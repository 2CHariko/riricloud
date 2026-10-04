import * as React from 'react';
import { useTranslation } from 'react-i18next';
import { Clock3, ShieldAlert } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from '@/components/ui/alert-dialog';
import type { AdminNode } from '../use-nodes';

function formatDiagnosticRemaining(expiresAt: string | null, now: number): string {
  if (!expiresAt) return '—';
  const remaining = Math.max(0, new Date(expiresAt).getTime() - now);
  return `${Math.floor(remaining / 60_000)}m ${Math.floor((remaining % 60_000) / 1000).toString().padStart(2, '0')}s`;
}

export function SingboxDiagnosticsCard({ node, enabling, disabling, onEnable, onDisable }: {
  node: AdminNode; enabling: boolean; disabling: boolean;
  onEnable: (level: 'INFO' | 'DEBUG') => void; onDisable: () => void;
}) {
  const { t } = useTranslation(['admin', 'common']);
  const [level, setLevel] = React.useState<'INFO' | 'DEBUG'>('INFO');
  const [now, setNow] = React.useState(() => Date.now());
  const active = node.singboxLogMode !== 'NORMAL' && Boolean(node.singboxLogModeUntil);
  React.useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [active]);
  const available = node.status === 'ONLINE' && node.supportsSingboxLogCapture;
  return (
    <Card>
      <CardHeader><CardTitle className="flex items-center gap-2 text-base"><ShieldAlert className="size-4" />{t('admin:nodes.diagLogTitle')}</CardTitle></CardHeader>
      <CardContent className="space-y-3">
        <p className="text-sm text-muted-foreground">{t('admin:nodes.diagLogDesc')}</p>
        {active ? (
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-warning/30 bg-warning/5 p-3">
            <div className="space-y-1 text-sm">
              <div className="flex items-center gap-2"><Badge variant="outline">{node.singboxLogMode}</Badge><span>{t('admin:nodes.diagLogActive')}</span></div>
              <p className="flex items-center gap-1 text-xs text-muted-foreground"><Clock3 className="size-3" />{t('admin:nodes.diagLogRemaining', { time: formatDiagnosticRemaining(node.singboxLogModeUntil, now) })}</p>
            </div>
            <AlertDialog>
              <AlertDialogTrigger asChild><Button variant="outline" size="sm" disabled={disabling}>{t('admin:nodes.stopDiag')}</Button></AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader><AlertDialogTitle>{t('admin:nodes.stopDiag')}</AlertDialogTitle><AlertDialogDescription>{t('admin:nodes.diagConfirmDesc')}</AlertDialogDescription></AlertDialogHeader>
                <AlertDialogFooter><AlertDialogCancel>{t('common:actions.cancel')}</AlertDialogCancel><AlertDialogAction onClick={onDisable}>{t('common:actions.confirm')}</AlertDialogAction></AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </div>
        ) : (
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div className="space-y-2">
              {!node.supportsSingboxLogCapture && <p className="text-xs text-muted-foreground">{t('admin:nodes.diagUnsupported')}</p>}
              {node.status !== 'ONLINE' && <p className="text-xs text-muted-foreground">{t('admin:nodes.diagOffline')}</p>}
              <Select value={level} onValueChange={(value) => setLevel(value as 'INFO' | 'DEBUG')}>
                <SelectTrigger className="w-40"><SelectValue placeholder={t('admin:nodes.diagLevel')} /></SelectTrigger>
                <SelectContent><SelectItem value="INFO">{t('admin:nodes.diagLevelInfo')}</SelectItem><SelectItem value="DEBUG">{t('admin:nodes.diagLevelDebug')}</SelectItem></SelectContent>
              </Select>
            </div>
            <AlertDialog>
              <AlertDialogTrigger asChild><Button size="sm" disabled={!available || enabling}>{enabling ? t('admin:nodes.enablingDiag') : t('admin:nodes.enableDiag')}</Button></AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader><AlertDialogTitle>{t('admin:nodes.diagConfirmTitle', { level })}</AlertDialogTitle><AlertDialogDescription>{t('admin:nodes.diagConfirmDesc')}</AlertDialogDescription></AlertDialogHeader>
                <AlertDialogFooter><AlertDialogCancel>{t('common:actions.cancel')}</AlertDialogCancel><AlertDialogAction onClick={() => onEnable(level)}>{t('admin:nodes.confirmEnable')}</AlertDialogAction></AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
