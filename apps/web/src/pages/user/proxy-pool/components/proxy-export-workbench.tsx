import { useTranslation } from 'react-i18next';
import { Copy, Download, RefreshCw, Terminal, Code2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { EmptyState } from '@/components/shared/empty-state';
import type { ProxyExportState } from '../use-proxy-export';

export function ProxyExportWorkbench({ state }: { state: ProxyExportState }) {
  const { t } = useTranslation(['user', 'common']);
  const hasSelection = state.selectedEndpoints.length > 0;

  return (
    <Card className="overflow-hidden border">
      <CardContent className="p-0">
        {/* 顶部工具操作条 */}
        <div className="flex flex-wrap items-center justify-between gap-2.5 border-b bg-muted/20 p-3">
          {/* 左侧视图切换 Segmented Control */}
          <div className="flex rounded-md border bg-muted/40 p-0.5">
            <button
              type="button"
              onClick={() => state.setViewMode('export')}
              className={`flex items-center gap-1.5 rounded-sm px-3 py-1.5 text-xs font-medium transition-all ${
                state.viewMode === 'export'
                  ? 'bg-background text-foreground shadow-sm'
                  : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              <Terminal className="size-3.5" />
              <span>{t('user:proxyPool.tabTerminalExport')}</span>
            </button>
            <button
              type="button"
              onClick={() => state.setViewMode('code')}
              className={`flex items-center gap-1.5 rounded-sm px-3 py-1.5 text-xs font-medium transition-all ${
                state.viewMode === 'code'
                  ? 'bg-background text-foreground shadow-sm'
                  : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              <Code2 className="size-3.5" />
              <span>{t('user:proxyPool.tabTerminalCode')}</span>
            </button>
          </div>

          {/* 右侧操作按钮 */}
          <div className="flex flex-wrap items-center gap-1.5">
            <Button
              size="sm"
              variant="outline"
              className="h-8 gap-1.5 text-xs"
              onClick={state.refresh}
              disabled={!hasSelection}
            >
              <RefreshCw className="size-3.5 text-muted-foreground" />
              <span>{t('user:proxyPool.reexport')}</span>
            </Button>
            {state.viewMode === 'export' && (
              <Button
                size="sm"
                variant="outline"
                className="h-8 gap-1.5 text-xs"
                disabled={!state.canCopy}
                onClick={state.download}
              >
                <Download className="size-3.5 text-muted-foreground" />
                <span>{t('user:proxyPool.downloadList')}</span>
              </Button>
            )}
            <Button
              size="sm"
              className="h-8 gap-1.5 text-xs"
              disabled={!state.canCopy}
              onClick={() => void state.copy(state.content)}
            >
              <Copy className="size-3.5" />
              <span>{t(state.viewMode === 'code' ? 'user:proxyPool.copyCode' : 'user:proxyPool.copyResult')}</span>
            </Button>
          </div>
        </div>

        {/* 代码集成模式下的多语言切页与出网节点选择 */}
        {state.viewMode === 'code' && hasSelection && (
          <div className="flex flex-wrap items-center justify-between gap-2 border-b bg-muted/10 px-3 py-2">
            <div className="flex max-w-full flex-wrap gap-1">
              {state.snippets.map((snippet) => (
                <Button
                  key={snippet.id}
                  size="sm"
                  variant={state.snippetTab === snippet.id ? 'secondary' : 'ghost'}
                  className="h-7 text-xs"
                  onClick={() => state.setSnippetTab(snippet.id)}
                >
                  {snippet.label}
                </Button>
              ))}
            </div>

            {state.exportedProxies.length > 1 && (
              <Select value={state.nodeView} onValueChange={state.setNodeView}>
                <SelectTrigger className="h-7 w-full sm:w-48 text-xs" aria-label={t('user:proxyPool.egressNode')}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all" className="text-xs">
                    {t('user:proxyPool.allRotationPool', { count: state.exportedProxies.length })}
                  </SelectItem>
                  {state.exportedProxies.map((proxy) => (
                    <SelectItem key={proxy.lineId} value={proxy.lineId} className="text-xs">
                      {proxy.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </div>
        )}

        {/* 结果代码预览区 / 空状态 */}
        {!hasSelection ? (
          <div className="py-12">
            <EmptyState
              title={t('user:proxyPool.emptyEndpointPreviewTitle')}
              description={t('user:proxyPool.emptyEndpointPreviewDesc')}
              className="border-0 shadow-none"
            />
          </div>
        ) : (
          <pre className="max-h-96 min-h-36 overflow-auto whitespace-pre-wrap break-all p-4 font-mono text-xs leading-relaxed select-text bg-muted/10 text-foreground/90">
            {state.content}
          </pre>
        )}
      </CardContent>
    </Card>
  );
}
