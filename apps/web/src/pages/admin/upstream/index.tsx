import * as React from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow
} from '@/components/ui/table';
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select';
import {
  Activity,
  ArrowRight,
  Database,
  ExternalLink,
  Layers,
  Plus,
  RefreshCw,
  Search,
  Trash2,
  Edit
} from 'lucide-react';
import { ApiUpstreamSubscription, ApiUpstreamNode } from '@/lib/api';
import { useAdminUpstreams, useAdminUpstreamMutations } from './use-upstream';
import { UpstreamFormDialog, UpstreamFormSubmitValues } from './components/upstream-form-dialog';
import { UpstreamNodesSheet } from './components/upstream-nodes-sheet';

export default function AdminUpstreamPage() {
  const { t } = useTranslation(['admin', 'common']);
  const navigate = useNavigate();

  const [search, setSearch] = React.useState('');
  const [status, setStatus] = React.useState<string>('ALL');
  const [formOpen, setFormOpen] = React.useState(false);
  const [editingSub, setEditingSub] = React.useState<ApiUpstreamSubscription | null>(null);
  const [nodesSheetOpen, setNodesSheetOpen] = React.useState(false);
  const [selectedSubForNodes, setSelectedSubForNodes] = React.useState<ApiUpstreamSubscription | null>(null);
  const [deletingSub, setDeletingSub] = React.useState<ApiUpstreamSubscription | null>(null);

  const query = React.useMemo(() => ({
    search: search.trim() || undefined,
    status: status !== 'ALL' ? status : undefined,
    pageSize: 50
  }), [search, status]);

  const { data, isLoading } = useAdminUpstreams(query);
  const {
    createMutation,
    updateMutation,
    deleteMutation,
    syncMutation
  } = useAdminUpstreamMutations();

  const subscriptions = data?.data ?? [];
  const totalNodesCount = subscriptions.reduce((sum, s) => sum + s.nodeCount, 0);

  const handleCreate = () => {
    setEditingSub(null);
    setFormOpen(true);
  };

  const handleEdit = (sub: ApiUpstreamSubscription) => {
    setEditingSub(sub);
    setFormOpen(true);
  };

  const handleFormSubmit = (values: UpstreamFormSubmitValues) => {
    if (editingSub) {
      updateMutation.mutate({ id: editingSub.id, data: values }, {
        onSuccess: () => setFormOpen(false)
      });
    } else {
      createMutation.mutate(values, {
        onSuccess: () => setFormOpen(false)
      });
    }
  };

  const handleOpenNodes = (sub: ApiUpstreamSubscription) => {
    setSelectedSubForNodes(sub);
    setNodesSheetOpen(true);
  };

  const handleCreateRelayLineFromNode = (node: ApiUpstreamNode) => {
    setNodesSheetOpen(false);
    navigate('/admin/lines', { state: { createUpstreamNode: node } });
  };

  return (
    <div className="space-y-6">
      {/* 页头 */}
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">{t('admin:upstream.title')}</h1>
          <p className="text-muted-foreground text-sm">{t('admin:upstream.subtitle')}</p>
        </div>
        <Button onClick={handleCreate} className="shrink-0">
          <Plus className="h-4 w-4 mr-1" />
          {t('admin:upstream.addSubscription')}
        </Button>
      </div>

      {/* 指标卡片 */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <div className="rounded-lg border bg-card p-4 text-card-foreground shadow-sm flex items-center gap-3">
          <div className="p-2.5 bg-primary/10 text-primary rounded-md">
            <Layers className="h-5 w-5" />
          </div>
          <div>
            <div className="text-sm font-medium text-muted-foreground">{t('admin:upstream.colName')}</div>
            <div className="text-2xl font-bold">{subscriptions.length}</div>
          </div>
        </div>

        <div className="rounded-lg border bg-card p-4 text-card-foreground shadow-sm flex items-center gap-3">
          <div className="p-2.5 bg-emerald-500/10 text-emerald-500 rounded-md">
            <Database className="h-5 w-5" />
          </div>
          <div>
            <div className="text-sm font-medium text-muted-foreground">{t('admin:upstream.nodesTitle')}</div>
            <div className="text-2xl font-bold">{totalNodesCount}</div>
          </div>
        </div>

        <div className="rounded-lg border bg-card p-4 text-card-foreground shadow-sm flex items-center gap-3">
          <div className="p-2.5 bg-blue-500/10 text-blue-500 rounded-md">
            <Activity className="h-5 w-5" />
          </div>
          <div>
            <div className="text-sm font-medium text-muted-foreground">{t('admin:upstream.autoUpdate')}</div>
            <div className="text-2xl font-bold">
              {subscriptions.filter((s) => s.autoUpdate && s.status === 'ACTIVE').length} / {subscriptions.length}
            </div>
          </div>
        </div>
      </div>

      {/* 搜索与筛选工具栏 */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2 flex-1 max-w-sm">
          <div className="relative w-full">
            <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder={t('admin:upstream.searchPlaceholder')}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="pl-8"
            />
          </div>
        </div>

        <div className="flex items-center gap-2">
          <Select value={status} onValueChange={setStatus}>
            <SelectTrigger className="w-[120px]">
              <SelectValue placeholder={t('admin:upstream.filterStatus')} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="ALL">{t('admin:upstream.statusAll')}</SelectItem>
              <SelectItem value="ACTIVE">{t('admin:upstream.statusActive')}</SelectItem>
              <SelectItem value="DISABLED">{t('admin:upstream.statusDisabled')}</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      {/* 订阅表格 */}
      <div className="rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t('admin:upstream.colName')}</TableHead>
              <TableHead>{t('admin:upstream.colType')}</TableHead>
              <TableHead>{t('admin:upstream.colNodes')}</TableHead>
              <TableHead>{t('admin:upstream.colQuota')}</TableHead>
              <TableHead>{t('admin:upstream.colLastSync')}</TableHead>
              <TableHead>{t('admin:upstream.colStatus')}</TableHead>
              <TableHead className="text-right">{t('admin:upstream.colActions')}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              <TableRow>
                <TableCell colSpan={7} className="h-24 text-center">
                  {t('common:actions.loading')}
                </TableCell>
              </TableRow>
            ) : subscriptions.length === 0 ? (
              <TableRow>
                <TableCell colSpan={7} className="h-24 text-center text-muted-foreground">
                  {t('admin:upstream.emptyTitle')}
                </TableCell>
              </TableRow>
            ) : (
              subscriptions.map((sub) => (
                <TableRow key={sub.id}>
                  <TableCell className="font-medium">
                    <div className="flex flex-col gap-0.5">
                      <span>{sub.name}</span>
                      {sub.url && (
                        <span className="text-xs text-muted-foreground truncate max-w-xs font-mono" title={sub.url}>
                          {sub.url}
                        </span>
                      )}
                    </div>
                  </TableCell>

                  <TableCell>
                    <div className="flex items-center gap-1.5">
                      <Badge variant="outline">{sub.sourceType}</Badge>
                      <Badge variant="secondary">{sub.format}</Badge>
                    </div>
                  </TableCell>

                  <TableCell>
                    <Button
                      variant="link"
                      className="p-0 h-auto font-medium"
                      onClick={() => handleOpenNodes(sub)}
                    >
                      {sub.nodeCount} {t('admin:upstream.nodesTitle')}
                      <ArrowRight className="h-3 w-3 ml-0.5" />
                    </Button>
                  </TableCell>

                  <TableCell className="text-xs text-muted-foreground">
                    {sub.userInfoTotalBytes !== null && sub.userInfoTotalBytes > 0 ? (
                      <span>
                        {(sub.userInfoUsedBytes ?? 0) > 0
                          ? `${((sub.userInfoUsedBytes ?? 0) / (1024 * 1024 * 1024)).toFixed(1)} GB / `
                          : ''}
                        {(sub.userInfoTotalBytes / (1024 * 1024 * 1024)).toFixed(0)} GB
                      </span>
                    ) : (
                      <span>{t('admin:upstream.unlimited')}</span>
                    )}
                  </TableCell>

                  <TableCell>
                    <div className="flex flex-col gap-0.5 text-xs">
                      {sub.lastSyncStatus === 'SUCCESS' ? (
                        <span className="text-emerald-600 dark:text-emerald-400 font-medium">
                          {sub.lastSyncAt ? new Date(sub.lastSyncAt).toLocaleString() : t('admin:upstream.never')}
                        </span>
                      ) : sub.lastSyncStatus === 'FAILED' ? (
                        <span className="text-rose-600 dark:text-rose-400 font-medium" title={sub.lastSyncMessage || ''}>
                          {t('admin:upstream.syncFailed')}
                        </span>
                      ) : (
                        <span className="text-muted-foreground">{t('admin:upstream.never')}</span>
                      )}
                      {sub.autoUpdate && (
                        <span className="text-muted-foreground">
                          {Math.round(sub.updateIntervalMins / 60)}h {t('admin:upstream.autoUpdate')}
                        </span>
                      )}
                    </div>
                  </TableCell>

                  <TableCell>
                    <Badge variant={sub.status === 'ACTIVE' ? 'default' : 'secondary'}>
                      {sub.status === 'ACTIVE' ? t('admin:upstream.statusActive') : t('admin:upstream.statusDisabled')}
                    </Badge>
                  </TableCell>

                  <TableCell className="text-right">
                    <div className="flex items-center justify-end gap-1">
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8"
                        onClick={() => syncMutation.mutate(sub.id)}
                        disabled={syncMutation.isPending}
                        title={t('admin:upstream.syncNow')}
                      >
                        <RefreshCw className={`h-4 w-4 ${syncMutation.isPending ? 'animate-spin' : ''}`} />
                      </Button>

                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8"
                        onClick={() => handleOpenNodes(sub)}
                        title={t('admin:upstream.nodesTitle')}
                      >
                        <ExternalLink className="h-4 w-4" />
                      </Button>

                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8"
                        onClick={() => handleEdit(sub)}
                        title={t('common:actions.edit')}
                      >
                        <Edit className="h-4 w-4" />
                      </Button>

                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8 text-destructive"
                        onClick={() => setDeletingSub(sub)}
                        title={t('common:actions.delete')}
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      {/* 表单弹窗 */}
      <UpstreamFormDialog
        open={formOpen}
        onOpenChange={setFormOpen}
        current={editingSub}
        onSubmit={handleFormSubmit}
        isPending={createMutation.isPending || updateMutation.isPending}
      />

      {/* 节点列表抽屉 */}
      <UpstreamNodesSheet
        open={nodesSheetOpen}
        onOpenChange={setNodesSheetOpen}
        subscription={selectedSubForNodes}
        onCreateRelayLine={handleCreateRelayLineFromNode}
      />

      {/* 删除确认弹窗 */}
      <AlertDialog open={Boolean(deletingSub)} onOpenChange={(open) => !open && setDeletingSub(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t('admin:upstream.deleteTitle', { name: deletingSub?.name ?? '' })}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t('admin:upstream.deleteDesc')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common:actions.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => {
                if (deletingSub) {
                  deleteMutation.mutate(deletingSub.id);
                  setDeletingSub(null);
                }
              }}
            >
              {t('common:actions.delete')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
