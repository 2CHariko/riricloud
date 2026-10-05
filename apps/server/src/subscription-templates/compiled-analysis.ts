import { parseDocument } from 'yaml';
import { analyzeTemplate, createReporter, flattenRules, inspectGroups, inspectRules, type AnalysisDraft, type FlatRule } from './template-analysis';
import { record } from './validation-policy';

export function analyzeCompiled(template: AnalysisDraft, format: 'clash' | 'singbox', content: string) {
  const source = analyzeTemplate(template);
  const reporter = createReporter(template.validationConfig);
  const config: Record<string, unknown> = format === 'clash' ? parseDocument(content).toJS() : JSON.parse(content);
  const override: Record<string, unknown> = format === 'clash'
    ? (template.customInjectYaml ? parseDocument(template.customInjectYaml).toJS() : {})
    : (template.customInjectJson ? JSON.parse(template.customInjectJson) : {});
  const clash = format === 'clash';
  const groupKey = clash ? 'proxy-groups' : 'outbounds';
  const groups = (Array.isArray(config[groupKey]) ? config[groupKey] : []).filter(record);
  const proxies = (Array.isArray(config.proxies) ? config.proxies : []).filter(record);
  const names = new Set<string>(clash ? ['DIRECT', 'REJECT', 'REJECT-DROP', 'PASS', 'COMPATIBLE', 'GLOBAL'] : []);
  for (const item of [...groups, ...proxies]) names.add(String(item.name ?? item.tag));
  inspectGroups(groups, reporter, names, `effective.${groupKey}`, clash ? 'proxies' : 'outbounds');
  // 原始引用被编译器过滤时也要报告，不能只验证过滤后的合法配置。
  for (const [i, group] of (template.proxyGroups ?? []).entries()) {
    if (!record(group) || !Array.isArray(group.proxies)) continue;
    for (const member of group.proxies) {
      if (typeof member !== 'string') continue;
      const reference = member.trim();
      if (!reference || ['all', '$all', '$nodes'].includes(reference) || ['DIRECT', 'REJECT'].includes(reference.toUpperCase())) continue;
      if (!names.has(reference)) reporter.emit('groups', 'missingTarget', `proxyGroups[${i}].proxies`, { value: reference });
    }
  }
  const compiledRules: FlatRule[] = [];
  if (clash && Array.isArray(config.rules)) {
    config.rules.forEach((raw, i) => {
      if (typeof raw !== 'string') return;
      const [type, value, target] = raw.split(',');
      // 复杂逻辑规则留给原生验证，不能用逗号拆分猜测其出站。
      if (['AND', 'OR', 'NOT', 'SUB-RULE'].includes(type)) { reporter.emit('coverage', 'conditional', `effective.rules[${i}]`); return; }
      compiledRules.push({ type: type.toLowerCase(), value: type === 'MATCH' ? '' : value, target: type === 'MATCH' ? value : target, location: `effective.rules[${i}]` });
    });
  } else if (!clash && record(config.route) && Array.isArray(config.route.rules)) {
    config.route.rules.forEach((rule, i) => {
      if (!record(rule)) return;
      if (typeof rule.outbound === 'string') compiledRules.push({ type: 'other', value: '', target: rule.outbound, location: `effective.route.rules[${i}]` });
    });
    if (Object.hasOwn(override, 'route')) reporter.emit('coverage', 'conditional', 'customInjectJson.route');
  }
  for (const rule of compiledRules) if (rule.target && !names.has(rule.target)) reporter.emit('groups', 'missingTarget', rule.location, { value: rule.target });
  if (clash && Object.hasOwn(override, 'rules')) {
    reporter.emit('coverage', 'rulesReplaced', 'customInjectYaml.rules');
    inspectRules(compiledRules, reporter);
  }
  const dns = record(config.dns) ? config.dns : {};
  const injectedDns = record(override.dns) ? override.dns : {};
  for (const key of Object.keys(injectedDns)) {
    reporter.emit('dnsOverride', 'overridden', `${clash ? 'customInjectYaml' : 'customInjectJson'}.dns.${key}`);
    if (record(injectedDns[key]) && !Object.keys(injectedDns[key]).length && record(dns[key]) && Object.keys(dns[key]).length) reporter.emit('dnsOverride', 'emptyObject', `effective.dns.${key}`);
  }
  if (clash && dns.enable !== false && Object.keys(dns).length) {
    if (Array.isArray(dns.fallback) && !dns.fallback.length) reporter.emit('dnsRouting', 'emptyFallback', 'effective.dns.fallback');
    if (dns['respect-rules'] === true && (!Array.isArray(dns['proxy-server-nameserver']) || !dns['proxy-server-nameserver'].length)) reporter.emit('dnsRouting', 'bootstrap', 'effective.dns.proxy-server-nameserver');
    if (!record(dns['nameserver-policy']) && !dns['direct-nameserver']) reporter.emit('dnsRouting', 'sharedResolvers', 'effective.dns');
  }
  const effective = reporter.result();
  const all = [...source.diagnostics, ...effective.diagnostics];
  const diagnostics = all.slice(0, reporter.policy.maxDiagnostics);
  const counts = { error: source.counts.error + effective.counts.error, warning: source.counts.warning + effective.counts.warning, info: source.counts.info + effective.counts.info };
  return {
    diagnostics, counts,
    truncated: source.truncated + effective.truncated + all.length - diagnostics.length,
    enabledChecks: source.enabledChecks,
    analyzedRules: flattenRules(template).length,
    scope: 'STATIC' as const
  };
}
