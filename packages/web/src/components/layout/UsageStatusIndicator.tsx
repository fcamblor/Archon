import type { CcstatuslineAccount } from '@/lib/api';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';

interface UsageStatusIndicatorProps {
  usages: CcstatuslineAccount[];
  activeEmail: string | null;
}

function formatTimeUntil(isoString: string): string {
  const ms = new Date(isoString).getTime() - Date.now();
  if (isNaN(ms) || ms <= 0) return 'reset';
  const totalMinutes = Math.floor(ms / 60_000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours >= 24) {
    const days = Math.floor(hours / 24);
    const remHours = hours % 24;
    return `${String(days)}d ${String(remHours)}h`;
  }
  if (hours > 0) return `${String(hours)}h ${String(minutes)}m`;
  return `${String(minutes)}m`;
}

/** Window durations in milliseconds */
const SESSION_WINDOW_MS = 5 * 60 * 60 * 1000; // 5 hours
const WEEKLY_WINDOW_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

/**
 * Computes a burn-rate color based on usage% relative to elapsed time%.
 *
 * ratio = usage% / elapsedTime%
 *   < 0.75  → green   (well under linear pace)
 *   0.75–0.9 → yellow  (approaching linear pace)
 *   0.9–1.2  → orange  (at or slightly above linear pace)
 *   > 1.2   → red     (consuming significantly faster than expected)
 *
 * When the window just started (elapsed < 5%), falls back to raw usage%
 * thresholds to avoid noisy division-by-near-zero.
 */
function burnRateColor(usagePercent: number, resetAtIso: string, windowMs: number): string {
  const remainingMs = new Date(resetAtIso).getTime() - Date.now();
  const elapsedMs = windowMs - Math.max(0, remainingMs);
  const elapsedPct = (elapsedMs / windowMs) * 100;

  // Window just started — use raw thresholds to avoid instability
  if (elapsedPct < 5) {
    if (usagePercent > 30) return 'bg-red-500';
    if (usagePercent > 20) return 'bg-orange-500';
    if (usagePercent > 10) return 'bg-yellow-500';
    return 'bg-emerald-500';
  }

  const ratio = usagePercent / elapsedPct;
  if (ratio > 1.2) return 'bg-red-500';
  if (ratio >= 0.9) return 'bg-orange-500';
  if (ratio >= 0.75) return 'bg-yellow-500';
  return 'bg-emerald-500';
}

/** Tiny Claude logo (sparkle mark) rendered as inline SVG */
function ClaudeLogo({ className }: { className?: string }): React.ReactElement {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className} aria-label="Claude">
      <path d="M4.709 15.955l4.72-2.756.08-.046 2.698-1.575c.091-.053.091-.186 0-.24l-2.7-1.574-.078-.045-4.72-2.756a.233.233 0 00-.349.202v8.588c0 .17.183.278.349.202z" />
      <path d="M19.291 8.045l-4.72 2.756-.08.046-2.698 1.575a.139.139 0 000 .24l2.7 1.574.078.045 4.72 2.756a.233.233 0 00.349-.202V8.247a.233.233 0 00-.349-.202z" />
    </svg>
  );
}

/** Computes elapsed % for a window given its reset time and total duration */
function elapsedPercent(resetAtIso: string, windowMs: number): number {
  const remainingMs = new Date(resetAtIso).getTime() - Date.now();
  const elapsedMs = windowMs - Math.max(0, remainingMs);
  return Math.min(100, Math.max(0, (elapsedMs / windowMs) * 100));
}

interface UsageBarProps {
  percent: number;
  label: string;
  colorClass: string;
  /** Expected linear position (elapsed time %) — shown as a vertical marker */
  expectedPercent?: number;
}

function UsageBar({ percent, label, colorClass, expectedPercent }: UsageBarProps): React.ReactElement {
  const clamped = Math.min(100, Math.max(0, percent));
  const expectedClamped = expectedPercent != null ? Math.min(100, Math.max(0, expectedPercent)) : undefined;
  return (
    <div className="relative h-4 w-full rounded overflow-hidden bg-muted text-[10px] leading-4">
      {/* filled portion */}
      <div
        className={`absolute inset-y-0 left-0 ${colorClass}`}
        style={{ width: `${String(clamped)}%` }}
      />
      {/* expected linear pace marker */}
      {expectedClamped != null && expectedClamped > 0 && (
        <div
          className="absolute inset-y-0 w-0.5 bg-white/70"
          style={{ left: `${String(expectedClamped)}%` }}
          title={`Linear pace: ${String(Math.round(expectedClamped))}%`}
        />
      )}
      {/* label */}
      <span
        className="absolute inset-0 flex items-center px-1 font-medium select-none text-white"
        style={{
          textShadow:
            '0 0 3px rgba(0,0,0,0.95), 0 0 6px rgba(0,0,0,0.8), 1px 1px 0 rgba(0,0,0,0.9)',
        }}
      >
        {label}
      </span>
    </div>
  );
}

export function UsageStatusIndicator({
  usages,
  activeEmail,
}: UsageStatusIndicatorProps): React.ReactElement {
  const activeAccount =
    usages.find(a => a.email === activeEmail && a.usage != null) ??
    usages.find(a => a.usage != null);
  const session = activeAccount?.usage;

  const sessionColor = session
    ? burnRateColor(session.sessionUsage, session.sessionResetAt, SESSION_WINDOW_MS)
    : 'bg-emerald-500';
  const weeklyColor = session
    ? burnRateColor(session.weeklyUsage, session.weeklyResetAt, WEEKLY_WINDOW_MS)
    : 'bg-emerald-500';

  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="flex items-center gap-1.5 cursor-default text-xs text-gray-900 rounded-md border border-border bg-white/75 px-2 py-1">
            <ClaudeLogo className="h-3.5 w-3.5 text-[#D97757] shrink-0" />
            {session != null ? (
              <>
                <span className={`flex h-1.5 w-1.5 rounded-full shrink-0 ${sessionColor}`} />
                <span>
                  H {String(session.sessionUsage)}% · {formatTimeUntil(session.sessionResetAt)}
                </span>
                <span className={`flex h-1.5 w-1.5 rounded-full shrink-0 ${weeklyColor}`} />
                <span>
                  W {String(session.weeklyUsage)}% · {formatTimeUntil(session.weeklyResetAt)}
                </span>
              </>
            ) : (
              '—'
            )}
          </span>
        </TooltipTrigger>
        <TooltipContent side="bottom" align="end" className="max-w-xs w-64 p-3">
          <p className="text-xs font-semibold mb-2">Claude Usage (ccstatusline)</p>
          {usages.map(account => {
            const isActive = account.email === activeEmail;
            const sColor = account.usage
              ? burnRateColor(
                  account.usage.sessionUsage,
                  account.usage.sessionResetAt,
                  SESSION_WINDOW_MS
                )
              : 'bg-emerald-500';
            const wColor = account.usage
              ? burnRateColor(
                  account.usage.weeklyUsage,
                  account.usage.weeklyResetAt,
                  WEEKLY_WINDOW_MS
                )
              : 'bg-emerald-500';
            return (
              <div
                key={account.email}
                className={`mt-2 first:mt-0 rounded px-2 py-1.5 ${isActive ? 'bg-primary/10 ring-1 ring-primary/30' : ''}`}
              >
                <div className="flex items-center gap-1.5 mb-1">
                  <p className="text-xs font-medium truncate flex-1">{account.email}</p>
                  {isActive && (
                    <span className="shrink-0 text-[9px] font-semibold uppercase tracking-wide text-primary bg-primary/15 rounded px-1 py-0.5">
                      active
                    </span>
                  )}
                </div>
                {account.usage ? (
                  <div className="flex flex-col gap-1">
                    <UsageBar
                      percent={account.usage.sessionUsage}
                      label={`H: ${String(account.usage.sessionUsage)}% · ${formatTimeUntil(account.usage.sessionResetAt)}`}
                      colorClass={sColor}
                      expectedPercent={elapsedPercent(account.usage.sessionResetAt, SESSION_WINDOW_MS)}
                    />
                    <UsageBar
                      percent={account.usage.weeklyUsage}
                      label={`W: ${String(account.usage.weeklyUsage)}% · ${formatTimeUntil(account.usage.weeklyResetAt)}`}
                      colorClass={wColor}
                      expectedPercent={elapsedPercent(account.usage.weeklyResetAt, WEEKLY_WINDOW_MS)}
                    />
                  </div>
                ) : (
                  <p className="text-xs text-muted-foreground">
                    No data{account.lastError ? ` — ${account.lastError}` : ''}
                  </p>
                )}
              </div>
            );
          })}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
