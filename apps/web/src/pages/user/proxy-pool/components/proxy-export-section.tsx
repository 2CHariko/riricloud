import { useTranslation } from 'react-i18next';
import { Copy, Info, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { EmptyState } from '@/components/shared/empty-state';
import { extractErrorMessage } from '@/lib/api';
import { supportsProtocol } from '../proxy-pool-contract';
import { type ProxyKey, useProxyPoolEndpoints, useProxyPoolMutations } from '../use-proxy-pool';
import { useProxyExport } from '../use-proxy-export';
import { ProxyEndpointSelection } from './proxy-endpoint-selection';
import { ProxyExportWorkbench } from './proxy-export-workbench';

interface ProxyExportSectionProps {
  keys: ProxyKey[];
  keyId: string;
  onKeyChange: (keyId: string) => void;
  onOpenCreateKey?: () => void;
}

export function ProxyExportSection({ keys, keyId, onKeyChange, onOpenCreateKey }: ProxyExportSectionProps) {
  const { t } = useTranslation(['user', 'common']);
  const { rotateToken } = useProxyPoolMutations();
  const activeKeys = keys.filter((key) => key.isActive);
  const currentKey = activeKeys.find((key) => key.id === keyId) ?? null;
  const endpointsQuery = useProxyPoolEndpoints(currentKey?.id);
  const endpointsReady = !endpointsQuery.isError && !!currentKey && endpointsQuery.data?.keyId === currentKey.id;
  const endpoints = endpointsReady ? endpointsQuery.data!.endpoints : [];
  const state = useProxyExport(currentKey, endpoints, endpointsReady);

  if (!keys.length) {
    return (
      <Card>
        <CardContent className="py-8">
          <EmptyState
            title={t('user:proxyPool.noExportableKeyTitle')}
            description={t('user:proxyPool.noExportableKeyDesc')}
            action={onOpenCreateKey && <Button onClick={onOpenCreateKey}>{t('user:proxyPool.createFirstKey')}</Button>}
          />
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      {/* 提取参数配置独立卡片（去除千层饼嵌套） */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">{t('user:proxyPool.configTitle')}</CardTitle>
          <CardDescription className="text-xs">{t('user:proxyPool.configDesc')}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center gap-2 rounded-md bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
            <Info className="size-4 shrink-0 text-primary" />
            <span>{t('user:proxyPool.reexportRequired')}</span>
          </div>

          <div className="grid gap-4 sm:grid-cols-3">
            <div className="space-y-1.5">
              <Label className="text-xs font-medium">{t('user:proxyPool.credentialSelectLabel')}</Label>
              <Select value={keyId} onValueChange={onKeyChange}>
                <SelectTrigger aria-label={t('user:proxyPool.credentialSelectLabel')} className="h-9">
                  <SelectValue placeholder={t('user:proxyPool.credentialSelectPlaceholder')} />
                </SelectTrigger>
                <SelectContent>
                  {activeKeys.map((key) => (
                    <SelectItem key={key.id} value={key.id}>
                      {key.name} ({key.username})
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1.5">
              <Label className="text-xs font-medium">{t('user:proxyPool.exportProtocolLabel')}</Label>
              <div className="flex rounded-md border bg-muted/30 p-0.5">
                {(['socks5', 'http'] as const).map((protocol) => {
                  const active = state.protocol === protocol;
                  const disabled = state.selectedEndpoints.length > 0 && !state.selectedEndpoints.every((endpoint) => supportsProtocol(endpoint, protocol));
                  return (
                    <button
                      key={protocol}
                      type="button"
                      disabled={disabled}
                      onClick={() => state.setProtocol(protocol)}
                      className={`flex-1 rounded-sm py-1.5 text-xs font-medium transition-colors ${
                        active
                          ? 'bg-background text-foreground shadow-sm'
                          : 'text-muted-foreground hover:text-foreground'
                      } ${disabled ? 'cursor-not-allowed opacity-50' : 'cursor-pointer'}`}
                    >
                      {protocol === 'http' ? 'HTTP / HTTPS' : 'SOCKS5'}
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="space-y-1.5">
              <Label className="text-xs font-medium">{t('user:proxyPool.exportFormatLabel')}</Label>
              <div className="flex rounded-md border bg-muted/30 p-0.5">
                {(['text', 'uri', 'json'] as const).map((format) => {
                  const active = state.format === format;
                  const disabled = format === 'text' && state.selectedEndpoints.some((endpoint) => endpoint.tls);
                  return (
                    <button
                      key={format}
                      type="button"
                      disabled={disabled}
                      onClick={() => state.setFormat(format)}
                      className={`flex-1 rounded-sm py-1.5 text-xs font-medium transition-colors ${
                        active
                          ? 'bg-background text-foreground shadow-sm'
                          : 'text-muted-foreground hover:text-foreground'
                      } ${disabled ? 'cursor-not-allowed opacity-50' : 'cursor-pointer'}`}
                    >
                      {format === 'text' ? 'TXT' : format.toUpperCase()}
                    </button>
                  );
                })}
              </div>
            </div>
          </div>

          {state.selectedEndpoints.some((endpoint) => endpoint.tls) && (
            <p className="text-xs text-amber-600 dark:text-amber-400">{t('user:proxyPool.tlsTextUnavailable')}</p>
          )}
          {endpointsQuery.isError && (
            <p role="alert" className="text-sm text-destructive">
              {extractErrorMessage(endpointsQuery.error, t('user:proxyPool.loadErrorDesc'))}
            </p>
          )}
        </CardContent>
      </Card>

      {/* 出网节点选择独立区域 */}
      <ProxyEndpointSelection
        endpoints={endpoints}
        pending={endpointsQuery.isPending}
        excludedCount={endpointsQuery.data?.excludedCount ?? 0}
        state={state}
      />

      {/* 导出结果与自动化集成代码工作台 */}
      <ProxyExportWorkbench state={state} />

      {/* 自动化动态拉取 API 紧凑卡片 */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">{t('user:proxyPool.apiTitle')}</CardTitle>
          <CardDescription className="text-xs">{t('user:proxyPool.apiDesc')}</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-2 pt-0">
          <Button
            size="sm"
            variant="outline"
            disabled={!state.automationUrl}
            onClick={() => void state.copy(state.automationUrl)}
            className="gap-1.5"
          >
            <Copy className="size-3.5 text-muted-foreground" />
            {t('user:proxyPool.copyApiUrl')}
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={!currentKey || rotateToken.isPending}
            onClick={() => currentKey && rotateToken.mutate(currentKey.id)}
            className="gap-1.5"
          >
            <RefreshCw className="size-3.5 text-muted-foreground" />
            {t('user:proxyPool.rotateTokenButton')}
          </Button>
        </CardContent>
      </Card>

      <p className="text-xs text-muted-foreground">{t('user:proxyPool.fingerprintTipDesc')}</p>
    </div>
  );
}
