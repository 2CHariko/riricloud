import { buildUpstreamOutbound, buildUpstreamUri, buildUpstreamClashProxy, type UpstreamConnection } from '../common/upstream-connection';
import { bindManagedConnection } from './compilers/managed-connection';
import { formatAuthUserName } from '../common/inbound';
import { parseDocument, stringify } from 'yaml';
import type {
  HttpParams,
  Hysteria2Params,
  InboundMultiplexConfig,
  MixedParams,
  NaiveParams,
  ShadowtlsParams,
  ShadowsocksParams,
  SocksParams,
  TrojanParams,
  TuicParams,
  VlessParams,
  VmessParams
} from '../common/inbound';
import type { ProtocolType } from '../common/constants';
import {
  buildClientTls,
  buildClientTransport,
  buildShadowsocksClientPassword,
  normalizeShadowsocksPassword,
  parseDest
} from '../common/inbound';
import { deepMerge } from '../common/utils';

// 订阅用户凭证：vless/vmess 以 uuid 登录；hy2/trojan/tuic/naive 密码为 User.password ?? uuid；ss 为入站密码
export interface SubUser {
  uuid: string;
  email?: string;
  credential: string;
}

// 订阅输出中的入站（paramsJson 已解析归一化；仅含 isPublic 入站）
export interface SubInbound {
  type: ProtocolType;
  tag: string;
  port: number;
  params: Record<string, unknown>;
}

export interface SubNode {
  name: string;
  serverHost: string;
  tags?: string[];
  level?: number;
  inbounds: SubInbound[];
}

// 订阅编译的主输入：Line 已经解析出对外端点与自身协议参数。
export interface SubLine {
  id?: string;
  name: string;
  type?: 'DIRECT' | 'RELAY' | string;
  relayMode?: 'BLIND_FORWARD' | 'PROTOCOL_PROXY' | string | null;
  protocolType?: ProtocolType;
  params?: Record<string, unknown>;
  endpointOverrideEnabled?: boolean;
  serverHost: string;
  serverPort: number;
  serverName?: string | null;
  host?: string | null;
  trafficRate?: number;
  tags?: string[];
  level?: number;
  speedLimitMbps?: number | null;
  externalConnection?: UpstreamConnection;
  // 旧版调用方兼容字段；新代码使用 protocolType + params。
  targetInbound?: SubInbound;
}

export interface SubscriptionTemplateConfig {
  proxyGroupsJson?: string;
  ruleSetsJson?: string;
  dnsConfigJson?: string;
  customInjectYaml?: string | null;
  customInjectJson?: string | null;
}

export interface SemanticDnsConfig {
  enable?: boolean;
  fakeIp?: boolean;
  directDns?: string[];
  proxyDns?: string[];
  ipv6?: boolean;
}

export interface TemplateRuleItem {
  name?: string;
  type?: 'domain' | 'domain-suffix' | 'domain-keyword' | 'ip-cidr' | 'geosite' | 'match' | 'final' | 'remote-rule-set' | string;
  target?: string;
  enabled?: boolean;
  rules?: string[];
  url?: string;
  singboxUrl?: string;
  format?: 'binary' | 'source' | string;
  behavior?: 'domain' | 'ipcidr' | string;
}

export interface TemplateProxyGroupConfig {
  name?: string;
  type?: 'select' | 'url-test' | 'fallback' | 'load-balance' | string;
  proxies?: string | string[];
  filter?: string;
  includeTags?: string[];
  excludeTags?: string[];
  protocols?: string[];
  maxRate?: number;
  url?: string;
  interval?: number;
  tolerance?: number;
}

function parseJson<T>(value: string | undefined, fallback: T): T {
  try {
    return value ? (JSON.parse(value) as T) : fallback;
  } catch {
    return fallback;
  }
}

export function normalizeSemanticDnsConfig(value: unknown): SemanticDnsConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const source = value as Record<string, unknown>;
  const asStringArray = (candidate: unknown): string[] => Array.isArray(candidate)
    ? candidate.filter((item): item is string => typeof item === 'string' && item.trim().length > 0).map((item) => item.trim())
    : [];
  const directDns = asStringArray(source.directDns);
  const proxyDns = asStringArray(source.proxyDns);
  if (directDns.length || proxyDns.length || 'fakeIp' in source) {
    return {
      ...(typeof source.enable === 'boolean' ? { enable: source.enable } : {}),
      ...(typeof source.fakeIp === 'boolean' ? { fakeIp: source.fakeIp } : {}),
      ...(directDns.length ? { directDns } : {}),
      ...(proxyDns.length ? { proxyDns } : {}),
      ...(typeof source.ipv6 === 'boolean' ? { ipv6: source.ipv6 } : {})
    };
  }

  const nameserver = asStringArray(source.nameserver);
  const fallback = asStringArray(source.fallback);
  const defaultNameserver = asStringArray(source['default-nameserver']);
  const enhancedMode = source['enhanced-mode'];
  return {
    enable: source.enable !== false,
    fakeIp: enhancedMode === 'fake-ip' || source['fake-ip-range'] !== undefined,
    directDns: nameserver.length ? (fallback.length ? nameserver : [nameserver[0]]) : defaultNameserver,
    proxyDns: fallback.length ? fallback : nameserver.slice(1),
    ...(typeof source.ipv6 === 'boolean' ? { ipv6: source.ipv6 } : {})
  };
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0).map((item) => item.trim())
    : [];
}

function matchesProxyFilter(entry: SubEntry, group: Record<string, unknown>): boolean {
  const filter = group.filter;
  if (typeof filter === 'string' && filter.trim()) {
    try {
      const regex = new RegExp(filter, 'i');
      if (!regex.test(entry.node.name) && !regex.test(entry.inbound.tag)) return false;
    } catch {
      return false;
    }
  }

  const tags = entry.line?.tags ?? entry.node.tags ?? [];
  const includeTags = stringArray(group.includeTags).map((tag) => tag.toLowerCase());
  const excludeTags = stringArray(group.excludeTags).map((tag) => tag.toLowerCase());
  const normalizedTags = tags.map((tag) => tag.toLowerCase());
  if (includeTags.length && !includeTags.every((tag) => normalizedTags.includes(tag))) return false;
  if (excludeTags.some((tag) => normalizedTags.includes(tag))) return false;

  const protocols = stringArray(group.protocols).map((protocol) => protocol.toUpperCase());
  if (protocols.length && !protocols.includes(entry.inbound.type.toUpperCase())) return false;

  if (typeof group.maxRate === 'number' && Number.isFinite(group.maxRate)) {
    const rate = entry.line?.trafficRate ?? 1;
    if (rate > group.maxRate) return false;
  }
  return true;
}

function templateGroups(template: SubscriptionTemplateConfig | undefined): Array<Record<string, unknown>> {
  return parseJson<unknown[]>(template?.proxyGroupsJson, [])
    .filter((group): group is Record<string, unknown> => !!group && typeof group === 'object' && !Array.isArray(group));
}

function resolveClashGroupProxies(
  group: Record<string, unknown>,
  groupNames: string[],
  allNames: string[],
  allGroupNames: Set<string>
): string[] {
  const configured = group.proxies;
  if (configured === undefined || configured === null || configured === 'all') {
    return groupNames.length ? groupNames : (allNames.length ? [...allNames] : ['DIRECT']);
  }

  if (Array.isArray(configured)) {
    const result: string[] = [];
    for (const raw of configured) {
      if (typeof raw !== 'string') continue;
      const item = raw.trim();
      if (!item) continue;

      const upper = item.toUpperCase();
      if (item === 'all' || item === '$all' || item === '$nodes') {
        const nodesToAdd = groupNames.length ? groupNames : allNames;
        for (const n of nodesToAdd) {
          if (!result.includes(n)) result.push(n);
        }
      } else if (upper === 'DIRECT' || upper === 'REJECT') {
        if (!result.includes(upper)) result.push(upper);
      } else if (allGroupNames.has(item)) {
        if (!result.includes(item)) result.push(item);
      } else if (allNames.includes(item)) {
        if (!result.includes(item)) result.push(item);
      }
    }
    if (result.length > 0) return result;
  }

  return groupNames.length ? groupNames : (allNames.length ? [...allNames, 'DIRECT'] : ['DIRECT']);
}

function resolveSingboxGroupOutbounds(
  group: Record<string, unknown>,
  groupNames: string[],
  allNames: string[],
  allGroupNames: Set<string>
): string[] {
  const configured = group.proxies;
  if (configured === undefined || configured === null || configured === 'all') {
    return groupNames.length ? groupNames : (allNames.length ? [...allNames] : ['direct']);
  }

  if (Array.isArray(configured)) {
    const result: string[] = [];
    for (const raw of configured) {
      if (typeof raw !== 'string') continue;
      const item = raw.trim();
      if (!item) continue;

      const upper = item.toUpperCase();
      if (item === 'all' || item === '$all' || item === '$nodes') {
        const nodesToAdd = groupNames.length ? groupNames : allNames;
        for (const n of nodesToAdd) {
          if (!result.includes(n)) result.push(n);
        }
      } else if (upper === 'DIRECT') {
        if (!result.includes('direct')) result.push('direct');
      } else if (upper === 'REJECT') {
        if (!result.includes('block')) result.push('block');
      } else if (allGroupNames.has(item)) {
        if (!result.includes(item)) result.push(item);
      } else if (allNames.includes(item)) {
        if (!result.includes(item)) result.push(item);
      }
    }
    if (result.length > 0) return result;
  }

  return groupNames.length ? groupNames : (allNames.length ? [...allNames] : ['direct']);
}

function templateRules(template: SubscriptionTemplateConfig | undefined): Array<Record<string, unknown>> {
  return parseJson<unknown[]>(template?.ruleSetsJson, [])
    .filter((rule): rule is Record<string, unknown> => !!rule && typeof rule === 'object' && !Array.isArray(rule));
}

function templateDns(template: SubscriptionTemplateConfig | undefined): Record<string, unknown> {
  const dns = parseJson<unknown>(template?.dnsConfigJson, {});
  return { ...normalizeSemanticDnsConfig(dns) };
}

function parseYamlObject(value: string): Record<string, unknown> {
  try {
    const parsed: unknown = parseDocument(value).toJS();
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function ruleType(value: unknown, fallback: string): string {
  const raw = typeof value === 'string' && value.trim() ? value.trim().toLowerCase() : fallback;
  if (raw === 'rule-set' || raw === 'rule_set' || raw === 'remote_rule_set') return 'remote-rule-set';
  if (raw === 'ip-cidr6' || raw === 'ip_cidr6' || raw === 'ip_cidr') return 'ip-cidr';
  if (raw === 'domain_suffix') return 'domain-suffix';
  if (raw === 'domain_keyword') return 'domain-keyword';
  if (raw === 'process_name') return 'process-name';
  if (raw === 'geo-ip') return 'geoip';
  return raw;
}

function cleanTargetAndNoResolve(rawTarget: unknown, fallback: string): { target: string; noResolve: boolean } {
  const t = typeof rawTarget === 'string' && rawTarget.trim() ? rawTarget.trim() : fallback;
  const parts = t.split(',').map((p) => p.trim()).filter(Boolean);
  const target = parts[0] || fallback;
  let noResolve = false;
  for (const part of parts.slice(1)) {
    if (part.toLowerCase() === 'no-resolve') {
      noResolve = true;
    }
  }
  return { target, noResolve };
}

function safeRuleName(value: unknown, fallback: string): string {
  const name = typeof value === 'string' ? value.trim() : '';
  return name || fallback;
}

function slug(value: string, fallback: string): string {
  const normalized = value.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
  return normalized || fallback;
}

export function buildClashRuleProvidersInternal(rules: TemplateRuleItem[]): {
  providers: Record<string, Record<string, unknown>>;
  ruleToProviderMap: Map<number, string>;
} {
  const providers: Record<string, Record<string, unknown>> = {};
  const ruleToProviderMap = new Map<number, string>();
  const used = new Set<string>();
  for (const [index, rule] of rules.entries()) {
    if (rule.enabled === false || ruleType(rule.type, '') !== 'remote-rule-set' || typeof rule.url !== 'string' || !rule.url.trim()) continue;
    const base = slug(safeRuleName(rule.name, `rule-set-${index + 1}`), `rule-set-${index + 1}`);
    let name = base;
    let suffix = 2;
    while (used.has(name)) name = `${base}-${suffix++}`;
    used.add(name);
    ruleToProviderMap.set(index, name);
    const rawBehavior = typeof rule.behavior === 'string' ? rule.behavior.toLowerCase().trim() : '';
    const behavior = rawBehavior === 'ipcidr' ? 'ipcidr' : rawBehavior === 'domain' ? 'domain' : 'classical';
    providers[name] = {
      type: 'http',
      behavior,
      path: `./ruleset/${name}.yaml`,
      format: 'yaml',
      url: rule.url.trim(),
      interval: 86400
    };
  }
  return { providers, ruleToProviderMap };
}

export function buildClashRuleProviders(rules: TemplateRuleItem[]): Record<string, Record<string, unknown>> {
  return buildClashRuleProvidersInternal(rules).providers;
}

export function buildSingboxRouteRuleSets(rules: TemplateRuleItem[]): Array<Record<string, unknown>> {
  const definitions: Array<Record<string, unknown>> = [];
  const used = new Set<string>();
  const addDefinition = (tag: string, url: string, format: string) => {
    let uniqueTag = tag;
    let suffix = 2;
    while (used.has(uniqueTag)) uniqueTag = `${tag}-${suffix++}`;
    used.add(uniqueTag);
    definitions.push({
      tag: uniqueTag,
      type: 'remote',
      format: format === 'source' ? 'source' : 'binary',
      url,
      download_detour: 'direct'
    });
    return uniqueTag;
  };

  for (const [index, rule] of rules.entries()) {
    if (rule.enabled === false) continue;
    const type = ruleType(rule.type, '');
    const values = stringArray(rule.rules);
    const remoteUrl = typeof rule.singboxUrl === 'string' && rule.singboxUrl.trim() ? rule.singboxUrl.trim() : '';
    if (type === 'remote-rule-set' && remoteUrl) {
      addDefinition(slug(safeRuleName(rule.name, `rule-set-${index + 1}`), `rule-set-${index + 1}`), remoteUrl, rule.format ?? 'binary');
      continue;
    }
    if (type === 'geosite') {
      for (const value of values) {
        const normalized = slug(value, `geosite-${index + 1}`);
        addDefinition(`geosite-${normalized}`, `https://github.com/SagerNet/sing-geosite/releases/latest/download/geosite-${normalized}.srs`, 'binary');
      }
      continue;
    }
    if (type === 'geoip') {
      for (const value of values) {
        const normalized = slug(value, `geoip-${index + 1}`);
        addDefinition(`geoip-${normalized}`, `https://github.com/SagerNet/sing-geoip/releases/latest/download/geoip-${normalized}.srs`, 'binary');
      }
      continue;
    }
  }
  return definitions;
}

function buildSingboxRuleSetTags(rules: TemplateRuleItem[]): Map<number, string[]> {
  const tags = new Map<number, string[]>();
  const used = new Set<string>();
  for (const [index, rule] of rules.entries()) {
    if (rule.enabled === false) continue;
    const type = ruleType(rule.type, '');
    const values = stringArray(rule.rules);
    const remoteUrl = typeof rule.singboxUrl === 'string' && rule.singboxUrl.trim() ? rule.singboxUrl.trim() : '';
    if (type === 'remote-rule-set' && remoteUrl) {
      const base = slug(safeRuleName(rule.name, `rule-set-${index + 1}`), `rule-set-${index + 1}`);
      let tag = base;
      let suffix = 2;
      while (used.has(tag)) tag = `${base}-${suffix++}`;
      used.add(tag);
      tags.set(index, [tag]);
    } else if (type === 'geosite' || type === 'geoip') {
      const prefix = type;
      const result: string[] = [];
      for (const value of values) {
        const base = `${prefix}-${slug(value, `rule-${index + 1}`)}`;
        let tag = base;
        let suffix = 2;
        while (used.has(tag)) tag = `${base}-${suffix++}`;
        used.add(tag);
        result.push(tag);
      }
      if (result.length) tags.set(index, result);
    }
  }
  return tags;
}

export function buildSemanticClashDns(value: unknown): Record<string, unknown> {
  const dns = normalizeSemanticDnsConfig(value);
  if (dns.enable === false) return {};
  const directDns = dns.directDns?.length ? dns.directDns : ['223.5.5.5'];
  const proxyDns = dns.proxyDns?.length ? dns.proxyDns : ['https://1.1.1.1/dns-query'];
  return {
    enable: true,
    ...(dns.ipv6 === false ? { ipv6: false } : {}),
    ...(dns.fakeIp ? { 'enhanced-mode': 'fake-ip', 'fake-ip-range': '198.18.0.1/16' } : {}),
    'default-nameserver': directDns,
    nameserver: [...new Set([...directDns, ...proxyDns])],
    fallback: proxyDns,
    'fallback-filter': { geoip: true, 'geoip-code': 'CN', ipcidr: ['240.0.0.0/4'] }
  };
}

export function parseSingboxDnsServer(addr: string, tag: string, detour?: string): Record<string, unknown> {
  const trimmed = addr.trim();
  if (trimmed.toLowerCase() === 'local') {
    return { type: 'local', tag, ...(detour ? { detour } : {}) };
  }
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(trimmed)) {
    try {
      const url = new URL(trimmed);
      const protocol = url.protocol.replace(':', '').toLowerCase();
      if (protocol === 'https') {
        return {
          type: 'https',
          tag,
          server: url.hostname,
          ...(url.port ? { server_port: parseInt(url.port, 10) } : {}),
          ...(url.pathname && url.pathname !== '/' ? { path: url.pathname + (url.search || '') } : {}),
          ...(detour ? { detour } : {})
        };
      }
      if (protocol === 'tls' || protocol === 'quic') {
        return {
          type: protocol,
          tag,
          server: url.hostname,
          ...(url.port ? { server_port: parseInt(url.port, 10) } : {}),
          ...(detour ? { detour } : {})
        };
      }
      if (protocol === 'h3') {
        return {
          type: 'h3',
          tag,
          server: url.hostname,
          ...(url.port ? { server_port: parseInt(url.port, 10) } : {}),
          ...(url.pathname && url.pathname !== '/' ? { path: url.pathname + (url.search || '') } : {}),
          ...(detour ? { detour } : {})
        };
      }
      if (protocol === 'udp' || protocol === 'tcp') {
        return {
          type: protocol,
          tag,
          server: url.hostname,
          ...(url.port ? { server_port: parseInt(url.port, 10) } : {}),
          ...(detour ? { detour } : {})
        };
      }
    } catch {
      // fallback to plain host/port
    }
  }
  let host = trimmed;
  let port: number | undefined;
  if (trimmed.includes(':') && !trimmed.includes('[')) {
    const parts = trimmed.split(':');
    host = parts[0];
    const parsedPort = parseInt(parts[1], 10);
    if (!isNaN(parsedPort)) {
      port = parsedPort;
    }
  } else if (trimmed.startsWith('[') && trimmed.includes(']:')) {
    const closeBracketIdx = trimmed.indexOf(']:');
    host = trimmed.slice(1, closeBracketIdx);
    const parsedPort = parseInt(trimmed.slice(closeBracketIdx + 2), 10);
    if (!isNaN(parsedPort)) {
      port = parsedPort;
    }
  }
  return {
    type: 'udp',
    tag,
    server: host,
    ...(port ? { server_port: port } : {}),
    ...(detour ? { detour } : {})
  };
}

export function buildSemanticSingboxDns(value: unknown, primaryGroup: string, ruleSetTags: string[] = []): Record<string, unknown> {
  const dns = normalizeSemanticDnsConfig(value);
  if (dns.enable === false) return {};
  const directDns = dns.directDns?.length ? dns.directDns : ['223.5.5.5'];
  const proxyDns = dns.proxyDns?.length ? dns.proxyDns : ['https://1.1.1.1/dns-query'];
  const servers: Array<Record<string, unknown>> = [];
  directDns.forEach((addr, idx) => {
    servers.push(
      parseSingboxDnsServer(addr, idx === 0 ? 'dns_direct' : `dns_direct_${idx + 1}`, 'direct')
    );
  });
  if (dns.fakeIp) {
    servers.push({
      type: 'fakeip',
      tag: 'dns_fakeip',
      inet4_range: '198.18.0.0/15',
      ...(dns.ipv6 !== false ? { inet6_range: 'fc00::/18' } : {})
    });
  }
  proxyDns.forEach((addr, idx) => {
    servers.push(
      parseSingboxDnsServer(addr, idx === 0 ? 'dns_proxy' : `dns_proxy_${idx + 1}`, primaryGroup)
    );
  });
  const rules: Array<Record<string, unknown>> = [];
  if (ruleSetTags.length) rules.push({ rule_set: ruleSetTags, server: 'dns_direct' });
  if (dns.fakeIp) {
    rules.push({ query_type: ['A', 'AAAA'], server: 'dns_fakeip' });
  }
  rules.push({ server: 'dns_proxy' });
  return {
    servers,
    rules,
    strategy: dns.ipv6 === false ? 'ipv4_only' : 'prefer_ipv4'
  };
}

function buildClashRules(rules: TemplateRuleItem[], primaryGroup: string): { rules: string[]; providers: Record<string, Record<string, unknown>> } {
  const { providers, ruleToProviderMap } = buildClashRuleProvidersInternal(rules);
  const output: string[] = [];
  for (const [index, rule] of rules.entries()) {
    if (rule.enabled === false) continue;
    const { target, noResolve } = cleanTargetAndNoResolve(rule.target, primaryGroup);
    const type = ruleType(rule.type, 'domain-suffix');
    if (type === 'remote-rule-set') {
      for (const value of stringArray(rule.rules)) {
        output.push(`DOMAIN-SUFFIX,${value},${target}`);
      }
      const provider = ruleToProviderMap.get(index);
      if (provider) {
        output.push(`RULE-SET,${provider},${target}`);
      }
      continue;
    }
    if (type === 'match' || type === 'final') {
      output.push(`MATCH,${target}`);
      continue;
    }
    if (type === 'geoip') {
      for (const value of stringArray(rule.rules)) {
        output.push(`GEOIP,${value.toUpperCase()},${target}`);
      }
      continue;
    }
    if (type === 'process-name') {
      for (const value of stringArray(rule.rules)) {
        output.push(`PROCESS-NAME,${value},${target}`);
      }
      continue;
    }
    const clashType = type === 'ip-cidr' ? 'IP-CIDR' : type === 'domain-keyword' ? 'DOMAIN-KEYWORD' : type === 'domain' ? 'DOMAIN' : type === 'geosite' ? 'GEOSITE' : 'DOMAIN-SUFFIX';
    const noResolveSuffix = (clashType === 'IP-CIDR' && noResolve) ? ',no-resolve' : '';
    for (const value of stringArray(rule.rules)) {
      output.push(`${clashType},${value},${target}${noResolveSuffix}`);
    }
  }
  return { rules: output.length ? output : [`MATCH,${primaryGroup}`], providers };
}

const REALITY_CLIENT_DEFAULTS = {
  fp: 'chrome'
};

export interface SubEntry {
  label: string;
  node: SubNode;
  inbound: SubInbound;
  line?: SubLine;
}

type SubscriptionSource = SubNode | SubLine;

function isSubLine(source: SubscriptionSource): source is SubLine {
  return 'protocolType' in source || 'targetInbound' in source;
}

function lineInbound(line: SubLine): SubInbound {
  const legacy = line.targetInbound;
  return {
    type: line.protocolType ?? legacy?.type ?? 'VLESS',
    tag: legacy?.tag ?? `line-${line.id ?? line.name}`,
    port: line.serverPort,
    params: line.params ?? legacy?.params ?? {}
  };
}

function formatLineName(name: string, trafficRate?: number): string {
  return trafficRate !== undefined && trafficRate !== 1 ? `${name} [${trafficRate}x]` : name;
}

function endpointHost(entry: SubEntry): string {
  return entry.line?.serverHost ?? entry.node.serverHost;
}

function endpointPort(entry: SubEntry): number {
  return entry.line?.serverPort ?? entry.inbound.port;
}

function effectiveServerName(entry: SubEntry, fallback?: string): string | undefined {
  return entry.line && entry.line.endpointOverrideEnabled !== false ? entry.line.serverName || fallback : fallback;
}

function effectiveTransportHost(entry: SubEntry, fallback?: string): string | undefined {
  return entry.line && entry.line.endpointOverrideEnabled !== false ? entry.line.host || fallback : fallback;
}

function shadowtlsHandshakeHost(entry: SubEntry, params: ShadowtlsParams): string {
  const handshakeHost = parseDest(params.handshakeDest).host;
  return effectiveServerName(entry, handshakeHost) || handshakeHost;
}

function shadowtlsInnerPassword(params: ShadowtlsParams): string {
  return normalizeShadowsocksPassword(params.inner.method, params.inner.password);
}


// 输出条目名：单入站节点用节点名，多入站节点追加 tag 区分；再全局去重保证 Clash proxy 名唯一
export function entryLabels(nodes: SubscriptionSource[]): string[] {
  return dedupeNames(
    nodes.flatMap((source) => {
    if (isSubLine(source)) return [source.externalConnection ? source.name : formatLineName(source.name, source.trafficRate)];
      return source.inbounds.map((inbound) =>
        source.inbounds.length > 1 ? `${source.name}·${inbound.tag}` : source.name
      );
    }
    )
  );
}

function entries(nodes: SubscriptionSource[]): SubEntry[] {
  const labels = entryLabels(nodes);
  const list: SubEntry[] = [];
  let i = 0;
  for (const source of nodes) {
    if (isSubLine(source)) {
      const inbound = lineInbound(source);
      const node: SubNode = { name: source.name, serverHost: source.serverHost, inbounds: [inbound], tags: source.tags, level: source.level };
      list.push({ label: labels[i], node, inbound, line: source });
      i += 1;
      continue;
    }
    for (const inbound of source.inbounds) {
      list.push({ label: labels[i], node: source, inbound });
      i += 1;
    }
  }
  return list;
}

// Clash 要求 proxy 名唯一，重名自动追加序号
export function dedupeNames(names: string[]): string[] {
  const seen = new Map<string, number>();
  return names.map((name) => {
    const count = seen.get(name) ?? 0;
    seen.set(name, count + 1);
    return count === 0 ? name : `${name} ${count + 1}`;
  });
}

// ==============================
// URI（Base64 订阅行）
// ==============================

function buildVlessUri(user: SubUser, entry: SubEntry): string {
  const p = entry.inbound.params as unknown as VlessParams;
  const transport = p.transport?.type || 'tcp';
  const tls = p.tls;

  const params = new URLSearchParams({
    encryption: 'none',
    type: transport
  });

  if (p.flow) {
    params.set('flow', p.flow);
  }

  if (transport === 'ws' && p.transport?.path) {
    params.set('path', p.transport.path);
    const host = effectiveTransportHost(entry, p.transport.host);
    if (host) params.set('host', host);
  } else if (transport === 'grpc' && p.transport?.serviceName) {
    params.set('serviceName', p.transport.serviceName);
  } else if (transport === 'httpupgrade' && p.transport?.path) {
    params.set('path', p.transport.path);
    const host = effectiveTransportHost(entry, p.transport.host);
    if (host) params.set('host', host);
  }

  if (tls && tls.enabled) {
    const rawReality = tls.reality as unknown as { enabled?: boolean; publicKey?: string; public_key?: string; shortId?: string; short_id?: string; shortIds?: string[]; serverNames?: string[] } | undefined;
    if ((tls.mode === 'reality' || Boolean(rawReality?.enabled || rawReality?.publicKey || rawReality?.public_key)) && rawReality) {
      const sni = effectiveServerName(entry, tls.serverName || rawReality.serverNames?.[0]);
      const pbk = rawReality.publicKey || rawReality.public_key || '';
      const sid = rawReality.shortIds?.[0] ?? rawReality.shortId ?? rawReality.short_id ?? '';
      params.set('security', 'reality');
      if (sni) params.set('sni', sni);
      params.set('fp', REALITY_CLIENT_DEFAULTS.fp);
      params.set('pbk', pbk);
      params.set('sid', sid);
    } else {
      params.set('security', 'tls');
      const serverName = effectiveServerName(entry, tls.serverName);
      if (serverName) params.set('sni', serverName);
      if (tls.alpn && tls.alpn.length) params.set('alpn', tls.alpn.join(','));
      if (tls.insecure) params.set('allowInsecure', '1');
    }
  }

  const uuid = (p as unknown as { uuid?: string }).uuid || user.uuid;
  return `vless://${uuid}@${endpointHost(entry)}:${endpointPort(entry)}?${params.toString()}#${encodeURIComponent(entry.label)}`;
}

function buildVmessUri(user: SubUser, entry: SubEntry): string {
  const p = entry.inbound.params as unknown as VmessParams;
  const transport = p.transport?.type || 'tcp';
  const tls = p.tls;

  const vmessJson = {
    v: '2',
    ps: entry.label,
    add: endpointHost(entry),
    port: endpointPort(entry),
    id: (p as unknown as { uuid?: string }).uuid || user.uuid,
    aid: p.alterId ?? (p as unknown as { alter_id?: number }).alter_id ?? 0,
    scy: (p as unknown as { security?: string }).security || 'auto',
    net: transport === 'httpupgrade' ? 'http' : transport,
    type: 'none',
    host: effectiveTransportHost(entry, p.transport?.host) || '',
    path: p.transport?.path || (transport === 'grpc' ? p.transport?.serviceName : '') || '',
    tls: tls && tls.enabled ? 'tls' : '',
    sni: effectiveServerName(entry, tls?.serverName) || ''
  };

  const b64 = Buffer.from(JSON.stringify(vmessJson), 'utf8').toString('base64');
  return `vmess://${b64}`;
}

function buildTrojanUri(user: SubUser, entry: SubEntry): string {
  const p = entry.inbound.params as unknown as TrojanParams;
  const transport = p.transport?.type || 'tcp';
  const tls = p.tls;

  const params = new URLSearchParams({
    type: transport
  });

  const serverName = effectiveServerName(entry, tls?.serverName);
  if (serverName) {
    params.set('sni', serverName);
  }
  if (tls?.alpn && tls.alpn.length) {
    params.set('alpn', tls.alpn.join(','));
  }
  if (tls?.insecure) {
    params.set('allowInsecure', '1');
  }

  if (transport === 'ws' && p.transport?.path) {
    params.set('path', p.transport.path);
    const host = effectiveTransportHost(entry, p.transport.host);
    if (host) params.set('host', host);
  } else if (transport === 'grpc' && p.transport?.serviceName) {
    params.set('serviceName', p.transport.serviceName);
  } else if (transport === 'httpupgrade' && p.transport?.path) {
    params.set('path', p.transport.path);
    const host = effectiveTransportHost(entry, p.transport.host);
    if (host) params.set('host', host);
  }

  const password = (p as unknown as { password?: string }).password || user.credential;
  return `trojan://${encodeURIComponent(password)}@${endpointHost(entry)}:${endpointPort(entry)}?${params.toString()}#${encodeURIComponent(entry.label)}`;
}

function buildHysteria2Uri(user: SubUser, entry: SubEntry): string {
  const p = entry.inbound.params as unknown as Hysteria2Params;
  const params = new URLSearchParams();
  const serverName = effectiveServerName(entry, p.tls?.serverName);
  if (serverName) {
    params.set('sni', serverName);
  }
  if (p.tls?.alpn && p.tls.alpn.length) {
    params.set('alpn', p.tls.alpn.join(','));
  }
  if (p.tls?.insecure) {
    params.set('insecure', '1');
  }
  if (p.upMbps && p.upMbps > 0) {
    params.set('upmbps', String(p.upMbps));
  }
  if (p.downMbps && p.downMbps > 0) {
    params.set('downmbps', String(p.downMbps));
  }
  const rawObfs = (p as unknown as { obfs?: unknown; obfsPassword?: string }).obfs;
  const rawObfsPassword = (p as unknown as { obfsPassword?: string }).obfsPassword;
  if (rawObfs && typeof rawObfs === 'object' && (rawObfs as { password?: string }).password) {
    params.set('obfs', (rawObfs as { type?: string }).type || 'salamander');
    params.set('obfs-password', (rawObfs as { password: string }).password);
  } else if (typeof rawObfs === 'string' && rawObfs && rawObfsPassword) {
    params.set('obfs', rawObfs);
    params.set('obfs-password', rawObfsPassword);
  }
  const qs = params.toString();
  const password = (p as unknown as { password?: string }).password || user.credential;
  return `hy2://${encodeURIComponent(password)}@${endpointHost(entry)}:${endpointPort(entry)}${qs ? `?${qs}` : ''}#${encodeURIComponent(entry.label)}`;
}

function buildShadowsocksUri(user: SubUser, entry: SubEntry): string {
  const p = entry.inbound.params as unknown as ShadowsocksParams;
  const password = p.mode === 'multi-user'
    ? buildShadowsocksClientPassword(p.method, p.password || '', user.credential, user.uuid)
    : normalizeShadowsocksPassword(p.method, p.password || '');
  const userinfo = Buffer.from(`${p.method}:${password}`, 'utf8').toString('base64url');
  return `ss://${userinfo}@${endpointHost(entry)}:${endpointPort(entry)}#${encodeURIComponent(entry.label)}`;
}

function buildTuicUri(user: SubUser, entry: SubEntry): string {
  const p = entry.inbound.params as unknown as TuicParams;
  const params = new URLSearchParams({
    congestion_control: p.congestionControl || 'bbr',
    udp_relay_mode: 'native'
  });
  const serverName = effectiveServerName(entry, p.tls?.serverName);
  if (serverName) {
    params.set('sni', serverName);
  }
  if (p.tls?.alpn && p.tls.alpn.length) {
    params.set('alpn', p.tls.alpn.join(','));
  }
  if (p.tls?.insecure) {
    params.set('allow_insecure', '1');
  }
  const uuid = (p as unknown as { uuid?: string }).uuid || user.uuid;
  const password = (p as unknown as { password?: string }).password || user.credential;
  return `tuic://${uuid}:${encodeURIComponent(password)}@${endpointHost(entry)}:${endpointPort(entry)}?${params.toString()}#${encodeURIComponent(entry.label)}`;
}

function buildNaiveUri(user: SubUser, entry: SubEntry): string {
  const username = formatAuthUserName(user, entry.line?.id);
  return `naive+https://${encodeURIComponent(username)}:${encodeURIComponent(user.credential)}@${endpointHost(entry)}:${endpointPort(entry)}#${encodeURIComponent(entry.label)}`;
}

function buildShadowtlsUri(user: SubUser, entry: SubEntry): string {
  const p = entry.inbound.params as unknown as ShadowtlsParams;
  const plugin = `shadow-tls;host=${shadowtlsHandshakeHost(entry, p)};password=${user.credential};version=3`;
  const userinfo = Buffer.from(`${p.inner.method}:${shadowtlsInnerPassword(p)}`, 'utf8').toString('base64url');
  const query = new URLSearchParams({ plugin });
  return `ss://${userinfo}@${endpointHost(entry)}:${endpointPort(entry)}?${query.toString()}#${encodeURIComponent(entry.label)}`;
}

// 逐入站生成 URI 行（Base64 订阅体）；未知或本地协议跳过（空行）
export function buildUriList(user: SubUser, nodes: SubscriptionSource[]): string[] {
  return entries(nodes)
    .map((entry) => {
      if (entry.line?.externalConnection) return buildUpstreamUri(entry.line.externalConnection, entry.label);
      switch (entry.inbound.type) {
        case 'VLESS':
        case 'VLESS_REALITY' as ProtocolType:
          return buildVlessUri(user, entry);
        case 'VMESS':
          return buildVmessUri(user, entry);
        case 'TROJAN':
          return buildTrojanUri(user, entry);
        case 'HYSTERIA2':
          return buildHysteria2Uri(user, entry);
        case 'SHADOWSOCKS':
          return buildShadowsocksUri(user, entry);
        case 'TUIC':
          return buildTuicUri(user, entry);
        case 'NAIVE':
          return buildNaiveUri(user, entry);
        case 'SHADOWTLS':
          return buildShadowtlsUri(user, entry);
        case 'SOCKS':
        case 'MIXED':
        case 'HTTP': {
          const tls = entry.inbound.params.tls as { enabled?: boolean; mode?: string } | undefined;
          const scheme = entry.inbound.type === 'HTTP' ? (tls?.enabled ? 'https' : 'http') : 'socks5';
          const host = endpointHost(entry).includes(':') ? `[${endpointHost(entry).replace(/^\[|\]$/g, '')}]` : endpointHost(entry);
          const auth = entry.inbound.params.usersEnabled !== false ? `${encodeURIComponent(formatAuthUserName(user, entry.line?.id))}:${encodeURIComponent(user.credential)}@` : '';
          return `${scheme}://${auth}${host}:${endpointPort(entry)}#${encodeURIComponent(entry.label)}`;
        }
        default:
          return '';
      }
    })
    .filter((uri) => uri.length > 0);
}

// ==============================
// Clash Meta（mihomo）YAML
// ==============================

function buildClashProxy(user: SubUser, entry: SubEntry): Record<string, unknown> {
  if (entry.line?.externalConnection) return buildUpstreamClashProxy(entry.line.externalConnection, entry.label);
  if (entry.inbound.type === 'DIRECT') return {};
  const connection = bindManagedConnection({
    protocolType: entry.inbound.type, serverHost: endpointHost(entry), serverPort: endpointPort(entry),
    params: entry.inbound.params, lineId: entry.line?.id,
    serverName: effectiveServerName(entry), host: effectiveTransportHost(entry)
  }, user);
  const proxy = buildUpstreamClashProxy(connection, entry.label);
  if (entry.line?.speedLimitMbps && entry.line.speedLimitMbps > 0) proxy['bandwidth-limit'] = `${entry.line.speedLimitMbps} Mbps`;
  return proxy;
}

// Clash Meta 客户端配置：完整最小可用（基础设置 + proxies + 策略组 + 兜底规则）
export function buildClashYaml(user: SubUser, nodes: SubscriptionSource[], template?: SubscriptionTemplateConfig): string {
  const allEntries = entries(nodes);
  const proxies = allEntries
    .map((entry) => buildClashProxy(user, entry))
    .filter((p) => Object.keys(p).length > 0);

  const names = proxies.map((p) => p.name as string);
  const defaultGroup = '节点选择';
  const groups = templateGroups(template) as TemplateProxyGroupConfig[];
  const allGroupNames = new Set(
    groups
      .map((g) => (typeof g.name === 'string' ? g.name.trim() : ''))
      .filter((n): n is string => !!n)
  );
  const proxyGroups = groups.length
    ? groups.map((group) => {
        const groupEntries = allEntries.filter((entry) => matchesProxyFilter(entry, group as Record<string, unknown>));
        const groupNames = groupEntries
          .map((entry) => names[allEntries.indexOf(entry)])
          .filter((name): name is string => !!name && names.includes(name));
        const type = typeof group.type === 'string' ? group.type : 'select';
        return {
          name: typeof group.name === 'string' && group.name.trim() ? group.name : defaultGroup,
          type,
          proxies: resolveClashGroupProxies(group as Record<string, unknown>, groupNames, names, allGroupNames),
          ...(typeof group.url === 'string' ? { url: group.url } : {}),
          ...(typeof group.interval === 'number' ? { interval: group.interval } : {}),
          ...(typeof group.tolerance === 'number' ? { tolerance: group.tolerance } : {})
        };
      })
    : [{ name: defaultGroup, type: 'select', proxies: [...names, 'DIRECT'] }];
  const primaryGroup = (proxyGroups[0]?.name as string) || defaultGroup;
  const configuredRules = templateRules(template) as TemplateRuleItem[];
  const clashRules = buildClashRules(configuredRules, primaryGroup);
  const config: Record<string, unknown> = {
    'mixed-port': 7890,
    'allow-lan': false,
    mode: 'rule',
    'log-level': 'info',
    proxies,
    'proxy-groups': proxyGroups,
    rules: clashRules.rules,
    ...(Object.keys(clashRules.providers).length ? { 'rule-providers': clashRules.providers } : {}),
    ...(Object.keys(templateDns(template)).length ? { dns: buildSemanticClashDns(templateDns(template)) } : {})
  };
  if (template?.customInjectYaml?.trim()) {
    const parsed = parseYamlObject(template.customInjectYaml);
    return stringify(deepMerge(config, parsed));
  }
  return stringify(config);
}

// ==============================
// Sing-box 客户端 JSON
// ==============================

function buildSingboxClientMultiplex(multiplex?: InboundMultiplexConfig): Record<string, unknown> | undefined {
  if (!multiplex || !multiplex.enabled) return undefined;
  const res: Record<string, unknown> = { enabled: true };
  if (multiplex.protocol) res.protocol = multiplex.protocol;
  // Sing-box 官方规范：max_connections 与 max_streams 互斥
  if (multiplex.maxConnections) {
    res.max_connections = multiplex.maxConnections;
  } else if (multiplex.maxStreams) {
    res.max_streams = multiplex.maxStreams;
  }
  if (multiplex.minStreams) res.min_streams = multiplex.minStreams;
  if (multiplex.padding !== undefined) res.padding = multiplex.padding;
  if (multiplex.brutal && multiplex.brutal.enabled) {
    const upMbps = multiplex.brutal.upMbps ?? 0;
    const downMbps = multiplex.brutal.downMbps ?? 0;
    if (upMbps > 0 && downMbps > 0) {
      res.brutal = {
        enabled: true,
        up_mbps: upMbps,
        down_mbps: downMbps
      };
    }
  }
  return res;
}

export function buildSingboxOutbound(user: SubUser, entry: SubEntry): Record<string, unknown> {
  if (entry.line?.externalConnection) return buildUpstreamOutbound(entry.line.externalConnection, entry.label);
  const serverHost = endpointHost(entry);
  const port = endpointPort(entry);

  switch (entry.inbound.type) {
    case 'VLESS':
    case 'VLESS_REALITY' as ProtocolType: {
      const p = entry.inbound.params as unknown as VlessParams;
      const transport = p.transport?.type !== 'tcp' && p.transport ? p.transport : undefined;
      const tls = p.tls;

      const outbound: Record<string, unknown> = {
        type: 'vless',
        tag: entry.label,
        server: serverHost,
        server_port: port,
        uuid: (p as unknown as { uuid?: string }).uuid || user.uuid
      };

      const clientTls = buildClientTls(tls, effectiveServerName(entry));
      if (clientTls) outbound.tls = clientTls;
      const clientTransport = buildClientTransport(transport, effectiveTransportHost(entry));
      if (clientTransport) outbound.transport = clientTransport;

      if (p.flow && !clientTransport && clientTls) {
        outbound.flow = p.flow;
      }

      const clientMultiplex = buildSingboxClientMultiplex(p.multiplex);
      if (clientMultiplex) outbound.multiplex = clientMultiplex;

      return outbound;
    }

    case 'VMESS': {
      const p = entry.inbound.params as unknown as VmessParams;
      const transport = p.transport?.type !== 'tcp' && p.transport ? p.transport : undefined;
      const tls = p.tls;

      const outbound: Record<string, unknown> = {
        type: 'vmess',
        tag: entry.label,
        server: serverHost,
        server_port: port,
        uuid: (p as unknown as { uuid?: string }).uuid || user.uuid,
        alter_id: p.alterId ?? (p as unknown as { alter_id?: number }).alter_id ?? 0,
        security: (p as unknown as { security?: string }).security || 'auto'
      };

      const clientTls = buildClientTls(tls, effectiveServerName(entry));
      if (clientTls) outbound.tls = clientTls;
      const clientTransport = buildClientTransport(transport, effectiveTransportHost(entry));
      if (clientTransport) outbound.transport = clientTransport;
      const clientMultiplex = buildSingboxClientMultiplex(p.multiplex);
      if (clientMultiplex) outbound.multiplex = clientMultiplex;

      return outbound;
    }

    case 'TROJAN': {
      const p = entry.inbound.params as unknown as TrojanParams;
      const transport = p.transport?.type !== 'tcp' && p.transport ? p.transport : undefined;
      const tls = p.tls;

      const outbound: Record<string, unknown> = {
        type: 'trojan',
        tag: entry.label,
        server: serverHost,
        server_port: port,
        password: (p as unknown as { password?: string }).password || user.credential
      };

      const clientTls = buildClientTls(tls, effectiveServerName(entry));
      if (clientTls) outbound.tls = clientTls;
      const clientTransport = buildClientTransport(transport, effectiveTransportHost(entry));
      if (clientTransport) outbound.transport = clientTransport;
      const clientMultiplex = buildSingboxClientMultiplex(p.multiplex);
      if (clientMultiplex) outbound.multiplex = clientMultiplex;

      return outbound;
    }

    case 'HYSTERIA2': {
      const p = entry.inbound.params as unknown as Hysteria2Params;
      const outbound: Record<string, unknown> = {
        type: 'hysteria2',
        tag: entry.label,
        server: serverHost,
        server_port: port,
        password: (p as unknown as { password?: string }).password || user.credential,
        ...(p.upMbps && p.upMbps > 0 ? { up_mbps: p.upMbps } : {}),
        ...(p.downMbps && p.downMbps > 0 ? { down_mbps: p.downMbps } : {}),
        ...(p.obfs && typeof p.obfs === 'object' && p.obfs.password
          ? { obfs: { type: p.obfs.type || 'salamander', password: p.obfs.password } }
          : (typeof (p as unknown as { obfs?: unknown }).obfs === 'string' && (p as unknown as { obfsPassword?: string }).obfsPassword
              ? { obfs: { type: (p as unknown as { obfs: string }).obfs, password: (p as unknown as { obfsPassword: string }).obfsPassword } }
              : {}))
      };
      const clientTls = buildClientTls(p.tls, effectiveServerName(entry));
      if (clientTls) outbound.tls = clientTls;
      return outbound;
    }

    case 'SHADOWSOCKS': {
      const p = entry.inbound.params as unknown as ShadowsocksParams;
      const password = p.mode === 'multi-user'
        ? buildShadowsocksClientPassword(p.method, p.password || '', user.credential, user.uuid)
        : normalizeShadowsocksPassword(p.method, p.password || '');
      const outbound: Record<string, unknown> = {
        type: 'shadowsocks',
        tag: entry.label,
        server: serverHost,
        server_port: port,
        method: p.method,
        password,
        ...(p.udpOverTcp ? { udp_over_tcp: true } : {})
      };
      const clientMultiplex = p.udpOverTcp ? undefined : buildSingboxClientMultiplex(p.multiplex);
      if (clientMultiplex) outbound.multiplex = clientMultiplex;
      return outbound;
    }

    case 'SHADOWTLS': {
      const p = entry.inbound.params as unknown as ShadowtlsParams;
      return {
        type: 'shadowsocks',
        tag: entry.label,
        server: serverHost,
        server_port: port,
        method: p.inner.method,
        password: shadowtlsInnerPassword(p),
        detour: `${entry.label} · ShadowTLS`
      };
    }

    case 'TUIC': {
      const p = entry.inbound.params as unknown as TuicParams;
      const outbound: Record<string, unknown> = {
        type: 'tuic',
        tag: entry.label,
        server: serverHost,
        server_port: port,
        uuid: (p as unknown as { uuid?: string }).uuid || user.uuid,
        password: (p as unknown as { password?: string }).password || user.credential,
        congestion_control: p.congestionControl || 'bbr',
        ...(p.zeroRttHandshake ? { zero_rtt_handshake: true } : {})
      };
      const clientTls = buildClientTls(p.tls, effectiveServerName(entry));
      if (clientTls) outbound.tls = clientTls;
      return outbound;
    }

    case 'NAIVE': {
      const p = entry.inbound.params as unknown as NaiveParams;
      const outbound: Record<string, unknown> = {
        type: 'naive',
        tag: entry.label,
        server: serverHost,
        server_port: port,
        username: formatAuthUserName(user, entry.line?.id),
        password: user.credential
      };
      const clientTls = buildClientTls(p.tls, effectiveServerName(entry), { includeAlpn: false, includeInsecure: false });
      if (clientTls) outbound.tls = clientTls;
      return outbound;
    }

    case 'MIXED':
    case 'SOCKS': {
      const p = entry.inbound.params as unknown as (SocksParams | MixedParams | undefined);
      const outbound: Record<string, unknown> = {
        type: 'socks',
        tag: entry.label,
        server: serverHost,
        server_port: port,
        version: '5'
      };
      if (user.credential || user.uuid) {
        outbound.username = formatAuthUserName(user, entry.line?.id);
        outbound.password = user.credential;
      }
      const clientTls = buildClientTls(p?.tls, effectiveServerName(entry));
      if (clientTls) outbound.tls = clientTls;
      return outbound;
    }

    case 'HTTP': {
      const p = entry.inbound.params as unknown as (HttpParams | undefined);
      const outbound: Record<string, unknown> = {
        type: 'http',
        tag: entry.label,
        server: serverHost,
        server_port: port
      };
      if (user.credential || user.uuid) {
        outbound.username = formatAuthUserName(user, entry.line?.id);
        outbound.password = user.credential;
      }
      const clientTls = buildClientTls(p?.tls, effectiveServerName(entry));
      if (clientTls) outbound.tls = clientTls;
      return outbound;
    }

    default:
      return {};
  }
}

export function buildShadowtlsTransportOutbound(entry: SubEntry, user: SubUser): Record<string, unknown> {
  const p = entry.inbound.params as unknown as ShadowtlsParams;
  return {
    type: 'shadowtls',
    tag: `${entry.label} · ShadowTLS`,
    server: endpointHost(entry),
    server_port: endpointPort(entry),
    version: 3,
    password: user.credential,
    tls: {
      enabled: true,
      server_name: shadowtlsHandshakeHost(entry, p)
    }
  };
}

// Sing-box 客户端配置：多协议出站 + direct 兜底
export function buildSingboxJson(user: SubUser, nodes: SubscriptionSource[], template?: SubscriptionTemplateConfig): string {
  const allEntries = entries(nodes);
  const primaryOutbounds = allEntries
    .map((entry) => buildSingboxOutbound(user, entry))
    .filter((o) => Object.keys(o).length > 0);
  const outbounds: Record<string, unknown>[] = [
    ...primaryOutbounds,
    ...allEntries
      .filter((entry) => entry.inbound.type === 'SHADOWTLS')
      .map((entry) => buildShadowtlsTransportOutbound(entry, user))
  ];

  const names = primaryOutbounds.map((outbound) => outbound.tag as string);
  const groups = templateGroups(template) as TemplateProxyGroupConfig[];
  const allGroupNames = new Set(
    groups
      .map((g) => (typeof g.name === 'string' ? g.name.trim() : ''))
      .filter((n): n is string => !!n)
  );
  const strategyOutbounds = groups.length
    ? groups.map((group) => {
        const groupEntries = allEntries.filter((entry) => matchesProxyFilter(entry, group as Record<string, unknown>));
        const groupNames = groupEntries
          .map((entry) => names[allEntries.indexOf(entry)])
          .filter((name): name is string => !!name && names.includes(name));
        const type = typeof group.type === 'string' ? group.type.toLowerCase() : 'select';
        const outboundType = type === 'select' ? 'selector' : 'urltest';
        return {
          type: outboundType,
          tag: typeof group.name === 'string' && group.name.trim() ? group.name : '节点选择',
          outbounds: resolveSingboxGroupOutbounds(group as Record<string, unknown>, groupNames, names, allGroupNames),
          ...(outboundType === 'urltest'
            ? {
                url: typeof group.url === 'string' ? group.url : 'https://www.gstatic.com/generate_204',
                interval: typeof group.interval === 'number' ? `${group.interval}s` : '5m',
                ...(typeof group.tolerance === 'number' ? { tolerance: group.tolerance } : {}),
                ...(type === 'fallback' ? { interruptible: true } : {})
              }
            : {})
        };
      })
    : [{ type: 'selector', tag: '节点选择', outbounds: [...names] }];
  const primaryGroup = (strategyOutbounds[0]?.tag as string) || '节点选择';
  const routeTarget = (target: string): string => {
    if (target.toUpperCase() === 'DIRECT') return 'direct';
    if (target.toUpperCase() === 'REJECT') return 'block';
    return target;
  };
  outbounds.push({ type: 'direct', tag: 'direct' });
  outbounds.push({ type: 'block', tag: 'block' });
  outbounds.push(...strategyOutbounds);
  const configuredRules = templateRules(template) as TemplateRuleItem[];
  const singboxRuleSets = buildSingboxRouteRuleSets(configuredRules);
  const singboxRuleSetTags = buildSingboxRuleSetTags(configuredRules);
  const routeRules: Array<Record<string, unknown>> = [];
  for (const [index, rule] of configuredRules.entries()) {
    if (rule.enabled === false) continue;
    const { target } = cleanTargetAndNoResolve(rule.target, primaryGroup);
    const routeOutbound = routeTarget(target);
    const values = stringArray(rule.rules);
    const type = ruleType(rule.type, 'domain-suffix');
    if (type === 'match' || type === 'final') {
      routeRules.push({ action: 'route', outbound: routeOutbound });
      continue;
    }
    if (type === 'remote-rule-set') {
      if (values.length) {
        routeRules.push({ domain_suffix: values, outbound: routeOutbound });
      }
      const ruleSet = singboxRuleSetTags.get(index);
      if (ruleSet?.length) {
        routeRules.push({ rule_set: ruleSet, outbound: routeOutbound });
      }
      continue;
    }
    if (type === 'geosite' || type === 'geoip') {
      const ruleSet = singboxRuleSetTags.get(index);
      if (ruleSet?.length) {
        routeRules.push({ rule_set: ruleSet, outbound: routeOutbound });
      }
      continue;
    }
    if (type === 'process-name') {
      routeRules.push({ process_name: values, outbound: routeOutbound });
      continue;
    }
    if (type === 'ip-cidr') {
      routeRules.push({ ip_cidr: values, outbound: routeOutbound });
      continue;
    }
    if (type === 'domain') {
      routeRules.push({ domain: values, outbound: routeOutbound });
      continue;
    }
    if (type === 'domain-keyword') {
      routeRules.push({ domain_keyword: values, outbound: routeOutbound });
      continue;
    }
    routeRules.push({ domain_suffix: values, outbound: routeOutbound });
  }
  const dnsConfig = buildSemanticSingboxDns(templateDns(template), primaryGroup, singboxRuleSets.map((rule) => String(rule.tag)));
  const hasDnsServers = Array.isArray(dnsConfig.servers) && dnsConfig.servers.length > 0;
  const config: Record<string, unknown> = {
    log: { level: 'info' },
    dns: dnsConfig,
    outbounds,
    route: {
      ...(hasDnsServers ? { default_domain_resolver: 'dns_direct' } : {}),
      ...(singboxRuleSets.length ? { rule_set: singboxRuleSets } : {}),
      rules: routeRules.length ? routeRules : [{ action: 'route', outbound: primaryGroup }]
    }
  };
  if (template?.customInjectJson?.trim()) {
    const parsed = JSON.parse(template.customInjectJson) as Record<string, unknown>;
    return JSON.stringify(deepMerge(config, parsed), null, 2);
  }
  return JSON.stringify(config, null, 2);
}
