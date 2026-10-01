import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Badge } from '@/components/ui/badge';
import { Label } from '@/components/ui/label';
import { Card, CardContent } from '@/components/ui/card';
import { ProbeMeasurementChip } from '@/components/shared/probe-result';
import { proxyAuthority } from '../proxy-snippets';
import type { ProxyPoolEndpoint } from '../use-proxy-pool';
import type { ProxyExportState } from '../use-proxy-export';

export function ProxyEndpointSelection({ endpoints, pending, excludedCount, state }: {
  endpoints: ProxyPoolEndpoint[]; pending: boolean; excludedCount: number; state: ProxyExportState;
}) {
  const { t } = useTranslation(['user', 'common']);
  return <Card><CardContent className="space-y-3 p-3">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <p className="text-sm font-medium">{t('user:proxyPool.selectNodesTitle', { selected: state.selectedLineIds.length, total: endpoints.length })}</p>
      <div className="flex gap-2">
        <Button size="sm" variant="ghost" disabled={pending} onClick={() => state.setSelection(endpoints.filter((endpoint) => endpoint.status === 'AVAILABLE').map((endpoint) => endpoint.lineId))}>{t('user:proxyPool.selectAll')}</Button>
        <Button size="sm" variant="ghost" onClick={() => state.setSelection([])}>{t('user:proxyPool.clearAll')}</Button>
      </div>
    </div>
    {excludedCount > 0 && <p className="text-sm text-destructive">{t('user:proxyPool.capacityExcludedCount', { count: excludedCount })}</p>}
    {pending ? <p>{t('user:proxyPool.loadingNodes')}</p> : !endpoints.length ? <p>{t('user:proxyPool.noNodesConfigured')}</p> :
      <div className="grid gap-2 sm:grid-cols-2">{endpoints.map((endpoint) => <div key={endpoint.lineId} className="flex min-w-0 items-start gap-2 rounded-md border p-3">
        <Checkbox id={`endpoint-${endpoint.lineId}`} checked={state.selectedLineIds.includes(endpoint.lineId)}
          disabled={endpoint.status !== 'AVAILABLE'}
          onCheckedChange={(checked) => state.toggleLine(endpoint.lineId, checked === true)} />
        <div className="min-w-0 flex-1 space-y-1">
          <Label htmlFor={`endpoint-${endpoint.lineId}`} className="break-words">{endpoint.name}</Label>
          <p className="break-all font-mono text-xs text-muted-foreground">{proxyAuthority(endpoint.host, endpoint.port)}</p>
          <div className="flex flex-wrap items-center gap-1">
            <Badge variant="outline">{t(endpoint.routeKind === 'UPSTREAM_RELAY' ? 'user:proxyPool.routeRelay' : 'user:proxyPool.routeDirect')}</Badge>
            <Badge variant={endpoint.online ? 'secondary' : 'destructive'}>{t(endpoint.online ? 'user:proxyPool.online' : 'user:proxyPool.offline')}</Badge>
            {endpoint.region && <Badge variant="outline">{endpoint.region}</Badge>}
            <ProbeMeasurementChip value={endpoint.lastProbe} />
            {endpoint.tls && <Badge variant="secondary">HTTPS</Badge>}
          </div>
          <p className="text-xs text-muted-foreground">{t('user:proxyPool.protocolCapabilities', { protocols: endpoint.supportedProtocols.join(' / '), rate: endpoint.trafficRate })}</p>
          {endpoint.status === 'CAPACITY_EXCLUDED' && <p className="text-xs text-destructive">{t('user:proxyPool.capacityExcluded')}</p>}
          {endpoint.reason && <p className="break-words text-xs text-muted-foreground">{endpoint.reason}</p>}
        </div>
      </div>)}</div>}
  </CardContent></Card>;
}
