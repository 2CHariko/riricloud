export type { KernelCheckResult } from '@/lib/probe-types';
import type { KernelCheckResult } from '@/lib/probe-types';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { api, extractErrorMessage } from '@/lib/api';
import i18n from '@/i18n/config';

export interface SubscriptionTemplate {
  id: string;
  name: string;
  description: string | null;
  isDefault: boolean;
  isBuiltin: boolean;
  proxyGroups: unknown[];
  ruleSets: unknown[];
  dnsConfig: Record<string, unknown>;
  customInjectYaml: string | null;
  customInjectJson: string | null;
}

export interface TemplatePayload {
  name: string;
  description?: string | null;
  proxyGroups: unknown[];
  ruleSets: unknown[];
  dnsConfig: Record<string, unknown>;
  customInjectYaml?: string | null;
  customInjectJson?: string | null;
  isDefault: boolean;
}


export interface TemplatePreviewResponse {
  format: 'clash' | 'singbox';
  content: string;
  stats: { totalNodes: number; matchedNodes: number; proxyGroupsCount: number; rulesCount: number };
  warnings: string[];
  kernelCheck: KernelCheckResult;
}

export function useAdminTemplates() {
  return useQuery({
    queryKey: ['admin', 'templates'],
    queryFn: async () => (await api.get<SubscriptionTemplate[]>('/admin/subscription-templates')).data
  });
}

export function useTemplateMutations() {
  const queryClient = useQueryClient();
  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['admin', 'templates'] });
  };
  const options = {
    onSuccess: () => { toast.success(i18n.t('admin:templates.saveSuccess')); invalidate(); },
    onError: (error: unknown) => toast.error(extractErrorMessage(error, i18n.t('admin:templates.opFailed')))
  };
  const create = useMutation({ mutationFn: async (payload: TemplatePayload) => (await api.post('/admin/subscription-templates', payload)).data, ...options });
  const update = useMutation({ mutationFn: async ({ id, ...payload }: TemplatePayload & { id: string }) => (await api.patch(`/admin/subscription-templates/${id}`, payload)).data, ...options });
  const remove = useMutation({
    mutationFn: async (id: string) => (await api.delete(`/admin/subscription-templates/${id}`)).data,
    onSuccess: () => { toast.success(i18n.t('admin:templates.deleteSuccess')); invalidate(); },
    onError: (error: unknown) => toast.error(extractErrorMessage(error, i18n.t('admin:templates.deleteFailed')))
  });
  const duplicate = useDuplicateTemplate();
  return { create, update, remove, duplicate };
}

export function useTemplatePreview() {
  return useMutation({
    mutationFn: async ({ format, template }: { format: 'clash' | 'singbox'; template: TemplatePayload }) =>
      (await api.post<TemplatePreviewResponse>('/admin/subscription-templates/preview', { format, template })).data,
    onError: (error: unknown) => toast.error(extractErrorMessage(error, i18n.t('admin:templates.previewFailed')))
  });
}

export function useDuplicateTemplate() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => (await api.post<SubscriptionTemplate>(`/admin/subscription-templates/${id}/duplicate`)).data,
    onSuccess: () => {
      toast.success(i18n.t('admin:templates.duplicateSuccess'));
      void queryClient.invalidateQueries({ queryKey: ['admin', 'templates'] });
    },
    onError: (error: unknown) => toast.error(extractErrorMessage(error, i18n.t('admin:templates.duplicateFailed')))
  });
}
