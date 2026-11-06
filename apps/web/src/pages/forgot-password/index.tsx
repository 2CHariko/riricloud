import { useEffect, useMemo, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@/lib/zod-resolver';
import { useMutation } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { z } from 'zod';
import { ArrowLeft, Cloud, KeyRound, Loader2, Mail } from 'lucide-react';
import { api, extractErrorMessage } from '@/lib/api';
import {
  buildPasswordStrengthPolicy,
  passwordComplexityFromSettings,
  passwordComplexityHint,
  passwordZodSchema,
  type PasswordStrengthPolicy
} from '@/lib/password-policy';
import { usePublicSettings } from '@/lib/public-settings';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form';
import { Input } from '@/components/ui/input';
import { SupportContactsInline } from '@/components/shared/support-dialog';
import { CaptchaDialog, type CaptchaPayload } from '@/components/shared/captcha-challenge';
import { LanguageSwitcher } from '@/components/layout/language-switcher';
import { ThemeToggle } from '@/components/layout/theme-toggle';

const buildForgotPasswordSchema = (minLength: number, policy: PasswordStrengthPolicy, t: (key: string) => string) =>
  z
    .object({
      email: z.string().email(t('auth:validation.emailInvalid')),
      verificationCode: z.string().min(6, t('auth:validation.codeLength')).max(6, t('auth:validation.codeLength')),
      newPassword: passwordZodSchema(minLength, policy),
      confirmPassword: z.string()
    })
    .refine((v) => v.newPassword === v.confirmPassword, {
      message: t('auth:validation.passwordMismatch'),
      path: ['confirmPassword']
    });

type ForgotPasswordForm = z.infer<ReturnType<typeof buildForgotPasswordSchema>>;

export default function ForgotPasswordPage() {
  const { t } = useTranslation(['auth', 'common', 'errors']);
  const navigate = useNavigate();
  const infoQuery = usePublicSettings();
  const [captchaOpen, setCaptchaOpen] = useState(false);
  const [cooldown, setCooldown] = useState(0);

  const logoUrl = infoQuery.data?.logoUrl;
  const captchaMode = infoQuery.data?.captchaMode ?? 'OFF';
  const siteKey = infoQuery.data?.turnstileSiteKey ?? '';
  const siteName = infoQuery.data?.siteName ?? 'RiriCloud';
  const passwordMinLength = infoQuery.data?.passwordMinLength ?? 8;
  const passwordComplexity = useMemo(() => passwordComplexityFromSettings(infoQuery.data), [infoQuery.data]);
  const passwordPolicy = useMemo(() => buildPasswordStrengthPolicy(passwordComplexity), [passwordComplexity]);
  const passwordHint = passwordComplexityHint(passwordComplexity);
  const passwordPlaceholder = `${passwordMinLength}-64${passwordHint ? ` (${passwordHint})` : ''}`;

  useEffect(() => {
    if (!cooldown) return;
    const timer = window.setInterval(() => setCooldown((value) => Math.max(0, value - 1)), 1000);
    return () => window.clearInterval(timer);
  }, [cooldown]);

  const forgotPasswordSchema = useMemo(() => buildForgotPasswordSchema(passwordMinLength, passwordPolicy, t as (key: string) => string), [passwordMinLength, passwordPolicy, t]);
  const form = useForm<ForgotPasswordForm>({
    resolver: zodResolver(forgotPasswordSchema),
    defaultValues: { email: '', verificationCode: '', newPassword: '', confirmPassword: '' }
  });

  const sendCodeMutation = useMutation({
    mutationFn: async (payload: CaptchaPayload) => {
      const email = form.getValues('email');
      return (await api.post('/verification/send-code', { email, action: 'RESET_PASSWORD', ...payload })).data;
    },
    onSuccess: () => {
      setCooldown(60);
      setCaptchaOpen(false);
      toast.success(t('auth:register.codeSent'));
    },
    onError: (error) => toast.error(extractErrorMessage(error, t('errors:business.sendCodeFailed')))
  });

  const resetPasswordMutation = useMutation({
    mutationFn: async (values: ForgotPasswordForm) => {
      return (await api.post('/auth/reset-password', {
        email: values.email,
        code: values.verificationCode,
        newPassword: values.newPassword
      })).data;
    },
    onSuccess: () => {
      toast.success(t('auth:forgotPassword.resetSuccess'));
      navigate('/login', { replace: true });
    },
    onError: (error) => toast.error(extractErrorMessage(error, t('errors:business.tokenExpired')))
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

  const onSubmit = (values: ForgotPasswordForm) => {
    resetPasswordMutation.mutate(values);
  };

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
          <CardTitle>{t('auth:forgotPassword.title')}</CardTitle>
          <CardDescription>{t('auth:forgotPassword.subtitle')}</CardDescription>
        </CardHeader>
        <CardContent>
          <Form {...form}>
            <form className="space-y-4" onSubmit={form.handleSubmit(onSubmit)}>
              <FormField
                control={form.control}
                name="email"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{t('auth:forgotPassword.emailLabel')}</FormLabel>
                    <FormControl>
                      <Input type="email" placeholder={t('auth:forgotPassword.emailPlaceholder')} autoComplete="username" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="verificationCode"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{t('auth:forgotPassword.verificationCodeLabel')}</FormLabel>
                    <div className="flex gap-2">
                      <FormControl>
                        <Input inputMode="numeric" placeholder={t('auth:forgotPassword.verificationCodePlaceholder')} autoComplete="one-time-code" {...field} />
                      </FormControl>
                      <Button
                        type="button"
                        variant="outline"
                        className="shrink-0"
                        onClick={() => void requestCode()}
                        disabled={cooldown > 0 || sendCodeMutation.isPending}
                      >
                        <Mail className="size-4" />
                        {cooldown ? t('auth:register.resendIn', { seconds: cooldown }) : t('auth:register.sendCode')}
                      </Button>
                    </div>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="newPassword"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{t('auth:forgotPassword.newPasswordLabel')}</FormLabel>
                    <FormControl>
                      <Input type="password" placeholder={passwordPlaceholder} autoComplete="new-password" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="confirmPassword"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{t('auth:forgotPassword.confirmPasswordLabel')}</FormLabel>
                    <FormControl>
                      <Input type="password" placeholder={t('auth:forgotPassword.confirmPasswordPlaceholder')} autoComplete="new-password" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <Button type="submit" className="w-full" disabled={resetPasswordMutation.isPending}>
                {resetPasswordMutation.isPending ? <Loader2 className="animate-spin" /> : <KeyRound className="size-4" />}
                {resetPasswordMutation.isPending ? t('auth:forgotPassword.resetting') : t('auth:forgotPassword.submitButton')}
              </Button>

              <p className="text-muted-foreground text-center text-sm">
                <Link className="text-primary underline-offset-4 hover:underline" to="/login">
                  {t('auth:forgotPassword.backToLogin')}
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
      <CaptchaDialog
        open={captchaOpen}
        mode={captchaMode}
        siteKey={siteKey}
        action="reset-password"
        onOpenChange={setCaptchaOpen}
        onVerified={(payload) => sendCodeMutation.mutate(payload)}
      />
    </div>
  );
}
