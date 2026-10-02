import * as React from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { Layers, Server, AlertTriangle, CheckCircle2, KeyRound, Network, Info } from 'lucide-react';
import { api, extractErrorMessage } from '@/lib/api';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetTrigger } from '@/components/ui/sheet';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Progress } from '@/components/ui/progress';
import { Card, CardContent } from '@/components/ui/card';
import { cn } from '@/lib/utils';

interface ProxyPoolOverview {
  totalKeys: number;
  activeKeys: number;
  disabledKeys: number;
  trafficUsedBytes: number;
  endpointCount: number;
  nodeCapacities: Array<{
    nodeId: string;
    nodeName: string;
    used: number;
    limit: number;
    excluded: number;
  }>;
}

export function ProxyPoolDrawer() {
  const { t } = useTranslation(['admin', 'common']);
  const [open, setOpen] = React.useState(false);

  const query = useQuery({
    queryKey: ['admin', 'proxy-pool', 'overview'],
    queryFn: async () => (await api.get<ProxyPoolOverview>('/admin/proxy-pool/overview')).data,
    refetchInterval: 30_000
  });

  const capacities = query.data?.nodeCapacities ?? [];
  const hasExcluded = capacities.some((n) => n.excluded > 0);
  const hasHighUsage = capacities.some((n) => n.limit > 0 && n.used / n.limit >= 0.8);

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <Button variant="outline" size="sm" className="relative gap-2">
          <Layers className="size-4 text-muted-foreground" />
          <span>{t('admin:lines.proxyPoolTrigger')}</span>
          {capacities.length > 0 && (
            <Badge variant="secondary" className="px-1.5 py-0 text-[10px] font-normal">
              {capacities.length}
            </Badge>
          )}
          {hasExcluded ? (
            <span className="absolute -top-1 -right-1 flex h-2.5 w-2.5">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-destructive opacity-75" />
              <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-destructive" />
            </span>
          ) : hasHighUsage ? (
            <span className="absolute -top-1 -right-1 h-2.5 w-2.5 rounded-full bg-amber-500" />
          ) : null}
        </Button>
      </SheetTrigger>
      <SheetContent side="right" className="w-full sm:max-w-md overflow-y-auto">
        <SheetHeader className="text-left space-y-1">
          <div className="flex items-center gap-2">
            <Layers className="size-5 text-primary" />
            <SheetTitle>{t('admin:lines.proxyPoolDrawerTitle')}</SheetTitle>
          </div>
          <SheetDescription className="text-xs">
            {t('admin:lineForm.proxyPoolCapacityDesc')}
          </SheetDescription>
        </SheetHeader>

        <div className="mt-6 space-y-5">
          {query.isPending ? (
            <p className="text-sm text-muted-foreground">{t('common:actions.loading')}</p>
          ) : query.isError ? (
            <p role="alert" className="text-sm text-destructive">
              {extractErrorMessage(query.error, t('common:status.failed'))}
            </p>
          ) : (
            <>
              {/* 3 项紧凑概览仪表板 */}
              <div className="grid grid-cols-3 gap-2.5">
                <div className="rounded-lg border bg-muted/20 p-2.5 flex flex-col justify-between">
                  <div className="flex items-center gap-1 text-muted-foreground text-xs">
                    <Network className="size-3.5" />
                    <span>{t('admin:lines.proxyPoolMetricEndpoints')}</span>
                  </div>
                  <div className="mt-1.5">
                    <span className="text-xl font-bold font-mono tracking-tight">
                      {query.data?.endpointCount ?? 0}
                    </span>
                    <p className="text-[10px] text-muted-foreground truncate">
                      {t('admin:lines.proxyPoolMetricEndpointsSub')}
                    </p>
                  </div>
                </div>

                <div className="rounded-lg border bg-muted/20 p-2.5 flex flex-col justify-between">
                  <div className="flex items-center gap-1 text-muted-foreground text-xs">
                    <KeyRound className="size-3.5" />
                    <span>{t('admin:lines.proxyPoolMetricKeys')}</span>
                  </div>
                  <div className="mt-1.5">
                    <span className="text-xl font-bold font-mono tracking-tight">
                      {query.data?.activeKeys ?? 0}
                    </span>
                    <p className="text-[10px] text-muted-foreground truncate" title={t('admin:lines.proxyPoolMetricKeysSub', { active: query.data?.activeKeys ?? 0, total: query.data?.totalKeys ?? 0 })}>
                      {t('admin:lines.proxyPoolMetricKeysSub', { active: query.data?.activeKeys ?? 0, total: query.data?.totalKeys ?? 0 })}
                    </p>
                  </div>
                </div>

                <div className="rounded-lg border bg-muted/20 p-2.5 flex flex-col justify-between">
                  <div className="flex items-center gap-1 text-muted-foreground text-xs">
                    <Server className="size-3.5" />
                    <span>{t('admin:lines.proxyPoolMetricNodes')}</span>
                  </div>
                  <div className="mt-1.5">
                    <span className="text-xl font-bold font-mono tracking-tight">
                      {capacities.length}
                    </span>
                    <p className="text-[10px] text-muted-foreground truncate">
                      {t('admin:lines.proxyPoolMetricNodesSub')}
                    </p>
                  </div>
                </div>
              </div>

              {/* 各节点配额水位明细 */}
              <div className="space-y-3">
                <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                  {t('admin:lines.proxyPoolSectionWatermark')}
                </h4>
                {capacities.length === 0 ? (
                  <p className="text-xs text-muted-foreground">{t('admin:lines.proxyPoolEmptyNodes')}</p>
                ) : (
                  capacities.map((node) => {
                    const limit = Math.max(1, node.limit);
                    const rawPct = (node.used / limit) * 100;
                    const pct = Math.min(100, Math.round(rawPct));
                    const isOver = node.excluded > 0;
                    const isWarning = !isOver && pct >= 80;

                    return (
                      <Card key={node.nodeId} className="border shadow-none">
                        <CardContent className="p-3.5 space-y-2.5">
                          <div className="flex items-center justify-between">
                            <div className="flex items-center gap-2">
                              <Server className="size-4 text-muted-foreground shrink-0" />
                              <span className="text-sm font-medium">{node.nodeName}</span>
                            </div>
                            {isOver ? (
                              <Badge variant="destructive" className="gap-1 text-[11px] py-0">
                                <AlertTriangle className="size-3" />
                                {t('admin:lines.proxyPoolStatusExcluded')}: {node.excluded}
                              </Badge>
                            ) : isWarning ? (
                              <Badge variant="outline" className="gap-1 text-[11px] py-0 border-amber-500/40 text-amber-500 bg-amber-500/10">
                                <AlertTriangle className="size-3" />
                                {t('admin:lines.proxyPoolStatusWarning')}
                              </Badge>
                            ) : (
                              <Badge variant="secondary" className="gap-1 text-[11px] py-0 text-emerald-600 dark:text-emerald-400">
                                <CheckCircle2 className="size-3" />
                                {t('admin:lines.proxyPoolStatusNormal')}
                              </Badge>
                            )}
                          </div>

                          <div className="space-y-1">
                            <div className="flex items-center justify-between text-xs text-muted-foreground">
                              <span>
                                {t('admin:lines.proxyPoolUsedLimit', { used: node.used, limit: node.limit })}
                              </span>
                              <span className="font-mono">
                                {node.used > 0 && pct === 0 ? '< 1%' : `${pct}%`}
                              </span>
                            </div>

                            <Progress
                              value={node.used > 0 ? Math.max(pct, 2) : 0}
                              className={cn(
                                'h-1.5',
                                isOver
                                  ? '[&>div]:bg-destructive'
                                  : isWarning
                                    ? '[&>div]:bg-amber-500'
                                    : '[&>div]:bg-primary'
                              )}
                            />
                          </div>
                        </CardContent>
                      </Card>
                    );
                  })
                )}
              </div>

              {/* 底部使用指引与安全水位提示 */}
              <div className="rounded-lg border bg-muted/20 p-3 flex items-start gap-2.5 text-xs text-muted-foreground">
                <Info className="size-4 text-primary shrink-0 mt-0.5" />
                <p className="leading-relaxed">
                  {t('admin:lines.proxyPoolDrawerNotice')}
                </p>
              </div>
            </>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}

// 兼容老引用
export { ProxyPoolDrawer as ProxyPoolCapacity };
