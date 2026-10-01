import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { api } from '@/lib/api';
import type { ClientKernelStatus } from '@/lib/probe-types';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';

export function ClientKernelStatusCard() {
  const { t } = useTranslation(['admin', 'common']);
  const status = useQuery({ queryKey: ['admin', 'client-kernels', 'status'], queryFn: async ({ signal }) =>
    (await api.get<ClientKernelStatus>('/admin/client-kernels/status', { signal })).data });
  const profiles = status.data;
  return <Card className="md:col-span-2"><CardHeader><CardTitle className="text-sm">{t('admin:probes.kernelsTitle')}</CardTitle></CardHeader><CardContent className="space-y-3">
    {status.isPending && <p className="text-sm text-muted-foreground">{t('common:actions.loading')}</p>}
    {status.isError && <p className="text-amber-600 dark:text-amber-400">{t('admin:probes.taskUnavailable')}</p>}
    {Array.isArray(profiles) && [...profiles].sort((a, b) => a.engine === b.engine ? 0 : a.engine === 'MIHOMO' ? -1 : 1).map((profile) => <div key={profile.engine} className="space-y-1 text-xs">
      <Badge variant="outline" className={profile.available ? 'text-emerald-600 dark:text-emerald-400' : 'text-amber-600 dark:text-amber-400'}>
        {t(`admin:probes.engine.${profile.engine}`)} · {profile.version ?? '—'} · {profile.available ? t('admin:probes.available') : t('admin:probes.unavailable')}
      </Badge>{profile.reason && <p className="break-words text-muted-foreground">{profile.reason}</p>}
    </div>)}
    <Button type="button" variant="outline" size="sm" disabled={status.isFetching} onClick={() => void status.refetch()}>{t('admin:probes.refresh')}</Button>
  </CardContent></Card>;
}
