import * as React from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import i18n from '@/i18n/config';
import { zodResolver } from '@hookform/resolvers/zod';
import { AlertTriangle, CheckCircle2, CloudDownload, Pencil, Plus, RefreshCw, Trash2 } from 'lucide-react';
import { useForm } from 'react-hook-form';
import * as z from 'zod';

/** 与页面内 useTranslation(['admin','common']) 的 t 签名保持一致。 */
type TFn = TFunction<'admin' | 'common'>;
import { PageContainer, PageHeader } from '@/components/shared/page-container';
import { EmptyState } from '@/components/shared/empty-state';
import { ResponsiveDialog, ResponsiveDialogContent } from '@/components/shared/responsive-dialog';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { IconButton } from '@/components/ui/icon-button';
import { Card, CardContent } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Form, FormControl, FormDescription, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import { useFormResetOnKey } from '@/hooks/use-form-reset';
import { api } from '@/lib/api';
import { useAdminNodes } from '@/pages/admin/nodes/use-nodes';
import {
  useAdminUpstreams,
  useMaterializeUpstreams,
  useUpstreamEntries,
  useUpstreamMutations,
  useUpstreamPreview,
  type ApiUpstreamSubscription,
  type UpstreamPreviewResult,
  type UpstreamSkipItem,
  type UpstreamSubscriptionPayload
} from './use-upstreams';

const subscriptionFormSchema = z.object({
  name: z.string().trim().min(1, i18n.t('admin:upstreams.valNameReq')).max(64, i18n.t('admin:upstreams.valNameMax')),
  url: z.string().trim().regex(/^https?:\/\//i, i18n.t('admin:upstreams.valUrl')).max(2048, i18n.t('admin:upstreams.valUrlMax')),
  syncIntervalMins: z.coerce.number().int().min(15, i18n.t('admin:upstreams.valInterval')).max(10080, i18n.t('admin:upstreams.valInterval')),
  userAgent: z.string().trim().max(256, i18n.t('admin:upstreams.valUserAgentMax')),
  enabled: z.boolean()
});

type SubscriptionFormValues = z.infer<typeof subscriptionFormSchema>;

/** 入口协议白名单与后端保持一致；上游出口不支持 MIXED/SOCKS/HTTP 等本地代理入站作为出口来源。 */
const ENTRY_PROTOCOLS = ['VLESS', 'VMESS', 'TROJAN', 'HYSTERIA2', 'TUIC', 'SHADOWSOCKS'] as const;

/** 跳过原因的 i18n 键：写成字面量联合类型，动态取值时才不会被 t() 的键校验拒绝。 */
const SKIP_REASON_KEYS = {
  UNSUPPORTED_PROTOCOL: 'admin:upstreams.skipUnsupported',
  MISSING_SERVER: 'admin:upstreams.skipMissingServer',
  MISSING_CREDENTIAL: 'admin:upstreams.skipMissingCredential',
  INVALID_PARAMS: 'admin:upstreams.skipInvalidParams',
  DUPLICATE: 'admin:upstreams.skipDuplicate'
} as const satisfies Record<UpstreamSkipItem['reason'], string>;

function skipReasonKey(reason: string): (typeof SKIP_REASON_KEYS)[keyof typeof SKIP_REASON_KEYS] {
  return SKIP_REASON_KEYS[reason as UpstreamSkipItem['reason']] ?? SKIP_REASON_KEYS.INVALID_PARAMS;
}

function emptySubscriptionFormValues(): SubscriptionFormValues {
  return { name: '', url: '', syncIntervalMins: 720, userAgent: '', enabled: true };
}

function toFormValues(subscription: ApiUpstreamSubscription): SubscriptionFormValues {
  return {
    name: subscription.name,
    // 完整 URL 服务端不会下发，编辑时留空表示保留原地址
    url: '',
    syncIntervalMins: subscription.syncIntervalMins,
    userAgent: subscription.userAgent ?? '',
    enabled: subscription.enabled
  };
}

function formatStatusBadge(status: ApiUpstreamSubscription['lastFetchStatus'], t: TFn) {
  if (status === 'SUCCESS') return <Badge variant="secondary">{t('upstreams.statusSuccess')}</Badge>;
  if (status === 'FAILED') return <Badge variant="destructive">{t('upstreams.statusFailed')}</Badge>;
  return <Badge variant="outline">{t('upstreams.statusNever')}</Badge>;
}

function SubscriptionForm({
  open,
  editing,
  pending,
  onOpenChange,
  onSubmit
}: {
  open: boolean;
  editing: ApiUpstreamSubscription | null;
  pending: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmit: (payload: UpstreamSubscriptionPayload) => void;
}) {
  const { t } = useTranslation(['admin', 'common']);
  const form = useForm<SubscriptionFormValues>({
    resolver: zodResolver(subscriptionFormSchema),
    defaultValues: emptySubscriptionFormValues()
  });

  useFormResetOnKey({
    open,
    resetKey: editing?.id ?? 'create',
    reset: () => form.reset(editing ? toFormValues(editing) : emptySubscriptionFormValues())
  });

  const submit = form.handleSubmit((values) => {
    const url = values.url.trim();
    if (!editing && !url) {
      form.setError('url', { message: t('admin:upstreams.valUrl') });
      return;
    }
    const payload: UpstreamSubscriptionPayload = {
      name: values.name.trim(),
      // 编辑时地址留空 = 保留原地址，服务端不会回显完整 URL（内嵌机场鉴权令牌）
      url,
      enabled: values.enabled,
      syncIntervalMins: values.syncIntervalMins,
      userAgent: values.userAgent.trim() || null
    };
    onSubmit(payload);
  });

  return (
    <ResponsiveDialog open={open} onOpenChange={onOpenChange}>
      <ResponsiveDialogContent>
        <DialogHeader>
          <DialogTitle>{editing ? t('admin:upstreams.editTitle') : t('admin:upstreams.createTitle')}</DialogTitle>
          <DialogDescription>{t('admin:upstreams.formDesc')}</DialogDescription>
        </DialogHeader>
        <Form {...form}>
          <form onSubmit={submit} className="space-y-4">
            <FormField
              control={form.control}
              name="name"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t('admin:upstreams.fieldName')}</FormLabel>
                  <FormControl>
                    <Input placeholder={t('admin:upstreams.fieldNamePlaceholder')} {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="url"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t('admin:upstreams.fieldUrl')}</FormLabel>
                  <FormControl>
                    <Input placeholder="https://sub.example.com/api/v1/client/subscribe?token=..." {...field} />
                  </FormControl>
                  <FormDescription>
                    {editing ? t('admin:upstreams.fieldUrlKeepHint') : t('admin:upstreams.fieldUrlHint')}
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />
            <div className="grid gap-4 sm:grid-cols-2">
              <FormField
                control={form.control}
                name="syncIntervalMins"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{t('admin:upstreams.fieldInterval')}</FormLabel>
                    <FormControl>
                      <Input type="number" min={15} max={10080} {...field} />
                    </FormControl>
                    <FormDescription>{t('admin:upstreams.fieldIntervalHint')}</FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="userAgent"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{t('admin:upstreams.fieldUserAgent')}</FormLabel>
                    <FormControl>
                      <Input placeholder="clash-verge/v2.0.0" {...field} />
                    </FormControl>
                    <FormDescription>{t('admin:upstreams.fieldUserAgentHint')}</FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>
            <FormField
              control={form.control}
              name="enabled"
              render={({ field }) => (
                <FormItem className="flex flex-row items-center justify-between rounded-lg border p-3">
                  <div className="space-y-0.5">
                    <FormLabel>{t('admin:upstreams.fieldEnabled')}</FormLabel>
                    <FormDescription>{t('admin:upstreams.fieldEnabledHint')}</FormDescription>
                  </div>
                  <FormControl>
                    <Switch checked={field.value} onCheckedChange={field.onChange} />
                  </FormControl>
                </FormItem>
              )}
            />
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                {t('common:actions.cancel')}
              </Button>
              <Button type="submit" disabled={pending}>
                {editing ? t('common:actions.save') : t('common:actions.create')}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  );
}

/**
 * 导入预览与物化对话框。
 *
 * 预览本身不落库：管理员先看清"能导入什么、跳过了什么"，再决定入口节点与协议，
 * 最后一次性生成线路。这样上游订阅的内容永远不会静默污染用户订阅列表。
 */
function ImportDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const { t } = useTranslation(['admin', 'common']);
  const nodesQuery = useAdminNodes();
  const preview = useUpstreamPreview();
  const materialize = useMaterializeUpstreams();

  const [source, setSource] = React.useState<'url' | 'content'>('url');
  const [url, setUrl] = React.useState('');
  const [content, setContent] = React.useState('');
  const [followProviders, setFollowProviders] = React.useState(true);
  const [result, setResult] = React.useState<UpstreamPreviewResult | null>(null);
  const [selected, setSelected] = React.useState<Set<string>>(new Set());
  const [entryNodeId, setEntryNodeId] = React.useState('');
  const [entryProtocolType, setEntryProtocolType] = React.useState<string>('VLESS');
  const [namePrefix, setNamePrefix] = React.useState('');
  const [isPublic, setIsPublic] = React.useState(false);

  const availableNodes = React.useMemo(
    () => (nodesQuery.data ?? []).filter((node) => node.reachability !== 'NAT'),
    [nodesQuery.data]
  );

  React.useEffect(() => {
    if (!open) return;
    setResult(null);
    setSelected(new Set());
    if (!entryNodeId && availableNodes[0]) setEntryNodeId(availableNodes[0].id);
  }, [availableNodes, entryNodeId, open]);

  const runPreview = () => {
    setResult(null);
    preview.mutate(
      {
        ...(source === 'url' ? { url: url.trim() } : { content }),
        followProviders: source === 'url' ? followProviders : undefined
      },
      {
        onSuccess: (data) => {
          setResult(data);
          // 仅默认勾选尚未导入的节点，避免重复物化同一上游
          setSelected(new Set(data.nodes.filter((node) => !node.imported).map((node) => node.entryKey)));
        }
      }
    );
  };

  const toggle = (entryKey: string, checked: boolean) => {
    setSelected((current) => {
      const next = new Set(current);
      if (checked) next.add(entryKey);
      else next.delete(entryKey);
      return next;
    });
  };

  const submit = () => {
    if (!result || !entryNodeId || !selected.size) return;
    // 物化要求条目 ID：已导入的直接可用，新节点需要先落库
    const existingIds = result.nodes
      .filter((node) => node.entryId && selected.has(node.entryKey))
      .map((node) => node.entryId as string);

    const materializeWithIds = (ids: string[]) => {
      if (!ids.length) return;
      materialize.mutate(
        {
          entryIds: ids,
          entryNodeId,
          entryProtocolType,
          namePrefix: namePrefix.trim() || undefined,
          isPublic
        },
        { onSuccess: () => onOpenChange(false) }
      );
    };

    if (existingIds.length === selected.size) {
      materializeWithIds(existingIds);
      return;
    }

    // 存在未落库的新节点：先落库为上游条目，再物化。
    // 这一步需要重新解析一次订阅内容（预览本身不落库），因此可能稍慢。
    void (async () => {
      try {
        const imported = await api.post<{ entryIds: string[] }>('/admin/upstreams/import', {
          ...(source === 'url' ? { url: url.trim() } : { content }),
          followProviders: source === 'url' ? followProviders : undefined
        });
        const merged = [...new Set([...existingIds, ...imported.data.entryIds])];
        materializeWithIds(merged);
      } catch {
        // 错误提示由统一 API 客户端拦截器负责
      }
    })();
  };

  const skippedByReason = React.useMemo(() => {
    const groups = new Map<string, UpstreamSkipItem[]>();
    for (const item of result?.skipped ?? []) {
      const list = groups.get(item.reason) ?? [];
      list.push(item);
      groups.set(item.reason, list);
    }
    return [...groups.entries()];
  }, [result]);

  return (
    <ResponsiveDialog open={open} onOpenChange={onOpenChange}>
      <ResponsiveDialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>{t('admin:upstreams.importTitle')}</DialogTitle>
          <DialogDescription>{t('admin:upstreams.importDesc')}</DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="flex gap-2">
            <Button type="button" size="sm" variant={source === 'url' ? 'default' : 'outline'} onClick={() => setSource('url')}>
              {t('admin:upstreams.sourceUrl')}
            </Button>
            <Button type="button" size="sm" variant={source === 'content' ? 'default' : 'outline'} onClick={() => setSource('content')}>
              {t('admin:upstreams.sourceContent')}
            </Button>
          </div>

          {source === 'url' ? (
            <div className="space-y-3">
              <Input
                value={url}
                onChange={(event) => setUrl(event.target.value)}
                placeholder="https://sub.example.com/api/v1/client/subscribe?token=..."
              />
              <div className="flex items-center gap-2">
                <Checkbox id="follow-providers" checked={followProviders} onCheckedChange={(value) => setFollowProviders(value === true)} />
                <Label htmlFor="follow-providers" className="text-sm font-normal">
                  {t('admin:upstreams.followProviders')}
                </Label>
              </div>
            </div>
          ) : (
            <Textarea
              value={content}
              onChange={(event) => setContent(event.target.value)}
              rows={6}
              placeholder={t('admin:upstreams.contentPlaceholder')}
            />
          )}

          <Button
            type="button"
            onClick={runPreview}
            disabled={preview.isPending || (source === 'url' ? !url.trim() : !content.trim())}
          >
            <CloudDownload className="mr-2 h-4 w-4" />
            {preview.isPending ? t('admin:upstreams.previewing') : t('admin:upstreams.runPreview')}
          </Button>

          {result && (
            <div className="space-y-4">
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <Badge variant="secondary">{result.format}</Badge>
                <span className="text-muted-foreground">
                  {t('admin:upstreams.previewSummary', {
                    importable: result.nodes.length,
                    skipped: result.skipped.length
                  })}
                </span>
                {result.providerCount > 0 && (
                  <span className="text-muted-foreground">
                    {t('admin:upstreams.previewProviders', { count: result.providerCount })}
                  </span>
                )}
              </div>

              {result.nodes.length > 0 ? (
                <div className="max-h-64 overflow-auto rounded-md border">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead className="w-10" />
                        <TableHead>{t('admin:upstreams.colNodeName')}</TableHead>
                        <TableHead>{t('admin:upstreams.colProtocol')}</TableHead>
                        <TableHead>{t('admin:upstreams.colEndpoint')}</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {result.nodes.map((node) => (
                        <TableRow key={node.entryKey}>
                          <TableCell>
                            <Checkbox
                              checked={selected.has(node.entryKey)}
                              onCheckedChange={(value) => toggle(node.entryKey, value === true)}
                              aria-label={node.name}
                            />
                          </TableCell>
                          <TableCell className="max-w-[16rem] truncate" title={node.name}>
                            {node.name}
                            {node.imported && (
                              <Badge variant="outline" className="ml-2">
                                {t('admin:upstreams.badgeImported')}
                              </Badge>
                            )}
                          </TableCell>
                          <TableCell>{node.protocolType}</TableCell>
                          <TableCell className="font-mono text-xs">
                            {node.server}:{node.port}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              ) : (
                <div className="flex items-start gap-3 rounded-md border border-amber-500/40 bg-amber-500/5 p-4">
                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
                  <div className="space-y-1">
                    <p className="text-sm font-medium">{t('admin:upstreams.noImportableTitle')}</p>
                    <p className="text-muted-foreground text-sm">{t('admin:upstreams.noImportableDesc')}</p>
                  </div>
                </div>
              )}

              {skippedByReason.length > 0 && (
                <div className="space-y-2">
                  <p className="text-sm font-medium">{t('admin:upstreams.skippedTitle')}</p>
                  <div className="space-y-1 rounded-md border p-3 text-sm">
                    {skippedByReason.map(([reason, items]) => (
                      <div key={reason} className="flex items-start gap-2">
                        <Badge variant="outline" className="shrink-0">
                          {t(skipReasonKey(reason))}
                        </Badge>
                        <span className="text-muted-foreground">
                          {t('admin:upstreams.skippedCount', { count: items.length })}
                          {items[0]?.name ? ` · ${items[0].name}` : ''}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              <div className="space-y-4 rounded-md border p-4">
                <p className="text-sm font-medium">{t('admin:upstreams.materializeTitle')}</p>
                <p className="text-xs text-muted-foreground">{t('admin:upstreams.materializeHint')}</p>
                <div className="grid gap-4 sm:grid-cols-2">
                  <div className="space-y-2">
                    <Label>{t('admin:upstreams.fieldEntryNode')}</Label>
                    <Select value={entryNodeId} onValueChange={setEntryNodeId}>
                      <SelectTrigger>
                        <SelectValue placeholder={t('admin:upstreams.fieldEntryNodePlaceholder')} />
                      </SelectTrigger>
                      <SelectContent>
                        {availableNodes.map((node) => (
                          <SelectItem key={node.id} value={node.id}>
                            {node.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <p className="text-xs text-muted-foreground">{t('admin:upstreams.fieldEntryNodeHint')}</p>
                  </div>
                  <div className="space-y-2">
                    <Label>{t('admin:upstreams.fieldEntryProtocol')}</Label>
                    <Select value={entryProtocolType} onValueChange={setEntryProtocolType}>
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {ENTRY_PROTOCOLS.map((protocol) => (
                          <SelectItem key={protocol} value={protocol}>
                            {protocol}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <p className="text-xs text-muted-foreground">{t('admin:upstreams.fieldEntryProtocolHint')}</p>
                  </div>
                  <div className="space-y-2">
                    <Label>{t('admin:upstreams.fieldNamePrefix')}</Label>
                    <Input
                      value={namePrefix}
                      onChange={(event) => setNamePrefix(event.target.value)}
                      placeholder={t('admin:upstreams.fieldNamePrefixPlaceholder')}
                    />
                  </div>
                  <div className="flex items-center gap-2 pt-6">
                    <Checkbox id="materialize-public" checked={isPublic} onCheckedChange={(value) => setIsPublic(value === true)} />
                    <Label htmlFor="materialize-public" className="text-sm font-normal">
                      {t('admin:upstreams.fieldIsPublic')}
                    </Label>
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            {t('common:actions.cancel')}
          </Button>
          <Button
            type="button"
            onClick={submit}
            disabled={!result || !selected.size || !entryNodeId || materialize.isPending}
          >
            {materialize.isPending
              ? t('admin:upstreams.materializing')
              : t('admin:upstreams.materializeSubmit', { count: selected.size })}
          </Button>
        </DialogFooter>
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  );
}

/**
 * 上游条目页签。
 *
 * 条目是"已解析入库的上游节点"，线路由管理员显式从条目物化而来。
 * 这里让管理员能确认"哪些上游节点已经被接入、各自生成了几条线路"。
 */
function EntriesPanel() {
  const { t } = useTranslation(['admin', 'common']);
  const entries = useUpstreamEntries({ pageSize: 100 });
  const rows = entries.data?.data ?? [];

  if (!entries.isLoading && rows.length === 0) {
    return <EmptyState title={t('admin:upstreams.entriesEmptyTitle')} description={t('admin:upstreams.entriesEmptyDesc')} />;
  }

  return (
    <div className="max-h-[32rem] overflow-auto">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{t('admin:upstreams.colNodeName')}</TableHead>
            <TableHead>{t('admin:upstreams.colProtocol')}</TableHead>
            <TableHead>{t('admin:upstreams.colEndpoint')}</TableHead>
            <TableHead>{t('admin:upstreams.colSource')}</TableHead>
            <TableHead>{t('admin:upstreams.colAvailable')}</TableHead>
            <TableHead>{t('admin:upstreams.colMaterialized')}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((entry) => (
            <TableRow key={entry.id}>
              <TableCell className="max-w-[16rem] truncate" title={entry.name}>
                {entry.name}
              </TableCell>
              <TableCell>{entry.protocolType}</TableCell>
              <TableCell className="font-mono text-xs">
                {entry.server}:{entry.port}
              </TableCell>
              <TableCell className="text-xs text-muted-foreground">
                {entry.subscriptionName ?? t('admin:upstreams.sourceManual')}
              </TableCell>
              <TableCell>
                <Badge variant={entry.available ? 'secondary' : 'outline'}>
                  {entry.available ? t('admin:upstreams.availableYes') : t('admin:upstreams.availableNo')}
                </Badge>
              </TableCell>
              <TableCell>{t('admin:upstreams.linesCount', { count: entry.materializedLineCount })}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

export default function AdminUpstreamsPage() {
  const { t } = useTranslation(['admin', 'common']);
  const subscriptions = useAdminUpstreams();
  const { create, update, remove, sync } = useUpstreamMutations();

  const [formOpen, setFormOpen] = React.useState(false);
  const [importOpen, setImportOpen] = React.useState(false);
  const [editing, setEditing] = React.useState<ApiUpstreamSubscription | null>(null);
  const [deleting, setDeleting] = React.useState<ApiUpstreamSubscription | null>(null);

  const rows = subscriptions.data?.data ?? [];

  return (
    <PageContainer>
      <PageHeader title={t('admin:upstreams.title')} description={t('admin:upstreams.subtitle')} />

      <div className="flex flex-wrap justify-end gap-2">
        <Button variant="outline" onClick={() => setImportOpen(true)}>
          <CloudDownload className="mr-2 h-4 w-4" />
          {t('admin:upstreams.importButton')}
        </Button>
        <Button
          onClick={() => {
            setEditing(null);
            setFormOpen(true);
          }}
        >
          <Plus className="mr-2 h-4 w-4" />
          {t('admin:upstreams.createButton')}
        </Button>
      </div>

      <Card>
        <CardContent className="pt-6">
          <Tabs defaultValue="subscriptions">
            <TabsList className="mb-4">
              <TabsTrigger value="subscriptions">{t('admin:upstreams.tabSubscriptions')}</TabsTrigger>
              <TabsTrigger value="entries">{t('admin:upstreams.tabEntries')}</TabsTrigger>
            </TabsList>

            <TabsContent value="subscriptions">
              {rows.length === 0 && !subscriptions.isLoading ? (
                <EmptyState
                  icon={<CloudDownload className="text-muted-foreground/60 h-10 w-10" />}
                  title={t('admin:upstreams.emptyTitle')}
                  description={t('admin:upstreams.emptyDesc')}
                />
              ) : (
                <div className="overflow-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>{t('admin:upstreams.colName')}</TableHead>
                        <TableHead>{t('admin:upstreams.colHost')}</TableHead>
                        <TableHead>{t('admin:upstreams.colFormat')}</TableHead>
                        <TableHead>{t('admin:upstreams.colEntries')}</TableHead>
                        <TableHead>{t('admin:upstreams.colLastFetch')}</TableHead>
                        <TableHead>{t('admin:upstreams.colStatus')}</TableHead>
                        <TableHead className="text-right">{t('admin:upstreams.colActions')}</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {rows.map((row) => (
                        <TableRow key={row.id}>
                          <TableCell>
                            <div className="flex items-center gap-2">
                              <span className="font-medium">{row.name}</span>
                              {!row.enabled && <Badge variant="outline">{t('admin:upstreams.badgeDisabled')}</Badge>}
                            </div>
                          </TableCell>
                          <TableCell className="font-mono text-xs">{row.host}</TableCell>
                          <TableCell>{row.detectedFormat ?? '—'}</TableCell>
                          <TableCell>
                            {t('admin:upstreams.entriesCount', { available: row.availableEntryCount, total: row.entryCount })}
                            {row.lineCount > 0 && (
                              <span className="ml-2 text-xs text-muted-foreground">
                                {t('admin:upstreams.linesCount', { count: row.lineCount })}
                              </span>
                            )}
                          </TableCell>
                          <TableCell className="text-xs text-muted-foreground">
                            {row.lastFetchedAt ? new Date(row.lastFetchedAt).toLocaleString() : t('admin:upstreams.neverFetched')}
                          </TableCell>
                          <TableCell>
                            <div className="flex flex-col gap-1">
                              {formatStatusBadge(row.lastFetchStatus, t)}
                              {row.lastFetchError && (
                                <span className="max-w-[18rem] truncate text-xs text-destructive" title={row.lastFetchError}>
                                  {row.lastFetchError}
                                </span>
                              )}
                            </div>
                          </TableCell>
                          <TableCell className="text-right">
                            <div className="flex justify-end gap-1">
                              <IconButton
                                aria-label={t('admin:upstreams.actionSync')}
                                onClick={() => sync.mutate(row.id)}
                                disabled={sync.isPending}
                              >
                                <RefreshCw className={sync.isPending ? 'h-4 w-4 animate-spin' : 'h-4 w-4'} />
                              </IconButton>
                              <IconButton
                                aria-label={t('admin:upstreams.actionEdit')}
                                onClick={() => {
                                  setEditing(row);
                                  setFormOpen(true);
                                }}
                              >
                                <Pencil className="h-4 w-4" />
                              </IconButton>
                              <IconButton
                                aria-label={t('admin:upstreams.actionDelete')}
                                onClick={() => setDeleting(row)}
                              >
                                <Trash2 className="h-4 w-4" />
                              </IconButton>
                            </div>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
            </TabsContent>

            <TabsContent value="entries">
              <EntriesPanel />
            </TabsContent>
          </Tabs>
        </CardContent>
      </Card>

      <div className="flex items-start gap-3 rounded-md border p-4">
        <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" />
        <div className="space-y-1">
          <p className="text-sm font-medium">{t('admin:upstreams.noticeTitle')}</p>
          <p className="text-muted-foreground text-sm">{t('admin:upstreams.noticeDesc')}</p>
        </div>
      </div>

      <SubscriptionForm
        open={formOpen}
        editing={editing}
        pending={create.isPending || update.isPending}
        onOpenChange={(open) => {
          setFormOpen(open);
          if (!open) setEditing(null);
        }}
        onSubmit={(payload) => {
          if (editing) {
            update.mutate({ id: editing.id, ...payload }, { onSuccess: () => setFormOpen(false) });
            return;
          }
          create.mutate(payload, { onSuccess: () => setFormOpen(false) });
        }}
      />

      <ImportDialog open={importOpen} onOpenChange={setImportOpen} />

      <AlertDialog open={Boolean(deleting)} onOpenChange={(open) => !open && setDeleting(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('admin:upstreams.deleteDialogTitle', { name: deleting?.name ?? '' })}</AlertDialogTitle>
            <AlertDialogDescription>{t('admin:upstreams.deleteDialogDesc')}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common:actions.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (deleting) remove.mutate(deleting.id);
                setDeleting(null);
              }}
            >
              {t('common:actions.delete')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </PageContainer>
  );
}
