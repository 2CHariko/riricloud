import * as React from 'react';
import { useFormResetOnKey } from '@/hooks/use-form-reset';
import { zodResolver } from '@/lib/zod-resolver';
import { useForm } from 'react-hook-form';
import { useQuery } from '@tanstack/react-query';
import { z } from 'zod';
import { CheckCircle2, CircleAlert, Clock3, Network } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import i18n from '@/i18n/config';
import { api } from '@/lib/api';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { ResponsiveDialog, ResponsiveDialogContent } from '@/components/shared/responsive-dialog';
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { formatDateTime } from '@/lib/utils';
import type { ProbeResult, ProbeSnapshot } from '../use-nodes';

const schema = z.object({
  type: z.enum(['tcp', 'dns', 'icmp']),
  target: z.string().trim().min(1, i18n.t('admin:nodes.valTargetReq')),
  port: z.coerce.number().int().min(1).max(65535).optional(),
  timeoutMs: z.coerce.number().int().min(100).max(10000)
});

type Values = z.infer<typeof schema>;

const presets: Array<{ value: string; label: string; probe: Values }> = [
  { value: 'cloudflare', label: 'Cloudflare Anycast · TCP 443', probe: { type: 'tcp', target: '1.1.1.1', port: 443, timeoutMs: 3000 } },
  { value: 'google-dns', label: 'Google DNS · DNS', probe: { type: 'dns', target: 'dns.google', port: 443, timeoutMs: 3000 } },
  { value: 'github', label: 'GitHub · TCP 443', probe: { type: 'tcp', target: 'github.com', port: 443, timeoutMs: 5000 } },
  { value: 'custom', label: 'custom', probe: { type: 'tcp', target: '', port: 443, timeoutMs: 3000 } }
];

function resultLabel(result: ProbeResult) {
  if (result.type === 'tcp') return 'TCP';
  if (result.type === 'dns') return 'DNS';
  return 'ICMP';
}

function ProbeResultCard({ result }: { result: ProbeResult }) {
  const { t } = useTranslation(['admin', 'common']);
  const success = result.success;
  return (
    <Card className="shadow-none">
      <CardContent className="space-y-2 p-4">
        <div className="flex items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-2">
            <span className="font-medium">{resultLabel(result)}</span>
            <span className="truncate text-sm text-muted-foreground">{result.target}</span>
          </div>
          {success ? (
            <Badge><CheckCircle2 className="mr-1 h-3.5 w-3.5" />{t('admin:nodes.probeNormal')}</Badge>
          ) : (
            <Badge variant="destructive"><CircleAlert className="mr-1 h-3.5 w-3.5" />{t('admin:nodes.probeFailed')}</Badge>
          )}
        </div>
        <div className="grid gap-2 text-sm sm:grid-cols-3">
          <span className="flex items-center gap-1.5 text-muted-foreground">
            <Clock3 className="h-3.5 w-3.5" />{t('admin:nodes.latencyPrefix')}{success && result.latencyMs !== undefined ? `${result.latencyMs} ms` : '—'}
          </span>
          <span className="text-muted-foreground">{t('admin:nodes.packetLossPrefix')}{result.packetLossPercent ?? (success ? 0 : 100)}%</span>
          <span className="truncate text-muted-foreground">{result.addresses?.length ? t('admin:nodes.dnsResolved', { addrs: result.addresses.join(', ') }) : t('admin:nodes.dnsNoAddr')}</span>
        </div>
        {!success && <p className="break-words text-xs text-destructive">{result.message || t('admin:nodes.probeFailedNoDetails')}</p>}
      </CardContent>
    </Card>
  );
}

export function ProbeNodeDialog({ open, onOpenChange, pending, snapshot, onSubmit }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  pending: boolean;
  snapshot: ProbeSnapshot | null;
  onSubmit: (values: { probes: Values[] }) => void;
}) {
  const { t } = useTranslation(['admin', 'common']);
  const settingsQuery = useQuery({
    queryKey: ['admin', 'settings', 'probe-presets'],
    queryFn: async () => (await api.get<{ probePresetTargets: Array<{ type: Values['type']; target: string; port?: number; timeoutMs?: number }> }>('/admin/settings')).data,
    enabled: open,
    staleTime: 60_000
  });
  const form = useForm<Values>({
    resolver: zodResolver(schema),
    defaultValues: presets[0].probe
  });
  const [preset, setPreset] = React.useState('cloudflare');
  const availablePresets = React.useMemo(() => {
    const configured = settingsQuery.data?.probePresetTargets ?? [];
    if (!configured.length) return presets;
    return [
      ...configured.map((item, index) => ({
        value: `configured-${index}`,
        label: `${item.target} · ${item.type.toUpperCase()}`,
        probe: { type: item.type, target: item.target, port: item.port, timeoutMs: item.timeoutMs ?? 3000 } as Values
      })),
      presets[presets.length - 1]
    ];
  }, [settingsQuery.data?.probePresetTargets]);

  useFormResetOnKey({
    open,
    resetKey: preset,
    reset: () => {
      const selected = availablePresets.find((item) => item.value === preset);
      if (selected) form.reset(selected.probe);
    }
  });

  React.useEffect(() => {
    if (!open) return;
    if (availablePresets.some((item) => item.value === preset)) return;
    const first = availablePresets[0];
    if (first) setPreset(first.value);
  }, [availablePresets, open, preset]);

  const applyPreset = (value: string) => setPreset(value);

  return (
    <ResponsiveDialog open={open} onOpenChange={onOpenChange}>
      <ResponsiveDialogContent size="compact">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Network className="h-4 w-4" />
            {t('admin:nodes.probeTitle')}
          </DialogTitle>
          <DialogDescription>{t('admin:nodes.probeDesc')}</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-2">
            <Label>{t('admin:nodes.quickPreset')}</Label>
            <Select value={preset} onValueChange={applyPreset}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {availablePresets.map((item) => (
                  <SelectItem key={item.value} value={item.value}>{item.value === 'custom' ? t('admin:nodes.customTarget') : item.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <Form {...form}>
            <form className="space-y-4" onSubmit={form.handleSubmit((values) => onSubmit({ probes: [values] }))}>
              <div className="grid gap-4 sm:grid-cols-2">
                <FormField
                  control={form.control}
                  name="type"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>{t('admin:nodes.probeType')}</FormLabel>
                      <Select value={field.value} onValueChange={field.onChange}>
                        <FormControl><SelectTrigger><SelectValue /></SelectTrigger></FormControl>
                        <SelectContent>
                          <SelectItem value="tcp">{t('admin:nodes.probeTypeTcp')}</SelectItem>
                          <SelectItem value="dns">{t('admin:nodes.probeTypeDns')}</SelectItem>
                          <SelectItem value="icmp">{t('admin:nodes.probeTypeIcmp')}</SelectItem>
                        </SelectContent>
                      </Select>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="timeoutMs"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>{t('admin:nodes.probeTimeout')}</FormLabel>
                      <FormControl><Input type="number" min={100} max={10000} {...field} /></FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>
              <FormField
                control={form.control}
                name="target"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{t('admin:nodes.probeTarget')}</FormLabel>
                    <FormControl><Input placeholder="example.com / 1.1.1.1" {...field} /></FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="port"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{t('admin:nodes.probePort')}</FormLabel>
                    <FormControl><Input type="number" min={1} max={65535} {...field} /></FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <DialogFooter>
                <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                  {t('common:actions.close')}
                </Button>
                <Button type="submit" disabled={pending}>
                  {pending ? t('admin:nodes.probing') : t('admin:nodes.startProbe')}
                </Button>
              </DialogFooter>
            </form>
          </Form>
          {snapshot && (
            <div className="space-y-3 border-t pt-4">
              <div className="flex items-center justify-between gap-2">
                <p className="text-sm font-medium">{t('admin:nodes.lastProbeResult')}</p>
                <span className="text-xs text-muted-foreground">{formatDateTime(snapshot.completedAt)}</span>
              </div>
              <div className="space-y-2">
                {snapshot.results.map((result, index) => (
                  <ProbeResultCard key={`${result.type}-${result.target}-${index}`} result={result} />
                ))}
              </div>
            </div>
          )}
        </div>
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  );
}
