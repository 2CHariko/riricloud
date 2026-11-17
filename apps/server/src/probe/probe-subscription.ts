export type ProbeSubscriptionErrorCode = 'SPEEDTEST_USER_NOT_CONFIGURED' | 'SPEEDTEST_USER_UNAVAILABLE' | 'SPEEDTEST_LINE_UNAUTHORIZED' | 'SPEEDTEST_IDENTITY_CHANGED';
const messages: Record<ProbeSubscriptionErrorCode, string> = {
  SPEEDTEST_USER_NOT_CONFIGURED: '请在系统设置中指定有合法订阅的拨测账号',
  SPEEDTEST_USER_UNAVAILABLE: '拨测账号不可用，请检查账号状态、邮箱验证、订阅有效期和配额',
  SPEEDTEST_LINE_UNAUTHORIZED: '拨测账号无权访问此线路',
  SPEEDTEST_IDENTITY_CHANGED: '拨测账号或凭据已变更，请重新测试'
};
// 只暴露固定原因，禁止把用户标识、认证材料或数据库异常写入任务结果。
export class ProbeSubscriptionError extends Error {
  constructor(readonly code: ProbeSubscriptionErrorCode) { super(messages[code]); }
}
