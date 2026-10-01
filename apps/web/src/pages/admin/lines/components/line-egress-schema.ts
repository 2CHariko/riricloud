import { z } from 'zod';
import i18n from '@/i18n/config';
import type { ApiEgressProxy, EgressProxyPayload, LineType, RelayMode } from '@/lib/api';

export const egressFormFields = {
  egressEnabled: z.boolean().default(false),
  egressProtocol: z.enum(['HTTP', 'SOCKS5']).default('HTTP'),
  egressServerHost: z.string().default(''),
  egressServerPort: z.preprocess((value) => value === '' || value == null ? undefined : value, z.coerce.number().optional()),
  egressAuthEnabled: z.boolean().default(false),
  egressUsername: z.string().default(''),
  egressPassword: z.string().default(''),
  egressHasPassword: z.boolean().default(false),
  egressUdpEnabled: z.boolean().default(false),
  egressClearConfirmed: z.boolean().default(false)
};

export type EgressFormValues = z.infer<z.ZodObject<typeof egressFormFields>>;
type EgressTopology = { type: LineType; relayMode?: RelayMode | null };

export function supportsOwnEgress(value: EgressTopology) {
  return value.type === 'DIRECT' || (value.type === 'RELAY' && (value.relayMode === 'BLIND_FORWARD' || value.relayMode === 'PROTOCOL_PROXY'));
}

export function egressToFormValues(proxy?: ApiEgressProxy | null): EgressFormValues {
  return {
    egressEnabled: !!proxy, egressProtocol: proxy?.protocol ?? 'HTTP',
    egressServerHost: proxy?.serverHost ?? '', egressServerPort: proxy?.serverPort,
    egressAuthEnabled: proxy?.authEnabled ?? false, egressUsername: proxy?.username ?? '',
    egressPassword: '', egressHasPassword: proxy?.hasPassword ?? false,
    egressUdpEnabled: proxy?.protocol === 'SOCKS5' && proxy.udpEnabled,
    egressClearConfirmed: false
  };
}

export function hasEgressDraft(value: EgressFormValues) {
  return value.egressEnabled || !!value.egressServerHost || value.egressServerPort != null || value.egressAuthEnabled || !!value.egressUsername || !!value.egressPassword || value.egressHasPassword || value.egressUdpEnabled;
}

export function validateEgress(value: EgressFormValues & EgressTopology, ctx: z.RefinementCtx) {
  const issue = (field: keyof EgressFormValues, key: 'clearRequired' | 'hostRequired' | 'portRequired' | 'usernameRequired' | 'passwordRequired') => ctx.addIssue({ code: 'custom', path: [field], message: i18n.t(`admin:lineForm.egress.${key}`) });
  if (!supportsOwnEgress(value)) {
    if (hasEgressDraft(value)) issue('egressEnabled', 'clearRequired');
    return;
  }
  if (!value.egressEnabled) return;
  const host = value.egressServerHost.trim();
  if (!host || host.length > 253 || /[\s/@?#]/.test(host) || host.includes('://')) issue('egressServerHost', 'hostRequired');
  if (!Number.isInteger(value.egressServerPort) || !value.egressServerPort || value.egressServerPort < 1 || value.egressServerPort > 65535) issue('egressServerPort', 'portRequired');
  if (value.egressAuthEnabled) {
    if (!value.egressUsername.trim()) issue('egressUsername', 'usernameRequired');
    if (!value.egressHasPassword && !value.egressPassword) issue('egressPassword', 'passwordRequired');
  }
}

export function toEgressPayload(value: EgressFormValues & EgressTopology): EgressProxyPayload | null | undefined {
  if (!supportsOwnEgress(value)) return value.egressClearConfirmed ? null : undefined;
  if (!value.egressEnabled) return null;
  return {
    protocol: value.egressProtocol, serverHost: value.egressServerHost.trim(),
    serverPort: value.egressServerPort!, authEnabled: value.egressAuthEnabled,
    udpEnabled: value.egressProtocol === 'SOCKS5' && value.egressUdpEnabled,
    ...(value.egressAuthEnabled ? { username: value.egressUsername, ...(value.egressPassword ? { password: value.egressPassword } : {}) } : {})
  };
}
