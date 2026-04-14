/**
 * Tests for usage-fetcher.ts
 * Uses a real tmpdir for storage (no fs mock) and mocks exec + fetch.
 *
 * IMPORTANT: usage-fetcher has module-level state (lastFetchedAt, fetchInProgress).
 * Tests use unique email addresses per test to avoid staleness-check interference.
 */
import { describe, test, expect, mock, beforeEach, afterEach } from 'bun:test';
import { tmpdir } from 'os';
import { join } from 'path';
import { mkdir, rm, writeFile, readFile } from 'fs/promises';

// ---------------------------------------------------------------------------
// Mock child_process exec — must be before dynamic imports
// ---------------------------------------------------------------------------

const mockExecCallback = mock((_cmd: string, cb: (err: Error | null, stdout: string) => void) => {
  // Default: keychain not found (simulate non-macOS or missing entry)
  cb(new Error('not found'), '');
});

mock.module('child_process', () => ({
  exec: mockExecCallback,
}));

// ---------------------------------------------------------------------------
// Mock @archon/paths logger
// ---------------------------------------------------------------------------

mock.module('@archon/paths', () => ({
  createLogger: () => ({
    fatal: mock(() => undefined),
    error: mock(() => undefined),
    warn: mock(() => undefined),
    info: mock(() => undefined),
    debug: mock(() => undefined),
    trace: mock(() => undefined),
    child: mock(function (this: unknown) {
      return this;
    }),
    bindings: mock(() => ({})),
    isLevelEnabled: mock(() => true),
    level: 'info',
  }),
}));

// ---------------------------------------------------------------------------
// Mock global fetch — must be before dynamic imports
// ---------------------------------------------------------------------------

const mockFetchImpl = mock(async (): Promise<Response> => {
  return new Response(
    JSON.stringify({
      five_hour: { utilization: 0.42, resets_at: '2026-04-14T05:00:00Z' },
      seven_day: { utilization: 0.75, resets_at: '2026-04-21T00:00:00Z' },
    }),
    { status: 200 }
  );
});

global.fetch = mockFetchImpl as unknown as typeof fetch;

// ---------------------------------------------------------------------------
// Import after all mock.module() calls
// ---------------------------------------------------------------------------

import { startUsageFetcher, stopUsageFetcher } from './usage-fetcher';

// ---------------------------------------------------------------------------
// Per-test isolated tmpdir + unique email
// ---------------------------------------------------------------------------

let testDir: string;
let originalHome: string | undefined;
let testEmail: string;
let testCounter = 0;

beforeEach(async () => {
  testCounter++;
  // Unique email per test ensures module-level lastFetchedAt map doesn't block fetches
  testEmail = `user${testCounter}@example.com`;

  const uniqueSuffix = `${Date.now()}-${testCounter}`;
  testDir = join(tmpdir(), `usage-fetcher-test-${uniqueSuffix}`);
  await mkdir(join(testDir, '.cache', 'archon'), { recursive: true });
  originalHome = process.env.HOME;
  process.env.HOME = testDir;

  mockFetchImpl.mockReset();
  mockExecCallback.mockReset();

  // Default exec: keychain not found
  mockExecCallback.mockImplementation(
    (_cmd: string, cb: (err: Error | null, stdout: string) => void) => {
      cb(new Error('not found'), '');
    }
  );
});

afterEach(async () => {
  stopUsageFetcher();
  process.env.HOME = originalHome;
  delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
  await rm(testDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

async function readUsagesFileDisk(dir: string): Promise<{ usages: AccountEntry[] }> {
  const raw = await readFile(join(dir, '.cache', 'archon', 'usages.json'), 'utf-8');
  return JSON.parse(raw) as { usages: AccountEntry[] };
}

function writeClaudeJson(dir: string, email: string): Promise<void> {
  return writeFile(
    join(dir, '.claude.json'),
    JSON.stringify({ oauthAccount: { emailAddress: email } })
  );
}

/** Wait for the immediate tick on start to complete */
async function waitForTick(ms = 300): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, ms));
}

function makeValidFetchResponse(): Response {
  return new Response(
    JSON.stringify({
      five_hour: { utilization: 0.42, resets_at: '2026-04-14T05:00:00Z' },
      seven_day: { utilization: 0.75, resets_at: '2026-04-21T00:00:00Z' },
    }),
    { status: 200 }
  );
}

// ---------------------------------------------------------------------------
// Tests: lifecycle
// ---------------------------------------------------------------------------

describe('startUsageFetcher / stopUsageFetcher lifecycle', () => {
  test('stopUsageFetcher before start does not throw', () => {
    expect(() => stopUsageFetcher()).not.toThrow();
  });

  test('calling startUsageFetcher twice is idempotent (no double interval)', async () => {
    await writeClaudeJson(testDir, testEmail);
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'test-token';
    mockFetchImpl.mockImplementation(async () => makeValidFetchResponse());

    startUsageFetcher();
    startUsageFetcher(); // second call should be a no-op
    await waitForTick();
    stopUsageFetcher();

    // fetch should have been called at most once (idempotent start)
    expect(mockFetchImpl.mock.calls.length).toBeLessThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// Tests: saveEntry upsert logic (via filesystem)
// ---------------------------------------------------------------------------

describe('saveEntry upsert logic', () => {
  test('creates new entry when usages file does not exist', async () => {
    await writeClaudeJson(testDir, testEmail);
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'test-token';
    mockFetchImpl.mockImplementationOnce(async () => makeValidFetchResponse());

    startUsageFetcher();
    await waitForTick();
    stopUsageFetcher();

    const data = await readUsagesFileDisk(testDir);
    expect(data.usages).toHaveLength(1);
    expect(data.usages[0].email).toBe(testEmail);
    expect(data.usages[0].usage).not.toBeNull();
    expect(data.usages[0].lastError).toBeNull();
  });

  test('upserts existing entry without creating duplicates', async () => {
    // Pre-populate file with one entry for the same email
    const initial: { usages: AccountEntry[] } = {
      usages: [
        {
          email: testEmail,
          lastUsageAcquiredOn: '2026-04-13T00:00:00Z',
          usage: {
            sessionUsage: 10,
            sessionResetAt: '2026-04-13T05:00:00Z',
            weeklyUsage: 20,
            weeklyResetAt: '2026-04-20T00:00:00Z',
            extraUsageEnabled: false,
          },
          lastError: null,
        },
      ],
    };
    await writeFile(join(testDir, '.cache', 'archon', 'usages.json'), JSON.stringify(initial));
    await writeClaudeJson(testDir, testEmail);
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'test-token';
    mockFetchImpl.mockImplementationOnce(async () => makeValidFetchResponse());

    startUsageFetcher();
    await waitForTick();
    stopUsageFetcher();

    const data = await readUsagesFileDisk(testDir);
    // Should be exactly 1 entry — no duplicate
    expect(data.usages).toHaveLength(1);
    expect(data.usages[0].email).toBe(testEmail);
  });
});

// ---------------------------------------------------------------------------
// Tests: no active account
// ---------------------------------------------------------------------------

describe('tick: no active account', () => {
  test('does not write usages file when no .claude.json exists', async () => {
    // No .claude.json → no email → tick exits early
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'test-token';

    startUsageFetcher();
    await waitForTick();
    stopUsageFetcher();

    // usages.json should NOT have been created
    let fileExists = true;
    try {
      await readFile(join(testDir, '.cache', 'archon', 'usages.json'), 'utf-8');
    } catch {
      fileExists = false;
    }
    expect(fileExists).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Tests: error handling
// ---------------------------------------------------------------------------

describe('fetchForEmail: error handling', () => {
  test('saves lastError=no_credentials when no token available', async () => {
    await writeClaudeJson(testDir, testEmail);
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    // exec returns error (no keychain) by default

    startUsageFetcher();
    await waitForTick();
    stopUsageFetcher();

    const data = await readUsagesFileDisk(testDir);
    expect(data.usages).toHaveLength(1);
    expect(data.usages[0].lastError).toBe('no_credentials');
    expect(data.usages[0].usage).toBeNull();
  });

  test('saves lastError=timeout when API request times out (AbortError)', async () => {
    await writeClaudeJson(testDir, testEmail);
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'test-token';

    const abortError = new Error('The operation was aborted');
    abortError.name = 'AbortError';
    mockFetchImpl.mockRejectedValueOnce(abortError);

    startUsageFetcher();
    await waitForTick();
    stopUsageFetcher();

    const data = await readUsagesFileDisk(testDir);
    expect(data.usages).toHaveLength(1);
    expect(data.usages[0].lastError).toBe('timeout');
    expect(data.usages[0].usage).toBeNull();
  });

  test('saves lastError=api_error when API returns non-OK response', async () => {
    await writeClaudeJson(testDir, testEmail);
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'test-token';

    mockFetchImpl.mockImplementationOnce(
      async () => new Response('Unauthorized', { status: 401, statusText: 'Unauthorized' })
    );

    startUsageFetcher();
    await waitForTick();
    stopUsageFetcher();

    const data = await readUsagesFileDisk(testDir);
    expect(data.usages).toHaveLength(1);
    expect(data.usages[0].lastError).toBe('api_error');
    expect(data.usages[0].usage).toBeNull();
  });

  test('saves usage data and null lastError on successful API fetch', async () => {
    await writeClaudeJson(testDir, testEmail);
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'test-token';
    mockFetchImpl.mockImplementationOnce(async () => makeValidFetchResponse());

    startUsageFetcher();
    await waitForTick();
    stopUsageFetcher();

    const data = await readUsagesFileDisk(testDir);
    expect(data.usages).toHaveLength(1);
    expect(data.usages[0].lastError).toBeNull();
    expect(data.usages[0].usage).not.toBeNull();
    expect(typeof data.usages[0].usage?.sessionUsage).toBe('number');
    expect(typeof data.usages[0].usage?.weeklyUsage).toBe('number');
  });
});
