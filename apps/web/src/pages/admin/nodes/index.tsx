import * as React from 'react';
import { Link } from 'react-router-dom';
import { ChevronRight, Plus, RefreshCw, Search, Trash2, Wrench } from 'lucide-react';
import { toast } from 'sonner';
import { useTranslation } from 'react-i18next';
import { Checkbox } from '@/components/ui/checkbox';
import { PageContainer, PageHeader } from '@/components/shared/page-container';
import { BatchUpgradeNodesDialog } from './components/batch-upgrade-nodes-dialog';
import { EmptyState } from '@/components/shared/empty-state';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { IconButton } from '@/components/ui/icon-button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { formatDateTime, formatRate } from '@/lib/utils';
import { useAdminNodes, useNodeMutations, type AdminNode } from './use-nodes';
import { NodeFormDialog } from './components/node-form-dialog';
import { useAdminBinaryResources } from '../binaries/use-binaries';

function NodeStatusBadge({ node }: { node: AdminNode }) {
  const { t } = useTranslation(['admin']);
  if (node.status === 'DISABLED') return <Badge variant="secondary">{t('admin:nodes.statusDisabled')}</Badge>;
  if (node.status !== 'ONLINE') return <Badge variant="secondary">{t('admin:nodes.statusOffline')}</Badge>;
  return (
    <Badge variant={node.communicationMode === 'HTTP' ? 'outline' : 'default'}>
      {node.communicationMode === 'HTTP' ? t('admin:nodes.modeHttp') : t('admin:nodes.modeWs')}
    </Badge>
  );
}

function NodeRate({ node }: { node: AdminNode }) {
  if (node.status !== 'ONLINE' || node.uploadRate == null || node.downloadRate == null) return <span>—</span>;
  return (
    <div className="space-y-0.5 whitespace-nowrap text-xs">
      <div className="text-chart-2">↑ {formatRate(node.uploadRate)}</div>
      <div className="text-chart-1">↓ {formatRate(node.downloadRate)}</div>
    </div>
  );
}

export default function AdminNodesPage() {
  const { t } = useTranslation(['admin', 'common']);
  const [formOpen, setFormOpen] = React.useState(false);
  const [deleting, setDeleting] = React.useState<AdminNode | null>(null);
  const [search, setSearch] = React.useState('');
  const [status, setStatus] = React.useState<'ALL' | 'ONLINE' | 'OFFLINE' | 'DISABLED'>('ALL');
  const [kernel, setKernel] = React.useState<'ALL' | 'RUNNING' | 'STOPPED'>('ALL');
  const [selectedIds, setSelectedIds] = React.useState<Set<string>>(new Set());
  const [batchUpgradeOpen, setBatchUpgradeOpen] = React.useState(false);
  const [batchUpgradeResult, setBatchUpgradeResult] = React.useState<import('./use-nodes').BatchNodeUpgradeResult | null>(null);
  const { data: nodes } = useAdminNodes();
  const { data: binaryResources } = useAdminBinaryResources({ status: 'ACTIVE', pageSize: 100 });
  const { deleteNode, reloadNode, batchUpgradeNodes } = useNodeMutations();

  const filteredNodes = React.useMemo(() => {
    return (nodes ?? []).filter((node) => {
      if (search.trim()) {
        const q = search.trim().toLowerCase();
        const matchName = node.name.toLowerCase().includes(q);
        const matchHost = node.serverHost.toLowerCase().includes(q);
        if (!matchName && !matchHost) return false;
      }
      if (status !== 'ALL') {
        if (status === 'DISABLED' && node.status !== 'DISABLED') return false;
        if (status === 'ONLINE' && node.status !== 'ONLINE') return false;
        if (status === 'OFFLINE' && (node.status === 'ONLINE' || node.status === 'DISABLED')) return false;
      }
      if (kernel !== 'ALL') {
        const isOnline = node.status === 'ONLINE';
        if (kernel === 'RUNNING' && (!isOnline || !node.kernelRunning)) return false;
        if (kernel === 'STOPPED' && (!isOnline || node.kernelRunning !== false)) return false;
      }
      return true;
    });
  }, [nodes, search, status, kernel]);
  const nodeIdsKey = (nodes ?? []).map((node) => node.id).sort().join(',');
  React.useEffect(() => {
    const existingIds = new Set(nodeIdsKey ? nodeIdsKey.split(',') : []);
    setSelectedIds((current) => new Set([...current].filter((id) => existingIds.has(id))));
  }, [nodeIdsKey]);
  const selectedNodes = React.useMemo(() => (nodes ?? []).filter((node) => selectedIds.has(node.id)), [nodes, selectedIds]);
  const visibleSelectedCount = filteredNodes.filter((node) => selectedIds.has(node.id)).length;
  const allVisibleSelected = filteredNodes.length > 0 && visibleSelectedCount === filteredNodes.length;
  const toggleNode = (id: string, checked: boolean) => {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (checked) {
        if (next.size >= 100) {
          toast.warning(t('admin:nodes.batchUpgradeMaxNodes'));
          return current;
        }
        next.add(id);
      } else next.delete(id);
      return next;
    });
  };
  const toggleVisible = (checked: boolean) => {
    if (!checked) {
      setSelectedIds((current) => {
        const next = new Set(current);
        filteredNodes.forEach((node) => next.delete(node.id));
        return next;
      });
      return;
    }
    if (new Set([...selectedIds, ...filteredNodes.map((node) => node.id)]).size > 100) {
      toast.warning(t('admin:nodes.batchUpgradeSelectLimit'));
      return;
    }
    setSelectedIds((current) => new Set([...current, ...filteredNodes.map((node) => node.id)]));
  };
  const closeBatchUpgrade = (open: boolean) => {
    setBatchUpgradeOpen(open);
    if (!open && batchUpgradeResult) {
      setBatchUpgradeResult(null);
      setSelectedIds(new Set());
    }
  };


  return (
    <PageContainer>
      <PageHeader title={t('admin:nodes.title')} description={t('admin:nodes.subtitle')} />

      <div className="flex min-w-0 flex-col gap-2 lg:flex-row lg:items-center lg:justify-between">
        <div className="flex flex-1 flex-wrap items-center gap-2">
          <div className="relative w-full min-w-0 flex-1 sm:min-w-52 sm:max-w-xs">
            <Search className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder={t('admin:nodes.searchPlaceholder')}
              className="pl-9"
            />
          </div>
          <Select value={status} onValueChange={(val) => setStatus(val as typeof status)}>
            <SelectTrigger className="w-full sm:w-32">
              <SelectValue placeholder={t('admin:nodes.filterStatus')} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="ALL">{t('admin:nodes.statusAll')}</SelectItem>
              <SelectItem value="ONLINE">{t('admin:nodes.statusOnline')}</SelectItem>
              <SelectItem value="OFFLINE">{t('admin:nodes.statusOffline')}</SelectItem>
              <SelectItem value="DISABLED">{t('admin:nodes.statusDisabled')}</SelectItem>
            </SelectContent>
          </Select>
          <Select value={kernel} onValueChange={(val) => setKernel(val as typeof kernel)}>
            <SelectTrigger className="w-full sm:w-32">
              <SelectValue placeholder={t('admin:nodes.filterKernel')} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="ALL">{t('admin:nodes.kernelAll')}</SelectItem>
              <SelectItem value="RUNNING">{t('admin:nodes.kernelRunning')}</SelectItem>
              <SelectItem value="STOPPED">{t('admin:nodes.kernelStopped')}</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="flex w-full flex-wrap gap-2 sm:flex-nowrap lg:w-auto">
          <Button size="sm" className="w-full gap-1.5 sm:w-auto" onClick={() => setFormOpen(true)}>
            <Plus className="h-4 w-4" />
            {t('admin:nodes.addNode')}
          </Button>
        </div>
      </div>

      {selectedIds.size > 0 && (
        <div className="flex flex-wrap items-center gap-2 rounded-md border bg-muted/30 p-3 text-sm">
          <span>{t('admin:nodes.selectedNodes', { count: selectedIds.size })}</span>
          <Button size="sm" variant="outline" onClick={() => setSelectedIds(new Set())}>{t('common:actions.clear')}</Button>
          <Button size="sm" disabled={selectedNodes.length !== selectedIds.size} onClick={() => { setBatchUpgradeResult(null); setBatchUpgradeOpen(true); }}>
            <Wrench className="size-4" />{t('admin:nodes.batchUpgradeAction')}
          </Button>
          {selectedNodes.length !== selectedIds.size && <span className="text-xs text-destructive">{t('admin:nodes.batchUpgradeStaleSelection')}</span>}
        </div>
      )}
      <Card>
        <CardContent className="min-w-0 p-0">
          {filteredNodes.length ? (
            <Table className="min-w-[980px]">
              <TableHeader>
                <TableRow>
                  <TableHead className="w-10"><Checkbox checked={allVisibleSelected} onCheckedChange={(checked) => toggleVisible(checked === true)} aria-label={t('common:table.selectAll')} /></TableHead>
                  <TableHead>{t('admin:nodes.colNode')}</TableHead>
                  <TableHead>{t('admin:nodes.colHost')}</TableHead>
                  <TableHead>{t('admin:nodes.colLines')}</TableHead>
                  <TableHead>{t('admin:nodes.colPorts')}</TableHead>
                  <TableHead>{t('admin:nodes.colKernel')}</TableHead>
                  <TableHead>{t('admin:nodes.colStatus')}</TableHead>
                  <TableHead>{t('admin:nodes.colCpu')}</TableHead>
                  <TableHead>{t('admin:nodes.colMem')}</TableHead>
                  <TableHead>{t('admin:nodes.colBandwidth')}</TableHead>
                  <TableHead className="text-right">{t('admin:nodes.colActions')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filteredNodes.map((node) => (
                  <TableRow key={node.id} data-state={selectedIds.has(node.id) ? 'selected' : undefined}>
                    <TableCell><Checkbox checked={selectedIds.has(node.id)} onCheckedChange={(checked) => toggleNode(node.id, checked === true)} aria-label={`${t('common:actions.select')} ${node.name}`} /></TableCell>
                    <TableCell className="font-medium">
                      <div className="flex items-center gap-1.5">
                        <Link to={`/admin/nodes/${node.id}`} className="hover:underline">
                          {node.name}
                        </Link>
                        {node.reachability === 'NAT' ? (
                          <Badge variant="secondary" className="text-[10px] px-1.5 py-0 h-4 bg-amber-500/15 text-amber-600 dark:text-amber-400 border-amber-500/30">
                            {t('admin:nodes.natTag')}
                          </Badge>
                        ) : (
                          <Badge variant="outline" className="text-[10px] px-1.5 py-0 h-4 text-muted-foreground">
                            {t('admin:nodes.publicTag')}
                          </Badge>
                        )}
                      </div>
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {node.reachability === 'NAT' ? (
                        <span className="text-xs text-muted-foreground flex items-center gap-1">
                          {t('admin:nodes.tunnelDesc')}
                          <span className="font-mono text-[11px] opacity-75">({node.serverHost})</span>
                        </span>
                      ) : (
                        node.serverHost
                      )}
                    </TableCell>
                    <TableCell>
                      {node.lines.length ? (
                        <div className="flex max-w-52 flex-wrap gap-1">
                          {node.lines.slice(0, 4).map((line) => (
                            <Badge key={line.id} variant="outline">
                              {line.protocolType}
                            </Badge>
                          ))}
                          {node.lines.length > 4 && (
                            <Badge variant="secondary">+{node.lines.length - 4}</Badge>
                          )}
                        </div>
                      ) : (
                        <span className="text-xs text-muted-foreground">{t('admin:nodes.noLines')}</span>
                      )}
                    </TableCell>
                    <TableCell className="text-xs tabular-nums">
                      {node.servicePorts.length
                        ? node.servicePorts.slice(0, 3).map((port) => (
                            <div key={`${port.lineId}-${port.role}`}>
                              {port.port} · {port.role === 'DIRECT' ? t('admin:nodes.roleDirect') : port.role === 'TRANSIT' ? t('admin:nodes.roleTransit') : t('admin:nodes.roleLanding')}
                            </div>
                          ))
                        : '—'}
                    </TableCell>
                    <TableCell>
                      {node.status !== 'ONLINE' ? (
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <span className="text-xs text-muted-foreground cursor-help select-none">—</span>
                          </TooltipTrigger>
                          <TooltipContent className="text-xs">
                            {t('admin:nodes.kernelOfflineNotice', { status: node.status === 'DISABLED' ? t('admin:nodes.statusDisabled') : t('admin:nodes.statusOffline') })}
                          </TooltipContent>
                        </Tooltip>
                      ) : node.kernelRunning == null ? (
                        <span className="text-xs text-muted-foreground">—</span>
                      ) : node.kernelRunning ? (
                        <Badge>{t('admin:nodes.kernelRunningShort')}</Badge>
                      ) : (
                        <Badge variant="destructive">{t('admin:nodes.kernelStoppedShort')}</Badge>
                      )}
                    </TableCell>
                    <TableCell>
                      <div className="space-y-1">
                        <NodeStatusBadge node={node} />
                        <p className="text-xs text-muted-foreground">{node.lastSeenAt ? formatDateTime(node.lastSeenAt) : t('admin:nodes.notReported')}</p>
                      </div>
                    </TableCell>
                    <TableCell className="tabular-nums">
                      {node.status === 'ONLINE' && node.cpuUsage != null ? `${node.cpuUsage.toFixed(1)}%` : '—'}
                    </TableCell>
                    <TableCell className="tabular-nums">
                      {node.status === 'ONLINE' && node.memoryUsage != null ? `${node.memoryUsage.toFixed(1)}%` : '—'}
                    </TableCell>
                    <TableCell className="tabular-nums">
                      <NodeRate node={node} />
                    </TableCell>
                    <TableCell>
                      <div className="flex justify-end gap-1">
                        <IconButton
                          variant="ghost"
                          size="icon-sm"
                          aria-label={t('admin:nodes.reloadConfig')}
                          disabled={reloadNode.isPending}
                          onClick={() => reloadNode.mutate(node.id)}
                        >
                          <RefreshCw className="size-4" />
                        </IconButton>
                        {!node.isLocal && (
                          <IconButton
                            variant="ghost"
                            size="icon-sm"
                            aria-label={t('common:actions.delete')}
                            onClick={() => setDeleting(node)}
                          >
                            <Trash2 className="size-4 text-destructive" />
                          </IconButton>
                        )}
                        <IconButton
                          variant="ghost"
                          size="icon-sm"
                          aria-label={t('admin:nodes.details')}
                          asChild
                        >
                          <Link to={`/admin/nodes/${node.id}`}>
                            <ChevronRight className="size-4" />
                          </Link>
                        </IconButton>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          ) : (
            <EmptyState
              title={(nodes ?? []).length ? t('admin:nodes.emptyFiltered') : t('admin:nodes.emptyNodes')}
              description={
                (nodes ?? []).length
                  ? t('admin:nodes.emptyFilteredDesc')
                  : t('admin:nodes.subtitle')
              }
              className="border-0"
            />
          )}
        </CardContent>
      </Card>

      <NodeFormDialog open={formOpen} onOpenChange={setFormOpen} />
      <BatchUpgradeNodesDialog
        open={batchUpgradeOpen}
        onOpenChange={closeBatchUpgrade}
        pending={batchUpgradeNodes.isPending}
        nodes={selectedNodes}
        resources={binaryResources?.data}
        result={batchUpgradeResult}
        onSubmit={(values) => batchUpgradeNodes.mutate(values, { onSuccess: setBatchUpgradeResult })}
      />

      <AlertDialog open={!!deleting} onOpenChange={(open) => !open && setDeleting(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('admin:nodes.deleteDialogTitle', { name: deleting?.name ?? '' })}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('admin:nodes.deleteDialogDesc')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common:actions.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => deleting && deleteNode.mutate(deleting.id, { onSuccess: () => setDeleting(null) })}
            >
              {t('common:actions.delete')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </PageContainer>
  );
}
