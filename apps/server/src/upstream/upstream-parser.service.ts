import { Injectable, BadRequestException } from '@nestjs/common';
import { parse as parseYaml } from 'yaml';
import { createHash } from 'crypto';
import type { ParsedUpstreamNode, ParseResult, UpstreamUserInfo } from './upstream.types';
import type { ProtocolType } from '../common/constants';

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
    if (!headerValue || typeof headerValue !== 'string') return null;
    const parts = headerValue.split(';');
    const result: UpstreamUserInfo = {};
    for (const part of parts) {
      const [rawKey, rawVal] = part.split('=').map((s) => s.trim());
      if (!rawKey || !rawVal) continue;
      const key = rawKey.toLowerCase();
      try {
        if (key === 'upload') result.uploadBytes = BigInt(rawVal);
        if (key === 'download') result.downloadBytes = BigInt(rawVal);
        if (key === 'total') result.totalBytes = BigInt(rawVal);
        if (key === 'expire') {
          const timestampSec = Number(rawVal);
          if (timestampSec > 0) result.expireAt = new Date(timestampSec * 1000);
        }
      } catch {
        // ignore bigint/number parse errors
      }
    }
    if (result.uploadBytes !== undefined || result.downloadBytes !== undefined) {
      result.usedBytes = (result.uploadBytes ?? 0n) + (result.downloadBytes ?? 0n);
    }
    return Object.keys(result).length > 0 ? result : null;
  }

  /**
   * 自动探测并解析上游订阅内容
   */
  parse(rawContent: string, formatHint: string = 'AUTO'): ParseResult {
    const trimmed = rawContent.trim();
    if (!trimmed) {
      throw new BadRequestException('订阅内容为空');
    }

    // 1. 若显式指定或探测为 Clash Meta (YAML)
    if (formatHint === 'CLASH_META' || (formatHint === 'AUTO' && this.isClashMetaYaml(trimmed))) {
      try {
        const nodes = this.parseClashMeta(trimmed);
        if (nodes.length > 0) {
          return { format: 'CLASH_META', nodes };
        }
      } catch (err) {
        if (formatHint === 'CLASH_META') throw err;
      }
    }

    // 2. 若显式指定或探测为 Sing-box (JSON)
    if (formatHint === 'SINGBOX' || (formatHint === 'AUTO' && this.isSingboxJson(trimmed))) {
      try {
        const nodes = this.parseSingbox(trimmed);
        if (nodes.length > 0) {
          return { format: 'SINGBOX', nodes };
        }
      } catch (err) {
        if (formatHint === 'SINGBOX') throw err;
      }
    }

    // 3. 尝试作为 URI 列表解析（支持 Base64 解码）
    try {
      const nodes = this.parseUriList(trimmed);
      if (nodes.length > 0) {
        return { format: 'URI_LIST', nodes };
      }
    } catch (err) {
      if (formatHint === 'URI_LIST') throw err;
    }

    throw new BadRequestException('无法识别该订阅的内容格式，请确认其符合 Mihomo (Clash Meta)、Sing-box 或标准 URI 规范');
  }

  // ==============================
  // 探测逻辑
  // ==============================

  private isClashMetaYaml(content: string): boolean {
    return (
      (content.includes('proxies:') || content.includes('Proxy:')) &&
      !content.startsWith('{')
    );
  }

  private isSingboxJson(content: string): boolean {
    if (!content.startsWith('{') && !content.startsWith('[')) return false;
    try {
      const parsed = JSON.parse(content);
      return Boolean(parsed.outbounds && Array.isArray(parsed.outbounds));
    } catch {
      return false;
    }
  }

  // ==============================
  // Clash Meta / Mihomo 解析器
  // ==============================

  private parseClashMeta(content: string): ParsedUpstreamNode[] {
    const parsed = parseYaml(content) as Record<string, unknown>;
    const rawProxies = Array.isArray(parsed?.proxies)
      ? (parsed.proxies as Array<Record<string, unknown>>)
      : Array.isArray(parsed?.Proxy)
        ? (parsed.Proxy as Array<Record<string, unknown>>)
        : [];

    const nodes: ParsedUpstreamNode[] = [];
    for (const p of rawProxies) {
      if (!p || typeof p !== 'object') continue;
      const node = this.convertClashProxy(p);
      if (node) nodes.push(node);
    }
    return nodes;
  }

  private convertClashProxy(p: Record<string, unknown>): ParsedUpstreamNode | null {
    const rawType = String(p.type || '').toLowerCase();
    const name = String(p.name || '').trim();
    const serverHost = String(p.server || '').trim();
    const serverPort = Number(p.port);
    if (!name || !serverHost || !serverPort || isNaN(serverPort)) return null;

    let protocolType: ProtocolType | string = 'DIRECT';
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
        if (p.obfs) params.obfs = String(p.obfs);
        if (p['obfs-password']) params.obfsPassword = String(p['obfs-password']);
        const tls: Record<string, unknown> = { enabled: true };
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
      default:
        // 其他协议（如 wireguard 等）以原样记录
        protocolType = rawType.toUpperCase();
        Object.assign(params, p);
        break;
    }

    const fingerprint = this.computeFingerprint(protocolType, serverHost, serverPort, params);
    const tags = this.extractTags(name);

    return {
      name,
      protocolType,
      serverHost,
      serverPort,
      params,
      rawConfig: p,
      fingerprint,
      tags
    };
  }

  private extractClashTransportAndTls(p: Record<string, unknown>, params: Record<string, unknown>) {
    const tls: Record<string, unknown> = {
      enabled: Boolean(p.tls)
    };
    if (p.sni) tls.serverName = String(p.sni);
    if (p['skip-cert-verify'] !== undefined) tls.insecure = Boolean(p['skip-cert-verify']);
    if (Array.isArray(p.alpn)) tls.alpn = p.alpn;
    if (p['client-fingerprint']) tls.clientFingerprint = String(p['client-fingerprint']);

    // Reality
    if (p['reality-opts'] && typeof p['reality-opts'] === 'object') {
      const ro = p['reality-opts'] as Record<string, unknown>;
      tls.reality = {
        enabled: true,
        publicKey: ro['public-key'] ? String(ro['public-key']) : '',
        shortId: ro['short-id'] ? String(ro['short-id']) : ''
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
    }
  }

  // ==============================
  // Sing-box (JSON) 解析器
  // ==============================

  private parseSingbox(content: string): ParsedUpstreamNode[] {
    const parsed = JSON.parse(content) as Record<string, unknown>;
    const outbounds = Array.isArray(parsed.outbounds)
      ? (parsed.outbounds as Array<Record<string, unknown>>)
      : [];

    const nonProxyTypes = new Set(['direct', 'block', 'dns', 'selector', 'urltest', 'wireguard-drop']);
    const nodes: ParsedUpstreamNode[] = [];

    for (const ob of outbounds) {
      if (!ob || typeof ob !== 'object') continue;
      const type = String(ob.type || '').toLowerCase();
      if (nonProxyTypes.has(type)) continue;

      const name = String(ob.tag || '').trim();
      const serverHost = String(ob.server || '').trim();
      const serverPort = Number(ob.server_port);
      if (!name || !serverHost || !serverPort) continue;

      const protocolType = type.toUpperCase() as ProtocolType;
      // Sing-box 的 outbound 字段本身就是标准格式
      const params: Record<string, unknown> = { ...ob };
      delete params.type;
      delete params.tag;
      delete params.server;
      delete params.server_port;

      const fingerprint = this.computeFingerprint(protocolType, serverHost, serverPort, params);
      const tags = this.extractTags(name);

      nodes.push({
        name,
        protocolType,
        serverHost,
        serverPort,
        params,
        rawConfig: ob,
        fingerprint,
        tags
      });
    }

    return nodes;
  }

  // ==============================
  // URI 列表解析器 (单行 / Base64)
  // ==============================

  private parseUriList(content: string): ParsedUpstreamNode[] {
    let text = content;
    // 检查是否全文本是 Base64 编码
    if (!content.includes('://') && /^[A-Za-z0-9+/=\r\n]+$/.test(content)) {
      try {
        const decoded = Buffer.from(content.replace(/\s+/g, ''), 'base64').toString('utf-8');
        if (decoded.includes('://')) {
          text = decoded;
        }
      } catch {
        // ignore
      }
    }

    const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    const nodes: ParsedUpstreamNode[] = [];

    for (const line of lines) {
      try {
        const node = this.parseSingleUri(line);
        if (node) nodes.push(node);
      } catch {
        // skip invalid line
      }
    }

    return nodes;
  }

  private parseSingleUri(uri: string): ParsedUpstreamNode | null {
    if (!uri.includes('://')) return null;
    const protoIndex = uri.indexOf('://');
    const scheme = uri.slice(0, protoIndex).toLowerCase();
    const rest = uri.slice(protoIndex + 3);

    switch (scheme) {
      case 'vless':
        return this.parseVlessUri(rest);
      case 'vmess':
        return this.parseVmessUri(rest);
      case 'trojan':
        return this.parseTrojanUri(rest);
      case 'ss':
        return this.parseShadowsocksUri(rest);
      case 'hysteria2':
      case 'hy2':
        return this.parseHysteria2Uri(rest);
      case 'tuic':
        return this.parseTuicUri(rest);
      case 'socks5':
      case 'socks':
      case 'http':
        return this.parseCommonProxyUri(scheme.toUpperCase(), rest);
      default:
        return null;
    }
  }

  private parseVlessUri(rest: string): ParsedUpstreamNode | null {
    const [mainPart, rawName] = rest.split('#');
    const name = rawName ? decodeURIComponent(rawName) : 'VLESS 节点';
    const [credAndHost, queryPart] = mainPart.split('?');
    const atIndex = credAndHost.lastIndexOf('@');
    if (atIndex < 0) return null;

    const uuid = credAndHost.slice(0, atIndex);
    const hostPort = credAndHost.slice(atIndex + 1);
    const [serverHost, rawPort] = hostPort.split(':');
    const serverPort = Number(rawPort);
    if (!serverHost || !serverPort) return null;

    const query = new URLSearchParams(queryPart || '');
    const params: Record<string, unknown> = { uuid };
    if (query.get('flow')) params.flow = query.get('flow');

    const security = query.get('security');
    if (security === 'tls' || security === 'reality') {
      const tls: Record<string, unknown> = { enabled: true };
      if (query.get('sni')) tls.serverName = query.get('sni');
      if (query.get('fp')) tls.clientFingerprint = query.get('fp');
      if (query.get('alpn')) tls.alpn = query.get('alpn')!.split(',');
      if (query.get('insecure') === '1') tls.insecure = true;
      if (security === 'reality') {
        tls.reality = {
          enabled: true,
          publicKey: query.get('pbk') || '',
          shortId: query.get('sid') || ''
        };
      }
      params.tls = tls;
    }

    const type = query.get('type') || query.get('net') || 'tcp';
    if (type === 'ws') {
      params.transport = {
        type: 'ws',
        path: query.get('path') || '/',
        headers: query.get('host') ? { Host: query.get('host') } : {}
      };
    } else if (type === 'grpc') {
      params.transport = {
        type: 'grpc',
        serviceName: query.get('serviceName') || ''
      };
    }

    const fingerprint = this.computeFingerprint('VLESS', serverHost, serverPort, params);
    return {
      name,
      protocolType: 'VLESS',
      serverHost,
      serverPort,
      params,
      rawConfig: uriRest('vless', rest),
      fingerprint,
      tags: this.extractTags(name)
    };
  }

  private parseVmessUri(rest: string): ParsedUpstreamNode | null {
    try {
      const decoded = Buffer.from(rest, 'base64').toString('utf-8');
      const obj = JSON.parse(decoded) as Record<string, unknown>;
      const name = String(obj.ps || 'VMess 节点');
      const serverHost = String(obj.add || '');
      const serverPort = Number(obj.port);
      if (!serverHost || !serverPort) return null;

      const params: Record<string, unknown> = {
        uuid: String(obj.id || ''),
        alterId: Number(obj.aid || 0),
        security: String(obj.scy || 'auto')
      };

      if (obj.tls === 'tls') {
        const tls: Record<string, unknown> = { enabled: true };
        if (obj.sni) tls.serverName = String(obj.sni);
        if (obj.alpn) tls.alpn = String(obj.alpn).split(',');
        params.tls = tls;
      }

      const net = String(obj.net || 'tcp').toLowerCase();
      if (net === 'ws') {
        params.transport = {
          type: 'ws',
          path: String(obj.path || '/'),
          headers: obj.host ? { Host: String(obj.host) } : {}
        };
      } else if (net === 'grpc') {
        params.transport = {
          type: 'grpc',
          serviceName: String(obj.path || '')
        };
      }

      const fingerprint = this.computeFingerprint('VMESS', serverHost, serverPort, params);
      return {
        name,
        protocolType: 'VMESS',
        serverHost,
        serverPort,
        params,
        rawConfig: obj,
        fingerprint,
        tags: this.extractTags(name)
      };
    } catch {
      return null;
    }
  }

  private parseTrojanUri(rest: string): ParsedUpstreamNode | null {
    const [mainPart, rawName] = rest.split('#');
    const name = rawName ? decodeURIComponent(rawName) : 'Trojan 节点';
    const [credAndHost, queryPart] = mainPart.split('?');
    const atIndex = credAndHost.lastIndexOf('@');
    if (atIndex < 0) return null;

    const password = credAndHost.slice(0, atIndex);
    const hostPort = credAndHost.slice(atIndex + 1);
    const [serverHost, rawPort] = hostPort.split(':');
    const serverPort = Number(rawPort);
    if (!serverHost || !serverPort) return null;

    const query = new URLSearchParams(queryPart || '');
    const tls: Record<string, unknown> = { enabled: true };
    if (query.get('sni')) tls.serverName = query.get('sni');
    if (query.get('alpn')) tls.alpn = query.get('alpn')!.split(',');
    if (query.get('allowInsecure') === '1') tls.insecure = true;

    const params: Record<string, unknown> = { password, tls };
    const type = query.get('type');
    if (type === 'ws') {
      params.transport = {
        type: 'ws',
        path: query.get('path') || '/',
        headers: query.get('host') ? { Host: query.get('host') } : {}
      };
    } else if (type === 'grpc') {
      params.transport = {
        type: 'grpc',
        serviceName: query.get('serviceName') || ''
      };
    }

    const fingerprint = this.computeFingerprint('TROJAN', serverHost, serverPort, params);
    return {
      name,
      protocolType: 'TROJAN',
      serverHost,
      serverPort,
      params,
      rawConfig: uriRest('trojan', rest),
      fingerprint,
      tags: this.extractTags(name)
    };
  }

  private parseShadowsocksUri(rest: string): ParsedUpstreamNode | null {
    const [mainPart, rawName] = rest.split('#');
    const name = rawName ? decodeURIComponent(rawName) : 'Shadowsocks 节点';
    let method = '';
    let password = '';
    let serverHost = '';
    let serverPort = 0;

    if (mainPart.includes('@')) {
      const atIndex = mainPart.lastIndexOf('@');
      const credPart = mainPart.slice(0, atIndex);
      const hostPort = mainPart.slice(atIndex + 1);
      const [h, p] = hostPort.split(':');
      serverHost = h;
      serverPort = Number(p);

      // 解密 base64 cred
      try {
        const decoded = Buffer.from(credPart, 'base64').toString('utf-8');
        const [m, pwd] = decoded.split(':');
        method = m;
        password = pwd;
      } catch {
        const [m, pwd] = credPart.split(':');
        method = m;
        password = pwd;
      }
    } else {
      // 全身 base64
      try {
        const decoded = Buffer.from(mainPart, 'base64').toString('utf-8');
        const atIndex = decoded.lastIndexOf('@');
        const cred = decoded.slice(0, atIndex);
        const hostPort = decoded.slice(atIndex + 1);
        const [m, pwd] = cred.split(':');
        const [h, p] = hostPort.split(':');
        method = m;
        password = pwd;
        serverHost = h;
        serverPort = Number(p);
      } catch {
        return null;
      }
    }

    if (!serverHost || !serverPort || !method || !password) return null;
    const params = { method, password };
    const fingerprint = this.computeFingerprint('SHADOWSOCKS', serverHost, serverPort, params);
    return {
      name,
      protocolType: 'SHADOWSOCKS',
      serverHost,
      serverPort,
      params,
      rawConfig: uriRest('ss', rest),
      fingerprint,
      tags: this.extractTags(name)
    };
  }

  private parseHysteria2Uri(rest: string): ParsedUpstreamNode | null {
    const [mainPart, rawName] = rest.split('#');
    const name = rawName ? decodeURIComponent(rawName) : 'Hysteria 2 节点';
    const [credAndHost, queryPart] = mainPart.split('?');
    const atIndex = credAndHost.lastIndexOf('@');
    if (atIndex < 0) return null;

    const password = decodeURIComponent(credAndHost.slice(0, atIndex));
    const hostPort = credAndHost.slice(atIndex + 1);
    const [serverHost, rawPort] = hostPort.split(':');
    const serverPort = Number(rawPort);
    if (!serverHost || !serverPort) return null;

    const query = new URLSearchParams(queryPart || '');
    const tls: Record<string, unknown> = { enabled: true };
    if (query.get('sni')) tls.serverName = query.get('sni');
    if (query.get('insecure') === '1') tls.insecure = true;

    const params: Record<string, unknown> = { password, tls };
    if (query.get('obfs')) params.obfs = query.get('obfs');
    if (query.get('obfs-password')) params.obfsPassword = query.get('obfs-password');

    const fingerprint = this.computeFingerprint('HYSTERIA2', serverHost, serverPort, params);
    return {
      name,
      protocolType: 'HYSTERIA2',
      serverHost,
      serverPort,
      params,
      rawConfig: uriRest('hysteria2', rest),
      fingerprint,
      tags: this.extractTags(name)
    };
  }

  private parseTuicUri(rest: string): ParsedUpstreamNode | null {
    const [mainPart, rawName] = rest.split('#');
    const name = rawName ? decodeURIComponent(rawName) : 'TUIC 节点';
    const [credAndHost, queryPart] = mainPart.split('?');
    const atIndex = credAndHost.lastIndexOf('@');
    if (atIndex < 0) return null;

    const cred = credAndHost.slice(0, atIndex);
    const [uuid, password] = cred.split(':');
    const hostPort = credAndHost.slice(atIndex + 1);
    const [serverHost, rawPort] = hostPort.split(':');
    const serverPort = Number(rawPort);
    if (!serverHost || !serverPort) return null;

    const query = new URLSearchParams(queryPart || '');
    const tls: Record<string, unknown> = { enabled: true };
    if (query.get('sni')) tls.serverName = query.get('sni');
    if (query.get('allow_insecure') === '1') tls.insecure = true;

    const params: Record<string, unknown> = {
      uuid: uuid || '',
      password: password || '',
      tls,
      congestionControl: query.get('congestion_control') || 'bbr'
    };

    const fingerprint = this.computeFingerprint('TUIC', serverHost, serverPort, params);
    return {
      name,
      protocolType: 'TUIC',
      serverHost,
      serverPort,
      params,
      rawConfig: uriRest('tuic', rest),
      fingerprint,
      tags: this.extractTags(name)
    };
  }

  private parseCommonProxyUri(protocolType: string, rest: string): ParsedUpstreamNode | null {
    const [mainPart, rawName] = rest.split('#');
    const name = rawName ? decodeURIComponent(rawName) : `${protocolType} 节点`;
    let username = '';
    let password = '';
    let serverHost = '';
    let serverPort = 0;

    if (mainPart.includes('@')) {
      const atIndex = mainPart.lastIndexOf('@');
      const cred = mainPart.slice(0, atIndex);
      const hostPort = mainPart.slice(atIndex + 1);
      const [u, p] = cred.split(':');
      username = decodeURIComponent(u || '');
      password = decodeURIComponent(p || '');
      const [h, portStr] = hostPort.split(':');
      serverHost = h;
      serverPort = Number(portStr);
    } else {
      const [h, portStr] = mainPart.split(':');
      serverHost = h;
      serverPort = Number(portStr);
    }

    if (!serverHost || !serverPort) return null;
    const params: Record<string, unknown> = {};
    if (username) params.username = username;
    if (password) params.password = password;

    const fingerprint = this.computeFingerprint(protocolType, serverHost, serverPort, params);
    return {
      name,
      protocolType,
      serverHost,
      serverPort,
      params,
      rawConfig: uriRest(protocolType.toLowerCase(), rest),
      fingerprint,
      tags: this.extractTags(name)
    };
  }

  // ==============================
  // 工具函数
  // ==============================

  /**
   * 计算节点特征唯一指纹 (Fingerprint)
   */
  computeFingerprint(
    protocolType: string,
    serverHost: string,
    serverPort: number,
    params: Record<string, unknown>
  ): string {
    const keyParts = [
      protocolType.toUpperCase(),
      serverHost.toLowerCase().trim(),
      String(serverPort),
      params.uuid || '',
      params.password || '',
      params.method || '',
      params.username || '',
      (params.tls as Record<string, unknown>)?.serverName || ''
    ];
    return createHash('sha256').update(keyParts.join('|')).digest('hex').slice(0, 16);
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

function uriRest(scheme: string, rest: string): string {
  return `${scheme}://${rest}`;
}
