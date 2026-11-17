import * as React from 'react';
import { useLocation, useSearchParams } from 'react-router-dom';
import { Activity, GitBranch } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { ApiUpstreamNode, LineStatus, LineType } from '@/lib/api';
import { certificateReturnPath } from '@/lib/certificate-navigation';
import { usePublicSettings } from '@/lib/public-settings';
import { CertificateReturnLink } from '@/components/shared/certificate-return-link';
import { ServerPagination } from '@/components/shared/server-pagination';
import { PageContainer, PageHeader } from '@/components/shared/page-container';
import { ProbeTaskDialog } from '@/components/shared/probe-task-dialog';
import { Button } from '@/components/ui/button';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog';
import { useAdminNodes } from '../nodes/use-nodes';
import { useAdminCertificates } from '../certificates/use-certificates';
import { useAdminLines, useLineMutations, type AdminLine } from './use-lines';
import { LinkedLineDialog } from './components/linked-line-dialog';
import { LineFormDialog } from './components/line-form-dialog';
import { LineSpeedtestDialog } from './components/line-speedtest-dialog';
import { LineCredentialsDialog } from './components/line-credentials-dialog';
import { LinesToolbar } from './components/lines-toolbar';
import { LinesTable } from './components/lines-table';
import { isCredentialLine } from './line-credentials-contract';

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
  const [credentialsLineId, setCredentialsLineId] = React.useState<string | null>(null);
  const [initialUpstreamNode, setInitialUpstreamNode] = React.useState<ApiUpstreamNode | null>(null);
  const location = useLocation();
  const [linkParams, setLinkParams] = useSearchParams();
  const linkedLineId = linkParams.get('lineId');
  const closeLinkedLine = () => setLinkParams(current => { const next = new URLSearchParams(current); next.delete('lineId'); next.delete('edit'); return next; }, { replace: true, state: location.state });

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
  const credentialsLine = lines.find(line => line.id === credentialsLineId);
  const credentialsLineRemoved = Boolean(credentialsLineId && data && (!credentialsLine || !isCredentialLine(credentialsLine)));
  React.useEffect(() => { if (credentialsLineRemoved) setCredentialsLineId(null); }, [credentialsLineRemoved]);
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

  return (
    <PageContainer>
      <CertificateReturnLink />
      <PageHeader title={t('admin:lines.title')} description={t('admin:lines.subtitle')} />
      {isPending && <p className="text-sm text-muted-foreground">{t('common:actions.loading')}</p>}
      {isError && <p className="text-sm text-destructive">{t('admin:certificateManagement.lineUnavailable')}</p>}
      {linkedLineId && <LinkedLineDialog key={linkedLineId + location.key} id={linkedLineId} edit={linkParams.get('edit') === '1'} returnTo={certificateReturnPath(location.state)} onClose={closeLinkedLine} onEdit={line => { closeLinkedLine(); openEdit(line); }} />}

      <LinesToolbar
        search={search} tag={tag} type={type} status={status} hasLines={lines.length > 0}
        onSearchChange={value => { setSearch(value); setPage(1); }}
        onTagChange={value => { setTag(value); setPage(1); }}
        onTypeChange={value => { setType(value); setPage(1); }}
        onStatusChange={value => { setStatus(value); setPage(1); }}
        onCreate={openCreate} onProbeAll={() => setBatchProbeOpen(true)}
      />

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

      <LinesTable
        lines={lines} selected={selected} unitConversion={unitConversion}
        speedLimitColorTiers={publicSettings?.speedLimitColorTiers}
        onToggleAll={toggleAll} onToggleSelected={toggleSelected}
        onStatusChange={(id, nextStatus) => batchStatus.mutate({ ids: [id], status: nextStatus })}
        onSpeedtest={setSpeedtestingLine}
        actions={{
          resolving: testResolve.isPending, duplicating: duplicate.isPending, reordering: reorder.isPending,
          onSpeedtest: setSpeedtestingLine, onEdit: openEdit, onDelete: setDeleting,
          onCredentials: line => setCredentialsLineId(line.id),
          onResolve: id => testResolve.mutate(id), onDuplicate: id => duplicate.mutate(id), onMove: move
        }}
      />

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

      {credentialsLine && <LineCredentialsDialog
        key={credentialsLine.id} line={credentialsLine} open
        onOpenChange={open => { if (!open) setCredentialsLineId(null); }}
      />}

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
