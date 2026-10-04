import * as React from 'react';
import { useTranslation } from 'react-i18next';
import { RefreshCw } from 'lucide-react';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { IconButton } from '@/components/ui/icon-button';
import { Badge } from '@/components/ui/badge';
import { Progress } from '@/components/ui/progress';
import { ServerPagination } from '@/components/shared/server-pagination';
import { ProbeResultCard } from '@/components/shared/probe-result';
import { useProbeTask, type ProbeTaskRequest } from '@/hooks/use-probe-task';
import { parseLastProbe } from '@/lib/probe-types';
import { formatDateTime } from '@/lib/utils';
import { FlagText } from '@/components/shared/flag-text';

export interface ProbeTaskDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  request: ProbeTaskRequest;
  title?: string;
}

export function ProbeTaskDialog({ open, onOpenChange, request, title }: ProbeTaskDialogProps) {
  const { t } = useTranslation(['admin', 'common']);
  const probe = useProbeTask(request, open);
  const [activeTaskId, setActiveTaskId] = React.useState<string | undefined>();
  const task = probe.task.data;

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle><FlagText text={title ?? t('admin:latencyTest.title')} /></DialogTitle>
            <DialogDescription className="text-xs">{t('admin:latencyTest.description')}</DialogDescription>
          </DialogHeader>

          {request.key !== '__active__' && (
            <Button
              type="button"
              size="sm"
              className="justify-self-start"
              disabled={probe.blocked || probe.pending || probe.task.isFetching}
              onClick={() => probe.start.mutate()}
            >
              {probe.start.isPending ? t('common:actions.loading') : probe.taskId ? t('admin:latencyTest.retest') : t('admin:latencyTest.start')}
            </Button>
          )}

          {probe.activeElsewhere && (
            <div className="rounded-md border border-amber-500/30 bg-amber-500/10 p-3 space-y-2 text-xs text-amber-600 dark:text-amber-400">
              <p>{t('admin:latencyTest.globalBusy')}</p>
              <Button variant="outline" size="sm" onClick={() => setActiveTaskId(probe.activeTaskId ?? undefined)}>
                {t('admin:latencyTest.viewActive')}
              </Button>
            </div>
          )}

          {probe.taskId && (
            <div className="rounded-md border bg-muted/20 p-3 space-y-2 text-xs" aria-live="polite">
              <div className="flex flex-wrap items-center justify-between gap-2">
                {task && <Badge variant={task.state === 'FAILED' ? 'destructive' : 'secondary'}>{t(`admin:latencyTest.state.${task.state}`)}</Badge>}
                <IconButton
                  aria-label={t('admin:latencyTest.refresh')}
                  variant="ghost"
                  size="icon-xs"
                  disabled={probe.task.isFetching || probe.results.isFetching}
                  onClick={() => { void probe.task.refetch(); if (task) void probe.results.refetch(); }}
                >
                  <RefreshCw className="size-4" />
                </IconButton>
              </div>
              <p className="break-all font-mono text-muted-foreground">{t('admin:latencyTest.taskId', { id: probe.taskId })}</p>
              {task && (
                <>
                  <p className="text-muted-foreground">{t('admin:latencyTest.progress', { completed: task.completed, total: task.total, success: task.success, failed: task.failed, skipped: task.skipped })}</p>
                  <Progress value={task.total ? Math.min(100, (task.completed / task.total) * 100) : 0} className="h-2" />
                  <p className="text-muted-foreground">{t('admin:latencyTest.taskTimes', { created: formatDateTime(task.createdAt), expires: formatDateTime(task.expiresAt) })}</p>
                </>
              )}
              {probe.task.isError && <p className="text-destructive">{t('admin:latencyTest.taskUnavailable')}</p>}
            </div>
          )}

          {probe.results.isError && <p className="text-sm text-destructive">{t('admin:latencyTest.resultsUnavailable')}</p>}
          <div className="space-y-3">
            {probe.results.data?.data.map((value, index) => {
              const result = parseLastProbe(value);
              return result ? <ProbeResultCard key={`${result.subjectId}-${index}`} result={result} /> : (
                <p key={index} className="text-xs text-muted-foreground">{t('admin:latencyTest.invalidResult')}</p>
              );
            })}
          </div>
          {probe.results.data && <ServerPagination page={probe.page} pageSize={20} total={probe.results.data.total} pending={probe.results.isFetching} onPageChange={probe.setPage} />}
          <p className="text-[11px] text-muted-foreground">{t('admin:latencyTest.closeHelp')}</p>

          <DialogFooter className="gap-2 sm:gap-0">
            {probe.pending && !probe.task.isError && (
              <Button variant="outline" disabled={probe.cancel.isPending} onClick={() => probe.cancel.mutate()}>
                {t('admin:latencyTest.cancel')}
              </Button>
            )}
            <Button onClick={() => onOpenChange(false)}>{t('common:actions.close')}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {request.key !== '__active__' && activeTaskId && (
        <ProbeTaskDialog open={open} onOpenChange={() => setActiveTaskId(undefined)} request={{ key: '__active__', endpoint: request.endpoint, taskId: activeTaskId }} />
      )}
    </>
  );
}
