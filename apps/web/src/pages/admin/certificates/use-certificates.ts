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
  expectedRevision?: number;
  name: string;
  certificatePem?: string;
  privateKeyPem?: string;
}

export interface ParsedCertificate {
  fingerprint256: string;
  keyType: string;
  chainLength: number;
  duplicates: Array<{ id: string; name: string }>;
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

export function useAdminCertificates(search = '', page = 1, filters: { status?: string; association?: string; sort?: string } = {}) {
  return useQuery({
    queryKey: ['admin', 'certificates', 'list', search, page, filters],
    queryFn: async () => (await api.get<{ data: ApiCertificate[]; total: number }>('/admin/certificates', {
      params: { page, pageSize: 20, ...filters, ...(search.trim() ? { search: search.trim() } : {}) }
    })).data
  });
}

export interface CertificateSummary { total: number; expired: number; expiring: number; notYetValid: number; invalid: number; needsAttention: number }
export function useCertificateSummary(enabled = true) {
  return useQuery({ queryKey: ['admin', 'certificates', 'summary'], enabled, queryFn: async () => (await api.get<CertificateSummary>('/admin/certificates/summary')).data, refetchInterval: 60_000 });
}
export interface CertificateLine { id: string; name: string; type: string; relayMode: string | null; targetLine: { id: string; name: string } | null; protocolType: string; status: string; serverName: string; serverNames: string[]; matched: boolean; validationError: string | null; entryNode: { id: string; name: string } | null; landingNode: { id: string; name: string } | null; hostingNodeIds: string[]; hostingNodes: Array<{ id: string; name: string }>; inherited: boolean }
export interface CertificateRevision { revision: number; createdAt: string; metadata: { validFrom?: string; validTo?: string; sans?: string[]; fingerprint256?: string } }
export interface CertificateDeployment { id: string; nodeId: string; nodeName: string; nodeStatus: string; revision: number; configVersion: number | null; state: string; error: string | null }
export interface CertificatePreview { expectedRevision: number; before: CertificateRevision['metadata']; after: CertificateRevision['metadata']; lines: CertificateLine[]; contentChanged: boolean }
export function useCertificateRecords<T>(id: string | null, kind: 'lines' | 'revisions' | 'deployments', page = 1, enabled = true, filters: { search?: string; lineStatus?: string; relation?: string } = {}) {
  const activeFilters = Object.fromEntries(Object.entries(filters).filter(([, value]) => Boolean(value)));
  return useQuery({ queryKey: ['admin', 'certificates', id, kind, page, activeFilters], enabled: enabled && Boolean(id), queryFn: async () => (await api.get<{ data: T[]; total: number }>(`/admin/certificates/${id}/${kind}`, { params: { page, pageSize: 20, ...activeFilters } })).data, refetchInterval: kind === 'deployments' ? 5000 : false });
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
    gcTime: 0,
    mutationFn: async (payload: CertificatePayload) => (await api.post<{ certificate: ApiCertificate }>('/admin/certificates', payload)).data,
    onSuccess: () => { toast.success(i18n.t('admin:certificates.createSuccess')); invalidate(); },
    onError: (error: unknown) => onError(error, i18n.t('admin:certificates.createFailed'))
  });
  const update = useMutation({
    gcTime: 0,
    mutationFn: async ({ id, ...payload }: CertificatePayload & { id: string }) => (await api.patch<{ certificate: ApiCertificate }>(`/admin/certificates/${id}`, payload)).data,
    onSuccess: () => { toast.success(i18n.t('admin:certificateManagement.saved')); invalidate(); },
    onError: (error: unknown) => onError(error, i18n.t('admin:certificates.updateFailed'))
  });
  const remove = useMutation({
    mutationFn: async (id: string) => (await api.delete(`/admin/certificates/${id}`)).data,
    onSuccess: () => { toast.success(i18n.t('admin:certificates.deleteSuccess')); invalidate(); },
    onError: (error: unknown) => onError(error, i18n.t('admin:certificates.deleteFailed'))
  });
  const preview = useMutation({ gcTime: 0, mutationFn: async ({ id, ...payload }: CertificatePayload & { id: string }) => (await api.post<CertificatePreview>(`/admin/certificates/${id}/preview-update`, payload)).data, onError: (error: unknown) => onError(error, i18n.t('admin:certificates.updateFailed')) });
  const rollback = useMutation({ mutationFn: async (payload: { id: string; revision: number; expectedRevision: number }) => (await api.post(`/admin/certificates/${payload.id}/rollback`, { revision: payload.revision, expectedRevision: payload.expectedRevision })).data, onSuccess: () => { toast.success(i18n.t('admin:certificateManagement.saved')); invalidate(); }, onError: (error: unknown) => onError(error, i18n.t('admin:certificates.updateFailed')) });
  const retry = useMutation({ mutationFn: async ({ id, nodeIds }: { id: string; nodeIds?: string[] }) => (await api.post(`/admin/certificates/${id}/deployments/retry`, { nodeIds })).data, onSuccess: invalidate, onError: (error: unknown) => onError(error, i18n.t('admin:certificates.updateFailed')) });
  const download = useMutation({ mutationFn: async ({ id, format }: { id: string; format: 'leaf' | 'fullchain' | 'private-key' | 'bundle' }) => {
    const { data } = await api.post<Blob>(`/admin/certificates/${id}/export`, { format }, { responseType: 'blob' });
    const url = URL.createObjectURL(data);
    const link = document.createElement('a'); link.href = url; link.download = format === 'bundle' ? 'certificate-bundle.zip' : format + '.pem'; link.click(); URL.revokeObjectURL(url);
  }, onError: (error: unknown) => onError(error, i18n.t('admin:certificates.loadFailed')) });
  return { parse, create, update, remove, preview, rollback, retry, download };
}
