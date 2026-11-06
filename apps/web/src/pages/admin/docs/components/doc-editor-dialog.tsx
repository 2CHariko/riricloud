import { useMemo, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@/lib/zod-resolver';
import { z } from 'zod';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { useTheme } from 'next-themes';
import CodeMirror from '@uiw/react-codemirror';
import { EditorView } from '@codemirror/view';
import { MarkdownRenderer } from '@/components/shared/markdown-renderer';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog';
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage
} from '@/components/ui/form';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { Badge } from '@/components/ui/badge';
import { useFormResetOnKey } from '@/hooks/use-form-reset';
import {
  Columns2,
  Eye,
  FileCode2,
  Save
} from 'lucide-react';
import type { AdminHelpArticle, AdminHelpArticlePayload } from '../use-admin-docs';

const createArticleSchema = (t: TFunction<['admin', 'common']>) =>
  z.object({
    slug: z
      .string()
      .min(2, t('admin:docs.validation.slugMin'))
      .max(64, t('admin:docs.validation.slugMax'))
      .regex(/^[a-z0-9-]+$/, t('admin:docs.validation.slugRegex')),
    title: z
      .string()
      .min(2, t('admin:docs.validation.titleMin'))
      .max(128, t('admin:docs.validation.titleMax')),
    platform: z.string().default('ALL'),
    clientName: z.string().max(64).optional(),
    icon: z.string().max(64).optional(),
    summary: z.string().max(255).optional(),
    content: z.string().min(1, t('admin:docs.validation.contentRequired')),
    sortOrder: z.coerce.number().int().default(0),
    isPublished: z.boolean().default(true),
    locale: z.string().default('zh-CN')
  });

type ArticleFormValues = z.infer<ReturnType<typeof createArticleSchema>>;

interface DocEditorDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  article: AdminHelpArticle | null;
  onSave: (payload: AdminHelpArticlePayload) => void;
  isSaving: boolean;
}

const editorScrollTheme = EditorView.theme({
  '&': { height: '100%', minHeight: '380px' },
  '.cm-scroller': {
    height: '100% !important',
    overflowX: 'auto',
    overflowY: 'auto'
  }
});

export function DocEditorDialog({
  open,
  onOpenChange,
  article,
  onSave,
  isSaving
}: DocEditorDialogProps) {
  const { t } = useTranslation(['admin', 'common']);
  const { resolvedTheme } = useTheme();
  const isDark = resolvedTheme === 'dark';

  const [viewMode, setViewMode] = useState<'split' | 'edit' | 'preview'>('split');

  const articleSchema = useMemo(() => createArticleSchema(t), [t]);

  const form = useForm<ArticleFormValues>({
    resolver: zodResolver(articleSchema),
    defaultValues: {
      slug: '',
      title: '',
      platform: 'ALL',
      clientName: '',
      icon: '',
      summary: '',
      content: '# 教程标题\n\n在此输入 Markdown 内容…',
      sortOrder: 0,
      isPublished: true,
      locale: 'zh-CN'
    }
  });

  useFormResetOnKey({
    open,
    resetKey: article?.id ?? 'create',
    reset: () => {
      form.reset(
        article
          ? {
              slug: article.slug,
              title: article.title,
              platform: article.platform,
              clientName: article.clientName || '',
              icon: article.icon || '',
              summary: article.summary || '',
              content: article.content,
              sortOrder: article.sortOrder,
              isPublished: article.isPublished,
              locale: article.locale
            }
          : {
              slug: '',
              title: '',
              platform: 'ALL',
              clientName: '',
              icon: '',
              summary: '',
              content: '# 教程标题\n\n在此输入 Markdown 内容…',
              sortOrder: 0,
              isPublished: true,
              locale: 'zh-CN'
            }
      );
    }
  });

  const insertSnippet = (snippet: string) => {
    const current = form.getValues('content');
    form.setValue('content', `${current}\n${snippet}\n`, { shouldDirty: true });
  };

  const onSubmit = (values: ArticleFormValues) => {
    onSave({
      slug: values.slug,
      title: values.title,
      platform: values.platform,
      clientName: values.clientName ? values.clientName.trim() : null,
      icon: values.icon ? values.icon.trim() : null,
      summary: values.summary ? values.summary.trim() : null,
      content: values.content,
      sortOrder: values.sortOrder,
      isPublished: values.isPublished,
      locale: values.locale
    });
  };

  const currentContent = form.watch('content');

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="fullscreen">
        <DialogHeader className="shrink-0 pb-2 border-b border-border/50 pr-10 sm:pr-12">
          <div className="flex items-center justify-between">
            <DialogTitle className="text-lg font-bold">
              {article ? t('admin:docs.editor.editTitle') : t('admin:docs.editor.newTitle')}
            </DialogTitle>
            {/* 视图切换模式 */}
            <div className="flex items-center rounded-lg border border-border bg-muted/40 p-0.5">
              <Button
                type="button"
                variant={viewMode === 'split' ? 'secondary' : 'ghost'}
                size="sm"
                className="h-7 px-2.5 text-xs gap-1"
                onClick={() => setViewMode('split')}
              >
                <Columns2 className="size-3.5" />
                <span className="hidden sm:inline">{t('admin:docs.editor.splitView')}</span>
              </Button>
              <Button
                type="button"
                variant={viewMode === 'edit' ? 'secondary' : 'ghost'}
                size="sm"
                className="h-7 px-2.5 text-xs gap-1"
                onClick={() => setViewMode('edit')}
              >
                <FileCode2 className="size-3.5" />
                <span className="hidden sm:inline">{t('admin:docs.editor.editView')}</span>
              </Button>
              <Button
                type="button"
                variant={viewMode === 'preview' ? 'secondary' : 'ghost'}
                size="sm"
                className="h-7 px-2.5 text-xs gap-1"
                onClick={() => setViewMode('preview')}
              >
                <Eye className="size-3.5" />
                <span className="hidden sm:inline">{t('admin:docs.editor.previewView')}</span>
              </Button>
            </div>
          </div>
          <DialogDescription className="text-xs">
            {t('admin:docs.editor.desc')}
          </DialogDescription>
        </DialogHeader>

        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="flex flex-col flex-1 min-h-0 space-y-4 pt-2">
            {/* 基础元数据网格 */}
            <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-3 text-xs shrink-0">
              <FormField
                control={form.control}
                name="title"
                render={({ field }) => (
                  <FormItem className="space-y-1 sm:col-span-2">
                    <FormLabel className="text-xs">{t('admin:docs.editor.titleLabel')}</FormLabel>
                    <FormControl>
                      <Input placeholder={t('admin:docs.editor.titlePlaceholder')} className="h-8 text-xs" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="slug"
                render={({ field }) => (
                  <FormItem className="space-y-1">
                    <FormLabel className="text-xs">{t('admin:docs.editor.slugLabel')}</FormLabel>
                    <FormControl>
                      <Input placeholder={t('admin:docs.editor.slugPlaceholder')} className="h-8 text-xs font-mono" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="platform"
                render={({ field }) => (
                  <FormItem className="space-y-1">
                    <FormLabel className="text-xs">{t('admin:docs.editor.platformLabel')}</FormLabel>
                    <Select onValueChange={field.onChange} value={field.value}>
                      <FormControl>
                        <SelectTrigger className="h-8 text-xs">
                          <SelectValue placeholder={t('admin:docs.platform')} />
                        </SelectTrigger>
                      </FormControl>
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
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="clientName"
                render={({ field }) => (
                  <FormItem className="space-y-1">
                    <FormLabel className="text-xs">{t('admin:docs.editor.clientNameLabel')}</FormLabel>
                    <FormControl>
                      <Input placeholder={t('admin:docs.editor.clientNamePlaceholder')} className="h-8 text-xs" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="icon"
                render={({ field }) => (
                  <FormItem className="space-y-1">
                    <FormLabel className="text-xs">{t('admin:docs.editor.iconLabel')}</FormLabel>
                    <FormControl>
                      <Input placeholder={t('admin:docs.editor.iconPlaceholder')} className="h-8 text-xs" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="sortOrder"
                render={({ field }) => (
                  <FormItem className="space-y-1">
                    <FormLabel className="text-xs">{t('admin:docs.editor.sortOrderLabel')}</FormLabel>
                    <FormControl>
                      <Input type="number" className="h-8 text-xs" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="locale"
                render={({ field }) => (
                  <FormItem className="space-y-1">
                    <FormLabel className="text-xs">{t('admin:docs.editor.localeLabel')}</FormLabel>
                    <Select onValueChange={field.onChange} value={field.value}>
                      <FormControl>
                        <SelectTrigger className="h-8 text-xs">
                          <SelectValue placeholder={t('admin:docs.locale')} />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        <SelectItem value="zh-CN">{t('common:languages.zhCN')} (zh-CN)</SelectItem>
                        <SelectItem value="en-US">{t('common:languages.enUS')} (en-US)</SelectItem>
                        <SelectItem value="ja-JP">{t('common:languages.jaJP')} (ja-JP)</SelectItem>
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="summary"
                render={({ field }) => (
                  <FormItem className="space-y-1 sm:col-span-3">
                    <FormLabel className="text-xs">{t('admin:docs.editor.summaryLabel')}</FormLabel>
                    <FormControl>
                      <Input placeholder={t('admin:docs.editor.summaryPlaceholder')} className="h-8 text-xs" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="isPublished"
                render={({ field }) => (
                  <FormItem className="flex items-center justify-between rounded-lg border border-border p-2 space-y-0 mt-3">
                    <div className="space-y-0.5">
                      <FormLabel className="text-xs">{t('admin:docs.editor.isPublishedLabel')}</FormLabel>
                    </div>
                    <FormControl>
                      <Switch checked={field.value} onCheckedChange={field.onChange} />
                    </FormControl>
                  </FormItem>
                )}
              />
            </div>

            {/* 动态占位符与语法快捷插入工具栏 */}
            <div className="flex flex-wrap items-center gap-1.5 p-2 rounded-lg bg-muted/30 border border-border text-xs shrink-0">
              <span className="text-muted-foreground text-[11px] font-medium mr-1">{t('admin:docs.editor.insertToolbar')}</span>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-6 text-[11px] px-2 font-mono"
                onClick={() => insertSnippet('`{{subscription_url}}`')}
              >
                + {t('admin:docs.editor.insertSubUrl')}
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-6 text-[11px] px-2 font-mono"
                onClick={() => insertSnippet('[一键导入到 Clash](clash://install-config?url={{clash_import_url}}&name={{site_name}})')}
              >
                + {t('admin:docs.editor.insertClashUrl')}
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-6 text-[11px] px-2 font-mono"
                onClick={() => insertSnippet('[一键导入到 Shadowrocket](shadowrocket://add/sub://{{shadowrocket_import_url}}?title={{site_name}})')}
              >
                + {t('admin:docs.editor.insertShadowrocketUrl')}
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-6 text-[11px] px-2 font-mono"
                onClick={() => insertSnippet('{{site_name}}')}
              >
                + {t('admin:docs.editor.insertSiteName')}
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-6 text-[11px] px-2 font-mono"
                onClick={() => insertSnippet('> [!NOTE]\n> 这里填写需要提醒新手的关键注意事项。')}
              >
                + Note
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-6 text-[11px] px-2 font-mono"
                onClick={() => insertSnippet('> [!TIP]\n> 这里填写实用操作技巧或快捷键。')}
              >
                + Tip
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-6 text-[11px] px-2 font-mono"
                onClick={() => insertSnippet('> [!WARNING]\n> 这里填写重要警告，避免用户误操作。')}
              >
                + Warning
              </Button>
            </div>

            {/* 编辑与预览容器 */}
            <div className="flex-1 min-h-[360px] grid grid-cols-1 lg:grid-cols-12 gap-4 border border-border rounded-lg overflow-hidden bg-background">
              {/* 编辑区 */}
              {(viewMode === 'split' || viewMode === 'edit') && (
                <div className={`${viewMode === 'split' ? 'lg:col-span-6 border-b lg:border-b-0 lg:border-r border-border' : 'lg:col-span-12'} flex flex-col h-full overflow-hidden`}>
                  <div className="px-3 py-1.5 bg-muted/50 border-b border-border text-[11px] font-semibold text-muted-foreground flex items-center justify-between shrink-0">
                    <span>Markdown</span>
                    <Badge variant="outline" className="text-[10px] h-4 font-mono font-normal">
                      {currentContent.length} chars
                    </Badge>
                  </div>
                  <div className="flex-1 overflow-auto">
                    <FormField
                      control={form.control}
                      name="content"
                      render={({ field }) => (
                        <CodeMirror
                          value={field.value}
                          height="100%"
                          theme={isDark ? 'dark' : 'light'}
                          extensions={[editorScrollTheme]}
                          onChange={(val) => field.onChange(val)}
                          className="h-full text-xs font-mono"
                        />
                      )}
                    />
                  </div>
                </div>
              )}

              {/* 实时渲染预览区 */}
              {(viewMode === 'split' || viewMode === 'preview') && (
                <div className={`${viewMode === 'split' ? 'lg:col-span-6' : 'lg:col-span-12'} flex flex-col h-full overflow-hidden`}>
                  <div className="px-3 py-1.5 bg-muted/50 border-b border-border text-[11px] font-semibold text-muted-foreground flex items-center justify-between shrink-0">
                    <span>Preview</span>
                    <Badge variant="secondary" className="text-[10px] h-4 font-normal">
                      Live
                    </Badge>
                  </div>
                  <div className="flex-1 overflow-y-auto p-4 bg-card/40">
                    <MarkdownRenderer content={currentContent} />
                  </div>
                </div>
              )}
            </div>

            {/* 对话框操作底栏 */}
            <DialogFooter className="shrink-0 pt-2 border-t border-border/50">
              <Button type="button" variant="outline" size="sm" onClick={() => onOpenChange(false)}>
                {t('common:actions.cancel')}
              </Button>
              <Button type="submit" size="sm" disabled={isSaving} className="gap-1.5">
                <Save className="size-3.5" />
                <span>{isSaving ? t('common:actions.saving') : t('admin:docs.editor.saveDoc')}</span>
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
