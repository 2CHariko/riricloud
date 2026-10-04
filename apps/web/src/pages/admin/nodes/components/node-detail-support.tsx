import { useTranslation } from 'react-i18next';
import { Cpu, KeyRound } from 'lucide-react';
import { CopyButton } from '@/components/shared/copy-button';
import { ResponsiveDialog, ResponsiveDialogContent } from '@/components/shared/responsive-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { formatDateTime, formatRate } from '@/lib/utils';
import type { AdminNode, NodeLine, ProbeSnapshot } from '../use-nodes';
import { InstallCommandsPicker } from './install-commands-picker';
import { RotateTokenDialog } from './rotate-token-dialog';

export function GeneratedConfigPreview({ node }: { node: { id: string; lines: NodeLine[] } }) {
  const inbounds = node.lines.flatMap((line) => {
    const result: Array<Record<string, unknown>> = [];
    if (line.entryNodeId === node.id) result.push({ type: line.type === 'RELAY' && line.relayMode === 'BLIND_FORWARD' ? 'direct' : line.protocolType.toLowerCase(), tag: line.type === 'RELAY' ? `relay-${line.id}` : `line-${line.id}`, listen: '0.0.0.0', listen_port: line.entryPort });
    if (line.landingNodeId === node.id && line.type === 'RELAY' && line.relayMode !== 'TARGET_LINE' && line.landingPort) result.push({ type: line.protocolType.toLowerCase(), tag: `line-${line.id}-landing`, listen: '0.0.0.0', listen_port: line.landingPort });
    return result;
  });
  return <pre className="max-h-[480px] overflow-auto rounded-md border bg-muted/50 p-3 text-xs leading-relaxed">{JSON.stringify({ log: { level: 'warn', timestamp: true }, inbounds, outbounds: [{ type: 'direct', tag: 'direct' }] }, null, 2)}</pre>;
}

export function ProbeSnapshotCard({ snapshot }: { snapshot: ProbeSnapshot | null }) {
  const { t } = useTranslation(['admin']);
  if (!snapshot) return <p className="text-sm text-muted-foreground">{t('admin:nodes.emptyFilteredDesc')}</p>;
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2"><p className="text-sm font-medium">{snapshot.success ? t('admin:nodes.probePass') : t('admin:nodes.probeAnomaly')}</p><span className="text-xs text-muted-foreground">{formatDateTime(snapshot.completedAt)}</span></div>
      {snapshot.results.map((result, index) => (
        <div key={`${result.type}-${result.target}-${index}`} className="rounded-md border p-3 text-sm">
          <div className="flex flex-wrap items-center justify-between gap-2"><span className="font-medium">{result.type.toUpperCase()} · {result.target}</span><Badge variant={result.success ? 'default' : 'destructive'}>{result.success ? t('admin:nodes.probeNormal') : t('admin:nodes.probeFailed')}</Badge></div>
          <p className="mt-1 text-xs text-muted-foreground">{t('admin:nodes.probeLatencyLabel')}{result.latencyMs != null ? `${result.latencyMs} ms` : '—'} · {t('admin:nodes.probeLossLabel')}{result.packetLossPercent ?? (result.success ? 0 : 100)}%{result.addresses?.length ? ` · ${t('admin:nodes.probeAddrLabel')}${result.addresses.join(', ')}` : ''}</p>
          {result.message && <p className="mt-1 break-words text-xs text-destructive">{result.message}</p>}
        </div>
      ))}
    </div>
  );
}

export function InstallCommandDialog({ open, onOpenChange, node }: { open: boolean; onOpenChange: (open: boolean) => void; node: AdminNode }) {
  const { t } = useTranslation(['admin', 'common']);
  const uninstallCommand = node.uninstallCommand ?? 'sudo /usr/local/bin/riri-agent uninstall --purge --yes';
  const windowsUninstallCommand = node.windowsUninstallCommand ?? '& "$env:ProgramFiles\\RiriCloud\\riri-agent.exe" uninstall --purge --yes';
  return (
    <ResponsiveDialog open={open} onOpenChange={onOpenChange}>
      <ResponsiveDialogContent size="compact">
        <DialogHeader><DialogTitle>{t('admin:nodes.installTitle')}</DialogTitle><DialogDescription>{t('admin:nodes.installSubtitle')}</DialogDescription></DialogHeader>
        <div className="min-w-0 space-y-4">
          <InstallCommandsPicker key={open ? node.id : 'closed'} commands={node.installCommands} defaultMode={node.communicationMode === 'HTTP' ? 'http' : 'ws'} nodeOsArch={node.osArch} nodeId={node.id} />
          <div className="space-y-2"><Label>{t('admin:nodes.uninstallLinuxMac')}</Label><div className="flex min-w-0 items-start gap-2"><code className="min-w-0 flex-1 break-all rounded-md border bg-muted/40 p-3 text-xs">{uninstallCommand}</code><CopyButton value={uninstallCommand} /></div></div>
          <div className="space-y-2"><Label>{t('admin:nodes.uninstallWindows')}</Label><div className="flex min-w-0 items-start gap-2"><code className="min-w-0 flex-1 break-all rounded-md border bg-muted/40 p-3 text-xs">{windowsUninstallCommand}</code><CopyButton value={windowsUninstallCommand} /></div></div>
        </div>
        <DialogFooter><Button variant="outline" onClick={() => onOpenChange(false)}>{t('common:actions.close')}</Button></DialogFooter>
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  );
}

export function NodeProfileCards({ node }: { node: AdminNode }) {
  const { t } = useTranslation(['admin']);
  const rate = (value: number | null) => node.status === 'ONLINE' && value != null ? formatRate(value) : '—';
  const totalRate = node.uploadRate != null && node.downloadRate != null ? node.uploadRate + node.downloadRate : node.bandwidthRate;
  return (<>
    <Card>
      <CardHeader><CardTitle className="flex items-center gap-2 text-base"><KeyRound className="size-4" />{t('admin:nodes.agentProfile')}</CardTitle></CardHeader>
      <CardContent className="space-y-3">
        {node.pendingVersionConfirm && <div className="rounded-md border border-warning/20 bg-warning/10 p-3 text-sm text-warning">{t('admin:nodes.versionMismatchWarning', { time: formatDateTime(node.pendingVersionConfirm.completedAt), current: node.agentVersion || t('admin:nodes.notReported'), expected: node.pendingVersionConfirm.expectedVersion })}</div>}
        <p className="text-sm text-muted-foreground">{t('admin:nodes.tokenNotice')}</p>
        {node.isLocal ? <p className="text-sm text-muted-foreground">{t('admin:nodes.localNodeNotice')}</p> : <RotateTokenDialog node={node} />}
        <div className="grid gap-2 text-sm sm:grid-cols-2">
          <span className="text-muted-foreground">{t('admin:nodes.commMode')}<strong className="font-medium text-foreground">{node.communicationMode === 'HTTP' ? t('admin:nodes.commModeHttp') : t('admin:nodes.commModeWs')}</strong></span>
          <span className="text-muted-foreground">{t('admin:nodes.pollInterval')}<strong className="font-medium text-foreground">{node.pollIntervalSecs}s</strong></span>
          <span className="text-muted-foreground">{t('admin:nodes.version')}: <strong className="font-medium text-foreground">{node.agentVersion || t('admin:nodes.notReported')}</strong></span>
          <span className="text-muted-foreground">{t('admin:nodes.osArch')}: <strong className="font-medium text-foreground">{node.osArch || t('admin:nodes.notReported')}</strong></span>
          <span className="text-muted-foreground">{t('admin:nodes.kernelVersion')}: <strong className="font-medium text-foreground">{node.kernelVersion || t('admin:nodes.notReported')}</strong></span>
          <span className="text-muted-foreground">{t('admin:nodes.lastHeartbeat')}: <strong className="font-medium text-foreground">{node.lastSeenAt ? formatDateTime(node.lastSeenAt) : t('admin:nodes.notReported')}</strong></span>
        </div>
        <p className="text-sm text-muted-foreground">{t('admin:nodes.kernelRunningStatus')}{node.status !== 'ONLINE' || node.kernelRunning == null ? t('admin:nodes.unknown') : node.kernelRunning ? t('admin:nodes.kernelRunning') : t('admin:nodes.kernelStopped')}</p>
      </CardContent>
    </Card>
    <Card>
      <CardHeader><CardTitle className="flex items-center gap-2 text-base"><Cpu className="size-4" />{t('admin:nodes.realtimeTelemetry')}</CardTitle></CardHeader>
      <CardContent className="grid gap-4 text-sm text-muted-foreground sm:grid-cols-2 lg:grid-cols-5">
        <span>{t('admin:nodes.statCpu')} {node.status === 'ONLINE' && node.cpuUsage != null ? `${node.cpuUsage.toFixed(1)}%` : '—'}</span>
        <span>{t('admin:nodes.statMem')} {node.status === 'ONLINE' && node.memoryUsage != null ? `${node.memoryUsage.toFixed(1)}%` : '—'}</span>
        <span>{t('admin:nodes.statUp')}{rate(node.uploadRate)}</span><span>{t('admin:nodes.statDown')}{rate(node.downloadRate)}</span><span>{t('admin:nodes.statTotal')}{rate(totalRate)}</span>
        <p className="sm:col-span-2 lg:col-span-5">{t('admin:nodes.telemetryNote')}</p>
      </CardContent>
    </Card>
  </>);
}
