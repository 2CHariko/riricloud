import { isLineAuthorized, type AccessLine, type PlanLineRule } from './line-access';
import { applyPlanSnapshot } from '../subscription/plan-snapshot';

export interface SubscriptionEntitlementSnapshot {
  status: string;
  expireAt: Date | null;
  trafficLimitBytes: bigint;
  trafficUsedBytes: bigint;
  planSnapshotJson?: string | null;
  plan?: PlanLineRule | null;
  user: {
    isActive: boolean;
    role?: string;
    emailVerifiedAt?: Date | null;
    extraLineGrants?: Array<{ lineId: string }>;
  };
}
export type SubscriptionEntitlementReason = 'USER_INACTIVE' | 'EMAIL_UNVERIFIED' | 'SUBSCRIPTION_INACTIVE' | 'SUBSCRIPTION_EXPIRED' | 'QUOTA_EXHAUSTED' | 'LINE_UNAUTHORIZED';
export type SubscriptionEntitlement = { allowed: true } | { allowed: false; reason: SubscriptionEntitlementReason };

// 与节点入站、订阅拨测共享权益口径；取消续费的订阅在剩余有效期内仍有使用权。
export function evaluateSubscriptionEntitlement(
  subscription: SubscriptionEntitlementSnapshot | null | undefined,
  options: { enforceEmailVerification: boolean; line?: AccessLine; now?: Date }
): SubscriptionEntitlement {
  if (!subscription || !['ACTIVE', 'CANCELED'].includes(subscription.status)) return { allowed: false, reason: 'SUBSCRIPTION_INACTIVE' };
  if (!subscription.user.isActive) return { allowed: false, reason: 'USER_INACTIVE' };
  if (options.enforceEmailVerification && !subscription.user.emailVerifiedAt && subscription.user.role !== 'ADMIN') return { allowed: false, reason: 'EMAIL_UNVERIFIED' };
  if (subscription.expireAt && subscription.expireAt.getTime() <= (options.now?.getTime() ?? Date.now())) return { allowed: false, reason: 'SUBSCRIPTION_EXPIRED' };
  if (subscription.trafficUsedBytes >= subscription.trafficLimitBytes) return { allowed: false, reason: 'QUOTA_EXHAUSTED' };
  const effective = applyPlanSnapshot(subscription);
  if (options.line && ((options.line.status !== undefined && options.line.status !== 'ACTIVE') || (effective.plan && !isLineAuthorized(effective.plan, options.line, subscription.user.extraLineGrants?.map((grant) => grant.lineId) ?? [])))) return { allowed: false, reason: 'LINE_UNAUTHORIZED' };
  return { allowed: true };
}
