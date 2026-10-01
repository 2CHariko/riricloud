import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { proxyObject, proxyTlsEnabled, type ProxyConnection } from '../common/proxy-connection';
import { KernelExecutionError } from '../client-kernels/kernel-process';
import type { ProbeTarget } from './probe.types';

export interface PinnedProbeTarget { id: string; url: URL; address: string; expectedStatus: number }
export type ProbeDnsLookup = (host: string) => Promise<Array<{ address: string }>>;
const defaultLookup: ProbeDnsLookup = (host) => lookup(host, { all: true, verbatim: true });
export function isPublicProbeAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const [a, b, c] = address.split('.').map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 || a === 169 && b === 254 || a === 172 && b >= 16 && b <= 31 || a === 192 && (b === 168 || b === 0 || b === 2 && c === 0) || a === 100 && b >= 64 && b <= 127 || a === 198 && (b === 18 || b === 19 || b === 51 && c === 100) || a === 203 && b === 0 && c === 113);
  }
  if (isIP(address) !== 6 || address.includes('%')) return false;
  const lower = address.toLowerCase();
  // 全球单播仅 2000::/3；排除文档及 IPv4 映射/过渡，防缩写绕过私网判定。
  const [first, second] = lower.split(':').map((part) => Number.parseInt(part || '0', 16));
  return first >= 0x2000 && first <= 0x3fff && first !== 0x2002 && !(first === 0x2001 && (second === 0 || second === 0xdb8));
}
export class ProbeTargetPolicy {
  constructor(private readonly dnsLookup: ProbeDnsLookup = defaultLookup) {}
  private async address(host: string, allowPrivate = false, signal?: AbortSignal): Promise<string> {
    if (signal?.aborted) throw new KernelExecutionError('CANCELED');
    let timer: ReturnType<typeof setTimeout> | undefined;
    let abort: (() => void) | undefined;
    let addresses: Array<{ address: string }>;
    try {
      addresses = isIP(host) ? [{ address: host }] : await Promise.race([this.dnsLookup(host), new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new KernelExecutionError('DNS_TIMEOUT')), 5_000);
        abort = () => reject(new KernelExecutionError('CANCELED'));
        signal?.addEventListener('abort', abort, { once: true });
      })]);
    } finally { clearTimeout(timer); if (abort) signal?.removeEventListener('abort', abort); }
    if (!addresses.length || addresses.some((item) => !isIP(item.address) || (!allowPrivate && !isPublicProbeAddress(item.address)))) throw new KernelExecutionError('ADDRESS_POLICY_REJECTED');
    return addresses[0].address;
  }
  async target(target: ProbeTarget, signal?: AbortSignal): Promise<PinnedProbeTarget> {
    let url: URL;
    try { url = new URL(target.url); } catch { throw new KernelExecutionError('INVALID_TARGET'); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash || target.url.length > 2048 || !Number.isInteger(target.expectedStatus) || target.expectedStatus < 100 || target.expectedStatus > 599) throw new KernelExecutionError('INVALID_TARGET');
    const host = url.hostname.replace(/^\[|\]$/g, '');
    return { id: target.id, url, address: await this.address(host, false, signal), expectedStatus: target.expectedStatus };
  }
  async connection(connection: ProxyConnection, allowPrivate: boolean, signal?: AbortSignal): Promise<ProxyConnection> {
    const host = connection.serverHost.replace(/^\[|\]$/g, '');
    const address = await this.address(host, allowPrivate, signal);
    const tls = { ...proxyObject(connection.params.tls) };
    if (proxyTlsEnabled(connection) && !tls.serverName && !tls.server_name) tls.serverName = host;
    const transport = { ...proxyObject(connection.params.transport) };
    if (['ws', 'http', 'httpupgrade'].includes(String(transport.type)) && !transport.host && !proxyObject(transport.headers).Host) transport.host = host;
    return { ...connection, serverHost: address, params: { ...connection.params, ...(Object.keys(tls).length ? { tls } : {}), ...(Object.keys(transport).length ? { transport } : {}) } };
  }
}
