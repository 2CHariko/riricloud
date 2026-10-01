import { Activity, Zap } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { ProbeMeasurementChip } from '@/components/shared/probe-result';
import { cn } from '@/lib/utils';
import { usePublicSettings } from '@/lib/public-settings';
import { formatSpeedLimit, getSpeedTierBadgeClass } from '@/lib/speed-tier';
import type { UserLine } from '@/pages/user/subscription/use-user-subscription';

interface LineCardProps {
  line: UserLine;
  className?: string;
}

import { useTranslation } from 'react-i18next';

// 用户只需确认线路名称、协议、倍率、延迟和当前在线状态，拓扑细节由订阅客户端负责展示。
export function LineCard({ line, className }: LineCardProps) {
  const { t } = useTranslation(['common', 'admin']);
  const { data: publicSettings } = usePublicSettings();
  const isOnline = line.status === 'ACTIVE';
  const unitConversion = publicSettings?.speedLimitUnitConversionEnabled !== false;
  const speedText = formatSpeedLimit(line.speedLimitMbps, unitConversion);
  const speedBadgeClass = getSpeedTierBadgeClass(line.speedLimitMbps, publicSettings?.speedLimitColorTiers);

  return (
    <div className={cn('flex min-w-0 flex-col justify-between gap-2.5 rounded-md border bg-card/50 p-3 transition-colors hover:bg-muted/20', className)}>
      <div className="flex items-center justify-between gap-2">
        <p className="min-w-0 truncate text-sm font-medium" title={line.name}>
          {line.name}
        </p>
        <div className="flex shrink-0 items-center gap-1.5">
          <Badge variant="outline" className="text-xs">{line.protocolType}</Badge>
          {line.capabilities.trafficMetered ? <Badge variant="outline" className="text-xs">{line.trafficRate}x</Badge> : <Badge variant="outline">{t('admin:upstream.externalType')}</Badge>}
        </div>
      </div>
      <div className="flex items-center gap-2">
        <Badge variant={isOnline ? 'default' : 'secondary'} className="gap-1 text-xs">
          <Activity className="size-3" />
          {isOnline ? t('status.active') : t('status.offline')}
        </Badge>
        {line.capabilities.localLimitsSupported && Boolean(line.speedLimitMbps) && (
          <Badge variant="outline" className={cn('gap-1 text-xs font-normal', speedBadgeClass)}>
            <Zap className="size-3" />
            {speedText}
          </Badge>
        )}
        <ProbeMeasurementChip value={line.lastProbe} />
      </div>
      {!line.capabilities.trafficMetered && <p className="text-xs text-muted-foreground">{t('lineCapabilities.unmetered')}</p>}
      {!line.capabilities.localLimitsSupported && <p className="text-xs text-muted-foreground">{t('lineCapabilities.noLocalLimits')}</p>}
      {!line.capabilities.credentialRevocable && <p className="text-xs text-destructive">{t('lineCapabilities.notRevocable')}</p>}
    </div>
  );
}
