import { useForm } from 'react-hook-form';
import { zodResolver } from '@/lib/zod-resolver';
import { z } from 'zod';
import { KeyRound } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useFormResetOnKey } from '@/hooks/use-form-reset';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Form, FormControl, FormDescription, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { type ProxyKey, useProxyPoolMutations } from '../use-proxy-pool';

// 与后端 proxy-key.util 保持同口径的轻量前置校验（仅用于即时提示，最终以后端为准）
function isValidIpOrCidr(value: string): boolean {
  const candidate = value.trim();
  if (!candidate) return false;
  const slashIndex = candidate.indexOf('/');
  const host = slashIndex === -1 ? candidate : candidate.slice(0, slashIndex);
  const prefix = slashIndex === -1 ? null : candidate.slice(slashIndex + 1);
  const isV4 = /^(?:(?:25[0-5]|2[0-4]\d|1\d{2}|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d{2}|[1-9]?\d)$/.test(host);
  const isV6 = !isV4 && /^[0-9a-fA-F:]+$/.test(host) && host.includes(':');
  if (!isV4 && !isV6) return false;
  if (prefix === null) return true;
  if (!/^\d{1,3}$/.test(prefix)) return false;
  const numeric = Number(prefix);
  return isV4 ? numeric >= 0 && numeric <= 32 : numeric >= 0 && numeric <= 128;
}

const schema = z.object({
  name: z.string().trim().min(1, 'user:proxyPool.keyNameRequired').max(60, 'user:proxyPool.keyNameMax'),
  whitelistIps: z
    .string()
    .max(2000, 'user:proxyPool.whitelistTooLong')
    .refine(
      (value) => value.split(/[\s,;]+/).filter(Boolean).every(isValidIpOrCidr),
      'user:proxyPool.whitelistError'
    )
});

type ProxyKeyFormValues = z.infer<typeof schema>;

interface ProxyKeyDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  editing?: ProxyKey | null;
}

// 凭据新增/编辑弹窗（全量 shadcn Form 控件，无裸 HTML 交互标签）
export function ProxyKeyDialog({ open, onOpenChange, editing }: ProxyKeyDialogProps) {
  const { t } = useTranslation(['user', 'common']);
  const { createKey, updateKey } = useProxyPoolMutations();
  const form = useForm<ProxyKeyFormValues>({
    resolver: zodResolver(schema),
    defaultValues: { name: '', whitelistIps: '' }
  });

  // 表单草稿契约：仅以 (open, editing.id) 为触发条件，避免列表轮询清空用户输入
  useFormResetOnKey({
    open,
    resetKey: open ? (editing?.id ?? 'create') : null,
    reset: () =>
      form.reset({
        name: editing?.name ?? '',
        whitelistIps: editing?.whitelistIps.join('\n') ?? ''
      })
  });

  const isPending = createKey.isPending || updateKey.isPending;

  const onSubmit = (values: ProxyKeyFormValues) => {
    const payload = { name: values.name.trim(), whitelistIps: values.whitelistIps.trim() };
    const onSuccess = () => onOpenChange(false);
    if (editing) {
      updateKey.mutate({ id: editing.id, ...payload }, { onSuccess });
      return;
    }
    createKey.mutate(payload, { onSuccess });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <KeyRound className="size-4" />
            {editing ? t('user:proxyPool.editKeyTitle') : t('user:proxyPool.createKeyTitle')}
          </DialogTitle>
          <DialogDescription>
            {editing
              ? t('user:proxyPool.editKeyDesc')
              : t('user:proxyPool.createKeyDesc')}
          </DialogDescription>
        </DialogHeader>
        <Form {...form}>
          <form className="space-y-4" onSubmit={form.handleSubmit(onSubmit)}>
            <FormField
              control={form.control}
              name="name"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t('user:proxyPool.keyName')}</FormLabel>
                  <FormControl>
                    <Input placeholder={t('user:proxyPool.keyNamePlaceholder')} autoComplete="off" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="whitelistIps"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t('user:proxyPool.whitelistLabel')}</FormLabel>
                  <FormControl>
                    <Textarea
                      rows={4}
                      placeholder={'203.0.113.10\n198.51.100.0/24'}
                      className="font-mono text-xs"
                      {...field}
                    />
                  </FormControl>
                  <FormDescription>
                    {t('user:proxyPool.whitelistDesc')}
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                {t('common:actions.cancel')}
              </Button>
              <Button type="submit" disabled={isPending}>
                {isPending ? t('user:proxyPool.saving') : editing ? t('user:proxyPool.saveChanges') : t('user:proxyPool.createKeyButton')}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
