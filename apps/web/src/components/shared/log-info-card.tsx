import type { ReactNode } from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { cn } from '@/lib/utils';
import { LogCopyButton } from './log-copy-button';

export function LogInfoCard({ label, value, copyValue, actions, warning = false, numeric = false }: {
  label: string; value: ReactNode; copyValue?: string; actions?: ReactNode; warning?: boolean; numeric?: boolean;
}) {
  return (
    <Card className={cn('min-w-0', warning && 'border-amber-500/30 bg-amber-500/5')}>
      <CardContent className="space-y-1.5 p-3">
        <div className="flex min-h-7 min-w-0 items-center justify-between gap-2">
          <p className="min-w-0 text-xs font-medium text-muted-foreground">{label}</p>
          <div className="flex shrink-0 items-center gap-1">
            {actions}
            {copyValue !== undefined && <LogCopyButton key={copyValue} value={copyValue} label={label} iconOnly />}
          </div>
        </div>
        <div className={cn('min-w-0 break-words font-mono text-xs leading-relaxed select-text [overflow-wrap:anywhere]', numeric && 'text-lg font-semibold tabular-nums', warning && 'text-amber-700 dark:text-amber-400')}>
          {value}
        </div>
      </CardContent>
    </Card>
  );
}
