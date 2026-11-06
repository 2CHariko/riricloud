import { useFormResetOnKey } from '@/hooks/use-form-reset';
import { zodResolver } from '@/lib/zod-resolver';
import { Controller, useForm } from 'react-hook-form';
import { z } from 'zod';
import { useTranslation } from 'react-i18next';
import i18n from '@/i18n/config';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { ResponsiveDialog, ResponsiveDialogContent } from '@/components/shared/responsive-dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import type { AdminBinaryInfo, AdminNode } from '../use-nodes';
import type { BinaryResource } from '../../binaries/use-binaries';

const schema = z.object({
  target: z.literal('agent').default('agent'),
  source: z.enum(['master', 'custom']),
  resourceId: z.string().optional(),
  version: z.string().optional(),
  url: z.string().optional(),
  sha256: z.string().optional()
}).superRefine((value, context) => {
  if (value.source === 'custom') {
    if (!value.version?.trim()) context.addIssue({ code: z.ZodIssueCode.custom, path: ['version'], message: i18n.t('admin:nodes.valCustomVersionReq') });
    if (!value.url || !/^https?:\/\//i.test(value.url)) context.addIssue({ code: z.ZodIssueCode.custom, path: ['url'], message: i18n.t('admin:nodes.valDownloadUrlReq') });
    if (!value.sha256 || !/^[a-f0-9]{64}$/i.test(value.sha256)) context.addIssue({ code: z.ZodIssueCode.custom, path: ['sha256'], message: i18n.t('admin:nodes.valSha256Hex') });
  }
});

type Values = z.infer<typeof schema>;

function normalizeArch(value: string | null) {
  if (!value) return '';
  return value.toLowerCase().replace('/', '-').replace('x86_64', 'amd64').replace('aarch64', 'arm64');
}

export function UpgradeNodeDialog({ open, onOpenChange, pending, importing: _importing, node, binaryInfo, resources, onSubmit, onImport: _onImport }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  pending: boolean;
  importing?: boolean;
  node: Pick<AdminNode, 'osArch' | 'agentVersion' | 'kernelVersion'>;
  binaryInfo?: AdminBinaryInfo;
  resources?: BinaryResource[];
  onSubmit: (values: { target: 'agent'; resourceId?: string; version?: string; url?: string; sha256?: string }) => void;
  onImport?: (values: { target: string; version: string; url: string; sha256: string }) => void;
}) {
  const { t } = useTranslation(['admin', 'common']);
  const form = useForm<Values>({
    resolver: zodResolver(schema),
    defaultValues: { target: 'agent', source: 'master', resourceId: '', version: '', url: '', sha256: '' }
  });
  const source = form.watch('source');
  const platform = normalizeArch(node.osArch);
  const builtIn = binaryInfo?.targets.find((item) => item.kind === 'agent' && item.target.endsWith(platform));
  const resourceId = form.watch('resourceId');
  const resourceOptions = resources?.filter((item) => item.kind === 'AGENT' && item.status === 'ACTIVE' && item.assets.some((asset) => asset.target === `agent-${platform}`)) ?? [];
  const selectedResource = resourceOptions.find((item) => item.id === resourceId);

  useFormResetOnKey({
    open,
    resetKey: 'upgrade',
    reset: () => form.reset({ target: 'agent', source: 'master', resourceId: '', version: '', url: '', sha256: '' })
  });

  const submit = (values: Values) => onSubmit({
    target: 'agent',
    ...(values.source === 'master' && values.resourceId ? { resourceId: values.resourceId } : {}),
    ...(values.version?.trim() ? { version: values.version.trim() } : {}),
    ...(values.source === 'custom' ? { url: values.url?.trim(), sha256: values.sha256?.trim().toLowerCase() } : {})
  });

  return (
    <ResponsiveDialog open={open} onOpenChange={onOpenChange}>
      <ResponsiveDialogContent size="compact">
        <DialogHeader>
          <DialogTitle>{t('admin:nodes.upgradeTitle')}</DialogTitle>
          <DialogDescription>{t('admin:nodes.upgradeDesc')}</DialogDescription>
        </DialogHeader>
        <form className="space-y-4" onSubmit={form.handleSubmit(submit)}>
          <div className="space-y-2">
            <Label>{t('admin:nodes.fileSource')}</Label>
            <Controller
              control={form.control}
              name="source"
              render={({ field }) => (
                <Select value={field.value} onValueChange={field.onChange}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="master">{t('admin:nodes.masterSource')}</SelectItem>
                    <SelectItem value="custom">{t('admin:nodes.customSource')}</SelectItem>
                  </SelectContent>
                </Select>
              )}
            />
          </div>
          <div className="rounded-md border bg-muted/30 p-3 text-sm">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-muted-foreground">{t('admin:nodes.currentAgent')}</span>
              <span className="font-medium">{node.agentVersion || t('admin:nodes.notReported')}</span>
              <span className="text-muted-foreground ml-2">{t('admin:nodes.embeddedKernel')}</span>
              <span className="font-medium">{node.kernelVersion || t('admin:nodes.notReported')}</span>
              {source === 'master' && (
                <>
                  <span className="text-muted-foreground ml-2">{t('admin:nodes.availableResource')}</span>
                  <Badge variant={selectedResource || builtIn?.available ? 'default' : 'secondary'}>
                    {selectedResource?.version || builtIn?.version || t('admin:nodes.noArchFound')}
                  </Badge>
                </>
              )}
            </div>
            <p className="mt-1 text-xs text-muted-foreground">
              {t('admin:nodes.runningPlatform')}{node.osArch || t('admin:nodes.notReported')}
            </p>
          </div>
          {source === 'master' && (
            <div className="space-y-2">
              <Label>{t('admin:nodes.resourceVersion')}</Label>
              <Controller
                control={form.control}
                name="resourceId"
                render={({ field }) => (
                  <Select value={field.value || undefined} onValueChange={field.onChange}>
                    <SelectTrigger>
                      <SelectValue placeholder={resourceOptions.length ? t('admin:nodes.selectActiveResource') : t('admin:nodes.useDefaultResource')} />
                    </SelectTrigger>
                    <SelectContent>
                      {resourceOptions.map((item) => (
                        <SelectItem key={item.id} value={item.id}>
                          {item.version}{item.isDefault ? t('admin:nodes.defaultBadge') : ''}{t('admin:nodes.platformAssetsCount', { count: item.assets.length })}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              />
              <p className="text-xs text-muted-foreground">{t('admin:nodes.activeResourceDesc')}</p>
            </div>
          )}
          <div className="space-y-2">
            <Label htmlFor="upgrade-version">
              {t('admin:nodes.versionField')}{source === 'master' ? t('admin:nodes.versionFieldMasterHint') : ''}
            </Label>
            <Input
              id="upgrade-version"
              placeholder={source === 'master' ? (builtIn?.version || '1.11.0') : '1.11.0'}
              {...form.register('version')}
            />
            {form.formState.errors.version && <p className="text-xs text-destructive">{form.formState.errors.version.message}</p>}
          </div>
          {source === 'custom' && (
            <>
              <div className="space-y-2">
                <Label htmlFor="upgrade-url">{t('admin:nodes.customUrl')}</Label>
                <Input id="upgrade-url" placeholder="https://example.com/riri-agent" {...form.register('url')} />
                {form.formState.errors.url && <p className="text-xs text-destructive">{form.formState.errors.url.message}</p>}
              </div>
              <div className="space-y-2">
                <Label htmlFor="upgrade-sha256">{t('admin:nodes.customSha256')}</Label>
                <Input id="upgrade-sha256" placeholder={t('admin:nodes.sha256Placeholder')} className="font-mono text-xs" {...form.register('sha256')} />
                {form.formState.errors.sha256 && <p className="text-xs text-destructive">{form.formState.errors.sha256.message}</p>}
              </div>
            </>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>{t('common:actions.cancel')}</Button>
            <Button type="submit" disabled={pending}>
              {pending ? t('admin:nodes.dispatching') : t('admin:nodes.dispatchUpgrade')}
            </Button>
          </DialogFooter>
        </form>
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  );
}
