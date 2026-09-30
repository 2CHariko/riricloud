import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useFormResetOnKey } from '@/hooks/use-form-reset';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Button } from '@/components/ui/button';
import { DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { ResponsiveDialog, ResponsiveDialogContent } from '@/components/shared/responsive-dialog';
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form';
import { Input } from '@/components/ui/input';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import type { AdminNode } from '../../nodes/use-nodes';
import type { AdminLine, LinePayload } from '../use-lines';
import { useRealityKeypair } from '../use-lines';
import { LineAdvancedFields } from './line-advanced-fields';
import { LineInboundFields } from './line-inbound-fields';
import { defaultLineFormValues, lineFormSchema, lineToFormValues, newLineFormValues, toLinePayload, type LineFormValues } from './line-form-schema';
import type { ApiCertificate, ProtocolType, ApiUpstreamNode } from '@/lib/api';

interface LineFormDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  line: AdminLine | null;
  nodes: AdminNode[];
  lines: AdminLine[];
  certificates: ApiCertificate[];
  pending: boolean;
  onSubmit: (payload: LinePayload) => void;
  initialUpstreamNode?: ApiUpstreamNode | null;
}

export function LineFormDialog({ open, onOpenChange, line, nodes, lines, certificates, pending, onSubmit, initialUpstreamNode }: LineFormDialogProps) {
  const { t } = useTranslation(['admin', 'common']);
  const [tab, setTab] = useState('inbound');
  const form = useForm<LineFormValues>({
    resolver: zodResolver(lineFormSchema),
    defaultValues: defaultLineFormValues()
  });
  const realityKeypair = useRealityKeypair();

  useFormResetOnKey({
    open,
    resetKey: line?.id ?? 'create',
    reset: () => {
      setTab('inbound');
      const maxSort = lines.length ? Math.max(...lines.map((item) => item.sortOrder ?? 0)) : 0;
      if (line) {
        form.reset(lineToFormValues(line));
      } else if (initialUpstreamNode) {
        const values = newLineFormValues('VLESS', maxSort + 10);
        values.name = `${t('admin:lines.typeRelay')} · ${initialUpstreamNode.name}`;
        values.type = 'RELAY';
        values.relayMode = 'UPSTREAM_NODE';
        values.upstreamNodeId = initialUpstreamNode.id;
        form.reset(values);
      } else {
        form.reset(newLineFormValues('VLESS', maxSort + 10));
      }
    }
  });

  const changeProtocol = (protocolType: ProtocolType) => {
    const current = form.getValues();
    const next = defaultLineFormValues(protocolType);
    form.reset({
      ...next,
      name: current.name,
      tag: current.tag,
      listen: current.listen,
      type: current.type,
      relayMode: current.relayMode,
      targetLineId: current.targetLineId,
      entryNodeId: current.entryNodeId,
      entryPort: current.entryPort,
      landingNodeId: current.landingNodeId,
      landingPort: current.landingPort,
      certificateId: current.certificateId,
      endpointOverrideEnabled: current.endpointOverrideEnabled,
      serverHost: current.serverHost,
      serverPort: current.serverPort,
      serverName: current.serverName,
      host: current.host,
      landingEndpointOverrideEnabled: current.landingEndpointOverrideEnabled,
      landingServerHost: current.landingServerHost,
      landingServerPort: current.landingServerPort,
      trafficRate: current.trafficRate,
      tags: current.tags,
      level: current.level,
      sortOrder: current.sortOrder,
      isPublic: current.isPublic,
      status: current.status
    });
  };

  const changeType = (nextType: LineFormValues['type']) => {
    form.setValue('type', nextType, { shouldDirty: true });
    if (nextType === 'DIRECT') {
      form.setValue('landingNodeId', '', { shouldDirty: true });
      form.setValue('landingPort', undefined, { shouldDirty: true });
      form.setValue('targetLineId', '', { shouldDirty: true });
    }
  };

  const generateKeys = () => {
    realityKeypair.mutate(undefined, {
      onSuccess: (keys) => {
        form.setValue('realityPrivateKey', keys.privateKey, { shouldDirty: true });
        form.setValue('realityPublicKey', keys.publicKey, { shouldDirty: true });
        form.setValue('tlsMode', 'reality', { shouldDirty: true });
      }
    });
  };

  const submit = (values: LineFormValues) => {
    if (values.tlsMode === 'reality' && !values.realityPrivateKey.trim() && !line && values.realityPublicKey.trim()) {
      form.setError('realityPrivateKey', { message: t('admin:lineForm.realityKeyRequired') });
      setTab('inbound');
      return;
    }
    onSubmit(toLinePayload(values));
  };

  return (
    <ResponsiveDialog open={open} onOpenChange={onOpenChange}>
      <ResponsiveDialogContent size="wide">
        <DialogHeader>
          <DialogTitle>{line ? t('admin:lines.editLine') : t('admin:lines.createLine')}</DialogTitle>
        </DialogHeader>
        <Form {...form}>
          <form onSubmit={form.handleSubmit(submit)} className="space-y-4">
            <FormField control={form.control} name="name" render={({ field }) => (
              <FormItem><FormLabel>{t('admin:lines.name')}</FormLabel><FormControl><Input placeholder={t('admin:lineForm.namePlaceholder')} {...field} /></FormControl><FormMessage /></FormItem>
            )} />
            <Tabs value={tab} onValueChange={setTab} className="w-full">
              <TabsList className="grid w-full grid-cols-2">
                <TabsTrigger value="inbound">{t('admin:lineForm.tabInbound')}</TabsTrigger>
                <TabsTrigger value="advanced">{t('admin:lineForm.tabAdvanced')}</TabsTrigger>
              </TabsList>
              <TabsContent value="inbound" className="mt-4"><LineInboundFields form={form} nodes={nodes} certificates={certificates} onProtocolChange={changeProtocol} onGenerateKeys={generateKeys} keyPending={realityKeypair.isPending} /></TabsContent>
              <TabsContent value="advanced" className="mt-4"><LineAdvancedFields form={form} nodes={nodes} lines={lines} currentLineId={line?.id} onTypeChange={changeType} /></TabsContent>
            </Tabs>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>{t('common:actions.cancel')}</Button>
              <Button type="submit" disabled={pending}>{pending ? t('common:actions.saving') : t('admin:lineForm.saveLine')}</Button>
            </DialogFooter>
          </form>
        </Form>
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  );
}
