import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { api, extractErrorMessage } from '@/lib/api';
import i18n from '@/i18n/config';

export interface ProfileUser {
  id: string;
  uid: number | null;
  nickname: string;
  email: string;
  emailVerifiedAt: string | null;
  subscriptionEmailNotificationsEnabled: boolean;
  role: 'ADMIN' | 'USER';
  balance: number;
  uuid: string;
  trafficLimitBytes: number;
  trafficUsedBytes: number;
  expireAt: string | null;
  subscriptionToken: string;
  isActive: boolean;
  createdAt: string;
}

export interface WalletSummary {
  balance: number;
  totalIncome: number;
  totalExpense: number;
  transactionCount: number;
}

export interface WalletTransaction {
  id: string;
  amount: number;
  balanceBefore: number;
  balanceAfter: number;
  type: string;
  description: string | null;
  createdAt: string;
}

export function useProfileUser() {
  return useQuery({
    queryKey: ['auth', 'me'],
    queryFn: async () => (await api.get<ProfileUser>('/auth/me')).data
  });
}

export function useWallet() {
  return useQuery({
    queryKey: ['user', 'wallet'],
    queryFn: async () => (await api.get<WalletSummary>('/user/wallet')).data,
    refetchInterval: 5000
  });
}

export function useWalletTransactions(page: number) {
  return useQuery({
    queryKey: ['user', 'wallet', 'transactions', page],
    queryFn: async () => (await api.get<{ data: WalletTransaction[]; total: number; page: number; pageSize: number }>('/user/wallet/transactions', { params: { page, pageSize: 10 } })).data,
    placeholderData: (previous) => previous
  });
}

export function useProfileMutations() {
  const queryClient = useQueryClient();
  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['auth', 'me'] });
    void queryClient.invalidateQueries({ queryKey: ['user', 'wallet'] });
    void queryClient.invalidateQueries({ queryKey: ['user', 'wallet', 'transactions'] });
  };
  const redeem = useMutation({
    mutationFn: async (code: string) => (await api.post('/user/wallet/redeem', { code })).data,
    onSuccess: () => { toast.success(i18n.t('user:profile.redeemSuccess')); invalidate(); },
    onError: (error: unknown) => toast.error(extractErrorMessage(error, i18n.t('user:profile.redeemFailed')))
  });
  const changePassword = useMutation({
    mutationFn: async (payload: { oldPassword: string; newPassword: string }) => (await api.post('/user/change-password', payload)).data,
    onSuccess: () => toast.success(i18n.t('user:profile.passwordSuccess')),
    onError: (error: unknown) => toast.error(extractErrorMessage(error, i18n.t('user:profile.passwordFailed')))
  });
  const resetUuid = useMutation({
    mutationFn: async () => (await api.post<{ uuid: string }>('/user/reset-uuid')).data,
    onSuccess: () => { toast.success(i18n.t('user:profile.resetUuidSuccess')); invalidate(); },
    onError: (error: unknown) => toast.error(extractErrorMessage(error, i18n.t('user:profile.resetUuidFailed')))
  });
  const updateProfile = useMutation({
    mutationFn: async (payload: { nickname: string }) => (await api.patch('/user/profile', payload)).data,
    onSuccess: () => { toast.success(i18n.t('user:profile.nicknameSuccess')); invalidate(); },
    onError: (error: unknown) => toast.error(extractErrorMessage(error, i18n.t('user:profile.nicknameFailed')))
  });
  const updateNotificationPreferences = useMutation({
    mutationFn: async (payload: { subscriptionEmailNotificationsEnabled: boolean }) => (await api.patch<{ subscriptionEmailNotificationsEnabled: boolean }>('/user/notification-preferences', payload)).data,
    onSuccess: () => { toast.success(i18n.t('user:profile.notificationPreferencesSuccess')); invalidate(); },
    onError: (error: unknown) => toast.error(extractErrorMessage(error, i18n.t('user:profile.notificationPreferencesFailed')))
  });
  const sendEmailCode = useMutation({
    mutationFn: async (email: string) => (await api.post('/verification/send-code', { email, action: 'CHANGE_EMAIL' })).data,
    onSuccess: () => toast.success(i18n.t('user:profile.codeSentNewEmail')),
    onError: (error: unknown) => toast.error(extractErrorMessage(error, i18n.t('user:profile.codeSendFailed')))
  });
  const changeEmail = useMutation({
    mutationFn: async (payload: { newEmail: string; verificationCode: string; currentPassword: string }) => (await api.post('/user/change-email', payload)).data,
    onSuccess: () => { toast.success(i18n.t('user:profile.emailChangeSuccess')); invalidate(); },
    onError: (error: unknown) => toast.error(extractErrorMessage(error, i18n.t('user:profile.emailChangeFailed')))
  });
  const sendCurrentEmailCode = useMutation({
    mutationFn: async (email: string) => (await api.post('/verification/send-code', { email, action: 'VERIFY_CURRENT_EMAIL' })).data,
    onSuccess: () => toast.success(i18n.t('user:profile.codeSentCurrentEmail')),
    onError: (error: unknown) => toast.error(extractErrorMessage(error, i18n.t('user:profile.codeSendFailed')))
  });
  const verifyCurrentEmail = useMutation({
    mutationFn: async (code: string) => (await api.post<{ verified: boolean; emailVerifiedAt: string | null }>('/user/verify-email', { code })).data,
    onSuccess: () => { toast.success(i18n.t('user:profile.emailVerifySuccess')); invalidate(); },
    onError: (error: unknown) => toast.error(extractErrorMessage(error, i18n.t('user:profile.emailVerifyFailed')))
  });
  return { redeem, changePassword, resetUuid, updateProfile, updateNotificationPreferences, sendEmailCode, changeEmail, sendCurrentEmailCode, verifyCurrentEmail };
}
