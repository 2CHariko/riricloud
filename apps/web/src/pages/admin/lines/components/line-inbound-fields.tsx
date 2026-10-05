import type { UseFormReturn } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import { Separator } from '@/components/ui/separator';
import { FieldGrid, SelectField, TextField } from './line-form-controls';
import { LineNetworkFields } from './line-network-fields';
import { LineProtocolFields } from './line-protocol-fields';
import { hasProtocolSpecificFields } from './line-protocol-capabilities';
import { LineSecurityFields } from './line-security-fields';
import { LineTransportFields } from './line-transport-fields';
import { PROTOCOL_LABELS, PROTOCOL_TYPES, type LineFormValues } from './line-form-schema';
import type { ApiCertificate, ProtocolType } from '@/lib/api';
import type { AdminNode } from '../../nodes/use-nodes';

export function LineInboundFields({ form, nodes, certificates, onProtocolChange, onGenerateParameters, parametersPending }: {
  form: UseFormReturn<LineFormValues>;
  nodes: AdminNode[];
  onProtocolChange: (protocol: ProtocolType) => void;
  onGenerateParameters: () => void;
  parametersPending: boolean;
  certificates: ApiCertificate[];
}) {
  const { t } = useTranslation(['admin']);
  const protocol = form.watch('protocolType');
  const supportsTransport = ['VLESS', 'VMESS', 'TROJAN'].includes(protocol);
  const supportsTls = ['VLESS', 'VMESS', 'TROJAN', 'HYSTERIA2', 'TUIC', 'NAIVE', 'MIXED', 'SOCKS', 'HTTP'].includes(protocol);
  const supportsProtocolFields = hasProtocolSpecificFields(protocol);
  const nodeOptions = nodes
    .filter((node) => (node.reachability ?? 'PUBLIC') === 'PUBLIC')
    .map((node) => ({ value: node.id, label: `${node.name} · ${node.serverHost}` }));

  return (
    <div className="space-y-6">
      <section className="space-y-3">
        <h3 className="text-sm font-medium">{t('admin:lineForm.sectionBasicAndNetwork')}</h3>
        <Separator />
        <FieldGrid>
          <ProtocolSelect form={form} onProtocolChange={onProtocolChange} />
          <SelectField form={form} name="entryNodeId" label={t('admin:lineForm.entryNode')} options={nodeOptions} />
          <TextField form={form} name="tag" label={t('admin:lineForm.tag')} placeholder={t('admin:lineForm.tagPlaceholder')} />
          <TextField form={form} name="listen" label={t('admin:lineForm.listen')} placeholder={t('admin:lineForm.listenPlaceholder')} />
          <TextField form={form} name="entryPort" label={t('admin:lineForm.entryPort')} type="number" placeholder={t('admin:lineForm.entryPortPlaceholder')} />
        </FieldGrid>
        <p className="text-xs text-muted-foreground">{t('admin:lineForm.switchProtocolHint')}</p>
      </section>

      <Separator />
      <section className="space-y-3">
        <h3 className="text-sm font-medium">{t('admin:lineForm.sectionNetworkAndSpeedLimit')}</h3>
        <Separator />
        <LineNetworkFields form={form} />
      </section>

      {supportsTransport && <>
        <Separator />
        <section className="space-y-3">
          <h3 className="text-sm font-medium">{t('admin:lineForm.sectionTransport')}</h3>
          <Separator />
          <LineTransportFields form={form} />
        </section>
      </>}

      {supportsTls && <>
        <Separator />
        <section className="space-y-3">
          <h3 className="text-sm font-medium">{t('admin:lineForm.sectionSecurity')}</h3>
          <Separator />
          <LineSecurityFields form={form} onGenerateParameters={onGenerateParameters} parametersPending={parametersPending} certificates={certificates} />
        </section>
      </>}

      {supportsProtocolFields && <>
        <Separator />
        <section className="space-y-3">
          <h3 className="text-sm font-medium">{t('admin:lineForm.sectionProtocol')}</h3>
          <Separator />
          <LineProtocolFields form={form} />
        </section>
      </>}
    </div>
  );
}

function ProtocolSelect({ form, onProtocolChange }: { form: UseFormReturn<LineFormValues>; onProtocolChange: (protocol: ProtocolType) => void }) {
  const { t } = useTranslation(['admin']);
  return (
    <SelectField
      form={form}
      name="protocolType"
      label={t('admin:lineForm.protocol')}
      options={PROTOCOL_TYPES.map((value) => ({ value, label: PROTOCOL_LABELS[value] }))}
      onValueChange={(value) => onProtocolChange(value as ProtocolType)}
    />
  );
}
