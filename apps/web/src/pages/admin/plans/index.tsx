import { useState, useMemo } from 'react';
import { PackagePlus, Pencil, Search, Sparkles, Trash2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { PageContainer, PageHeader } from '@/components/shared/page-container';
import { EmptyState } from '@/components/shared/empty-state';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow
} from '@/components/ui/table';
import { IconButton } from '@/components/ui/icon-button';
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
import { PlanFormDialog } from './components/plan-form-dialog';
import { useAdminPlans, usePlanMutations, type Plan } from './use-plans';
import { useAdminTemplates } from '../templates/use-templates';
import { useLineOptions } from '../lines/use-lines';
import { formatBytes, formatYuan } from '@/lib/utils';

export default function PlansPage() {
  const { t } = useTranslation(['admin', 'common']);
  const { data, isPending, isError } = useAdminPlans();
  const { data: templates } = useAdminTemplates();
  const { data: lineData } = useLineOptions();
  const { remove } = usePlanMutations();

  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<'ALL' | 'PUBLIC' | 'UNLISTED'>('ALL');
  const [editing, setEditing] = useState<Plan | null>(null);
  const [deleting, setDeleting] = useState<Plan | null>(null);
  const [open, setOpen] = useState(false);

  const filteredPlans = useMemo(() => {
    if (!data) return [];
    const keyword = search.trim().toLowerCase();
    return data.filter((plan) => {
      if (statusFilter === 'PUBLIC' && !plan.isPublic) return false;
      if (statusFilter === 'UNLISTED' && plan.isPublic) return false;
      if (!keyword) return true;
      return (
        plan.name.toLowerCase().includes(keyword) ||
        (plan.description && plan.description.toLowerCase().includes(keyword)) ||
        (plan.badgeText && plan.badgeText.toLowerCase().includes(keyword)) ||
        plan.lineTags.some((tag) => tag.toLowerCase().includes(keyword))
      );
    });
  }, [data, search, statusFilter]);

  if (isPending) {
    return (
      <PageContainer>
        <PageHeader title={t('admin:plans.title')} description={t('admin:plans.subtitle')} />
        <Skeleton className="h-10 w-full max-w-sm" />
        <Card>
          <CardContent className="p-4 space-y-3">
            <Skeleton className="h-8 w-full" />
            <Skeleton className="h-12 w-full" />
            <Skeleton className="h-12 w-full" />
          </CardContent>
        </Card>
      </PageContainer>
    );
  }

  if (isError) {
    return (
      <PageContainer>
        <PageHeader title={t('admin:plans.title')} description={t('admin:plans.subtitle')} />
        <EmptyState title={t('common:status.error')} description={t('admin:nodes.emptyFilteredDesc')} />
      </PageContainer>
    );
  }

  return (
    <PageContainer>
      <PageHeader title={t('admin:plans.title')} description={t('admin:plans.subtitle')} />

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-1 flex-col gap-2 sm:flex-row sm:items-center">
          <div className="relative w-full sm:w-72">
            <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input
              type="search"
              placeholder={t('admin:plans.searchPlaceholder')}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="pl-8"
            />
          </div>
          <Select
            value={statusFilter}
            onValueChange={(val) => setStatusFilter(val as 'ALL' | 'PUBLIC' | 'UNLISTED')}
          >
            <SelectTrigger className="w-full sm:w-32">
              <SelectValue placeholder={t('admin:plans.filterStatus')} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="ALL">{t('admin:plans.statusAll')}</SelectItem>
              <SelectItem value="PUBLIC">{t('admin:plans.statusPublic')}</SelectItem>
              <SelectItem value="UNLISTED">{t('admin:plans.statusUnlisted')}</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <Button
          className="w-full sm:w-auto"
          onClick={() => {
            setEditing(null);
            setOpen(true);
          }}
        >
          <PackagePlus className="h-4 w-4 mr-1.5" />
          {t('admin:plans.addPlan')}
        </Button>
      </div>

      <Card>
        <CardContent className="min-w-0 p-0">
          {filteredPlans.length ? (
            <Table className="min-w-[960px]">
              <TableHeader>
                <TableRow>
                  <TableHead className="w-[28%]">{t('admin:plans.colPlan')}</TableHead>
                  <TableHead>{t('admin:plans.colPriceDuration')}</TableHead>
                  <TableHead>{t('admin:plans.colTrafficLimit')}</TableHead>
                  <TableHead>{t('admin:plans.colDeviceLimit')}</TableHead>
                  <TableHead>{t('admin:plans.colLinesTemplate')}</TableHead>
                  <TableHead>{t('admin:plans.status')}</TableHead>
                  <TableHead className="text-right">{t('common:table.actions')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filteredPlans.map((plan) => (
                  <TableRow key={plan.id}>
                    <TableCell>
                      <div className="space-y-1">
                        <div className="flex items-center gap-1.5 flex-wrap">
                          <span className="font-medium text-foreground">{plan.name}</span>
                          {plan.isFeatured && (
                            <Badge
                              variant="default"
                              className="text-[11px] h-5 bg-amber-500/15 text-amber-600 dark:text-amber-400 border-amber-500/30 gap-0.5 hover:bg-amber-500/20"
                            >
                              <Sparkles className="h-3 w-3" />
                              {t('admin:plans.featured')}
                            </Badge>
                          )}
                          {plan.badgeText && (
                            <Badge variant="secondary" className="text-[11px] h-5 font-semibold">
                              {plan.badgeText}
                            </Badge>
                          )}
                          <span className="text-xs text-muted-foreground tabular-nums">#{plan.sortOrder}</span>
                        </div>
                        <p className="text-xs text-muted-foreground line-clamp-1">
                          {plan.description || t('admin:templates.noDesc')}
                        </p>
                      </div>
                    </TableCell>
                    <TableCell>
                      <div className="space-y-0.5">
                        <span className="font-semibold text-foreground">
                          {plan.price === 0 ? t('common:pricing.free') : formatYuan(plan.price)}
                        </span>
                        <span className="text-xs text-muted-foreground"> / {t('common:time.days', { count: plan.durationDays })}</span>
                      </div>
                    </TableCell>
                    <TableCell>
                      <div className="space-y-0.5 text-xs">
                        <div className="font-medium tabular-nums text-foreground">
                          {formatBytes(plan.trafficLimitBytes)}
                        </div>
                        <div className="text-muted-foreground">
                          {plan.trafficResetMode === 'CALENDAR_MONTH'
                            ? t('common:resetMode.CALENDAR_MONTH')
                            : plan.trafficResetMode === 'SUBSCRIPTION_CYCLE'
                              ? t('common:resetMode.SUBSCRIPTION_CYCLE')
                              : t('common:resetMode.NONE')}
                        </div>
                      </div>
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline">{plan.deviceLimit && plan.deviceLimit > 0 ? t('admin:plans.deviceLimitValue', { count: plan.deviceLimit }) : t('admin:plans.unlimitedDevices')}</Badge>
                    </TableCell>
                    <TableCell>
                      <div className="space-y-1 text-xs">
                        <div className="flex items-center gap-1 flex-wrap">
                          <Badge variant="outline" className="text-[11px]">
                            {plan.lineMatchMode === 'TAGS'
                              ? t('common:matchMode.TAGS')
                              : plan.lineMatchMode === 'EXPLICIT'
                                ? t('common:matchMode.EXPLICIT')
                                : t('common:matchMode.ALL')}
                          </Badge>
                          {plan.lineMatchMode === 'TAGS' && plan.lineTags.length > 0 && (
                            <span className="text-muted-foreground">
                              #{plan.lineTags.slice(0, 2).join(' #')}
                              {plan.lineTags.length > 2 && ` +${plan.lineTags.length - 2}`}
                            </span>
                          )}
                          {plan.lineMatchMode === 'EXPLICIT' && (
                            <span className="text-muted-foreground">
                              {t('admin:plans.linesCountValue', { count: plan.lineIds.length })}
                            </span>
                          )}
                        </div>
                      </div>
                    </TableCell>
                    <TableCell>
                      {plan.template ? (
                        <Badge variant="outline" className="text-xs">
                          {plan.template.name}
                        </Badge>
                      ) : (
                        <span className="text-xs text-muted-foreground">{t('admin:templates.dnsDefault')}</span>
                      )}
                    </TableCell>
                    <TableCell>
                      {plan.isPublic ? (
                        <Badge
                          variant="outline"
                          className="text-xs border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
                        >
                          {t('admin:plans.statusActive')}
                        </Badge>
                      ) : (
                        <Badge variant="secondary" className="text-xs">
                          {t('admin:plans.statusDisabled')}
                        </Badge>
                      )}
                    </TableCell>
                    <TableCell>
                      <div className="flex justify-end items-center gap-1">
                        <IconButton
                          variant="ghost"
                          size="icon-sm"
                          aria-label={t('admin:plans.editPlan')}
                          onClick={() => {
                            setEditing(plan);
                            setOpen(true);
                          }}
                        >
                          <Pencil className="size-4" />
                        </IconButton>
                        <IconButton
                          variant="ghost"
                          size="icon-sm"
                          aria-label={t('common:actions.delete')}
                          onClick={() => setDeleting(plan)}
                        >
                          <Trash2 className="size-4" />
                        </IconButton>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          ) : (
            <EmptyState
              title={search || statusFilter !== 'ALL' ? t('admin:nodes.emptyFiltered') : t('admin:plans.emptyPlans')}
              description={
                search || statusFilter !== 'ALL'
                  ? t('admin:nodes.emptyFilteredDesc')
                  : t('admin:plans.subtitle')
              }
              className="border-0"
            />
          )}
        </CardContent>
      </Card>

      <PlanFormDialog
        open={open}
        onOpenChange={setOpen}
        plan={editing}
        lineOptions={lineData?.data ?? []}
        templateOptions={(templates ?? []).map((template) => ({
          id: template.id,
          name: template.name
        }))}
      />

      <AlertDialog open={!!deleting} onOpenChange={(isOpen) => !isOpen && setDeleting(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('admin:plans.deleteDialogTitle', { name: deleting?.name ?? '' })}</AlertDialogTitle>
            <AlertDialogDescription>{t('admin:plans.deleteDialogDesc')}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common:actions.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                if (deleting) {
                  remove.mutate(deleting.id, {
                    onSuccess: () => setDeleting(null)
                  });
                }
              }}
            >
              {t('common:actions.confirm')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </PageContainer>
  );
}
