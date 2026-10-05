import { useCallback, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import type { UseFormReturn } from 'react-hook-form';
import { toast } from 'sonner';
import { useRealityParameters } from '../use-lines';
import type { LineFormValues } from './line-form-schema';

export function useGenerateRealityParameters(form: UseFormReturn<LineFormValues>, open: boolean, draftKey: string) {
  const { t } = useTranslation(['admin']);
  const mutation = useRealityParameters();
  const request = useRef<AbortController | null>(null);
  const protocol = form.watch('protocolType');
  const mode = form.watch('tlsMode');
  const type = form.watch('type');

  const cancel = useCallback(() => {
    request.current?.abort();
    request.current = null;
  }, []);

  // 弹窗或草稿身份变化时，旧请求即使返回也不能覆盖当前表单。
  useEffect(() => {
    const subscription = form.watch((_values, { name }) => {
      // 用户手动修改参数或重置草稿时也取消，避免覆盖输入。
      if (!name || ['protocolType', 'tlsMode', 'type', 'realityShortIds', 'realityPublicKey', 'realityPrivateKey'].includes(name)) cancel();
    });
    return () => { subscription.unsubscribe(); cancel(); };
  }, [form, open, draftKey, cancel]);

  const generate = () => {
    if (!open || mutation.isPending || request.current || protocol !== 'VLESS' || mode !== 'reality' || type === 'EXTERNAL') return;
    const controller = new AbortController();
    request.current = controller;
    mutation.mutate(controller.signal, {
      onSuccess: (parameters) => {
        if (controller.signal.aborted || request.current !== controller) return;
        request.current = null;
        form.setValue('realityShortIds', parameters.shortIds.join(','), { shouldDirty: true });
        form.setValue('realityPublicKey', parameters.publicKey, { shouldDirty: true });
        form.setValue('realityPrivateKey', parameters.privateKey, { shouldDirty: true });
      },
      onError: () => {
        if (!controller.signal.aborted) toast.error(t('admin:lineForm.generateParametersFailed'));
      },
      onSettled: () => {
        if (request.current === controller) request.current = null;
      }
    });
  };

  return { generate, cancel, isPending: mutation.isPending };
}
