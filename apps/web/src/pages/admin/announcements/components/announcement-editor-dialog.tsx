import { useMemo, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
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
  FormDescription,
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
import type { AnnouncementItem, AnnouncementType } from '@/lib/announcements';
import type { AdminAnnouncementPayload } from '../use-admin-announcements';

const createAnnouncementSchema = (t: TFunction<['admin', 'common']>) =>
  z.object({
    title: z
      .string()
      .min(2, t('admin:announcements.validation.titleMin'))
      .max(120, t('admin:announcements.validation.titleMax')),
    type: z.enum(['NOTICE', 'MAINTENANCE', 'EVENT', 'URGENT']),
    content: z.string().min(1, t('admin:announcements.validation.contentRequired')),
    isPinned: z.boolean().default(false),
    showBanner: z.boolean().default(true),
    popupOnLogin: z.boolean().default(false),
    enabled: z.boolean().default(true)
  });

type AnnouncementFormValues = z.infer<ReturnType<typeof createAnnouncementSchema>>;

interface AnnouncementEditorDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  announcement: AnnouncementItem | null;
  onSave: (payload: AdminAnnouncementPayload) => void;
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

export function AnnouncementEditorDialog({
  open,
  onOpenChange,
  announcement,
  onSave,
  isSaving
}: AnnouncementEditorDialogProps) {
  const { t } = useTranslation(['admin', 'common', 'user']);
  const { resolvedTheme } = useTheme();
  const isDark = resolvedTheme === 'dark';

  const [viewMode, setViewMode] = useState<'split' | 'edit' | 'preview'>('split');

  const schema = useMemo(() => createAnnouncementSchema(t), [t]);

  const form = useForm<AnnouncementFormValues>({
    resolver: zodResolver(schema),
    defaultValues: {
      title: '',
      type: 'NOTICE',
      content: '## 公告标题\n\n在此输入详细公告正文…',
      isPinned: false,
      showBanner: true,
      popupOnLogin: false,
      enabled: true
    }
  });

  useFormResetOnKey({
    open,
    resetKey: announcement?.id ?? 'create',
    reset: () => {
      form.reset(
        announcement
          ? {
              title: announcement.title,
              type: announcement.type,
              content: announcement.content,
              isPinned: announcement.isPinned,
              showBanner: announcement.showBanner,
              popupOnLogin: announcement.popupOnLogin,
              enabled: announcement.enabled
            }
          : {
              title: '',
              type: 'NOTICE',
              content: '## 公告标题\n\n在此输入详细公告正文…',
              isPinned: false,
              showBanner: true,
              popupOnLogin: false,
              enabled: true
            }
      );
    }
  });

  const insertSnippet = (snippet: string) => {
    const current = form.getValues('content');
    form.setValue('content', `${current}\n${snippet}\n`, { shouldDirty: true });
  };

  const onSubmit = (values: AnnouncementFormValues) => {
    onSave({
      title: values.title.trim(),
      type: values.type as AnnouncementType,
      content: values.content.trim(),
      isPinned: values.isPinned,
      showBanner: values.showBanner,
      popupOnLogin: values.popupOnLogin,
      enabled: values.enabled
    });
  };

  const currentContent = form.watch('content');

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="fullscreen">
        <DialogHeader className="shrink-0 pb-2 border-b border-border/50 pr-10 sm:pr-12">
          <div className="flex items-center justify-between">
            <DialogTitle className="text-lg font-bold">
              {announcement
                ? t('admin:announcements.editor.editTitle')
                : t('admin:announcements.editor.newTitle')}
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
                <span className="hidden sm:inline">{t('admin:announcements.editor.splitView')}</span>
              </Button>
              <Button
                type="button"
                variant={viewMode === 'edit' ? 'secondary' : 'ghost'}
                size="sm"
                className="h-7 px-2.5 text-xs gap-1"
                onClick={() => setViewMode('edit')}
              >
                <FileCode2 className="size-3.5" />
                <span className="hidden sm:inline">{t('admin:announcements.editor.editView')}</span>
              </Button>
              <Button
                type="button"
                variant={viewMode === 'preview' ? 'secondary' : 'ghost'}
                size="sm"
                className="h-7 px-2.5 text-xs gap-1"
                onClick={() => setViewMode('preview')}
              >
                <Eye className="size-3.5" />
                <span className="hidden sm:inline">{t('admin:announcements.editor.previewView')}</span>
              </Button>
            </div>
          </div>
          <DialogDescription className="text-xs">
            {t('admin:announcements.editor.desc')}
          </DialogDescription>
        </DialogHeader>

        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="flex flex-col flex-1 min-h-0 space-y-4 pt-2">
            {/* 基础元数据网格 */}
            <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-3 text-xs shrink-0">
              <FormField
                control={form.control}
                name="title"
                render={({ field }) => (
                  <FormItem className="space-y-1 sm:col-span-2">
                    <FormLabel className="text-xs">{t('admin:announcements.editor.titleLabel')}</FormLabel>
                    <FormControl>
                      <Input
                        placeholder={t('admin:announcements.editor.titlePlaceholder')}
                        className="h-8 text-xs"
                        {...field}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="type"
                render={({ field }) => (
                  <FormItem className="space-y-1">
                    <FormLabel className="text-xs">{t('admin:announcements.editor.typeLabel')}</FormLabel>
                    <Select onValueChange={field.onChange} value={field.value}>
                      <FormControl>
                        <SelectTrigger className="h-8 text-xs">
                          <SelectValue placeholder={t('admin:announcements.type')} />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        <SelectItem value="NOTICE">{t('admin:announcements.types.NOTICE')}</SelectItem>
                        <SelectItem value="MAINTENANCE">{t('admin:announcements.types.MAINTENANCE')}</SelectItem>
                        <SelectItem value="EVENT">{t('admin:announcements.types.EVENT')}</SelectItem>
                        <SelectItem value="URGENT">{t('admin:announcements.types.URGENT')}</SelectItem>
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>

            {/* 4 维策略展示开关 */}
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 shrink-0">
              <FormField
                control={form.control}
                name="enabled"
                render={({ field }) => (
                  <FormItem className="flex items-center justify-between rounded-lg border border-border p-2.5 space-y-0 bg-muted/20">
                    <div className="space-y-0.5 pr-2 min-w-0">
                      <FormLabel className="text-xs font-semibold cursor-pointer">
                        {t('admin:announcements.editor.enabledLabel')}
                      </FormLabel>
                      <FormDescription className="text-[11px] truncate">
                        {t('admin:announcements.editor.enabledDesc')}
                      </FormDescription>
                    </div>
                    <FormControl>
                      <Switch checked={field.value} onCheckedChange={field.onChange} />
                    </FormControl>
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="isPinned"
                render={({ field }) => (
                  <FormItem className="flex items-center justify-between rounded-lg border border-border p-2.5 space-y-0 bg-muted/20">
                    <div className="space-y-0.5 pr-2 min-w-0">
                      <FormLabel className="text-xs font-semibold cursor-pointer">
                        {t('admin:announcements.editor.isPinnedLabel')}
                      </FormLabel>
                      <FormDescription className="text-[11px] truncate">
                        {t('admin:announcements.editor.isPinnedDesc')}
                      </FormDescription>
                    </div>
                    <FormControl>
                      <Switch checked={field.value} onCheckedChange={field.onChange} />
                    </FormControl>
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="showBanner"
                render={({ field }) => (
                  <FormItem className="flex items-center justify-between rounded-lg border border-border p-2.5 space-y-0 bg-muted/20">
                    <div className="space-y-0.5 pr-2 min-w-0">
                      <FormLabel className="text-xs font-semibold cursor-pointer">
                        {t('admin:announcements.editor.showBannerLabel')}
                      </FormLabel>
                      <FormDescription className="text-[11px] truncate">
                        {t('admin:announcements.editor.showBannerDesc')}
                      </FormDescription>
                    </div>
                    <FormControl>
                      <Switch checked={field.value} onCheckedChange={field.onChange} />
                    </FormControl>
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="popupOnLogin"
                render={({ field }) => (
                  <FormItem className="flex items-center justify-between rounded-lg border border-border p-2.5 space-y-0 bg-muted/20">
                    <div className="space-y-0.5 pr-2 min-w-0">
                      <FormLabel className="text-xs font-semibold cursor-pointer">
                        {t('admin:announcements.editor.popupOnLoginLabel')}
                      </FormLabel>
                      <FormDescription className="text-[11px] truncate">
                        {t('admin:announcements.editor.popupOnLoginDesc')}
                      </FormDescription>
                    </div>
                    <FormControl>
                      <Switch checked={field.value} onCheckedChange={field.onChange} />
                    </FormControl>
                  </FormItem>
                )}
              />
            </div>

            {/* 语法快捷插入工具栏 */}
            <div className="flex flex-wrap items-center gap-1.5 p-2 rounded-lg bg-muted/30 border border-border text-xs shrink-0">
              <span className="text-muted-foreground text-[11px] font-medium mr-1">
                {t('admin:announcements.editor.insertToolbar')}
              </span>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-6 text-[11px] px-2 font-mono"
                onClick={() => insertSnippet('### 标题')}
              >
                + {t('admin:announcements.editor.insertHeading')}
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-6 text-[11px] px-2 font-mono"
                onClick={() => insertSnippet('**粗体文本**')}
              >
                + {t('admin:announcements.editor.insertBold')}
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-6 text-[11px] px-2 font-mono"
                onClick={() => insertSnippet('> [!NOTE]\n> 这里填写需要提醒用户的关键注意事项。')}
              >
                + {t('admin:announcements.editor.insertNoteAlert')}
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-6 text-[11px] px-2 font-mono"
                onClick={() => insertSnippet('> [!WARNING]\n> 这里填写重要警示或维护时间安排。')}
              >
                + {t('admin:announcements.editor.insertWarningAlert')}
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-6 text-[11px] px-2 font-mono"
                onClick={() => insertSnippet('```\n// 代码块或操作说明\n```')}
              >
                + {t('admin:announcements.editor.insertCodeBlock')}
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-6 text-[11px] px-2 font-mono"
                onClick={() => insertSnippet('[链接名称](https://example.com)')}
              >
                + {t('admin:announcements.editor.insertLink')}
              </Button>
            </div>

            {/* 编辑与预览容器 */}
            <div className="flex-1 min-h-[360px] grid grid-cols-1 lg:grid-cols-12 gap-4 border border-border rounded-lg overflow-hidden bg-background">
              {/* 编辑区 */}
              {(viewMode === 'split' || viewMode === 'edit') && (
                <div
                  className={`${
                    viewMode === 'split'
                      ? 'lg:col-span-6 border-b lg:border-b-0 lg:border-r border-border'
                      : 'lg:col-span-12'
                  } flex flex-col h-full overflow-hidden`}
                >
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
                <div
                  className={`${
                    viewMode === 'split' ? 'lg:col-span-6' : 'lg:col-span-12'
                  } flex flex-col h-full overflow-hidden`}
                >
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
                <span>
                  {isSaving
                    ? t('common:actions.saving')
                    : t('admin:announcements.editor.saveAnnouncement')}
                </span>
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
