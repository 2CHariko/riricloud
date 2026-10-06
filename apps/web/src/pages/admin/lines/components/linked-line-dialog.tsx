import { useEffect, useRef } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { api } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { ResponsiveDialog, ResponsiveDialogContent } from '@/components/shared/responsive-dialog';
import type { AdminLine } from '../use-lines';
import { LineTopology } from './line-topology';

export function LinkedLineDialog({ id, edit, returnTo, onClose, onEdit }: { id: string; edit: boolean; returnTo: string | null; onClose: () => void; onEdit: (line: AdminLine) => void }) {
  const { t } = useTranslation(['admin', 'common']);
  const query = useQuery({ queryKey: ['admin', 'lines', 'linked', id], queryFn: async ({ signal }) => (await api.get<{ line: AdminLine }>('/admin/lines/' + id, { signal })).data.line, gcTime: 0 });
  const opened = useRef(false);
  const tls = query.data?.params?.tls as { serverName?: string } | undefined;
  const serverName = query.data?.serverName?.trim() || (typeof tls?.serverName === 'string' ? tls.serverName.trim() : '') || query.data?.serverHost?.replace(/^\[|\]$/g, '') || '—';
  useEffect(() => {
    if (edit && query.data && !opened.current) { opened.current = true; onEdit(query.data); }
    // eslint-disable-next-line no-restricted-syntax -- URL 指定编辑只初始化一次会话；refetch 不覆盖草稿
  }, [edit, query.data, onEdit]);
  return <ResponsiveDialog open onOpenChange={open => !open && onClose()}><ResponsiveDialogContent size="wide">
    <DialogHeader><DialogTitle>{query.data?.name ?? t('admin:certificateManagement.lineDetail')}</DialogTitle><DialogDescription>{t('admin:certificateManagement.viewLine')}</DialogDescription></DialogHeader>
    {query.isPending && <p className="text-sm text-muted-foreground">{t('common:actions.loading')}</p>}
    {query.isError && <div className="space-y-2"><p className="text-sm text-destructive">{t('admin:certificateManagement.lineLoadFailed')}</p><Button variant="outline" onClick={() => void query.refetch()}>{t('common:actions.retry')}</Button></div>}
    {query.data && <div className="space-y-3">
      <LineTopology line={query.data} />
      <Badge variant="outline">{t(`admin:certificateManagement.${query.data.status === 'ACTIVE' ? 'lineActive' : 'lineDisabled'}`)}</Badge>
      <p className="break-all text-sm">{t('admin:certificateManagement.lineEndpoint')}: {query.data.serverHost}:{query.data.serverPort}</p>
      <p className="break-all text-sm">{t('admin:certificateManagement.lineSni')}: {serverName}</p>
      <div className="flex flex-wrap gap-2">{[query.data.entryNode, query.data.landingNode, query.data.targetLine?.entryNode].filter((node): node is NonNullable<typeof node> => Boolean(node)).filter((node, index, nodes) => nodes.findIndex(item => item.id === node.id) === index).map(node => <Button variant="link" key={node.id} asChild><Link to={'/admin/nodes/' + node.id} state={{ certificateReturn: returnTo }}>{node.name}</Link></Button>)}</div>
    </div>}
    <DialogFooter>{returnTo && <Button variant="outline" asChild><Link to={returnTo}>{t('admin:certificateManagement.backToCertificate')}</Link></Button>}<Button variant="outline" onClick={onClose}>{t('common:actions.close')}</Button>{query.data && <Button onClick={() => onEdit(query.data!)}>{t('admin:certificateManagement.editLine')}</Button>}</DialogFooter>
  </ResponsiveDialogContent></ResponsiveDialog>;
}
