import { useTranslation } from 'react-i18next';
import { ProbeTaskDialog } from '@/components/shared/probe-task-dialog';
import type { AdminLine } from '../use-lines';

export interface LineSpeedtestDialogProps { open: boolean; onOpenChange: (open: boolean) => void; line: AdminLine | null; }
export function LineSpeedtestDialog({ open, onOpenChange, line }: LineSpeedtestDialogProps) {
  const { t } = useTranslation('admin');
  if (!line) return null;
  return <ProbeTaskDialog key={line.id} open={open} onOpenChange={onOpenChange}
    request={{ key: `line:${line.id}`, endpoint: `/admin/lines/${line.id}/speedtest` }} title={`${t('latencyTest.title')} · ${line.name}`} />;
}
