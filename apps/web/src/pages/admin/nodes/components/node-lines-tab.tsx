import { useTranslation } from 'react-i18next';
import { GitBranch } from 'lucide-react';
import { EmptyState } from '@/components/shared/empty-state';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import type { AdminNode } from '../use-nodes';

export function NodeLinesTab({ node }: { node: AdminNode }) {
  const { t } = useTranslation(['admin']);
  return (<>
    <Card>
      <CardHeader><CardTitle className="flex items-center gap-2 text-base"><GitBranch className="size-4" />{t('admin:nodes.currentLines', { count: node.lines.length })}</CardTitle></CardHeader>
      <CardContent className="p-0">
        {node.lines.length ? (
          <Table className="min-w-[720px]">
            <TableHeader><TableRow>
              <TableHead>{t('admin:lines.colLine')}</TableHead><TableHead>{t('admin:lines.protocol')}</TableHead><TableHead>{t('admin:lines.type')}</TableHead>
              <TableHead>{t('admin:lines.entryPort')}</TableHead><TableHead>{t('admin:lines.landingPort')}</TableHead><TableHead>{t('admin:lines.status')}</TableHead>
            </TableRow></TableHeader>
            <TableBody>{node.lines.map((line) => (
              <TableRow key={line.id}>
                <TableCell className="font-medium">{line.name}</TableCell><TableCell><Badge variant="outline">{line.protocolType}</Badge></TableCell>
                <TableCell>
                  {line.role === 'DIRECT' ? t('admin:nodes.roleDirect') : line.role === 'ENTRY' ? t('admin:nodes.roleTransit') : t('admin:nodes.roleLanding')}
                  {line.type === 'RELAY' && <span className="ml-1 text-xs text-muted-foreground">· {line.relayMode === 'BLIND_FORWARD' ? t('admin:lines.relayBlindForward') : line.relayMode === 'TARGET_LINE' ? t('admin:lines.relayTargetBridge') : t('admin:lines.relayProtocolProxy')}</span>}
                </TableCell>
                <TableCell className="tabular-nums">{line.entryNodeId === node.id ? line.entryPort : '—'}</TableCell>
                <TableCell className="tabular-nums">{line.landingNodeId === node.id ? (line.landingPort ?? '—') : '—'}</TableCell>
                <TableCell><Badge variant={line.status === 'ACTIVE' ? 'default' : 'secondary'}>{line.status === 'ACTIVE' ? t('admin:lines.statusActive') : t('admin:lines.statusDisabled')}</Badge></TableCell>
              </TableRow>
            ))}</TableBody>
          </Table>
        ) : <EmptyState title={t('admin:lines.emptyLines')} description={t('admin:nodes.emptyFilteredDesc')} className="border-0" />}
      </CardContent>
    </Card>
    <Card>
      <CardHeader><CardTitle className="text-base">{t('admin:nodes.derivedPorts')}</CardTitle></CardHeader>
      <CardContent className="grid gap-2 sm:grid-cols-2">
        {node.servicePorts.length ? node.servicePorts.map((port) => (
          <div key={`${port.lineId}-${port.role}`} className="flex items-center justify-between rounded-md border px-3 py-2 text-sm">
            <span className="truncate">{port.lineName}</span><span className="font-mono text-xs text-muted-foreground">{port.port} · {port.role === 'DIRECT' ? t('admin:nodes.roleDirect') : port.role === 'TRANSIT' ? t('admin:nodes.roleTransit') : t('admin:nodes.roleLanding')}</span>
          </div>
        )) : <p className="text-sm text-muted-foreground">{t('admin:nodes.noDerivedPorts')}</p>}
      </CardContent>
    </Card>
  </>);
}
