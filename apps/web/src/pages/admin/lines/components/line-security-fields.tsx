import { ExternalLink, KeyRound } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { Input } from '@/components/ui/input';
import { CertificatePager } from '../../certificates/certificate-pager';
import { useAdminCertificates } from '../../certificates/use-certificates';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import type { UseFormReturn } from 'react-hook-form';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { FormDescription, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form';
import { Label } from '@/components/ui/label';
import type { ApiCertificate } from '@/lib/api';
import { FieldGrid, SelectField, SwitchField, TextField } from './line-form-controls';
import { getAlpnOptions, MANUAL_CERTIFICATE_ID, type LineFormValues } from './line-form-schema';

const LOCAL_PROXY_PROTOCOLS = ['MIXED', 'SOCKS', 'HTTP'];

export function LineSecurityFields({ form, onGenerateParameters, parametersPending, certificates }: {
  form: UseFormReturn<LineFormValues>;
  onGenerateParameters: () => void;
  parametersPending: boolean;
  certificates: ApiCertificate[];
}) {
  const { t } = useTranslation(['admin']);
  const mode = form.watch('tlsMode');
  const protocolType = form.watch('protocolType');
  const transportType = form.watch('transportType');
  const tlsAlpn = form.watch('tlsAlpn');
  const certificateId = form.watch('certificateId');
  const [certificateSearch, setCertificateSearch] = useState('');
  const [certificatePage, setCertificatePage] = useState(1);
  const certificateQuery = useAdminCertificates(certificateSearch, certificatePage);
  const currentCertificate = useQuery({ queryKey: ['admin', 'certificates', 'public', certificateId], enabled: mode === 'tls' && Boolean(certificateId) && certificateId !== MANUAL_CERTIFICATE_ID, queryFn: async () => (await api.get<{ certificate: ApiCertificate }>('/admin/certificates/' + certificateId, { params: { publicOnly: true } })).data.certificate });
  const selectedCertificate = currentCertificate.data ?? certificates.find((certificate) => certificate.id === certificateId);
  const certificateOptions = [...new Map([...(certificateQuery.data?.data ?? []), ...(selectedCertificate ? [selectedCertificate] : [])].map(cert => [cert.id, cert])).values()];
  const alpnOptions = getAlpnOptions(protocolType, transportType, tlsAlpn);

  const tlsModes: Array<'none' | 'tls' | 'reality' | 'acme'> = LOCAL_PROXY_PROTOCOLS.includes(protocolType)
    ? ['none', 'tls', 'acme']
    : ['none', 'tls', 'reality', 'acme'];
  const tlsOptions = tlsModes.map((value) => ({
    value,
    label: t(`admin:lineForm.tlsModes.${value}` as const)
  }));

  useEffect(() => {
    if (mode !== 'tls' && certificateId !== MANUAL_CERTIFICATE_ID) {
      form.setValue('certificateId', MANUAL_CERTIFICATE_ID, { shouldDirty: true });
    }
  }, [certificateId, form, mode]);

  useEffect(() => {
    if (mode !== 'tls' || !selectedCertificate || form.getValues('tlsServerName').trim()) return;
    const suggestedName = selectedCertificate.sans.find(name => !name.includes('*') && !name.includes(':') && !/^\d+\.\d+\.\d+\.\d+$/.test(name));
    if (suggestedName) form.setValue('tlsServerName', suggestedName, { shouldDirty: true });
  }, [form, mode, selectedCertificate]);

  if (!['VLESS', 'VMESS', 'TROJAN', 'HYSTERIA2', 'TUIC', 'NAIVE', ...LOCAL_PROXY_PROTOCOLS].includes(protocolType)) return null;

  return (
    <div className="space-y-3">
      <SelectField form={form} name="tlsMode" label={t('admin:lineForm.tlsMode')} options={tlsOptions} />
      {mode !== 'none' && <>
        <FieldGrid>
          <TextField form={form} name="tlsServerName" label={t('admin:lineForm.tlsServerName')} placeholder={t('admin:lineForm.tlsServerNamePlaceholder')} />
          {mode !== 'reality' && <AlpnField form={form} options={alpnOptions} />}
        </FieldGrid>
        {mode !== 'reality' && (
          <FieldGrid>
            <SelectField
              form={form}
              name="tlsMinVersion"
              label={t('admin:lineForm.tlsMinVersion')}
              options={[
                { value: '', label: t('admin:lineForm.tlsVersionDefault12') },
                { value: '1.2', label: t('admin:lineForm.tlsVersion12') },
                { value: '1.3', label: t('admin:lineForm.tlsVersion13Safer') }
              ]}
            />
            <SelectField
              form={form}
              name="tlsMaxVersion"
              label={t('admin:lineForm.tlsMaxVersion')}
              options={[
                { value: '', label: t('admin:lineForm.tlsVersionDefault13') },
                { value: '1.3', label: t('admin:lineForm.tlsVersion13') },
                { value: '1.2', label: t('admin:lineForm.tlsVersion12') }
              ]}
            />
          </FieldGrid>
        )}
        {mode !== 'reality' && (
          <TextField
            form={form}
            name="tlsCipherSuites"
            label={t('admin:lineForm.tlsCipherSuites')}
            placeholder={t('admin:lineForm.tlsCipherSuitesPlaceholder')}
          />
        )}
        <SwitchField form={form} name="tlsInsecure" label={t('admin:lineForm.tlsInsecure')} description={t('admin:lineForm.tlsInsecureDesc')} />
      </>}
      {mode === 'tls' && <div className="space-y-3">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
          <div className="min-w-0 flex-1 space-y-2">
            <Input value={certificateSearch} onChange={event => { setCertificateSearch(event.target.value); setCertificatePage(1); }} placeholder={t('admin:certificates.searchPlaceholder')} />
            {certificateQuery.isError && <Button type="button" variant="outline" onClick={() => void certificateQuery.refetch()}>{t('admin:certificateManagement.retry')}</Button>}
            <SelectField
              form={form}
              name="certificateId"
              label={t('admin:lineForm.certificateId')}
              options={[
                { value: MANUAL_CERTIFICATE_ID, label: t('admin:lineForm.manualCertificate') },
                ...certificateOptions.map((certificate) => ({ value: certificate.id, label: `${certificate.name} · ${certificate.sans[0] ?? certificate.subject}` }))
              ]}
            />
          </div>
          <Button type="button" variant="outline" size="sm" asChild className="shrink-0"><Link to="/admin/certificates"><ExternalLink />{t('admin:lineForm.manageCertificates')}</Link></Button>
        </div>
        <CertificatePager page={certificatePage} total={certificateQuery.data?.total ?? 0} onChange={setCertificatePage} />
        {selectedCertificate ? <p className="text-xs text-muted-foreground">{t('admin:lineForm.certificateSelectedHint', { name: selectedCertificate.name })}</p> : <FieldGrid>
          <TextField form={form} name="tlsCertPath" label={t('admin:lineForm.tlsCertPath')} placeholder="/etc/ssl/cert.pem" />
          <TextField form={form} name="tlsKeyPath" label={t('admin:lineForm.tlsKeyPath')} placeholder="/etc/ssl/key.pem" />
        </FieldGrid>}
      </div>}
      {mode === 'reality' && <div className="space-y-3">
        <div className="flex items-center justify-between gap-2">
          <div><p className="text-sm font-medium">{t('admin:lineForm.realityParamsTitle')}</p><p className="text-xs text-muted-foreground">{t('admin:lineForm.realityParamsDesc')}</p></div>
          {protocolType === 'VLESS' && <Button type="button" variant="outline" size="sm" className="shrink-0" onClick={onGenerateParameters} disabled={parametersPending}><KeyRound />{t('admin:lineForm.generateParameters')}</Button>}
        </div>
        {protocolType === 'VLESS' && <p className="text-xs text-muted-foreground">{t('admin:lineForm.generateParametersHint')}</p>}
        <FieldGrid>
          <TextField form={form} name="realityDest" label={t('admin:lineForm.realityDest')} placeholder={t('admin:lineForm.realityDestPlaceholder')} />
          <TextField form={form} name="realityServerNames" label={t('admin:lineForm.realityServerNames')} placeholder={t('admin:lineForm.realityServerNamesPlaceholder')} />
          <TextField form={form} name="realityShortIds" label={t('admin:lineForm.realityShortIds')} placeholder={t('admin:lineForm.realityShortIdsPlaceholder')} />
          <TextField form={form} name="realityPublicKey" label={t('admin:lineForm.realityPublicKey')} placeholder={t('admin:lineForm.realityPublicKeyPlaceholder')} />
        </FieldGrid>
        <TextField form={form} name="realityPrivateKey" label={t('admin:lineForm.realityPrivateKey')} type="password" placeholder={t('admin:lineForm.realityPrivateKeyPlaceholder')} />
      </div>}
      {mode === 'acme' && <FieldGrid>
        <TextField form={form} name="acmeDomain" label={t('admin:lineForm.acmeDomain')} placeholder={t('admin:lineForm.acmeDomainPlaceholder')} />
        <TextField form={form} name="acmeEmail" label={t('admin:lineForm.acmeEmail')} placeholder={t('admin:lineForm.acmeEmailPlaceholder')} />
        <TextField form={form} name="acmeProvider" label={t('admin:lineForm.acmeProvider')} placeholder={t('admin:lineForm.acmeProviderPlaceholder')} />
      </FieldGrid>}
    </div>
  );
}

function AlpnField({ form, options }: {
  form: UseFormReturn<LineFormValues>;
  options: string[];
}) {
  const { t } = useTranslation(['admin']);
  return (
    <FormField control={form.control} name="tlsAlpn" render={({ field }) => (
      <FormItem>
        <FormLabel>{t('admin:lineForm.alpnLabel')}</FormLabel>
        <FormDescription>{t('admin:lineForm.alpnDesc')}</FormDescription>
        <div className="grid gap-2 sm:grid-cols-2">
          {options.map((value) => {
            const id = `alpn-${value.replace(/[^a-z0-9]+/gi, '-')}`;
            return (
              <div key={value} className="flex items-center gap-2 rounded-md border px-3 py-2">
                <Checkbox
                  id={id}
                  checked={field.value.includes(value)}
                  onCheckedChange={(nextChecked) => {
                    const next = nextChecked === true
                      ? [...new Set([...field.value, value])]
                      : field.value.filter((item) => item !== value);
                    field.onChange(next);
                  }}
                />
                <Label htmlFor={id} className="cursor-pointer font-normal">
                  {value === 'h3' ? 'HTTP/3 (h3)' : value === 'h2' ? 'HTTP/2 (h2)' : value === 'http/1.1' ? 'HTTP/1.1' : t('admin:lineForm.alpnCustom', { value })}
                </Label>
              </div>
            );
          })}
        </div>
        {options.length === 0 && <p className="text-xs text-muted-foreground">{t('admin:lineForm.alpnEmpty')}</p>}
        <FormMessage />
      </FormItem>
    )} />
  );
}
