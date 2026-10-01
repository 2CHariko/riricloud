import { useState } from 'react';
import { useInfiniteQuery } from '@tanstack/react-query';
import type { UseFormReturn } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import { upstreamApi } from '@/lib/api';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { SelectField } from './line-form-controls';
import type { LineFormValues } from './line-form-schema';

export function UpstreamNodePicker({ form, selectedSummary }: { form: UseFormReturn<LineFormValues>; selectedSummary?: { id: string; name: string; protocolType: string; serverHost: string; serverPort: number } | null }) {
  const { t } = useTranslation(['admin', 'common']);
  const [search, setSearch] = useState('');
  const [tag, setTag] = useState('');
  const query = useInfiniteQuery({
    queryKey: ['admin-upstream-nodes', 'selector', search, tag], initialPageParam: 1,
    queryFn: async ({ pageParam }) => (await upstreamApi.listNodes({ page: pageParam, pageSize: 50, status: 'ACTIVE', search: search.trim() || undefined, tag: tag.trim() || undefined })).data,
    getNextPageParam: (last) => last.page * last.pageSize < last.total ? last.page + 1 : undefined
  });
  const nodes = query.data?.pages.flatMap((page) => page.data).filter((node) => node.presenceStatus === 'PRESENT' && node.subscription?.status === 'ACTIVE') ?? [];
  const chosenId = form.watch('upstreamNodeId');
  const chosen = nodes.find((node) => node.id === chosenId) ?? (selectedSummary?.id === chosenId ? selectedSummary : null);
  const choices = nodes.map((node) => ({ value: node.id, label: `${node.name} · ${node.protocolType} · ${node.serverHost}:${node.serverPort}` }));
  if (chosen && !choices.some((option) => option.value === chosen.id)) choices.unshift({ value: chosen.id, label: `${chosen.name} · ${chosen.protocolType} · ${chosen.serverHost}:${chosen.serverPort}` });
  return <div className="space-y-2">
    <div className="flex gap-2"><Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder={t('admin:upstream.searchNodesPlaceholder')} /><Input value={tag} onChange={(e) => setTag(e.target.value)} placeholder={t('admin:lines.filterTag')} /></div>
    <SelectField form={form} name="upstreamNodeId" label={t('admin:lineForm.upstreamNodeLabel')} options={choices} description={t('admin:lineForm.upstreamNodeDesc')} />
    {chosen && <p className="text-xs text-muted-foreground">{chosen.protocolType} · {chosen.serverHost}:{chosen.serverPort}</p>}
    <p className="text-xs text-muted-foreground">{t('admin:upstream.loadedCount', { count: nodes.length, total: query.data?.pages[0]?.total ?? 0 })}</p>
    {query.isError && <Button type="button" variant="outline" onClick={() => void query.refetch()}>{t('admin:upstream.retry')}</Button>}
    {query.hasNextPage && <Button type="button" variant="outline" disabled={query.isFetchingNextPage} onClick={() => void query.fetchNextPage()}>{query.isFetchingNextPage ? t('common:actions.loading') : t('admin:upstream.loadMore')}</Button>}
  </div>;
}
