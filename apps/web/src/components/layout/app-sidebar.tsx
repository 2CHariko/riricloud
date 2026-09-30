import { Link, NavLink } from 'react-router-dom';
import { useCurrentUser } from '@/lib/current-user';
import { Activity, BookOpen, Cloud, FileText, GitBranch, Headphones, KeyRound, LayoutTemplate, Megaphone, Network, Package, Server, Settings, ShoppingBag, Users, WalletCards, Wallet, Ticket, Binary, ScrollText, Waypoints, Share2 } from 'lucide-react';
import { useAuthStore } from '@/stores/auth';
import { usePublicSettings } from '@/lib/public-settings';
import { SupportDialog } from '@/components/shared/support-dialog';
import { hasSupportContacts } from '@/lib/support';
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar
} from '@/components/ui/sidebar';

import { useTranslation } from 'react-i18next';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

// 侧边导航：结构化分组（控制台 / 管理后台）
export function AppSidebar() {
  const { t } = useTranslation('common');
  const user = useAuthStore((s) => s.user);
  const sessionQuery = useCurrentUser();
  const isAdmin = (sessionQuery.data ?? user)?.role === 'ADMIN';
  const { setOpenMobile } = useSidebar();
  const publicSettings = usePublicSettings();
  const siteName = publicSettings.data?.siteName || 'RiriCloud';
  const logoUrl = publicSettings.data?.logoUrl;

  const groups = [
    {
      label: t('nav.console'),
      items: [
        { to: '/subscription', label: t('nav.mySubscription'), icon: WalletCards, end: false },
        { to: '/proxy-pool', label: t('nav.directProxy'), icon: Network, end: false },
        { to: '/market', label: t('nav.market'), icon: ShoppingBag, end: false },
        { to: '/profile', label: t('nav.profile'), icon: Wallet, end: false },
        { to: '/help', label: t('nav.help', { defaultValue: '使用文档' }), icon: BookOpen, end: false }
      ]
    },
    ...(isAdmin
      ? [
          {
            label: t('nav.business'),
            items: [
              { to: '/admin/users', label: t('nav.users'), icon: Users, end: false },
              { to: '/admin/plans', label: t('nav.plans'), icon: Package, end: false },
              { to: '/admin/redeem-codes', label: t('nav.redeemCodes'), icon: Ticket, end: false },
              { to: '/admin/announcements', label: t('nav.announcements'), icon: Megaphone, end: false },
              { to: '/admin/docs', label: t('nav.docs', { defaultValue: '文档管理' }), icon: FileText, end: false }
            ]
          },
          {
            label: t('nav.network'),
            items: [
              { to: '/admin/nodes', label: t('nav.nodes'), icon: Server, end: false },
              { to: '/admin/lines', label: t('nav.lines'), icon: GitBranch, end: false },
              { to: '/admin/upstream', label: t('nav.upstream'), icon: Share2, end: false },
              { to: '/admin/certificates', label: t('nav.certificates'), icon: KeyRound, end: false },
              { to: '/admin/templates', label: t('nav.templates'), icon: LayoutTemplate, end: false },
              { to: '/admin/binaries', label: t('nav.binaries'), icon: Binary, end: false },
              { to: '/admin/mirrors', label: t('nav.mirrors'), icon: Waypoints, end: false }
            ]
          },
          {
            label: t('nav.monitoring'),
            items: [
              { to: '/admin/traffic', label: t('nav.traffic'), icon: Activity, end: false },
              { to: '/admin/logs', label: t('nav.logs'), icon: ScrollText, end: false },
              { to: '/admin/settings', label: t('nav.settings'), icon: Settings, end: false }
            ]
          }
        ]
      : [])
  ];

  return (
    <Sidebar variant="inset" aria-label={t('nav.mainNav')}>
      <SidebarHeader className="h-14 justify-center px-4">
        <Tooltip>
          <TooltipTrigger asChild>
            <Link
              to="/"
              className="flex items-center gap-2.5 px-1 rounded-md transition-opacity hover:opacity-80 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
            >
              <div className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-primary text-primary-foreground shadow-xs">
                {logoUrl ? <img src={logoUrl} alt="" className="size-4.5 rounded object-contain" /> : <Cloud className="size-4" />}
              </div>
              <span className="truncate font-semibold tracking-tight text-sidebar-foreground text-sm">{siteName}</span>
            </Link>
          </TooltipTrigger>
          <TooltipContent>{t('nav.home')}</TooltipContent>
        </Tooltip>
      </SidebarHeader>
      <SidebarContent className="px-2">
        {groups.map((group) => (
          <SidebarGroup key={group.label} className="py-1">
            <SidebarGroupLabel className="text-[11px] font-semibold tracking-wider text-sidebar-foreground/50 uppercase px-3 py-1">
              {group.label}
            </SidebarGroupLabel>
            <SidebarMenu className="gap-0.5">
              {group.items.map((item) => (
                <SidebarMenuItem key={item.to}>
                  <NavLink to={item.to} end={item.end} className="block" onClick={() => setOpenMobile(false)}>
                    {({ isActive }) => (
                      <SidebarMenuButton asChild active={isActive} className="rounded-lg px-3 py-2 text-sm">
                        <span><item.icon className="size-4" /><span>{item.label}</span></span>
                      </SidebarMenuButton>
                    )}
                  </NavLink>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroup>
        ))}
      </SidebarContent>
      <SidebarFooter className="p-3 space-y-2 border-t border-sidebar-border/50 shrink-0">
        {hasSupportContacts(publicSettings.data) && (
          <SidebarMenu>
            <SidebarMenuItem>
              <SupportDialog
                settings={publicSettings.data}
                trigger={
                  <SidebarMenuButton className="w-full justify-start rounded-lg px-3 py-2 text-xs text-sidebar-foreground/70 hover:text-sidebar-foreground">
                    <Headphones className="size-4" />
                    <span>{t('nav.support')}</span>
                  </SidebarMenuButton>
                }
              />
            </SidebarMenuItem>
          </SidebarMenu>
        )}
        <div className="px-2 text-center text-[11px] text-sidebar-foreground/45 space-y-0.5">
          {publicSettings.data?.footerCopyright ? (
            <p className="truncate" title={publicSettings.data.footerCopyright}>{publicSettings.data.footerCopyright}</p>
          ) : null}
          <p>v{__APP_VERSION__}</p>
        </div>
      </SidebarFooter>
    </Sidebar>
  );
}
