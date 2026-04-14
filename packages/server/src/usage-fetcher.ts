/**
 * Claude Code usage fetcher
 * Periodically fetches OAuth usage data from Anthropic API and writes it to
 * ~/.cache/archon/usages.json — the same file read by GET /api/ccstatusline/usages.
 */
import { exec } from 'child_process';
import { readFile, writeFile, mkdir } from 'fs/promises';
import { join } from 'path';
import { createLogger } from '@archon/paths';

/** Lazy-initialized logger */
let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('usage-fetcher');
  return cachedLog;
}

// ─── Constants ───────────────────────────────────────────────────────────────

const FETCH_INTERVAL_MS = 60_000; // 60 s between ticks
const STALE_THRESHOLD_MS = 180_000; // 180 s → re-fetch if data is older
const FETCH_TIMEOUT_MS = 5_000; // 5 s API request timeout
const LOCK_TIMEOUT_MS = 10_000; // 10 s → release lock if fetch takes too long
const ANTHROPIC_USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const OAUTH_BETA_HEADER = 'oauth-2025-04-20';

// ─── Per-account state ────────────────────────────────────────────────────────

/** ISO timestamp of last successful fetch, keyed by email */
const lastFetchedAt = new Map<string, number>();
/** In-progress fetch lock, keyed by email */
const fetchInProgress = new Map<string, boolean>();

// ─── Scheduler state ──────────────────────────────────────────────────────────

let intervalId: ReturnType<typeof setInterval> | null = null;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function homeDir(): string {
  return process.env.HOME ?? process.env.USERPROFILE ?? '';
}

function usageFilePath(): string {
  return join(homeDir(), '.cache', 'archon', 'usages.json');
}

/** Read ~/.claude.json and return .oauthAccount.emailAddress, or null. */
async function getActiveEmail(): Promise<string | null> {
  try {
    const raw = await readFile(join(homeDir(), '.claude.json'), 'utf-8');
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed === 'object' && parsed !== null && 'oauthAccount' in parsed) {
      const oauth = (parsed as { oauthAccount?: { emailAddress?: string } }).oauthAccount;
      return oauth?.emailAddress ?? null;
    }
  } catch {
    // file missing, malformed, etc. — not an error condition
  }
  return null;
}

/** macOS Keychain lookup — resolves to the token string or null. */
function readKeychainToken(): Promise<string | null> {
  return new Promise(resolve => {
    exec("security find-generic-password -s 'Claude Code-credentials' -w", (err, stdout) => {
      if (err || !stdout.trim()) {
        resolve(null);
        return;
      }
      try {
        const creds = JSON.parse(stdout.trim()) as unknown;
        if (typeof creds === 'object' && creds !== null && 'claudeAiOauth' in creds) {
          const oauthObj = (creds as { claudeAiOauth?: { accessToken?: string } }).claudeAiOauth;
          resolve(oauthObj?.accessToken ?? null);
        } else {
          resolve(null);
        }
      } catch {
        resolve(null);
      }
    });
  });
}

/** Retrieve the best available OAuth token for the current session. */
async function getOAuthToken(): Promise<string | null> {
  // Try macOS Keychain first
  const keychainToken = await readKeychainToken();
  if (keychainToken) return keychainToken;

  // Fall back to env var
  const envToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  return envToken ?? null;
}

// ─── Storage helpers ──────────────────────────────────────────────────────────

interface AccountUsage {
  sessionUsage: number;
  sessionResetAt: string;
  weeklyUsage: number;
  weeklyResetAt: string;
  extraUsageEnabled: boolean;
}

interface AccountEntry {
  email: string;
  lastUsageAcquiredOn: string;
  usage: AccountUsage | null;
  lastError: string | null;
}

interface UsagesFile {
  usages: AccountEntry[];
}

async function readUsagesFile(): Promise<UsagesFile> {
  try {
    const raw = await readFile(usageFilePath(), 'utf-8');
    const parsed = JSON.parse(raw) as unknown;
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      'usages' in parsed &&
      Array.isArray((parsed as { usages: unknown }).usages)
    ) {
      return parsed as UsagesFile;
    }
  } catch {
    // missing or malformed — start fresh
  }
  return { usages: [] };
}

async function writeUsagesFile(data: UsagesFile): Promise<void> {
  const dir = join(homeDir(), '.cache', 'archon');
  await mkdir(dir, { recursive: true });
  await writeFile(usageFilePath(), JSON.stringify(data, null, 2), 'utf-8');
}

/** Upsert an entry for `email` and persist. */
async function saveEntry(entry: AccountEntry): Promise<void> {
  const file = await readUsagesFile();
  const idx = file.usages.findIndex(u => u.email === entry.email);
  if (idx >= 0) {
    file.usages[idx] = entry;
  } else {
    file.usages.push(entry);
  }
  await writeUsagesFile(file);
}

// ─── API fetch ────────────────────────────────────────────────────────────────

interface AnthropicUsageResponse {
  five_hour?: { utilization?: number; resets_at?: string };
  seven_day?: { utilization?: number; resets_at?: string };
}

async function fetchUsageFromApi(token: string): Promise<AccountUsage> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => {
    controller.abort();
  }, FETCH_TIMEOUT_MS);

  try {
    const res = await fetch(ANTHROPIC_USAGE_URL, {
      headers: {
        Authorization: `Bearer ${token}`,
        'anthropic-beta': OAUTH_BETA_HEADER,
      },
      signal: controller.signal,
    });

    if (!res.ok) {
      throw new Error(`HTTP ${res.status}: ${res.statusText}`);
    }

    const body = (await res.json()) as AnthropicUsageResponse;

    const sessionUtilization = body.five_hour?.utilization;
    const sessionResetAt = body.five_hour?.resets_at;
    const weeklyUtilization = body.seven_day?.utilization;
    const weeklyResetAt = body.seven_day?.resets_at;

    if (
      typeof sessionUtilization !== 'number' ||
      typeof sessionResetAt !== 'string' ||
      typeof weeklyUtilization !== 'number' ||
      typeof weeklyResetAt !== 'string'
    ) {
      throw new Error('Unexpected response shape');
    }

    return {
      sessionUsage: Math.floor(sessionUtilization),
      sessionResetAt,
      weeklyUsage: Math.floor(weeklyUtilization),
      weeklyResetAt,
      extraUsageEnabled: false,
    };
  } finally {
    clearTimeout(timeoutId);
  }
}

// ─── Core tick logic ──────────────────────────────────────────────────────────

async function fetchForEmail(email: string): Promise<void> {
  // Concurrency lock
  if (fetchInProgress.get(email)) {
    getLog().debug({ email }, 'usage-fetcher.fetch_skipped_in_progress');
    return;
  }

  // Staleness check
  const last = lastFetchedAt.get(email);
  if (last !== undefined && Date.now() - last < STALE_THRESHOLD_MS) {
    getLog().debug({ email }, 'usage-fetcher.fetch_skipped_fresh');
    return;
  }

  fetchInProgress.set(email, true);

  // Safety timeout: release lock after LOCK_TIMEOUT_MS regardless of outcome
  const lockTimeout = setTimeout(() => {
    if (fetchInProgress.get(email)) {
      getLog().warn({ email }, 'usage-fetcher.lock_timeout_released');
      fetchInProgress.set(email, false);
    }
  }, LOCK_TIMEOUT_MS);

  try {
    getLog().debug({ email }, 'usage-fetcher.fetch_started');

    const token = await getOAuthToken();
    if (!token) {
      getLog().warn({ email }, 'usage-fetcher.no_credentials');
      await saveEntry({
        email,
        lastUsageAcquiredOn: new Date().toISOString(),
        usage: null,
        lastError: 'no_credentials',
      });
      return;
    }

    let usage: AccountUsage;
    try {
      usage = await fetchUsageFromApi(token);
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      const isAbort = error.name === 'AbortError';
      const errorType = isAbort ? 'timeout' : 'api_error';
      getLog().warn({ email, err: error }, `usage-fetcher.fetch_${errorType}`);
      await saveEntry({
        email,
        lastUsageAcquiredOn: new Date().toISOString(),
        usage: null,
        lastError: errorType,
      });
      return;
    }

    await saveEntry({
      email,
      lastUsageAcquiredOn: new Date().toISOString(),
      usage,
      lastError: null,
    });

    lastFetchedAt.set(email, Date.now());
    getLog().info(
      { email, sessionUsage: usage.sessionUsage, weeklyUsage: usage.weeklyUsage },
      'usage-fetcher.fetch_completed'
    );
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    getLog().error({ email, err: error }, 'usage-fetcher.fetch_failed');

    try {
      await saveEntry({
        email,
        lastUsageAcquiredOn: new Date().toISOString(),
        usage: null,
        lastError: 'api_error',
      });
    } catch (writeErr) {
      getLog().error({ err: writeErr }, 'usage-fetcher.save_failed');
    }
  } finally {
    clearTimeout(lockTimeout);
    fetchInProgress.set(email, false);
  }
}

async function tick(): Promise<void> {
  const email = await getActiveEmail();
  if (!email) {
    getLog().debug('usage-fetcher.no_active_account');
    return;
  }
  await fetchForEmail(email);
}

// ─── Public API ───────────────────────────────────────────────────────────────

/** Start the usage fetcher. Runs an immediate tick, then every 60 s. */
export function startUsageFetcher(): void {
  if (intervalId) {
    getLog().warn('usage-fetcher.already_running');
    return;
  }

  getLog().info({ intervalMs: FETCH_INTERVAL_MS }, 'usage-fetcher.starting');

  // Immediate tick on startup (non-blocking)
  void tick().catch(err => {
    getLog().error({ err }, 'usage-fetcher.initial_tick_failed');
  });

  intervalId = setInterval(() => {
    void tick().catch(err => {
      getLog().error({ err }, 'usage-fetcher.tick_failed');
    });
  }, FETCH_INTERVAL_MS);

  getLog().info('usage-fetcher.started');
}

/** Stop the usage fetcher. */
export function stopUsageFetcher(): void {
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
    getLog().info('usage-fetcher.stopped');
  }
}
