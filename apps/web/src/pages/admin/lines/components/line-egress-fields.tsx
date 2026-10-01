import type { UseFormReturn } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import { Separator } from '@/components/ui/separator';
import type { ApiLine } from '@/lib/api';
import type { AdminNode } from '../../nodes/use-nodes';
import { FieldGrid, SelectField, SwitchField, TextField } from './line-form-controls';
import type { LineFormValues } from './line-form-schema';
import { supportsOwnEgress } from './line-egress-schema';

export function LineEgressFields({ form, nodes, lines }: {
  form: UseFormReturn<LineFormValues>; nodes: AdminNode[]; lines: ApiLine[];
}) {
  const { t } = useTranslation('admin');
  const values = form.watch();
  const inherited = values.type === 'RELAY' && values.relayMode === 'TARGET_LINE';
  const target = lines.find((line) => line.id === values.targetLineId);
  const effective = target?.effectiveEgress;
  const nodeId = inherited ? effective?.nodeId ?? target?.entryNodeId : values.type === 'DIRECT' ? values.entryNodeId : values.landingNodeId;
  const node = nodes.find((item) => item.id === nodeId);
  const proxy = effective ? effective.proxy : target?.egressProxy;
  const editable = supportsOwnEgress(values);
  return <section className="space-y-3">
    <h3 className="text-sm font-medium">{t('lineForm.egress.title')}</h3>
    <Separator />
    {!editable ? <>
      <p className="text-sm text-muted-foreground">{t(inherited ? 'lineForm.egress.inheritedDesc' : 'lineForm.egress.unsupported')}</p>
      {inherited && <p className="break-all text-sm">{target ? proxy ? `${proxy.protocol} · ${proxy.serverHost}:${proxy.serverPort}` : t('lineForm.egress.inheritedDirect') : t('lineForm.egress.inheritedPending')}</p>}
    </> : <>
      <SwitchField form={form} name="egressEnabled" label={t('lineForm.egress.enabled')} description={t('lineForm.egress.description')} />
      {values.egressEnabled && <>
        <SelectField form={form} name="egressProtocol" label={t('lineForm.egress.protocol')} options={[{ value: 'HTTP', label: t('lineForm.egress.http') }, { value: 'SOCKS5', label: t('lineForm.egress.socks5') }]} onValueChange={(value) => {
          if (value !== 'HTTP' && value !== 'SOCKS5') return;
          form.setValue('egressProtocol', value, { shouldDirty: true });
          if (value === 'HTTP') form.setValue('egressUdpEnabled', false, { shouldDirty: true });
        }} />
        <FieldGrid>
          <TextField form={form} name="egressServerHost" label={t('lineForm.egress.host')} placeholder={t('lineForm.egress.hostPlaceholder')} />
          <TextField form={form} name="egressServerPort" label={t('lineForm.egress.port')} type="number" inputProps={{ min: 1, max: 65535, step: 1 }} />
        </FieldGrid>
        <SwitchField form={form} name="egressAuthEnabled" label={t('lineForm.egress.auth')} description={t('lineForm.egress.authDesc')} />
        {values.egressAuthEnabled && <FieldGrid>
          <TextField form={form} name="egressUsername" label={t('lineForm.egress.username')} inputProps={{ autoComplete: 'off' }} />
          <TextField form={form} name="egressPassword" label={t('lineForm.egress.password')} type="password" inputProps={{ autoComplete: 'new-password' }} description={t(values.egressHasPassword ? 'lineForm.egress.passwordKeep' : 'lineForm.egress.passwordNew')} />
        </FieldGrid>}
        <SwitchField form={form} name="egressUdpEnabled" disabled={values.egressProtocol === 'HTTP'} label={t('lineForm.egress.udp')} description={t('lineForm.egress.udpDesc')} />
        {values.egressProtocol === 'SOCKS5' && <p className="text-xs text-muted-foreground">{t('lineForm.egress.dns')}</p>}
      </>}
    </>}
    {(editable || inherited) && <>
      <p className="text-sm">{t('lineForm.egress.execution', { name: node?.name || target?.entryNode?.name || nodeId || t('lineForm.egress.selectNode') })}</p>
      <p className="text-xs text-muted-foreground">{t('lineForm.egress.namespace')}</p>
      <p className="text-xs text-amber-600 dark:text-amber-400">{t('lineForm.egress.failClosed')}</p>
    </>}
  </section>;
}
