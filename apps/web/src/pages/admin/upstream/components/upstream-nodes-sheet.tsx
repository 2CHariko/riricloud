import * as React from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription
} from '@/components/ui/sheet';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow
} from '@/components/ui/table';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select';
import {
  Activity,
  Copy,
  Download,
  GitBranch,
  Search
} from 'lucide-react';
import {
  ApiUpstreamSubscription,
  ApiUpstreamNode,
  upstreamApi
} from '@/lib/api';
import { useAdminUpstreamNodes, useAdminUpstreamMutations } from '../use-upstream';

export function UpstreamNodesSheet({
  open,
  onOpenChange,
  subscription,
  onCreateRelayLine
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  subscription?: ApiUpstreamSubscription | null;
  onCreateRelayLine?: (node: ApiUpstreamNode) => void;
}) {
  const { t } = useTranslation(['admin', 'common']);
  const [search, setSearch] = React.useState('');
  const [protocolType, setProtocolType] = React.useState<string>('ALL');
  const { data, isLoading } = useAdminUpstreamNodes({
    subscriptionId: subscription?.id,
    search: search.trim() || undefined,
    protocolType: protocolType !== 'ALL' ? protocolType : undefined,
    pageSize: 100
  });

  const {
    setNodeDirectSubMutation,
    probeNodeMutation,
    probeAllMutation
  } = useAdminUpstreamMutations();

  const handleCopyLink = async (node: ApiUpstreamNode) => {
    try {
      const resp = await upstreamApi.exportNodes({ nodeIds: node.id, format: 'uri' });
      await navigator.clipboard.writeText(resp.data);
      toast.success(t('admin:upstream.copyLinkSuccess'));
    } catch {
      toast.error(t('common:actions.copyFailed'));
    }
  };

  const handleExportAll = async () => {
    if (!subscription) return;
    try {
      const resp = await upstreamApi.exportNodes({ subscriptionId: subscription.id, format: 'uri' });
      await navigator.clipboard.writeText(resp.data);
      toast.success(t('admin:upstream.exportSuccess'));
    } catch {
      toast.error(t('common:actions.copyFailed'));
    }
  };

  const nodes = data?.data ?? [];

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full sm:max-w-4xl p-6 overflow-y-auto">
        <SheetHeader className="mb-4">
          <SheetTitle className="flex items-center gap-2">
            <span>{subscription?.name || t('admin:upstream.nodesTitle')}</span>
            <Badge variant="outline">{nodes.length}</Badge>
          </SheetTitle>
          <SheetDescription>{t('admin:upstream.nodesSubtitle')}</SheetDescription>
        </SheetHeader>

        {/* 顶部工具栏 */}
        <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
          <div className="flex items-center gap-2 flex-1 max-w-sm">
            <div className="relative w-full">
              <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder={t('admin:upstream.searchNodesPlaceholder')}
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="pl-8"
              />
            </div>
          </div>

          <div className="flex items-center gap-2">
            <Select value={protocolType} onValueChange={setProtocolType}>
              <SelectTrigger className="w-[120px]">
                <SelectValue placeholder={t('admin:upstream.colProtocol')} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="ALL">{t('admin:upstream.statusAll')}</SelectItem>
                <SelectItem value="VLESS">VLESS</SelectItem>
                <SelectItem value="VMESS">VMess</SelectItem>
                <SelectItem value="HYSTERIA2">Hysteria 2</SelectItem>
                <SelectItem value="TROJAN">Trojan</SelectItem>
                <SelectItem value="SHADOWSOCKS">SS</SelectItem>
                <SelectItem value="TUIC">TUIC</SelectItem>
              </SelectContent>
            </Select>

            <Button
              variant="outline"
              size="sm"
              onClick={() => probeAllMutation.mutate(subscription?.id)}
              disabled={probeAllMutation.isPending || nodes.length === 0}
            >
              <Activity className="h-4 w-4 mr-1" />
              {t('admin:upstream.probeAll')}
            </Button>

            <Button
              variant="outline"
              size="sm"
              onClick={handleExportAll}
              disabled={nodes.length === 0}
            >
              <Download className="h-4 w-4 mr-1" />
              {t('admin:upstream.exportUri')}
            </Button>
          </div>
        </div>

        {/* 节点表格 */}
        <div className="rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t('admin:upstream.colNodeName')}</TableHead>
                <TableHead>{t('admin:upstream.colProtocol')}</TableHead>
                <TableHead>{t('admin:upstream.colServer')}</TableHead>
                <TableHead>{t('admin:upstream.colLatency')}</TableHead>
                <TableHead>{t('admin:upstream.colDirectSub')}</TableHead>
                <TableHead className="text-right">{t('admin:upstream.colActions')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading ? (
                <TableRow>
                  <TableCell colSpan={6} className="h-24 text-center">
                    {t('common:actions.loading')}
                  </TableCell>
                </TableRow>
              ) : nodes.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={6} className="h-24 text-center text-muted-foreground">
                    {t('admin:upstream.emptyNodesTitle')}
                  </TableCell>
                </TableRow>
              ) : (
                nodes.map((node) => (
                  <TableRow key={node.id}>
                    <TableCell className="font-medium max-w-[200px]">
                      <div className="flex flex-col gap-1">
                        <span className="truncate" title={node.name}>
                          {node.name}
                        </span>
                        <div className="flex flex-wrap gap-1">
                          {node.tags.map((tag) => (
                            <Badge key={tag} variant="secondary" className="text-[10px] px-1 py-0">
                              {tag}
                            </Badge>
                          ))}
                        </div>
                      </div>
                    </TableCell>

                    <TableCell>
                      <Badge variant="outline">{node.protocolType}</Badge>
                    </TableCell>

                    <TableCell className="text-xs text-muted-foreground font-mono">
                      {node.serverHost}:{node.serverPort}
                    </TableCell>

                    <TableCell>
                      {node.lastTestStatus === 'SUCCESS' && node.latencyMs !== null ? (
                        <Badge
                          variant="secondary"
                          className={
                            node.latencyMs < 100
                              ? 'text-emerald-600 dark:text-emerald-400 border-emerald-500/30'
                              : node.latencyMs < 300
                                ? 'text-amber-600 dark:text-amber-400 border-amber-500/30'
                                : 'text-rose-600 dark:text-rose-400 border-rose-500/30'
                          }
                        >
                          {node.latencyMs} ms
                        </Badge>
                      ) : node.lastTestStatus === 'TIMEOUT' ? (
                        <Badge variant="outline" className="text-muted-foreground">
                          {t('admin:upstream.probeTimeout')}
                        </Badge>
                      ) : node.lastTestStatus === 'ERROR' ? (
                        <Badge variant="destructive">
                          {t('common:status.failed')}
                        </Badge>
                      ) : (
                        <span className="text-xs text-muted-foreground">{t('admin:upstream.never')}</span>
                      )}
                    </TableCell>

                    <TableCell>
                      <Switch
                        checked={node.isDirectSub}
                        onCheckedChange={(checked) =>
                          setNodeDirectSubMutation.mutate({ nodeId: node.id, isDirectSub: checked })
                        }
                        title={
                          node.isDirectSub
                            ? t('admin:upstream.directSubEnabledDesc')
                            : t('admin:upstream.directSubDisabledDesc')
                        }
                      />
                    </TableCell>

                    <TableCell className="text-right">
                      <div className="flex items-center justify-end gap-1">
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8"
                          onClick={() => probeNodeMutation.mutate(node.id)}
                          title={t('admin:upstream.probeNode')}
                          disabled={probeNodeMutation.isPending}
                        >
                          <Activity className="h-4 w-4" />
                        </Button>

                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8"
                          onClick={() => handleCopyLink(node)}
                          title={t('common:actions.copy')}
                        >
                          <Copy className="h-4 w-4" />
                        </Button>

                        {onCreateRelayLine && (
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-8 w-8 text-primary"
                            onClick={() => onCreateRelayLine(node)}
                            title={t('admin:upstream.createRelayLine')}
                          >
                            <GitBranch className="h-4 w-4" />
                          </Button>
                        )}
                      </div>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>
      </SheetContent>
    </Sheet>
  );
}
