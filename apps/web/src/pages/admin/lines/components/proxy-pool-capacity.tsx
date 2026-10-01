import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { api, extractErrorMessage } from '@/lib/api';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';

interface ProxyPoolOverview {
  totalKeys: number; activeKeys: number; disabledKeys: number; trafficUsedBytes: number;
  endpointCount: number;
  nodeCapacities: Array<{ nodeId: string; nodeName: string; used: number; limit: number; excluded: number }>;
}
export function ProxyPoolCapacity() {
  const { t } = useTranslation(['admin', 'common']);
  const query = useQuery({
    queryKey: ['admin', 'proxy-pool', 'overview'],
    queryFn: async () => (await api.get<ProxyPoolOverview>('/admin/proxy-pool/overview')).data,
    refetchInterval: 30_000
  });
  return <Card><CardHeader className="pb-3">
    <CardTitle className="text-sm">{t('admin:lineForm.proxyPoolOverview')}</CardTitle>
    <CardDescription>{t('admin:lineForm.proxyPoolCapacityDesc')}</CardDescription>
  </CardHeader><CardContent className="space-y-2">
    {query.isPending ? <p>{t('common:actions.loading')}</p> : query.isError ?
      <p role="alert" className="text-sm text-destructive">{extractErrorMessage(query.error, t('common:status.failed'))}</p> : <>
        <p className="text-sm">{t('admin:lineForm.proxyPoolEndpointCount', { count: query.data.endpointCount })}</p>
        <div className="flex flex-wrap gap-2">{query.data.nodeCapacities.map((node) => <Badge key={node.nodeId} variant={node.excluded > 0 ? 'destructive' : 'secondary'}>
          {t('admin:lineForm.proxyPoolCapacity', { name: node.nodeName, used: node.used, limit: node.limit, excluded: node.excluded })}
        </Badge>)}</div>
      </>}
  </CardContent></Card>;
}
