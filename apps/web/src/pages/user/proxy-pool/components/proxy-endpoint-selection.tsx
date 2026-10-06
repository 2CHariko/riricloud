import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ProbeMeasurementChip } from '@/components/shared/probe-result';
import { FlagText } from '@/components/shared/flag-text';
import { cn } from '@/lib/utils';
import { proxyAuthority } from '../proxy-snippets';
import type { ProxyPoolEndpoint } from '../use-proxy-pool';
import type { ProxyExportState } from '../use-proxy-export';

export function ProxyEndpointSelection({
  endpoints,
  pending,
  excludedCount,
  state
}: {
  endpoints: ProxyPoolEndpoint[];
  pending: boolean;
  excludedCount: number;
  state: ProxyExportState;
}) {
  const { t } = useTranslation(['user', 'common']);

  return (
    <Card>
      <CardHeader className="p-4 pb-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle className="text-sm font-medium">
            {t('user:proxyPool.selectNodesTitle', {
              selected: state.selectedLineIds.length,
              total: endpoints.length
            })}
          </CardTitle>
          <div className="flex items-center gap-1.5">
            <Button
              size="sm"
              variant="outline"
              className="h-7 text-xs"
              disabled={pending || !endpoints.length}
              onClick={() =>
                state.setSelection(
                  endpoints
                    .filter((endpoint) => endpoint.status === 'AVAILABLE')
                    .map((endpoint) => endpoint.lineId)
                )
              }
            >
              {t('user:proxyPool.selectAll')}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="h-7 text-xs"
              disabled={state.selectedLineIds.length === 0}
              onClick={() => state.setSelection([])}
            >
              {t('user:proxyPool.clearAll')}
            </Button>
          </div>
        </div>
      </CardHeader>

      <CardContent className="p-4 pt-1 space-y-3">
        {excludedCount > 0 && (
          <p className="text-xs text-destructive font-medium">
            {t('user:proxyPool.capacityExcludedCount', { count: excludedCount })}
          </p>
        )}

        {pending ? (
          <p className="text-sm text-muted-foreground">{t('user:proxyPool.loadingNodes')}</p>
        ) : !endpoints.length ? (
          <p className="text-sm text-muted-foreground py-4 text-center">
            {t('user:proxyPool.noNodesConfigured')}
          </p>
        ) : (
          <div className="grid gap-2.5 sm:grid-cols-2 xl:grid-cols-3">
            {endpoints.map((endpoint) => {
              const isSelected = state.selectedLineIds.includes(endpoint.lineId);
              const isAvailable = endpoint.status === 'AVAILABLE';

              return (
                <div
                  key={endpoint.lineId}
                  onClick={() => isAvailable && state.toggleLine(endpoint.lineId, !isSelected)}
                  className={cn(
                    'flex min-w-0 items-start gap-2.5 rounded-lg border p-3 transition-colors select-none',
                    isAvailable
                      ? 'cursor-pointer hover:border-foreground/30 hover:bg-muted/30'
                      : 'opacity-55 cursor-not-allowed bg-muted/10',
                    isSelected && 'border-primary bg-primary/5 shadow-sm ring-1 ring-primary/25'
                  )}
                >
                  <Checkbox
                    id={`endpoint-${endpoint.lineId}`}
                    checked={isSelected}
                    disabled={!isAvailable}
                    onCheckedChange={(checked) => state.toggleLine(endpoint.lineId, checked === true)}
                    onClick={(e) => e.stopPropagation()}
                    className="mt-0.5"
                  />
                  <div className="min-w-0 flex-1 space-y-1.5">
                    <div className="flex items-center justify-between gap-1.5">
                      <span className="truncate text-sm font-medium text-foreground" title={endpoint.name}>
                        <FlagText text={endpoint.name} />
                      </span>
                      <Badge
                        variant={endpoint.routeKind === 'UPSTREAM_RELAY' ? 'secondary' : 'outline'}
                        className="text-[10px] px-1.5 py-0 shrink-0 font-normal"
                      >
                        {t(endpoint.routeKind === 'UPSTREAM_RELAY' ? 'user:proxyPool.routeRelay' : 'user:proxyPool.routeDirect')}
                      </Badge>
                    </div>

                    <p className="break-all font-mono text-xs text-muted-foreground">
                      {proxyAuthority(endpoint.host, endpoint.port)}
                    </p>

                    <div className="flex flex-wrap items-center gap-1">
                      <Badge
                        variant="outline"
                        className={cn(
                          'text-[10px] px-1.5 py-0 font-normal',
                          endpoint.online
                            ? 'text-emerald-600 dark:text-emerald-400 bg-emerald-500/10 border-emerald-500/20'
                            : 'text-destructive bg-destructive/10 border-destructive/20'
                        )}
                      >
                        {t(endpoint.online ? 'user:proxyPool.online' : 'user:proxyPool.offline')}
                      </Badge>
                      {endpoint.region && (
                        <Badge variant="outline" className="text-[10px] px-1 py-0">
                          {endpoint.region}
                        </Badge>
                      )}
                      <ProbeMeasurementChip value={endpoint.lastProbe} />
                      {endpoint.tls && (
                        <Badge variant="secondary" className="text-[10px] px-1.5 py-0 font-mono">
                          HTTPS
                        </Badge>
                      )}
                    </div>

                    <p className="text-[11px] text-muted-foreground">
                      {t('user:proxyPool.protocolCapabilities', {
                        protocols: endpoint.supportedProtocols.join(' / ').toUpperCase(),
                        rate: endpoint.trafficRate
                      })}
                    </p>

                    {endpoint.status === 'CAPACITY_EXCLUDED' && (
                      <p className="text-xs text-destructive font-medium">{t('user:proxyPool.capacityExcluded')}</p>
                    )}
                    {endpoint.reason && (
                      <p className="break-words text-xs text-muted-foreground">{endpoint.reason}</p>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
