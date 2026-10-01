import { Injectable, BadRequestException } from '@nestjs/common';
import { parse as parseYaml } from 'yaml';
import { createHash } from 'crypto';
import { canonicalJson } from './upstream.types';
import type { ParsedUpstreamNode, ParseResult, UpstreamUserInfo } from './upstream.types';
import { validateUpstreamConnection } from '../common/upstream-connection';
import { isIP } from 'node:net';
const NON_PROXY_TYPES = new Set(['direct', 'block', 'reject', 'dns', 'selector', 'urltest']);
const PROTOCOLS: Record<string, string> = { ss: 'SHADOWSOCKS', shadowsocks: 'SHADOWSOCKS', vless: 'VLESS', vmess: 'VMESS', trojan: 'TROJAN', hysteria2: 'HYSTERIA2', hy2: 'HYSTERIA2', tuic: 'TUIC', socks: 'SOCKS', socks5: 'SOCKS', http: 'HTTP' };
const hash = (value: unknown) => createHash('sha256').update(canonicalJson(value)).digest('hex');

const REGION_KEYWORDS: Array<{ code: string; regex: RegExp }> = [
  { code: 'HK', regex: /香港|Hong\s*Kong|HK|HongKong/i },
  { code: 'JP', regex: /日本|Japan|Tokyo|Osaka|JP/i },
  { code: 'US', regex: /美国|United\s*States|America|USA|US|Los\s*Angeles|San\s*Jose|Silicon|New\s*York/i },
  { code: 'SG', regex: /新加坡|Singapore|Lion\s*City|SG/i },
  { code: 'TW', regex: /台湾|Taiwan|Taipei|TW/i },
  { code: 'KR', regex: /韩国|Korea|Seoul|KR/i },
  { code: 'UK', regex: /英国|United\s*Kingdom|Great\s*Britain|London|UK|GB/i },
  { code: 'DE', regex: /德国|Germany|Frankfurt|DE/i },
  { code: 'FR', regex: /法国|France|Paris|FR/i },
  { code: 'CA', regex: /加拿大|Canada|Toronto|CA/i },
  { code: 'AU', regex: /澳大利亚|澳洲|Australia|Sydney|AU/i }
];

@Injectable()
export class UpstreamParserService {

  /**
   * 解析上游响应头中的 subscription-userinfo 流量与到期信息
   * 例如: upload=12345; download=67890; total=107374182400; expire=1735689600
   */
  parseUserInfoHeader(headerValue?: string | null): UpstreamUserInfo | null {
    if (!headerValue) return null;
    const result: UpstreamUserInfo = {};
    for (const part of headerValue.split(';')) {
      const [key, value] = part.trim().split('=');
      if (!value || !/^\d+$/.test(value)) continue;
      if (key === 'upload') result.uploadBytes = BigInt(value);
      if (key === 'download') result.downloadBytes = BigInt(value);
      if (key === 'total') result.totalBytes = BigInt(value);
      if (key === 'expire') {
        const seconds = Number(value);
        if (Number.isSafeInteger(seconds) && seconds > 0 && seconds <= 8640000000000) result.expireAt = new Date(seconds * 1000);
      }
    }
    if (result.uploadBytes !== undefined && result.downloadBytes !== undefined) result.usedBytes = result.uploadBytes + result.downloadBytes;
    return Object.keys(result).length ? result : null;
  }

  parse(rawContent: string, formatHint = 'AUTO'): ParseResult {
    const text = rawContent.trim();
    if (!text || Buffer.byteLength(text) > 5 * 1024 * 1024 || /^\s*</.test(text)) throw new BadRequestException('订阅为空、超限或不是代理配置');
    let document: Record<string, unknown> | undefined;
    let format: ParseResult['format'];
    if (formatHint === 'AUTO') {
      try {
        const parsed: unknown = text.startsWith('{') ? JSON.parse(text) : parseYaml(text, { maxAliasCount: 50 });
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) document = parsed as Record<string, unknown>;
      } catch { /* URI 内容不作为结构化配置处理 */ }
      format = document && ('proxies' in document || 'Proxy' in document) ? 'CLASH_META' : document && 'outbounds' in document ? 'SINGBOX' : 'URI_LIST';
    } else if (['CLASH_META', 'SINGBOX', 'URI_LIST'].includes(formatHint)) {
      format = formatHint as ParseResult['format'];
    } else throw new BadRequestException('不支持的订阅格式');
    let entries: unknown[];
    try {
      if (format === 'URI_LIST') {
        const decoded = !text.includes('://') && /^[A-Za-z0-9+/_=\s-]+$/.test(text) ? Buffer.from(text.replace(/\s/g, ''), 'base64url').toString('utf8') : text;
        entries = decoded.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
      } else {
        document ??= (format === 'SINGBOX' ? JSON.parse(text) : parseYaml(text, { maxAliasCount: 50 })) as Record<string, unknown>;
        const list = format === 'SINGBOX' ? document.outbounds : document.proxies ?? document.Proxy;
        if (!Array.isArray(list)) throw new Error();
        entries = list;
      }
    } catch { throw new BadRequestException('订阅结构无效或指定格式不匹配'); }
    const nodes: ParsedUpstreamNode[] = [];
    const diagnostics = { recognized: 0, duplicates: 0, skipped: 0 };
    const seen = new Set<string>();
    for (const [index, entry] of entries.entries()) {
      try {
        let node: ParsedUpstreamNode;
        if (format === 'URI_LIST') node = this.parseUri(String(entry));
        else {
          if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error();
          const proxy = entry as Record<string, unknown>;
          if (NON_PROXY_TYPES.has(String(proxy.type).toLowerCase())) { diagnostics.skipped++; continue; }
          if (!PROTOCOLS[String(proxy.type).toLowerCase()]) throw new Error();
          const converted = format === 'SINGBOX' ? this.convertSingbox(proxy) : this.convertClashProxy(proxy);
          if (!converted) throw new Error();
          node = converted;
        }
        validateUpstreamConnection(node);
        diagnostics.recognized++;
        const exact = hash({ name: node.name, sourceKey: node.sourceKey, connectionHash: node.connectionHash, tags: node.tags });
        if (seen.has(exact)) { diagnostics.duplicates++; continue; }
        seen.add(exact);
        nodes.push(node);
      } catch { throw new BadRequestException(`代理条目 ${index + 1} 无效或不受支持；快照未提交`); }
    }
    if (!nodes.length) throw new BadRequestException('订阅没有有效代理；快照未提交');
    return { format, nodes, diagnostics };
  }

  private convertClashProxy(p: Record<string, unknown>): ParsedUpstreamNode | null {
    const rawType = String(p.type || '').toLowerCase();
    const name = String(p.name || '').trim();
    const serverHost = String(p.server || '').trim();
    const serverPort = Number(p.port);
    if (!name || !serverHost || !serverPort || isNaN(serverPort)) return null;

    let protocolType = 'DIRECT';
    const params: Record<string, unknown> = {};

    switch (rawType) {
      case 'ss':
      case 'shadowsocks': {
        protocolType = 'SHADOWSOCKS';
        params.method = String(p.cipher || '');
        params.password = String(p.password || '');
        if (p.plugin) params.plugin = p.plugin;
        if (p['plugin-opts']) params.pluginOpts = p['plugin-opts'];
        break;
      }
      case 'vmess': {
        protocolType = 'VMESS';
        params.uuid = String(p.uuid || '');
        params.alterId = Number(p.alterId ?? 0);
        params.security = String(p.cipher || 'auto');
        this.extractClashTransportAndTls(p, params);
        break;
      }
      case 'vless': {
        protocolType = 'VLESS';
        params.uuid = String(p.uuid || '');
        if (p.flow) params.flow = String(p.flow);
        this.extractClashTransportAndTls(p, params);
        break;
      }
      case 'trojan': {
        protocolType = 'TROJAN';
        params.password = String(p.password || '');
        this.extractClashTransportAndTls(p, params);
        break;
      }
      case 'hysteria2':
      case 'hy2': {
        protocolType = 'HYSTERIA2';
        params.password = String(p.password || '');
        if (p.up) params.upMbps = Number(p.up);
        if (p.down) params.downMbps = Number(p.down);
        if (p.obfs && p['obfs-password']) {
          params.obfs = { type: String(p.obfs), password: String(p['obfs-password']) };
          params.obfsPassword = String(p['obfs-password']);
        } else if (p.obfs && typeof p.obfs === 'object') {
          params.obfs = p.obfs;
        }
        const tls: Record<string, unknown> = { enabled: true, mode: 'tls' };
        if (p.sni) tls.serverName = String(p.sni);
        if (p['skip-cert-verify'] !== undefined) tls.insecure = Boolean(p['skip-cert-verify']);
        if (Array.isArray(p.alpn)) tls.alpn = p.alpn;
        params.tls = tls;
        break;
      }
      case 'tuic': {
        protocolType = 'TUIC';
        params.uuid = String(p.uuid || '');
        params.password = String(p.password || '');
        if (p['congestion-controller']) params.congestionControl = String(p['congestion-controller']);
        if (p['reduce-rtt']) params.zeroRttHandshake = Boolean(p['reduce-rtt']);
        const tls: Record<string, unknown> = { enabled: true };
        if (p.sni) tls.serverName = String(p.sni);
        if (p['skip-cert-verify'] !== undefined) tls.insecure = Boolean(p['skip-cert-verify']);
        if (Array.isArray(p.alpn)) tls.alpn = p.alpn;
        params.tls = tls;
        break;
      }
      case 'socks5':
      case 'socks': {
        protocolType = 'SOCKS';
        if (p.username) params.username = String(p.username);
        if (p.password) params.password = String(p.password);
        if (p.tls) params.tls = { enabled: true, serverName: p.sni };
        break;
      }
      case 'http': {
        protocolType = 'HTTP';
        if (p.username) params.username = String(p.username);
        if (p.password) params.password = String(p.password);
        if (p.tls) params.tls = { enabled: true, serverName: p.sni };
        break;
      }
      default: throw new Error('Unsupported proxy');
    }
    if (protocolType === 'TROJAN' && !params.tls) params.tls = { enabled: true, mode: 'tls' };
    return this.makeNode(name, protocolType, serverHost, serverPort, params, { kind: 'STRUCTURED', value: p }, p.id);
  }

  private extractClashTransportAndTls(p: Record<string, unknown>, params: Record<string, unknown>) {
    const tls: Record<string, unknown> = {
      enabled: p.tls === undefined ? String(p.type).toLowerCase() === 'trojan' : Boolean(p.tls),
      mode: 'tls'
    };
    if (p.sni) tls.serverName = String(p.sni);
    if (p['skip-cert-verify'] !== undefined) tls.insecure = Boolean(p['skip-cert-verify']);
    if (Array.isArray(p.alpn)) tls.alpn = p.alpn;
    if (p['client-fingerprint']) tls.clientFingerprint = String(p['client-fingerprint']);

    // Reality
    if (p['reality-opts'] && typeof p['reality-opts'] === 'object') {
      const ro = p['reality-opts'] as Record<string, unknown>;
      const shortId = ro['short-id'] ? String(ro['short-id']) : '';
      tls.mode = 'reality';
      tls.reality = {
        enabled: true,
        publicKey: ro['public-key'] ? String(ro['public-key']) : '',
        shortId,
        shortIds: [shortId],
        ...(tls.serverName ? { serverNames: [String(tls.serverName)] } : {})
      };
      tls.enabled = true;
    }
    if (tls.enabled) params.tls = tls;
    // Transport
    const network = String(p.network || '').toLowerCase();
    if (network === 'ws') {
      const wsOpts = (p['ws-opts'] || {}) as Record<string, unknown>;
      params.transport = {
        type: 'ws',
        path: wsOpts.path ? String(wsOpts.path) : '/',
        headers: wsOpts.headers && typeof wsOpts.headers === 'object' ? wsOpts.headers : {}
      };
    } else if (network === 'grpc') {
      const grpcOpts = (p['grpc-opts'] || {}) as Record<string, unknown>;
      params.transport = {
        type: 'grpc',
        serviceName: grpcOpts['grpc-service-name'] ? String(grpcOpts['grpc-service-name']) : ''
      };
    } else if (network === 'h2' || network === 'http') {
      const h2Opts = (p['h2-opts'] || {}) as Record<string, unknown>;
      params.transport = {
        type: 'http',
        host: Array.isArray(h2Opts.host) ? h2Opts.host[0] : (h2Opts.host ? String(h2Opts.host) : undefined),
        path: h2Opts.path ? String(h2Opts.path) : '/'
      };
    } else if (network && network !== 'tcp') {
      throw new Error('Unsupported transport');
    }
  }

  // ==============================
  // Sing-box (JSON) 解析器
  // ==============================

  private convertSingbox(ob: Record<string, unknown>): ParsedUpstreamNode {
    const protocolType = PROTOCOLS[String(ob.type).toLowerCase()];
    if (!protocolType) throw new Error('Unsupported proxy');
    const params = { ...ob };
    for (const key of ['type', 'tag', 'server', 'server_port', 'id']) delete params[key];
    this.normalizeSingboxParams(params);
    if (['TROJAN', 'TUIC', 'HYSTERIA2'].includes(protocolType) && !params.tls) params.tls = { enabled: true, mode: 'tls' };
    return this.makeNode(String(ob.tag || ''), protocolType, String(ob.server || ''), Number(ob.server_port), params, { kind: 'STRUCTURED', value: ob }, ob.id);
  }

  private normalizeSingboxParams(params: Record<string, unknown>) {
    if (params.alter_id !== undefined) {
      params.alterId = Number(params.alter_id) || 0;
      delete params.alter_id;
    }
    if (params.up_mbps !== undefined) {
      params.upMbps = Number(params.up_mbps) || 0;
      delete params.up_mbps;
    }
    if (params.down_mbps !== undefined) {
      params.downMbps = Number(params.down_mbps) || 0;
      delete params.down_mbps;
    }
    if (params.congestion_control !== undefined) {
      params.congestionControl = String(params.congestion_control);
      delete params.congestion_control;
    }
    if (params.zero_rtt_handshake !== undefined) {
      params.zeroRttHandshake = Boolean(params.zero_rtt_handshake);
      delete params.zero_rtt_handshake;
    }
    if (params.udp_over_tcp !== undefined) {
      params.udpOverTcp = Boolean(params.udp_over_tcp);
      delete params.udp_over_tcp;
    }
    if (params.plugin_opts !== undefined) {
      params.pluginOpts = params.plugin_opts;
      delete params.plugin_opts;
    }
    if (params.tls && typeof params.tls === 'object' && !Array.isArray(params.tls)) {
      const rawTls = { ...(params.tls as Record<string, unknown>) };
      if (typeof rawTls.server_name === 'string') {
        rawTls.serverName = rawTls.server_name;
        delete rawTls.server_name;
      }
      if (rawTls.utls && typeof rawTls.utls === 'object' && !Array.isArray(rawTls.utls)) {
        const utls = rawTls.utls as Record<string, unknown>;
        if (typeof utls.fingerprint === 'string' && utls.fingerprint) {
          rawTls.clientFingerprint = utls.fingerprint;
        }
      }
      if (rawTls.reality && typeof rawTls.reality === 'object' && !Array.isArray(rawTls.reality)) {
        const rawReality = { ...(rawTls.reality as Record<string, unknown>) };
        const publicKey = typeof rawReality.public_key === 'string'
          ? rawReality.public_key
          : (typeof rawReality.publicKey === 'string' ? rawReality.publicKey : '');
        const shortId = typeof rawReality.short_id === 'string'
          ? rawReality.short_id
          : (typeof rawReality.shortId === 'string' ? rawReality.shortId : '');
        delete rawReality.public_key;
        delete rawReality.short_id;
        rawReality.enabled = rawReality.enabled ?? true;
        rawReality.publicKey = publicKey;
        rawReality.shortId = shortId;
        rawReality.shortIds = Array.isArray(rawReality.shortIds) ? rawReality.shortIds : [shortId];
        if (typeof rawTls.serverName === 'string' && rawTls.serverName && !Array.isArray(rawReality.serverNames)) {
          rawReality.serverNames = [rawTls.serverName];
        }
        rawTls.reality = rawReality;
        rawTls.mode = 'reality';
      } else if (rawTls.enabled) {
        rawTls.mode = rawTls.mode || 'tls';
      }
      params.tls = rawTls;
    }
    if (params.transport && typeof params.transport === 'object' && !Array.isArray(params.transport)) {
      const rawTransport = { ...(params.transport as Record<string, unknown>) };
      if (typeof rawTransport.service_name === 'string') {
        rawTransport.serviceName = rawTransport.service_name;
        delete rawTransport.service_name;
      }
      if (typeof rawTransport.max_early_data === 'number') {
        rawTransport.maxEarlyData = rawTransport.max_early_data;
        delete rawTransport.max_early_data;
      }
      if (typeof rawTransport.early_data_header_name === 'string') {
        rawTransport.earlyDataHeaderName = rawTransport.early_data_header_name;
        delete rawTransport.early_data_header_name;
      }
      params.transport = rawTransport;
    }
  }

  // ==============================
  // URI 列表解析器 (单行 / Base64)
  // ==============================

  private parseUri(uri: string): ParsedUpstreamNode {
    const scheme = uri.slice(0, uri.indexOf('://')).toLowerCase();
    const protocolType = PROTOCOLS[scheme];
    if (!protocolType) throw new Error('Unsupported proxy');
    if (scheme === 'vmess') {
      const obj = JSON.parse(Buffer.from(uri.slice(8), 'base64url').toString('utf8')) as Record<string, unknown>;
      return this.convertClashProxy({ name: obj.ps || 'VMess', type: 'vmess', server: obj.add, port: obj.port, uuid: obj.id, alterId: obj.aid || 0, cipher: obj.scy || 'auto', tls: obj.tls === 'tls', sni: obj.sni, alpn: obj.alpn ? String(obj.alpn).split(',') : undefined, network: obj.net, 'ws-opts': { path: obj.path || '/', headers: obj.host ? { Host: obj.host } : {} }, 'grpc-opts': { 'grpc-service-name': obj.path || '' } })!;
    }
    let rest = uri.slice(uri.indexOf('://') + 3);
    const hashIndex = rest.indexOf('#');
    const name = hashIndex >= 0 ? decodeURIComponent(rest.slice(hashIndex + 1)) : protocolType;
    rest = hashIndex >= 0 ? rest.slice(0, hashIndex) : rest;
    const queryIndex = rest.indexOf('?');
    const query = new URLSearchParams(queryIndex >= 0 ? rest.slice(queryIndex + 1) : '');
    let authority = (queryIndex >= 0 ? rest.slice(0, queryIndex) : rest).replace(/\/$/, '');
    if (scheme === 'ss' && !authority.includes('@')) authority = Buffer.from(authority, 'base64url').toString('utf8');
    const at = authority.lastIndexOf('@');
    let credential = at >= 0 ? authority.slice(0, at) : '';
    const endpoint = at >= 0 ? authority.slice(at + 1) : authority;
    const match = /^(?:\[([^\]]+)\]|([^:]+)):(\d+)$/.exec(endpoint);
    if (!match) throw new Error('Invalid endpoint');
    const host = match[1] || match[2];
    const port = Number(match[3]);
    const params: Record<string, unknown> = {};
    if (scheme === 'ss') {
      if (!credential.includes(':')) credential = Buffer.from(credential, 'base64url').toString('utf8');
      const colon = credential.indexOf(':');
      if (colon < 0) throw new Error('Invalid credential');
      params.method = decodeURIComponent(credential.slice(0, colon));
      params.password = decodeURIComponent(credential.slice(colon + 1));
      if (query.get('plugin')) {
        const [plugin, ...opts] = query.get('plugin')!.split(';');
        params.plugin = plugin;
        params.pluginOpts = opts.join(';');
      }
    } else if (['SOCKS', 'HTTP', 'TUIC'].includes(protocolType)) {
      if (credential) {
        const colon = credential.indexOf(':');
        params[protocolType === 'TUIC' ? 'uuid' : 'username'] = decodeURIComponent(colon >= 0 ? credential.slice(0, colon) : credential);
        if (colon >= 0) params.password = decodeURIComponent(credential.slice(colon + 1));
      }
    } else params[protocolType === 'VLESS' ? 'uuid' : 'password'] = decodeURIComponent(credential);
    const security = query.get('security');
    if (['TROJAN', 'HYSTERIA2', 'TUIC'].includes(protocolType) || security === 'tls' || security === 'reality') {
      const tls: Record<string, unknown> = { enabled: true, mode: security === 'reality' ? 'reality' : 'tls' };
      if (query.get('sni')) tls.serverName = query.get('sni');
      if (query.get('fp')) tls.clientFingerprint = query.get('fp');
      if (query.get('alpn')) tls.alpn = query.get('alpn')!.split(',');
      if (['insecure', 'allowInsecure', 'allow_insecure'].some((key) => query.get(key) === '1')) tls.insecure = true;
      if (security === 'reality') tls.reality = { enabled: true, publicKey: query.get('pbk') || '', shortId: query.get('sid') || '' };
      params.tls = tls;
    }
    if (query.get('flow')) params.flow = query.get('flow');
    const transport = query.get('type') || query.get('net') || 'tcp';
    if (transport === 'ws') params.transport = { type: 'ws', path: query.get('path') || '/', headers: query.get('host') ? { Host: query.get('host') } : {} };
    else if (transport === 'grpc') params.transport = { type: 'grpc', serviceName: query.get('serviceName') || '' };
    else if (transport !== 'tcp') throw new Error('Unsupported transport');
    if (protocolType === 'HYSTERIA2' && query.get('obfs')) params.obfs = { type: query.get('obfs'), password: query.get('obfs-password') || '' };
    if (protocolType === 'TUIC' && query.get('congestion_control')) params.congestionControl = query.get('congestion_control');
    return this.makeNode(name, protocolType, host, port, params, { kind: 'URI', value: uri });
  }

  private makeNode(name: string, protocolType: string, serverHost: string, serverPort: number, params: Record<string, unknown>, rawConfig: ParsedUpstreamNode['rawConfig'], sourceId?: unknown): ParsedUpstreamNode {
    serverHost = serverHost.trim().replace(/^\[|\]$/g, '').toLowerCase().replace(/\.$/, '');
    if (!name.trim() || name.length > 512 || !serverHost || serverHost.length > 253 || /[\s/@?#]/.test(serverHost) || (serverHost.includes(':') && !isIP(serverHost)) || !Number.isInteger(serverPort) || serverPort < 1 || serverPort > 65535) throw new Error('Invalid node');
    const sourceKey = typeof sourceId === 'string' && sourceId.length > 0 && sourceId.length <= 512 ? sourceId : undefined;
    const connectionHash = this.computeConnectionHash(protocolType, serverHost, serverPort, params);
    const tags = this.extractTags(name);
    return { name: name.trim(), protocolType, serverHost, serverPort, params, rawConfig, sourceKey, connectionHash, configHash: hash({ connectionHash, name: name.trim(), tags }), tags };
  }

  computeConnectionHash(protocolType: string, serverHost: string, serverPort: number, params: Record<string, unknown>): string {
    return hash({ protocolType: protocolType.toUpperCase(), serverHost: serverHost.trim().toLowerCase(), serverPort, params });
  }

  /**
   * 从节点名称智能提取地区标签
   */
  extractTags(name: string): string[] {
    const tags = new Set<string>();
    for (const item of REGION_KEYWORDS) {
      if (item.regex.test(name)) {
        tags.add(item.code);
      }
    }
    return Array.from(tags);
  }
}
