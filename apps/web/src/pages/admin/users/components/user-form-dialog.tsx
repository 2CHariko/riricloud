import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useFormResetOnKey } from '@/hooks/use-form-reset';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@/lib/zod-resolver';
import { Button } from '@/components/ui/button';
import { DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { ResponsiveDialog, ResponsiveDialogContent } from '@/components/shared/responsive-dialog';
import { Form } from '@/components/ui/form';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog';
import type { Plan } from '../../plans/use-plans';
import type { AdminLine } from '../../lines/use-lines';
import { useUserMutations, type AdminUser } from '../use-users';
import { CreateUserFields, EditAccountFields } from './user-account-fields';
import { UserSubscriptionFields } from './user-subscription-fields';
import { buildCreateUserSchema, buildEditAccountSchema, dateInputToIso, GB, subscriptionSchema, type CreateUserForm, type EditAccountForm, type SubscriptionForm } from './user-form-schema';
import { buildPasswordStrengthPolicy, passwordComplexityFromSettings } from '@/lib/password-policy';
import { usePublicSettings } from '@/lib/public-settings';

interface UserFormDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  user: AdminUser | null;
  selfId: string;
  plans: Plan[];
  lineOptions: AdminLine[];
}

const emptyCreateValues: CreateUserForm = {
  email: '',
  password: '',
  role: 'USER',
  planId: ''
};

export function UserFormDialog({ open, onOpenChange, user, selfId, plans, lineOptions }: UserFormDialogProps) {
  const { t } = useTranslation(['admin', 'common']);
  const { createUser, updateUser, updateSubscription, assignSubscription, resetSubscriptionToken } = useUserMutations();
  const publicSettings = usePublicSettings();
  const passwordMinLength = publicSettings.data?.passwordMinLength ?? 8;
  const passwordComplexity = useMemo(() => passwordComplexityFromSettings(publicSettings.data), [publicSettings.data]);
  const passwordPolicy = useMemo(() => buildPasswordStrengthPolicy(passwordComplexity), [passwordComplexity]);
  const createUserSchema = useMemo(() => buildCreateUserSchema(passwordMinLength, passwordPolicy), [passwordMinLength, passwordPolicy]);
  const editAccountSchema = useMemo(() => buildEditAccountSchema(passwordMinLength, passwordPolicy), [passwordMinLength, passwordPolicy]);
  const [resetConfirmOpen, setResetConfirmOpen] = useState(false);
  const [removeSubscriptionConfirmOpen, setRemoveSubscriptionConfirmOpen] = useState(false);
  const isEdit = !!user;
  const isSelf = user?.id === selfId;
  const accountForm = useForm<EditAccountForm>({ resolver: zodResolver(editAccountSchema), defaultValues: { role: 'USER', isActive: true, emailVerified: false, password: '', deviceLimitMode: 'FOLLOW_PLAN', deviceLimitCount: undefined } });
  const createForm = useForm<CreateUserForm>({ resolver: zodResolver(createUserSchema), defaultValues: emptyCreateValues });
  const subscriptionForm = useForm<SubscriptionForm>({ resolver: zodResolver(subscriptionSchema), defaultValues: { planId: '', status: 'ACTIVE', quotaGB: 0, usedGB: 0, expireAt: '', addDays: undefined, extraLineIds: [] } });

  useFormResetOnKey({
    open,
    resetKey: user?.id ?? 'create',
    reset: () => {
      if (!user) {
        createForm.reset(emptyCreateValues);
        return;
      }
      accountForm.reset({ role: user.role, isActive: user.isActive, emailVerified: !!user.emailVerifiedAt, password: '', deviceLimitMode: user.deviceLimit == null ? 'FOLLOW_PLAN' : user.deviceLimit === 0 ? 'UNLIMITED' : 'CUSTOM', deviceLimitCount: user.deviceLimit && user.deviceLimit > 0 ? user.deviceLimit : undefined });
      const subscription = user.subscription;
      subscriptionForm.reset({
        planId: subscription?.plan?.id ?? '',
        status: subscription?.status ?? 'ACTIVE',
        quotaGB: (subscription?.trafficLimitBytes ?? 0) / GB,
        usedGB: (subscription?.trafficUsedBytes ?? 0) / GB,
        expireAt: subscription?.expireAt ? subscription.expireAt.slice(0, 10) : '',
        addDays: undefined,
        extraLineIds: subscription?.extraLineIds ?? []
      });
    }
  });

  const submitAccount = (values: EditAccountForm) => {
    if (!user) return;
    updateUser.mutate({ id: user.id, role: values.role, isActive: values.isActive, emailVerified: values.emailVerified, deviceLimit: values.deviceLimitMode === 'FOLLOW_PLAN' ? null : values.deviceLimitMode === 'UNLIMITED' ? 0 : values.deviceLimitCount, ...(values.password ? { password: values.password } : {}) }, { onSuccess: () => onOpenChange(false) });
  };

  const submitCreate = (values: CreateUserForm) => {
    createUser.mutate({
      email: values.email,
      password: values.password,
      role: values.role,
      planId: values.planId || null
    }, { onSuccess: () => onOpenChange(false) });
  };

  const submitSubscription = (values: SubscriptionForm) => {
    if (!user) return;
    const planId = values.planId || null;
    if (!planId && !user.subscription) {
      onOpenChange(false);
      return;
    }
    if (!planId && user.subscription) {
      setRemoveSubscriptionConfirmOpen(true);
      return;
    }
    const payload = {
      planId,
      status: values.status,
      trafficLimitBytes: Math.round(values.quotaGB * GB),
      trafficUsedBytes: Math.round(values.usedGB * GB),
      expireAt: values.addDays ? undefined : dateInputToIso(values.expireAt ?? ''),
      addDays: values.addDays,
      extraLineIds: values.extraLineIds
    };
    if (user.subscription) {
      updateSubscription.mutate({ id: user.subscription.id, ...payload }, { onSuccess: () => onOpenChange(false) });
    } else if (planId) {
      assignSubscription.mutate({ userId: user.id, ...payload, planId }, { onSuccess: () => onOpenChange(false) });
    }
  };

  const watchedPlanId = subscriptionForm.watch('planId');
  const hasSubscription = Boolean(user?.subscription);
  const canSaveSubscription = hasSubscription || Boolean(watchedPlanId);
  const isRemovingSubscription = hasSubscription && !watchedPlanId;

  return (
    <>
      <ResponsiveDialog open={open} onOpenChange={onOpenChange}>
        <ResponsiveDialogContent>
          <DialogHeader>
            <DialogTitle>{isEdit ? t('admin:userForm.manageTitle', { email: user?.email }) : t('admin:userForm.createTitle')}</DialogTitle>
            <DialogDescription>{isEdit ? t('admin:userForm.manageDesc') : t('admin:userForm.createDesc')}</DialogDescription>
          </DialogHeader>
          {isEdit ? (
            <Tabs key={user?.id} defaultValue="account" className="w-full">
              <TabsList className="grid w-full grid-cols-2">
                <TabsTrigger value="account">{t('admin:userForm.tabAccount')}</TabsTrigger>
                <TabsTrigger value="subscription">{t('admin:userForm.tabSubscription')}</TabsTrigger>
              </TabsList>
              <TabsContent value="account">
                <Form {...accountForm}>
                  <form className="space-y-4" onSubmit={accountForm.handleSubmit(submitAccount)}>
                    <EditAccountFields form={accountForm} isSelf={isSelf} />
                    <DialogFooter>
                      <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                        {t('common:actions.cancel')}
                      </Button>
                      <Button type="submit" disabled={updateUser.isPending}>
                        {updateUser.isPending ? t('common:actions.saving') : t('admin:userForm.saveAccount')}
                      </Button>
                    </DialogFooter>
                  </form>
                </Form>
              </TabsContent>
              <TabsContent value="subscription">
                <Form {...subscriptionForm}>
                  <form className="space-y-4" onSubmit={subscriptionForm.handleSubmit(submitSubscription)}>
                    <UserSubscriptionFields form={subscriptionForm} plans={plans} lineOptions={lineOptions} subscription={user.subscription} onResetToken={() => setResetConfirmOpen(true)} resetPending={resetSubscriptionToken.isPending} />
                    <DialogFooter>
                      <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                        {t('common:actions.cancel')}
                      </Button>
                      <Button
                        type="submit"
                        disabled={!canSaveSubscription || updateSubscription.isPending || assignSubscription.isPending}
                        variant={isRemovingSubscription ? 'destructive' : 'default'}
                      >
                        {updateSubscription.isPending || assignSubscription.isPending
                          ? t('common:actions.saving')
                          : isRemovingSubscription
                            ? t('admin:userForm.removeSub')
                            : t('admin:userForm.saveSub')}
                      </Button>
                    </DialogFooter>
                  </form>
                </Form>
              </TabsContent>
            </Tabs>
          ) : (
            <Form {...createForm}>
              <form className="space-y-4" onSubmit={createForm.handleSubmit(submitCreate)}>
                <CreateUserFields form={createForm} plans={plans} />
                <DialogFooter>
                  <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                    {t('common:actions.cancel')}
                  </Button>
                  <Button type="submit" disabled={createUser.isPending}>
                    {createUser.isPending ? t('admin:userForm.creating') : t('admin:userForm.createAccount')}
                  </Button>
                </DialogFooter>
              </form>
            </Form>
          )}
        </ResponsiveDialogContent>
      </ResponsiveDialog>
      <AlertDialog open={resetConfirmOpen} onOpenChange={setResetConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('admin:userForm.resetTokenConfirmTitle')}</AlertDialogTitle>
            <AlertDialogDescription>{t('admin:userForm.resetTokenConfirmDesc')}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common:actions.cancel')}</AlertDialogCancel>
            <AlertDialogAction onClick={() => { if (user) resetSubscriptionToken.mutate(user.id); setResetConfirmOpen(false); }}>
              {t('admin:userForm.confirmResetToken')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <AlertDialog open={removeSubscriptionConfirmOpen} onOpenChange={setRemoveSubscriptionConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('admin:userForm.removeSubConfirmTitle')}</AlertDialogTitle>
            <AlertDialogDescription>{t('admin:userForm.removeSubConfirmDesc')}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common:actions.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={updateSubscription.isPending}
              onClick={() => {
                if (user?.subscription) {
                  updateSubscription.mutate(
                    { id: user.subscription.id, planId: null },
                    { onSuccess: () => onOpenChange(false) }
                  );
                }
                setRemoveSubscriptionConfirmOpen(false);
              }}
            >
              {t('admin:userForm.confirmRemove')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
