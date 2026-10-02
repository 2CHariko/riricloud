import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { extractErrorMessage } from '@/lib/api';
import { usePublicSettings } from '@/lib/public-settings';
import { buildMultiProxyCodeSnippets, buildProxyCodeSnippets } from './proxy-snippets';
import { buildAutomationUrl, proxyPoolErrorCode, reconcileSelection, supportsProtocol, PROXY_POOL_SELECTION_LIMIT } from './proxy-pool-contract';
import { type ProxyKey, type ProxyPoolEndpoint, type ProxyPoolExportFormat, type ProxyPoolExportProtocol, useProxyPoolExport, useProxyPoolExportCredentials } from './use-proxy-pool';

export function useProxyExport(currentKey: ProxyKey | null, endpoints: ProxyPoolEndpoint[], endpointsReady: boolean) {
  const { t } = useTranslation(['user', 'common']);
  const publicSettings = usePublicSettings();
  const keyId = currentKey?.id ?? '';
  const [selections, setSelections] = useState<Record<string, string[]>>({});
  const [protocol, setProtocol] = useState<ProxyPoolExportProtocol>('socks5');
  const [format, setFormat] = useState<ProxyPoolExportFormat>('text');
  const [viewMode, setViewMode] = useState<'export' | 'code'>('export');
  const [snippetTab, setSnippetTab] = useState('python-requests');
  const [nodeView, setNodeView] = useState('all');
  const selectedLineIds = endpointsReady ? reconcileSelection(selections[keyId] ?? [], endpoints) : [];
  // 身份包含 Key 和容量资格；轮询改变状态时只清理无效选择，不重新全选。
  const endpointKey = `${keyId}:${endpoints.map((endpoint) => `${endpoint.lineId}:${endpoint.status}`).join(',')}`;
  useEffect(() => {
    if (!endpointsReady) return;
    setSelections((previous) => {
      const ids = previous[keyId] ?? [];
      const cleaned = reconcileSelection(ids, endpoints);
      return cleaned.length === ids.length ? previous : { ...previous, [keyId]: cleaned };
    });
  }, [endpointKey, endpointsReady, keyId, endpoints]);
  const selectedEndpoints = endpoints.filter((endpoint) => selectedLineIds.includes(endpoint.lineId));
  const incompatible = selectedEndpoints.some((endpoint) => !supportsProtocol(endpoint, protocol))
    || (viewMode === 'export' && format === 'text' && selectedEndpoints.some((endpoint) => endpoint.tls));
  const ready = !!currentKey && endpointsReady && selectedLineIds.length > 0 && !incompatible;
  const exportQuery = useProxyPoolExport({ keyId, format, protocol, lineIds: selectedLineIds, enabled: ready && viewMode === 'export' });
  const credentialsQuery = useProxyPoolExportCredentials({ keyId, protocol, lineIds: selectedLineIds, enabled: ready && viewMode === 'code' });
  const exportedProxies = useMemo(
    () => (ready && !credentialsQuery.isError ? credentialsQuery.data?.proxies ?? [] : []),
    [ready, credentialsQuery.isError, credentialsQuery.data]
  );
  const effectiveNodeView = exportedProxies.some((proxy) => proxy.lineId === nodeView) ? nodeView : 'all';
  const snippets = useMemo(() => {
    if (!exportedProxies.length || exportedProxies.some((proxy) => !supportsProtocol(proxy, protocol))) return [];
    const target = exportedProxies.find((proxy) => proxy.lineId === effectiveNodeView);
    if (target) return buildProxyCodeSnippets({ ...target, protocol });
    if (exportedProxies.length === 1) return buildProxyCodeSnippets({ ...exportedProxies[0], protocol });
    return buildMultiProxyCodeSnippets({ protocol, endpoints: exportedProxies });
  }, [exportedProxies, effectiveNodeView, protocol]);
  const currentSnippet = snippets.find((snippet) => snippet.id === snippetTab) ?? snippets[0];
  const activeQuery = viewMode === 'code' ? credentialsQuery : exportQuery;
  const errorCode = proxyPoolErrorCode(activeQuery.error);
  const error = errorCode === 'PROXY_POOL_SELECTION_UNAVAILABLE' ? t('user:proxyPool.selectionUnavailable')
    : errorCode === 'PROXY_POOL_ACCESS_DENIED' ? t('user:proxyPool.accessDenied')
    : errorCode === 'PROXY_POOL_KEY_DISABLED' ? t('user:proxyPool.createAndEnableKeyPrompt')
    : activeQuery.error instanceof Error && activeQuery.error.message === 'PROXY_POOL_REEXPORT_REQUIRED' ? t('user:proxyPool.reexportRequired')
    : extractErrorMessage(activeQuery.error, t('user:proxyPool.exportFailed'));
  const hasData = viewMode === 'code' ? !!currentSnippet : !!exportQuery.data;
  const isInitialLoading = (activeQuery.isPending || activeQuery.isFetching) && !hasData;
  const content = !keyId ? t('user:proxyPool.createAndEnableKeyPrompt')
    : !selectedLineIds.length ? t('user:proxyPool.atLeastOneEndpointPrompt')
    : incompatible ? t(format === 'text' && protocol === 'http' ? 'user:proxyPool.tlsTextUnavailable' : 'user:proxyPool.protocolUnavailable')
    : isInitialLoading ? t('user:proxyPool.generatingProxies')
    : activeQuery.isError ? error
    : viewMode === 'code' ? currentSnippet?.code ?? t('user:proxyPool.reexportRequired') : exportQuery.data ?? '';
  const canCopy = ready && !activeQuery.isError && hasData;
  const automationBase = publicSettings.data?.publicBaseUrl || publicSettings.data?.subscriptionBaseUrl || window.location.origin;
  const automationUrl = ready && !(format === 'text' && selectedEndpoints.some((endpoint) => endpoint.tls))
    ? buildAutomationUrl(automationBase, currentKey!.exportToken, protocol, format, selectedLineIds) : '';
  const setSelection = (ids: string[]) => {
    if (new Set(ids).size > PROXY_POOL_SELECTION_LIMIT) toast.info(t('user:proxyPool.selectionLimit', { count: PROXY_POOL_SELECTION_LIMIT }));
    setSelections((previous) => ({ ...previous, [keyId]: reconcileSelection(ids, endpoints) }));
  };
  const toggleLine = (id: string, checked: boolean) => setSelection(checked ? [...new Set([...selectedLineIds, id])] : selectedLineIds.filter((value) => value !== id));
  const copy = async (value: string) => {
    try { await navigator.clipboard.writeText(value); toast.success(t('user:proxyPool.copied')); }
    catch { toast.error(t('user:proxyPool.copyFailedToast')); }
  };
  const download = () => {
    if (!canCopy || viewMode !== 'export' || !exportQuery.data) return;
    const url = URL.createObjectURL(new Blob([exportQuery.data], { type: 'text/plain;charset=utf-8' }));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `riricloud-proxies-${protocol}-${format}.${format === 'json' ? 'json' : 'txt'}`;
    anchor.click();
    URL.revokeObjectURL(url);
  };
  const refresh = () => { if (ready) void activeQuery.refetch(); };
  return { selectedLineIds, selectedEndpoints, protocol, setProtocol, format, setFormat, viewMode, setViewMode,
    snippetTab, setSnippetTab, nodeView: effectiveNodeView, setNodeView, snippets, exportedProxies,
    content, canCopy, automationUrl, toggleLine, setSelection, copy, download, refresh, isFetching: activeQuery.isFetching };
}
export type ProxyExportState = ReturnType<typeof useProxyExport>;
