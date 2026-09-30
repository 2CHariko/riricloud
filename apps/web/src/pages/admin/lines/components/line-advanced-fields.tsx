import type { UseFormReturn } from 'react-hook-form';
import { useQuery } from '@tanstack/react-query';
import { upstreamApi } from '@/lib/api';
import { useTranslation } from 'react-i18next';
import { FormField, FormItem, FormLabel, FormControl, FormDescription } from '@/components/ui/form';
import { Switch } from '@/components/ui/switch';
import { Separator } from '@/components/ui/separator';
import type { AdminNode } from '../../nodes/use-nodes';
import type { AdminLine } from '../use-lines';
import { FieldGrid, SelectField, SwitchField, TextField } from './line-form-controls';
import { TARGET_LINE_PROTOCOLS, type LineFormValues } from './line-form-schema';

export function LineAdvancedFields({ form, nodes, lines, currentLineId, onTypeChange }: {
  form: UseFormReturn<LineFormValues>;
  nodes: AdminNode[];
  lines: AdminLine[];
  currentLineId?: string;
  onTypeChange: (type: LineFormValues['type']) => void;
}) {
  const { t } = useTranslation(['admin']);
  const type = form.watch('type');
  const relayMode = form.watch('relayMode');
  const entryNodeId = form.watch('entryNodeId');
  const landingNodeId = form.watch('landingNodeId');
  const targetLineId = form.watch('targetLineId');
  const endpointOverrideEnabled = form.watch('endpointOverrideEnabled');
  const landingEndpointOverrideEnabled = form.watch('landingEndpointOverrideEnabled');
  const selectedLandingNode = nodes.find((node) => node.id === landingNodeId);
  const isNatLanding = selectedLandingNode?.reachability === 'NAT';
  const nodeOptions = nodes
    .filter((node) => node.id !== entryNodeId)
    .map((node) => ({
      value: node.id,
      label: `${node.name} · ${node.serverHost}${node.reachability === 'NAT' ? t('admin:lineForm.natLandingTag') : ''}`
    }));
  const targetLines = lines.filter((line) => (
    line.id !== currentLineId &&
    line.type === 'DIRECT' &&
    line.entryNodeId !== entryNodeId &&
    TARGET_LINE_PROTOCOLS.includes(line.protocolType as (typeof TARGET_LINE_PROTOCOLS)[number]) &&
    (line.status === 'ACTIVE' || line.id === targetLineId)
  ));
  const targetLine = lines.find((line) => line.id === targetLineId);
  const targetLineOptions = targetLines.map((line) => ({
    value: line.id,
    label: `${line.name} · ${line.entryNode.name} · ${line.protocolType} · ${line.entryPort}${line.status === 'ACTIVE' ? '' : t('admin:lineForm.lineDisabledTag')}`
  }));
  const upstreamNodesQuery = useQuery({
    queryKey: ['admin-upstream-nodes-selector'],
    queryFn: async () => (await upstreamApi.listNodes({ status: 'ACTIVE', pageSize: 200 })).data,
    enabled: type === 'RELAY' && relayMode === 'UPSTREAM_NODE'
  });
  const upstreamNodeOptions = (upstreamNodesQuery.data?.data ?? []).map((node) => ({
    value: node.id,
    label: `${node.subscription?.name ? `[${node.subscription.name}] ` : ''}${node.name} · ${node.protocolType} · ${node.serverHost}:${node.serverPort}`
  }));
  const changeRelayMode = (value: string) => {
    form.setValue('relayMode', value as LineFormValues['relayMode'], { shouldDirty: true });
    if (value !== 'TARGET_LINE') form.setValue('targetLineId', '', { shouldDirty: true });
  };
  const changeTargetLine = (value: string) => {
    form.setValue('targetLineId', value, { shouldDirty: true });
    form.setValue('landingNodeId', '', { shouldDirty: true });
    form.setValue('landingPort', undefined, { shouldDirty: true });
  };
  return (
    <div className="space-y-6">
      <section className="space-y-3">
        <h3 className="text-sm font-medium">{t('admin:lineForm.sectionTopology')}</h3>
        <Separator />
        <FieldGrid>
          <SelectField
            form={form}
            name="type"
            label={t('admin:lineForm.lineMode')}
            options={[{ value: 'DIRECT', label: t('admin:lineForm.modeDirect') }, { value: 'RELAY', label: t('admin:lineForm.modeRelay') }]}
            onValueChange={(value) => onTypeChange(value as LineFormValues['type'])}
          />
          {type === 'RELAY' && relayMode !== 'TARGET_LINE' && relayMode !== 'UPSTREAM_NODE' && <SelectField form={form} name="landingNodeId" label={t('admin:lineForm.landingNode')} options={nodeOptions} />}
          {type === 'RELAY' && relayMode !== 'TARGET_LINE' && relayMode !== 'UPSTREAM_NODE' && <TextField form={form} name="landingPort" label={t('admin:lineForm.landingPort')} type="number" placeholder={t('admin:lineForm.landingPortPlaceholder')} />}
        </FieldGrid>
        {type === 'RELAY' && (
          <SelectField
            form={form}
            name="relayMode"
            label={t('admin:lineForm.relayMode')}
            options={
              isNatLanding
                ? [
                    { value: 'BLIND_FORWARD', label: t('admin:lineForm.relayModes.blindForwardNat') },
                    { value: 'PROTOCOL_PROXY', label: t('admin:lineForm.relayModes.protocolProxyNat') }
                  ]
                : [
                    { value: 'BLIND_FORWARD', label: t('admin:lineForm.relayModes.blindForward') },
                    { value: 'PROTOCOL_PROXY', label: t('admin:lineForm.relayModes.protocolProxy') },
                    { value: 'TARGET_LINE', label: t('admin:lineForm.relayModes.targetLine') },
                    { value: 'UPSTREAM_NODE', label: t('admin:lineForm.relayModes.upstreamNode') }
                  ]
            }
            onValueChange={changeRelayMode}
          />
        )}
        {type === 'RELAY' && isNatLanding && (
          <div className="space-y-3 rounded-md border border-amber-500/30 bg-amber-500/5 p-4 text-sm">
            <div className="flex items-center justify-between">
              <span className="font-medium text-amber-700 dark:text-amber-400">
                {t('admin:lineForm.natLandingTitle')}
              </span>
            </div>
            <p className="text-xs text-muted-foreground">
              {t('admin:lineForm.natLandingDesc')}
            </p>
            <SwitchField
              form={form}
              name="allowLanAccess"
              label={t('admin:lineForm.allowLanAccess')}
              description={t('admin:lineForm.allowLanAccessDesc')}
            />
            <FieldGrid>
              <TextField
                form={form}
                name="tunnelPort"
                label={t('admin:lineForm.tunnelPort')}
                type="number"
                placeholder={t('admin:lineForm.tunnelPortPlaceholder')}
                description={t('admin:lineForm.tunnelPortDesc')}
              />
              <TextField
                form={form}
                name="tunnelSecret"
                label={t('admin:lineForm.tunnelSecret')}
                placeholder={t('admin:lineForm.tunnelSecretPlaceholder')}
                description={t('admin:lineForm.tunnelSecretDesc')}
              />
            </FieldGrid>
          </div>
        )}
        {type === 'RELAY' && relayMode === 'TARGET_LINE' && <div className="space-y-3">
          <SelectField
            form={form}
            name="targetLineId"
            label={t('admin:lineForm.targetLineLabel')}
            options={targetLineOptions.length ? targetLineOptions : [{ value: '__no-target-line__', label: t('admin:lineForm.noTargetLine') }]}
            disabled={!entryNodeId || targetLineOptions.length === 0}
            description={t('admin:lineForm.targetLineDesc')}
            onValueChange={changeTargetLine}
          />
          {targetLine && <div className="rounded-md border bg-muted/30 p-3 text-sm">
            <p className="font-medium">{t('admin:lineForm.boundLandingTitle')}</p>
            <p className="mt-1 text-muted-foreground">
              {targetLine.entryNode.name} · {targetLine.endpointOverrideEnabled && targetLine.serverHost ? targetLine.serverHost : targetLine.entryNode.serverHost}:{targetLine.endpointOverrideEnabled && targetLine.serverPort ? targetLine.serverPort : targetLine.entryPort}
              {targetLine.endpointOverrideEnabled && Boolean(targetLine.serverHost || targetLine.serverPort) ? t('admin:lineForm.targetLineEndpointInherited') : ''}
            </p>
            <p className="text-muted-foreground">{t('admin:lineForm.targetProtocol')}{targetLine.protocolType} · {targetLine.status === 'ACTIVE' ? t('admin:lineForm.lineActive') : t('admin:lineForm.lineDisabled')}</p>
          </div>}
        </div>}
        {type === 'RELAY' && relayMode === 'UPSTREAM_NODE' && (
          <div className="space-y-3">
            <SelectField
              form={form}
              name="upstreamNodeId"
              label={t('admin:lineForm.upstreamNodeLabel')}
              options={upstreamNodeOptions.length ? upstreamNodeOptions : [{ value: '__no_upstream_node__', label: t('admin:lineForm.noUpstreamNode') }]}
              disabled={upstreamNodeOptions.length === 0}
              description={t('admin:lineForm.upstreamNodeDesc')}
            />
          </div>
        )}
      </section>

      <Separator />
      <section className="space-y-3">
        <h3 className="text-sm font-medium">{t('admin:lineForm.sectionEndpointOverride')}</h3>
        <Separator />
        <SwitchField form={form} name="endpointOverrideEnabled" label={t('admin:lineForm.endpointOverrideEnabled')} description={t('admin:lineForm.endpointOverrideDesc')} />
        {endpointOverrideEnabled && <FieldGrid>
          <TextField form={form} name="serverHost" label={t('admin:lineForm.serverHostOverride')} placeholder={t('admin:lineForm.serverHostPlaceholder')} />
          <TextField form={form} name="serverPort" label={t('admin:lineForm.serverPortOverride')} type="number" placeholder={t('admin:lineForm.serverPortPlaceholder')} />
          <TextField form={form} name="serverName" label={t('admin:lineForm.serverNameOverride')} placeholder={t('admin:lineForm.serverNamePlaceholder')} />
          <TextField form={form} name="host" label={t('admin:lineForm.hostOverride')} placeholder={t('admin:lineForm.hostPlaceholder')} />
        </FieldGrid>}
      </section>

      {type === 'RELAY' && <>
        <Separator />
        <section className="space-y-3">
          <h3 className="text-sm font-medium">{t('admin:lineForm.sectionLandingEndpointOverride')}</h3>
          <Separator />
          {isNatLanding ? (
            <p className="text-xs text-muted-foreground">{t('admin:lineForm.landingEndpointOverrideNatNotice')}</p>
          ) : (
            <>
              <SwitchField
                form={form}
                name="landingEndpointOverrideEnabled"
                label={t('admin:lineForm.landingEndpointOverrideEnabled')}
                description={t('admin:lineForm.landingEndpointOverrideDesc')}
              />
              {landingEndpointOverrideEnabled && (
                <FieldGrid>
                  <TextField
                    form={form}
                    name="landingServerHost"
                    label={t('admin:lineForm.landingServerHostOverride')}
                    placeholder={t('admin:lineForm.landingServerHostPlaceholder')}
                  />
                  <TextField
                    form={form}
                    name="landingServerPort"
                    label={t('admin:lineForm.landingServerPortOverride')}
                    type="number"
                    placeholder={t('admin:lineForm.landingServerPortPlaceholder')}
                  />
                </FieldGrid>
              )}
            </>
          )}
        </section>
      </>}
      <Separator />
      <section className="space-y-3">
        <h3 className="text-sm font-medium">{t('admin:lineForm.sectionAttributes')}</h3>
        <Separator />
        <FieldGrid>
          <TextField form={form} name="trafficRate" label={t('admin:lineForm.trafficRate')} type="number" inputProps={{ min: 0.01, step: 0.01 }} />
          <TextField form={form} name="tags" label={t('admin:lineForm.tags')} placeholder={t('admin:lineForm.tagsPlaceholder')} />
          <TextField form={form} name="level" label={t('admin:lineForm.level')} type="number" inputProps={{ min: 0 }} />
          <TextField form={form} name="sortOrder" label={t('admin:lineForm.sortOrder')} type="number" inputProps={{ min: 0 }} />
        </FieldGrid>
        <FieldGrid>
          <SwitchField form={form} name="isPublic" label={t('admin:lineForm.isPublic')} description={t('admin:lineForm.isPublicDesc')} />
          <StatusSwitch form={form} />
        </FieldGrid>
      </section>
    </div>
  );
}

function StatusSwitch({ form }: { form: UseFormReturn<LineFormValues> }) {
  const { t } = useTranslation(['admin']);
  return <FormField control={form.control} name="status" render={({ field }) => (
    <FormItem className="flex items-center justify-between gap-4">
      <div><FormLabel>{t('admin:lineForm.lineActiveLabel')}</FormLabel><FormDescription>{t('admin:lineForm.lineActiveDesc')}</FormDescription></div>
      <FormControl><Switch checked={field.value === 'ACTIVE'} onCheckedChange={(checked) => field.onChange(checked ? 'ACTIVE' : 'DISABLED')} /></FormControl>
    </FormItem>
  )} />;
}
