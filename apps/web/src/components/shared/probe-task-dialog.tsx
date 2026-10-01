import * as React from 'react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { ChevronDown, RefreshCw } from 'lucide-react';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Progress } from '@/components/ui/progress';
import { Form, FormControl, FormField, FormItem } from '@/components/ui/form';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { ServerPagination } from '@/components/shared/server-pagination';
import { ProbeResultCard } from '@/components/shared/probe-result';
import { useProbeTask, type ProbeTaskRequest } from '@/hooks/use-probe-task';
import { parseLastProbe } from '@/lib/probe-types';
import { formatDateTime } from '@/lib/utils';

const policySchema = z.object({ policy: z.enum(['MIHOMO_PREFERRED', 'MIHOMO_ONLY']) });

export interface ProbeTaskDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  request: ProbeTaskRequest;
  title?: string;
  children?: ReactNode;
}

export function ProbeTaskDialog({ open, onOpenChange, request, title, children }: ProbeTaskDialogProps) {
  const { t } = useTranslation(['admin', 'common']);
  const probe = useProbeTask(request, open);
  const [activeTaskId, setActiveTaskId] = React.useState<string | undefined>();
  const form = useForm<z.infer<typeof policySchema>>({
    resolver: zodResolver(policySchema),
    defaultValues: { policy: 'MIHOMO_PREFERRED' }
  });
  const task = probe.task.data;
  const isRunning = task?.state === 'RUNNING' || task?.state === 'QUEUED';
  const hasResults = (probe.results.data?.data.length ?? 0) > 0;

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{title ?? t('admin:probes.title')}</DialogTitle>
            <DialogDescription className="text-xs">
              {t('admin:probes.description')}
            </DialogDescription>
          </DialogHeader>

          {children}

          {/* 紧凑策略与创建表单 */}
          <Form {...form}>
            <form
              noValidate
              className="space-y-2 rounded-lg border bg-muted/20 p-3"
              onSubmit={form.handleSubmit(({ policy }) => probe.start.mutate(policy))}
            >
              <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2">
                <FormField
                  control={form.control}
                  name="policy"
                  render={({ field }) => (
                    <FormItem className="flex-1 space-y-0">
                      <Select
                        value={field.value}
                        onValueChange={field.onChange}
                        disabled={probe.blocked}
                      >
                        <FormControl>
                          <SelectTrigger className="h-8 text-xs">
                            <SelectValue />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          <SelectItem value="MIHOMO_PREFERRED" className="text-xs">
                            {t('admin:probes.preferred')}
                          </SelectItem>
                          <SelectItem value="MIHOMO_ONLY" className="text-xs">
                            {t('admin:probes.only')}
                          </SelectItem>
                        </SelectContent>
                      </Select>
                    </FormItem>
                  )}
                />
                {request.key !== '__active__' && (
                  <Button
                    type="submit"
                    size="sm"
                    className="h-8 shrink-0 text-xs"
                    disabled={probe.blocked || probe.pending || probe.task.isFetching}
                  >
                    {probe.start.isPending
                      ? t('common:actions.loading')
                      : probe.taskId
                        ? t('admin:probes.retest')
                        : t('admin:probes.start')}
                  </Button>
                )}
              </div>

              {/* 折叠收纳的长篇规则说明 */}
              <details className="group text-[11px] text-muted-foreground">
                <summary className="cursor-pointer select-none font-medium hover:text-foreground inline-flex items-center gap-1 transition-colors">
                  <ChevronDown className="size-3 transition-transform group-open:rotate-180" />
                  <span>{t('admin:probes.policySettingsToggle')}</span>
                </summary>
                <p className="mt-1 pl-3 border-l text-muted-foreground/80 leading-relaxed">
                  {t('admin:probes.policyHelp')}
                </p>
              </details>
            </form>
          </Form>

          {probe.activeElsewhere && (
            <div className="rounded-md border border-amber-500/30 bg-amber-500/10 p-3 space-y-1.5 text-xs text-amber-600 dark:text-amber-400">
              <p>{t('admin:probes.globalBusy')}</p>
              <Button
                variant="outline"
                size="sm"
                className="h-7 text-xs"
                onClick={() => setActiveTaskId(probe.activeTaskId ?? undefined)}
              >
                {t('admin:probes.viewActive')}
              </Button>
            </div>
          )}

          {/* 任务状态监控：运行中直接展示进度，已完成则放入折叠卡片 */}
          {probe.taskId && (
            <div className="space-y-2" aria-live="polite">
              {isRunning && task && (
                <div className="rounded-md border bg-muted/20 p-3 space-y-2">
                  <div className="flex items-center justify-between text-xs">
                    <Badge variant="secondary">{t(`admin:probes.state.${task.state}`)}</Badge>
                    <span className="font-mono text-muted-foreground">
                      {t('admin:probes.progress', { ...task })}
                    </span>
                  </div>
                  <Progress
                    value={task.total ? Math.min(100, (task.completed / task.total) * 100) : 0}
                    className="h-2"
                  />
                  {task.phase && (
                    <p className="text-xs text-muted-foreground">
                      {t('admin:probes.phase', { phase: task.phase })}
                    </p>
                  )}
                </div>
              )}

              {/* 诊断与执行流水详情折叠 */}
              <details
                className="group rounded-md border bg-muted/10 p-2.5 text-xs"
                open={!hasResults && !isRunning}
              >
                <summary className="cursor-pointer select-none font-medium flex items-center justify-between text-muted-foreground hover:text-foreground">
                  <span className="inline-flex items-center gap-1.5">
                    <ChevronDown className="size-3.5 transition-transform group-open:rotate-180" />
                    <span>{t('admin:probes.diagnosticDetails')}</span>
                  </span>
                  {task && (
                    <div className="flex items-center gap-2">
                      <Badge
                        variant={task.state === 'FAILED' ? 'destructive' : 'secondary'}
                        className="text-[10px] h-4 px-1.5"
                      >
                        {t(`admin:probes.state.${task.state}`)}
                      </Badge>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-xs"
                        disabled={probe.task.isFetching}
                        onClick={(e) => {
                          e.preventDefault();
                          void probe.task.refetch();
                          void probe.results.refetch();
                        }}
                      >
                        <RefreshCw className="size-3 text-muted-foreground" />
                      </Button>
                    </div>
                  )}
                </summary>

                <div className="mt-2.5 pt-2 border-t space-y-1 text-[11px] text-muted-foreground font-mono">
                  <p className="break-all">{t('admin:probes.taskId', { id: probe.taskId })}</p>
                  {task && (
                    <>
                      <p>
                        {t('admin:probes.taskTimes', {
                          created: formatDateTime(task.createdAt),
                          expires: formatDateTime(task.expiresAt)
                        })}
                      </p>
                      {task.phase && <p>{t('admin:probes.phase', { phase: task.phase })}</p>}
                    </>
                  )}
                  {probe.task.isError && (
                    <p className="text-destructive font-sans">
                      {t('admin:probes.taskUnavailable')}
                    </p>
                  )}
                </div>
              </details>
            </div>
          )}

          {probe.results.isError && (
            <p className="text-sm text-destructive">{t('admin:probes.resultsUnavailable')}</p>
          )}

          {/* 探测结果核心看板展示 */}
          <div className="space-y-3">
            {probe.results.data?.data.map((value, index) => {
              const result = parseLastProbe(value);
              return result ? (
                <ProbeResultCard key={`${result.subjectId}-${index}`} result={result} />
              ) : (
                <p key={index} className="text-xs text-muted-foreground">
                  {t('admin:probes.invalidResult')}
                </p>
              );
            })}
          </div>

          {probe.results.data && (
            <ServerPagination
              page={probe.page}
              pageSize={20}
              total={probe.results.data.total}
              pending={probe.results.isFetching}
              onPageChange={probe.setPage}
            />
          )}

          <p className="text-[11px] text-muted-foreground">{t('admin:probes.closeHelp')}</p>

          <DialogFooter className="gap-2 sm:gap-0">
            {probe.pending && !probe.task.isError && (
              <Button
                variant="outline"
                disabled={probe.cancel.isPending}
                onClick={() => probe.cancel.mutate()}
              >
                {t('admin:probes.cancel')}
              </Button>
            )}
            <Button onClick={() => onOpenChange(false)}>{t('common:actions.close')}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {request.key !== '__active__' && activeTaskId && (
        <ProbeTaskDialog
          open={open}
          onOpenChange={() => setActiveTaskId(undefined)}
          request={{ key: '__active__', endpoint: request.endpoint, taskId: activeTaskId }}
        />
      )}
    </>
  );
}
