import { useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Progress } from '@/components/ui/progress';
import { Form, FormControl, FormField, FormItem, FormLabel } from '@/components/ui/form';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { ServerPagination } from '@/components/shared/server-pagination';
import { ProbeResultCard } from '@/components/shared/probe-result';
import { useProbeTask, type ProbeTaskRequest } from '@/hooks/use-probe-task';
import { parseLastProbe } from '@/lib/probe-types';
import { formatDateTime } from '@/lib/utils';

const policySchema = z.object({ policy: z.enum(['MIHOMO_PREFERRED', 'MIHOMO_ONLY']) });
export interface ProbeTaskDialogProps {
  open: boolean; onOpenChange: (open: boolean) => void; request: ProbeTaskRequest; title?: string; children?: ReactNode;
}
export function ProbeTaskDialog({ open, onOpenChange, request, title, children }: ProbeTaskDialogProps) {
  const { t } = useTranslation(['admin', 'common']);
  const probe = useProbeTask(request, open);
  const [activeTaskId, setActiveTaskId] = useState<string | undefined>();
  const form = useForm<z.infer<typeof policySchema>>({ resolver: zodResolver(policySchema), defaultValues: { policy: 'MIHOMO_PREFERRED' } });
  const task = probe.task.data;
  return <><Dialog open={open} onOpenChange={onOpenChange}><DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
    <DialogHeader><DialogTitle>{title ?? t('admin:probes.title')}</DialogTitle><DialogDescription>{t('admin:probes.description')}</DialogDescription></DialogHeader>
    {children}
    <Form {...form}><form noValidate className="space-y-2" onSubmit={form.handleSubmit(({ policy }) => probe.start.mutate(policy))}>
      <FormField control={form.control} name="policy" render={({ field }) => <FormItem><FormLabel>{t('admin:probes.policyLabel')}</FormLabel>
        <Select value={field.value} onValueChange={field.onChange} disabled={probe.blocked}><FormControl><SelectTrigger><SelectValue /></SelectTrigger></FormControl><SelectContent>
          <SelectItem value="MIHOMO_PREFERRED">{t('admin:probes.preferred')}</SelectItem><SelectItem value="MIHOMO_ONLY">{t('admin:probes.only')}</SelectItem>
        </SelectContent></Select></FormItem>} />
      <p className="text-xs text-muted-foreground">{t('admin:probes.policyHelp')}</p>
      {request.key !== '__active__' && <Button type="submit" disabled={probe.blocked || probe.pending || probe.task.isFetching}>{probe.start.isPending ? t('common:actions.loading') : probe.taskId ? t('admin:probes.retest') : t('admin:probes.start')}</Button>}
    </form></Form>
    {probe.activeElsewhere && <div className="space-y-2"><p className="text-xs text-amber-600 dark:text-amber-400">{t('admin:probes.globalBusy')}</p><Button variant="outline" onClick={() => setActiveTaskId(probe.activeTaskId ?? undefined)}>{t('admin:probes.viewActive')}</Button></div>}
    {probe.taskId && <div className="space-y-2" aria-live="polite">
      <p className="text-xs font-mono break-all">{t('admin:probes.taskId', { id: probe.taskId })}</p>
      {task ? <><Badge variant={task.state === 'FAILED' ? 'destructive' : 'secondary'}>{t(`admin:probes.state.${task.state}`)}</Badge>
        <Progress value={task.total ? Math.min(100, task.completed / task.total * 100) : 0} />
        <p className="text-sm">{t('admin:probes.progress', { ...task })}</p>
        <p className="text-xs text-muted-foreground">{t('admin:probes.taskTimes', { created: formatDateTime(task.createdAt), expires: formatDateTime(task.expiresAt) })}</p>
        {task.phase && <p className="text-xs">{t('admin:probes.phase', { phase: task.phase })}</p>}
      </> : !probe.task.isError && <p>{t('common:actions.loading')}</p>}
      {probe.task.isError && <p className="text-amber-600 dark:text-amber-400">{t('admin:probes.taskUnavailable')}</p>}
      <Button variant="outline" size="sm" disabled={probe.task.isFetching} onClick={() => { void probe.task.refetch(); void probe.results.refetch(); }}>{t('admin:probes.refresh')}</Button>
    </div>}
    {probe.results.isError && <p className="text-amber-600 dark:text-amber-400">{t('admin:probes.resultsUnavailable')}</p>}
    {probe.results.data?.data.map((value, index) => {
      const result = parseLastProbe(value);
      return result ? <ProbeResultCard key={`${result.subjectId}-${index}`} result={result} /> : <p key={index}>{t('admin:probes.invalidResult')}</p>;
    })}
    {probe.results.data && <ServerPagination page={probe.page} pageSize={20} total={probe.results.data.total} pending={probe.results.isFetching} onPageChange={probe.setPage} />}
    <p className="text-xs text-muted-foreground">{t('admin:probes.closeHelp')}</p>
    <DialogFooter>{probe.pending && !probe.task.isError && <Button variant="outline" disabled={probe.cancel.isPending} onClick={() => probe.cancel.mutate()}>{t('admin:probes.cancel')}</Button>}<Button onClick={() => onOpenChange(false)}>{t('common:actions.close')}</Button></DialogFooter>
  </DialogContent></Dialog>
    {request.key !== '__active__' && activeTaskId && <ProbeTaskDialog open={open} onOpenChange={() => setActiveTaskId(undefined)} request={{ key: '__active__', endpoint: request.endpoint, taskId: activeTaskId }} />}
  </>;
}
