import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import {
  Activity,
  Copy,
  ChevronDown,
  Radio,
  GitFork,
  AlertCircle,
  Download,
} from 'lucide-react';
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from '@/components/ui/sheet';
import { Button } from '@/components/ui/button';
import { IconButton } from '@/components/ui/icon-button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import { Card, CardContent } from '@/components/ui/card';
import { ServerPagination } from '@/components/shared/server-pagination';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { ApiUpstreamSubscription, ApiUpstreamNode, upstreamApi } from '@/lib/api';
import { useAdminUpstreamNodes, useAdminUpstreamMutations } from '../use-upstream';
import { ProbeTaskDialog } from '@/components/shared/probe-task-dialog';
import { ProbeMeasurementChip } from '@/components/shared/probe-result';

export function UpstreamNodesSheet({
  open,
  onOpenChange,
  subscription,
  onCreateRelayLine,
  onCreateExternalLine,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  subscription?: ApiUpstreamSubscription | null;
  onCreateRelayLine?: (node: ApiUpstreamNode) => void;
  onCreateExternalLine?: (node: ApiUpstreamNode) => void;
}) {
  const { t } = useTranslation(['admin', 'common']);
  const [search, setSearch] = useState('');
  const [protocol, setProtocol] = useState('ALL');
  const [tag, setTag] = useState('');
  const [page, setPage] = useState(1);

  const { data, isLoading, isError } = useAdminUpstreamNodes(
    {
      subscriptionId: subscription?.id,
      page,
      pageSize: 20,
      search: search.trim() || undefined,
      protocolType: protocol === 'ALL' ? undefined : protocol,
      tag: tag.trim() || undefined,
    },
    open
  );

  const { setNodeStatusMutation } = useAdminUpstreamMutations();
  const [probeSelection, setProbeSelection] = useState<ApiUpstreamNode | 'ALL' | null>(null);

  const copy = async (node?: ApiUpstreamNode) => {
    try {
      const res = await upstreamApi.exportNodes({
        nodeIds: node?.id,
        subscriptionId: node ? undefined : subscription?.id,
        format: 'uri',
      });
      await navigator.clipboard.writeText(res.data);
      toast.success(t('admin:upstream.exportSuccess'));
    } catch {
      toast.error(t('common:actions.copyFailed'));
    }
  };

  return (
    <>
      <Sheet open={open} onOpenChange={onOpenChange}>
        <SheetContent side="right" className="w-full sm:max-w-6xl p-6 overflow-y-auto space-y-4">
          <SheetHeader>
            <div className="flex items-center gap-2">
              <SheetTitle className="text-lg font-bold">
                {subscription?.name}
              </SheetTitle>
              <Badge variant="outline" className="font-mono text-xs">
                {t('admin:upstream.nodesPoolSummary', {
                  total: data?.total ?? 0,
                })}
              </Badge>
            </div>
            <SheetDescription className="text-xs text-muted-foreground">
              {t('admin:upstream.nodesSheetSubtitle')}
            </SheetDescription>
          </SheetHeader>

          {/* 筛选与批量操作区 */}
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex flex-wrap items-center gap-2">
              <Input
                className="max-w-xs h-8 text-xs"
                value={search}
                onChange={(e) => {
                  setSearch(e.target.value);
                  setPage(1);
                }}
                placeholder={t('admin:upstream.searchNodesPlaceholder')}
              />
              <Input
                className="w-32 h-8 text-xs"
                value={tag}
                onChange={(e) => {
                  setTag(e.target.value);
                  setPage(1);
                }}
                placeholder={t('admin:lines.filterTag')}
              />
              <Select
                value={protocol}
                onValueChange={(v) => {
                  setProtocol(v);
                  setPage(1);
                }}
              >
                <SelectTrigger className="w-32 h-8 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {[
                    'ALL',
                    'VLESS',
                    'VMESS',
                    'HYSTERIA2',
                    'TUIC',
                    'TROJAN',
                    'SHADOWSOCKS',
                    'SOCKS',
                    'HTTP',
                    'NAIVE',
                  ].map((v) => (
                    <SelectItem key={v} value={v}>
                      {v === 'ALL' ? t('admin:upstream.statusAll') : v}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                className="h-8 text-xs gap-1.5"
                onClick={() => setProbeSelection('ALL')}
              >
                <Activity className="size-3.5" />
                {t('admin:upstream.probeAll')}
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="h-8 text-xs gap-1.5"
                onClick={() => void copy()}
              >
                <Download className="size-3.5" />
                {t('admin:upstream.exportUri')}
              </Button>
            </div>
          </div>

          {/* 节点数据表格 */}
          <Card>
            <CardContent className="min-w-0 p-0">
              <Table className="min-w-[850px] table-fixed">
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-2/5 min-w-64">
                      {t('admin:upstream.colNodeName')}
                    </TableHead>
                    <TableHead className="w-32">
                      {t('admin:upstream.colLatency')}
                    </TableHead>
                    <TableHead className="w-40">
                      {t('admin:upstream.nodeLocalStatus')}
                    </TableHead>
                    <TableHead className="w-40">
                      {t('admin:upstream.relatedLines')}
                    </TableHead>
                    <TableHead className="w-40 text-right">
                      {t('admin:upstream.colActions')}
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {isLoading || isError || !data?.data.length ? (
                    <TableRow>
                      <TableCell colSpan={5} className="h-40 text-center">
                        <p className="text-sm text-muted-foreground">
                          {isLoading
                            ? t('common:actions.loading')
                            : isError
                            ? t('common:status.failed')
                            : t('admin:upstream.emptyNodesTitle')}
                        </p>
                      </TableCell>
                    </TableRow>
                  ) : (
                    data.data.map((node) => {
                      const isMissing = node.presenceStatus === 'MISSING';

                      return (
                        <TableRow key={node.id}>
                          {/* 1. 节点名称与端点拓扑 */}
                          <TableCell>
                            <div className="space-y-1">
                              <div className="flex items-center gap-1.5">
                                {isMissing ? (
                                  <Tooltip>
                                    <TooltipTrigger asChild>
                                      <span className="inline-flex items-center text-destructive cursor-help">
                                        <AlertCircle className="size-3.5" />
                                      </span>
                                    </TooltipTrigger>
                                    <TooltipContent className="text-xs">
                                      {t('admin:upstream.presenceMissing')}
                                    </TooltipContent>
                                  </Tooltip>
                                ) : (
                                  <span className="size-1.5 rounded-full bg-emerald-500 shrink-0" />
                                )}
                                <span
                                  className={`font-medium text-sm truncate max-w-[260px] ${
                                    isMissing ? 'text-muted-foreground line-through' : ''
                                  }`}
                                  title={node.name}
                                >
                                  {node.name}
                                </span>
                                {node.tags.map((item) => (
                                  <Badge
                                    key={item}
                                    variant="secondary"
                                    className="text-[10px] px-1 py-0 h-4 font-normal"
                                  >
                                    {item}
                                  </Badge>
                                ))}
                              </div>
                              <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                                <Badge
                                  variant="outline"
                                  className="font-mono text-[10px] px-1 py-0 h-4 font-normal"
                                >
                                  {node.protocolType}
                                </Badge>
                                <span className="font-mono text-[11px] truncate max-w-[240px]">
                                  {node.serverHost}:{node.serverPort}
                                </span>
                              </div>
                            </div>
                          </TableCell>

                          {/* 2. 连通性 / 延迟 */}
                          <TableCell>
                            <ProbeMeasurementChip
                              value={node.lastProbe}
                              onClick={() => setProbeSelection(node)}
                            />
                          </TableCell>

                          {/* 3. 本地分发状态 */}
                          <TableCell>
                            <div className="flex items-center gap-2">
                              <Switch
                                aria-label={t('admin:upstream.toggleNodeStatus')}
                                checked={node.status === 'ACTIVE'}
                                disabled={setNodeStatusMutation.isPending || isMissing}
                                onCheckedChange={(v) =>
                                  setNodeStatusMutation.mutate({
                                    nodeId: node.id,
                                    status: v ? 'ACTIVE' : 'DISABLED',
                                  })
                                }
                              />
                              <span className="text-[11px] text-muted-foreground">
                                {node.status === 'ACTIVE'
                                  ? t('admin:upstream.nodeLocalStatusActive')
                                  : t('admin:upstream.nodeLocalStatusDisabled')}
                              </span>
                            </div>
                          </TableCell>

                          {/* 4. 关联线路 */}
                          <TableCell className="text-xs">
                            {node.relayLines && node.relayLines.length > 0 ? (
                              <div className="space-y-0.5">
                                {node.relayLines.map((line) => (
                                  <div
                                    key={line.id}
                                    className="flex items-center gap-1 text-[11px]"
                                  >
                                    <span className="font-medium truncate max-w-[120px]">
                                      {line.name}
                                    </span>
                                    <Badge
                                      variant={line.status === 'ACTIVE' ? 'default' : 'secondary'}
                                      className="text-[9px] px-1 py-0 h-3.5"
                                    >
                                      {line.status === 'ACTIVE'
                                        ? t('admin:upstream.statusActive')
                                        : t('admin:upstream.statusDisabled')}
                                    </Badge>
                                  </div>
                                ))}
                              </div>
                            ) : (
                              <span className="text-muted-foreground/60 text-[11px]">
                                {t('admin:upstream.noRelatedLines')}
                              </span>
                            )}
                          </TableCell>

                          {/* 5. 行操作列 */}
                          <TableCell className="text-right">
                            <div className="flex items-center justify-end gap-1">
                              <IconButton
                                variant="ghost"
                                size="icon-sm"
                                aria-label={t('admin:upstream.probeNode')}
                                tooltip={t('admin:upstream.probeNode')}
                                onClick={() => setProbeSelection(node)}
                              >
                                <Activity />
                              </IconButton>
                              <IconButton
                                variant="ghost"
                                size="icon-sm"
                                aria-label={t('common:actions.copy')}
                                tooltip={t('admin:upstream.exportUri')}
                                onClick={() => void copy(node)}
                              >
                                <Copy />
                              </IconButton>

                              <DropdownMenu>
                                <DropdownMenuTrigger asChild>
                                  <Button
                                    variant="outline"
                                    size="sm"
                                    className="h-7 text-xs gap-1 px-2 font-normal"
                                    disabled={
                                      isMissing ||
                                      node.status !== 'ACTIVE' ||
                                      subscription?.status !== 'ACTIVE'
                                    }
                                  >
                                    <span>{t('admin:upstream.createLineDropdown')}</span>
                                    <ChevronDown className="size-3 text-muted-foreground" />
                                  </Button>
                                </DropdownMenuTrigger>
                                <DropdownMenuContent align="end" className="w-44">
                                  <DropdownMenuItem
                                    onClick={() => onCreateExternalLine?.(node)}
                                    className="gap-2 text-xs"
                                  >
                                    <Radio className="size-3.5 text-muted-foreground" />
                                    <span>{t('admin:upstream.createExternalLine')}</span>
                                  </DropdownMenuItem>
                                  <DropdownMenuItem
                                    onClick={() => onCreateRelayLine?.(node)}
                                    className="gap-2 text-xs"
                                  >
                                    <GitFork className="size-3.5 text-muted-foreground" />
                                    <span>{t('admin:upstream.createRelayLine')}</span>
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
            pending={isLoading}
            onPageChange={setPage}
          />
        </SheetContent>
      </Sheet>

      {probeSelection && (
        <ProbeTaskDialog
          key={
            probeSelection === 'ALL'
              ? `all:${subscription?.id}`
              : probeSelection.id
          }
          open={open}
          onOpenChange={(value) => !value && setProbeSelection(null)}
          title={
            probeSelection === 'ALL'
              ? t('admin:upstream.probeAll')
              : `${t('admin:probes.title')} · ${probeSelection.name}`
          }
          request={
            probeSelection === 'ALL'
              ? {
                  key: `upstream:all:${subscription?.id ?? 'all'}`,
                  endpoint: '/admin/upstream/probe-all',
                  subscriptionId: subscription?.id,
                }
              : {
                  key: `upstream:${probeSelection.id}`,
                  endpoint: `/admin/upstream/nodes/${probeSelection.id}/probe`,
                }
          }
        />
      )}
    </>
  );
}
