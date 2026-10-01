import { Copy, Download, RefreshCw } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import type { ProxyExportState } from '../use-proxy-export';

export function ProxyExportWorkbench({ state }: { state: ProxyExportState }) {
  const { t } = useTranslation(['user', 'common']);
  return <Card className="overflow-hidden"><CardContent className="p-0">
    <div className="flex flex-wrap items-center justify-between gap-2 border-b bg-muted/30 p-3">
      <div className="flex gap-2">
        <Button size="sm" variant={state.viewMode === 'export' ? 'secondary' : 'ghost'} onClick={() => state.setViewMode('export')}>{t('user:proxyPool.tabTerminalExport')}</Button>
        <Button size="sm" variant={state.viewMode === 'code' ? 'secondary' : 'ghost'} onClick={() => state.setViewMode('code')}>{t('user:proxyPool.tabTerminalCode')}</Button>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="outline" onClick={state.refresh}><RefreshCw className="size-4" />{t('user:proxyPool.reexport')}</Button>
        {state.viewMode === 'export' && <Button size="sm" variant="outline" disabled={!state.canCopy} onClick={state.download}><Download className="size-4" />{t('user:proxyPool.downloadList')}</Button>}
        <Button size="sm" disabled={!state.canCopy} onClick={() => void state.copy(state.content)}><Copy className="size-4" />{t(state.viewMode === 'code' ? 'user:proxyPool.copyCode' : 'user:proxyPool.copyResult')}</Button>
      </div>
    </div>
    {state.viewMode === 'code' && <div className="flex flex-wrap items-center justify-between gap-2 border-b p-3">
      <div className="flex max-w-full gap-1 overflow-x-auto">{state.snippets.map((snippet) => <Button key={snippet.id} size="sm" variant={state.snippetTab === snippet.id ? 'secondary' : 'ghost'} onClick={() => state.setSnippetTab(snippet.id)}>{snippet.label}</Button>)}</div>
      {state.exportedProxies.length > 1 && <Select value={state.nodeView} onValueChange={state.setNodeView}>
        <SelectTrigger className="w-full sm:w-52" aria-label={t('user:proxyPool.egressNode')}><SelectValue /></SelectTrigger>
        <SelectContent>
          <SelectItem value="all">{t('user:proxyPool.allRotationPool', { count: state.exportedProxies.length })}</SelectItem>
          {state.exportedProxies.map((proxy) => <SelectItem key={proxy.lineId} value={proxy.lineId}>{proxy.name}</SelectItem>)}
        </SelectContent>
      </Select>}
    </div>}
    <pre className="max-h-96 min-h-36 overflow-auto whitespace-pre-wrap break-all p-4 font-mono text-xs leading-relaxed select-text">{state.content}</pre>
  </CardContent></Card>;
}
