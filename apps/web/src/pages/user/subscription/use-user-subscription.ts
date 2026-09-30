import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { api, extractErrorMessage } from '@/lib/api';
import i18n from '@/i18n/config';
import type { PlanCardConfig } from '@/pages/admin/plans/use-plans';

export type TrafficResetMode = 'NONE' | 'CALENDAR_MONTH' | 'SUBSCRIPTION_CYCLE';
export interface UserPlan {
  id: string;
  name: string;
  description: string | null;
  price: number;
  durationDays: number;
  trafficLimitBytes: number;
  trafficResetMode: TrafficResetMode;
  lineMatchMode: string;
  badgeText?: string | null;
  isFeatured?: boolean;
  features?: string[];
  cardConfig?: PlanCardConfig;
  purchaseLimitPerUser: number | null;
  allowRenewal: boolean;
  deviceLimit?: number | null;
  speedLimitMbps?: number | null;
}
export interface DeviceManagement { onlineDeviceCount: number; configuredDeviceLimit: number | null; effectiveDeviceLimit: number | null; deviceLimitSource: 'USER' | 'PLAN' | 'UNLIMITED' | 'GLOBAL_OFF'; configuredDeviceLimitSource: 'USER' | 'PLAN' | 'UNLIMITED'; deviceLimitEnabled: boolean; devices: Array<{ ip: string; connections: number; firstSeenAt: number; lastSeenAt: number; nodes: Array<{ nodeId: string; nodeName: string; lineId: string | null; lineName: string | null; connections: number }> }>; }
export interface UserSubscription { id: string; status: 'ACTIVE' | 'CANCELED' | 'EXPIRED' | 'REVOKED'; trafficLimitBytes: number; trafficUsedBytes: number; startedAt: string; expireAt: string | null; subscriptionToken: string; trafficResetMode: TrafficResetMode; nextTrafficResetAt: string | null; extraLineIds: string[]; plan: UserPlan; }
export interface UserLine {
  id: string;
  name: string;
  type: 'DIRECT' | 'RELAY' | 'EXTERNAL';
  status: 'ACTIVE' | 'DISABLED';
  serverHost: string;
  serverPort: number;
  capabilities: { trafficMetered: boolean; localLimitsSupported: boolean; credentialRevocable: boolean };
  protocolType: string;
  trafficRate: number;
  speedLimitMbps?: number | null;
  lastLatencyMs?: number | null;
  lastTestedAt?: string | null;
  lastTestStatus?: string | null;
  lastTestMessage?: string | null;
}

export interface PlanClaim {
  planId: string;
  used: number;
}

export function useUserSubscription() {
  return useQuery({
    queryKey: ['user', 'subscription'],
    queryFn: async () => (await api.get<{ subscription: UserSubscription | null; lines: UserLine[]; planClaims: PlanClaim[]; deviceManagement: DeviceManagement | null }>('/user/subscription')).data,
    refetchInterval: 5000
  });
}

export function useUserSubscriptionMutations() {
  const queryClient = useQueryClient();
  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['user', 'subscription'] });
    void queryClient.invalidateQueries({ queryKey: ['user', 'nodes'] });
  };
  const subscribe = useMutation({
    mutationFn: async (planId: string) => (await api.post('/user/subscription', { planId })).data,
    onSuccess: () => { toast.success(i18n.t('user:market.buySuccess')); invalidate(); },
    onError: (error: unknown) => toast.error(extractErrorMessage(error, i18n.t('common:status.failed')))
  });
  const upgrade = useMutation({
    mutationFn: async (planId: string) => (await api.post('/user/subscription/upgrade', { planId })).data,
    onSuccess: () => { toast.success(i18n.t('common:status.success')); invalidate(); },
    onError: (error: unknown) => toast.error(extractErrorMessage(error, i18n.t('common:status.failed')))
  });
  const renew = useMutation({
    mutationFn: async () => (await api.post('/user/subscription/renew')).data,
    onSuccess: () => { toast.success(i18n.t('common:status.success')); invalidate(); },
    onError: (error: unknown) => toast.error(extractErrorMessage(error, i18n.t('common:status.failed')))
  });
  const cancel = useMutation({
    mutationFn: async () => (await api.post('/user/subscription/cancel')).data,
    onSuccess: () => { toast.success(i18n.t('common:status.success')); invalidate(); },
    onError: (error: unknown) => toast.error(extractErrorMessage(error, i18n.t('common:status.failed')))
  });
  const resetToken = useMutation({
    mutationFn: async () => (await api.post<{ subscriptionToken: string }>('/user/subscription/reset-token')).data,
    onSuccess: () => { toast.success(i18n.t('user:subscription.regenerateSuccess')); invalidate(); },
    onError: (error: unknown) => toast.error(extractErrorMessage(error, i18n.t('common:status.failed')))
  });
  const kickDevice = useMutation({ mutationFn: async (ip: string) => (await api.delete('/user/subscription/devices', { params: { ip } })).data, onSuccess: invalidate, onError: (error: unknown) => toast.error(extractErrorMessage(error, i18n.t('common:status.failed'))) });
  const kickAllDevices = useMutation({ mutationFn: async () => (await api.post('/user/subscription/devices/kick-all')).data, onSuccess: invalidate, onError: (error: unknown) => toast.error(extractErrorMessage(error, i18n.t('common:status.failed'))) });
  return { subscribe, upgrade, renew, cancel, resetToken, kickDevice, kickAllDevices };
}
