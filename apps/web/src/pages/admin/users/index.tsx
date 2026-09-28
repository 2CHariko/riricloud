import * as React from 'react';
import type { ColumnDef, RowSelectionState } from '@tanstack/react-table';
import { Activity, Pencil, Plus, RefreshCw, Search, ShieldOff, ShieldCheck, Smartphone, Trash2, WalletCards } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { api } from '@/lib/api';
import { useAuthStore } from '@/stores/auth';
import { toast } from 'sonner';
import { PageContainer, PageHeader } from '@/components/shared/page-container';
import { DataTable } from '@/components/shared/data-table';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Progress } from '@/components/ui/progress';
import { Skeleton } from '@/components/ui/skeleton';
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
import { IconButton } from '@/components/ui/icon-button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useAdminPlans } from '../plans/use-plans';
import { useAdminLines } from '../lines/use-lines';
import { useAdminUsers, useAdminUserDevices, useUserMutations, type AdminUser, type AdminUserSubscription } from './use-users';
import { UserFormDialog } from './components/user-form-dialog';
import { UserTrafficDialog } from './components/user-traffic-dialog';
import { BalanceFormDialog } from './components/balance-form-dialog';
import { DeviceManagementDialog } from '@/components/shared/device-management-dialog';
import { formatBytes, formatCurrency, formatDate } from '@/lib/utils';

function StatusBadge({ isActive }: { isActive: boolean }) {
  const { t } = useTranslation(['admin']);
  return isActive ? (
    <Badge className="border-transparent bg-emerald-600 text-white hover:bg-emerald-600">
      {t('admin:users.statusActive')}
    </Badge>
  ) : (
    <Badge variant="destructive">{t('admin:users.statusDisabled')}</Badge>
  );
}

function SubscriptionStatusBadge({ status }: { status: AdminUserSubscription['status'] | null }) {
  const { t } = useTranslation(['admin', 'common']);
  if (!status) return <Badge variant="outline">{t('admin:users.noSubscription')}</Badge>;
  const variant = status === 'ACTIVE' ? 'default' : status === 'REVOKED' ? 'destructive' : 'secondary';
  const labels: Record<AdminUserSubscription['status'], string> = {
    ACTIVE: t('admin:users.statusActive'),
    CANCELED: t('common:status.canceled'),
    EXPIRED: t('common:status.expired'),
    REVOKED: t('common:status.revoked')
  };
  return <Badge variant={variant}>{labels[status] ?? status}</Badge>;
}

export default function AdminUsersPage() {
  const { t } = useTranslation(['admin', 'common']);
  const selfId = useAuthStore((s) => s.user?.id);
  const [search, setSearch] = React.useState('');
  const [debouncedSearch, setDebouncedSearch] = React.useState('');
  const [editing, setEditing] = React.useState<AdminUser | null>(null);
  const [formOpen, setFormOpen] = React.useState(false);
  const [deleting, setDeleting] = React.useState<AdminUser | null>(null);
  const [resetting, setResetting] = React.useState<AdminUser | null>(null);
  const [bulkDeleting, setBulkDeleting] = React.useState(false);
  const [selected, setSelected] = React.useState<AdminUser[]>([]);
  const [rowSelection, setRowSelection] = React.useState<RowSelectionState>({});
  const [roleFilter, setRoleFilter] = React.useState<'ALL' | 'USER' | 'ADMIN'>('ALL');
  const [activeFilter, setActiveFilter] = React.useState<'ALL' | 'true' | 'false'>('ALL');
  const [emailVerifiedFilter, setEmailVerifiedFilter] = React.useState<'ALL' | 'true' | 'false'>('ALL');
  const [subscriptionFilter, setSubscriptionFilter] = React.useState<'ALL' | AdminUserSubscription['status'] | 'NONE'>('ALL');
  const [planFilter, setPlanFilter] = React.useState('ALL');
  const [trafficUser, setTrafficUser] = React.useState<AdminUser | null>(null);
  const [devicesUser, setDevicesUser] = React.useState<AdminUser | null>(null);
  const [adjusting, setAdjusting] = React.useState<AdminUser | null>(null);

  React.useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(search.trim()), 400);
    return () => clearTimeout(timer);
  }, [search]);

  const { data, isPending } = useAdminUsers({
    search: debouncedSearch,
    role: roleFilter === 'ALL' ? undefined : roleFilter,
    isActive: activeFilter === 'ALL' ? undefined : activeFilter === 'true',
    emailVerified: emailVerifiedFilter === 'ALL' ? undefined : emailVerifiedFilter === 'true',
    subscriptionStatus: subscriptionFilter === 'ALL' ? undefined : subscriptionFilter,
    planId: planFilter === 'ALL' ? undefined : planFilter
  });
  const { data: plans } = useAdminPlans();
  const { data: lineData } = useAdminLines();
  const { deleteUser, bulkActive, resetSubscriptionToken } = useUserMutations();
  const deviceManagement = useAdminUserDevices(devicesUser?.id, Boolean(devicesUser));
  const users = data?.data ?? [];

  const columns = React.useMemo<ColumnDef<AdminUser>[]>(
    () => [
      {
        accessorKey: 'uid',
        header: t('admin:users.uid'),
        cell: ({ row }) => <span className="font-mono tabular-nums">{row.original.uid ?? '—'}</span>
      },
      {
        accessorKey: 'nickname',
        header: t('admin:users.nickname'),
        cell: ({ row }) => <span className="max-w-32 truncate font-medium">{row.original.nickname || '—'}</span>
      },
      {
        accessorKey: 'email',
        header: t('admin:users.email'),
        cell: ({ row }) => (
          <div className="flex items-center gap-1.5 min-w-0">
            <span className="truncate font-medium">{row.original.email}</span>
            {row.original.emailVerifiedAt ? (
              <Badge variant="outline" className="px-1 py-0 text-[10px] text-emerald-600 border-emerald-300 bg-emerald-50 dark:bg-emerald-950/30 dark:border-emerald-800 shrink-0">
                {t('admin:users.verified')}
              </Badge>
            ) : (
              <Badge variant="outline" className="px-1 py-0 text-[10px] text-amber-600 border-amber-300 bg-amber-50 dark:bg-amber-950/30 dark:border-amber-800 shrink-0">
                {t('admin:users.unverified')}
              </Badge>
            )}
          </div>
        )
      },
      {
        id: 'plan',
        header: t('admin:users.plan'),
        cell: ({ row }) => row.original.subscription?.plan ? (
          <Badge variant="outline">{row.original.subscription.plan.name}</Badge>
        ) : <span className="text-muted-foreground">{t('admin:users.unbound')}</span>
      },
      {
        accessorKey: 'balance',
        header: t('admin:users.balance'),
        cell: ({ row }) => <span className="whitespace-nowrap font-medium tabular-nums">{formatCurrency(row.original.balance)}</span>
      },
      {
        id: 'subscriptionStatus',
        header: t('admin:users.filterSubscription'),
        cell: ({ row }) => <SubscriptionStatusBadge status={row.original.subscription?.status ?? null} />
      },
      {
        accessorKey: 'role',
        header: t('admin:users.role'),
        cell: ({ row }) => (
          <Badge variant={row.original.role === 'ADMIN' ? 'default' : 'secondary'}>
            {row.original.role === 'ADMIN' ? t('admin:users.roleAdmin') : t('admin:users.roleUser')}
          </Badge>
        )
      },
      {
        id: 'quota',
        header: t('admin:users.trafficUsed'),
        cell: ({ row }) => {
          const { trafficLimitBytes: limit, trafficUsedBytes: used } = row.original;
          const percent = limit > 0 ? Math.min(Math.round((used / limit) * 100), 100) : 0;
          return (
            <div className="w-40 space-y-1">
              <Progress value={percent} />
              <p className="text-muted-foreground text-xs tabular-nums">
                {formatBytes(used)} / {formatBytes(limit)}（{percent}%）
              </p>
            </div>
          );
        }
      },
      {
        id: 'onlineDevices',
        header: t('admin:users.onlineDevices'),
        cell: ({ row }) => {
          const user = row.original;
          const count = user.onlineDeviceCount ?? 0;
          const limit = user.effectiveDeviceLimit;
          const isOverLimit = limit !== null && limit !== undefined && count > limit;
          const sourceKey = user.deviceLimitSource === 'USER'
            ? 'common:deviceManagement.sourceUser'
            : user.deviceLimitSource === 'PLAN'
              ? 'common:deviceManagement.sourcePlan'
              : user.deviceLimitSource === 'GLOBAL_OFF'
                ? 'common:deviceManagement.sourceGlobalOff'
                : 'common:deviceManagement.sourceUnlimited';
          return (
            <div className="flex min-w-36 flex-col items-start gap-1">
              <Button type="button" size="sm" variant={isOverLimit ? 'destructive' : 'outline'} className="h-7 gap-1.5 px-2" onClick={() => setDevicesUser(user)}>
                <Smartphone className="size-3.5" />
                <span className="tabular-nums">{count} / {limit ?? t('common:deviceManagement.unlimited')}</span>
              </Button>
              {(user.deviceLimitSource !== 'UNLIMITED' || isOverLimit) && (
                <div className="flex flex-wrap items-center gap-1">
                  {user.deviceLimitSource !== 'UNLIMITED' && <Badge variant="outline" className="px-1.5 py-0 text-[10px]">{t(sourceKey)}</Badge>}
                  {isOverLimit && <Badge variant="destructive" className="px-1.5 py-0 text-[10px]">{t('common:deviceManagement.overLimit')}</Badge>}
                </div>
              )}
            </div>
          );
        }
      },
      {
        accessorKey: 'expireAt',
        header: t('admin:users.expireAt'),
        cell: ({ row }) =>
          row.original.expireAt ? (
            <span className="tabular-nums">{formatDate(row.original.expireAt)}</span>
          ) : (
            <span className="text-muted-foreground">{t('common:time.permanent')}</span>
          )
      },
      {
        accessorKey: 'isActive',
        header: t('admin:users.status'),
        cell: ({ row }) => <StatusBadge isActive={row.original.isActive} />
      },
      {
        accessorKey: 'createdAt',
        header: t('common:table.createdAt'),
        cell: ({ row }) => (
          <span className="text-muted-foreground tabular-nums">
            {formatDate(row.original.createdAt)}
          </span>
        )
      },
      {
        id: 'actions',
        header: t('common:table.actions'),
        enableHiding: false,
        cell: ({ row }) => {
          const u = row.original;
          const isSelf = u.id === selfId;
          return (
            <div className="flex justify-end gap-1">
              <IconButton
                variant="ghost"
                size="icon-sm"
                aria-label={t('admin:users.trafficDetails')}
                onClick={() => setTrafficUser(u)}
              >
                <Activity className="size-4" />
              </IconButton>
              <IconButton
                variant="ghost"
                size="icon-sm"
                aria-label={t('admin:users.adjustBalance')}
                onClick={() => setAdjusting(u)}
              >
                <WalletCards className="size-4" />
              </IconButton>
              <IconButton
                variant="ghost"
                size="icon-sm"
                aria-label={t('admin:users.editUser')}
                onClick={() => { setEditing(u); setFormOpen(true); }}
              >
                <Pencil className="size-4" />
              </IconButton>
              <IconButton
                variant="ghost"
                size="icon-sm"
                aria-label={t('admin:users.resetToken')}
                tooltip={u.subscription ? t('admin:users.resetToken') : t('admin:users.noSubscription')}
                disabled={!u.subscription || resetSubscriptionToken.isPending}
                onClick={() => setResetting(u)}
              >
                <RefreshCw className="size-4" />
              </IconButton>
              {!isSelf ? (
                <>
                  <IconButton
                    variant="ghost"
                    size="icon-sm"
                    aria-label={u.isActive ? t('admin:users.banUser') : t('admin:users.unbanUser')}
                    disabled={bulkActive.isPending}
                    onClick={() => bulkActive.mutate({ ids: [u.id], isActive: !u.isActive })}
                  >
                    {u.isActive ? <ShieldOff className="size-4" /> : <ShieldCheck className="size-4" />}
                  </IconButton>
                  <IconButton
                    variant="ghost"
                    size="icon-sm"
                    aria-label={t('common:actions.delete')}
                    onClick={() => setDeleting(u)}
                  >
                    <Trash2 className="size-4 text-destructive" />
                  </IconButton>
                </>
              ) : null}
            </div>
          );
        }
      }
    ],
    [bulkActive, resetSubscriptionToken, selfId, t]
  );

  const clearSelection = () => {
    setRowSelection({});
    setSelected([]);
  };

  const onBulkBan = async (isActive: boolean) => {
    const ids = selected.filter((u) => u.id !== selfId).map((u) => u.id);
    if (ids.length === 0) {
      toast.warning(t('admin:users.noOperableUsers'));
      return;
    }
    bulkActive.mutate({ ids, isActive }, { onSuccess: clearSelection });
  };

  const onConfirmDelete = () => {
    if (!deleting) return;
    deleteUser.mutate(deleting.id, {
      onSuccess: () => setDeleting(null),
      onError: () => setDeleting(null)
    });
  };

  return (
    <PageContainer>
      <PageHeader title={t('admin:users.title')} description={t('admin:users.subtitle')} />

      {isPending ? (
        <div className="flex flex-col gap-4 md:gap-6">
          <div className="flex flex-wrap items-center gap-2">
            <Skeleton className="h-9 w-64" />
            <Skeleton className="h-9 w-28" />
            <Skeleton className="h-9 w-28" />
            <Skeleton className="h-9 w-32" />
          </div>
          <Card>
            <CardContent className="min-w-0 p-0">
              <div className="space-y-3 p-4">
                <Skeleton className="h-8 w-full" />
                <Skeleton className="h-12 w-full" />
                <Skeleton className="h-12 w-full" />
                <Skeleton className="h-12 w-full" />
              </div>
            </CardContent>
          </Card>
        </div>
      ) : (
        <DataTable
          columns={columns}
          data={users}
          total={data?.total}
          rowSelection={rowSelection}
          onRowSelectionChange={setRowSelection}
          onSelectionChange={setSelected}
          tableClassName="min-w-[1160px]"
          emptyTitle={t('admin:users.emptyUsers')}
          emptyDescription={t('admin:users.subtitle')}
          toolbar={
            <>
              <div className="relative w-full sm:w-64">
                <Search className="pointer-events-none absolute left-3 top-2.5 size-4 text-muted-foreground" />
                <Input
                  type="search"
                  className="pl-9"
                  placeholder={t('admin:users.searchPlaceholder')}
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                />
              </div>
              <Select value={roleFilter} onValueChange={(value) => setRoleFilter(value as typeof roleFilter)}>
                <SelectTrigger className="w-full sm:w-[120px]"><SelectValue placeholder={t('admin:users.filterRole')} /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="ALL">{t('admin:users.allRoles')}</SelectItem>
                  <SelectItem value="USER">{t('admin:users.roleUser')}</SelectItem>
                  <SelectItem value="ADMIN">{t('admin:users.roleAdmin')}</SelectItem>
                </SelectContent>
              </Select>
              <Select value={activeFilter} onValueChange={(value) => setActiveFilter(value as typeof activeFilter)}>
                <SelectTrigger className="w-full sm:w-[120px]"><SelectValue placeholder={t('admin:users.filterStatus')} /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="ALL">{t('admin:users.allStatuses')}</SelectItem>
                  <SelectItem value="true">{t('admin:users.statusActive')}</SelectItem>
                  <SelectItem value="false">{t('admin:users.statusDisabled')}</SelectItem>
                </SelectContent>
              </Select>
              <Select value={emailVerifiedFilter} onValueChange={(value) => setEmailVerifiedFilter(value as typeof emailVerifiedFilter)}>
                <SelectTrigger className="w-full sm:w-[120px]"><SelectValue placeholder={t('admin:users.filterVerified')} /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="ALL">{t('admin:users.allVerified')}</SelectItem>
                  <SelectItem value="true">{t('admin:users.verified')}</SelectItem>
                  <SelectItem value="false">{t('admin:users.unverified')}</SelectItem>
                </SelectContent>
              </Select>
              <Select value={subscriptionFilter} onValueChange={(value) => setSubscriptionFilter(value as typeof subscriptionFilter)}>
                <SelectTrigger className="w-full sm:w-[130px]"><SelectValue placeholder={t('admin:users.filterSubscription')} /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="ALL">{t('admin:users.allSubscriptions')}</SelectItem>
                  <SelectItem value="ACTIVE">{t('admin:users.statusActive')}</SelectItem>
                  <SelectItem value="CANCELED">{t('common:status.canceled')}</SelectItem>
                  <SelectItem value="EXPIRED">{t('common:status.expired')}</SelectItem>
                  <SelectItem value="REVOKED">{t('common:status.revoked')}</SelectItem>
                  <SelectItem value="NONE">{t('admin:users.noSubscription')}</SelectItem>
                </SelectContent>
              </Select>
              <Select value={planFilter} onValueChange={setPlanFilter}>
                <SelectTrigger className="w-full sm:w-[140px]"><SelectValue placeholder={t('admin:users.filterPlan')} /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="ALL">{t('admin:users.allPlans')}</SelectItem>
                  <SelectItem value="NONE">{t('admin:users.unbound')}</SelectItem>
                  {(plans ?? []).map((plan) => <SelectItem key={plan.id} value={plan.id}>{plan.name}</SelectItem>)}
                </SelectContent>
              </Select>
            </>
          }
          actions={
            <Button size="sm" className="w-full gap-1.5 sm:w-auto" onClick={() => { setEditing(null); setFormOpen(true); }}>
              <Plus className="size-4" />
              {t('admin:users.addUser')}
            </Button>
          }
          banner={
            selected.length > 0 ? (
              <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm">
                <span>{t('admin:users.selectedCount', { count: selected.length })}</span>
                <div className="flex items-center gap-2">
                  <Button size="sm" variant="outline" className="gap-1.5" disabled={bulkActive.isPending} onClick={() => void onBulkBan(false)}>
                    <ShieldOff className="size-4" />
                    {t('admin:users.batchBan')}
                  </Button>
                  <Button size="sm" variant="outline" className="gap-1.5" disabled={bulkActive.isPending} onClick={() => void onBulkBan(true)}>
                    <ShieldCheck className="size-4" />
                    {t('admin:users.batchActivate')}
                  </Button>
                  <Button size="sm" variant="destructive" className="gap-1.5" onClick={() => setBulkDeleting(true)}>
                    <Trash2 className="size-4" />
                    {t('admin:users.batchDelete')}
                  </Button>
                  <Button size="sm" variant="ghost" onClick={clearSelection}>
                    {t('common:actions.cancel')}
                  </Button>
                </div>
              </div>
            ) : null
          }
        />
      )}

      <UserFormDialog open={formOpen} onOpenChange={setFormOpen} user={editing} selfId={selfId ?? ''} plans={plans ?? []} lineOptions={lineData?.data ?? []} />
      <UserTrafficDialog user={trafficUser} open={!!trafficUser} onOpenChange={(open) => !open && setTrafficUser(null)} />
      <DeviceManagementDialog
        audience="admin"
        open={!!devicesUser}
        onOpenChange={(open) => !open && setDevicesUser(null)}
        title={t('common:deviceManagement.title') + (devicesUser ? ` · ${devicesUser.email}` : '')}
        data={deviceManagement.data}
        isLoading={deviceManagement.isLoading}
        isError={deviceManagement.isError}
        onKickDevice={(ip) => deviceManagement.kickDevice.mutate(ip)}
        onKickAllDevices={() => deviceManagement.kickAllDevices.mutate()}
        isKickingDevice={deviceManagement.kickDevice.isPending}
        isKickingAll={deviceManagement.kickAllDevices.isPending}
      />
      <BalanceFormDialog user={adjusting} open={!!adjusting} onOpenChange={(open) => !open && setAdjusting(null)} />

      <AlertDialog open={!!deleting} onOpenChange={(open) => !open && setDeleting(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('admin:users.deleteConfirm', { email: deleting?.email ?? '' })}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('admin:users.deleteConfirmDesc')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common:actions.cancel')}</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={() => void onConfirmDelete()}>
              {t('common:actions.delete')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={!!resetting} onOpenChange={(open) => !open && setResetting(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('admin:users.resetToken')}?</AlertDialogTitle>
            <AlertDialogDescription>{t('admin:users.resetTokenDesc', { email: resetting?.email ?? '' })}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common:actions.cancel')}</AlertDialogCancel>
            <AlertDialogAction onClick={() => { if (resetting) resetSubscriptionToken.mutate(resetting.id, { onSuccess: () => setResetting(null) }); }}>
              {t('common:actions.confirm')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={bulkDeleting} onOpenChange={setBulkDeleting}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('admin:users.batchDeleteTitle', { count: selected.length })}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('admin:users.batchDeleteDesc', { count: selected.length })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common:actions.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={async () => {
                const ids = selected.filter((u) => u.id !== selfId).map((u) => u.id);
                const results = await Promise.allSettled(ids.map((id) => api.delete(`/admin/users/${id}`)));
                const failed = results.filter((r) => r.status === 'rejected').length;
                if (failed === 0) toast.success(t('admin:users.deleteBatchSuccess', { count: ids.length }));
                else toast.warning(t('admin:users.deleteBatchPartial', { success: ids.length - failed, failed }));
                clearSelection();
                setBulkDeleting(false);
              }}
            >
              {t('common:actions.delete')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </PageContainer>
  );
}
