import { useEffect, useMemo, useState } from 'react';
import { useFormResetOnKey } from '@/hooks/use-form-reset';
import { zodResolver } from '@hookform/resolvers/zod';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import {
  AlertTriangle,
  ArrowDownLeft,
  ArrowUpRight,
  Calendar,
  CheckCircle2,
  CreditCard,
  Eye,
  EyeOff,
  Headphones,
  KeyRound,
  Mail,
  MailCheck,
  Pencil,
  Receipt,
  ShieldCheck,
  User,
  Wallet
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { IconButton } from '@/components/ui/icon-button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Form, FormControl, FormDescription, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Switch } from '@/components/ui/switch';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle
} from '@/components/ui/alert-dialog';
import { CopyButton } from '@/components/shared/copy-button';
import { EmptyState } from '@/components/shared/empty-state';
import { PageContainer, PageHeader } from '@/components/shared/page-container';
import { Pagination, PaginationInfo, PaginationNext, PaginationPrevious } from '@/components/ui/pagination';
import { formatCurrency, formatDateTime } from '@/lib/utils';
import {
  buildPasswordStrengthPolicy,
  passwordComplexityFromSettings,
  passwordZodSchema,
  type PasswordStrengthPolicy
} from '@/lib/password-policy';
import { usePublicSettings } from '@/lib/public-settings';
import { hasSupportContacts } from '@/lib/support';
import { SupportDialog, SupportContactsInline } from '@/components/shared/support-dialog';
import { useProfileMutations, useProfileUser, useWallet, useWalletTransactions } from './use-profile';

const redeemSchema = z.object({ code: z.string().trim().min(6, 'user:profile.redeemCodeMinError').max(128) });
const buildPasswordSchema = (minLength: number, policy: PasswordStrengthPolicy) =>
  z
    .object({
      oldPassword: z.string().min(8, 'user:profile.passwordMinLength'),
      newPassword: passwordZodSchema(minLength, policy),
      confirmPassword: z.string()
    })
    .refine((value) => value.newPassword === value.confirmPassword, {
      path: ['confirmPassword'],
      message: 'user:profile.passwordMismatch'
    });
const nicknameSchema = z.object({
  nickname: z.string().trim().min(2, 'user:profile.nicknameMinError').max(20, 'user:profile.nicknameMaxError')
});
const emailSchema = z.object({
  newEmail: z.string().email('user:profile.newEmailInvalid'),
  verificationCode: z.string().regex(/^\d{6}$/, 'user:profile.verifyCodeInvalid'),
  currentPassword: z.string().min(8, 'user:profile.passwordMinLength')
});
const verifyEmailSchema = z.object({
  code: z.string().regex(/^\d{6}$/, 'user:profile.verifyCodeInvalid')
});

type RedeemValues = z.infer<typeof redeemSchema>;
type PasswordValues = z.infer<ReturnType<typeof buildPasswordSchema>>;
type NicknameValues = z.infer<typeof nicknameSchema>;
type EmailValues = z.infer<typeof emailSchema>;
type VerifyEmailValues = z.infer<typeof verifyEmailSchema>;

export default function ProfilePage() {
  const { t } = useTranslation(['user', 'common']);
  const [page, setPage] = useState(1);
  const [resetOpen, setResetOpen] = useState(false);
  const [emailOpen, setEmailOpen] = useState(false);
  const [verifyEmailOpen, setVerifyEmailOpen] = useState(false);
  const [nicknameOpen, setNicknameOpen] = useState(false);
  const [showUuid, setShowUuid] = useState(false);
  const [emailCooldown, setEmailCooldown] = useState(0);
  const [verifyCooldown, setVerifyCooldown] = useState(0);

  const user = useProfileUser();
  const wallet = useWallet();
  const transactions = useWalletTransactions(page);
  const publicSettings = usePublicSettings();
  const passwordMinLength = publicSettings.data?.passwordMinLength ?? 8;
  const passwordComplexity = useMemo(() => passwordComplexityFromSettings(publicSettings.data), [publicSettings.data]);
  const passwordPolicy = useMemo(() => buildPasswordStrengthPolicy(passwordComplexity), [passwordComplexity]);
  const passwordSchema = useMemo(() => buildPasswordSchema(passwordMinLength, passwordPolicy), [passwordMinLength, passwordPolicy]);
  const { redeem, changePassword, resetUuid, updateProfile, updateNotificationPreferences, sendEmailCode, changeEmail, sendCurrentEmailCode, verifyCurrentEmail } = useProfileMutations();

  const transactionLabels: Record<string, string> = useMemo(
    () => ({
      SYSTEM_GIFT: t('user:profile.typeLabels.SYSTEM_GIFT'),
      REDEEM: t('user:profile.typeLabels.REDEEM'),
      PLAN_BUY: t('user:profile.typeLabels.PLAN_BUY'),
      PLAN_RENEW: t('user:profile.typeLabels.PLAN_RENEW'),
      PLAN_UPGRADE: t('user:profile.typeLabels.PLAN_UPGRADE'),
      ADMIN_ADJUST: t('user:profile.typeLabels.ADMIN_ADJUST')
    }),
    [t]
  );

  const redeemForm = useForm<RedeemValues>({
    resolver: zodResolver(redeemSchema),
    defaultValues: { code: '' }
  });
  const passwordForm = useForm<PasswordValues>({
    resolver: zodResolver(passwordSchema),
    defaultValues: { oldPassword: '', newPassword: '', confirmPassword: '' }
  });
  const nicknameForm = useForm<NicknameValues>({
    resolver: zodResolver(nicknameSchema),
    defaultValues: { nickname: '' }
  });
  const emailForm = useForm<EmailValues>({
    resolver: zodResolver(emailSchema),
    defaultValues: { newEmail: '', verificationCode: '', currentPassword: '' }
  });
  const verifyEmailForm = useForm<VerifyEmailValues>({
    resolver: zodResolver(verifyEmailSchema),
    defaultValues: { code: '' }
  });

  const totalPages = Math.ceil((transactions.data?.total ?? 0) / 10);

  // 昵称草稿仅在首次拿到用户数据时初始化；profile 每 5 秒轮询，且存在未保存修改时不回写
  useFormResetOnKey({
    resetKey: user.data?.id ?? null,
    dataRevision: user.dataUpdatedAt,
    isDirty: nicknameForm.formState.isDirty,
    reset: () => { if (user.data?.nickname) nicknameForm.reset({ nickname: user.data.nickname }); }
  });

  useEffect(() => {
    if (!emailCooldown) return;
    const timer = window.setInterval(() => setEmailCooldown((value) => Math.max(0, value - 1)), 1000);
    return () => window.clearInterval(timer);
  }, [emailCooldown]);

  useEffect(() => {
    if (!verifyCooldown) return;
    const timer = window.setInterval(() => setVerifyCooldown((value) => Math.max(0, value - 1)), 1000);
    return () => window.clearInterval(timer);
  }, [verifyCooldown]);

  if (user.isPending || wallet.isPending) {
    return (
      <PageContainer>
        <PageHeader title={t('user:profile.title')} />
        <div className="space-y-4">
          <div className="h-32 rounded-xl border bg-muted/20 animate-pulse" />
          <div className="h-64 rounded-xl border bg-muted/20 animate-pulse" />
        </div>
      </PageContainer>
    );
  }

  if (user.isError || wallet.isError || !user.data || !wallet.data) {
    return (
      <PageContainer>
        <PageHeader title={t('user:profile.title')} />
        <EmptyState
          title={t('user:profile.loadErrorTitle')}
          description={t('user:profile.loadErrorDesc')}
        />
      </PageContainer>
    );
  }

  const onRedeem = (values: RedeemValues) =>
    redeem.mutate(values.code, { onSuccess: () => redeemForm.reset() });

  const onPassword = (values: PasswordValues) => {
    changePassword.mutate(
      { oldPassword: values.oldPassword, newPassword: values.newPassword },
      { onSuccess: () => passwordForm.reset() }
    );
  };

  const onNickname = (values: NicknameValues) =>
    updateProfile.mutate({ nickname: values.nickname }, { onSuccess: () => setNicknameOpen(false) });

  const requestEmailCode = async () => {
    if (emailCooldown || sendEmailCode.isPending || !(await emailForm.trigger('newEmail'))) return;
    sendEmailCode.mutate(emailForm.getValues('newEmail'), { onSuccess: () => setEmailCooldown(60) });
  };

  const onChangeEmail = (values: EmailValues) =>
    changeEmail.mutate(values, {
      onSuccess: () => {
        emailForm.reset();
        setEmailOpen(false);
      }
    });

  const requestVerifyCode = () => {
    if (verifyCooldown || sendCurrentEmailCode.isPending || !user.data?.email) return;
    sendCurrentEmailCode.mutate(user.data.email, { onSuccess: () => setVerifyCooldown(60) });
  };

  const onVerifyEmail = (values: VerifyEmailValues) =>
    verifyCurrentEmail.mutate(values.code, {
      onSuccess: () => {
        setVerifyEmailOpen(false);
        verifyEmailForm.reset();
      }
    });

  const displayName = user.data.nickname || user.data.email;
  const userInitial = displayName[0]?.toUpperCase() || 'U';
  const isEmailUnverifiedBlocked = publicSettings.data?.enforceEmailVerification && !user.data.emailVerifiedAt && user.data.role !== 'ADMIN';

  return (
    <PageContainer>
      <PageHeader
        title={t('user:profile.title')}
        description={t('user:profile.description')}
      />

      {isEmailUnverifiedBlocked && (
        <div className="rounded-lg border border-amber-300 bg-amber-50 p-4 text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200">
          <div className="flex items-start gap-3">
            <AlertTriangle className="h-5 w-5 shrink-0 text-amber-600 dark:text-amber-400 mt-0.5" />
            <div className="flex-1 space-y-1">
              <div className="font-semibold text-sm">{t('user:profile.emailUnverifiedTitle')}</div>
              <p className="text-xs leading-relaxed text-amber-800 dark:text-amber-300">
                {t('user:profile.emailUnverifiedDesc')}
              </p>
              <div className="pt-1.5">
                <Button size="sm" variant="default" className="h-8 gap-1.5 text-xs" onClick={() => setVerifyEmailOpen(true)}>
                  <MailCheck className="size-3.5" />
                  {t('user:profile.verifyCurrentEmailNow')}
                </Button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* 顶部名片式用户身份横幅 (Profile Header) */}
      <Card className="min-w-0 overflow-hidden border-border/70 bg-gradient-to-br from-card via-card to-muted/20 shadow-sm">
        <CardContent className="p-5 sm:p-6">
          <div className="flex flex-col gap-5 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-start sm:items-center gap-4 sm:gap-5 min-w-0">
              {/* 大尺寸个性化 Avatar 头像 */}
              <div className="relative flex size-16 sm:size-20 shrink-0 items-center justify-center rounded-2xl border border-border/80 bg-muted/60 text-foreground font-bold text-2xl sm:text-3xl shadow-xs select-none dark:border-primary/25 dark:bg-gradient-to-br dark:from-primary/20 dark:via-primary/10 dark:to-primary/5 dark:text-primary">
                {userInitial}
              </div>

              {/* 用户信息与元数据 */}
              <div className="min-w-0 flex-1 space-y-2">
                <div className="flex flex-wrap items-center gap-2.5">
                  <h2 className="text-xl sm:text-2xl font-bold tracking-tight text-foreground truncate max-w-[220px] sm:max-w-[320px]">
                    {user.data.nickname || t('user:profile.unnamedUser')}
                  </h2>
                  <IconButton
                    type="button"
                    variant="ghost"
                    size="icon-xs"
                    className="rounded-full text-muted-foreground hover:bg-muted hover:text-foreground"
                    onClick={() => {
                      nicknameForm.reset({ nickname: user.data.nickname || '' });
                      setNicknameOpen(true);
                    }}
                    aria-label={t('user:profile.editNickname')}
                  >
                    <Pencil className="size-4" />
                  </IconButton>
                  <Badge variant={user.data.role === 'ADMIN' ? 'default' : 'secondary'} className="gap-1 font-normal">
                    {user.data.role === 'ADMIN' ? (
                      <>
                        <ShieldCheck className="size-3 text-emerald-500" />
                        <span>{t('user:profile.adminRole')}</span>
                      </>
                    ) : (
                      <>
                        <User className="size-3" />
                        <span>{t('user:profile.userRole')}</span>
                      </>
                    )}
                  </Badge>
                </div>

                <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-xs text-muted-foreground">
                  {/* 登录邮箱 + 验证状态 + 更换操作 */}
                  <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5 min-w-0 max-w-full">
                    <div className="flex items-center gap-1.5 min-w-0">
                      <Mail className="size-3.5 shrink-0 text-muted-foreground/70" />
                      <span
                        className="truncate max-w-[180px] xs:max-w-[240px] sm:max-w-[320px] font-medium text-foreground"
                        title={user.data.email}
                      >
                        {user.data.email}
                      </span>
                    </div>

                    <div className="flex items-center gap-1.5 shrink-0 whitespace-nowrap">
                      {user.data.emailVerifiedAt ? (
                        <Badge
                          variant="outline"
                          className="gap-1 px-1.5 py-0 text-[10px] text-emerald-600 border-emerald-300 bg-emerald-50 dark:bg-emerald-950/30 dark:border-emerald-800 whitespace-nowrap shrink-0"
                        >
                          <CheckCircle2 className="size-2.5" />
                          {t('user:profile.emailVerified')}
                        </Badge>
                      ) : (
                        <div className="flex items-center gap-1.5 shrink-0 whitespace-nowrap">
                          <Badge
                            variant="outline"
                            className="gap-1 px-1.5 py-0 text-[10px] text-amber-600 border-amber-300 bg-amber-50 dark:bg-amber-950/30 dark:border-amber-800 whitespace-nowrap shrink-0"
                          >
                            <AlertTriangle className="size-2.5" />
                            {t('user:profile.emailUnverified')}
                          </Badge>
                          <button
                            type="button"
                            className="text-xs text-amber-600 dark:text-amber-400 underline underline-offset-2 hover:opacity-80 transition-opacity font-medium whitespace-nowrap shrink-0"
                            onClick={() => setVerifyEmailOpen(true)}
                          >
                            {t('user:profile.verifyNow')}
                          </button>
                        </div>
                      )}
                      <button
                        type="button"
                        className="ml-0.5 text-xs text-primary underline underline-offset-2 hover:opacity-80 transition-opacity font-medium whitespace-nowrap shrink-0"
                        onClick={() => setEmailOpen(true)}
                      >
                        {t('user:profile.changeEmailAction')}
                      </button>
                    </div>
                  </div>

                  {/* 数字 UID */}
                  {user.data.uid ? (
                    <div className="flex items-center gap-1.5">
                      <span className="text-muted-foreground/70">{t('user:profile.uidLabel')}</span>
                      <span className="font-mono font-semibold text-foreground">{user.data.uid}</span>
                      <CopyButton value={String(user.data.uid)} className="h-6 px-1.5 text-[11px] gap-1" />
                    </div>
                  ) : null}

                  {/* 注册时间 */}
                  {user.data.createdAt ? (
                    <div className="flex items-center gap-1 text-muted-foreground/70">
                      <Calendar className="size-3.5 shrink-0" />
                      <span>{t('user:profile.joinedAt', { date: formatDateTime(user.data.createdAt).split(' ')[0] })}</span>
                    </div>
                  ) : null}
                </div>
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Tabs 分页架构（账号与安全 / 资产与财务） */}
      <Tabs defaultValue="security" className="space-y-4">
        <TabsList className="grid w-full grid-cols-2 max-w-xs sm:max-w-sm bg-muted/60 p-1">
          <TabsTrigger value="security" className="gap-2">
            <ShieldCheck className="size-4" />
            <span>{t('user:profile.tabSecurity')}</span>
          </TabsTrigger>
          <TabsTrigger value="wallet" className="gap-2">
            <Wallet className="size-4" />
            <span>{t('user:profile.tabWallet')}</span>
          </TabsTrigger>
        </TabsList>

        {/* Tab 1: 账号与安全 */}
        <TabsContent value="security" className="space-y-4">
          <div className="grid gap-4 lg:grid-cols-2">
            {/* 修改登录密码卡片 */}
            <Card className="min-w-0">
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-base">
                  <KeyRound className="size-4 text-primary" />
                  {t('user:profile.changePasswordTitle')}
                </CardTitle>
                <CardDescription>{t('user:profile.changePasswordDesc')}</CardDescription>
              </CardHeader>
              <CardContent>
                <Form {...passwordForm}>
                  <form onSubmit={passwordForm.handleSubmit(onPassword)} className="space-y-4">
                    {(['oldPassword', 'newPassword', 'confirmPassword'] as const).map((name) => (
                      <FormField
                        key={name}
                        control={passwordForm.control}
                        name={name}
                        render={({ field }) => (
                          <FormItem className="min-w-0">
                            <FormLabel>
                              {name === 'oldPassword'
                                ? t('user:profile.oldPasswordLabel')
                                : name === 'newPassword'
                                  ? t('user:profile.newPasswordLabel')
                                  : t('user:profile.confirmPasswordLabel')}
                            </FormLabel>
                            <FormControl>
                              <Input
                                className="min-w-0 max-w-full"
                                type="password"
                                autoComplete={name === 'oldPassword' ? 'current-password' : 'new-password'}
                                {...field}
                              />
                            </FormControl>
                            <FormMessage />
                          </FormItem>
                        )}
                      />
                    ))}
                    <Button type="submit" disabled={changePassword.isPending}>
                      {changePassword.isPending ? t('user:profile.savingPassword') : t('user:profile.savePasswordButton')}
                    </Button>
                  </form>
                </Form>
              </CardContent>
            </Card>

            {/* 代理连接凭据 (UUID) 与安全管理 */}
            <Card className="min-w-0 flex flex-col justify-between">
              <div>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2 text-base">
                    <ShieldCheck className="size-4 text-primary" />
                    {t('user:profile.proxyCredentialTitle')}
                  </CardTitle>
                  <CardDescription>{t('user:profile.proxyCredentialDesc')}</CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="space-y-2">
                    <div className="flex items-center justify-between text-xs text-muted-foreground">
                      <span>{t('user:profile.userUuidLabel')}</span>
                      <button
                        type="button"
                        onClick={() => setShowUuid((prev) => !prev)}
                        className="flex items-center gap-1 text-primary hover:underline font-medium"
                      >
                        {showUuid ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
                        <span>{showUuid ? t('user:profile.hidePlaintext') : t('user:profile.showPlaintext')}</span>
                      </button>
                    </div>
                    <div className="flex min-w-0 items-center gap-2">
                      <code className="min-w-0 flex-1 truncate rounded-md border bg-muted/50 px-3 py-2 font-mono text-xs text-foreground select-all">
                        {showUuid ? user.data.uuid : '••••••••-••••-••••-••••-••••••••••••'}
                      </code>
                      <CopyButton value={user.data.uuid} className="shrink-0" />
                    </div>
                  </div>

                  {/* 危险操作警示区 */}
                  <div className="rounded-lg border border-destructive/20 bg-destructive/5 p-4 space-y-3">
                    <div className="flex items-start gap-2.5">
                      <AlertTriangle className="size-4 text-destructive shrink-0 mt-0.5" />
                      <div className="space-y-1 text-xs">
                        <p className="font-semibold text-destructive">{t('user:profile.resetRiskTitle')}</p>
                        <p className="text-muted-foreground leading-relaxed">
                          {t('user:profile.resetRiskDesc')}
                        </p>
                      </div>
                    </div>
                    <Button
                      type="button"
                      variant="destructive"
                      size="sm"
                      onClick={() => setResetOpen(true)}
                      disabled={resetUuid.isPending}
                    >
                      {t('user:profile.resetProxyCredential')}
                    </Button>
                  </div>
                </CardContent>
              </div>
            </Card>
          </div>

          <Card className="min-w-0">
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <MailCheck className="size-4 text-primary" />
                {t('user:profile.notificationSettingsTitle')}
              </CardTitle>
              <CardDescription>{t('user:profile.notificationSettingsDesc')}</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="flex flex-col gap-4 rounded-lg border p-4 shadow-sm sm:flex-row sm:items-center sm:justify-between">
                <div className="space-y-1">
                  <p className="text-sm font-medium">{t('user:profile.subscriptionEmailNotifications')}</p>
                  <p className="text-xs text-muted-foreground">{t('user:profile.subscriptionEmailNotificationsDesc')}</p>
                  {!user.data.emailVerifiedAt ? <p className="text-xs text-amber-600">{t('user:profile.subscriptionEmailNeedsVerification')}</p> : null}
                </div>
                <Switch
                  checked={user.data.subscriptionEmailNotificationsEnabled}
                  disabled={updateNotificationPreferences.isPending}
                  onCheckedChange={(checked) => updateNotificationPreferences.mutate({ subscriptionEmailNotificationsEnabled: checked })}
                  aria-label={t('user:profile.subscriptionEmailNotifications')}
                />
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        {/* Tab 2: 资产与财务 */}
        <TabsContent value="wallet" className="space-y-4">
          {/* 上半部：资产总览与卡密充值并排 */}
          <div className="grid gap-4 lg:grid-cols-2">
            {/* 账户资产概览 */}
            <Card className="min-w-0">
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-base">
                  <Wallet className="size-4 text-primary" />
                  {t('user:profile.accountWalletTitle')}
                </CardTitle>
                <CardDescription>{t('user:profile.accountWalletDesc')}</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="rounded-xl border border-border/80 bg-muted/30 p-4 shadow-xs sm:p-5 dark:border-primary/20 dark:bg-gradient-to-br dark:from-primary/10 dark:via-primary/5 dark:to-transparent">
                  <p className="text-xs font-medium text-muted-foreground">{t('user:profile.currentBalance')}</p>
                  <p className="mt-1 text-3xl sm:text-4xl font-bold tracking-tight text-foreground">
                    {formatCurrency(wallet.data.balance)}
                  </p>
                </div>
                <div className="grid grid-cols-2 gap-3 pt-1">
                  <div className="rounded-lg border bg-muted/20 p-3">
                    <p className="text-xs text-muted-foreground flex items-center gap-1">
                      <ArrowDownLeft className="size-3.5 text-emerald-600 dark:text-emerald-400" />
                      <span>{t('user:profile.totalRecharge')}</span>
                    </p>
                    <p className="mt-1 text-lg font-semibold text-emerald-600 dark:text-emerald-400">
                      {formatCurrency(wallet.data.totalIncome)}
                    </p>
                  </div>
                  <div className="rounded-lg border bg-muted/20 p-3">
                    <p className="text-xs text-muted-foreground flex items-center gap-1">
                      <ArrowUpRight className="size-3.5 text-destructive" />
                      <span>{t('user:profile.totalExpense')}</span>
                    </p>
                    <p className="mt-1 text-lg font-semibold text-destructive">
                      {formatCurrency(wallet.data.totalExpense)}
                    </p>
                  </div>
                </div>
              </CardContent>
            </Card>

            {/* 卡密充值 */}
            <Card className="min-w-0 flex flex-col justify-between">
              <div>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2 text-base">
                    <CreditCard className="size-4 text-primary" />
                    {t('user:profile.redeemCardTitle')}
                  </CardTitle>
                  <CardDescription>{t('user:profile.redeemCardDesc')}</CardDescription>
                </CardHeader>
                <CardContent>
                  <Form {...redeemForm}>
                    <form onSubmit={redeemForm.handleSubmit(onRedeem)} className="space-y-4">
                      <FormField
                        control={redeemForm.control}
                        name="code"
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel>{t('user:profile.redeemCodeLabel')}</FormLabel>
                            <FormControl>
                              <Input placeholder={t('user:profile.redeemCodePlaceholder')} autoComplete="off" {...field} />
                            </FormControl>
                            <FormDescription>{t('user:profile.redeemCodeDesc')}</FormDescription>
                            <FormMessage />
                          </FormItem>
                        )}
                      />
                      <Button type="submit" disabled={redeem.isPending}>
                        {redeem.isPending ? t('user:profile.redeeming') : t('user:profile.redeemButton')}
                      </Button>
                    </form>
                  </Form>
                </CardContent>
              </div>
            </Card>
          </div>

          {/* 下半部：全宽收支明细表格 */}
          <Card className="min-w-0">
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <Receipt className="size-4 text-primary" />
                {t('user:profile.transactionsTitle')}
              </CardTitle>
              <CardDescription>{t('user:profile.transactionsDesc')}</CardDescription>
            </CardHeader>
            <CardContent className="min-w-0 space-y-4">
              <div className="overflow-x-auto rounded-md border">
                <Table className="min-w-[680px]">
                  <TableHeader>
                    <TableRow className="bg-muted/40">
                      <TableHead className="whitespace-nowrap">{t('user:profile.timeColumn')}</TableHead>
                      <TableHead className="whitespace-nowrap">{t('user:profile.typeColumn')}</TableHead>
                      <TableHead className="min-w-[160px] whitespace-nowrap">{t('user:profile.descriptionColumn')}</TableHead>
                      <TableHead className="min-w-[110px] whitespace-nowrap text-right">{t('user:profile.amountColumn')}</TableHead>
                      <TableHead className="min-w-[110px] whitespace-nowrap text-right">{t('user:profile.balanceAfterColumn')}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {transactions.data?.data.map((item) => (
                      <TableRow key={item.id}>
                        <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                          {formatDateTime(item.createdAt)}
                        </TableCell>
                        <TableCell className="whitespace-nowrap">
                          <Badge className="whitespace-nowrap font-normal" variant={item.amount >= 0 ? 'secondary' : 'outline'}>
                            {transactionLabels[item.type] ?? item.type}
                          </Badge>
                        </TableCell>
                        <TableCell className="min-w-[160px] max-w-[320px] break-words text-sm">
                          {item.description || '—'}
                        </TableCell>
                        <TableCell
                          className={`min-w-[110px] whitespace-nowrap text-right font-semibold tabular-nums ${
                            item.amount >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-destructive'
                          }`}
                        >
                          {item.amount >= 0 ? '+' : '-'}
                          {formatCurrency(Math.abs(item.amount))}
                        </TableCell>
                        <TableCell className="min-w-[110px] whitespace-nowrap text-right font-mono text-sm tabular-nums">
                          {formatCurrency(item.balanceAfter)}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
              {!transactions.data?.data.length && (
                <div className="py-8">
                  <EmptyState title={t('user:profile.noTransactionsTitle')} description={t('user:profile.noTransactionsDesc')} />
                </div>
              )}
              <Pagination className="border-t pt-3">
                <PaginationInfo page={page} totalPages={totalPages} />
                <PaginationPrevious
                  onClick={() => setPage((current) => Math.max(1, current - 1))}
                  disabled={page <= 1}
                />
                <PaginationNext
                  onClick={() => setPage((current) => Math.min(Math.max(totalPages, 1), current + 1))}
                  disabled={page >= Math.max(totalPages, 1)}
                />
              </Pagination>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      {/* 客服与技术支持卡片（若配置） */}
      {hasSupportContacts(publicSettings.data) ? (
        <Card className="min-w-0 border-border/60 bg-muted/20">
          <CardHeader className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between space-y-0 pb-3">
            <div>
              <CardTitle className="flex items-center gap-2 text-base">
                <Headphones className="size-4 text-primary" />
                {t('user:profile.supportTitle')}
              </CardTitle>
              <CardDescription>{t('user:profile.supportDesc')}</CardDescription>
            </div>
            <SupportDialog settings={publicSettings.data} />
          </CardHeader>
          <CardContent className="pt-0">
            <SupportContactsInline settings={publicSettings.data} className="justify-start" />
          </CardContent>
        </Card>
      ) : null}

      {/* 修改昵称弹窗 */}
      <Dialog open={nicknameOpen} onOpenChange={setNicknameOpen}>
        <DialogContent size="compact">
          <DialogHeader>
            <DialogTitle>{t('user:profile.nicknameDialogTitle')}</DialogTitle>
            <DialogDescription>{t('user:profile.nicknameDialogDesc')}</DialogDescription>
          </DialogHeader>
          <Form {...nicknameForm}>
            <form onSubmit={nicknameForm.handleSubmit(onNickname)} className="space-y-4">
              <FormField
                control={nicknameForm.control}
                name="nickname"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{t('user:profile.nicknameLabel')}</FormLabel>
                    <FormControl>
                      <Input placeholder={t('user:profile.nicknamePlaceholder')} {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <DialogFooter>
                <Button type="button" variant="outline" onClick={() => setNicknameOpen(false)}>
                  {t('common:actions.cancel')}
                </Button>
                <Button type="submit" disabled={updateProfile.isPending}>
                  {updateProfile.isPending ? t('user:profile.savingPassword') : t('user:profile.saveNickname')}
                </Button>
              </DialogFooter>
            </form>
          </Form>
        </DialogContent>
      </Dialog>

      {/* 更换登录邮箱弹窗 */}
      <Dialog open={emailOpen} onOpenChange={setEmailOpen}>
        <DialogContent size="compact">
          <DialogHeader>
            <DialogTitle>{t('user:profile.changeEmailDialogTitle')}</DialogTitle>
            <DialogDescription>{t('user:profile.changeEmailDialogDesc')}</DialogDescription>
          </DialogHeader>
          <Form {...emailForm}>
            <form onSubmit={emailForm.handleSubmit(onChangeEmail)} className="space-y-4">
              <FormField
                control={emailForm.control}
                name="newEmail"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{t('user:profile.newEmailLabel')}</FormLabel>
                    <FormControl>
                      <Input type="email" autoComplete="email" placeholder={t('user:profile.newEmailPlaceholder')} {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={emailForm.control}
                name="verificationCode"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{t('user:profile.verifyCodeLabel')}</FormLabel>
                    <div className="flex gap-2">
                      <FormControl>
                        <Input inputMode="numeric" autoComplete="one-time-code" placeholder={t('user:profile.verifyCodePlaceholder')} {...field} />
                      </FormControl>
                      <Button
                        type="button"
                        variant="outline"
                        className="shrink-0"
                        onClick={() => void requestEmailCode()}
                        disabled={emailCooldown > 0 || sendEmailCode.isPending}
                      >
                        <ShieldCheck className="size-4" />
                        {emailCooldown ? `${emailCooldown}s` : t('user:subscription.getCode')}
                      </Button>
                    </div>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={emailForm.control}
                name="currentPassword"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{t('user:profile.oldPasswordLabel')}</FormLabel>
                    <FormControl>
                      <Input type="password" autoComplete="current-password" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <DialogFooter>
                <Button type="button" variant="outline" onClick={() => setEmailOpen(false)}>
                  {t('common:actions.cancel')}
                </Button>
                <Button type="submit" disabled={changeEmail.isPending}>
                  {changeEmail.isPending ? t('user:profile.submittingEmail') : t('user:profile.confirmChangeEmail')}
                </Button>
              </DialogFooter>
            </form>
          </Form>
        </DialogContent>
      </Dialog>

      {/* 验证当前邮箱弹窗 */}
      <Dialog open={verifyEmailOpen} onOpenChange={setVerifyEmailOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('user:profile.verifyEmailDialogTitle')}</DialogTitle>
            <DialogDescription>
              {t('user:profile.verifyEmailDialogDesc')}<span className="font-mono text-foreground font-medium">{user.data.email}</span>
            </DialogDescription>
          </DialogHeader>
          <Form {...verifyEmailForm}>
            <form className="space-y-4" onSubmit={verifyEmailForm.handleSubmit(onVerifyEmail)}>
              <FormField
                control={verifyEmailForm.control}
                name="code"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{t('user:profile.verifyCodeLabel')}</FormLabel>
                    <div className="flex gap-2">
                      <FormControl>
                        <Input inputMode="numeric" autoComplete="one-time-code" placeholder={t('user:profile.verifyCodePlaceholder')} {...field} />
                      </FormControl>
                      <Button
                        type="button"
                        variant="outline"
                        className="shrink-0"
                        onClick={requestVerifyCode}
                        disabled={verifyCooldown > 0 || sendCurrentEmailCode.isPending}
                      >
                        <Mail className="size-4" />
                        {verifyCooldown ? `${verifyCooldown}s` : t('user:subscription.getCode')}
                      </Button>
                    </div>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <DialogFooter>
                <Button type="button" variant="outline" onClick={() => setVerifyEmailOpen(false)}>
                  {t('common:actions.cancel')}
                </Button>
                <Button type="submit" disabled={verifyCurrentEmail.isPending}>
                  {verifyCurrentEmail.isPending ? t('user:profile.verifyingEmail') : t('user:profile.confirmVerifyEmail')}
                </Button>
              </DialogFooter>
            </form>
          </Form>
        </DialogContent>
      </Dialog>

      {/* 重置代理凭据确认弹窗 */}
      <AlertDialog open={resetOpen} onOpenChange={setResetOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('user:profile.resetConfirmTitle')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('user:profile.resetConfirmDesc')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common:actions.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => resetUuid.mutate(undefined, { onSuccess: () => setResetOpen(false) })}
            >
              {t('user:profile.confirmReset')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </PageContainer>
  );
}
