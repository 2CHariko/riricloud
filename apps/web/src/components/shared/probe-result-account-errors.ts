import type { ProbeResult } from '@/lib/probe-types';

const accountErrorKeys = {
  SPEEDTEST_LINE_UNMETERED: 'admin:latencyTest.accountErrors.SPEEDTEST_LINE_UNMETERED',
  SPEEDTEST_USER_NOT_CONFIGURED: 'admin:latencyTest.accountErrors.SPEEDTEST_USER_NOT_CONFIGURED',
  SPEEDTEST_USER_UNAVAILABLE: 'admin:latencyTest.accountErrors.SPEEDTEST_USER_UNAVAILABLE',
  SPEEDTEST_LINE_UNAUTHORIZED: 'admin:latencyTest.accountErrors.SPEEDTEST_LINE_UNAUTHORIZED',
  SPEEDTEST_IDENTITY_CHANGED: 'admin:latencyTest.accountErrors.SPEEDTEST_IDENTITY_CHANGED'
} as const;

// 视图只接收白名单本地化键，不能把后端诊断内容或任意错误码拼成文案。
export function probeAccountErrorKey(result: Pick<ProbeResult, 'status' | 'errorCode'> | null) {
  if (!result || result.status === 'SUCCESS' || typeof result.errorCode !== 'string') return null;
  return Object.prototype.hasOwnProperty.call(accountErrorKeys, result.errorCode)
    ? accountErrorKeys[result.errorCode as keyof typeof accountErrorKeys]
    : null;
}
