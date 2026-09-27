import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { useTranslation } from 'react-i18next';
import { api, extractErrorMessage } from '@/lib/api';
import type { AnnouncementItem, AnnouncementType } from '@/lib/announcements';
import {
  derivePrimaryBannerText,
  parseAnnouncements
} from '@/lib/announcements';

export interface AdminAnnouncementPayload {
  title: string;
  content: string;
  type?: AnnouncementType;
  isPinned?: boolean;
  showBanner?: boolean;
  popupOnLogin?: boolean;
  enabled?: boolean;
}

export function useAdminAnnouncements(query?: {
  type?: string;
  status?: string;
  keyword?: string;
}) {
  const { t } = useTranslation('user');

  return useQuery({
    queryKey: ['admin-announcements', query],
    queryFn: async () => {
      const { data } = await api.get<{ siteAnnouncementsJson?: string; siteAnnouncement?: string }>('/admin/settings');
      const all = parseAnnouncements(data.siteAnnouncementsJson, data.siteAnnouncement, t('announcement.title'));

      let filtered = all;

      if (query?.type && query.type !== 'ALL') {
        filtered = filtered.filter((item) => item.type === query.type);
      }

      if (query?.status === 'ACTIVE') {
        filtered = filtered.filter((item) => item.enabled);
      } else if (query?.status === 'DISABLED') {
        filtered = filtered.filter((item) => !item.enabled);
      }

      if (query?.keyword?.trim()) {
        const kw = query.keyword.trim().toLowerCase();
        filtered = filtered.filter(
          (item) => item.title.toLowerCase().includes(kw) || item.content.toLowerCase().includes(kw)
        );
      }

      return filtered;
    }
  });
}

export function useAdminAnnouncementMutations() {
  const queryClient = useQueryClient();
  const { t } = useTranslation(['admin', 'user']);

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ['admin-announcements'] });
    queryClient.invalidateQueries({ queryKey: ['admin', 'settings'] });
    queryClient.invalidateQueries({ queryKey: ['system', 'public-info'] });
  };

  const getFullList = async (): Promise<AnnouncementItem[]> => {
    const { data } = await api.get<{ siteAnnouncementsJson?: string; siteAnnouncement?: string }>('/admin/settings');
    return parseAnnouncements(data.siteAnnouncementsJson, data.siteAnnouncement, t('user:announcement.title'));
  };

  const saveList = async (items: AnnouncementItem[]) => {
    const primaryBanner = derivePrimaryBannerText(items);
    await api.put('/admin/settings', {
      siteAnnouncementsJson: JSON.stringify(items),
      siteAnnouncement: primaryBanner
    });
  };

  const createMutation = useMutation({
    mutationFn: async (payload: AdminAnnouncementPayload) => {
      const currentList = await getFullList();
      const nowIso = new Date().toISOString();
      const newItem: AnnouncementItem = {
        id: `ann-${Date.now()}`,
        title: payload.title.trim(),
        content: payload.content.trim(),
        type: payload.type || 'NOTICE',
        isPinned: Boolean(payload.isPinned),
        showBanner: payload.showBanner !== undefined ? Boolean(payload.showBanner) : true,
        popupOnLogin: Boolean(payload.popupOnLogin),
        enabled: payload.enabled !== undefined ? Boolean(payload.enabled) : true,
        createdAt: nowIso,
        updatedAt: nowIso
      };
      const nextList = [newItem, ...currentList];
      await saveList(nextList);
      return newItem;
    },
    onSuccess: () => {
      invalidate();
      toast.success(t('admin:announcements.saveSuccess'));
    },
    onError: (err) => {
      toast.error(extractErrorMessage(err, t('admin:announcements.saveSuccess')));
    }
  });

  const updateMutation = useMutation({
    mutationFn: async ({
      id,
      payload
    }: {
      id: string;
      payload: Partial<AnnouncementItem>;
    }) => {
      const currentList = await getFullList();
      const nowIso = new Date().toISOString();
      const nextList = currentList.map((item) =>
        item.id === id
          ? {
              ...item,
              ...payload,
              title: payload.title !== undefined ? payload.title.trim() : item.title,
              content: payload.content !== undefined ? payload.content.trim() : item.content,
              updatedAt: nowIso
            }
          : item
      );
      await saveList(nextList);
      return id;
    },
    onSuccess: () => {
      invalidate();
      toast.success(t('admin:announcements.saveSuccess'));
    },
    onError: (err) => {
      toast.error(extractErrorMessage(err, t('admin:announcements.saveSuccess')));
    }
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: string) => {
      const currentList = await getFullList();
      const nextList = currentList.filter((item) => item.id !== id);
      await saveList(nextList);
      return id;
    },
    onSuccess: () => {
      invalidate();
      toast.success(t('admin:announcements.deleteSuccess'));
    },
    onError: (err) => {
      toast.error(extractErrorMessage(err, t('admin:announcements.deleteSuccess')));
    }
  });

  const toggleStatusMutation = useMutation({
    mutationFn: async ({ id, enabled }: { id: string; enabled: boolean }) => {
      const currentList = await getFullList();
      const nowIso = new Date().toISOString();
      const nextList = currentList.map((item) =>
        item.id === id ? { ...item, enabled, updatedAt: nowIso } : item
      );
      await saveList(nextList);
      return { id, enabled };
    },
    onSuccess: () => {
      invalidate();
      toast.success(t('admin:announcements.toggleStatusSuccess'));
    },
    onError: (err) => {
      toast.error(extractErrorMessage(err, t('admin:announcements.toggleStatusSuccess')));
    }
  });

  return {
    createMutation,
    updateMutation,
    deleteMutation,
    toggleStatusMutation
  };
}
