import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Bell, CheckCheck, Megaphone, Pin } from 'lucide-react';
import { toast } from 'sonner';
import {
  type AnnouncementItem,
  getAnnouncementTypeBadgeClass,
  stripMarkdownPreview,
  useAnnouncements
} from '@/lib/announcements';
import { formatDate } from '@/lib/utils';
import { IconButton } from '@/components/ui/icon-button';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu';
import { AnnouncementDetailDialog } from '@/components/shared/announcement-detail-dialog';

export function AnnouncementCenter() {
  const { t } = useTranslation(['user', 'common']);
  const {
    activeAnnouncements,
    unreadCount,
    popupAnnouncement,
    isRead,
    markAsRead,
    markAllAsRead
  } = useAnnouncements();

  const [menuOpen, setMenuOpen] = useState(false);
  const [detailOpen, setDetailOpen] = useState(false);
  const [selectedAnnouncement, setSelectedAnnouncement] = useState<AnnouncementItem | null>(null);

  // 避免同一会话内重复强弹窗
  const hasAutoPromptedRef = useRef(false);

  useEffect(() => {
    if (popupAnnouncement && !hasAutoPromptedRef.current) {
      setSelectedAnnouncement(popupAnnouncement);
      setDetailOpen(true);
      hasAutoPromptedRef.current = true;
    }
  }, [popupAnnouncement]);

  const handleSelectAnnouncement = (item: AnnouncementItem) => {
    markAsRead(item);
    setSelectedAnnouncement(item);
    setDetailOpen(true);
    setMenuOpen(false);
  };

  const handleMarkAllRead = () => {
    markAllAsRead();
    toast.success(t('user:announcement.allReadSuccess'));
  };

  const actionAriaLabel = t('user:announcement.centerAriaLabel');

  return (
    <>
      <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
        <DropdownMenuTrigger asChild>
          <IconButton
            variant="ghost"
            size="icon-sm"
            className="relative"
            title={actionAriaLabel}
            aria-label={actionAriaLabel}
          >
            <Bell className="size-4 shrink-0" />
            {unreadCount > 0 && (
              <span className="absolute top-1 right-1 flex size-2">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-rose-400 opacity-75" />
                <span className="relative inline-flex size-2 rounded-full bg-rose-500" />
              </span>
            )}
            <span className="sr-only">{actionAriaLabel}</span>
          </IconButton>
        </DropdownMenuTrigger>

        <DropdownMenuContent
          align="end"
          className="w-80 sm:w-96 p-0 max-h-[85vh] overflow-hidden flex flex-col shadow-lg border-border/60"
        >
          <div className="flex items-center justify-between px-3.5 py-2.5 border-b border-border/40 bg-muted/30">
            <div className="flex items-center gap-2">
              <span className="text-xs font-semibold text-foreground">
                {t('user:announcement.centerTitle')}
              </span>
              {unreadCount > 0 ? (
                <Badge variant="secondary" className="px-1.5 py-0 text-[10px] bg-primary/10 text-primary font-normal">
                  {t('user:announcement.unreadCount', { count: unreadCount })}
                </Badge>
              ) : null}
            </div>

            {unreadCount > 0 ? (
              <Button
                variant="ghost"
                size="sm"
                className="h-6 px-1.5 text-[11px] text-muted-foreground hover:text-foreground"
                onClick={handleMarkAllRead}
              >
                <CheckCheck className="size-3 mr-1 text-primary" />
                <span>{t('user:announcement.markAllRead')}</span>
              </Button>
            ) : null}
          </div>

          <div className="overflow-y-auto max-h-[60vh] divide-y divide-border/30">
            {activeAnnouncements.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-10 px-4 text-center">
                <div className="flex size-10 items-center justify-center rounded-full bg-muted/60 text-muted-foreground mb-2">
                  <Megaphone className="size-5 opacity-70" />
                </div>
                <p className="text-xs font-medium text-foreground">{t('user:announcement.emptyTitle')}</p>
                <p className="text-[11px] text-muted-foreground mt-1 max-w-[200px]">
                  {t('user:announcement.emptyDesc')}
                </p>
              </div>
            ) : (
              activeAnnouncements.map((item) => {
                const read = isRead(item);
                const publishTime = item.createdAt ? formatDate(item.createdAt) : '';
                const preview = stripMarkdownPreview(item.content);

                return (
                  <DropdownMenuItem
                    key={item.id}
                    onClick={() => handleSelectAnnouncement(item)}
                    className="flex flex-col items-start gap-1 p-3 cursor-pointer text-left focus:bg-muted/50 focus:text-foreground"
                  >
                    <div className="flex items-center gap-1.5 w-full">
                      {!read && (
                        <span className="size-1.5 rounded-full bg-primary shrink-0" />
                      )}

                      <Badge
                        variant="outline"
                        className={`text-[10px] px-1 py-0 font-normal shrink-0 ${getAnnouncementTypeBadgeClass(item.type)}`}
                      >
                        {t(`user:announcement.types.${item.type}`)}
                      </Badge>

                      {item.isPinned && (
                        <Pin className="size-3 text-muted-foreground shrink-0" />
                      )}

                      <span className={`text-xs truncate flex-1 ${read ? 'text-muted-foreground' : 'font-medium text-foreground'}`}>
                        {item.title}
                      </span>

                      {publishTime && (
                        <span className="text-[10px] text-muted-foreground/80 shrink-0 font-mono">
                          {publishTime}
                        </span>
                      )}
                    </div>

                    {preview ? (
                      <p className="text-[11px] text-muted-foreground line-clamp-2 leading-relaxed pl-0 w-full">
                        {preview}
                      </p>
                    ) : null}
                  </DropdownMenuItem>
                );
              })
            )}
          </div>
        </DropdownMenuContent>
      </DropdownMenu>

      <AnnouncementDetailDialog
        announcement={selectedAnnouncement}
        open={detailOpen}
        onOpenChange={setDetailOpen}
        onAcknowledge={markAsRead}
      />
    </>
  );
}
