import { useFormResetOnKey } from '@/hooks/use-form-reset';
import { zodResolver } from '@hookform/resolvers/zod';
import { CheckCircle2, CircleX, Clock3 } from 'lucide-react';
import { Controller, useForm } from 'react-hook-form';
import { z } from 'zod';
import { useTranslation } from 'react-i18next';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { ResponsiveDialog, ResponsiveDialogContent } from '@/components/shared/responsive-dialog';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import type { AdminNode, BatchNodeUpgradeResult } from '../use-nodes';
import type { BinaryResource } from '../../binaries/use-binaries';

const schema = z.object({ resourceId: z.string() });
type Values = z.infer<typeof schema>;

function normalizeArch(value: string | null) {
  const normalized = (value || 'linux/amd64').toLowerCase().replace(/\\/g, '/');
  const [os, arch] = normalized.split('/');
  const osName = os === 'darwin' ? 'macos' : os;
  const archName = ['x86_64', 'x64'].includes(arch) ? 'amd64' : arch === 'aarch64' ? 'arm64' : arch;
  return `${osName}-${archName}`;
}

export function BatchUpgradeNodesDialog({ open, onOpenChange, pending, nodes, resources, result, onSubmit }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  pending: boolean;
  nodes: AdminNode[];
  resources?: BinaryResource[];
  result: BatchNodeUpgradeResult | null;
  onSubmit: (values: { ids: string[]; resourceId?: string }) => void;
}) {
  const { t } = useTranslation(['admin', 'common']);
  const form = useForm<Values>({
    resolver: zodResolver(schema),
    defaultValues: { resourceId: '' }
  });
  const platforms = [...new Set(nodes.map((node) => normalizeArch(node.osArch)))];
  const compatibleResources = (resources ?? []).filter((resource) =>
    resource.kind === 'AGENT' && resource.status === 'ACTIVE' && platforms.every((platform) =>
      resource.assets.some((asset) => asset.target === `agent-${platform}` && asset.available)
    )
  );

  useFormResetOnKey({
    open: open && !result,
    resetKey: nodes.map((node) => node.id).join(','),
    reset: () => form.reset({ resourceId: '' })
  });

  const submit = (values: Values) => onSubmit({
    ids: nodes.map((node) => node.id),
    ...(values.resourceId ? { resourceId: values.resourceId } : {})
  });

  return (
    <ResponsiveDialog open={open} onOpenChange={(nextOpen) => !pending && onOpenChange(nextOpen)}>
      <ResponsiveDialogContent size="wide">
        <DialogHeader>
          <DialogTitle>{result ? t('admin:nodes.batchUpgradeResults') : t('admin:nodes.batchUpgradeTitle')}</DialogTitle>
          <DialogDescription>
            {result
              ? t('admin:nodes.batchUpgradeSummary', { succeeded: result.succeeded, failed: result.failed })
              : t('admin:nodes.batchUpgradeDesc', { count: nodes.length })}
          </DialogDescription>
        </DialogHeader>
        {result ? (
          <div className="max-h-[55vh] space-y-2 overflow-y-auto pr-1">
            {result.results.map((item) => {
              const node = nodes.find((candidate) => candidate.id === item.nodeId);
              const StatusIcon = item.status === 'FAILED' ? CircleX : item.status === 'QUEUED' ? Clock3 : CheckCircle2;
              const variant = item.status === 'FAILED' ? 'destructive' : item.status === 'QUEUED' ? 'secondary' : 'default';
              const label = item.status === 'FAILED'
                ? t('admin:nodes.batchUpgradeFailed')
                : item.status === 'QUEUED'
                  ? t('admin:nodes.batchUpgradeQueued')
                  : t('admin:nodes.batchUpgradeDispatched');
              return (
                <div key={item.nodeId} className="flex min-w-0 items-start gap-3 rounded-md border p-3">
                  <StatusIcon className={item.status === 'FAILED' ? 'mt-0.5 size-4 text-destructive' : 'mt-0.5 size-4 text-muted-foreground'} />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="truncate text-sm font-medium">{node?.name ?? item.nodeId}</span>
                      <Badge variant={variant}>{label}</Badge>
                    </div>
                    {item.message && <p className="mt-1 break-words text-xs text-muted-foreground">{item.message}</p>}
                  </div>
                </div>
              );
            })}
          </div>
        ) : (
          <form className="space-y-4" onSubmit={form.handleSubmit(submit)}>
            <div className="max-h-48 space-y-2 overflow-y-auto rounded-md border p-3">
              {nodes.map((node) => (
                <div key={node.id} className="flex min-w-0 items-center justify-between gap-3 text-sm">
                  <span className="min-w-0 truncate font-medium">{node.name}</span>
                  <span className="shrink-0 font-mono text-xs text-muted-foreground">
                    {node.osArch || t('admin:nodes.notReported')}
                  </span>
                </div>
              ))}
            </div>
            <div className="space-y-2">
              <Label htmlFor="batch-upgrade-resource">{t('admin:nodes.batchUpgradeResource')}</Label>
              <Controller
                control={form.control}
                name="resourceId"
                render={({ field }) => (
                  <Select
                    value={field.value || '__default__'}
                    onValueChange={(value) => field.onChange(value === '__default__' ? '' : value)}
                  >
                    <SelectTrigger id="batch-upgrade-resource"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="__default__">{t('admin:nodes.batchUpgradeDefaultResource')}</SelectItem>
                      {compatibleResources.map((resource) => (
                        <SelectItem key={resource.id} value={resource.id}>
                          {resource.version}{resource.isDefault ? t('admin:nodes.defaultBadge') : ''}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              />
              <p className="text-xs text-muted-foreground">
                {t('admin:nodes.batchUpgradeResourceDesc', { count: compatibleResources.length })}
              </p>
            </div>
            <div className="rounded-md border bg-muted/30 p-3 text-sm text-muted-foreground">
              {t('admin:nodes.batchUpgradeOfflineNotice')}
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" disabled={pending} onClick={() => onOpenChange(false)}>
                {t('common:actions.cancel')}
              </Button>
              <Button type="submit" disabled={pending || !nodes.length}>
                {pending ? t('admin:nodes.dispatching') : t('admin:nodes.batchUpgradeConfirm', { count: nodes.length })}
              </Button>
            </DialogFooter>
          </form>
        )}
        {result && (
          <DialogFooter>
            <Button onClick={() => onOpenChange(false)}>{t('common:actions.close')}</Button>
          </DialogFooter>
        )}
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  );
}
