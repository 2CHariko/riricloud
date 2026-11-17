import { evaluateSubscriptionEntitlement, type SubscriptionEntitlementSnapshot } from './subscription-entitlement';
const now = new Date('2026-11-17T00:00:00Z');
function subscription(): SubscriptionEntitlementSnapshot {
  return { status: 'ACTIVE', trafficLimitBytes: 1000n, trafficUsedBytes: 0n, expireAt: new Date(now.getTime() + 1000),
    user: { isActive: true, role: 'USER', emailVerifiedAt: now, extraLineGrants: [] },
    plan: { lineMatchMode: 'EXPLICIT', lineTagsJson: '[]', lineIdsJson: '["line"]' } };
}
const options = { enforceEmailVerification: true, now, line: { id: 'line', status: 'ACTIVE', isPublic: true, tagsJson: '[]' } };
describe('共享订阅权益规则', () => {
  it.each(['ACTIVE', 'CANCELED'])('有效 %s 订阅可访问套餐线路', (status) => {
    expect(evaluateSubscriptionEntitlement({ ...subscription(), status }, options)).toEqual({ allowed: true });
  });
  it.each(['EXPIRED', 'REVOKED', 'UNKNOWN'])('%s 订阅拒绝访问', (status) => {
    expect(evaluateSubscriptionEntitlement({ ...subscription(), status }, options)).toEqual({ allowed: false, reason: 'SUBSCRIPTION_INACTIVE' });
  });
  it('缺失订阅、停用用户、未验证邮箱分别拒绝', () => {
    expect(evaluateSubscriptionEntitlement(null, options)).toMatchObject({ reason: 'SUBSCRIPTION_INACTIVE' });
    const value = subscription(); value.user.isActive = false;
    expect(evaluateSubscriptionEntitlement(value, options)).toMatchObject({ reason: 'USER_INACTIVE' });
    value.user.isActive = true; value.user.emailVerifiedAt = null;
    expect(evaluateSubscriptionEntitlement(value, options)).toMatchObject({ reason: 'EMAIL_UNVERIFIED' });
    expect(evaluateSubscriptionEntitlement(value, { ...options, enforceEmailVerification: false })).toEqual({ allowed: true });
    value.user.role = 'ADMIN'; expect(evaluateSubscriptionEntitlement(value, options)).toEqual({ allowed: true });
  });
  it('到期边界与配额边界拒绝，永久订阅不自动到期', () => {
    const value = subscription(); value.expireAt = now;
    expect(evaluateSubscriptionEntitlement(value, options)).toMatchObject({ reason: 'SUBSCRIPTION_EXPIRED' });
    value.expireAt = null; expect(evaluateSubscriptionEntitlement(value, options)).toEqual({ allowed: true });
    value.trafficUsedBytes = value.trafficLimitBytes;
    expect(evaluateSubscriptionEntitlement(value, options)).toMatchObject({ reason: 'QUOTA_EXHAUSTED' });
  });
  it('额外授权支持非公开线路，但不能越过停用和订阅状态', () => {
    const value = subscription(); const privateOptions = { ...options, line: { ...options.line, isPublic: false } };
    expect(evaluateSubscriptionEntitlement(value, privateOptions)).toMatchObject({ reason: 'LINE_UNAUTHORIZED' });
    value.user.extraLineGrants = [{ lineId: 'line' }]; expect(evaluateSubscriptionEntitlement(value, privateOptions)).toEqual({ allowed: true });
    expect(evaluateSubscriptionEntitlement(value, { ...privateOptions, line: { ...privateOptions.line, status: 'DISABLED' } })).toMatchObject({ reason: 'LINE_UNAUTHORIZED' });
  });
  it('兑换套餐快照覆盖当前套餐匹配规则', () => {
    const value = subscription(); value.plan!.lineIdsJson = '["other"]';
    value.planSnapshotJson = JSON.stringify({ name: 'redeemed', trafficLimitBytes: '1000', lineMatchMode: 'EXPLICIT', lineIdsJson: '["line"]', lineTagsJson: '[]' });
    expect(evaluateSubscriptionEntitlement(value, options)).toEqual({ allowed: true });
  });
});
