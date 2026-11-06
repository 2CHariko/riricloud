import { useMemo } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@/lib/zod-resolver';
import { Link, useNavigate } from 'react-router-dom';
import { useMutation } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { z } from 'zod';
import { ArrowLeft, Cloud, Loader2, LogIn } from 'lucide-react';
import { toast } from 'sonner';
import { api, extractErrorMessage } from '@/lib/api';
import { usePublicSettings } from '@/lib/public-settings';
import { useAuthStore } from '@/stores/auth';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form';
import { Input } from '@/components/ui/input';
import { SupportContactsInline } from '@/components/shared/support-dialog';
import { LanguageSwitcher } from '@/components/layout/language-switcher';
import { ThemeToggle } from '@/components/layout/theme-toggle';

interface MeResponse {
  id: string;
  email: string;
  role: 'ADMIN' | 'USER';
}

export default function LoginPage() {
  const { t } = useTranslation(['auth', 'common', 'errors']);
  const setAuth = useAuthStore((s) => s.setAuth);
  const navigate = useNavigate();
  const infoQuery = usePublicSettings();
  const siteName = infoQuery.data?.siteName ?? 'RiriCloud';
  const logoUrl = infoQuery.data?.logoUrl;
  const siteDescription = infoQuery.data?.siteDescription?.trim();

  const loginSchema = useMemo(
    () =>
      z.object({
        email: z.string().email(t('auth:validation.emailInvalid')),
        password: z.string().min(8, t('auth:validation.passwordLength'))
      }),
    [t]
  );

  type LoginForm = z.infer<typeof loginSchema>;

  const form = useForm<LoginForm>({
    resolver: zodResolver(loginSchema),
    defaultValues: { email: '', password: '' }
  });

  const loginMutation = useMutation({
    mutationFn: async (values: LoginForm) => {
      await api.post<{ accessToken: string }>('/auth/login', values);
      const me = await api.get<MeResponse>('/auth/me');
      return { user: me.data };
    },
    onSuccess: ({ user }) => {
      setAuth(user);
      toast.success(t('auth:login.loginSuccess'));
      navigate(user.role === 'ADMIN' ? '/admin/nodes' : '/subscription', { replace: true });
    },
    onError: (error) => {
      toast.error(extractErrorMessage(error, t('errors:business.invalidCredentials')));
    }
  });

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
          <CardTitle>{t('auth:login.title')}</CardTitle>
          <CardDescription>
            {siteDescription || t('auth:login.subtitle')}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Form {...form}>
            <form className="space-y-4" onSubmit={form.handleSubmit((v) => loginMutation.mutate(v))}>
              <FormField
                control={form.control}
                name="email"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{t('auth:login.emailLabel')}</FormLabel>
                    <FormControl>
                      <Input type="email" placeholder={t('auth:login.emailPlaceholder')} autoComplete="username" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="password"
                render={({ field }) => (
                  <FormItem>
                    <div className="flex items-center justify-between">
                      <FormLabel>{t('auth:login.passwordLabel')}</FormLabel>
                      <Link className="text-xs text-muted-foreground underline-offset-4 hover:text-primary hover:underline" to="/forgot-password">
                        {t('auth:login.forgotPassword')}
                      </Link>
                    </div>
                    <FormControl>
                      <Input type="password" placeholder={t('auth:login.passwordPlaceholder')} autoComplete="current-password" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <Button type="submit" className="w-full" disabled={loginMutation.isPending}>
                {loginMutation.isPending ? <Loader2 className="animate-spin" /> : <LogIn className="size-4" />}
                {loginMutation.isPending ? t('auth:login.signingIn') : t('auth:login.submitButton')}
              </Button>
              {infoQuery.data?.registrationEnabled ? (
                <p className="text-muted-foreground text-center text-sm">
                  {t('auth:login.noAccount')}{' '}
                  <Link className="text-primary underline-offset-4 hover:underline" to="/register">
                    {t('auth:login.registerNow')}
                  </Link>
                </p>
              ) : null}
            </form>
          </Form>
        </CardContent>
      </Card>
      <div className="mt-6 flex flex-col items-center gap-2 text-center text-xs text-muted-foreground">
        <SupportContactsInline settings={infoQuery.data} />
        {infoQuery.data?.footerCopyright ? (
          <p>{infoQuery.data.footerCopyright}</p>
        ) : (
          <p>© {new Date().getFullYear()} {siteName}</p>
        )}
      </div>
    </div>
  );
}
