import { useTranslation } from 'react-i18next';
import { ExternalLink, HardDrive, Laptop, Server, Terminal } from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { SystemLogItem } from '../types';

const SOURCE_ICONS = {
  SERVER: Server,
  WEB: Laptop,
  AGENT: HardDrive,
  SINGBOX: Terminal,
};

interface LogContextCardsProps {
  log: SystemLogItem;
  onFilterByNodeId?: (id: string) => void;
  onFilterByModule?: (module: string) => void;
}

export function LogContextCards({ log, onFilterByNodeId, onFilterByModule }: LogContextCardsProps) {
  const { t } = useTranslation(['admin']);
  const SourceIcon = (log.source in SOURCE_ICONS ? SOURCE_ICONS[log.source as keyof typeof SOURCE_ICONS] : Server);

  return (
    <section className="grid grid-cols-2 gap-2 text-xs" aria-label={t('admin:logs.detail.contextTitle')}>
      {/* 来源 */}
      <div className="rounded-lg border bg-muted/10 p-2.5">
        <div className="text-[10px] font-semibold uppercase text-muted-foreground">
          {t('admin:logs.colSource')}
        </div>
        <div className="mt-1 flex items-center gap-1.5 font-mono font-medium">
          <SourceIcon className="size-3.5 text-muted-foreground shrink-0" />
          <span>{log.source}</span>
        </div>
      </div>

      {/* 所属模块 */}
      <div className="rounded-lg border bg-muted/10 p-2.5">
        <div className="flex items-center justify-between text-[10px] font-semibold uppercase text-muted-foreground">
          <span>{t('admin:logs.moduleTitle')}</span>
          {onFilterByModule && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => onFilterByModule(log.module)}
              className="h-4 px-1 text-[10px] text-primary hover:text-primary gap-0.5"
            >
              <ExternalLink className="size-2.5" />
              {t('admin:logs.filterModule')}
            </Button>
          )}
        </div>
        <div className="mt-1 font-mono font-medium truncate" title={log.module}>
          {log.module}
        </div>
      </div>

      {/* 关联 VPS 节点 */}
      {log.node && (
        <div className="rounded-lg border bg-muted/10 p-2.5">
          <div className="flex items-center justify-between text-[10px] font-semibold uppercase text-muted-foreground">
            <span>{t('admin:logs.relatedNode')}</span>
            {onFilterByNodeId && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => onFilterByNodeId(log.node!.id)}
                className="h-4 px-1 text-[10px] text-primary hover:text-primary gap-0.5"
              >
                <ExternalLink className="size-2.5" />
                {t('admin:logs.filterThisNode')}
              </Button>
            )}
          </div>
          <div className="mt-1 font-mono font-medium truncate" title={`${log.node.name} (${log.node.serverHost})`}>
            {log.node.name} <span className="font-normal text-muted-foreground">({log.node.serverHost})</span>
          </div>
        </div>
      )}

      {/* 关联操作用户 */}
      {log.user && (
        <div className="rounded-lg border bg-muted/10 p-2.5">
          <div className="text-[10px] font-semibold uppercase text-muted-foreground">
            {t('admin:logs.relatedUser')}
          </div>
          <div className="mt-1 font-mono font-medium truncate" title={log.user.email}>
            {log.user.email}
          </div>
        </div>
      )}
    </section>
  );
}
