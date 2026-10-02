import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { json } from '@codemirror/lang-json';
import { yaml } from '@codemirror/lang-yaml';
import { Copy, Eye, LoaderCircle } from 'lucide-react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useTemplatePreview, type TemplatePayload, type TemplatePreviewResponse } from '../use-templates';
import { TemplateCodeEditor } from './template-code-editor';
import { KernelValidationResult } from './kernel-validation-result';

export function TemplatePreviewPanel({ template }: { template: TemplatePayload }) {
  const { t } = useTranslation(['admin', 'common']);
  const [format, setFormat] = useState<'clash' | 'singbox'>('clash');
  const preview = useTemplatePreview();
  const serializedTemplate = useMemo(() => JSON.stringify(template), [template]);

  useEffect(() => {
    preview.mutate({ format, template });
    // 仅以序列化草稿为依赖，字段变化时刷新预览。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [format, serializedTemplate]);

  const result = preview.isPending || preview.isError || preview.data?.format !== format ? undefined : preview.data;
  const check = result?.kernelCheck;

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto">
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-2">
        <Tabs value={format} onValueChange={(value) => setFormat(value as 'clash' | 'singbox')}>
          <TabsList>
            <TabsTrigger value="clash">{t('admin:templatePreview.clashTab')}</TabsTrigger>
            <TabsTrigger value="singbox">{t('admin:templatePreview.singboxTab')}</TabsTrigger>
          </TabsList>
        </Tabs>
        {result && <PreviewActions result={result} />}
      </div>

      {result && (
        <div className="flex shrink-0 flex-wrap items-center gap-2 text-xs">
          <Badge variant="secondary">{t('admin:templatePreview.badgeTotalNodes', { count: result.stats.totalNodes })}</Badge>
          <Badge variant="secondary">{t('admin:templatePreview.badgeMatchedNodes', { count: result.stats.matchedNodes })}</Badge>
          <Badge variant="secondary">{t('admin:templatePreview.badgeProxyGroups', { count: result.stats.proxyGroupsCount })}</Badge>
          <Badge variant="secondary">{t('admin:templatePreview.badgeRules', { count: result.stats.rulesCount })}</Badge>
        </div>
      )}

      {check && <KernelValidationResult check={check} />}

      <div className="min-h-[340px] min-w-0 flex-1 overflow-hidden rounded-md border bg-background shadow-sm">
        {preview.isPending ? (
          <div className="flex h-full min-h-[340px] items-center justify-center text-sm text-muted-foreground">
            <LoaderCircle className="mr-2 size-4 animate-spin" />
            {t('admin:templatePreview.rendering')}
          </div>
        ) : result ? (
          <TemplateCodeEditor
            value={result.content}
            height="100%"
            className="h-full"
            extensions={format === 'singbox' ? [json()] : [yaml()]}
            readOnly
            basicSetup={{ lineNumbers: true, foldGutter: true }}
          />
        ) : (
          <div className="flex h-full min-h-[340px] items-center justify-center text-sm text-muted-foreground">
            {t('admin:templatePreview.placeholder')}
          </div>
        )}
      </div>
    </div>
  );
}


function PreviewActions({ result }: { result: TemplatePreviewResponse }) {
  const { t } = useTranslation(['admin', 'common']);
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(result.content);
          toast.success(t('admin:templatePreview.copySuccess'));
        } catch {
          toast.error(t('admin:templatePreview.copyFailed'));
        }
      }}
    >
      <Copy className="size-4" />
      {t('admin:templatePreview.copyButton')}
    </Button>
  );
}

export function TemplatePreviewDrawer({
  open,
  onOpenChange,
  template,
  title
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  template: TemplatePayload | null;
  title?: string;
}) {
  const { t } = useTranslation(['admin', 'common']);
  const drawerTitle = title || t('admin:templatePreview.drawerTitle');

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="!flex h-full w-full flex-col overflow-hidden sm:max-w-3xl">
        <SheetHeader className="shrink-0">
          <SheetTitle className="flex items-center gap-2">
            <Eye className="size-4" />
            {drawerTitle}
          </SheetTitle>
          <SheetDescription>{t('admin:templatePreview.drawerDesc')}</SheetDescription>
        </SheetHeader>
        <div className="mt-6 flex min-h-0 flex-1 flex-col">
          {template ? (
            <TemplatePreviewPanel template={template} />
          ) : (
            <p className="text-sm text-muted-foreground">{t('admin:templatePreview.selectTemplatePrompt')}</p>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
