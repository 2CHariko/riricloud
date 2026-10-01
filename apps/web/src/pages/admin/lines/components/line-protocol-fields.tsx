import type { UseFormReturn } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import { FieldGrid, SelectField, SwitchField, TextField } from './line-form-controls';
import type { LineFormValues } from './line-form-schema';
import { requiresUpstreamUserAuth } from './proxy-pool-line-capabilities';

export function LineProtocolFields({ form }: { form: UseFormReturn<LineFormValues> }) {
  const { t } = useTranslation(['admin']);
  const protocol = form.watch('protocolType');
  const authRequired = requiresUpstreamUserAuth(form.watch());
  return <div className="space-y-3">
    {protocol === 'VLESS' && (
      <TextField
        form={form}
        name="vlessFlow"
        label={t('admin:lineForm.vlessFlow')}
        placeholder={t('admin:lineForm.vlessFlowPlaceholder')}
        disabled={form.watch('transportType') !== 'tcp'}
        description={form.watch('transportType') !== 'tcp' ? t('admin:lineForm.vlessFlowDisabled') : undefined}
      />
    )}
    {protocol === 'VMESS' && <TextField form={form} name="vmessAlterId" label={t('admin:lineForm.vmessAlterId')} type="number" placeholder="0" />}
    {protocol === 'HYSTERIA2' && <>
      <FieldGrid>
        <TextField form={form} name="hy2UpMbps" label={t('admin:lineForm.hy2UpMbps')} type="number" />
        <TextField form={form} name="hy2DownMbps" label={t('admin:lineForm.hy2DownMbps')} type="number" />
        <TextField form={form} name="hy2ObfsPassword" label={t('admin:lineForm.hy2ObfsPassword')} type="password" placeholder={t('admin:lineForm.hy2ObfsPlaceholder')} />
      </FieldGrid>
      <SwitchField form={form} name="hy2IgnoreClientBandwidth" label={t('admin:lineForm.hy2IgnoreClientBandwidth')} description={t('admin:lineForm.hy2IgnoreClientBandwidthDesc')} />
      <SelectField
        form={form}
        name="hy2MasqueradeType"
        label={t('admin:lineForm.hy2MasqueradeType')}
        options={[
          { value: 'none', label: t('admin:lineForm.hy2MasqModes.none') },
          { value: 'file', label: t('admin:lineForm.hy2MasqModes.file') },
          { value: 'proxy', label: t('admin:lineForm.hy2MasqModes.proxy') },
          { value: 'string', label: t('admin:lineForm.hy2MasqModes.string') }
        ]}
      />
      {form.watch('hy2MasqueradeType') === 'file' && (
        <TextField form={form} name="hy2MasqueradeFile" label={t('admin:lineForm.hy2MasqueradeFile')} placeholder={t('admin:lineForm.hy2MasqueradeFilePlaceholder')} />
      )}
      {form.watch('hy2MasqueradeType') === 'proxy' && (
        <TextField form={form} name="hy2MasqueradeProxyUrl" label={t('admin:lineForm.hy2MasqueradeProxyUrl')} placeholder={t('admin:lineForm.hy2MasqueradeProxyPlaceholder')} />
      )}
      {form.watch('hy2MasqueradeType') === 'string' && (
        <TextField form={form} name="hy2MasqueradeString" label={t('admin:lineForm.hy2MasqueradeString')} placeholder={t('admin:lineForm.hy2MasqueradeStringPlaceholder')} />
      )}
    </>}
    {protocol === 'TUIC' && <FieldGrid>
      <SelectField form={form} name="tuicCongestionControl" label={t('admin:lineForm.tuicCongestionControl')} options={[{ value: 'bbr', label: 'BBR' }, { value: 'cubic', label: 'CUBIC' }, { value: 'new_reno', label: 'New Reno' }]} />
      <TextField form={form} name="tuicHeartbeat" label={t('admin:lineForm.tuicHeartbeat')} placeholder={t('admin:lineForm.tuicHeartbeatPlaceholder')} />
      <SwitchField form={form} name="tuicZeroRtt" label={t('admin:lineForm.tuicZeroRtt')} />
    </FieldGrid>}
    {protocol === 'SHADOWSOCKS' && <>
      <FieldGrid>
        <TextField form={form} name="ssMethod" label={t('admin:lineForm.ssMethod')} placeholder={t('admin:lineForm.ssMethodPlaceholder')} />
        <SelectField form={form} name="ssMode" label={t('admin:lineForm.ssMode')} options={[{ value: 'shared', label: t('admin:lineForm.ssModes.shared') }, { value: 'multi-user', label: t('admin:lineForm.ssModes.multiUser') }]} />
      </FieldGrid>
      <TextField form={form} name="ssPassword" label={t('admin:lineForm.ssPassword')} type="password" placeholder={t('admin:lineForm.ssPasswordPlaceholder')} />
      <SwitchField
        form={form}
        name="ssUdpOverTcp"
        label={t('admin:lineForm.ssUdpOverTcp')}
        description={t('admin:lineForm.ssUdpOverTcpDesc')}
      />
    </>}
    {protocol === 'NAIVE' && <SelectField form={form} name="naiveNetwork" label={t('admin:lineForm.naiveNetwork')} options={[{ value: 'tcp', label: 'TCP' }, { value: 'udp', label: 'UDP' }]} />}
    {protocol === 'SHADOWTLS' && <>
      <FieldGrid>
        <TextField form={form} name="stHandshakeDest" label={t('admin:lineForm.stHandshakeDest')} placeholder={t('admin:lineForm.stHandshakeDestPlaceholder')} />
        <TextField form={form} name="stInnerMethod" label={t('admin:lineForm.stInnerMethod')} placeholder={t('admin:lineForm.stInnerMethodPlaceholder')} />
        <TextField form={form} name="stInnerPassword" label={t('admin:lineForm.stInnerPassword')} type="password" placeholder={t('admin:lineForm.stInnerPasswordPlaceholder')} />
      </FieldGrid>
      <SwitchField form={form} name="stStrictMode" label={t('admin:lineForm.stStrictMode')} description={t('admin:lineForm.stStrictModeDesc')} />
    </>}
    {['MIXED', 'SOCKS', 'HTTP'].includes(protocol) && <FieldGrid>
      <SwitchField form={form} name="localAllowLan" label={t('admin:lineForm.localAllowLan')} />
      <SwitchField form={form} name="localUsersEnabled" label={t('admin:lineForm.localUsersEnabled')} />
    </FieldGrid>}
    {authRequired && <p className="text-sm text-destructive">{t('admin:lineForm.upstreamUsersRequired')}</p>}
    {protocol === 'DIRECT' && <FieldGrid>
      <TextField form={form} name="directOverrideAddress" label={t('admin:lineForm.directOverrideAddress')} placeholder={t('admin:lineForm.directOverrideAddressPlaceholder')} />
      <TextField form={form} name="directOverridePort" label={t('admin:lineForm.directOverridePort')} type="number" placeholder={t('admin:lineForm.directOverridePortPlaceholder')} />
    </FieldGrid>}
  </div>;
}
