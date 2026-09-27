import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Cloud } from 'lucide-react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { SidebarTrigger } from '@/components/ui/sidebar';
import { usePublicSettings } from '@/lib/public-settings';
import { ThemeToggle } from './theme-toggle';
import { UserMenu } from './user-menu';
import { LanguageSwitcher } from './language-switcher';
import { AnnouncementCenter } from './announcement-center';

// 顶部操作栏：与左侧 Logo (h-14) 保持一致水平高度，位于主工作大卡片上方
export function AppHeader() {
  const { t } = useTranslation('common');
  const publicSettings = usePublicSettings();
  const siteName = publicSettings.data?.siteName || 'RiriCloud';
  const logoUrl = publicSettings.data?.logoUrl;

  return (
    <header className="flex h-14 shrink-0 items-center justify-between gap-3 px-3 text-sidebar-foreground sm:gap-4 sm:px-4 md:px-4">
      <div className="flex items-center gap-2 md:hidden">
        <SidebarTrigger />
        <Tooltip>
          <TooltipTrigger asChild>
            <Link
              to="/"
              className="flex items-center gap-2 rounded-md transition-opacity hover:opacity-80 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
            >
              {logoUrl ? (
                <img src={logoUrl} alt="" className="size-5 rounded object-contain" />
              ) : (
                <Cloud className="size-4.5 text-primary" />
              )}
              <span className="text-sm font-semibold tracking-tight text-foreground">{siteName}</span>
            </Link>
          </TooltipTrigger>
          <TooltipContent>{t('nav.home')}</TooltipContent>
        </Tooltip>
      </div>
      <div className="hidden md:flex flex-1" />
      <div className="flex items-center gap-2">
        <AnnouncementCenter />
        <LanguageSwitcher />
        <ThemeToggle />
        <UserMenu />
      </div>
    </header>
  );
}
