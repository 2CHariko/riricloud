import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { api, extractErrorMessage, type ApiCertificate } from '@/lib/api';
import i18n from '@/i18n/config';

export type { ApiCertificate };

export interface ApiCertificateDetail extends ApiCertificate {
  certificatePem: string;
  privateKeyPem: string;
}

export interface CertificatePayload {
  name: string;
  certificatePem: string;
  privateKeyPem?: string;
}

export interface ParsedCertificate {
  subject: string;
  issuer: string;
  serialNumber: string;
  sans: string[];
  validFrom: string;
  validTo: string;
  status: ApiCertificate['status'];
  daysUntilExpiry: number;
  privateKeyMatched: boolean | null;
}

export function useAdminCertificates(search = '') {
  return useQuery({
    queryKey: ['admin', 'certificates', search],
    queryFn: async () => (await api.get<{ data: ApiCertificate[]; total: number }>('/admin/certificates', {
      params: { page: 1, pageSize: 100, ...(search.trim() ? { search: search.trim() } : {}) }
    })).data
  });
}

export function useCertificateDetail(id: string | null, enabled = true) {
  return useQuery({
    queryKey: ['admin', 'certificates', 'detail', id],
    enabled: enabled && Boolean(id),
    gcTime: 0,
    queryFn: async ({ signal }) => (await api.get<{ certificate: ApiCertificateDetail }>(`/admin/certificates/${id}`, { signal })).data.certificate
  });
}

export function useCertificateMutations() {
  const queryClient = useQueryClient();
  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['admin', 'certificates'] });
    void queryClient.invalidateQueries({ queryKey: ['admin', 'lines'] });
  };
  const onError = (error: unknown, fallback: string) => toast.error(extractErrorMessage(error, fallback));
  const parse = useMutation({
    gcTime: 0,
    mutationFn: async (payload: { certificatePem: string; privateKeyPem?: string }) => (await api.post<ParsedCertificate>('/admin/certificates/parse', payload)).data,
    onError: () => undefined
  });
  const create = useMutation({
    mutationFn: async (payload: CertificatePayload) => (await api.post<{ certificate: ApiCertificate }>('/admin/certificates', payload)).data,
    onSuccess: () => { toast.success(i18n.t('admin:certificates.createSuccess')); invalidate(); },
    onError: (error: unknown) => onError(error, i18n.t('admin:certificates.createFailed'))
  });
  const update = useMutation({
    mutationFn: async ({ id, ...payload }: CertificatePayload & { id: string }) => (await api.patch<{ certificate: ApiCertificate }>(`/admin/certificates/${id}`, payload)).data,
    onSuccess: () => { toast.success(i18n.t('admin:certificates.updateSuccess')); invalidate(); },
    onError: (error: unknown) => onError(error, i18n.t('admin:certificates.updateFailed'))
  });
  const remove = useMutation({
    mutationFn: async (id: string) => (await api.delete(`/admin/certificates/${id}`)).data,
    onSuccess: () => { toast.success(i18n.t('admin:certificates.deleteSuccess')); invalidate(); },
    onError: (error: unknown) => onError(error, i18n.t('admin:certificates.deleteFailed'))
  });
  return { parse, create, update, remove };
}
