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
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
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
      <PageHeader
        title={t('admin:announcements.title')}
        description={t('admin:announcements.subtitle')}
      />

      {/* 顶部工具栏过滤 */}
      <div className="flex min-w-0 flex-col gap-2 lg:flex-row lg:items-center lg:justify-between">
        <div className="flex flex-1 flex-wrap items-center gap-2">
          <div className="relative w-full min-w-0 flex-1 sm:min-w-52 sm:max-w-xs">
            <Search className="pointer-events-none absolute left-3 top-2.5 size-4 text-muted-foreground" />
            <Input
              type="search"
              value={searchKeyword}
              onChange={(e) => setSearchKeyword(e.target.value)}
              placeholder={t('admin:announcements.searchPlaceholder')}
              className="pl-9"
            />
          </div>

          <Select value={typeFilter} onValueChange={setTypeFilter}>
            <SelectTrigger className="w-full sm:w-36">
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
            <SelectTrigger className="w-full sm:w-32">
              <SelectValue placeholder={t('admin:announcements.allStatuses')} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="ALL">{t('admin:announcements.allStatuses')}</SelectItem>
              <SelectItem value="ACTIVE">{t('admin:announcements.statusActive')}</SelectItem>
              <SelectItem value="DISABLED">{t('admin:announcements.statusDisabled')}</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div className="flex w-full flex-wrap gap-2 sm:flex-nowrap lg:w-auto">
          <Button className="w-full sm:w-auto" onClick={handleOpenCreate}>
            <Plus className="size-4" />
            <span>{t('admin:announcements.newAnnouncement')}</span>
          </Button>
        </div>
      </div>

      {/* 公告列表表格 */}
      <Card>
        <CardContent className="min-w-0 p-0">
          {isLoading ? (
            <div className="space-y-3 p-4">
              <Skeleton className="h-8 w-full" />
              <Skeleton className="h-12 w-full" />
              <Skeleton className="h-12 w-full" />
            </div>
          ) : announcements.length === 0 ? (
            <EmptyState
              title={t('admin:announcements.emptyTitle')}
              description={t('admin:announcements.emptyDesc')}
              className="border-0"
              action={
                <Button size="sm" variant="outline" onClick={handleOpenCreate} className="gap-1.5">
                  <Plus className="size-4" />
                  <span>{t('admin:announcements.createNow')}</span>
                </Button>
              }
            />
          ) : (
            <Table className="min-w-[800px]">
              <TableHeader>
                <TableRow>
                  <TableHead className="w-[34%]">{t('admin:announcements.table.titleSummary')}</TableHead>
                  <TableHead>{t('admin:announcements.table.type')}</TableHead>
                  <TableHead>{t('admin:announcements.table.strategies')}</TableHead>
                  <TableHead>{t('admin:announcements.table.status')}</TableHead>
                  <TableHead>{t('admin:announcements.table.updatedAt')}</TableHead>
                  <TableHead className="text-right">{t('admin:announcements.table.actions')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {announcements.map((item) => {
                  const IconComp = getTypeIconComponent(item.type);
                  const preview = stripMarkdownPreview(item.content);
                  const displayTime = item.updatedAt || item.createdAt;

                  return (
                    <TableRow key={item.id}>
                      <TableCell className="max-w-[340px]">
                        <div className="flex items-start gap-2.5">
                          <span className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-md bg-muted text-foreground/80">
                            <IconComp className="size-3.5" />
                          </span>
                          <div className="min-w-0 space-y-0.5">
                            <div className="flex items-center gap-1.5">
                              {item.isPinned && (
                                <Pin className="size-3.5 text-primary shrink-0" />
                              )}
                              <div className="font-medium text-foreground truncate" title={item.title}>
                                {item.title}
                              </div>
                            </div>
                            {preview && (
                              <div className="text-xs text-muted-foreground truncate" title={preview}>
                                {preview}
                              </div>
                            )}
                          </div>
                        </div>
                      </TableCell>

                      <TableCell className="whitespace-nowrap">
                        <Badge
                          variant="outline"
                          className={getAnnouncementTypeBadgeClass(item.type)}
                        >
                          {t(`admin:announcements.types.${item.type}`)}
                        </Badge>
                      </TableCell>

                      <TableCell className="whitespace-nowrap">
                        <div className="flex flex-wrap items-center gap-1.5">
                          {item.isPinned && (
                            <Badge variant="secondary">
                              {t('admin:announcements.table.pinned')}
                            </Badge>
                          )}
                          {item.showBanner && (
                            <Badge variant="outline" className="border-primary/30 text-primary">
                              {t('admin:announcements.table.banner')}
                            </Badge>
                          )}
                          {item.popupOnLogin && (
                            <Badge variant="outline" className="border-rose-500/30 text-rose-600 dark:text-rose-400">
                              {t('admin:announcements.table.popup')}
                            </Badge>
                          )}
                          {!item.isPinned && !item.showBanner && !item.popupOnLogin && (
                            <span className="text-xs text-muted-foreground">—</span>
                          )}
                        </div>
                      </TableCell>

                      <TableCell className="whitespace-nowrap">
                        <div className="flex items-center gap-2">
                          <Switch
                            checked={item.enabled}
                            onCheckedChange={(checked) => handleToggleStatus(item, checked)}
                          />
                          <span className={item.enabled ? 'text-xs text-emerald-600 dark:text-emerald-400 font-medium' : 'text-xs text-muted-foreground'}>
                            {item.enabled
                              ? t('admin:announcements.statusActive')
                              : t('admin:announcements.statusDisabled')}
                          </span>
                        </div>
                      </TableCell>

                      <TableCell className="whitespace-nowrap text-xs text-muted-foreground tabular-nums">
                        {displayTime && displayTime.includes('T') ? formatDateTime(displayTime) : '—'}
                      </TableCell>

                      <TableCell className="text-right whitespace-nowrap">
                        <div className="inline-flex items-center justify-end gap-1">
                          <IconButton
                            variant="ghost"
                            size="icon-sm"
                            onClick={() => handleOpenEdit(item)}
                            title={t('admin:announcements.edit')}
                            aria-label={t('admin:announcements.edit')}
                          >
                            <Edit className="size-4" />
                          </IconButton>

                          <AlertDialog>
                            <AlertDialogTrigger asChild>
                              <IconButton
                                variant="ghost"
                                size="icon-sm"
                                title={t('admin:announcements.delete')}
                                aria-label={t('admin:announcements.delete')}
                              >
                                <Trash2 className="size-4 text-destructive" />
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
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

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
