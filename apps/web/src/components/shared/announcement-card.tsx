import { useState } from 'react';
import { ChevronRight, Megaphone, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import {
  buildAnnouncementSummary,
  getAnnouncementBannerCardClass,
  getAnnouncementBannerIconClass,
  getAnnouncementTypeBadgeClass,
  stripMarkdownPreview,
  useAnnouncements
} from '@/lib/announcements';
import { formatDate } from '@/lib/utils';
import { AnnouncementDetailDialog } from '@/components/shared/announcement-detail-dialog';
import { IconButton } from '@/components/ui/icon-button';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';

export function AnnouncementCard() {
  const { t } = useTranslation(['user', 'common']);
  const { visibleBannerAnnouncements, dismissBanner, markAsRead } = useAnnouncements();
  const [detailOpen, setDetailOpen] = useState(false);

  const currentBanner = visibleBannerAnnouncements[0] ?? null;
  if (!currentBanner) return null;

  const publishTime = currentBanner.createdAt ? formatDate(currentBanner.createdAt) : '';
  // 横幅仅承担「标题 + 纯文本摘要」的轻量提示，完整 GFM 由详情弹窗渲染
  const summary = buildAnnouncementSummary(currentBanner.content, currentBanner.title);
  const fullPlainText = stripMarkdownPreview(currentBanner.content);

  const handleOpenDetail = () => {
    markAsRead(currentBanner);
    setDetailOpen(true);
  };

  const handleDismiss = () => {
    markAsRead(currentBanner);
    dismissBanner(currentBanner);
  };

  return (
    <>
      <Card className={getAnnouncementBannerCardClass(currentBanner.type)}>
        <CardContent className="flex items-start gap-3 p-4">
          <Megaphone className={`mt-0.5 h-5 w-5 shrink-0 ${getAnnouncementBannerIconClass(currentBanner.type)}`} />

          <div className="min-w-0 flex-1 space-y-1.5">
            <div className="flex flex-wrap items-center gap-2">
              <Badge
                variant="outline"
                className={`text-[10px] px-1.5 py-0 font-normal ${getAnnouncementTypeBadgeClass(currentBanner.type)}`}
              >
                {t(`user:announcement.types.${currentBanner.type}`)}
              </Badge>

              <span className="text-sm font-semibold text-foreground break-words">
                {currentBanner.title}
              </span>

              {publishTime && (
                <span className="text-xs text-muted-foreground font-mono">
                  {publishTime}
                </span>
              )}

              <Button
                type="button"
                variant="link"
                size="sm"
                className="h-auto p-0 text-xs gap-0.5 ml-auto"
                onClick={handleOpenDetail}
              >
                <span>{t('user:announcement.viewDetails')}</span>
                <ChevronRight className="size-3.5" />
              </Button>
            </div>

            {summary ? (
              <p
                className="line-clamp-3 text-xs leading-relaxed text-muted-foreground break-words"
                title={fullPlainText}
              >
                {summary}
              </p>
            ) : null}
          </div>

          <IconButton
            variant="ghost"
            size="icon-sm"
            className="-mr-2 -mt-2 shrink-0"
            aria-label={t('user:announcement.dismiss')}
            onClick={handleDismiss}
          >
            <X />
          </IconButton>
        </CardContent>
      </Card>

      <AnnouncementDetailDialog
        announcement={currentBanner}
        open={detailOpen}
        onOpenChange={setDetailOpen}
        onAcknowledge={markAsRead}
      />
    </>
  );
}
