import * as React from 'react';
import { useLocation } from 'react-router-dom';
import type { ApiUpstreamNode } from '@/lib/api';
import { Activity, ArrowDown, ArrowUp, Copy, GitBranch, HelpCircle, Pencil, Plus, Search, Trash2, Zap } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { PageContainer, PageHeader } from '@/components/shared/page-container';
import { EmptyState } from '@/components/shared/empty-state';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { IconButton } from '@/components/ui/icon-button';
import { Card, CardContent } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { type LineStatus, type LineType, type RelayMode } from '@/lib/api';
import { useAdminNodes } from '../nodes/use-nodes';
import { useAdminCertificates } from '../certificates/use-certificates';
import { LineFormDialog } from './components/line-form-dialog';
import { LineSpeedtestDialog } from './components/line-speedtest-dialog';
import { LineLatencyChip } from '@/components/shared/line-latency-chip';
import { usePublicSettings } from '@/lib/public-settings';
import { formatSpeedLimit, getSpeedTierBadgeClass } from '@/lib/speed-tier';
import { useAdminLines, useLineMutations, type AdminLine } from './use-lines';

export default function AdminLinesPage() {
  const { t } = useTranslation(['admin', 'common']);
  const [search, setSearch] = React.useState('');
  const [type, setType] = React.useState<'ALL' | LineType>('ALL');
  const [status, setStatus] = React.useState<'ALL' | LineStatus>('ALL');
  const [tag, setTag] = React.useState('');
  const [selected, setSelected] = React.useState<Set<string>>(new Set());
  const [formOpen, setFormOpen] = React.useState(false);
  const [editing, setEditing] = React.useState<AdminLine | null>(null);
  const [deleting, setDeleting] = React.useState<AdminLine | null>(null);
  const [speedtestingLine, setSpeedtestingLine] = React.useState<AdminLine | null>(null);
  const [initialUpstreamNode, setInitialUpstreamNode] = React.useState<ApiUpstreamNode | null>(null);
  const location = useLocation();
  React.useEffect(() => {
    const state = location.state as { createUpstreamNode?: ApiUpstreamNode } | undefined;
    if (state?.createUpstreamNode) {
      setEditing(null);
      setInitialUpstreamNode(state.createUpstreamNode);
      setFormOpen(true);
      window.history.replaceState({}, document.title);
    }
  }, [location.state]);

  const typeLabels: Record<LineType, string> = {
    DIRECT: t('admin:lines.typeDirect'),
    RELAY: t('admin:lines.typeRelay')
  };
  const relayLabels: Record<RelayMode, string> = {
    BLIND_FORWARD: t('admin:lines.relayBlindForward'),
    PROTOCOL_PROXY: t('admin:lines.relayProtocolProxy'),
    TARGET_LINE: t('admin:lines.relayTargetBridge'),
    UPSTREAM_NODE: t('admin:lines.relayUpstreamNode')
  };

  function relayDescription(line: AdminLine) {
    if (line.relayMode === 'TARGET_LINE' && line.targetLine) {
      const targetPort = line.topology.landing?.port ?? line.targetLine.entryPort;
      return `${t('admin:lines.relayTargetBridge')} ➔ [${line.targetLine.entryNode.name}] ${line.targetLine.protocolType}:${targetPort}`;
    }
    if (line.relayMode === 'UPSTREAM_NODE' && line.topology.landing?.node) {
      return `${t('admin:lines.relayUpstreamNode')} ➔ ${line.topology.landing.node.name}`;
    }
    return line.relayMode ? relayLabels[line.relayMode] : '';
  }

  const query = React.useMemo(() => ({
    ...(search.trim() ? { search: search.trim() } : {}),
    ...(type !== 'ALL' ? { type } : {}),
    ...(status !== 'ALL' ? { status } : {}),
    ...(tag.trim() ? { tag: tag.trim() } : {})
  }), [search, status, tag, type]);
  const { data, isPending, isError } = useAdminLines(query);
  const { data: nodes } = useAdminNodes();
  const { data: certificates } = useAdminCertificates();
  const { data: publicSettings } = usePublicSettings();
  const unitConversion = publicSettings?.speedLimitUnitConversionEnabled !== false;
  const { create, update, remove, duplicate, testResolve, batchStatus, reorder, speedtest, speedtestAll } = useLineMutations();
  const lines = data?.data ?? [];
  const allSelected = lines.length > 0 && lines.every((line) => selected.has(line.id));
  const busy = create.isPending || update.isPending;

  const toggleSelected = (id: string, checked: boolean) => {
    setSelected((current) => {
      const next = new Set(current);
      if (checked) next.add(id); else next.delete(id);
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

    const reordered = [...lines];
    const [moved] = reordered.splice(index, 1);
    reordered.splice(targetIndex, 0, moved);

    const payload = reordered
      .map((item, idx) => ({ id: item.id, sortOrder: (idx + 1) * 10 }))
      .filter((item, idx) => lines[idx]?.id !== item.id || lines[idx]?.sortOrder !== item.sortOrder);

    reorder.mutate(payload);
  };

  const openCreate = () => { setEditing(null); setFormOpen(true); };
  const openEdit = (line: AdminLine) => { setEditing(line); setFormOpen(true); };

  if (isPending) return <PageContainer><PageHeader title={t('admin:lines.title')} description={t('admin:lines.subtitle')} /><p className="text-sm text-muted-foreground">{t('common:actions.loading')}</p></PageContainer>;
  if (isError) return <PageContainer><PageHeader title={t('admin:lines.title')} /><EmptyState title={t('admin:lines.emptyLines')} description={t('admin:lines.subtitle')} /></PageContainer>;

  return (
    <PageContainer>
      <PageHeader title={t('admin:lines.title')} description={t('admin:lines.subtitle')} />
      <div className="flex min-w-0 flex-col gap-2 lg:flex-row lg:items-center lg:justify-between">
        <div className="flex flex-1 flex-wrap items-center gap-2">
          <div className="relative w-full min-w-0 flex-1 sm:min-w-52 sm:max-w-xs">
            <Search className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input value={search} onChange={(event) => setSearch(event.target.value)} placeholder={t('admin:nodes.searchPlaceholder')} className="pl-9" />
          </div>
          <Input value={tag} onChange={(event) => setTag(event.target.value)} placeholder={t('admin:lines.filterTag')} className="w-full sm:w-32" />
          <Select value={type} onValueChange={(value) => setType(value as 'ALL' | LineType)}>
            <SelectTrigger className="w-full sm:w-32"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="ALL">{t('admin:lines.typeAll')}</SelectItem>
              <SelectItem value="DIRECT">{t('admin:lines.typeDirect')}</SelectItem>
              <SelectItem value="RELAY">{t('admin:lines.typeRelay')}</SelectItem>
            </SelectContent>
          </Select>
          <Select value={status} onValueChange={(value) => setStatus(value as 'ALL' | LineStatus)}>
            <SelectTrigger className="w-full sm:w-32"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="ALL">{t('admin:lines.statusAll')}</SelectItem>
              <SelectItem value="ACTIVE">{t('admin:lines.statusActive')}</SelectItem>
              <SelectItem value="DISABLED">{t('admin:lines.statusDisabled')}</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="flex w-full flex-col gap-2 sm:flex-row lg:w-auto">
          <Button
            variant="outline"
            disabled={speedtestAll.isPending || !lines.length}
            onClick={() => speedtestAll.mutate()}
            className="w-full sm:w-auto"
          >
            <Activity className={cn('size-4', speedtestAll.isPending && 'animate-spin text-primary')} />
            {speedtestAll.isPending ? t('admin:lines.speedtestingAll') : t('admin:lines.speedtestAll')}
          </Button>
          <Button className="w-full sm:w-auto" onClick={openCreate}><Plus />{t('admin:lines.createLine')}</Button>
        </div>
      </div>
      {selected.size > 0 && (
        <div className="flex flex-wrap items-center gap-2 rounded-md border bg-muted/30 p-3 text-sm">
          <span>{t('admin:lines.selectedCount', { count: selected.size })}</span>
          <Button size="sm" variant="outline" disabled={batchStatus.isPending} onClick={() => batchStatus.mutate({ ids: [...selected], status: 'ACTIVE' }, { onSuccess: () => setSelected(new Set()) })}>
            {t('admin:lines.batchEnable')}
          </Button>
          <Button size="sm" variant="outline" disabled={batchStatus.isPending} onClick={() => batchStatus.mutate({ ids: [...selected], status: 'DISABLED' }, { onSuccess: () => setSelected(new Set()) })}>
            {t('admin:lines.batchDisable')}
          </Button>
        </div>
      )}
      <Card>
        <CardContent className="p-0">
          {lines.length ? (
            <Table className="min-w-[980px]">
              <TableHeader>
                <TableRow>
                  <TableHead className="w-10"><Checkbox checked={allSelected} onCheckedChange={(checked) => toggleAll(checked === true)} aria-label={t('common:table.selectAll')} /></TableHead>
                  <TableHead className="w-16">{t('admin:lines.colOrder')}</TableHead>
                  <TableHead>{t('admin:lines.colLine')}</TableHead>
                  <TableHead>{t('admin:lines.colType')}</TableHead>
                  <TableHead>{t('admin:lines.colEndpoint')}</TableHead>
                  <TableHead>{t('admin:lines.colTopology')}</TableHead>
                  <TableHead>{t('admin:lines.colTagsRate')}</TableHead>
                  <TableHead>
                    <div className="flex items-center gap-1">
                      <span>{t('admin:lines.colLatency')}</span>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <HelpCircle className="size-3.5 text-muted-foreground/70 cursor-help" />
                        </TooltipTrigger>
                        <TooltipContent className="max-w-xs space-y-1 text-xs">
                          <p className="font-semibold">{t('admin:lines.latencyHelpTitle')}</p>
                          <p>{t('admin:lines.latencyHelpDesc')}</p>
                          <p className="text-primary text-[11px]">{t('admin:lines.latencyHelpClick')}</p>
                        </TooltipContent>
                      </Tooltip>
                    </div>
                  </TableHead>
                  <TableHead>{t('admin:lines.colStatus')}</TableHead>
                  <TableHead className="text-right">{t('admin:lines.colActions')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {lines.map((line, index) => (
                  <TableRow key={line.id}>
                    <TableCell><Checkbox checked={selected.has(line.id)} onCheckedChange={(checked) => toggleSelected(line.id, checked === true)} aria-label={`${t('common:actions.select')} ${line.name}`} /></TableCell>
                    <TableCell className="w-16"><span className="font-mono text-xs text-muted-foreground tabular-nums font-medium">#{line.sortOrder}</span></TableCell>
                    <TableCell><div className="font-medium">{line.name}</div><div className="text-xs text-muted-foreground">Lv.{line.level}</div></TableCell>
                    <TableCell><Badge variant="outline" title={line.relayMode === 'TARGET_LINE' ? relayDescription(line) : undefined}>{typeLabels[line.type]}{line.relayMode ? ` · ${relayDescription(line)}` : ''}</Badge></TableCell>
                    <TableCell className="min-w-36"><div className="font-mono text-xs">{line.serverHost}:{line.serverPort}</div><div className="text-xs text-muted-foreground">{line.endpointOverrideEnabled ? t('admin:lines.overrideEnabled') : t('admin:lines.reuseUnderlying')}</div>{line.serverName && <div className="text-xs text-muted-foreground">SNI {line.serverName}</div>}{line.host && <div className="text-xs text-muted-foreground">Host {line.host}</div>}</TableCell>
                    <TableCell>
                      {line.type === 'DIRECT' ? (
                        <>
                          <div>{line.entryNode.name}</div>
                          <div className="text-xs text-muted-foreground">{line.protocolType} · {t('admin:lines.portListen', { port: line.entryPort })}</div>
                        </>
                      ) : line.relayMode === 'TARGET_LINE' ? (
                        <>
                          <div className="flex items-center gap-1">
                            <span>{line.entryNode.name}</span>
                            <span className="text-muted-foreground">➔</span>
                            <span>{line.targetLine?.entryNode.name ?? t('admin:lines.unbound')}</span>
                          </div>
                          <div className="text-xs text-muted-foreground">
                            {line.protocolType} ➔ {line.targetLine?.protocolType ?? t('common:status.unknown')} · {t('admin:lines.portLanding', { port: line.topology.landing?.port ?? line.targetLine?.entryPort ?? '—' })}
                          </div>
                        </>
                      ) : (
                        <>
                          <div className="flex items-center gap-1">
                            <span>{line.entryNode.name}</span>
                            <span className="text-muted-foreground">➔</span>
                            <span>{line.landingNode?.name ?? t('admin:lines.unbound')}</span>
                          </div>
                          <div className="text-xs text-muted-foreground">
                            {line.protocolType} · {t('admin:lines.portLanding', { port: line.topology.landing?.port ?? line.landingPort ?? '—' })}
                          </div>
                        </>
                      )}
                    </TableCell>
                    <TableCell><div className="flex max-w-40 flex-wrap gap-1">{Boolean(line.speedLimitMbps) && <Badge variant="outline" className={cn('gap-1', getSpeedTierBadgeClass(line.speedLimitMbps, publicSettings?.speedLimitColorTiers))}><Zap className="size-3" />{formatSpeedLimit(line.speedLimitMbps, unitConversion)}</Badge>}{line.tags.map((item) => <Badge key={item} variant="secondary">#{item}</Badge>)}<Badge variant="outline">{line.trafficRate}x</Badge></div></TableCell>
                    <TableCell>
                      <LineLatencyChip
                        latencyMs={line.lastLatencyMs}
                        status={line.lastTestStatus}
                        message={line.lastTestMessage}
                        testedAt={line.lastTestedAt}
                        onClick={() => setSpeedtestingLine(line)}
                      />
                    </TableCell>
                    <TableCell><div className="flex flex-col items-start gap-1"><Badge variant={line.status === 'ACTIVE' ? 'default' : 'secondary'}>{line.status === 'ACTIVE' ? t('admin:lines.statusActive') : t('admin:lines.statusDisabled')}</Badge>{!line.isPublic && <span className="text-xs text-muted-foreground">{t('admin:lines.privateLine')}</span>}</div></TableCell>
                    <TableCell>
                      <div className="flex justify-end gap-1">
                        <IconButton variant="ghost" size="icon-sm" aria-label={t('admin:lines.moveUp')} disabled={index === 0 || reorder.isPending} onClick={() => move(line, -1)}><ArrowUp /></IconButton>
                        <IconButton variant="ghost" size="icon-sm" aria-label={t('admin:lines.moveDown')} disabled={index === lines.length - 1 || reorder.isPending} onClick={() => move(line, 1)}><ArrowDown /></IconButton>
                        <IconButton variant="ghost" size="icon-sm" aria-label={t('admin:lines.instantSpeedtest')} tooltip={t('admin:lines.instantSpeedtestTitle')} disabled={speedtest.isPending && speedtest.variables === line.id} onClick={() => setSpeedtestingLine(line)}><Activity className={cn('size-4', speedtest.isPending && speedtest.variables === line.id && 'animate-spin text-primary')} /></IconButton>
                        <IconButton variant="ghost" size="icon-sm" aria-label={t('admin:lines.testResolve')} disabled={testResolve.isPending} onClick={() => testResolve.mutate(line.id)}><Zap /></IconButton>
                        <IconButton variant="ghost" size="icon-sm" aria-label={t('admin:lines.duplicateLine')} disabled={duplicate.isPending} onClick={() => duplicate.mutate(line.id)}><Copy /></IconButton>
                        <IconButton variant="ghost" size="icon-sm" aria-label={t('admin:lines.editLine')} onClick={() => openEdit(line)}><Pencil /></IconButton>
                        <IconButton variant="ghost" size="icon-sm" aria-label={t('admin:lines.deleteLine')} onClick={() => setDeleting(line)}><Trash2 className="text-destructive" /></IconButton>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          ) : (
            <EmptyState title={t('admin:lines.emptyLines')} description={t('admin:lines.subtitle')} className="border-0" />
          )}
        </CardContent>
      </Card>
      <LineFormDialog open={formOpen} onOpenChange={(open) => { setFormOpen(open); if (!open) setInitialUpstreamNode(null); }} line={editing} initialUpstreamNode={initialUpstreamNode} nodes={nodes ?? []} lines={lines} certificates={certificates?.data ?? []} pending={busy} onSubmit={(payload) => editing ? update.mutate({ id: editing.id, ...payload }, { onSuccess: () => { setFormOpen(false); setInitialUpstreamNode(null); } }) : create.mutate(payload, { onSuccess: () => { setFormOpen(false); setInitialUpstreamNode(null); } })} />
      <LineSpeedtestDialog open={!!speedtestingLine} onOpenChange={(open) => !open && setSpeedtestingLine(null)} line={speedtestingLine} />
      <AlertDialog open={!!deleting} onOpenChange={(open) => !open && setDeleting(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('admin:lines.deleteDialogTitle', { name: deleting?.name ?? '' })}</AlertDialogTitle>
            <AlertDialogDescription>{t('admin:lines.deleteDialogDesc')}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common:actions.cancel')}</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={() => deleting && remove.mutate(deleting.id, { onSuccess: () => setDeleting(null) })}>
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
          <span>{t('admin:lines.footerSpeedtestNote')}</span>
        </div>
      </div>
    </PageContainer>
  );
}
