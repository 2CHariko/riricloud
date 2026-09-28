import { useEffect, useState } from 'react';
import { Archive, Download, Eraser, Eye, EyeOff, Plus, Search, Tags, Trash2, Undo2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { PageContainer, PageHeader } from '@/components/shared/page-container';
import { EmptyState } from '@/components/shared/empty-state';
import { CopyButton } from '@/components/shared/copy-button';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { IconButton } from '@/components/ui/icon-button';
import { Card, CardContent } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog';
import { Pagination, PaginationInfo, PaginationNext, PaginationPrevious } from '@/components/ui/pagination';
import { Skeleton } from '@/components/ui/skeleton';
import { ResponsiveDialog, ResponsiveDialogContent } from '@/components/shared/responsive-dialog';
import { formatCurrency, formatDate, formatDateTime } from '@/lib/utils';
import { GenerateDialog } from './components/generate-dialog';
import { RedeemStatsCards } from './components/stats-cards';
import { CategoryManagementDialog } from './components/category-management-dialog';
import { useAdminPlans } from '../plans/use-plans';
import { maskRedeemCode, useRedeemCodeCategories, useRedeemCodeMutations, useRedeemCodeStats, useRedeemCodes, type AdminRedeemCode, type RedeemCodeStatus } from './use-redeem-codes';

const PAGE_SIZE = 20;
export default function RedeemCodesPage() {
  const { t } = useTranslation(['admin', 'common']);
  const [status, setStatus] = useState<RedeemCodeStatus | 'ALL'>('ALL');
  const [categoryId, setCategoryId] = useState('ALL');
  const [deletedOnly, setDeletedOnly] = useState(false);
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [page, setPage] = useState(1);
  const [revealed, setRevealed] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [generateOpen, setGenerateOpen] = useState(false);
  const [categoriesOpen, setCategoriesOpen] = useState(false);
  const [revokeTarget, setRevokeTarget] = useState<AdminRedeemCode | null>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [batchRevokeOpen, setBatchRevokeOpen] = useState(false);
  const [cleanupOpen, setCleanupOpen] = useState(false);
  const [generatedCodes, setGeneratedCodes] = useState<string[]>([]);
  const categories = useRedeemCodeCategories();
  const plans = useAdminPlans();
  const labels: Record<RedeemCodeStatus, string> = {
    UNUSED: t('admin:redeemCodes.statusUnused'), REDEEMED: t('admin:redeemCodes.statusRedeemed'),
    REVOKED: t('admin:redeemCodes.statusRevoked'), EXPIRED: t('admin:redeemCodes.statusExpired')
  };
  useEffect(() => { const timer = setTimeout(() => setDebouncedSearch(search.trim()), 400); return () => clearTimeout(timer); }, [search]);
  useEffect(() => { setPage(1); setSelectedIds(new Set()); }, [status, categoryId, deletedOnly, debouncedSearch]);
  const activeCategoryId = categoryId === 'ALL' ? undefined : categoryId;
  const query = useRedeemCodes({ page, pageSize: PAGE_SIZE, status, search: debouncedSearch, categoryId: activeCategoryId, deletedOnly });
  const stats = useRedeemCodeStats({ categoryId: activeCategoryId, deletedOnly });
  const mutations = useRedeemCodeMutations({ status: status === 'ALL' ? undefined : status, search: debouncedSearch || undefined, categoryId: activeCategoryId, deletedOnly });
  const rows = query.data?.data ?? [];
  const total = query.data?.total ?? 0;
  const totalPages = Math.max(Math.ceil(total / PAGE_SIZE), 1);
  const selectableRows = rows.filter((row) => !row.deletedAt);
  const allPageSelected = selectableRows.length > 0 && selectableRows.every((row) => selectedIds.has(row.id));
  const codesText = generatedCodes.join('\n');
  const toggleRow = (row: AdminRedeemCode) => setSelectedIds((prev) => { const next = new Set(prev); if (next.has(row.id)) next.delete(row.id); else next.add(row.id); return next; });
  const toggleAllPage = () => setSelectedIds((prev) => { const next = new Set(prev); if (allPageSelected) selectableRows.forEach((row) => next.delete(row.id)); else selectableRows.forEach((row) => next.add(row.id)); return next; });
  const formatReward = (item: AdminRedeemCode) => item.reward.type === 'BALANCE' ? formatCurrency(item.reward.amount) : item.reward.planSnapshot.name;

  return (
    <PageContainer>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <PageHeader title={t('admin:redeemCodes.title')} description={t('admin:redeemCodes.subtitle')} />
        <div className="flex flex-wrap gap-2">
          <Button type="button" variant="outline" onClick={() => setCategoriesOpen(true)}>
            <Tags className="size-4" />{t('admin:redeemCodes.manageCategories')}
          </Button>
          <Button className="w-full sm:w-auto" onClick={() => setGenerateOpen(true)} disabled={!categories.data?.some((item) => item.isActive)}>
            <Plus />{t('admin:redeemCodes.generate')}
          </Button>
        </div>
      </div>

      <RedeemStatsCards stats={stats.data} isLoading={stats.isLoading} />

      {/* 搜索与筛选工具栏 */}
      <div className="flex min-w-0 flex-col gap-2 lg:flex-row lg:items-center lg:justify-between">
        <div className="flex flex-1 flex-wrap items-center gap-2">
          <div className="relative w-full min-w-0 flex-1 sm:min-w-52 sm:max-w-xs">
            <Search className="pointer-events-none absolute left-3 top-2.5 size-4 text-muted-foreground" />
            <Input
              type="search"
              className="pl-9"
              placeholder={t('admin:redeemCodes.searchPlaceholder')}
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
          </div>
          <Select value={categoryId} onValueChange={setCategoryId}>
            <SelectTrigger className="w-full sm:w-44">
              <SelectValue placeholder={t('admin:redeemCodes.category')} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="ALL">{t('admin:redeemCodes.allCategories')}</SelectItem>
              {categories.data?.map((item) => <SelectItem key={item.id} value={item.id}>{item.name}</SelectItem>)}
            </SelectContent>
          </Select>
          <Select value={status} onValueChange={(value) => setStatus(value as typeof status)}>
            <SelectTrigger className="w-full sm:w-36">
              <SelectValue placeholder={t('admin:redeemCodes.filterStatus')} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="ALL">{t('admin:redeemCodes.statusAll')}</SelectItem>
              {Object.entries(labels).map(([value, label]) => <SelectItem key={value} value={value}>{label}</SelectItem>)}
            </SelectContent>
          </Select>
          <Select value={deletedOnly ? 'DELETED' : 'ACTIVE'} onValueChange={(value) => setDeletedOnly(value === 'DELETED')}>
            <SelectTrigger className="w-full sm:w-36">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="ACTIVE">{t('admin:redeemCodes.activeCodes')}</SelectItem>
              <SelectItem value="DELETED">{t('admin:redeemCodes.deletedCodes')}</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {!deletedOnly && (
            <IconButton
              type="button"
              variant="outline"
              size="icon-sm"
              aria-label={revealed ? t('admin:redeemCodes.hidePlaintext') : t('admin:redeemCodes.showPlaintext')}
              onClick={() => setRevealed((value) => !value)}
            >
              {revealed ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
            </IconButton>
          )}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button type="button" variant="outline" disabled={mutations.exportCodes.isPending}>
                <Download className="size-4" />
                {t('admin:redeemCodes.export')}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={() => mutations.exportCodes.mutate('csv')}>{t('admin:redeemCodes.exportCsv')}</DropdownMenuItem>
              <DropdownMenuItem onClick={() => mutations.exportCodes.mutate('txt')}>{t('admin:redeemCodes.exportTxt')}</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          {!deletedOnly && (
            <Button type="button" variant="outline" onClick={() => setCleanupOpen(true)}>
              <Eraser className="size-4" />
              {t('admin:redeemCodes.cleanupExpired')}
            </Button>
          )}
        </div>
      </div>

      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <Archive className="size-3.5" />
        <span>{t(deletedOnly ? 'admin:redeemCodes.deletedInfo' : 'admin:redeemCodes.infoBanner')}</span>
      </div>

      {selectedIds.size > 0 && (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm">
          <span>{t('admin:redeemCodes.selectedCount', { count: selectedIds.size })}</span>
          <div className="flex items-center gap-2">
            <Button type="button" size="sm" variant="outline" onClick={() => setDeleteOpen(true)}>
              <Trash2 className="size-4" />
              {t('admin:redeemCodes.deleteAction')}
            </Button>
            <Button type="button" size="sm" variant="destructive" onClick={() => setBatchRevokeOpen(true)}>
              {t('admin:redeemCodes.batchRevoke')}
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={() => setSelectedIds(new Set())}>
              {t('common:actions.cancel')}
            </Button>
          </div>
        </div>
      )}

      {/* 表格容器 */}
      <Card>
        <CardContent className="min-w-0 p-0">
          {query.isPending ? (
            <div className="space-y-3 p-4">
              <Skeleton className="h-8 w-full" />
              <Skeleton className="h-12 w-full" />
              <Skeleton className="h-12 w-full" />
            </div>
          ) : rows.length === 0 ? (
            <EmptyState
              title={t('admin:redeemCodes.emptyCodes')}
              description={t('admin:redeemCodes.subtitle')}
              className="border-0"
            />
          ) : (
            <Table className="min-w-[1000px]">
              <TableHeader>
                <TableRow>
                  <TableHead className="w-10">
                    <Checkbox checked={allPageSelected} onCheckedChange={toggleAllPage} aria-label={t('common:table.selectAll')} disabled={deletedOnly || selectableRows.length === 0} />
                  </TableHead>
                  <TableHead>{t('admin:redeemCodes.colCode')}</TableHead>
                  <TableHead>{t('admin:redeemCodes.category')}</TableHead>
                  <TableHead>{t('admin:redeemCodes.colValue')}</TableHead>
                  <TableHead>{t('admin:redeemCodes.colStatus')}</TableHead>
                  <TableHead>{t('admin:redeemCodes.colValidity')}</TableHead>
                  <TableHead>{t('admin:redeemCodes.usedBy')}</TableHead>
                  <TableHead>{t('admin:redeemCodes.usedAt')}</TableHead>
                  <TableHead>{t('admin:redeemCodes.colNote')}</TableHead>
                  <TableHead>{t('common:table.createdAt')}</TableHead>
                  <TableHead className="text-right">{t('common:table.actions')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((item) => (
                  <TableRow key={item.id} data-state={selectedIds.has(item.id) ? 'selected' : undefined}>
                    <TableCell>{!item.deletedAt && <Checkbox checked={selectedIds.has(item.id)} onCheckedChange={() => toggleRow(item)} aria-label={t('admin:redeemCodes.selectCardAria', { id: item.id })} />}</TableCell>
                    <TableCell><div className="flex items-center gap-1.5"><code className="whitespace-nowrap text-xs">{revealed ? item.code : maskRedeemCode(item.code)}</code>{revealed && <CopyButton value={item.code} className="h-6 px-2 text-xs" />}</div></TableCell>
                    <TableCell>{item.category?.name ?? '—'}</TableCell>
                    <TableCell className="tabular-nums">{formatReward(item)}</TableCell>
                    <TableCell><Badge variant={item.deletedAt ? 'outline' : item.status === 'REDEEMED' ? 'secondary' : item.status === 'UNUSED' ? 'default' : 'destructive'}>{item.deletedAt ? t('admin:redeemCodes.deletedBadge') : labels[item.status]}</Badge></TableCell>
                    <TableCell className="whitespace-nowrap text-xs">{item.expiresAt ? formatDateTime(item.expiresAt) : t('common:time.permanent')}</TableCell>
                    <TableCell className="whitespace-nowrap text-xs">{item.redeemedBy ? item.redeemedBy.nickname || item.redeemedBy.email : '—'}</TableCell>
                    <TableCell className="whitespace-nowrap text-xs text-muted-foreground">{item.redeemedAt ? formatDateTime(item.redeemedAt) : '—'}</TableCell>
                    <TableCell>{item.note || '—'}</TableCell>
                    <TableCell className="whitespace-nowrap text-xs text-muted-foreground">{formatDate(item.createdAt)}</TableCell>
                    <TableCell className="text-right">{item.deletedAt ? <IconButton variant="ghost" size="icon-sm" aria-label={t('admin:redeemCodes.restore')} disabled={mutations.restore.isPending} onClick={() => mutations.restore.mutate(item.id)}><Undo2 className="size-4" /></IconButton> : <div className="flex justify-end">{item.status === 'UNUSED' && <IconButton variant="ghost" size="icon-sm" aria-label={t('admin:redeemCodes.revoke')} onClick={() => setRevokeTarget(item)}><Trash2 className="size-4 text-destructive" /></IconButton>}<IconButton variant="ghost" size="icon-sm" aria-label={t('admin:redeemCodes.deleteAction')} onClick={() => { setSelectedIds(new Set([item.id])); setDeleteOpen(true); }}><Archive className="size-4" /></IconButton></div>}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {rows.length > 0 && (
        <div className="flex items-center justify-between text-xs text-muted-foreground">
          <div>{t('admin:redeemCodes.totalRecords', { count: total })}</div>
          <Pagination>
            <PaginationPrevious onClick={() => setPage((value) => Math.max(value - 1, 1))} disabled={page <= 1} />
            <PaginationInfo page={page} totalPages={totalPages} />
            <PaginationNext onClick={() => setPage((value) => Math.min(value + 1, totalPages))} disabled={page >= totalPages} />
          </Pagination>
        </div>
      )}
    <GenerateDialog open={generateOpen} onOpenChange={setGenerateOpen} categories={categories.data?.filter((item) => item.isActive) ?? []} pending={mutations.batch.isPending} onSubmit={(payload) => mutations.batch.mutate(payload, { onSuccess: (data) => { setGeneratedCodes(data.codes); setGenerateOpen(false); } })} />
    <CategoryManagementDialog open={categoriesOpen} onOpenChange={setCategoriesOpen} categories={categories.data ?? []} plans={plans.data ?? []} pending={mutations.updateCategory.isPending || mutations.createCategory.isPending} onSave={async (payload, category) => { if (category) await mutations.updateCategory.mutateAsync({ ...payload, id: category.id }); else await mutations.createCategory.mutateAsync(payload); }} />
    <ResponsiveDialog open={generatedCodes.length > 0} onOpenChange={(value) => !value && setGeneratedCodes([])}><ResponsiveDialogContent><DialogHeader><DialogTitle>{t('admin:redeemCodes.generatedTitle')}</DialogTitle><DialogDescription>{t('admin:redeemCodes.generatedDesc', { count: generatedCodes.length })}</DialogDescription></DialogHeader><div className="max-h-[50vh] overflow-y-auto rounded-md border bg-muted/30 p-3"><pre className="whitespace-pre-wrap break-all font-mono text-xs leading-6">{codesText}</pre></div><DialogFooter><CopyButton value={codesText} className="w-full sm:w-auto" /><Button variant="outline" onClick={() => setGeneratedCodes([])}>{t('common:actions.close')}</Button></DialogFooter></ResponsiveDialogContent></ResponsiveDialog>
    <AlertDialog open={!!revokeTarget} onOpenChange={(value) => !value && setRevokeTarget(null)}><AlertDialogContent><AlertDialogHeader><AlertDialogTitle>{t('admin:redeemCodes.confirmRevoke')}</AlertDialogTitle><AlertDialogDescription>{t('admin:redeemCodes.revokeDesc', { code: revokeTarget?.code ?? '' })}</AlertDialogDescription></AlertDialogHeader><AlertDialogFooter><AlertDialogCancel>{t('common:actions.cancel')}</AlertDialogCancel><AlertDialogAction variant="destructive" onClick={() => { if (revokeTarget) mutations.revoke.mutate(revokeTarget.id, { onSuccess: () => { setRevokeTarget(null); setSelectedIds(new Set()); } }); }}>{t('common:actions.confirm')}</AlertDialogAction></AlertDialogFooter></AlertDialogContent></AlertDialog>
    <AlertDialog open={deleteOpen} onOpenChange={setDeleteOpen}><AlertDialogContent><AlertDialogHeader><AlertDialogTitle>{t('admin:redeemCodes.deleteTitle', { count: selectedIds.size })}</AlertDialogTitle><AlertDialogDescription>{t('admin:redeemCodes.deleteDesc')}</AlertDialogDescription></AlertDialogHeader><AlertDialogFooter><AlertDialogCancel>{t('common:actions.cancel')}</AlertDialogCancel><AlertDialogAction variant="destructive" disabled={mutations.batchDelete.isPending} onClick={() => mutations.batchDelete.mutate([...selectedIds], { onSuccess: () => { setDeleteOpen(false); setSelectedIds(new Set()); } })}>{t('admin:redeemCodes.deleteAction')}</AlertDialogAction></AlertDialogFooter></AlertDialogContent></AlertDialog>
    <AlertDialog open={batchRevokeOpen} onOpenChange={setBatchRevokeOpen}><AlertDialogContent><AlertDialogHeader><AlertDialogTitle>{t('admin:redeemCodes.batchRevokeTitle', { count: selectedIds.size })}</AlertDialogTitle><AlertDialogDescription>{t('admin:redeemCodes.batchRevokeDesc', { count: selectedIds.size })}</AlertDialogDescription></AlertDialogHeader><AlertDialogFooter><AlertDialogCancel>{t('common:actions.cancel')}</AlertDialogCancel><AlertDialogAction variant="destructive" disabled={mutations.batchRevoke.isPending} onClick={() => mutations.batchRevoke.mutate([...selectedIds], { onSuccess: () => { setBatchRevokeOpen(false); setSelectedIds(new Set()); } })}>{t('common:actions.confirm')}</AlertDialogAction></AlertDialogFooter></AlertDialogContent></AlertDialog>
    <AlertDialog open={cleanupOpen} onOpenChange={setCleanupOpen}><AlertDialogContent><AlertDialogHeader><AlertDialogTitle>{t('admin:redeemCodes.cleanupTitle')}</AlertDialogTitle><AlertDialogDescription>{t('admin:redeemCodes.cleanupDesc')}</AlertDialogDescription></AlertDialogHeader><AlertDialogFooter><AlertDialogCancel>{t('common:actions.cancel')}</AlertDialogCancel><AlertDialogAction variant="destructive" disabled={mutations.cleanup.isPending} onClick={() => mutations.cleanup.mutate(30, { onSuccess: () => setCleanupOpen(false) })}>{t('admin:redeemCodes.cleanupExpired')}</AlertDialogAction></AlertDialogFooter></AlertDialogContent></AlertDialog>
    </PageContainer>
  );
}
