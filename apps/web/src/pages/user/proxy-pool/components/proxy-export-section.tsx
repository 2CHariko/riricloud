import { Copy, RefreshCw } from 'lucide-react';
import { useTranslation } from 'react-i18next';
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
  if (!keys.length) return <Card><CardContent className="py-8"><EmptyState title={t('user:proxyPool.noExportableKeyTitle')} description={t('user:proxyPool.noExportableKeyDesc')}
    action={onOpenCreateKey && <Button onClick={onOpenCreateKey}>{t('user:proxyPool.createFirstKey')}</Button>} /></CardContent></Card>;
  return <div className="space-y-4">
    <Card><CardHeader>
      <CardTitle>{t('user:proxyPool.configTitle')}</CardTitle>
      <CardDescription>{t('user:proxyPool.configDesc')}</CardDescription>
    </CardHeader><CardContent className="space-y-4">
      <p className="text-sm text-destructive">{t('user:proxyPool.reexportRequired')}</p>
      <div className="grid gap-3 sm:grid-cols-3">
        <div className="space-y-2"><Label>{t('user:proxyPool.credentialSelectLabel')}</Label>
          <Select value={keyId} onValueChange={onKeyChange}><SelectTrigger aria-label={t('user:proxyPool.credentialSelectLabel')}><SelectValue placeholder={t('user:proxyPool.credentialSelectPlaceholder')} /></SelectTrigger>
            <SelectContent>{activeKeys.map((key) => <SelectItem key={key.id} value={key.id}>{key.name} ({key.username})</SelectItem>)}</SelectContent>
          </Select>
        </div>
        <div className="space-y-2"><Label>{t('user:proxyPool.exportProtocolLabel')}</Label><div className="flex gap-2">
          {(['socks5', 'http'] as const).map((protocol) => <Button key={protocol} variant={state.protocol === protocol ? 'secondary' : 'outline'}
            disabled={state.selectedEndpoints.length > 0 && !state.selectedEndpoints.every((endpoint) => supportsProtocol(endpoint, protocol))}
            onClick={() => state.setProtocol(protocol)}>{protocol === 'http' ? 'HTTP / HTTPS' : 'SOCKS5'}</Button>)}
        </div></div>
        <div className="space-y-2"><Label>{t('user:proxyPool.exportFormatLabel')}</Label><div className="flex gap-2">
          {(['text', 'uri', 'json'] as const).map((format) => <Button key={format} disabled={format === 'text' && state.selectedEndpoints.some((endpoint) => endpoint.tls)} variant={state.format === format ? 'secondary' : 'outline'} onClick={() => state.setFormat(format)}>{format === 'text' ? 'TXT' : format.toUpperCase()}</Button>)}
        </div></div>
      </div>
      {state.selectedEndpoints.some((endpoint) => endpoint.tls) && <p className="text-xs text-muted-foreground">{t('user:proxyPool.tlsTextUnavailable')}</p>}
      {endpointsQuery.isError && <p role="alert" className="text-sm text-destructive">{extractErrorMessage(endpointsQuery.error, t('user:proxyPool.loadErrorDesc'))}</p>}
      <ProxyEndpointSelection endpoints={endpoints} pending={endpointsQuery.isPending} excludedCount={endpointsQuery.data?.excludedCount ?? 0} state={state} />
    </CardContent></Card>
    <ProxyExportWorkbench state={state} />
    <Card><CardHeader><CardTitle className="text-sm">{t('user:proxyPool.apiTitle')}</CardTitle><CardDescription>{t('user:proxyPool.apiDesc')}</CardDescription></CardHeader>
      <CardContent className="flex flex-wrap gap-2"><Button variant="outline" disabled={!state.automationUrl} onClick={() => void state.copy(state.automationUrl)}><Copy className="size-4" />{t('user:proxyPool.copyApiUrl')}</Button>
        <Button variant="outline" disabled={!currentKey || rotateToken.isPending} onClick={() => currentKey && rotateToken.mutate(currentKey.id)}><RefreshCw className="size-4" />{t('user:proxyPool.rotateTokenButton')}</Button>
      </CardContent>
    </Card>
    <p className="text-xs text-muted-foreground">{t('user:proxyPool.fingerprintTipDesc')}</p>
  </div>;
}
