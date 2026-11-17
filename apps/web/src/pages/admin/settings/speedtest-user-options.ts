import type { AdminUser } from '@/pages/admin/users/use-users';

// 选择器只用于提示和过滤；保存及每次拨测均由服务端共用权益规则重新判定。
export function isSpeedtestUserCandidate(user: AdminUser, enforceEmailVerification: boolean, now = Date.now()): boolean {
  const subscription = user.subscription;
  if (!user.isActive || (enforceEmailVerification && !user.emailVerifiedAt && user.role !== 'ADMIN') || !subscription?.plan) return false;
  return ['ACTIVE', 'CANCELED'].includes(subscription.status)
    && subscription.trafficUsedBytes < subscription.trafficLimitBytes
    && (!subscription.expireAt || Date.parse(subscription.expireAt) > now);
}
