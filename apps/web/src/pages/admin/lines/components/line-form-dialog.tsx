import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { ExternalLineFields } from './external-line-fields';
import { SelectField } from './line-form-controls';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog';
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
import { useRealityKeypair, useLineOptions } from '../use-lines';
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
  createExternal?: boolean;
}

export function LineFormDialog({ open, onOpenChange, line, nodes, lines, certificates, pending, onSubmit, initialUpstreamNode, createExternal = false }: LineFormDialogProps) {
  const { t } = useTranslation(['admin', 'common']);
  const [tab, setTab] = useState('inbound');
  const [confirmPayload, setConfirmPayload] = useState<LinePayload | null>(null);
  const detail = useQuery({ queryKey: ['admin', 'line-detail', line?.id, open], queryFn: async () => (await api.get<{ line: AdminLine }>(`/admin/lines/${line!.id}`)).data.line, enabled: open && !!line, staleTime: 0, gcTime: 0, refetchOnWindowFocus: false });
  const ready = !line || (detail.isFetchedAfterMount && !!detail.data);
  const form = useForm<LineFormValues>({
    resolver: zodResolver(lineFormSchema),
    defaultValues: defaultLineFormValues()
  });
  const realityKeypair = useRealityKeypair();
  const options = useLineOptions(open);

  useFormResetOnKey({
    open,
    resetKey: line ? (ready ? line.id : null) : `create-${initialUpstreamNode?.id ?? ''}-${createExternal}`,
    reset: () => {
      setTab('inbound');
      const maxSort = lines.length ? Math.max(...lines.map((item) => item.sortOrder ?? 0)) : 0;
      setConfirmPayload(null);
      if (line && detail.data) {
        form.reset(lineToFormValues(detail.data));
      } else if (initialUpstreamNode) {
        const values = newLineFormValues(createExternal ? initialUpstreamNode.protocolType : 'VLESS', maxSort + 10);
        values.name = `${createExternal ? t('admin:upstream.createExternalLine') : t('admin:lines.typeRelay')} · ${initialUpstreamNode.name}`;
        values.type = createExternal ? 'EXTERNAL' : 'RELAY';
        if (createExternal) { values.isPublic = false; values.status = 'DISABLED'; values.trafficRate = 0; values.entryPort = undefined; }
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
      upstreamNodeId: current.upstreamNodeId,
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
    if (nextType === 'EXTERNAL') {
      form.setValue('isPublic', false, { shouldDirty: true });
      form.setValue('status', 'DISABLED', { shouldDirty: true });
      form.setValue('trafficRate', 0, { shouldDirty: true });
      setTab('advanced');
    } else if (form.getValues('trafficRate') === 0) form.setValue('trafficRate', 1);
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
    if (values.type === 'EXTERNAL') { setConfirmPayload(toLinePayload(values)); return; }
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
          <form noValidate onSubmit={form.handleSubmit(submit)} className="space-y-4">
            <FormField control={form.control} name="name" render={({ field }) => (
              <FormItem><FormLabel>{t('admin:lines.name')}</FormLabel><FormControl><Input disabled={!ready} placeholder={t('admin:lineForm.namePlaceholder')} {...field} /></FormControl><FormMessage /></FormItem>
            )} />
            {!ready ? <p>{detail.isError ? t('common:status.failed') : t('common:actions.loading')}</p> : <>
            <SelectField form={form} name="type" disabled={!!line} label={t('admin:lineForm.lineMode')} options={[{ value: 'DIRECT', label: t('admin:lineForm.modeDirect') }, { value: 'RELAY', label: t('admin:lineForm.modeRelay') }, { value: 'EXTERNAL', label: t('admin:upstream.createExternalLine') }]} onValueChange={(value) => { if (value === 'DIRECT' || value === 'RELAY' || value === 'EXTERNAL') changeType(value); }} />
            {form.watch('type') === 'EXTERNAL' ? <ExternalLineFields form={form} summary={initialUpstreamNode ?? detail.data?.upstreamSummary} /> :
            <Tabs value={tab} onValueChange={setTab} className="w-full">
              <TabsList className="grid w-full grid-cols-2">
                <TabsTrigger value="inbound">{t('admin:lineForm.tabInbound')}</TabsTrigger>
                <TabsTrigger value="advanced">{t('admin:lineForm.tabAdvanced')}</TabsTrigger>
              </TabsList>
              <TabsContent value="inbound" className="mt-4"><LineInboundFields form={form} nodes={nodes} certificates={certificates} onProtocolChange={changeProtocol} onGenerateKeys={generateKeys} keyPending={realityKeypair.isPending} /></TabsContent>
              <TabsContent value="advanced" className="mt-4"><LineAdvancedFields form={form} nodes={nodes} lines={options.data?.data ?? []} currentLineId={line?.id} onTypeChange={changeType} /></TabsContent>
            </Tabs>}
            </>}
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>{t('common:actions.cancel')}</Button>
              <Button type="submit" disabled={pending || !ready}>{pending ? t('common:actions.saving') : t('admin:lineForm.saveLine')}</Button>
            </DialogFooter>
          </form>
        </Form>
      </ResponsiveDialogContent>
      <AlertDialog open={!!confirmPayload} onOpenChange={(value) => !value && setConfirmPayload(null)}><AlertDialogContent><AlertDialogHeader><AlertDialogTitle>{t('admin:upstream.externalConfirm')}</AlertDialogTitle><AlertDialogDescription>{t('admin:upstream.externalRisk')} {t('admin:upstream.publicAllImpact')}</AlertDialogDescription></AlertDialogHeader><AlertDialogFooter><AlertDialogCancel>{t('common:actions.cancel')}</AlertDialogCancel><AlertDialogAction disabled={pending} onClick={() => { if (confirmPayload) onSubmit(confirmPayload); setConfirmPayload(null); }}>{t('common:actions.save')}</AlertDialogAction></AlertDialogFooter></AlertDialogContent></AlertDialog>
    </ResponsiveDialog>
  );
}
