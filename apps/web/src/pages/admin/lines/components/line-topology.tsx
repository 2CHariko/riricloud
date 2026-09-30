import { useTranslation } from 'react-i18next';
import type { AdminLine } from '../use-lines';

export function LineTopology({ line }: { line: AdminLine }) {
  const { t } = useTranslation(['admin', 'common']);
  if (line.type === 'EXTERNAL') return <div><p>{t('admin:upstream.externalType')}</p><p className="text-xs text-muted-foreground">{line.upstreamSummary?.name} · {line.protocolType}</p></div>;
  const target = line.relayMode === 'TARGET_LINE' ? line.targetLine?.entryNode.name : line.relayMode === 'UPSTREAM_NODE' ? line.upstreamSummary?.name : line.landingNode?.name;
  return <div>
    <p>{line.entryNode?.name}{line.type === 'RELAY' && <> ➔ {target ?? t('admin:lines.unbound')}</>}</p>
    <p className="text-xs text-muted-foreground">{line.protocolType} · {t('admin:lines.portListen', { port: line.entryPort ?? '—' })}</p>
  </div>;
}
