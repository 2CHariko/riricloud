import { ProbeMeasurementChip } from '@/components/shared/probe-result';

export interface LineLatencyChipProps {
  latencyMs?: number | null;
  status?: string | null;
  message?: string | null;
  testedAt?: string | Date | null;
  className?: string;
  onClick?: () => void;
}

/**
 * @deprecated 请优先直接使用 ProbeMeasurementChip 并传入统一的 lastProbe 快照对象
 */
export function LineLatencyChip({
  latencyMs,
  status,
  message,
  testedAt,
  className,
  onClick
}: LineLatencyChipProps) {
  const probeValue = status ? {
    schemaVersion: 2,
    measurement: 'MIHOMO_URL_TEST',
    perspective: 'MASTER',
    subjectType: 'LINE',
    subjectId: '',
    status,
    errorCode: null,
    message: message ?? '',
    engine: 'MIHOMO',
    engineVersion: null,
    fallbackReason: null,
    mihomoCompatibility: 'SUPPORTED',
    routeKind: 'MANAGED_DIRECT',
    targetId: '',
    targetHost: '',
    testedAt: testedAt ? new Date(testedAt).toISOString() : new Date().toISOString(),
    durationMs: 0,
    latencyMs: latencyMs ?? null,
    stage: 'DIAL_HTTP',
    configHash: '',
    applied: true
  } : null;

  return (
    <ProbeMeasurementChip
      value={probeValue}
      onClick={onClick}
      className={className}
    />
  );
}
