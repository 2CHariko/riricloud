import * as React from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import {
  Plus,
  RefreshCw,
  Trash2,
  Pencil,
  Server,
  Activity,
  MoreHorizontal,
  Layers,
  CheckCircle2,
  AlertTriangle,
  HelpCircle,
  Clock,
  Radio,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { IconButton } from '@/components/ui/icon-button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { PageContainer, PageHeader } from '@/components/shared/page-container';
import { ServerPagination } from '@/components/shared/server-pagination';
import { EmptyState } from '@/components/shared/empty-state';
import { StatCard } from '@/components/shared/stat-card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { ApiUpstreamSubscription, ApiUpstreamNode } from '@/lib/api';
import { formatUpstreamBytes } from '@/lib/upstream-usage';
import { formatDateTime } from '@/lib/utils';
import { useAdminUpstreams, useAdminUpstreamMutations } from './use-upstream';
import { UpstreamFormDialog, UpstreamFormSubmitValues } from './components/upstream-form-dialog';
import { UpstreamNodesSheet } from './components/upstream-nodes-sheet';
import { ProbeTaskDialog } from '@/components/shared/probe-task-dialog';

export default function AdminUpstreamPage() {
  const { t } = useTranslation(['admin', 'common']);
  const navigate = useNavigate();
  const [search, setSearch] = React.useState('');
  const [status, setStatus] = React.useState('ALL');
  const [page, setPage] = React.useState(1);
  const [formOpen, setFormOpen] = React.useState(false);
  const [editing, setEditing] = React.useState<ApiUpstreamSubscription | null>(null);
  const [pool, setPool] = React.useState<ApiUpstreamSubscription | null>(null);
  const [deleting, setDeleting] = React.useState<ApiUpstreamSubscription | null>(null);
  const [probeAllOpen, setProbeAllOpen] = React.useState(false);

  const { data, isLoading, isError } = useAdminUpstreams({
    page,
    pageSize: 20,
    search: search.trim() || undefined,
    status: status === 'ALL' ? undefined : status,
  });

  const { createMutation, updateMutation, deleteMutation, syncMutation } = useAdminUpstreamMutations();

  const submit = (values: UpstreamFormSubmitValues) =>
    editing
      ? updateMutation.mutate({ id: editing.id, data: values }, { onSuccess: () => setFormOpen(false) })
      : createMutation.mutate(values, { onSuccess: () => setFormOpen(false) });

  const createLine = (node: ApiUpstreamNode, createExternal: boolean) => {
    setPool(null);
    navigate('/admin/lines', { state: { createUpstreamNode: node, createExternal } });
  };

  const unknown = t('common:status.unknown');

  // 统计指标派生计算
  const stats = React.useMemo(() => {
    const list = data?.data ?? [];
    const totalSubs = data?.total ?? 0;
    const totalNodes = list.reduce((sum, item) => sum + (item.nodeCount || 0), 0);
    const failedSubs = list.filter((item) => item.lastSyncStatus === 'FAILED').length;

    let usedBig = 0n;
    let totalBig = 0n;
    for (const item of list) {
      if (item.userInfoUsedBytes) {
        try {
          usedBig += BigInt(item.userInfoUsedBytes);
        } catch {
          // ignore parsing error
        }
      }
      if (item.userInfoTotalBytes) {
        try {
          totalBig += BigInt(item.userInfoTotalBytes);
        } catch {
          // ignore parsing error
        }
      }
    }

    const usageLabel = totalBig > 0n
      ? `${formatUpstreamBytes(usedBig.toString(), unknown)} / ${formatUpstreamBytes(totalBig.toString(), unknown)}`
      : formatUpstreamBytes(usedBig > 0n ? usedBig.toString() : null, unknown);

    return {
      totalSubs,
      totalNodes,
      failedSubs,
      usageLabel,
    };
  }, [data, unknown]);

  return (
    <PageContainer>
      <PageHeader
        title={t('admin:upstream.title')}
        description={t('admin:upstream.subtitle')}
      />

      {/* 顶部统计指标看板 */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatCard
          title={t('admin:upstream.statTotalSubs')}
          value={String(stats.totalSubs)}
          hint={t('admin:upstream.title')}
          icon={<Radio className="size-4" />}
        />
        <StatCard
          title={t('admin:upstream.statTotalNodes')}
          value={String(stats.totalNodes)}
          hint={t('admin:upstream.nodesTitle')}
          icon={<Server className="size-4" />}
        />
        <StatCard
          title={t('admin:upstream.statTotalUsage')}
          value={stats.usageLabel}
          hint={t('admin:upstream.trafficUsed')}
          icon={<Layers className="size-4" />}
        />
        <StatCard
          title={t('admin:upstream.syncStatus')}
          value={
            stats.failedSubs > 0
              ? t('admin:upstream.statSyncError', { count: stats.failedSubs })
              : t('admin:upstream.statHealthy')
          }
          hint={t('admin:upstream.lastSync')}
          icon={
            stats.failedSubs > 0 ? (
              <AlertTriangle className="size-4 text-destructive" />
            ) : (
              <CheckCircle2 className="size-4 text-emerald-500" />
            )
          }
        />
      </div>

      {/* 工具栏与过滤区 */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Input
          className="max-w-sm"
          placeholder={t('admin:upstream.searchPlaceholder')}
          value={search}
          onChange={(e) => {
            setSearch(e.target.value);
            setPage(1);
          }}
        />
        <div className="flex items-center gap-2">
          <Select
            value={status}
            onValueChange={(v) => {
              setStatus(v);
              setPage(1);
            }}
          >
            <SelectTrigger className="w-32">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {['ALL', 'ACTIVE', 'DISABLED'].map((v) => (
                <SelectItem key={v} value={v}>
                  {v === 'ALL'
                    ? t('admin:upstream.statusAll')
                    : v === 'ACTIVE'
                    ? t('admin:upstream.statusActive')
                    : t('admin:upstream.statusDisabled')}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button variant="outline" onClick={() => setProbeAllOpen(true)}>
            <Activity className="size-4" />
            {t('admin:latencyTest.batchTitle')}
          </Button>
          <Button
            onClick={() => {
              setEditing(null);
              setFormOpen(true);
            }}
          >
            <Plus className="size-4" />
            {t('admin:upstream.addSubscription')}
          </Button>
        </div>
      </div>

      {/* 主数据表格 */}
      <Card>
        <CardContent className="min-w-0 p-0">
          <Table className="min-w-[900px] table-fixed">
            <TableHeader>
              <TableRow>
                <TableHead className="w-1/4 min-w-56">{t('admin:upstream.colName')}</TableHead>
                <TableHead className="w-44 min-w-36">{t('admin:upstream.colType')}</TableHead>
                <TableHead className="w-32 min-w-28">{t('admin:upstream.colNodes')}</TableHead>
                <TableHead className="w-56 min-w-44">
                  <div className="flex items-center gap-1">
                    <span>{t('admin:upstream.colQuota')}</span>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <HelpCircle className="size-3.5 text-muted-foreground/70 cursor-help" />
                      </TooltipTrigger>
                      <TooltipContent className="max-w-xs text-xs">
                        <p>{t('admin:upstream.quotaTooltip')}</p>
                      </TooltipContent>
                    </Tooltip>
                  </div>
                </TableHead>
                <TableHead className="w-44 min-w-36">{t('admin:upstream.colLastSync')}</TableHead>
                <TableHead className="w-24">{t('admin:upstream.colStatus')}</TableHead>
                <TableHead className="w-28 text-right">{t('admin:upstream.colActions')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading || isError || !data?.data.length ? (
                <TableRow>
                  <TableCell colSpan={7} className="h-48 text-center">
                    {isLoading ? (
                      <p className="text-sm text-muted-foreground">{t('common:actions.loading')}</p>
                    ) : isError ? (
                      <p className="text-sm text-destructive">{t('common:status.failed')}</p>
                    ) : (
                      <EmptyState
                        title={t('admin:upstream.emptyTitle')}
                        description={t('admin:upstream.emptyDesc')}
                        className="border-0 p-6"
                      />
                    )}
                  </TableCell>
                </TableRow>
              ) : (
                data.data.map((sub) => {
                  // 计算配额进度
                  let percent: number | null = null;
                  if (sub.userInfoUsedBytes && sub.userInfoTotalBytes) {
                    try {
                      const u = BigInt(sub.userInfoUsedBytes);
                      const tot = BigInt(sub.userInfoTotalBytes);
                      if (tot > 0n) {
                        percent = Math.min(100, Math.max(0, Math.round(Number((u * 1000n) / tot) / 10)));
                      }
                    } catch {
                      // ignore parse error
                    }
                  }

                  // 刷新周期格式化
                  const intervalText = sub.autoUpdate
                    ? sub.updateIntervalMins % 60 === 0
                      ? t('admin:upstream.intervalHours', { hours: sub.updateIntervalMins / 60 })
                      : t('admin:upstream.intervalMinutesShort', { minutes: sub.updateIntervalMins })
                    : t('admin:upstream.manualSync');

                  const isSyncing = syncMutation.isPending && syncMutation.variables === sub.id;

                  return (
                    <TableRow key={sub.id}>
                      {/* 1. 订阅名称与脱敏地址 */}
                      <TableCell>
                        <div className="space-y-1">
                          <div className="flex items-center gap-1.5">
                            <span className="font-semibold text-sm truncate max-w-[180px]" title={sub.name}>
                              {sub.name}
                            </span>
                            <Badge variant="secondary" className="text-[10px] px-1 py-0 h-4 font-mono font-normal">
                              {sub.sourceType}
                            </Badge>
                          </div>
                          {sub.url ? (
                            <p className="truncate text-xs text-muted-foreground font-mono max-w-[220px]" title={sub.url}>
                              {t('admin:upstream.maskedUrl')}
                            </p>
                          ) : null}
                        </div>
                      </TableCell>

                      {/* 2. 解析格式与调度策略 */}
                      <TableCell>
                        <div className="space-y-0.5 text-xs">
                          <div className="flex items-center gap-1">
                            <Badge variant="outline" className="text-[11px] px-1.5 py-0 font-normal">
                              {sub.format === 'AUTO' && sub.detectedFormat
                                ? sub.detectedFormat
                                : sub.format}
                            </Badge>
                            {sub.format === 'AUTO' ? (
                              <span className="text-[10px] text-muted-foreground">AUTO</span>
                            ) : null}
                          </div>
                          <div className="flex items-center gap-1 text-[11px] text-muted-foreground">
                            <Clock className="size-3" />
                            <span>{intervalText}</span>
                          </div>
                        </div>
                      </TableCell>

                      {/* 3. 节点池微标按键 */}
                      <TableCell>
                        <Button
                          variant="outline"
                          size="sm"
                          className="h-7 gap-1.5 px-2.5 text-xs font-mono font-medium hover:bg-accent"
                          onClick={() => setPool(sub)}
                        >
                          <Server className="size-3.5 text-muted-foreground" />
                          <span>{t('admin:upstream.nodesCountBadge', { count: sub.nodeCount })}</span>
                        </Button>
                      </TableCell>

                      {/* 4. 流量配额可视化 */}
                      <TableCell>
                        <div className="space-y-1.5 text-xs">
                          <div className="flex items-center justify-between text-[11px]">
                            <span className="font-mono text-muted-foreground">
                              {formatUpstreamBytes(sub.userInfoUsedBytes, unknown)} /{' '}
                              {formatUpstreamBytes(sub.userInfoTotalBytes, unknown)}
                            </span>
                            {percent !== null ? (
                              <span className="font-mono font-medium">{percent}%</span>
                            ) : null}
                          </div>
                          {percent !== null ? (
                            <div className="h-1.5 w-full overflow-hidden rounded-full bg-secondary">
                              <div
                                className={`h-full rounded-full transition-all ${
                                  percent >= 95
                                    ? 'bg-destructive'
                                    : percent >= 80
                                    ? 'bg-amber-500'
                                    : 'bg-primary'
                                }`}
                                style={{ width: `${percent}%` }}
                              />
                            </div>
                          ) : null}
                          {sub.userInfoExpireAt ? (
                            <p className="text-[11px] text-muted-foreground">
                              {t('admin:upstream.expireTime')}: {formatDateTime(sub.userInfoExpireAt)}
                            </p>
                          ) : null}
                        </div>
                      </TableCell>

                      {/* 5. 上次同步状态与时间 */}
                      <TableCell>
                        <div className="space-y-1 text-xs">
                          <div>
                            {isSyncing ? (
                              <Badge
                                variant="outline"
                                className="text-primary bg-primary/10 border-primary/20 text-[11px] gap-1 px-1.5 py-0.5"
                              >
                                <RefreshCw className="size-3 animate-spin" />
                                {t('admin:upstream.syncing')}
                              </Badge>
                            ) : sub.lastSyncStatus === 'SUCCESS' ? (
                              <Badge
                                variant="outline"
                                className="text-emerald-600 dark:text-emerald-400 bg-emerald-500/10 border-emerald-500/20 text-[11px] gap-1 px-1.5 py-0.5"
                              >
                                <CheckCircle2 className="size-3" />
                                {t('admin:upstream.syncSuccessShort')}
                              </Badge>
                            ) : sub.lastSyncStatus === 'FAILED' ? (
                              <Tooltip>
                                <TooltipTrigger asChild>
                                  <Badge
                                    variant="outline"
                                    className="text-destructive bg-destructive/10 border-destructive/20 text-[11px] gap-1 px-1.5 py-0.5 cursor-pointer"
                                  >
                                    <AlertTriangle className="size-3" />
                                    {t('admin:upstream.syncFailedShort')}
                                  </Badge>
                                </TooltipTrigger>
                                {sub.lastSyncMessage ? (
                                  <TooltipContent className="max-w-xs text-xs">
                                    <p className="break-words">{sub.lastSyncMessage}</p>
                                  </TooltipContent>
                                ) : null}
                              </Tooltip>
                            ) : (
                              <Badge variant="outline" className="text-[11px] px-1.5 py-0.5 text-muted-foreground">
                                {t('admin:upstream.syncPendingShort')}
                              </Badge>
                            )}
                          </div>
                          <p className="text-[11px] text-muted-foreground">
                            {sub.lastSyncAt ? formatDateTime(sub.lastSyncAt) : t('admin:upstream.never')}
                          </p>
                        </div>
                      </TableCell>

                      {/* 6. 运行状态 */}
                      <TableCell>
                        <Badge variant={sub.status === 'ACTIVE' ? 'default' : 'secondary'} className="text-[11px]">
                          {sub.status === 'ACTIVE'
                            ? t('admin:upstream.statusActive')
                            : t('admin:upstream.statusDisabled')}
                        </Badge>
                      </TableCell>

                      {/* 7. 操作列（高频外置 + 更多菜单） */}
                      <TableCell className="text-right">
                        <div className="flex items-center justify-end gap-1">
                          <IconButton
                            variant="ghost"
                            size="icon-sm"
                            aria-label={t('admin:upstream.syncNow')}
                            tooltip={t('admin:upstream.syncNow')}
                            disabled={syncMutation.isPending}
                            onClick={() => syncMutation.mutate(sub.id)}
                          >
                            <RefreshCw className={isSyncing ? 'animate-spin' : ''} />
                          </IconButton>
                          <IconButton
                            variant="ghost"
                            size="icon-sm"
                            aria-label={t('admin:upstream.viewNodes')}
                            tooltip={t('admin:upstream.viewNodes')}
                            onClick={() => setPool(sub)}
                          >
                            <Server />
                          </IconButton>

                          <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                              <IconButton
                                variant="ghost"
                                size="icon-sm"
                                aria-label={t('admin:upstream.moreActions')}
                                tooltip={t('admin:upstream.moreActions')}
                              >
                                <MoreHorizontal />
                              </IconButton>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end" className="w-36">
                              <DropdownMenuItem
                                onClick={() => {
                                  setEditing(sub);
                                  setFormOpen(true);
                                }}
                                className="gap-2 text-xs"
                              >
                                <Pencil className="size-3.5 text-muted-foreground" />
                                <span>{t('common:actions.edit')}</span>
                              </DropdownMenuItem>
                              <DropdownMenuSeparator />
                              <DropdownMenuItem
                                onClick={() => setDeleting(sub)}
                                className="gap-2 text-xs text-destructive focus:text-destructive focus:bg-destructive/10"
                              >
                                <Trash2 className="size-3.5" />
                                <span>{t('common:actions.delete')}</span>
                              </DropdownMenuItem>
                            </DropdownMenuContent>
                          </DropdownMenu>
                        </div>
                      </TableCell>
                    </TableRow>
                  );
                })
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <ServerPagination
        page={page}
        pageSize={20}
        total={data?.total ?? 0}
        onPageChange={setPage}
        pending={isLoading}
      />

      <UpstreamFormDialog
        open={formOpen}
        onOpenChange={setFormOpen}
        current={editing}
        onSubmit={submit}
        isPending={createMutation.isPending || updateMutation.isPending}
      />

      <UpstreamNodesSheet
        key={pool?.id ?? 'closed'}
        open={!!pool}
        onOpenChange={(v) => !v && setPool(null)}
        subscription={pool}
        onCreateRelayLine={(node) => createLine(node, false)}
        onCreateExternalLine={(node) => createLine(node, true)}
      />

      <ProbeTaskDialog
        open={probeAllOpen}
        onOpenChange={setProbeAllOpen}
        request={{ key: 'upstream:all:all', endpoint: '/admin/upstream/probe-all' }}
        title={t('admin:latencyTest.batchTitle')}
      />

      <AlertDialog open={!!deleting} onOpenChange={(v) => !v && setDeleting(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t('admin:upstream.deleteTitle', { name: deleting?.name ?? '' })}
            </AlertDialogTitle>
            <AlertDialogDescription>{t('admin:upstream.deleteDesc')}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common:actions.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              disabled={deleteMutation.isPending}
              onClick={() =>
                deleting &&
                deleteMutation.mutate(deleting.id, {
                  onSuccess: () => setDeleting(null),
                })
              }
            >
              {t('common:actions.delete')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </PageContainer>
  );
}
