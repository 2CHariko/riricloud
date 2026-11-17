import type { LineCredentialRotation } from '@prisma/client';
import { normalizeShadowsocksPassword, parseTrafficCredential, resolveShadowsocksUserPassword, type InboundUserCredential } from '../common/inbound';
import type { RelayCredentialView } from './line-credential.types';

type ObjectValue = Record<string, unknown>;
const objects = (value: unknown): ObjectValue[] => Array.isArray(value) ? value.filter((item): item is ObjectValue => !!item && typeof item === 'object' && !Array.isArray(item)) : [];
function sameIdentity(user: ObjectValue, credential: InboundUserCredential) {
  const name = typeof user.name === 'string' ? user.name : typeof user.username === 'string' ? user.username : null;
  return name !== null && parseTrafficCredential(name).rawCredential === credential.email;
}
export function inboundUsesCredential(inbound: ObjectValue, credential: InboundUserCredential): boolean {
  const method = typeof inbound.method === 'string' ? inbound.method : '';
  if (inbound.type === 'shadowsocks' && !Array.isArray(inbound.users)) return inbound.password === normalizeShadowsocksPassword(method, credential.credential);
  return objects(inbound.users).some(user => {
    if (!sameIdentity(user, credential)) return false;
    switch (inbound.type) {
      case 'vless': case 'vmess': return user.uuid === credential.uuid;
      case 'tuic': return user.uuid === credential.uuid && user.password === credential.credential;
      case 'shadowsocks': return user.password === resolveShadowsocksUserPassword(method, credential.credential, credential.uuid);
      case 'trojan': case 'hysteria2': case 'naive': return user.password === credential.credential;
      default: return false;
    }
  });
}
function outboundUsesCredential(outbound: ObjectValue, credential: InboundUserCredential): boolean {
  switch (outbound.type) {
    case 'vless': case 'vmess': return outbound.uuid === credential.uuid;
    case 'tuic': return outbound.uuid === credential.uuid && outbound.password === credential.credential;
    case 'naive': return typeof outbound.username === 'string' && parseTrafficCredential(outbound.username).rawCredential === credential.email && outbound.password === credential.credential;
    case 'trojan': case 'hysteria2': return outbound.password === credential.credential;
    case 'shadowsocks': {
      const method = typeof outbound.method === 'string' ? outbound.method : '';
      const userPassword = resolveShadowsocksUserPassword(method, credential.credential, credential.uuid);
      return outbound.password === normalizeShadowsocksPassword(method, credential.credential) || outbound.password === userPassword || typeof outbound.password === 'string' && outbound.password.endsWith(':' + userPassword);
    }
    default: return false;
  }
}
export function proveRelayConfiguration(config: ObjectValue, row: LineCredentialRotation, view: RelayCredentialView, oldCredential?: InboundUserCredential | null): boolean {
  const inbounds = objects(config.inbounds);
  const outbounds = objects(config.outbounds);
  const withoutEntry = (tag: string | null) => !!tag && !inbounds.some(item => item.tag === tag || item.tag === tag + '-inner');
  if (row.stage === 'STOPPING_PREVIOUS_ENTRY') return withoutEntry(row.previousEntryTag);
  if (row.stage === 'STOPPING_ENTRY' || row.stage === 'FAILED') return withoutEntry(row.entryTag);
  if (row.stage === 'RETIRING_PREVIOUS_LANDING') return !!oldCredential && !inbounds.some(item => inboundUsesCredential(item, oldCredential));
  if (!view.credential) return false;
  if (row.stage === 'APPLYING_LANDING') {
    const landing = inbounds.find(item => item.tag === row.landingTag);
    return !!landing && inboundUsesCredential(landing, view.credential) && (row.targetLineId !== null || !Array.isArray(landing.users) || landing.users.length === 1);
  }
  if (row.stage === 'RESTORING_ENTRY') {
    const entry = inbounds.find(item => item.tag === row.entryTag);
    const outbound = outbounds.find(item => item.tag === 'relay-out-' + row.lineId);
    // 没有任何合法用户时，正确的生效配置是无业务入站；不创建隐藏身份凑成功。
    if (!entry && !outbound) return true;
    if (!entry || !outbound || !outboundUsesCredential(outbound, view.credential)) return false;
    const route = config.route && typeof config.route === 'object' ? config.route as ObjectValue : {};
    return objects(route.rules).some(rule => Array.isArray(rule.inbound) && rule.inbound.includes(row.entryTag) && rule.outbound === outbound.tag);
  }
  return row.stage === 'CONFIRMED';
}
