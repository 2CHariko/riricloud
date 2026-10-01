import { useState } from 'react';
import { Globe, Info, KeyRound, Network, Wand2, Zap } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { PageContainer, PageHeader } from '@/components/shared/page-container';
import { StatCard } from '@/components/shared/stat-card';
import { EmptyState } from '@/components/shared/empty-state';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ProxyKeyDialog } from './components/proxy-key-dialog';
import { ProxyKeySection } from './components/proxy-key-section';
import { ProxyExportSection } from './components/proxy-export-section';
import { type ProxyKey, useProxyPoolEndpoints, useProxyPoolKeys } from './use-proxy-pool';

export default function UserProxyPoolPage() {
  const { t } = useTranslation(['user', 'common']);
  const keysQuery = useProxyPoolKeys();
  const [selectedKeyId, setSelectedKeyId] = useState('');
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<ProxyKey | null>(null);

  const keys = keysQuery.data?.keys ?? [];
  const limit = keysQuery.data?.limit ?? 20;
  const activeKeys = keys.filter((key) => key.isActive);
  const keyId = activeKeys.some((key) => key.id === selectedKeyId) ? selectedKeyId : activeKeys[0]?.id ?? '';
  const endpointsQuery = useProxyPoolEndpoints(keyId || undefined);
  const endpoints = !endpointsQuery.isError ? endpointsQuery.data?.endpoints ?? [] : [];
  const onlineEndpointsCount = endpoints.filter((endpoint) => endpoint.status === 'AVAILABLE' && endpoint.online).length;

  const openCreate = () => {
    setEditing(null);
    setDialogOpen(true);
  };

  const openEdit = (item: ProxyKey) => {
    setEditing(item);
    setDialogOpen(true);
  };

  if (keysQuery.isError) {
    return (
      <PageContainer>
        <PageHeader
          title={t('user:proxyPool.title')}
          description={t('user:proxyPool.description')}
        />
        <EmptyState
          title={t('user:proxyPool.loadErrorTitle')}
          description={t('user:proxyPool.loadErrorDesc')}
        />
      </PageContainer>
    );
  }

  return (
    <PageContainer>
      <PageHeader
        title={t('user:proxyPool.title')}
        description={t('user:proxyPool.description')}
      />

      {/* 顶部轻量说明横幅 */}
      <div className="flex items-center gap-2.5 rounded-lg border bg-muted/20 px-3.5 py-2.5 text-xs text-muted-foreground transition-colors hover:bg-muted/30">
        <Info className="size-4 shrink-0 text-sky-500" />
        <div className="flex min-w-0 flex-1 flex-wrap items-center justify-between gap-x-4 gap-y-1">
          <span className="truncate">
            {t('user:proxyPool.bannerText')}
          </span>
          <span className="shrink-0 text-muted-foreground/80">{t('user:proxyPool.bannerSubtext')}</span>
        </div>
      </div>

      {/* 顶部微型指标仪表盘 */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard
          title={t('user:proxyPool.activeKeysStat')}
          value={`${activeKeys.length} / ${limit}`}
          hint={keys.length >= limit ? t('user:proxyPool.limitReached') : t('user:proxyPool.createdKeysCount', { count: keys.length })}
          icon={<KeyRound className="text-emerald-500" />}
        />
        <StatCard
          title={t('user:proxyPool.availableEndpointsStat')}
          value={t('user:proxyPool.nodesCount', { count: endpoints.filter((endpoint) => endpoint.status === 'AVAILABLE').length })}
          hint={t('user:proxyPool.onlineCount', { count: onlineEndpointsCount })}
          icon={<Globe className="text-sky-500" />}
        />
        <StatCard
          title={t('user:proxyPool.protocolSupportStat')}
          value={t('user:proxyPool.singlePortMixed')}
          hint={t('user:proxyPool.mixedProtocolsDesc')}
          icon={<Network className="text-violet-500" />}
        />
        <StatCard
          title={t('user:proxyPool.billingLinkStat')}
          value={t('user:proxyPool.sharedAccount')}
          hint={t('user:proxyPool.autoBlockDesc')}
          icon={<Zap className="text-amber-500" />}
        />
      </div>

      {/* 响应式 Tabs 分页结构：提取工作台 vs 凭据管理 */}
      <Tabs defaultValue="export" className="space-y-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <TabsList className="grid h-9 w-full grid-cols-2 bg-muted/60 p-1 sm:w-auto">
            <TabsTrigger value="export" className="gap-1.5 text-xs sm:text-sm">
              <Wand2 className="size-3.5" />
              {t('user:proxyPool.tabExport')}
            </TabsTrigger>
            <TabsTrigger value="keys" className="gap-1.5 text-xs sm:text-sm">
              <KeyRound className="size-3.5" />
              {t('user:proxyPool.tabKeys')}
              {keys.length ? (
                <span className="ml-1 rounded-full bg-muted-foreground/15 px-1.5 py-0.5 text-[10px] font-medium leading-none">
                  {keys.length}
                </span>
              ) : null}
            </TabsTrigger>
          </TabsList>
        </div>

        <TabsContent value="export" className="m-0 focus-visible:outline-none">
          <ProxyExportSection
            keys={keys}
            keyId={keyId}
            onKeyChange={setSelectedKeyId}
            onOpenCreateKey={openCreate}
          />
        </TabsContent>

        <TabsContent value="keys" className="m-0 focus-visible:outline-none">
          <ProxyKeySection
            keys={keys}
            limit={limit}
            isPending={keysQuery.isPending}
            onCreate={openCreate}
            onEdit={openEdit}
          />
        </TabsContent>
      </Tabs>

      <ProxyKeyDialog open={dialogOpen} onOpenChange={setDialogOpen} editing={editing} />
    </PageContainer>
  );
}
