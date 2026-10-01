import { useTranslation } from 'react-i18next';
import { ArrowRight, Link2, Cloud } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import type { AdminLine } from '../use-lines';
import { LineEgressBadge } from './line-egress-badge';

export function LineTopology({ line }: { line: AdminLine }) {
  const { t } = useTranslation(['admin', 'common']);

  if (line.type === 'EXTERNAL') {
    return (
      <div className="flex flex-col gap-1">
        <div className="flex items-center gap-1.5 flex-wrap">
          <Badge variant="outline" className="text-[11px] font-normal px-1.5 py-0">
            {t('admin:upstream.externalType')}
          </Badge>
          <div className="flex items-center gap-1 font-medium text-xs">
            <Cloud className="size-3 text-muted-foreground" />
            <span>{line.upstreamSummary?.name ?? t('common:status.unknown')}</span>
          </div>
        </div>
        <div className="text-[11px] text-muted-foreground font-mono">
          {line.protocolType}
        </div>
      </div>
    );
  }

  const isRelay = line.type === 'RELAY';
  const targetNodeName =
    line.relayMode === 'TARGET_LINE'
      ? line.targetLine?.name ?? line.targetLine?.entryNode.name
      : line.relayMode === 'UPSTREAM_NODE'
        ? line.upstreamSummary?.name
        : line.landingNode?.name;

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-1.5 flex-wrap">
        <Badge
          variant={isRelay ? 'secondary' : 'outline'}
          className="text-[11px] font-normal px-1.5 py-0"
        >
          {isRelay ? t('admin:lines.typeRelay') : t('admin:lines.typeDirect')}
        </Badge>

        <div className="flex items-center gap-1 text-xs font-medium">
          <span>{line.entryNode?.name ?? t('common:status.unknown')}</span>
          {isRelay && (
            <>
              <ArrowRight className="size-3 text-muted-foreground shrink-0" />
              {line.relayMode === 'TARGET_LINE' ? (
                <span className="flex items-center gap-1 text-primary">
                  <Link2 className="size-3 shrink-0" />
                  <span>{targetNodeName ?? t('admin:lines.unbound')}</span>
                </span>
              ) : line.relayMode === 'UPSTREAM_NODE' ? (
                <span className="flex items-center gap-1 text-sky-600 dark:text-sky-400">
                  <Cloud className="size-3 shrink-0" />
                  <span>{targetNodeName ?? t('admin:lines.unbound')}</span>
                </span>
              ) : (
                <span>{targetNodeName ?? t('admin:lines.unbound')}</span>
              )}
            </>
          )}
        </div>
      </div>

      <div className="flex items-center gap-2 flex-wrap text-[11px] text-muted-foreground">
        <span className="font-mono">{line.protocolType}</span>
        {line.entryPort && (
          <>
            <span>·</span>
            <span>{t('admin:lines.portListen', { port: line.entryPort })}</span>
          </>
        )}
        <LineEgressBadge line={line} />
      </div>
    </div>
  );
}
