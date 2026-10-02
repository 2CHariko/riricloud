import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { usePublicSettings } from './public-settings';

export type AnnouncementType = 'NOTICE' | 'MAINTENANCE' | 'EVENT' | 'URGENT';

export interface AnnouncementItem {
  id: string;
  title: string;
  content: string;
  type: AnnouncementType;
  isPinned: boolean;
  showBanner: boolean;
  popupOnLogin: boolean;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

const VALID_TYPES: AnnouncementType[] = ['NOTICE', 'MAINTENANCE', 'EVENT', 'URGENT'];

export const ANNOUNCEMENT_READ_STORAGE_KEY = 'riricloud:announcements:read_map';
export const ANNOUNCEMENT_BANNER_DISMISS_KEY = 'riricloud:announcements:banner_dismissed';
export const ANNOUNCEMENT_CHANGE_EVENT = 'riricloud:announcements-change';
export const ANNOUNCEMENT_SUMMARY_MAX_LINES = 3;
export const ANNOUNCEMENT_SUMMARY_MAX_CHARS = 160;

function isValidType(val: unknown): val is AnnouncementType {
  return typeof val === 'string' && VALID_TYPES.includes(val as AnnouncementType);
}

export function normalizeAnnouncementItem(raw: unknown, index = 0): AnnouncementItem | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  const id = typeof obj.id === 'string' && obj.id.trim() ? obj.id.trim() : `ann-${index}`;
  const title = typeof obj.title === 'string' ? obj.title.trim() : '';
  const content = typeof obj.content === 'string' ? obj.content : '';
  if (!title && !content.trim()) return null;

  const nowIso = new Date().toISOString();
  const createdAt = typeof obj.createdAt === 'string' && obj.createdAt.trim() ? obj.createdAt.trim() : nowIso;
  const updatedAt = typeof obj.updatedAt === 'string' && obj.updatedAt.trim() ? obj.updatedAt.trim() : createdAt;

  return {
    id,
    title: title || extractTitleFromContent(content) || id,
    content,
    type: isValidType(obj.type) ? obj.type : 'NOTICE',
    isPinned: Boolean(obj.isPinned),
    showBanner: Boolean(obj.showBanner),
    popupOnLogin: Boolean(obj.popupOnLogin),
    enabled: obj.enabled !== undefined ? Boolean(obj.enabled) : true,
    createdAt,
    updatedAt
  };
}

export function extractTitleFromContent(content: string): string {
  const firstLine = content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
  if (!firstLine) return '';
  return stripMarkdownPreview(firstLine).slice(0, 60);
}

export function parseAnnouncements(
  jsonStr?: string,
  legacyAnnouncement?: string,
  fallbackTitle = 'Announcement'
): AnnouncementItem[] {
  let list: AnnouncementItem[] = [];
  if (jsonStr && jsonStr.trim() && jsonStr.trim() !== '[]') {
    try {
      const parsed: unknown = JSON.parse(jsonStr);
      if (Array.isArray(parsed)) {
        list = parsed
          .map((item, idx) => normalizeAnnouncementItem(item, idx))
          .filter((item): item is AnnouncementItem => item !== null);
      }
    } catch {
      list = [];
    }
  }

  if (list.length === 0 && legacyAnnouncement && legacyAnnouncement.trim()) {
    const trimmed = legacyAnnouncement.trim();
    const extracted = extractTitleFromContent(trimmed);
    list = [
      {
        id: 'legacy-site-announcement',
        title: extracted || fallbackTitle,
        content: trimmed,
        type: 'NOTICE',
        isPinned: true,
        showBanner: true,
        popupOnLogin: false,
        enabled: true,
        createdAt: '',
        updatedAt: trimmed
      }
    ];
  }

  return list;
}

export function getActiveAnnouncements(items: AnnouncementItem[]): AnnouncementItem[] {
  const enabled = items.filter((item) => item.enabled && (item.title.trim() || item.content.trim()));
  const pinned = enabled.filter((item) => item.isPinned);
  const regular = enabled.filter((item) => !item.isPinned);
  return [...pinned, ...regular];
}

export function getBannerAnnouncements(items: AnnouncementItem[]): AnnouncementItem[] {
  return getActiveAnnouncements(items).filter((item) => item.showBanner);
}

export function stripMarkdownPreview(md: string): string {
  return md
    .replace(/\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]/gi, '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^[#>*+-]+\s+/gm, '')
    .replace(/(\*\*|__|\*|_|~~)/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * 生成公告纯文本摘要：按行取值而非按字符硬切，避免关键句被截断。
 * 首行与标题重复时（旧版单条公告的标题由正文首行推导）跳过首行，避免横幅重复展示。
 */
export function buildAnnouncementSummary(
  content: string,
  title?: string,
  maxLines = ANNOUNCEMENT_SUMMARY_MAX_LINES,
  maxChars = ANNOUNCEMENT_SUMMARY_MAX_CHARS
): string {
  const lines = content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const summary = lines
    .filter((line, index) => {
      if (index === 0 && title && stripMarkdownPreview(line).startsWith(title)) return false;
      return !line.startsWith('```');
    })
    .slice(0, maxLines)
    .map((line) => stripMarkdownPreview(line))
    .filter(Boolean)
    .join(' ');
  if (!summary) return '';
  return summary.length > maxChars ? `${summary.slice(0, maxChars).trimEnd()}…` : summary;
}

export function getAnnouncementVersionKey(item: AnnouncementItem): string {
  return `${item.id}:${item.updatedAt || item.createdAt || item.content.length}`;
}

export function readStorageMap(storageKey: string): Record<string, string> {
  if (typeof window === 'undefined') return {};
  try {
    const raw = window.localStorage.getItem(storageKey);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, string>;
    }
    return {};
  } catch {
    return {};
  }
}

export function writeStorageMap(storageKey: string, map: Record<string, string>): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(storageKey, JSON.stringify(map));
    window.dispatchEvent(new Event(ANNOUNCEMENT_CHANGE_EVENT));
  } catch {
    // ignore storage quota errors
  }
}

export function getAnnouncementTypeBadgeClass(type: AnnouncementType): string {
  switch (type) {
    case 'URGENT':
      return 'border-rose-500/30 bg-rose-500/10 text-rose-600 dark:text-rose-400';
    case 'MAINTENANCE':
      return 'border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400';
    case 'EVENT':
      return 'border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400';
    case 'NOTICE':
    default:
      return 'border-sky-500/30 bg-sky-500/10 text-sky-600 dark:text-sky-400';
  }
}

export function getAnnouncementBannerCardClass(type: AnnouncementType): string {
  switch (type) {
    case 'URGENT':
      return 'border-rose-500/35 bg-rose-500/[0.04]';
    case 'MAINTENANCE':
      return 'border-amber-500/35 bg-amber-500/[0.04]';
    case 'EVENT':
      return 'border-emerald-500/35 bg-emerald-500/[0.04]';
    case 'NOTICE':
    default:
      return 'border-primary/30 bg-primary/[0.04]';
  }
}

export function getAnnouncementBannerIconClass(type: AnnouncementType): string {
  switch (type) {
    case 'URGENT':
      return 'text-rose-500';
    case 'MAINTENANCE':
      return 'text-amber-500';
    case 'EVENT':
      return 'text-emerald-500';
    case 'NOTICE':
    default:
      return 'text-primary';
  }
}

export function derivePrimaryBannerText(items: AnnouncementItem[]): string {
  const banners = getBannerAnnouncements(items);
  if (banners.length === 0) return '';
  const first = banners[0];
  return first.content.trim() || first.title.trim();
}

export function useAnnouncements() {
  const { t } = useTranslation('user');
  const settings = usePublicSettings().data;
  const [readMap, setReadMap] = useState<Record<string, string>>(() =>
    readStorageMap(ANNOUNCEMENT_READ_STORAGE_KEY)
  );
  const [dismissMap, setDismissMap] = useState<Record<string, string>>(() =>
    readStorageMap(ANNOUNCEMENT_BANNER_DISMISS_KEY)
  );

  useEffect(() => {
    const syncFromStorage = () => {
      setReadMap(readStorageMap(ANNOUNCEMENT_READ_STORAGE_KEY));
      setDismissMap(readStorageMap(ANNOUNCEMENT_BANNER_DISMISS_KEY));
    };
    window.addEventListener(ANNOUNCEMENT_CHANGE_EVENT, syncFromStorage);
    window.addEventListener('storage', syncFromStorage);
    return () => {
      window.removeEventListener(ANNOUNCEMENT_CHANGE_EVENT, syncFromStorage);
      window.removeEventListener('storage', syncFromStorage);
    };
  }, []);

  const allAnnouncements = useMemo(
    () =>
      parseAnnouncements(
        settings?.siteAnnouncementsJson,
        settings?.siteAnnouncement,
        t('announcement.title')
      ),
    [settings?.siteAnnouncementsJson, settings?.siteAnnouncement, t]
  );

  const activeAnnouncements = useMemo(
    () => getActiveAnnouncements(allAnnouncements),
    [allAnnouncements]
  );

  const bannerAnnouncements = useMemo(
    () => getBannerAnnouncements(allAnnouncements),
    [allAnnouncements]
  );

  const isRead = useCallback(
    (item: AnnouncementItem): boolean => {
      const versionKey = getAnnouncementVersionKey(item);
      if (readMap[item.id] === versionKey) return true;
      // 兼容旧版单条横幅本地已读/关闭记忆
      if (
        item.id === 'legacy-site-announcement' &&
        typeof window !== 'undefined' &&
        window.localStorage.getItem(`riricloud:announcement:${item.content}`) === 'dismissed'
      ) {
        return true;
      }
      return false;
    },
    [readMap]
  );

  const isBannerDismissed = useCallback(
    (item: AnnouncementItem): boolean => {
      const versionKey = getAnnouncementVersionKey(item);
      if (dismissMap[item.id] === versionKey) return true;
      if (
        item.id === 'legacy-site-announcement' &&
        typeof window !== 'undefined' &&
        window.localStorage.getItem(`riricloud:announcement:${item.content}`) === 'dismissed'
      ) {
        return true;
      }
      return false;
    },
    [dismissMap]
  );

  const unreadAnnouncements = useMemo(
    () => activeAnnouncements.filter((item) => !isRead(item)),
    [activeAnnouncements, isRead]
  );

  const visibleBannerAnnouncements = useMemo(
    () => bannerAnnouncements.filter((item) => !isBannerDismissed(item)),
    [bannerAnnouncements, isBannerDismissed]
  );

  const popupAnnouncement = useMemo(
    () => activeAnnouncements.find((item) => item.popupOnLogin && !isRead(item)) ?? null,
    [activeAnnouncements, isRead]
  );

  const markAsRead = useCallback((item: AnnouncementItem) => {
    const next = {
      ...readStorageMap(ANNOUNCEMENT_READ_STORAGE_KEY),
      [item.id]: getAnnouncementVersionKey(item)
    };
    writeStorageMap(ANNOUNCEMENT_READ_STORAGE_KEY, next);
  }, []);

  const markAllAsRead = useCallback(() => {
    const current = readStorageMap(ANNOUNCEMENT_READ_STORAGE_KEY);
    const next = { ...current };
    for (const item of activeAnnouncements) {
      next[item.id] = getAnnouncementVersionKey(item);
    }
    writeStorageMap(ANNOUNCEMENT_READ_STORAGE_KEY, next);
  }, [activeAnnouncements]);

  const dismissBanner = useCallback((item: AnnouncementItem) => {
    const next = {
      ...readStorageMap(ANNOUNCEMENT_BANNER_DISMISS_KEY),
      [item.id]: getAnnouncementVersionKey(item)
    };
    writeStorageMap(ANNOUNCEMENT_BANNER_DISMISS_KEY, next);
    if (item.id === 'legacy-site-announcement' && typeof window !== 'undefined') {
      window.localStorage.setItem(`riricloud:announcement:${item.content}`, 'dismissed');
    }
  }, []);

  return {
    allAnnouncements,
    activeAnnouncements,
    bannerAnnouncements,
    visibleBannerAnnouncements,
    unreadAnnouncements,
    unreadCount: unreadAnnouncements.length,
    popupAnnouncement,
    isRead,
    isBannerDismissed,
    markAsRead,
    markAllAsRead,
    dismissBanner
  };
}
