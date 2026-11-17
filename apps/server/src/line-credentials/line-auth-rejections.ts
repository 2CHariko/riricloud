import { isIP } from 'node:net';

export interface LandingAuthTarget { lineId: string; port: number; protocol: string }
export interface SafeEvent extends LandingAuthTarget {
  nodeId: string; configVersion: number; count: number; windowStartedAt: number; windowEndedAt: number;
}
const PROTOCOLS = new Set(['VLESS', 'VMESS', 'TROJAN', 'HYSTERIA2', 'TUIC', 'SHADOWSOCKS', 'NAIVE']);
const identifier = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,128}$/.test(value);
const integer = (value: number) => Number.isSafeInteger(value) && value >= 0;
function targetValue(value: unknown): LandingAuthTarget | null {
  if (!value || typeof value !== 'object') return null;
  const item = value as Record<string, unknown>;
  if (!identifier(item.lineId) || typeof item.port !== 'number' || !Number.isSafeInteger(item.port) || item.port < 1 || item.port > 65535 ||
      typeof item.protocol !== 'string' || !PROTOCOLS.has(item.protocol.toUpperCase())) return null;
  return { lineId: item.lineId, port: item.port, protocol: item.protocol };
}
const UUID = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}';
const unknownUuid = new RegExp('^unknown UUID: ' + UUID + '$');
const tuicUser = new RegExp('^connection failed: handle uni stream: authentication: unknown user ' + UUID + '$');
function socketAddress(value: string): boolean {
  const match = /^(?:\[([0-9a-fA-F:]+)\]|(\d+\.\d+\.\d+\.\d+)):(\d{1,5})$/.exec(value);
  return !!match && isIP(match[1] ?? match[2]) !== 0 && Number(match[3]) > 0 && Number(match[3]) <= 65535;
}

// 仅接受固定内核已确认的认证/认证首包拒绝分支；不根据泛化的 auth 字样推断。
// Hysteria2 失败由 HTTP/3 伪装静默处理，现有日志无法可靠计量，不能猜成零。
export function matchRelayAuthRejection(message: string, targets: ReadonlyMap<string, LandingAuthTarget>): LandingAuthTarget | null {
  if (typeof message !== 'string' || message.length > 4096 || [...message].some(character => {
    const code = character.charCodeAt(0);
    return code < 32 || (code >= 127 && code <= 159) || (code >= 0x2028 && code <= 0x202e) || (code >= 0x2066 && code <= 0x2069);
  })) return null;
  const match = /^(?:(?:WARN(?:ING)?|ERROR):?(?:\[\d{1,12}(?:\.\d{1,6})?\]| \[\d{1,20} (?:\d+(?:\.\d+)?(?:ms|s)|\d+m\d+s)\])? )?inbound\/([a-z0-9]+)\[([A-Za-z0-9_.:-]{1,128})\]: (.+)$/.exec(message);
  if (!match) return null;
  const target = targetValue(targets.get(match[2]));
  if (!target || target.protocol.toLowerCase() !== match[1]) return null;
  const body = match[3];
  if (match[1] === 'tuic') return tuicUser.test(body) || body === 'connection failed: handle uni stream: authentication: token mismatch' ? target : null;
  const connection = /^process (connection|packet) from (\S+): (.+)$/.exec(body);
  if (!connection || !socketAddress(connection[2])) return null;
  const reason = connection[3];
  if (match[1] === 'shadowsocks') {
    const request = /^shadowsocks: serve (TCP|UDP) from (\S+): invalid request$/.exec(reason);
    return request && request[2] === connection[2] && (request[1] === 'TCP') === (connection[1] === 'connection') ? target : null;
  }
  if (connection[1] !== 'connection') return null;
  const rejected = match[1] === 'vless' ? unknownUuid.test(reason) :
    match[1] === 'vmess' ? reason === 'bad request' :
    match[1] === 'trojan' ? reason === 'bad request: fallback disabled' :
    match[1] === 'naive' ? reason === 'authorization failed' : false;
  return rejected ? target : null;
}

interface Bucket {
  value: Omit<SafeEvent, 'count' | 'windowStartedAt' | 'windowEndedAt'>;
  lastSeen: number; lastEmitted: number; count: number; start: number; end: number;
}
export class RelayAuthRejectionCounter {
  private readonly buckets = new Map<string, Bucket>();
  private clock = 0;
  private emit(bucket: Bucket): SafeEvent[] {
    if (!bucket.count) return [];
    const event = { ...bucket.value, count: bucket.count, windowStartedAt: bucket.start, windowEndedAt: bucket.end };
    bucket.count = 0;
    return [event];
  }
  private expire(now: number): SafeEvent[] {
    const events: SafeEvent[] = [];
    for (const [key, bucket] of this.buckets) if (now - bucket.lastSeen >= 300_000) {
      events.push(...this.emit(bucket)); this.buckets.delete(key);
    }
    return events;
  }
  observe(nodeId: string, configVersion: number, value: LandingAuthTarget, now: number): SafeEvent[] {
    const target = targetValue(value);
    if (!integer(now) || !identifier(nodeId) || !integer(configVersion) || configVersion === 0 || !target) return [];
    now = this.clock = Math.max(this.clock, now);
    const events = this.expire(now);
    const key = JSON.stringify([nodeId, target.lineId, target.port]);
    let bucket = this.buckets.get(key);
    if (bucket && (bucket.value.configVersion !== configVersion || bucket.value.protocol !== target.protocol)) {
      events.push(...this.emit(bucket)); this.buckets.delete(key); bucket = undefined;
    }
    if (!bucket) {
      if (this.buckets.size >= 1024) {
        const oldest = this.buckets.keys().next().value!;
        events.push(...this.emit(this.buckets.get(oldest)!)); this.buckets.delete(oldest);
      }
      bucket = { value: { nodeId, configVersion, ...target }, lastSeen: now, lastEmitted: now, count: 1, start: now, end: now };
      this.buckets.set(key, bucket);
      events.push(...this.emit(bucket));
      return events;
    }
    this.buckets.delete(key); this.buckets.set(key, bucket);
    if (!bucket.count) bucket.start = now;
    bucket.end = bucket.lastSeen = now;
    bucket.count++;
    if (now - bucket.lastEmitted >= 30_000) { events.push(...this.emit(bucket)); bucket.lastEmitted = now; }
    return events;
  }
  flush(now: number, force = false): SafeEvent[] {
    if (!integer(now)) return [];
    now = this.clock = Math.max(this.clock, now);
    const events = this.expire(now);
    for (const bucket of this.buckets.values()) if (force || now - bucket.lastEmitted >= 30_000) {
      events.push(...this.emit(bucket)); bucket.lastEmitted = now;
    }
    return events;
  }
  clear(): SafeEvent[] {
    const events = [...this.buckets.values()].flatMap(bucket => this.emit(bucket));
    this.buckets.clear(); this.clock = 0;
    return events;
  }
}
