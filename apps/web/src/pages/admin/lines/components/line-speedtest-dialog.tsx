import { useTranslation } from 'react-i18next';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { ProbeTaskDialog } from '@/components/shared/probe-task-dialog';
import type { AdminLine } from '../use-lines';

export interface LineSpeedtestDialogProps { open: boolean; onOpenChange: (open: boolean) => void; line: AdminLine | null; }
export function LineSpeedtestDialog({ open, onOpenChange, line }: LineSpeedtestDialogProps) {
  const { t } = useTranslation(['admin', 'common']);
  if (!line) return null;
  const unknown = t('common:status.unknown');
  const entryName = line.type === 'EXTERNAL' ? line.upstreamSummary?.name ?? t('admin:upstream.externalType') : line.entryNode?.name ?? unknown;
  const landingName = line.relayMode === 'UPSTREAM_NODE' ? line.upstreamSummary?.name : line.relayMode === 'TARGET_LINE' ? line.targetLine?.name : line.landingNode?.name;
  return <ProbeTaskDialog key={line.id} open={open} onOpenChange={onOpenChange}
    request={{ key: `line:${line.id}`, endpoint: `/admin/lines/${line.id}/speedtest` }} title={`${t('admin:probes.title')} · ${line.name}`}>
    <Card><CardContent className="p-4 space-y-2">
      <p className="text-xs text-muted-foreground">{t('admin:lineSpeedtest.topoPath')}</p>
      <p>{t('admin:probes.perspective')} ➔ {entryName}{line.type === 'RELAY' && <> ➔ {landingName ?? unknown}</>} ➔ {t('admin:probes.configuredTarget')}</p>
      <p className="font-mono text-xs">{line.serverHost}:{line.serverPort} · {line.protocolType}</p>
      <Badge variant="outline">{line.type === 'EXTERNAL' ? t('admin:upstream.externalType') : line.type === 'DIRECT' ? t('admin:lines.typeDirect') : t('admin:lines.typeRelay')}</Badge>
    </CardContent></Card>
  </ProbeTaskDialog>;
}
