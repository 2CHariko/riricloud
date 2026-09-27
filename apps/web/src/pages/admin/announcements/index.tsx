import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  AlertCircle,
  Edit,
  Flame,
  Info,
  Pin,
  Plus,
  Search,
  Trash2,
  Wrench
} from 'lucide-react';
import { PageContainer, PageHeader } from '@/components/shared/page-container';
import { EmptyState } from '@/components/shared/empty-state';
import { Button } from '@/components/ui/button';
import { IconButton } from '@/components/ui/icon-button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger
} from '@/components/ui/alert-dialog';
import { formatDateTime } from '@/lib/utils';
import {
  type AnnouncementItem,
  type AnnouncementType,
  getAnnouncementTypeBadgeClass,
  stripMarkdownPreview
} from '@/lib/announcements';
import {
  type AdminAnnouncementPayload,
  useAdminAnnouncementMutations,
  useAdminAnnouncements
} from './use-admin-announcements';
import { AnnouncementEditorDialog } from './components/announcement-editor-dialog';

function getTypeIconComponent(type: AnnouncementType) {
  switch (type) {
    case 'URGENT':
      return AlertCircle;
    case 'MAINTENANCE':
      return Wrench;
    case 'EVENT':
      return Flame;
    case 'NOTICE':
    default:
      return Info;
  }
}

export default function AdminAnnouncementsPage() {
  const { t } = useTranslation(['admin', 'common', 'user']);
  const [typeFilter, setTypeFilter] = useState('ALL');
  const [statusFilter, setStatusFilter] = useState('ALL');
  const [searchKeyword, setSearchKeyword] = useState('');

  const [editorOpen, setEditorOpen] = useState(false);
  const [editingItem, setEditingItem] = useState<AnnouncementItem | null>(null);

  const { data: announcements = [], isLoading } = useAdminAnnouncements({
    type: typeFilter !== 'ALL' ? typeFilter : undefined,
    status: statusFilter !== 'ALL' ? statusFilter : undefined,
    keyword: searchKeyword ? searchKeyword.trim() : undefined
  });

  const {
    createMutation,
    updateMutation,
    deleteMutation,
    toggleStatusMutation
  } = useAdminAnnouncementMutations();

  const handleOpenCreate = () => {
    setEditingItem(null);
    setEditorOpen(true);
  };

  const handleOpenEdit = (item: AnnouncementItem) => {
    setEditingItem(item);
    setEditorOpen(true);
  };

  const handleSave = (payload: AdminAnnouncementPayload) => {
    if (editingItem && editingItem.id) {
      updateMutation.mutate(
        { id: editingItem.id, payload },
        { onSuccess: () => setEditorOpen(false) }
      );
    } else {
      createMutation.mutate(payload, {
        onSuccess: () => setEditorOpen(false)
      });
    }
  };

  const handleToggleStatus = (item: AnnouncementItem, enabled: boolean) => {
    toggleStatusMutation.mutate({
      id: item.id,
      enabled
    });
  };

  return (
    <PageContainer>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <PageHeader
          title={t('admin:announcements.title')}
          description={t('admin:announcements.subtitle')}
        />
        <div className="flex items-center gap-2 shrink-0">
          <Button size="sm" className="gap-1.5 shadow-xs" onClick={handleOpenCreate}>
            <Plus className="size-4" />
            <span>{t('admin:announcements.newAnnouncement')}</span>
          </Button>
        </div>
      </div>

      {/* 顶部工具栏过滤 */}
      <div className="flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-3 p-3 rounded-xl border border-border bg-card shadow-2xs">
        <div className="flex flex-wrap items-center gap-2">
          <Select value={typeFilter} onValueChange={setTypeFilter}>
            <SelectTrigger className="w-[140px] h-8 text-xs">
              <SelectValue placeholder={t('admin:announcements.type')} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="ALL">{t('admin:announcements.types.all')}</SelectItem>
              <SelectItem value="NOTICE">{t('admin:announcements.types.NOTICE')}</SelectItem>
              <SelectItem value="MAINTENANCE">{t('admin:announcements.types.MAINTENANCE')}</SelectItem>
              <SelectItem value="EVENT">{t('admin:announcements.types.EVENT')}</SelectItem>
              <SelectItem value="URGENT">{t('admin:announcements.types.URGENT')}</SelectItem>
            </SelectContent>
          </Select>

          <Select value={statusFilter} onValueChange={setStatusFilter}>
            <SelectTrigger className="w-[120px] h-8 text-xs">
              <SelectValue placeholder={t('admin:announcements.allStatuses')} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="ALL">{t('admin:announcements.allStatuses')}</SelectItem>
              <SelectItem value="ACTIVE">{t('admin:announcements.statusActive')}</SelectItem>
              <SelectItem value="DISABLED">{t('admin:announcements.statusDisabled')}</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div className="relative w-full sm:w-64">
          <Search className="absolute left-2.5 top-2.5 size-3.5 text-muted-foreground" />
          <Input
            value={searchKeyword}
            onChange={(e) => setSearchKeyword(e.target.value)}
            placeholder={t('admin:announcements.searchPlaceholder')}
            className="pl-8 h-8 text-xs"
          />
        </div>
      </div>

      {/* 公告列表表格 */}
      <div className="rounded-xl border border-border bg-card shadow-2xs overflow-hidden">
        {isLoading ? (
          <div className="py-20 text-center text-xs text-muted-foreground">
            {t('admin:announcements.loading')}
          </div>
        ) : announcements.length === 0 ? (
          <EmptyState
            title={t('admin:announcements.emptyTitle')}
            description={t('admin:announcements.emptyDesc')}
            action={
              <Button size="sm" variant="outline" onClick={handleOpenCreate} className="gap-1.5 text-xs">
                <Plus className="size-3.5" />
                <span>{t('admin:announcements.createNow')}</span>
              </Button>
            }
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs border-collapse">
              <thead>
                <tr className="border-b border-border bg-muted/40 font-semibold text-muted-foreground">
                  <th className="py-3 px-4">{t('admin:announcements.table.titleSummary')}</th>
                  <th className="py-3 px-4">{t('admin:announcements.table.type')}</th>
                  <th className="py-3 px-4">{t('admin:announcements.table.strategies')}</th>
                  <th className="py-3 px-4">{t('admin:announcements.table.status')}</th>
                  <th className="py-3 px-4">{t('admin:announcements.table.updatedAt')}</th>
                  <th className="py-3 px-4 text-right">{t('admin:announcements.table.actions')}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/60">
                {announcements.map((item) => {
                  const IconComp = getTypeIconComponent(item.type);
                  const preview = stripMarkdownPreview(item.content);
                  const displayTime = item.updatedAt || item.createdAt;

                  return (
                    <tr key={item.id} className="hover:bg-muted/30 transition-colors">
                      <td className="py-3 px-4 max-w-[340px]">
                        <div className="flex items-start gap-2.5">
                          <span className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-md bg-muted text-foreground/80">
                            <IconComp className="size-3.5" />
                          </span>
                          <div className="min-w-0">
                            <div className="flex items-center gap-1.5">
                              {item.isPinned && (
                                <Pin className="size-3 text-primary shrink-0" />
                              )}
                              <div className="font-semibold text-foreground truncate" title={item.title}>
                                {item.title}
                              </div>
                            </div>
                            {preview && (
                              <div className="text-[11px] text-muted-foreground truncate mt-0.5" title={preview}>
                                {preview}
                              </div>
                            )}
                          </div>
                        </div>
                      </td>

                      <td className="py-3 px-4 whitespace-nowrap">
                        <Badge
                          variant="outline"
                          className={`text-[10px] px-1.5 py-0 h-4 font-normal ${getAnnouncementTypeBadgeClass(item.type)}`}
                        >
                          {t(`admin:announcements.types.${item.type}`)}
                        </Badge>
                      </td>

                      <td className="py-3 px-4 whitespace-nowrap">
                        <div className="flex flex-wrap items-center gap-1.5">
                          {item.isPinned && (
                            <Badge variant="secondary" className="text-[10px] px-1.5 py-0 h-4 font-normal">
                              {t('admin:announcements.table.pinned')}
                            </Badge>
                          )}
                          {item.showBanner && (
                            <Badge variant="outline" className="text-[10px] px-1.5 py-0 h-4 font-normal border-primary/30 text-primary">
                              {t('admin:announcements.table.banner')}
                            </Badge>
                          )}
                          {item.popupOnLogin && (
                            <Badge variant="outline" className="text-[10px] px-1.5 py-0 h-4 font-normal border-rose-500/30 text-rose-600 dark:text-rose-400">
                              {t('admin:announcements.table.popup')}
                            </Badge>
                          )}
                          {!item.isPinned && !item.showBanner && !item.popupOnLogin && (
                            <span className="text-muted-foreground">—</span>
                          )}
                        </div>
                      </td>

                      <td className="py-3 px-4 whitespace-nowrap">
                        <div className="flex items-center gap-2">
                          <Switch
                            checked={item.enabled}
                            onCheckedChange={(checked) => handleToggleStatus(item, checked)}
                          />
                          <span className={item.enabled ? 'text-emerald-600 dark:text-emerald-400 font-medium' : 'text-muted-foreground'}>
                            {item.enabled
                              ? t('admin:announcements.statusActive')
                              : t('admin:announcements.statusDisabled')}
                          </span>
                        </div>
                      </td>

                      <td className="py-3 px-4 whitespace-nowrap text-muted-foreground font-mono">
                        {displayTime && displayTime.includes('T') ? formatDateTime(displayTime) : '—'}
                      </td>

                      <td className="py-3 px-4 text-right whitespace-nowrap">
                        <div className="inline-flex items-center justify-end gap-1">
                          <IconButton
                            variant="ghost"
                            size="icon-xs"
                            className="h-7 w-7 text-muted-foreground hover:text-foreground"
                            onClick={() => handleOpenEdit(item)}
                            title={t('admin:announcements.edit')}
                            aria-label={t('admin:announcements.edit')}
                          >
                            <Edit className="size-3.5" />
                          </IconButton>

                          <AlertDialog>
                            <AlertDialogTrigger asChild>
                              <IconButton
                                variant="ghost"
                                size="icon-xs"
                                className="h-7 w-7 text-muted-foreground hover:text-destructive"
                                title={t('admin:announcements.delete')}
                                aria-label={t('admin:announcements.delete')}
                              >
                                <Trash2 className="size-3.5" />
                              </IconButton>
                            </AlertDialogTrigger>
                            <AlertDialogContent>
                              <AlertDialogHeader>
                                <AlertDialogTitle>
                                  {t('admin:announcements.deleteConfirmTitle')}
                                </AlertDialogTitle>
                                <AlertDialogDescription>
                                  {t('admin:announcements.deleteConfirm', { title: item.title })}
                                </AlertDialogDescription>
                              </AlertDialogHeader>
                              <AlertDialogFooter>
                                <AlertDialogCancel>{t('common:actions.cancel')}</AlertDialogCancel>
                                <AlertDialogAction
                                  className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                                  onClick={() => deleteMutation.mutate(item.id)}
                                >
                                  {t('admin:announcements.delete')}
                                </AlertDialogAction>
                              </AlertDialogFooter>
                            </AlertDialogContent>
                          </AlertDialog>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* 编辑器对话框 */}
      <AnnouncementEditorDialog
        open={editorOpen}
        onOpenChange={setEditorOpen}
        announcement={editingItem}
        onSave={handleSave}
        isSaving={createMutation.isPending || updateMutation.isPending}
      />
    </PageContainer>
  );
}
