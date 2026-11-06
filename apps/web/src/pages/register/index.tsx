import { useEffect, useMemo, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@/lib/zod-resolver';
import { useMutation } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { z } from 'zod';
import { ArrowLeft, Cloud, Loader2, Mail, Timer } from 'lucide-react';
import { api, extractErrorMessage } from '@/lib/api';
import {
  buildPasswordStrengthPolicy,
  passwordComplexityFromSettings,
  passwordComplexityHint,
  passwordZodSchema,
  type PasswordStrengthPolicy
} from '@/lib/password-policy';
import { usePublicSettings } from '@/lib/public-settings';
import { useAuthStore } from '@/stores/auth';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form';
import { Input } from '@/components/ui/input';
import { SupportContactsInline } from '@/components/shared/support-dialog';
import { CaptchaDialog, CaptchaInline, type CaptchaPayload } from '@/components/shared/captcha-challenge';
import { LanguageSwitcher } from '@/components/layout/language-switcher';
import { ThemeToggle } from '@/components/layout/theme-toggle';

const buildRegisterSchema = (minLength: number, policy: PasswordStrengthPolicy, t: (key: string, options?: Record<string, unknown>) => string) =>
  z
    .object({
      email: z.string().email(t('auth:validation.emailInvalid')),
      nickname: z.string().max(20).optional(),
      password: passwordZodSchema(minLength, policy),
      confirmPassword: z.string(),
      verificationCode: z.string().optional()
    })
    .refine((v) => v.password === v.confirmPassword, {
      message: t('auth:validation.passwordMismatch'),
      path: ['confirmPassword']
    });

type RegisterForm = z.infer<ReturnType<typeof buildRegisterSchema>>;

export default function RegisterPage() {
  const { t } = useTranslation(['auth', 'common', 'errors']);
  const setAuth = useAuthStore((s) => s.setAuth);
  const navigate = useNavigate();
  const infoQuery = usePublicSettings();
  const [captchaOpen, setCaptchaOpen] = useState(false);
  const [registerCaptcha, setRegisterCaptcha] = useState<CaptchaPayload | null>(null);
  const [cooldown, setCooldown] = useState(0);
  const logoUrl = infoQuery.data?.logoUrl;
  const emailVerificationEnabled = infoQuery.data?.emailVerificationEnabled ?? false;
  const captchaMode = infoQuery.data?.captchaMode ?? 'OFF';
  const siteKey = infoQuery.data?.turnstileSiteKey ?? '';
  const passwordMinLength = infoQuery.data?.passwordMinLength ?? 8;
  const passwordComplexity = useMemo(() => passwordComplexityFromSettings(infoQuery.data), [infoQuery.data]);
  const passwordPolicy = useMemo(() => buildPasswordStrengthPolicy(passwordComplexity), [passwordComplexity]);
  const passwordHint = passwordComplexityHint(passwordComplexity);
  const passwordPlaceholder = `${passwordMinLength}-64${passwordHint ? ` (${passwordHint})` : ''}`;

  useEffect(() => {
    if (infoQuery.data && !infoQuery.data.registrationEnabled) {
      toast.error(t('auth:register.siteClosed'));
      navigate('/login', { replace: true });
    }
    // eslint-disable-next-line no-restricted-syntax -- 站点关闭注册时的一次性跳转判断，非表单草稿
  }, [infoQuery.data, navigate, t]);

  useEffect(() => {
    if (!cooldown) return;
    const timer = window.setInterval(() => setCooldown((value) => Math.max(0, value - 1)), 1000);
    return () => window.clearInterval(timer);
  }, [cooldown]);

  const registerSchema = useMemo(() => buildRegisterSchema(passwordMinLength, passwordPolicy, t as (key: string) => string), [passwordMinLength, passwordPolicy, t]);
  const form = useForm<RegisterForm>({
    resolver: zodResolver(registerSchema),
    defaultValues: { email: '', nickname: '', password: '', confirmPassword: '', verificationCode: '' }
  });

  const sendCodeMutation = useMutation({
    mutationFn: async (payload: CaptchaPayload) => {
      const email = form.getValues('email');
      return (await api.post('/verification/send-code', { email, action: 'REGISTER', ...payload })).data;
    },
    onSuccess: () => {
      setCooldown(60);
      setCaptchaOpen(false);
      toast.success(t('auth:register.codeSent'));
    },
    onError: (error) => toast.error(extractErrorMessage(error, t('errors:business.sendCodeFailed')))
  });

  const registerMutation = useMutation({
    mutationFn: async (values: RegisterForm) => {
      const payload: Record<string, unknown> = {
        email: values.email,
        nickname: values.nickname?.trim() || undefined,
        password: values.password,
        ...(emailVerificationEnabled ? { verificationCode: values.verificationCode } : registerCaptcha ?? {})
      };
      await api.post<{ accessToken: string }>('/auth/register', payload);
      const me = await api.get<{ id: string; email: string; role: 'ADMIN' | 'USER'; uid?: number | null; nickname?: string | null }>('/auth/me');
      return { user: me.data };
    },
    onSuccess: ({ user }) => {
      setAuth(user);
      toast.success(t('auth:register.registerSuccess'));
      navigate(user.role === 'ADMIN' ? '/admin/nodes' : '/subscription', { replace: true });
    },
    onError: (error) => toast.error(extractErrorMessage(error, t('common:status.failed')))
  });

  const requestCode = async () => {
    if (cooldown || sendCodeMutation.isPending) return;
    if (!(await form.trigger('email'))) return;
    if (captchaMode === 'OFF') {
      sendCodeMutation.mutate({});
    } else {
      setCaptchaOpen(true);
    }
  };

  const onSubmit = (values: RegisterForm) => {
    if (!emailVerificationEnabled && captchaMode !== 'OFF' && !registerCaptcha) {
      toast.error(t('auth:captcha.required'));
      return;
    }
    if (emailVerificationEnabled && !values.verificationCode?.trim()) {
      form.setError('verificationCode', { message: t('auth:validation.codeRequired') });
      return;
    }
    registerMutation.mutate(values);
  };

  const siteName = infoQuery.data?.siteName ?? 'RiriCloud';
  const siteDescription = infoQuery.data?.siteDescription?.trim();

  return (
    <div className="relative flex min-h-screen flex-col items-center justify-center bg-muted/40 p-3 sm:p-4">
      <div className="absolute top-4 left-4">
        <Button variant="ghost" size="sm" asChild className="gap-1.5 text-muted-foreground hover:text-foreground">
          <Link to="/">
            <ArrowLeft className="h-4 w-4" />
            <span>{t('auth:backToHome')}</span>
          </Link>
        </Button>
      </div>

      <div className="absolute top-4 right-4 flex items-center gap-2">
        <LanguageSwitcher showLabel />
        <ThemeToggle />
      </div>

      <Card className="w-full max-w-sm animate-in fade-in-0 zoom-in-[0.985] duration-300 ease-out">
        <CardHeader className="items-center text-center">
          <div className="mb-2 flex items-center gap-2">
            {logoUrl ? <img src={logoUrl} alt="" className="h-6 w-6 rounded object-contain" /> : <Cloud className="h-6 w-6 text-primary" />}
            <span className="text-lg font-semibold">{siteName}</span>
          </div>
          <CardTitle>{t('auth:register.title')}</CardTitle>
          <CardDescription>
            {siteDescription || t('auth:register.subtitle')}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Form {...form}>
            <form className="space-y-4" onSubmit={form.handleSubmit(onSubmit)}>
              <FormField control={form.control} name="email" render={({ field }) => (
                <FormItem>
                  <FormLabel>{t('auth:register.emailLabel')}</FormLabel>
                  <FormControl><Input type="email" placeholder={t('auth:register.emailPlaceholder')} autoComplete="username" {...field} /></FormControl>
                  <FormMessage />
                </FormItem>
              )} />
              <FormField control={form.control} name="nickname" render={({ field }) => (
                <FormItem>
                  <FormLabel>{t('auth:register.nicknameLabel')}</FormLabel>
                  <FormControl><Input placeholder={t('auth:register.nicknamePlaceholder')} autoComplete="nickname" {...field} /></FormControl>
                  <FormMessage />
                </FormItem>
              )} />
              <FormField control={form.control} name="password" render={({ field }) => (
                <FormItem>
                  <FormLabel>{t('auth:register.passwordLabel')}</FormLabel>
                  <FormControl><Input type="password" placeholder={passwordPlaceholder} autoComplete="new-password" {...field} /></FormControl>
                  <FormMessage />
                </FormItem>
              )} />
              <FormField control={form.control} name="confirmPassword" render={({ field }) => (
                <FormItem>
                  <FormLabel>{t('auth:register.confirmPasswordLabel')}</FormLabel>
                  <FormControl><Input type="password" placeholder={t('auth:register.confirmPasswordPlaceholder')} autoComplete="new-password" {...field} /></FormControl>
                  <FormMessage />
                </FormItem>
              )} />
              {emailVerificationEnabled ? (
                <FormField control={form.control} name="verificationCode" render={({ field }) => (
                  <FormItem>
                    <FormLabel>{t('auth:register.verificationCodeLabel')}</FormLabel>
                    <div className="flex gap-2">
                      <FormControl><Input inputMode="numeric" placeholder={t('auth:register.verificationCodePlaceholder')} autoComplete="one-time-code" {...field} /></FormControl>
                      <Button type="button" variant="outline" className="shrink-0" onClick={() => void requestCode()} disabled={cooldown > 0 || sendCodeMutation.isPending}>
                        <Mail className="size-4" />{cooldown ? t('auth:register.resendIn', { seconds: cooldown }) : t('auth:register.sendCode')}
                      </Button>
                    </div>
                    <FormMessage />
                  </FormItem>
                )} />
              ) : captchaMode !== 'OFF' ? (
                <CaptchaInline mode={captchaMode} siteKey={siteKey} action="register" onChange={setRegisterCaptcha} />
              ) : null}
              <Button type="submit" className="w-full" disabled={registerMutation.isPending || infoQuery.isPending}>
                {registerMutation.isPending ? <Loader2 className="animate-spin" /> : captchaMode !== 'OFF' && !emailVerificationEnabled ? <Timer className="size-4" /> : null}
                {registerMutation.isPending ? t('auth:register.registering') : t('auth:register.submitButton')}
              </Button>
              <p className="text-muted-foreground text-center text-sm">
                {t('auth:register.hasAccount')}{' '}
                <Link className="text-primary underline-offset-4 hover:underline" to="/login">
                  {t('auth:register.loginNow')}
                </Link>
              </p>
            </form>
          </Form>
        </CardContent>
      </Card>
      <div className="mt-6 flex flex-col items-center gap-2 text-center text-xs text-muted-foreground">
        <SupportContactsInline settings={infoQuery.data} />
        {infoQuery.data?.footerCopyright ? <p>{infoQuery.data.footerCopyright}</p> : <p>© {new Date().getFullYear()} {siteName}</p>}
      </div>
      <CaptchaDialog open={captchaOpen} mode={captchaMode} siteKey={siteKey} action="register" onOpenChange={setCaptchaOpen} onVerified={(payload) => sendCodeMutation.mutate(payload)} />
    </div>
  );
}
