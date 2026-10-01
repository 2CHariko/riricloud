import * as React from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { Layers, Server, AlertTriangle, CheckCircle2 } from 'lucide-react';
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

        <div className="mt-6 space-y-4">
          {query.isPending ? (
            <p className="text-sm text-muted-foreground">{t('common:actions.loading')}</p>
          ) : query.isError ? (
            <p role="alert" className="text-sm text-destructive">
              {extractErrorMessage(query.error, t('common:status.failed'))}
            </p>
          ) : (
            <>
              <div className="grid grid-cols-2 gap-3">
                <Card>
                  <CardContent className="p-3">
                    <p className="text-xs text-muted-foreground">{t('admin:lineForm.proxyPoolOverview')}</p>
                    <p className="mt-1 text-xl font-bold font-mono">
                      {query.data?.endpointCount ?? 0}
                    </p>
                    <p className="text-[11px] text-muted-foreground">
                      {t('admin:lineForm.proxyPoolEndpointCount', { count: query.data?.endpointCount ?? 0 })}
                    </p>
                  </CardContent>
                </Card>
                <Card>
                  <CardContent className="p-3">
                    <p className="text-xs text-muted-foreground">{t('admin:lines.proxyPoolDetailTitle')}</p>
                    <p className="mt-1 text-xl font-bold font-mono">
                      {capacities.length}
                    </p>
                    <p className="text-[11px] text-muted-foreground">
                      {t('admin:nodes.title')}
                    </p>
                  </CardContent>
                </Card>
              </div>

              <div className="space-y-3">
                <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                  {t('admin:lines.proxyPoolDetailTitle')}
                </h4>
                {capacities.length === 0 ? (
                  <p className="text-xs text-muted-foreground">{t('admin:lines.proxyPoolEmptyNodes')}</p>
                ) : (
                  capacities.map((node) => {
                    const limit = Math.max(1, node.limit);
                    const pct = Math.min(100, Math.round((node.used / limit) * 100));
                    const isOver = node.excluded > 0;
                    const isWarning = !isOver && pct >= 80;

                    return (
                      <Card key={node.nodeId} className="border shadow-none">
                        <CardContent className="p-3.5 space-y-2">
                          <div className="flex items-center justify-between">
                            <div className="flex items-center gap-2">
                              <Server className="size-4 text-muted-foreground" />
                              <span className="text-sm font-medium">{node.nodeName}</span>
                            </div>
                            {isOver ? (
                              <Badge variant="destructive" className="gap-1 text-[11px] py-0">
                                <AlertTriangle className="size-3" />
                                {t('admin:lines.proxyPoolStatusExcluded')}
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

                          <Progress
                            value={pct}
                            className={cn(
                              'h-1.5',
                              isOver
                                ? '[&>div]:bg-destructive'
                                : isWarning
                                  ? '[&>div]:bg-amber-500'
                                  : '[&>div]:bg-primary'
                            )}
                          />

                          <div className="flex items-center justify-between text-xs text-muted-foreground">
                            <span>
                              {node.used} / {node.limit} ({pct}%)
                            </span>
                            {node.excluded > 0 && (
                              <span className="text-destructive font-medium">
                                -{node.excluded}
                              </span>
                            )}
                          </div>
                        </CardContent>
                      </Card>
                    );
                  })
                )}
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
