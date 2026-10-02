import { proxyObject } from '../common/proxy-connection';
import type { KernelResourceRequirement, ProbeEngine } from '../probe/probe.types';

export interface ConfigResource {
  requirement: KernelResourceRequirement;
  // 文件名仅用于内部解析；绝不放进 API、日志或错误文本。
  file?: string;
  format?: string;
}
const array = (value: unknown): unknown[] => Array.isArray(value) ? value : [];

export function analyzeConfigResources(engine: ProbeEngine, config: Record<string, unknown>): ConfigResource[] {
  const entries = new Map<string, ConfigResource>();
  const add = (kind: KernelResourceRequirement['kind'], location: string, file?: string, state: KernelResourceRequirement['state'] = 'MISSING', format?: string) => {
    const key = file ? `${kind}:${file}:${format ?? ''}` : `${kind}:${location}`;
    const existing = entries.get(key);
    if (existing) { existing.requirement.references++; return; }
    entries.set(key, { file, format, requirement: { kind, location, state, references: 1,
      reasonCode: state === 'MISSING' ? 'RESOURCE_MISSING' : state === 'REMOTE_DISABLED' ? 'REMOTE_RESOURCE_DISABLED' : 'RESOURCE_UNSUPPORTED',
      actionCode: state === 'MISSING' ? 'PREPARE_RESOURCE' : 'CHECK_CLIENT' } });
  };
  if (engine === 'MIHOMO') {
    const geo = (kind: 'GEOIP' | 'GEOSITE', location: string, asn = false) => add(kind, location,
      asn ? 'ASN.mmdb' : kind === 'GEOSITE' ? 'geosite.dat' : config['geodata-mode'] === true ? 'geoip.dat' : 'Country.mmdb');
    const providers = proxyObject(config['rule-providers']);
    const scanRule = (rule: unknown, location: string) => {
      if (typeof rule !== 'string') return;
      // 逻辑规则的每个子表达式同样参与分析，不把目标策略名当作依赖。
      for (const match of rule.matchAll(/(?:^|\()\s*(GEOIP|GEOSITE|IP-ASN|SRC-GEOIP|SRC-IP-ASN|RULE-SET)\s*,\s*([^,()]+)/gi)) {
        const type = match[1].toUpperCase(); const value = match[2].trim();
        if (type === 'RULE-SET') {
          if (!Object.hasOwn(providers, value)) add('RULE_PROVIDER', location, undefined, 'UNSUPPORTED');
        } else if (type === 'GEOSITE') geo('GEOSITE', location);
        else if (!type.endsWith('GEOIP') || value.toLowerCase() !== 'private') geo('GEOIP', location, type.endsWith('ASN'));
      }
    };
    array(config.rules).forEach((rule, i) => scanRule(rule, `rules[${i}]`));
    Object.values(proxyObject(config['sub-rules'])).forEach((rules, i) => array(rules).forEach((rule, j) => scanRule(rule, `sub-rules[${i}][${j}]`)));
    Object.values(providers).forEach((value, i) => {
      const provider = proxyObject(value); const location = `rule-providers[${i}]`;
      if (provider.type === 'inline') {
        if (provider.behavior === 'classical') array(provider.payload).forEach((rule, j) => scanRule(rule, `${location}.payload[${j}]`));
      } else if (provider.type === 'file' && ['domain', 'ipcidr'].includes(String(provider.behavior)) && ['yaml', 'text', undefined].includes(provider.format as string | undefined) && typeof provider.path === 'string') {
        add('RULE_PROVIDER', location, provider.path, 'MISSING', `mihomo-${provider.format ?? 'yaml'}-${provider.behavior}`);
      } else add('RULE_PROVIDER', location, undefined, provider.type === 'http' ? 'REMOTE_DISABLED' : 'UNSUPPORTED');
    });
    Object.values(proxyObject(config['proxy-providers'])).forEach((_, i) => add('PROXY_PROVIDER', `proxy-providers[${i}]`, undefined, 'UNSUPPORTED'));
    const dns = proxyObject(config.dns);
    const filter = proxyObject(dns['fallback-filter']);
    if (array(dns.fallback).length && filter.geoip !== false) geo('GEOIP', 'dns.fallback-filter.geoip');
    if (array(dns.fallback).length && array(filter.geosite).length) geo('GEOSITE', 'dns.fallback-filter.geosite');
    for (const field of ['nameserver-policy', 'proxy-server-nameserver-policy', 'fake-ip-filter']) {
      const values = field.endsWith('policy') ? Object.keys(proxyObject(dns[field])) : array(dns[field]);
      values.forEach((value, i) => {
        if (typeof value !== 'string') return;
        if (field === 'fake-ip-filter' && dns['fake-ip-filter-mode'] === 'rule') scanRule(value, `dns.${field}[${i}]`);
        if (/^geosite:/i.test(value)) geo('GEOSITE', `dns.${field}[${i}]`);
        if (/^geoip:/i.test(value)) geo('GEOIP', `dns.${field}[${i}]`);
        if (/^rule-set:/i.test(value)) {
          for (const name of value.slice(9).split(',')) if (!Object.hasOwn(providers, name)) add('RULE_PROVIDER', `dns.${field}[${i}]`, undefined, 'UNSUPPORTED');
        }
      });
    }
    const sniffer = proxyObject(config.sniffer);
    for (const field of ['force-domain', 'skip-domain', 'skip-src-address', 'skip-dst-address']) {
      array(sniffer[field]).forEach((value, i) => {
        if (typeof value !== 'string') return;
        if (/^geosite:/i.test(value)) geo('GEOSITE', `sniffer.${field}[${i}]`);
        if (/^geoip:/i.test(value)) geo('GEOIP', `sniffer.${field}[${i}]`);
        if (/^rule-set:/i.test(value)) for (const name of value.slice(9).split(',')) {
          if (!Object.hasOwn(providers, name)) add('RULE_PROVIDER', `sniffer.${field}[${i}]`, undefined, 'UNSUPPORTED');
        }
      });
    }
    // 自定义来源不应悄悄被默认数据覆盖，更新/远程 UI 也不在离线验证边界内。
    for (const key of ['geox-url', 'external-ui-url', 'geo-auto-update']) {
      if (config[key] && (typeof config[key] !== 'object' || Object.keys(proxyObject(config[key])).length)) add('REMOTE_RESOURCE', key, undefined, 'REMOTE_DISABLED');
    }
  } else {
    array(proxyObject(config.route).rule_set).forEach((value, i) => {
      const ruleSet = proxyObject(value);
      if (ruleSet.type === 'inline') return;
      // Sing-box 的本地文件可能含二次依赖，本轮只放行可直接分析的 inline。
      add('RULE_SET', `route.rule_set[${i}]`, undefined, ruleSet.type === 'remote' ? 'REMOTE_DISABLED' : 'UNSUPPORTED');
    });
  }
  // 只扫描内核有意义的配置子树；位置里的动态键一律换成序号，防止泄露用户名/域名。
  const pathKeys = new Set(['certificate_path', 'key_path', 'certificate-path', 'private-key-path', 'ca_path', 'client_certificate_path', 'client_key_path', 'certificate', 'ca', 'ech_key_path']);
  const walk = (value: unknown, location: string, depth = 0) => {
    if (depth > 40) { add('EXTERNAL_FILE', location, undefined, 'UNSUPPORTED'); return; }
    if (Array.isArray(value)) { value.forEach((v, i) => walk(v, `${location}[${i}]`, depth + 1)); return; }
    Object.entries(proxyObject(value)).forEach(([key, v], i) => {
      if (pathKeys.has(key) && v && ((key.endsWith('_path') || key.endsWith('-path')) || (typeof v === 'string' && !v.includes('-----BEGIN ')))) add('CERTIFICATE', `${location}.fields[${i}]`, undefined, 'UNSUPPORTED');
      if (['file', 'cache_file', 'geoip', 'geosite', 'download_url', 'download-url'].includes(key) && v && !(key === 'geoip' && typeof v === 'boolean')) add('EXTERNAL_FILE', `${location}.fields[${i}]`, undefined, 'UNSUPPORTED');
      walk(v, `${location}.fields[${i}]`, depth + 1);
    });
  };
  const roots = engine === 'MIHOMO' ? ['proxies', 'listeners', 'tls', 'tun', 'hosts'] : ['inbounds', 'outbounds', 'dns', 'route', 'certificate', 'experimental', 'endpoints'];
  if (engine === 'MIHOMO') {
    const tls = proxyObject(config.tls);
    if (typeof tls['private-key'] === 'string' && tls['private-key'] && !tls['private-key'].includes('-----BEGIN ')) add('CERTIFICATE', 'tls.private-key', undefined, 'UNSUPPORTED');
    if (config['external-ui']) add('EXTERNAL_FILE', 'external-ui', undefined, 'UNSUPPORTED');
  }
  roots.forEach((key) => walk(config[key], key));
  return [...entries.values()];
}
