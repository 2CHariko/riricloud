import { useRef } from 'react';
import { useIsMutating, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import i18n from '@/i18n/config';
import { getLineCredentialStatus, rotateLineCredentials } from './line-credentials-api';
import { canMaintainLineCredentials, credentialErrorKey, isCredentialLine, isCredentialMaintenanceRunning, type CredentialLine, type LineCredentialStatus } from './line-credentials-contract';

export const credentialQueryKey = (lineId: string) => ['admin', 'line-credentials', lineId] as const;

export function lineCredentialQueryOptions(lineId: string, enabled: boolean) {
  return {
    queryKey: credentialQueryKey(lineId),
    enabled,
    queryFn: ({ signal }: { signal: AbortSignal }) => getLineCredentialStatus(lineId, signal),
    staleTime: 0,
    gcTime: 0,
    retry: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    refetchOnMount: 'always' as const,
    refetchInterval: (query: { state: { data?: LineCredentialStatus; status: string } }) =>
      enabled && query.state.status !== 'error' && isCredentialMaintenanceRunning(query.state.data?.state) ? 2000 : false
  };
}

export function useLineCredentials(line: CredentialLine, open: boolean) {
  const client = useQueryClient();
  const requestLock = useRef(false);
  const mutationKey = ['admin', 'line-credentials', 'rotate', line.id];
  const pendingRotations = useIsMutating({ mutationKey });
  const query = useQuery(lineCredentialQueryOptions(line.id, open && isCredentialLine(line)));
  const rotation = useMutation({
    mutationKey,
    retry: false,
    mutationFn: () => rotateLineCredentials(line.id),
    onMutate: () => client.cancelQueries({ queryKey: credentialQueryKey(line.id) }),
    onSuccess: async () => {
      // 状态仅从服务端重新读取，不把 202 受理响应当成运行成功或拼接缓存。
      await Promise.all([
        client.invalidateQueries({ queryKey: credentialQueryKey(line.id) }),
        client.invalidateQueries({ queryKey: ['admin', 'lines'] }),
        client.invalidateQueries({ queryKey: ['admin', 'nodes'] })
      ]);
    },
    onError: async (error: unknown) => {
      toast.error(i18n.t(`admin:lineCredentials.errors.${credentialErrorKey(error)}`));
      await client.invalidateQueries({ queryKey: credentialQueryKey(line.id) });
    },
    onSettled: () => { requestLock.current = false; }
  });
  const mutationPending = rotation.isPending || pendingRotations > 0;
  const canRotate = open && canMaintainLineCredentials(line, query.data)
    && !query.isFetching && !query.isError && !mutationPending && !rotation.isError;
  const requestRotation = () => {
    if (!canRotate || requestLock.current) return;
    requestLock.current = true;
    rotation.mutate();
  };
  const refresh = async () => {
    if (!open || mutationPending) return;
    const result = await query.refetch();
    if (!result.isError) rotation.reset();
  };
  return { query, rotation, mutationPending, canRotate, requestRotation, refresh };
}
