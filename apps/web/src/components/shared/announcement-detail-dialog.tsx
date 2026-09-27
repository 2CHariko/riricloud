import { useTranslation } from 'react-i18next';
import { AlertCircle, Calendar, CheckCircle2, Flame, Info, Pin, Wrench } from 'lucide-react';
import type { AnnouncementItem, AnnouncementType } from '@/lib/announcements';
import { getAnnouncementTypeBadgeClass } from '@/lib/announcements';
import { formatDate } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog';
import { MarkdownRenderer } from '@/components/shared/markdown-renderer';

interface AnnouncementDetailDialogProps {
  announcement: AnnouncementItem | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onAcknowledge?: (item: AnnouncementItem) => void;
}

function getTypeIcon(type: AnnouncementType) {
  switch (type) {
    case 'URGENT':
      return <AlertCircle className="size-3.5" />;
    case 'MAINTENANCE':
      return <Wrench className="size-3.5" />;
    case 'EVENT':
      return <Flame className="size-3.5" />;
    case 'NOTICE':
    default:
      return <Info className="size-3.5" />;
  }
}

export function AnnouncementDetailDialog({
  announcement,
  open,
  onOpenChange,
  onAcknowledge
}: AnnouncementDetailDialogProps) {
  const { t } = useTranslation(['user', 'common']);

  if (!announcement) return null;

  const handleDismiss = () => {
    onAcknowledge?.(announcement);
    onOpenChange(false);
  };

  const publishTime = announcement.createdAt ? formatDate(announcement.createdAt) : '';

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[85vh] p-0 gap-0 overflow-hidden flex flex-col border border-border/80 shadow-xl">
        {/* 沉浸式结构化头部：仅保留淡色分割线与充足 pr-14 避让关闭按钮 */}
        <DialogHeader className="relative shrink-0 space-y-2 text-left px-6 pt-5 pb-4 border-b border-border/40 pr-14 sm:pr-16">
          <div className="flex flex-wrap items-center gap-2">
            <Badge
              variant="outline"
              className={`gap-1 text-xs font-normal ${getAnnouncementTypeBadgeClass(announcement.type)}`}
            >
              {getTypeIcon(announcement.type)}
              <span>{t(`user:announcement.types.${announcement.type}`)}</span>
            </Badge>

            {announcement.isPinned && (
              <Badge variant="secondary" className="gap-1 text-xs font-normal">
                <Pin className="size-3" />
                <span>{t('user:announcement.pinnedBadge')}</span>
              </Badge>
            )}

            {announcement.showBanner && (
              <Badge variant="outline" className="text-xs font-normal border-primary/30 text-primary">
                {t('user:announcement.bannerBadge')}
              </Badge>
            )}

            {publishTime && (
              <span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground font-mono">
                <Calendar className="size-3" />
                <span>{publishTime}</span>
              </span>
            )}
          </div>

          <DialogTitle className="text-xl sm:text-2xl font-bold leading-snug tracking-tight text-foreground break-words pt-0.5">
            {announcement.title}
          </DialogTitle>
          <DialogDescription className="sr-only">
            {t('user:announcement.modalTitle')}
          </DialogDescription>
        </DialogHeader>

        {/* 正文区域：舒适内边距与自然层级收敛 */}
        <div className="flex-1 overflow-y-auto px-6 py-5 text-sm leading-relaxed max-h-[58vh]">
          <div className="[&_h1]:text-lg [&_h1]:font-semibold [&_h1]:border-b [&_h1]:pb-1.5 [&_h1]:mb-3 [&_h1]:mt-4 [&_h2]:text-base [&_h2]:font-semibold [&_h2]:border-b [&_h2]:pb-1 [&_h2]:mb-2 [&_h2]:mt-3 [&_h3]:text-sm [&_h3]:font-semibold [&_h3]:mb-1.5 [&_h3]:mt-2">
            <MarkdownRenderer content={announcement.content} />
          </div>
        </div>

        {/* 底部操作栏：仅保留淡色分割线 */}
        <DialogFooter className="shrink-0 px-6 py-3.5 border-t border-border/40 flex flex-row items-center justify-between sm:justify-between">
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <CheckCircle2 className="size-3.5 text-emerald-500 shrink-0" />
            <span>{t('user:announcement.markedReadHint')}</span>
          </div>

          <Button type="button" onClick={handleDismiss} className="px-5">
            {t('user:announcement.dismiss')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
