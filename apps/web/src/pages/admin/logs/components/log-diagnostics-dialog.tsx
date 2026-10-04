import { useTranslation } from 'react-i18next';
import { ResponsiveDialog, ResponsiveDialogContent } from '@/components/shared/responsive-dialog';
import { DiagnosticsSnapshotContent } from '@/components/shared/diagnostics-snapshot-card';
import { DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Card } from '@/components/ui/card';
import { useDiagnosticsSnapshot } from '@/hooks/use-diagnostics-snapshot';
import { LogIngestionCard } from './log-ingestion-card';
import type { LogIngestion, SnapshotNode } from '../types';

interface LogDiagnosticsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  node?: SnapshotNode & { name: string };
  ingestion?: LogIngestion;
}

export function LogDiagnosticsDialog({ open, onOpenChange, node, ingestion }: LogDiagnosticsDialogProps) {
  const { t } = useTranslation(['admin']);
  // 观察状态放在 Portal 外，关闭弹窗不丢失本轮回执或隐式取消节点任务。
  const snapshot = useDiagnosticsSnapshot(node?.id ?? '');
  return (
    <ResponsiveDialog open={open} onOpenChange={onOpenChange}>
      <ResponsiveDialogContent size="wide">
        <DialogHeader className="pr-8">
          <DialogTitle>{t('admin:logs.diagnosticsTitle')}</DialogTitle>
          <DialogDescription>{t('admin:logs.diagnosticsDescription', { name: node?.name ?? t('admin:logs.allNodes') })}</DialogDescription>
        </DialogHeader>
        <Card><DiagnosticsSnapshotContent node={node} snapshot={snapshot} /></Card>
        <LogIngestionCard ingestion={ingestion} />
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  );
}
