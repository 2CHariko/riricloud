export function canEnableProxyPool(value: { type: string; protocolType: string; relayMode?: string | null }) {
  return value.protocolType === 'MIXED' && (value.type === 'DIRECT' || (value.type === 'RELAY' && value.relayMode === 'UPSTREAM_NODE'));
}
export function requiresUpstreamUserAuth(value: { type: string; protocolType: string; relayMode?: string | null }) {
  return value.type === 'RELAY' && value.relayMode === 'UPSTREAM_NODE' && ['MIXED', 'HTTP', 'SOCKS'].includes(value.protocolType);
}
