import * as React from 'react';
import { useTranslation } from 'react-i18next';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { frontendLogger } from '@/lib/logger';
import type { LogIngestion } from '../types';

export function LogIngestionCard({ ingestion }: { ingestion?: LogIngestion }) {
  const { t } = useTranslation(['admin']);
  const [web, setWeb] = React.useState(() => frontendLogger.getStats());
  React.useEffect(() => {
    const timer = window.setInterval(() => setWeb(frontendLogger.getStats()), 3000);
    return () => window.clearInterval(timer);
  }, []);
  const fields = ['filtered', 'dropped', 'persistenceFailures', 'retries', 'persisted', 'pendingEntries', 'pendingBytes'] as const;
  return (
    <Card>
      <CardHeader className="pb-2"><CardTitle className="text-sm">{t('admin:logs.ingestionTitle')}</CardTitle></CardHeader>
      <CardContent className="space-y-3 text-xs">
        <p className="text-muted-foreground">{t('admin:logs.ingestionScope')}</p>
        {ingestion ? <>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {fields.map((key) => <p key={key}>{t(`admin:logs.ingestion.${key}`)}: <strong className="font-mono">{ingestion[key].toLocaleString()}</strong></p>)}
          </div>
          <p className="break-all font-mono">{t('admin:logs.ingestionInstance')}: {ingestion.instanceId}</p>
        </> : <p>{t('admin:logs.ingestionUnavailable')}</p>}
        <p>{t('admin:logs.webQueueStats', web)}</p>
      </CardContent>
    </Card>
  );
}
