import type { CcstatuslineAccount } from '@/lib/api';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';

interface UsageStatusIndicatorProps {
  usages: CcstatuslineAccount[];
}

function formatTimeUntil(isoString: string): string {
  const ms = new Date(isoString).getTime() - Date.now();
  if (ms <= 0) return 'reset';
  const totalMinutes = Math.floor(ms / 60_000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours >= 24) {
    const days = Math.floor(hours / 24);
    const remHours = hours % 24;
    return `${String(days)}d ${String(remHours)}h`;
  }
  return `${String(hours)}h ${String(minutes)}m`;
}

export function UsageStatusIndicator({ usages }: UsageStatusIndicatorProps): React.ReactElement {
  const totalSession = usages.reduce((sum, a) => sum + (a.usage?.sessionUsage ?? 0), 0);
  const totalWeekly = usages.reduce((sum, a) => sum + (a.usage?.weeklyUsage ?? 0), 0);

  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="flex items-center gap-1 cursor-default text-xs text-text-secondary">
            <span className="flex h-1.5 w-1.5 rounded-full bg-success" />
            {String(totalSession)}/{String(totalWeekly)}
          </span>
        </TooltipTrigger>
        <TooltipContent side="bottom" align="end" className="max-w-xs">
          <p className="text-xs font-medium mb-1">Claude Usage (ccstatusline)</p>
          {usages.map(account => (
            <div key={account.email} className="mt-1 text-xs text-text-secondary">
              <p className="font-medium text-text-primary">{account.email}</p>
              {account.usage ? (
                <>
                  <p>
                    Session: {String(account.usage.sessionUsage)} (resets in{' '}
                    {formatTimeUntil(account.usage.sessionResetAt)})
                  </p>
                  <p>
                    Weekly: {String(account.usage.weeklyUsage)} (resets in{' '}
                    {formatTimeUntil(account.usage.weeklyResetAt)})
                  </p>
                  <p>Extra: {account.usage.extraUsageEnabled ? 'enabled' : 'disabled'}</p>
                </>
              ) : (
                <p className="text-text-tertiary">
                  No data{account.lastError ? ` \u2014 ${account.lastError}` : ''}
                </p>
              )}
            </div>
          ))}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
