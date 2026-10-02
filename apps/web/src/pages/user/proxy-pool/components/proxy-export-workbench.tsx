import { useState, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, Code2, Copy, Download, RefreshCw, Terminal } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { cn } from '@/lib/utils';
import type { ProxyExportState } from '../use-proxy-export';

interface CodeToken {
  text: string;
  type: 'comment' | 'string' | 'keyword' | 'number' | 'boolean' | 'plain';
}

function tokenizeLine(line: string, _language: string): CodeToken[] {
  const trimmed = line.trimStart();
  if (trimmed.startsWith('#') || trimmed.startsWith('//')) {
    return [{ text: line, type: 'comment' }];
  }

  const regex = /(".*?"|'.*?'|#.*$|\/\/.*$|\b(?:import|from|with|as|print|const|require|let|var|new|function|async|await|return|then|catch|curl|export|def|class|if|else|for|in)\b|\b(?:true|false|null|None|True|False)\b|\b\d+\b|[^\s"'#/]+|\s+|.)/g;

  const tokens: CodeToken[] = [];
  let match: RegExpExecArray | null;

  while ((match = regex.exec(line)) !== null) {
    const text = match[0];
    if (!text) continue;

    if (text.startsWith('#') || text.startsWith('//')) {
      tokens.push({ text, type: 'comment' });
    } else if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"))) {
      tokens.push({ text, type: 'string' });
    } else if (
      /^(?:import|from|with|as|print|const|require|let|var|new|function|async|await|return|then|catch|curl|export|def|class|if|else|for|in)$/.test(
        text
      )
    ) {
      tokens.push({ text, type: 'keyword' });
    } else if (/^(?:true|false|null|None|True|False)$/.test(text)) {
      tokens.push({ text, type: 'boolean' });
    } else if (/^\d+$/.test(text)) {
      tokens.push({ text, type: 'number' });
    } else {
      tokens.push({ text, type: 'plain' });
    }
  }

  return tokens.length ? tokens : [{ text: line, type: 'plain' }];
}

export function ProxyExportWorkbench({ state }: { state: ProxyExportState }) {
  const { t } = useTranslation(['user', 'common']);
  const [copied, setCopied] = useState(false);
  const hasSelection = state.selectedEndpoints.length > 0;

  // 根据当前视图与语言选择推导模拟终端文件名与分词高亮模式
  const snippetMeta = useMemo(() => {
    if (state.viewMode === 'export') {
      if (state.format === 'json') return { language: 'json' as const, filename: 'proxies.json' };
      if (state.format === 'uri') return { language: 'text' as const, filename: 'proxies.uri' };
      return { language: 'text' as const, filename: 'proxies.txt' };
    }
    switch (state.snippetTab) {
      case 'python-requests':
        return { language: 'python' as const, filename: 'main.py' };
      case 'playwright':
        return { language: 'python' as const, filename: 'playwright_crawler.py' };
      case 'node-axios':
        return { language: 'javascript' as const, filename: 'proxy_client.js' };
      case 'curl':
        return { language: 'shell' as const, filename: 'curl_request.sh' };
      default:
        return { language: 'text' as const, filename: 'script.txt' };
    }
  }, [state.viewMode, state.format, state.snippetTab]);

  const handleCopy = () => {
    if (state.canCopy) {
      void state.copy(state.content);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  const lines = useMemo(() => state.content.split('\n'), [state.content]);
  const isShell = snippetMeta.language === 'shell';

  return (
    <div className="overflow-hidden rounded-lg border border-zinc-800 bg-zinc-950 text-zinc-100 shadow-xl transition-all">
      {/* 终端一体化顶栏（macOS 拟物微点 + 分段视图切换 + 动态文件名 + 统一右上操作群） */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-zinc-800/80 bg-zinc-900/80 px-3.5 py-2.5 select-none">
        <div className="flex items-center gap-3 flex-wrap">
          {/* 拟物化三色控制微点 */}
          <div className="flex items-center gap-1.5 shrink-0">
            <span className="size-2.5 rounded-full bg-red-500/80 ring-1 ring-red-500/20" />
            <span className="size-2.5 rounded-full bg-amber-500/80 ring-1 ring-amber-500/20" />
            <span className="size-2.5 rounded-full bg-emerald-500/80 ring-1 ring-emerald-500/20" />
          </div>

          {/* 模式分段选择器（暗黑终端风） */}
          <div className="flex rounded-md border border-zinc-800 bg-zinc-950/70 p-0.5">
            <button
              type="button"
              onClick={() => state.setViewMode('export')}
              className={cn(
                'flex items-center gap-1.5 rounded-sm px-2.5 py-1 text-xs font-medium transition-all',
                state.viewMode === 'export'
                  ? 'bg-zinc-800 text-zinc-100 shadow-sm'
                  : 'text-zinc-400 hover:text-zinc-200'
              )}
            >
              <Terminal className="size-3.5" />
              <span>{t('user:proxyPool.tabTerminalExport')}</span>
            </button>
            <button
              type="button"
              onClick={() => state.setViewMode('code')}
              className={cn(
                'flex items-center gap-1.5 rounded-sm px-2.5 py-1 text-xs font-medium transition-all',
                state.viewMode === 'code'
                  ? 'bg-zinc-800 text-zinc-100 shadow-sm'
                  : 'text-zinc-400 hover:text-zinc-200'
              )}
            >
              <Code2 className="size-3.5" />
              <span>{t('user:proxyPool.tabTerminalCode')}</span>
            </button>
          </div>

          <span className="hidden sm:inline-block font-mono text-xs font-medium text-zinc-400 tracking-wide">
            {snippetMeta.filename}
          </span>
        </div>

        {/* 右侧：唯一的统一操作区（彻底消除重复复制按钮） */}
        <div className="flex items-center gap-1.5">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 gap-1.5 px-2.5 text-xs text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200"
            onClick={state.refresh}
            disabled={!hasSelection}
          >
            <RefreshCw className={cn('size-3.5', state.isFetching && 'animate-spin text-zinc-300')} />
            <span className="hidden sm:inline">{t('user:proxyPool.reexport')}</span>
          </Button>

          {state.viewMode === 'export' && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-7 gap-1.5 px-2.5 text-xs text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200"
              disabled={!state.canCopy}
              onClick={state.download}
            >
              <Download className="size-3.5" />
              <span className="hidden sm:inline">{t('user:proxyPool.downloadList')}</span>
            </Button>
          )}

          <Button
            type="button"
            size="sm"
            className={cn(
              'h-7 gap-1.5 px-3 text-xs transition-all',
              copied
                ? 'bg-emerald-600 hover:bg-emerald-600 text-white'
                : 'bg-zinc-100 text-zinc-900 hover:bg-zinc-200 font-medium'
            )}
            disabled={!state.canCopy}
            onClick={handleCopy}
          >
            {copied ? (
              <>
                <Check className="size-3.5 text-white" />
                <span>{t('user:proxyPool.copied')}</span>
              </>
            ) : (
              <>
                <Copy className="size-3.5" />
                <span>
                  {t(state.viewMode === 'code' ? 'user:proxyPool.copyCode' : 'user:proxyPool.copyResult')}
                </span>
              </>
            )}
          </Button>
        </div>
      </div>

      {/* 次级工具栏（仅在快捷代码模式且有选中时呈现语言标签和节点选择） */}
      {state.viewMode === 'code' && hasSelection && (
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-zinc-800/60 bg-zinc-900/40 px-3.5 py-2">
          <div className="flex max-w-full flex-wrap gap-1">
            {state.snippets.map((snippet) => {
              const active = state.snippetTab === snippet.id;
              return (
                <button
                  key={snippet.id}
                  type="button"
                  onClick={() => state.setSnippetTab(snippet.id)}
                  className={cn(
                    'rounded-md px-2.5 py-1 text-xs font-mono transition-all',
                    active
                      ? 'bg-zinc-800 text-zinc-100 font-medium shadow-sm'
                      : 'text-zinc-400 hover:bg-zinc-800/50 hover:text-zinc-200'
                  )}
                >
                  {snippet.label}
                </button>
              );
            })}
          </div>

          {state.exportedProxies.length > 1 && (
            <Select value={state.nodeView} onValueChange={state.setNodeView}>
              <SelectTrigger className="h-7 w-full sm:w-48 text-xs border-zinc-800 bg-zinc-900 text-zinc-200">
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="border-zinc-800 bg-zinc-900 text-zinc-200">
                <SelectItem value="all" className="text-xs focus:bg-zinc-800 focus:text-zinc-100">
                  {t('user:proxyPool.allRotationPool', { count: state.exportedProxies.length })}
                </SelectItem>
                {state.exportedProxies.map((proxy) => (
                  <SelectItem
                    key={proxy.lineId}
                    value={proxy.lineId}
                    className="text-xs focus:bg-zinc-800 focus:text-zinc-100"
                  >
                    {proxy.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </div>
      )}

      {/* 终端内容区 */}
      {!hasSelection ? (
        <div className="py-16 px-4 text-center">
          <div className="mx-auto flex max-w-sm flex-col items-center justify-center text-center">
            <div className="flex size-10 items-center justify-center rounded-full bg-zinc-900 border border-zinc-800 text-zinc-400 mb-3">
              <Terminal className="size-5" />
            </div>
            <h4 className="text-sm font-semibold text-zinc-200 mb-1">
              {t('user:proxyPool.emptyEndpointPreviewTitle')}
            </h4>
            <p className="text-xs text-zinc-500 leading-relaxed">
              {t('user:proxyPool.emptyEndpointPreviewDesc')}
            </p>
          </div>
        </div>
      ) : (
        <div className="overflow-auto p-4 font-mono text-xs leading-relaxed select-text max-h-[460px] min-h-[160px]">
          <div className="table min-w-full">
            {lines.map((lineText, index) => {
              const tokens = tokenizeLine(lineText, snippetMeta.language);
              return (
                <div key={index} className="table-row group hover:bg-zinc-900/40">
                  {/* 行号 / 提示符（select-none 防误选复制） */}
                  <div className="table-cell pr-4 text-right select-none text-zinc-600 font-mono text-[11px] w-8 tabular-nums">
                    {isShell ? (
                      <span className="text-emerald-500/70 font-semibold">$</span>
                    ) : (
                      <span>{index + 1}</span>
                    )}
                  </div>

                  {/* 代码内容 Tokens */}
                  <div className="table-cell select-text whitespace-pre-wrap break-all pl-2">
                    {tokens.map((token, tIndex) => (
                      <span
                        key={tIndex}
                        className={cn(
                          token.type === 'comment' && 'text-zinc-500 italic',
                          token.type === 'string' && 'text-emerald-400 font-mono',
                          token.type === 'keyword' && 'text-sky-400 font-semibold',
                          token.type === 'number' && 'text-amber-400',
                          token.type === 'boolean' && 'text-amber-400 font-semibold',
                          token.type === 'plain' && 'text-zinc-200'
                        )}
                      >
                        {token.text}
                      </span>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
