import * as React from 'react';
import { useLocation } from 'react-router-dom';
import type { ApiUpstreamNode } from '@/lib/api';
import { api } from '@/lib/api';
import { useQuery } from '@tanstack/react-query';
import { ServerPagination } from '@/components/shared/server-pagination';
import { LineTopology } from './components/line-topology';
import {
  Activity,
  ArrowDown,
  ArrowUp,
  Copy,
  GitBranch,
  HelpCircle,
  MoreHorizontal,
  Pencil,
  Plus,
  Search,
  Trash2,
  Zap
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { PageContainer, PageHeader } from '@/components/shared/page-container';
import { EmptyState } from '@/components/shared/empty-state';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { IconButton } from '@/components/ui/icon-button';
import { Card, CardContent } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu';
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
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { type LineStatus, type LineType } from '@/lib/api';
import { useAdminNodes } from '../nodes/use-nodes';
import { useAdminCertificates } from '../certificates/use-certificates';
import { LineFormDialog } from './components/line-form-dialog';
import { LineSpeedtestDialog } from './components/line-speedtest-dialog';
import { ProbeMeasurementChip } from '@/components/shared/probe-result';
import { ProbeTaskDialog } from '@/components/shared/probe-task-dialog';
import { usePublicSettings } from '@/lib/public-settings';
import { formatSpeedLimit, getSpeedTierBadgeClass } from '@/lib/speed-tier';
import { useAdminLines, useLineMutations, type AdminLine } from './use-lines';
import { ProxyPoolDrawer } from './components/proxy-pool-drawer';
import { FlagText } from '@/components/shared/flag-text';

export default function AdminLinesPage() {
  const { t } = useTranslation(['admin', 'common']);
  const [search, setSearch] = React.useState('');
  const [page, setPage] = React.useState(1);
  const [createExternal, setCreateExternal] = React.useState(false);
  const [type, setType] = React.useState<'ALL' | LineType>('ALL');
  const [status, setStatus] = React.useState<'ALL' | LineStatus>('ALL');
  const [tag, setTag] = React.useState('');
  const [selected, setSelected] = React.useState<Set<string>>(new Set());
  const [formOpen, setFormOpen] = React.useState(false);
  const [editing, setEditing] = React.useState<AdminLine | null>(null);
  const [deleting, setDeleting] = React.useState<AdminLine | null>(null);
  const [speedtestingLine, setSpeedtestingLine] = React.useState<AdminLine | null>(null);
  const [batchProbeOpen, setBatchProbeOpen] = React.useState(false);
  const [initialUpstreamNode, setInitialUpstreamNode] = React.useState<ApiUpstreamNode | null>(null);
  const location = useLocation();
  const [linkedLineId, setLinkedLineId] = React.useState<string | null>(new URLSearchParams(location.search).get('lineId'));
  const linkedLine = useQuery({ queryKey: ['admin', 'lines', 'linked', linkedLineId], enabled: Boolean(linkedLineId), queryFn: async () => (await api.get<{ line: AdminLine }>('/admin/lines/' + linkedLineId)).data.line });
  React.useEffect(() => {
    if (linkedLine.data && linkedLineId) { setEditing(linkedLine.data); setFormOpen(true); setLinkedLineId(null); }
    // eslint-disable-next-line no-restricted-syntax -- 详情只打开一次会话，不初始化或覆盖表单草稿
  }, [linkedLine.data, linkedLineId]); // 服务端详情仅用于一次性打开业务会话

  React.useEffect(() => {
    const state = location.state as
      | { createUpstreamNode?: ApiUpstreamNode; createExternal?: boolean }
      | undefined;
    if (state?.createUpstreamNode) {
      setEditing(null);
      setInitialUpstreamNode(state.createUpstreamNode);
      setCreateExternal(state.createExternal === true);
      setFormOpen(true);
      window.history.replaceState({}, document.title);
    }
  }, [location.state]);

  const query = React.useMemo(
    () => ({
      page,
      pageSize: 20,
      ...(search.trim() ? { search: search.trim() } : {}),
      ...(type !== 'ALL' ? { type } : {}),
      ...(status !== 'ALL' ? { status } : {}),
      ...(tag.trim() ? { tag: tag.trim() } : {})
    }),
    [search, status, tag, type, page]
  );

  const { data, isPending, isError } = useAdminLines(query);
  const { data: nodes } = useAdminNodes();
  const { data: certificates } = useAdminCertificates();
  const { data: publicSettings } = usePublicSettings();
  const unitConversion = publicSettings?.speedLimitUnitConversionEnabled !== false;
  const { create, update, remove, duplicate, testResolve, batchStatus, reorder } =
    useLineMutations();
  const lines = data?.data ?? [];
  const allSelected = lines.length > 0 && lines.every((line) => selected.has(line.id));
  const busy = create.isPending || update.isPending;

  const toggleSelected = (id: string, checked: boolean) => {
    setSelected((current) => {
      const next = new Set(current);
      if (checked) next.add(id);
      else next.delete(id);
      return next;
    });
  };

  const toggleAll = (checked: boolean) => {
    setSelected(checked ? new Set(lines.map((line) => line.id)) : new Set());
  };

  const move = (line: AdminLine, direction: -1 | 1) => {
    const index = lines.findIndex((item) => item.id === line.id);
    const targetIndex = index + direction;
    if (targetIndex < 0 || targetIndex >= lines.length) return;

    const target = lines[targetIndex];
    const offset = (page - 1) * 20;
    reorder.mutate([
      { id: line.id, sortOrder: (offset + targetIndex + 1) * 10 },
      { id: target.id, sortOrder: (offset + index + 1) * 10 }
    ]);
  };

  const openCreate = () => {
    setEditing(null);
    setCreateExternal(false);
    setInitialUpstreamNode(null);
    setFormOpen(true);
  };
  const openEdit = (line: AdminLine) => {
    setEditing(line);
    setFormOpen(true);
  };

  if (isPending)
    return (
      <PageContainer>
        <PageHeader title={t('admin:lines.title')} description={t('admin:lines.subtitle')} />
        <p className="text-sm text-muted-foreground">{t('common:actions.loading')}</p>
      </PageContainer>
    );
  if (isError)
    return (
      <PageContainer>
        <PageHeader title={t('admin:lines.title')} />
        <EmptyState
          title={t('admin:lines.emptyLines')}
          description={t('admin:lines.subtitle')}
        />
      </PageContainer>
    );

  return (
    <PageContainer>
      <PageHeader title={t('admin:lines.title')} description={t('admin:lines.subtitle')} />

      {/* 搜索与多维度筛选工具栏 */}
      <div className="flex min-w-0 flex-col gap-2.5 lg:flex-row lg:items-center lg:justify-between">
        <div className="flex flex-1 flex-wrap items-center gap-2">
          <div className="relative w-full min-w-0 flex-1 sm:min-w-52 sm:max-w-xs">
            <Search className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input
              value={search}
              onChange={(event) => {
                setSearch(event.target.value);
                setPage(1);
              }}
              placeholder={t('admin:nodes.searchPlaceholder')}
              className="pl-9"
            />
          </div>
          <Input
            value={tag}
            onChange={(event) => {
              setTag(event.target.value);
              setPage(1);
            }}
            placeholder={t('admin:lines.filterTag')}
            className="w-full sm:w-28"
          />
          <Select
            value={type}
            onValueChange={(value) => {
              setType(value as 'ALL' | LineType);
              setPage(1);
            }}
          >
            <SelectTrigger className="w-full sm:w-28">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="ALL">{t('admin:lines.typeAll')}</SelectItem>
              <SelectItem value="DIRECT">{t('admin:lines.typeDirect')}</SelectItem>
              <SelectItem value="RELAY">{t('admin:lines.typeRelay')}</SelectItem>
              <SelectItem value="EXTERNAL">{t('admin:upstream.externalType')}</SelectItem>
            </SelectContent>
          </Select>
          <Select
            value={status}
            onValueChange={(value) => {
              setStatus(value as 'ALL' | LineStatus);
              setPage(1);
            }}
          >
            <SelectTrigger className="w-full sm:w-28">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="ALL">{t('admin:lines.statusAll')}</SelectItem>
              <SelectItem value="ACTIVE">{t('admin:lines.statusActive')}</SelectItem>
              <SelectItem value="DISABLED">{t('admin:lines.statusDisabled')}</SelectItem>
            </SelectContent>
          </Select>
        </div>

        {/* 右侧动作条：代理池抽屉、全量测速与新建线路 */}
        <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto">
          <ProxyPoolDrawer />
          <Button
            variant="outline"
            size="sm"
            disabled={!lines.length}
            onClick={() => setBatchProbeOpen(true)}
            className="w-full sm:w-auto"
          >
            <Activity className="size-4" />
            {t('admin:latencyTest.batchTitle')}
          </Button>
          <Button size="sm" className="w-full sm:w-auto" onClick={openCreate}>
            <Plus className="size-4" />
            {t('admin:lines.createLine')}
          </Button>
        </div>
      </div>

      {/* 批量操作卡片 */}
      {selected.size > 0 && (
        <div className="flex flex-wrap items-center gap-2 rounded-md border bg-muted/40 p-2.5 text-sm animate-in fade-in-50 duration-200">
          <span className="font-medium text-xs">
            {t('admin:lines.selectedCount', { count: selected.size })}
          </span>
          <div className="h-4 w-px bg-border mx-1" />
          <Button
            size="sm"
            variant="outline"
            className="h-7 text-xs"
            disabled={batchStatus.isPending}
            onClick={() =>
              batchStatus.mutate(
                { ids: [...selected], status: 'ACTIVE' },
                { onSuccess: () => setSelected(new Set()) }
              )
            }
          >
            {t('admin:lines.batchEnable')}
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="h-7 text-xs"
            disabled={batchStatus.isPending}
            onClick={() =>
              batchStatus.mutate(
                { ids: [...selected], status: 'DISABLED' },
                { onSuccess: () => setSelected(new Set()) }
              )
            }
          >
            {t('admin:lines.batchDisable')}
          </Button>
        </div>
      )}

      {/* 主数据表格：彻底收敛至 6 核心列 */}
      <Card>
        <CardContent className="min-w-0 p-0">
          {lines.length ? (
            <Table className="min-w-[900px] table-fixed">
              <TableHeader>
                <TableRow>
                  <TableHead className="w-14">
                    <div className="flex items-center gap-1.5">
                      <Checkbox
                        checked={allSelected}
                        onCheckedChange={(checked) => toggleAll(checked === true)}
                        aria-label={t('common:table.selectAll')}
                      />
                      <span className="font-mono text-xs text-muted-foreground font-semibold">
                        #
                      </span>
                    </div>
                  </TableHead>
                  <TableHead className="w-1/4 min-w-56">
                    {t('admin:lines.colLineAndEndpoint')}
                  </TableHead>
                  <TableHead className="w-1/3 min-w-64">
                    {t('admin:lines.colPipelineTopology')}
                  </TableHead>
                  <TableHead className="w-48 min-w-40">
                    {t('admin:lines.colTagsRate')}
                  </TableHead>
                  <TableHead className="w-28">
                    <div className="flex items-center gap-1">
                      <span>{t('admin:lines.colLatency')}</span>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <HelpCircle className="size-3.5 text-muted-foreground/70 cursor-help" />
                        </TooltipTrigger>
                        <TooltipContent className="max-w-xs space-y-1 text-xs shadow-lg">
                          <p className="font-semibold text-primary-foreground">{t('admin:latencyTest.title')}</p>
                          <p className="text-primary-foreground/80 leading-relaxed">{t('admin:latencyTest.description')}</p>
                          <p className="text-primary-foreground/65 text-[11px]">{t('admin:latencyTest.closeHelp')}</p>
                        </TooltipContent>
                      </Tooltip>
                    </div>
                  </TableHead>
                  <TableHead className="w-24">{t('admin:lines.colStatus')}</TableHead>
                  <TableHead className="w-28 text-right">{t('admin:lines.colActions')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {lines.map((line, index) => (
                  <TableRow key={line.id} data-state={selected.has(line.id) ? 'selected' : undefined}>
                    {/* 1. 复选框与排序合并 */}
                    <TableCell>
                      <div className="flex items-center gap-2">
                        <Checkbox
                          checked={selected.has(line.id)}
                          onCheckedChange={(checked) => toggleSelected(line.id, checked === true)}
                          aria-label={`${t('common:actions.select')} ${line.name}`}
                        />
                        <span className="font-mono text-xs text-muted-foreground tabular-nums">
                          #{line.sortOrder}
                        </span>
                      </div>
                    </TableCell>

                    {/* 2. 线路名称与端点双层整合 */}
                    <TableCell>
                      <div className="flex flex-col gap-0.5">
                        <div className="flex items-center gap-1.5 flex-wrap">
                          <span className="font-medium text-sm text-foreground">
                            <FlagText text={line.name} />
                          </span>
                          {!line.isPublic && (
                            <Badge
                              variant="outline"
                              className="text-[10px] px-1 py-0 text-muted-foreground font-normal"
                            >
                              {t('admin:lines.privateLine')}
                            </Badge>
                          )}
                          {line.proxyPoolEnabled && (
                            <Badge
                              variant="secondary"
                              className="text-[10px] px-1.5 py-0 text-emerald-600 dark:text-emerald-400 bg-emerald-500/10 font-normal"
                            >
                              {t('admin:lineForm.proxyPoolEnabledBadge')}
                            </Badge>
                          )}
                        </div>
                        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                          <span className="font-mono text-[11px]">Lv.{line.level}</span>
                          <span>·</span>
                          <span
                            className="font-mono text-[11px] truncate block"
                            title={`${line.serverHost}:${line.serverPort}`}
                          >
                            {line.serverHost}:{line.serverPort}
                          </span>
                        </div>
                      </div>
                    </TableCell>

                    {/* 3. 链路拓扑流水线（融合直连/中继/桥接/外部） */}
                    <TableCell>
                      <LineTopology line={line} />
                    </TableCell>

                    {/* 4. 规格与标签（限速、倍率、标签） */}
                    <TableCell>
                      <div className="flex flex-wrap items-center gap-1.5">
                        {Boolean(line.speedLimitMbps) && (
                          <Badge
                            variant="outline"
                            className={cn(
                              'gap-1 text-[11px] px-1.5 py-0 font-normal',
                              getSpeedTierBadgeClass(
                                line.speedLimitMbps,
                                publicSettings?.speedLimitColorTiers
                              )
                            )}
                          >
                            <Zap className="size-3" />
                            {formatSpeedLimit(line.speedLimitMbps, unitConversion)}
                          </Badge>
                        )}
                        <Badge variant="outline" className="text-[11px] px-1.5 py-0 font-mono">
                          {line.trafficRate}x
                        </Badge>
                        {line.tags.map((item) => (
                          <Badge
                            key={item}
                            variant="secondary"
                            className="text-[10px] px-1.5 py-0 font-normal"
                          >
                            #{item}
                          </Badge>
                        ))}
                      </div>
                    </TableCell>

                    {/* 5. 端到端探测延迟（精炼指示微标） */}
                    <TableCell>
                      <ProbeMeasurementChip
                        value={line.lastProbe}
                        onClick={() => setSpeedtestingLine(line)}
                      />
                    </TableCell>

                    {/* 6. 运行状态 */}
                    <TableCell>
                      <Badge
                        variant={line.status === 'ACTIVE' ? 'default' : 'secondary'}
                        className="text-[11px] px-2 py-0.5 cursor-pointer select-none"
                        onClick={() => {
                          const nextStatus = line.status === 'ACTIVE' ? 'DISABLED' : 'ACTIVE';
                          batchStatus.mutate({ ids: [line.id], status: nextStatus });
                        }}
                      >
                        {line.status === 'ACTIVE'
                          ? t('admin:lines.statusActive')
                          : t('admin:lines.statusDisabled')}
                      </Badge>
                    </TableCell>

                    {/* 7. 行操作列（高频外置 + 更多操作下拉折叠） */}
                    <TableCell className="text-right">
                      <div className="flex items-center justify-end gap-0.5">
                        <IconButton
                          variant="ghost"
                          size="icon-sm"
                          aria-label={t('admin:latencyTest.title')}
                          tooltip={t('admin:latencyTest.title')}
                          onClick={() => setSpeedtestingLine(line)}
                        >
                          <Activity className="size-4" />
                        </IconButton>
                        <IconButton
                          variant="ghost"
                          size="icon-sm"
                          aria-label={t('admin:lines.editLine')}
                          tooltip={t('admin:lines.editLine')}
                          onClick={() => openEdit(line)}
                        >
                          <Pencil className="size-4" />
                        </IconButton>

                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <IconButton
                              variant="ghost"
                              size="icon-sm"
                              aria-label={t('admin:lines.moreActions')}
                              tooltip={t('admin:lines.moreActions')}
                            >
                              <MoreHorizontal className="size-4" />
                            </IconButton>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end" className="w-36">
                            <DropdownMenuItem
                              disabled={testResolve.isPending}
                              onClick={() => testResolve.mutate(line.id)}
                              className="gap-2 text-xs"
                            >
                              <Zap className="size-3.5 text-muted-foreground" />
                              <span>{t('admin:lines.testResolve')}</span>
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              disabled={duplicate.isPending}
                              onClick={() => duplicate.mutate(line.id)}
                              className="gap-2 text-xs"
                            >
                              <Copy className="size-3.5 text-muted-foreground" />
                              <span>{t('admin:lines.duplicateLine')}</span>
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              disabled={index === 0 || reorder.isPending}
                              onClick={() => move(line, -1)}
                              className="gap-2 text-xs"
                            >
                              <ArrowUp className="size-3.5 text-muted-foreground" />
                              <span>{t('admin:lines.moveUp')}</span>
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              disabled={index === lines.length - 1 || reorder.isPending}
                              onClick={() => move(line, 1)}
                              className="gap-2 text-xs"
                            >
                              <ArrowDown className="size-3.5 text-muted-foreground" />
                              <span>{t('admin:lines.moveDown')}</span>
                            </DropdownMenuItem>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem
                              onClick={() => setDeleting(line)}
                              className="gap-2 text-xs text-destructive focus:text-destructive focus:bg-destructive/10"
                            >
                              <Trash2 className="size-3.5" />
                              <span>{t('admin:lines.deleteLine')}</span>
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          ) : (
            <EmptyState
              title={t('admin:lines.emptyLines')}
              description={t('admin:lines.subtitle')}
              className="border-0"
            />
          )}
        </CardContent>
      </Card>

      <ServerPagination
        page={page}
        pageSize={20}
        total={data?.total ?? 0}
        onPageChange={setPage}
      />

      <LineFormDialog
        open={formOpen}
        createExternal={createExternal}
        onOpenChange={(open) => {
          setFormOpen(open);
          if (!open) setInitialUpstreamNode(null);
        }}
        line={editing}
        initialUpstreamNode={initialUpstreamNode}
        nodes={nodes ?? []}
        lines={lines}
        certificates={certificates?.data ?? []}
        pending={busy}
        onSubmit={(payload) =>
          editing
            ? update.mutate(
                { id: editing.id, ...payload },
                {
                  onSuccess: () => {
                    setFormOpen(false);
                    setInitialUpstreamNode(null);
                  }
                }
              )
            : create.mutate(payload, {
                onSuccess: () => {
                  setFormOpen(false);
                  setInitialUpstreamNode(null);
                }
              })
        }
      />

      <LineSpeedtestDialog
        open={!!speedtestingLine}
        onOpenChange={(open) => !open && setSpeedtestingLine(null)}
        line={speedtestingLine}
      />

      <ProbeTaskDialog
        open={batchProbeOpen}
        onOpenChange={setBatchProbeOpen}
        request={{ key: 'lines:all', endpoint: '/admin/lines/speedtest-all' }}
        title={t('admin:latencyTest.batchTitle')}
      />

      <AlertDialog open={!!deleting} onOpenChange={(open) => !open && setDeleting(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t('admin:lines.deleteDialogTitle', { name: deleting?.name ?? '' })}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t('admin:lines.deleteDialogDesc')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common:actions.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() =>
                deleting &&
                remove.mutate(deleting.id, {
                  onSuccess: () => setDeleting(null)
                })
              }
            >
              {t('common:actions.delete')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <div className="flex flex-col gap-1.5 text-xs text-muted-foreground sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-2">
          <GitBranch className="h-3.5 w-3.5 shrink-0" />
          <span>{t('admin:lines.footerDirectNote')}</span>
        </div>
        <div className="flex items-center gap-1.5 opacity-85">
          <Activity className="h-3.5 w-3.5 shrink-0" />
          <span>{t('admin:latencyTest.description')}</span>
        </div>
      </div>
    </PageContainer>
  );
}
