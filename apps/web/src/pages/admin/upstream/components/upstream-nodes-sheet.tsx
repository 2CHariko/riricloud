import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Activity, Copy } from 'lucide-react';
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from '@/components/ui/sheet';
import { Button } from '@/components/ui/button';
import { IconButton } from '@/components/ui/icon-button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import { Card, CardContent } from '@/components/ui/card';
import { ServerPagination } from '@/components/shared/server-pagination';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { ApiUpstreamSubscription, ApiUpstreamNode, upstreamApi } from '@/lib/api';
import { useAdminUpstreamNodes, useAdminUpstreamMutations } from '../use-upstream';

export function UpstreamNodesSheet({ open, onOpenChange, subscription, onCreateRelayLine, onCreateExternalLine }: {
  open: boolean; onOpenChange: (open: boolean) => void; subscription?: ApiUpstreamSubscription | null;
  onCreateRelayLine?: (node: ApiUpstreamNode) => void; onCreateExternalLine?: (node: ApiUpstreamNode) => void;
}) {
  const { t } = useTranslation(['admin', 'common']);
  const [search, setSearch] = useState('');
  const [protocol, setProtocol] = useState('ALL');
  const [tag, setTag] = useState('');
  const [page, setPage] = useState(1);
  const { data, isLoading, isError } = useAdminUpstreamNodes({ subscriptionId: subscription?.id, page, pageSize: 20, search: search.trim() || undefined, protocolType: protocol === 'ALL' ? undefined : protocol, tag: tag.trim() || undefined }, open);
  const { setNodeStatusMutation, probeNodeMutation, probeAllMutation } = useAdminUpstreamMutations();
  const copy = async (node?: ApiUpstreamNode) => {
    try {
      const res = await upstreamApi.exportNodes({ nodeIds: node?.id, subscriptionId: node ? undefined : subscription?.id, format: 'uri' });
      await navigator.clipboard.writeText(res.data);
      toast.success(t('admin:upstream.exportSuccess'));
    } catch { toast.error(t('common:actions.copyFailed')); }
  };
  return <Sheet open={open} onOpenChange={onOpenChange}><SheetContent side="right" className="w-full sm:max-w-6xl p-6 overflow-y-auto space-y-4">
    <SheetHeader><SheetTitle>{subscription?.name} · {data?.total ?? 0}</SheetTitle><SheetDescription>{t('admin:upstream.masterProbeView')}</SheetDescription></SheetHeader>
    <div className="flex flex-wrap gap-2">
      <Input className="max-w-xs" value={search} onChange={(e) => { setSearch(e.target.value); setPage(1); }} placeholder={t('admin:upstream.searchNodesPlaceholder')} />
      <Input className="w-32" value={tag} onChange={(e) => { setTag(e.target.value); setPage(1); }} placeholder={t('admin:lines.filterTag')} />
      <Select value={protocol} onValueChange={(v) => { setProtocol(v); setPage(1); }}><SelectTrigger className="w-32"><SelectValue /></SelectTrigger><SelectContent>{['ALL', 'VLESS', 'VMESS', 'HYSTERIA2', 'TUIC', 'TROJAN', 'SHADOWSOCKS', 'SOCKS', 'HTTP', 'NAIVE'].map((v) => <SelectItem key={v} value={v}>{v === 'ALL' ? t('admin:upstream.statusAll') : v}</SelectItem>)}</SelectContent></Select>
      <Button variant="outline" disabled={probeAllMutation.isPending} onClick={() => probeAllMutation.mutate(subscription?.id)}>{t('admin:upstream.probeAll')}</Button>
      <Button variant="outline" onClick={() => void copy()}>{t('admin:upstream.exportUri')}</Button>
    </div>
    <Card><CardContent className="min-w-0 p-0"><Table><TableHeader><TableRow>{(['colNodeName', 'colProtocol', 'colServer', 'colLatency', 'colStatus', 'relatedLines', 'colActions'] as const).map((k) => <TableHead key={k}>{t(`admin:upstream.${k}`)}</TableHead>)}</TableRow></TableHeader><TableBody>
      {isLoading || isError || !data?.data.length ? <TableRow><TableCell colSpan={7}>{isLoading ? t('common:actions.loading') : isError ? t('common:status.failed') : t('admin:upstream.emptyNodesTitle')}</TableCell></TableRow> : data.data.map((node) => <TableRow key={node.id}>
        <TableCell><p>{node.name}</p><div className="flex flex-wrap gap-1">{node.tags.map((item) => <Badge key={item} variant="secondary">{item}</Badge>)}</div></TableCell>
        <TableCell>{node.protocolType}</TableCell><TableCell className="font-mono text-xs">{node.serverHost}:{node.serverPort}</TableCell>
        <TableCell>{node.lastTestStatus === 'NOT_APPLICABLE' ? t('admin:upstream.probeNotApplicable') : node.lastTestStatus === 'SUCCESS' && node.latencyMs !== null ? `${node.latencyMs} ms` : node.lastTestStatus === 'TIMEOUT' ? t('admin:upstream.probeTimeout') : node.lastTestStatus === 'ERROR' ? t('common:status.failed') : t('admin:upstream.never')}</TableCell>
        <TableCell><Badge variant={node.presenceStatus === 'MISSING' ? 'destructive' : 'outline'}>{node.presenceStatus === 'MISSING' ? t('admin:upstream.missing') : t('admin:upstream.present')}</Badge><Switch aria-label={t('admin:upstream.statusActive')} checked={node.status === 'ACTIVE'} disabled={setNodeStatusMutation.isPending} onCheckedChange={(v) => setNodeStatusMutation.mutate({ nodeId: node.id, status: v ? 'ACTIVE' : 'DISABLED' })} /></TableCell>
        <TableCell className="text-xs">{node.relayLines?.map((line) => <p key={line.id}>{line.name} · {line.status === 'ACTIVE' ? t('admin:upstream.statusActive') : t('admin:upstream.statusDisabled')}</p>)}</TableCell>
        <TableCell><div className="flex flex-wrap gap-1">
          <IconButton variant="ghost" size="icon-sm" aria-label={t('admin:upstream.probeNode')} disabled={probeNodeMutation.isPending} onClick={() => probeNodeMutation.mutate(node.id)}><Activity /></IconButton>
          <IconButton variant="ghost" size="icon-sm" aria-label={t('common:actions.copy')} onClick={() => void copy(node)}><Copy /></IconButton>
          <Button variant="outline" size="sm" disabled={node.presenceStatus !== 'PRESENT' || node.status !== 'ACTIVE' || subscription?.status !== 'ACTIVE'} onClick={() => onCreateExternalLine?.(node)}>{t('admin:upstream.createExternalLine')}</Button>
          <Button variant="outline" size="sm" disabled={node.presenceStatus !== 'PRESENT' || node.status !== 'ACTIVE' || subscription?.status !== 'ACTIVE'} onClick={() => onCreateRelayLine?.(node)}>{t('admin:upstream.createRelayLine')}</Button>
        </div></TableCell>
      </TableRow>)}
    </TableBody></Table></CardContent></Card>
    <ServerPagination page={page} pageSize={20} total={data?.total ?? 0} pending={isLoading} onPageChange={setPage} />
  </SheetContent></Sheet>;
}
