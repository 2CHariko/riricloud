import { RefreshCw } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { UseFormReturn } from 'react-hook-form';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { FormControl, FormDescription, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import type { AdminLine } from '../../lines/use-lines';
import type { Plan } from '../../plans/use-plans';
import type { AdminUserSubscription } from '../use-users';
import { dateInputAfterDays, GB, type SubscriptionForm } from './user-form-schema';
import { formatDate, formatDateTime } from '@/lib/utils';



export function UserSubscriptionFields({
  form,
  plans,
  lineOptions,
  subscription,
  onResetToken,
  resetPending
}: {
  form: UseFormReturn<SubscriptionForm>;
  plans: Plan[];
  lineOptions: AdminLine[];
  subscription: AdminUserSubscription | null;
  onResetToken: () => void;
  resetPending: boolean;
}) {
  const { t } = useTranslation(['admin', 'common']);
  const currentPlanId = form.watch('planId');
  const selectedPlan = plans.find((plan) => plan.id === currentPlanId);
  const resetMode = subscription?.trafficResetMode ?? selectedPlan?.trafficResetMode ?? 'NONE';
  const nextResetAt = subscription?.nextTrafficResetAt;

  const hasSubscription = Boolean(subscription);
  const hasSelectedPlan = Boolean(currentPlanId);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between rounded-md border p-3">
        <div>
          <p className="text-sm font-medium">
            {subscription ? t('admin:userForm.currentPlanTitle', { name: subscription.plan?.name ?? t('admin:userForm.unnamedPlan') }) : t('admin:userForm.noSubscription')}
          </p>
          <p className="text-xs text-muted-foreground">
            {subscription ? t('admin:userForm.startedAt', { date: formatDate(subscription.startedAt) }) : t('admin:userForm.noSubNote')}
          </p>
        </div>
        {subscription && (
          <Button type="button" variant="outline" size="sm" disabled={resetPending} onClick={onResetToken}>
            <RefreshCw className={resetPending ? 'animate-spin' : undefined} />
            {t('admin:userForm.resetTokenButton')}
          </Button>
        )}
      </div>

      <div className="space-y-3">
        <FormField
          control={form.control}
          name="planId"
          render={({ field }) => (
            <FormItem>
              <FormLabel>{t('admin:userForm.planLabel')}</FormLabel>
              <Select
                value={field.value || (hasSubscription ? 'none' : 'unselected')}
                onValueChange={(value) => {
                  const planId = (value === 'none' || value === 'unselected') ? '' : value;
                  field.onChange(planId);
                  const plan = plans.find((item) => item.id === planId);
                  if (plan) {
                    form.setValue('quotaGB', plan.trafficLimitBytes / GB, { shouldValidate: true });
                    form.setValue('usedGB', 0, { shouldValidate: true });
                    form.setValue('expireAt', dateInputAfterDays(plan.durationDays), { shouldValidate: true });
                    form.setValue('status', 'ACTIVE', { shouldValidate: true });
                  } else {
                    form.setValue('quotaGB', 0, { shouldValidate: true });
                    form.setValue('usedGB', 0, { shouldValidate: true });
                    form.setValue('expireAt', '', { shouldValidate: true });
                  }
                }}
              >
                <FormControl>
                  <SelectTrigger>
                    <SelectValue placeholder={hasSubscription ? t('admin:userForm.noPlan') : t('admin:userForm.selectPlanBind')} />
                  </SelectTrigger>
                </FormControl>
                <SelectContent>
                  {hasSubscription ? (
                    <SelectItem value="none">{t('admin:userForm.noPlanCancelSub')}</SelectItem>
                  ) : (
                    <SelectItem value="unselected" disabled>{t('admin:userForm.selectPlanBind')}</SelectItem>
                  )}
                  {plans.map((plan) => (
                    <SelectItem key={plan.id} value={plan.id}>
                      {plan.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <FormMessage />
            </FormItem>
          )}
        />

        {!hasSelectedPlan && hasSubscription && (
          <div className="rounded-md border border-destructive/40 bg-destructive/10 p-4 text-sm text-destructive">
            <p className="font-semibold">{t('admin:userForm.selectedCancelSub')}</p>
            <p className="mt-1 text-xs opacity-90 leading-relaxed">
              {t('admin:userForm.selectedCancelSubDesc')}
            </p>
          </div>
        )}

        {!hasSelectedPlan && !hasSubscription && (
          <div className="rounded-md border border-dashed p-6 text-center text-xs text-muted-foreground">
            <p className="font-medium text-foreground">{t('admin:userForm.noActiveSub')}</p>
            <p className="mt-1">{t('admin:userForm.noActiveSubDesc')}</p>
          </div>
        )}

        {hasSelectedPlan && (
          <>
            <div className="rounded-md border border-dashed px-3 py-2 text-xs text-muted-foreground">
              <span className="font-medium text-foreground">{t('admin:userForm.trafficReset')}</span>
              {resetMode === 'CALENDAR_MONTH'
                ? t('common:resetMode.CALENDAR_MONTH')
                : resetMode === 'SUBSCRIPTION_CYCLE'
                  ? t('common:resetMode.SUBSCRIPTION_CYCLE')
                  : t('common:resetMode.NONE')}
              {resetMode === 'NONE'
                ? t('admin:userForm.noAutoReset')
                : nextResetAt
                  ? t('admin:userForm.nextResetAt', { time: formatDateTime(nextResetAt) })
                  : t('admin:userForm.calculateNextReset')}
            </div>

            <FormField
              control={form.control}
              name="status"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t('admin:userForm.statusLabel')}</FormLabel>
                  <Select value={field.value} onValueChange={field.onChange}>
                    <FormControl><SelectTrigger><SelectValue /></SelectTrigger></FormControl>
                    <SelectContent>
                      <SelectItem value="ACTIVE">{t('common:status.active')}</SelectItem>
                      <SelectItem value="CANCELED">{t('common:status.canceled')}</SelectItem>
                      <SelectItem value="EXPIRED">{t('common:status.expired')}</SelectItem>
                      <SelectItem value="REVOKED">{t('common:status.revoked')}</SelectItem>
                    </SelectContent>
                  </Select>
                  <FormMessage />
                </FormItem>
              )}
            />

            <div className="grid gap-3 sm:grid-cols-2">
              <FormField
                control={form.control}
                name="quotaGB"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{t('admin:userForm.quotaLabel')}</FormLabel>
                    <FormControl><Input type="number" min={0} step="any" {...field} /></FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="usedGB"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{t('admin:userForm.usedLabel')}</FormLabel>
                    <FormControl><Input type="number" min={0} step="any" {...field} /></FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <FormField
                control={form.control}
                name="expireAt"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{t('admin:userForm.expireAtLabel')}</FormLabel>
                    <FormControl><Input type="date" {...field} /></FormControl>
                    <FormDescription>{t('admin:userForm.expireAtPlaceholder')}</FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="addDays"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{t('admin:userForm.addDaysLabel')}</FormLabel>
                    <FormControl><Input type="number" min={1} placeholder={t('admin:userForm.addDaysPlaceholder')} {...field} /></FormControl>
                    <FormDescription>{t('admin:userForm.addDaysDesc')}</FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>

            <FormField
              control={form.control}
              name="extraLineIds"
              render={({ field }) => {
                const selectedIds = field.value ?? [];
                const toggleLine = (lineId: string) => {
                  field.onChange(
                    selectedIds.includes(lineId)
                      ? selectedIds.filter((id) => id !== lineId)
                      : [...selectedIds, lineId]
                  );
                };
                return (
                  <FormItem>
                    <FormLabel>{t('admin:userForm.extraLinesLabel')}</FormLabel>
                    <FormDescription>{t('admin:userForm.extraLinesHint')}</FormDescription>
                    <FormControl>
                      <div className="max-h-56 space-y-2 overflow-y-auto rounded-md border p-3">
                        {lineOptions.length ? lineOptions.map((line) => {
                          const targetLandingNode = line.relayMode === 'TARGET_LINE' ? line.targetLine?.entryNode : line.landingNode;
                          const available = line.status === 'ACTIVE' && (line.type === 'EXTERNAL' ? line.upstreamSummary?.status === 'ACTIVE' && line.upstreamSummary.presenceStatus === 'PRESENT' : line.entryNode?.status === 'ONLINE' && (!targetLandingNode || targetLandingNode.status === 'ONLINE'));
                          const topologyText = line.type === 'EXTERNAL' ? `${t('admin:upstream.externalType')} · ${line.protocolType}` : line.type === 'DIRECT'
                            ? `${line.entryNode?.name} · ${line.protocolType}`
                            : `${line.entryNode?.name} ➔ ${line.upstreamSummary?.name ?? targetLandingNode?.name ?? t('admin:lines.unbound')} · ${line.protocolType}`;
                          return (
                            <div key={line.id} className="flex items-start gap-2">
                              <Checkbox
                                id={`user-extra-line-${line.id}`}
                                checked={selectedIds.includes(line.id)}
                                onCheckedChange={() => toggleLine(line.id)}
                              />
                              <Label htmlFor={`user-extra-line-${line.id}`} className="min-w-0 cursor-pointer text-sm font-normal">
                                <span className="block truncate font-medium">{line.name}</span>
                                <span className="block text-xs text-muted-foreground">
                                  {topologyText} · {available ? t('admin:userForm.currentlyAvailable') : t('admin:userForm.waitingAvailable')}
                                  {!line.isPublic ? ` · ${t('admin:userForm.hiddenLine')}` : ''}
                                </span>
                              </Label>
                            </div>
                          );
                        }) : <p className="text-xs text-muted-foreground">{t('admin:userForm.emptyLines')}</p>}
                      </div>
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                );
              }}
            />
          </>
        )}
      </div>
    </div>
  );
}
