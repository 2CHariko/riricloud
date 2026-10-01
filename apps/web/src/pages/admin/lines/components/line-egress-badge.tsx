import { useTranslation } from 'react-i18next';
import { Badge } from '@/components/ui/badge';
import type { ApiLine } from '@/lib/api';

export function LineEgressBadge({ line }: { line: ApiLine }) {
  const { t } = useTranslation('admin');
  const inherited = line.effectiveEgress?.inherited ?? (line.type === 'RELAY' && line.relayMode === 'TARGET_LINE');
  const proxy = line.effectiveEgress ? line.effectiveEgress.proxy : line.egressProxy;
  if (!proxy && !inherited) return null;
  return <Badge variant="outline" className="text-xs" title={proxy ? `${proxy.serverHost}:${proxy.serverPort}` : undefined}>
    {proxy?.protocol}{proxy && inherited ? ' · ' : ''}{inherited ? t('lineForm.egress.inherited') : ''}
  </Badge>;
}
