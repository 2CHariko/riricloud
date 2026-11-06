import { useState } from 'react';
import { useFormResetOnKey } from '@/hooks/use-form-reset';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@/lib/zod-resolver';
import { z } from 'zod';
import { Server } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import i18n from '@/i18n/config';
import { Button } from '@/components/ui/button';
import { CopyButton } from '@/components/shared/copy-button';
import {
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog';
import { ResponsiveDialog, ResponsiveDialogContent } from '@/components/shared/responsive-dialog';
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage
} from '@/components/ui/form';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useNodeMutations, type CreateNodeResult } from '../use-nodes';
import { InstallCommandsPicker } from './install-commands-picker';

const createSchema = z.object({
  name: z.string().max(32, i18n.t('admin:nodes.valName32Max')).optional(),
  reachability: z.enum(['PUBLIC', 'NAT']),
  serverHost: z.string().optional(),
  communicationMode: z.enum(['WS', 'HTTP'])
}).refine((data) => {
  if (data.reachability === 'PUBLIC') {
    return Boolean(data.serverHost && data.serverHost.trim().length > 0);
  }
  return true;
}, {
  message: i18n.t('admin:nodes.valServerHostReq'),
  path: ['serverHost']
});

type CreateForm = z.infer<typeof createSchema>;

interface NodeFormDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function NodeFormDialog({ open, onOpenChange }: NodeFormDialogProps) {
  const { t } = useTranslation(['admin', 'common']);
  const navigate = useNavigate();
  const { createNode } = useNodeMutations();
  const [created, setCreated] = useState<CreateNodeResult | null>(null);

  const createForm = useForm<CreateForm>({
    resolver: zodResolver(createSchema),
    defaultValues: { name: '', reachability: 'PUBLIC', serverHost: '', communicationMode: 'WS' }
  });

  useFormResetOnKey({
    open,
    resetKey: 'create',
    reset: () => {
      setCreated(null);
      createForm.reset({ name: '', reachability: 'PUBLIC', serverHost: '', communicationMode: 'WS' });
    }
  });

  const onCreateSubmit = (v: CreateForm) => {
    createNode.mutate(
       {
         name: v.name?.trim() || undefined,
         reachability: v.reachability,
         serverHost: v.reachability === 'NAT' ? (v.serverHost?.trim() || '127.0.0.1') : v.serverHost?.trim(),
         communicationMode: v.communicationMode
       },
       { onSuccess: (data) => { setCreated(data); } }
    );
  };

  return (
    <ResponsiveDialog open={open} onOpenChange={onOpenChange}>
      <ResponsiveDialogContent>
        {created ? (
          <>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <Server className="h-4 w-4" />
                {t('admin:nodes.addNode')}「{created.node.name}」
              </DialogTitle>
              <DialogDescription>
                {t('admin:nodes.installSubtitle')}
              </DialogDescription>
            </DialogHeader>
            <div className="min-w-0 space-y-3">
              <div className="flex items-center gap-2">
                <code className="bg-muted/50 min-w-0 flex-1 truncate rounded-md border px-3 py-2 text-xs">{created.agentToken}</code>
                <CopyButton value={created.agentToken} />
              </div>
              <InstallCommandsPicker
                key={created.node.id}
                commands={created.installCommands}
                fallbackCommand={created.installCommand}
                defaultMode={created.node.communicationMode === 'HTTP' ? 'http' : 'ws'}
                nodeId={created.node.id}
              />
            </div>
            <DialogFooter>
              <Button
                variant="outline"
                onClick={() => {
                  onOpenChange(false);
                  navigate(`/admin/nodes/${created.node.id}`);
                }}
              >
                {t('admin:nodes.details')}
              </Button>
              <Button onClick={() => onOpenChange(false)}>{t('common:actions.finish')}</Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>{t('admin:nodes.addNode')}</DialogTitle>
              <DialogDescription>{t('admin:nodes.subtitle')}</DialogDescription>
            </DialogHeader>
            <Form {...createForm}>
              <form className="space-y-4" onSubmit={createForm.handleSubmit(onCreateSubmit)}>
                <FormField
                  control={createForm.control}
                  name="name"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>{t('admin:nodes.name')}</FormLabel>
                      <FormControl>
                        <Input placeholder="Tokyo Node 01" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={createForm.control}
                  name="reachability"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>{t('admin:nodes.reachability')}</FormLabel>
                      <Select
                        value={field.value}
                        onValueChange={(val) => {
                          field.onChange(val);
                          if (val === 'NAT' && !createForm.getValues('serverHost')) {
                            createForm.setValue('serverHost', '127.0.0.1');
                          }
                        }}
                      >
                        <FormControl><SelectTrigger><SelectValue /></SelectTrigger></FormControl>
                        <SelectContent>
                          <SelectItem value="PUBLIC">{t('admin:nodes.reachabilityPublic')}</SelectItem>
                          <SelectItem value="NAT">{t('admin:nodes.reachabilityNat')}</SelectItem>
                        </SelectContent>
                      </Select>
                      <FormDescription>
                        {field.value === 'NAT'
                          ? t('admin:nodes.serverHostNatDesc')
                          : t('admin:nodes.serverHostPublicDesc')}
                      </FormDescription>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={createForm.control}
                  name="communicationMode"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>{t('admin:nodes.commMode')}</FormLabel>
                      <Select value={field.value} onValueChange={field.onChange}>
                        <FormControl><SelectTrigger><SelectValue /></SelectTrigger></FormControl>
                        <SelectContent>
                          <SelectItem value="WS">{t('admin:nodes.commModeWs')}</SelectItem>
                          <SelectItem value="HTTP">{t('admin:nodes.commModeHttp')}</SelectItem>
                        </SelectContent>
                      </Select>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                {createForm.watch('reachability') === 'PUBLIC' ? (
                  <FormField
                    control={createForm.control}
                    name="serverHost"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>{t('admin:nodes.serverHost')}</FormLabel>
                        <FormControl>
                          <Input placeholder="203.0.113.10" {...field} />
                        </FormControl>
                        <FormDescription>{t('admin:nodes.serverHostPublicDesc')}</FormDescription>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                ) : (
                  <FormField
                    control={createForm.control}
                    name="serverHost"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>{t('admin:nodes.serverHost')}</FormLabel>
                        <FormControl>
                          <Input placeholder="127.0.0.1" {...field} />
                        </FormControl>
                        <FormDescription>{t('admin:nodes.serverHostNatDesc')}</FormDescription>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                )}
                <DialogFooter>
                  <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                    {t('common:actions.cancel')}
                  </Button>
                  <Button type="submit" disabled={createNode.isPending}>
                    {createNode.isPending ? t('common:actions.submitting') : t('common:actions.create')}
                  </Button>
                </DialogFooter>
              </form>
            </Form>
          </>
        )}
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  );
}
