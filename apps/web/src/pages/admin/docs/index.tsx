import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Copy,
  Edit,
  Plus,
  Search,
  Trash2
} from 'lucide-react';
import { toast } from 'sonner';
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
  type AdminHelpArticle,
  type AdminHelpArticlePayload,
  useAdminHelpArticles,
  useAdminHelpMutations
} from './use-admin-docs';
import { DocEditorDialog } from './components/doc-editor-dialog';
import { ResetDefaultsDialog } from './components/reset-defaults-dialog';
import { getPlatformIcon } from '@/pages/user/help/components/help-platform-icons';

export default function AdminDocsPage() {
  const { t } = useTranslation(['admin', 'common']);
  const [platformFilter, setPlatformFilter] = useState('ALL');
  const [localeFilter, setLocaleFilter] = useState('ALL');
  const [searchKeyword, setSearchKeyword] = useState('');

  const [editorOpen, setEditorOpen] = useState(false);
  const [editingArticle, setEditingArticle] = useState<AdminHelpArticle | null>(null);

  const { data: articles = [], isLoading } = useAdminHelpArticles({
    platform: platformFilter !== 'ALL' ? platformFilter : undefined,
    locale: localeFilter !== 'ALL' ? localeFilter : undefined,
    keyword: searchKeyword ? searchKeyword.trim() : undefined
  });

  const {
    createMutation,
    updateMutation,
    deleteMutation,
    resetDefaultsMutation
  } = useAdminHelpMutations();

  const handleOpenCreate = () => {
    setEditingArticle(null);
    setEditorOpen(true);
  };

  const handleOpenEdit = (article: AdminHelpArticle) => {
    setEditingArticle(article);
    setEditorOpen(true);
  };

  const handleSave = (payload: AdminHelpArticlePayload) => {
    if (editingArticle && editingArticle.id) {
      updateMutation.mutate(
        { id: editingArticle.id, payload },
        { onSuccess: () => setEditorOpen(false) }
      );
    } else {
      createMutation.mutate(payload, {
        onSuccess: () => setEditorOpen(false)
      });
    }
  };

  const handleTogglePublish = (article: AdminHelpArticle, isPublished: boolean) => {
    updateMutation.mutate({
      id: article.id,
      payload: { isPublished }
    });
  };

  const handleCopySlug = async (slug: string) => {
    try {
      await navigator.clipboard.writeText(slug);
      toast.success(t('admin:docs.copiedSlug'));
    } catch {
      toast.error(t('common:actions.copyFailed'));
    }
  };

  return (
    <PageContainer>
      <PageHeader
        title={t('admin:docs.title')}
        description={t('admin:docs.subtitle')}
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
              placeholder={t('admin:docs.searchPlaceholder')}
              className="pl-9"
            />
          </div>

          <Select value={platformFilter} onValueChange={setPlatformFilter}>
            <SelectTrigger className="w-full sm:w-36">
              <SelectValue placeholder={t('admin:docs.platform')} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="ALL">{t('admin:docs.platforms.all')}</SelectItem>
              <SelectItem value="WINDOWS">{t('admin:docs.platforms.windows')}</SelectItem>
              <SelectItem value="MACOS">{t('admin:docs.platforms.macos')}</SelectItem>
              <SelectItem value="IOS">{t('admin:docs.platforms.ios')}</SelectItem>
              <SelectItem value="ANDROID">{t('admin:docs.platforms.android')}</SelectItem>
              <SelectItem value="ROUTER">{t('admin:docs.platforms.router')}</SelectItem>
              <SelectItem value="FAQ">{t('admin:docs.platforms.faq')}</SelectItem>
              <SelectItem value="GENERAL">{t('admin:docs.platforms.general')}</SelectItem>
            </SelectContent>
          </Select>

          <Select value={localeFilter} onValueChange={setLocaleFilter}>
            <SelectTrigger className="w-full sm:w-32">
              <SelectValue placeholder={t('admin:docs.allLocales')} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="ALL">{t('admin:docs.allLocales')}</SelectItem>
              <SelectItem value="zh-CN">{t('common:languages.zhCN')}</SelectItem>
              <SelectItem value="en-US">{t('common:languages.enUS')}</SelectItem>
              <SelectItem value="ja-JP">{t('common:languages.jaJP')}</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div className="flex w-full flex-col gap-2 sm:flex-row lg:w-auto">
          <ResetDefaultsDialog
            onConfirm={() => resetDefaultsMutation.mutate()}
            isPending={resetDefaultsMutation.isPending}
          />
          <Button className="w-full sm:w-auto" onClick={handleOpenCreate}>
            <Plus className="size-4" />
            <span>{t('admin:docs.newDoc')}</span>
          </Button>
        </div>
      </div>

      {/* 文档列表表格 */}
      <Card>
        <CardContent className="min-w-0 p-0">
          {isLoading ? (
            <div className="space-y-3 p-4">
              <Skeleton className="h-8 w-full" />
              <Skeleton className="h-12 w-full" />
              <Skeleton className="h-12 w-full" />
            </div>
          ) : articles.length === 0 ? (
            <EmptyState
              title={t('admin:docs.emptyTitle')}
              description={t('admin:docs.emptyDesc')}
              className="border-0"
              action={
                <Button size="sm" variant="outline" onClick={handleOpenCreate} className="gap-1.5">
                  <Plus className="size-4" />
                  <span>{t('admin:docs.createNow')}</span>
                </Button>
              }
            />
          ) : (
            <Table className="min-w-[900px]">
              <TableHeader>
                <TableRow>
                  <TableHead className="w-[30%]">{t('admin:docs.table.title')}</TableHead>
                  <TableHead>{t('admin:docs.table.platformClient')}</TableHead>
                  <TableHead>{t('admin:docs.table.slug')}</TableHead>
                  <TableHead>{t('admin:docs.table.sort')}</TableHead>
                  <TableHead>{t('admin:docs.table.locale')}</TableHead>
                  <TableHead>{t('admin:docs.table.status')}</TableHead>
                  <TableHead>{t('admin:docs.table.updatedAt')}</TableHead>
                  <TableHead className="text-right">{t('admin:docs.table.actions')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {articles.map((article) => {
                  const IconComp = getPlatformIcon(article.platform, article.icon);

                  return (
                    <TableRow key={article.id}>
                      <TableCell className="max-w-[280px]">
                        <div className="flex items-start gap-2.5">
                          <span className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-md bg-muted text-foreground/80">
                            <IconComp className="size-3.5" />
                          </span>
                          <div className="min-w-0 space-y-0.5">
                            <div className="font-medium text-foreground truncate" title={article.title}>
                              {article.title}
                            </div>
                            {article.summary && (
                              <div className="text-xs text-muted-foreground truncate" title={article.summary}>
                                {article.summary}
                              </div>
                            )}
                          </div>
                        </div>
                      </TableCell>

                      <TableCell className="whitespace-nowrap">
                        <div className="flex items-center gap-1.5">
                          <Badge variant="secondary">
                            {article.platform}
                          </Badge>
                          {article.clientName && (
                            <Badge variant="outline" className="border-primary/30 text-primary">
                              {article.clientName}
                            </Badge>
                          )}
                        </div>
                      </TableCell>

                      {/* Slug 标识列：优化等宽样式与纯图标独立复制按钮，杜绝文字遮挡与换行 */}
                      <TableCell className="whitespace-nowrap">
                        <div className="inline-flex items-center gap-1.5 font-mono text-xs bg-muted/40 border border-border/70 px-2 py-0.5 rounded-md text-foreground/90">
                          <span className="select-all">{article.slug}</span>
                          <IconButton
                            type="button"
                            variant="ghost"
                            size="icon-xs"
                            className="shrink-0 rounded text-muted-foreground hover:text-foreground"
                            title={t('admin:docs.copySlug')}
                            onClick={(e) => {
                              e.stopPropagation();
                              handleCopySlug(article.slug);
                            }}
                            aria-label={t('admin:docs.copySlug')}
                          >
                            <Copy className="size-3.5" />
                          </IconButton>
                        </div>
                      </TableCell>

                      <TableCell className="font-mono text-xs text-muted-foreground tabular-nums">
                        {article.sortOrder}
                      </TableCell>

                      <TableCell>
                        <Badge variant="outline" className="font-mono">
                          {article.locale}
                        </Badge>
                      </TableCell>

                      <TableCell className="whitespace-nowrap">
                        <div className="flex items-center gap-2">
                          <Switch
                            checked={article.isPublished}
                            onCheckedChange={(checked) => handleTogglePublish(article, checked)}
                            aria-label={t('admin:docs.table.status')}
                          />
                          <span className={article.isPublished ? 'text-xs text-emerald-600 dark:text-emerald-400 font-medium' : 'text-xs text-muted-foreground'}>
                            {article.isPublished ? t('admin:docs.table.published') : t('admin:docs.table.draft')}
                          </span>
                        </div>
                      </TableCell>

                      <TableCell className="text-muted-foreground whitespace-nowrap text-xs tabular-nums">
                        {formatDateTime(article.updatedAt)}
                      </TableCell>

                      <TableCell className="text-right whitespace-nowrap">
                        <div className="flex items-center justify-end gap-1">
                          <IconButton
                            variant="ghost"
                            size="icon-sm"
                            onClick={() => handleOpenEdit(article)}
                            title={t('admin:docs.edit')}
                            aria-label={t('admin:docs.edit')}
                          >
                            <Edit className="size-4" />
                          </IconButton>

                          <AlertDialog>
                            <AlertDialogTrigger asChild>
                              <IconButton
                                variant="ghost"
                                size="icon-sm"
                                title={t('admin:docs.delete')}
                                aria-label={t('admin:docs.delete')}
                              >
                                <Trash2 className="size-4 text-destructive" />
                              </IconButton>
                            </AlertDialogTrigger>
                            <AlertDialogContent>
                              <AlertDialogHeader>
                                <AlertDialogTitle>{t('admin:docs.deleteConfirmTitle')}</AlertDialogTitle>
                                <AlertDialogDescription>
                                  {t('admin:docs.deleteConfirm', { title: article.title })}
                                </AlertDialogDescription>
                              </AlertDialogHeader>
                              <AlertDialogFooter>
                                <AlertDialogCancel>{t('common:actions.cancel')}</AlertDialogCancel>
                                <AlertDialogAction
                                  className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                                  onClick={() => deleteMutation.mutate(article.id)}
                                >
                                  {t('common:actions.delete')}
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

      {/* 新建/编辑文档分屏弹窗 */}
      <DocEditorDialog
        open={editorOpen}
        onOpenChange={setEditorOpen}
        article={editingArticle}
        onSave={handleSave}
        isSaving={createMutation.isPending || updateMutation.isPending}
      />
    </PageContainer>
  );
}
