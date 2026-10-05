import { BadRequestException } from '@nestjs/common';
import { CHECKS, parseValidationPolicy, record, type Check, type Level } from './validation-policy';
export { parseValidationPolicy } from './validation-policy';

export interface AnalysisDraft {
  proxyGroups?: unknown[];
  ruleSets?: unknown[];
  dnsConfig?: Record<string, unknown>;
  customInjectYaml?: string | null;
  customInjectJson?: string | null;
  validationConfig?: Record<string, unknown>;
}
export interface Diagnostic {
  code: Check;
  reason: string;
  severity: Exclude<Level, 'off'>;
  location: string;
  related?: string;
  value?: string;
  target?: string;
  previousTarget?: string;
}
export interface FlatRule { type: string; value: string; target: string; location: string }
export const canonicalType = (value: string): string => {
  const raw = value.trim().toLowerCase();
  return ({ 'ip-cidr6': 'ip-cidr', ip_cidr6: 'ip-cidr', ip_cidr: 'ip-cidr', 'geo-ip': 'geoip',
    'rule-set': 'remote-rule-set', rule_set: 'remote-rule-set', remote_rule_set: 'remote-rule-set',
    domain_suffix: 'domain-suffix', domain_keyword: 'domain-keyword', process_name: 'process-name', final: 'match'
  } as Record<string, string>)[raw] ?? raw;
};
const RULE_TYPES = ['domain', 'domain-suffix', 'domain-keyword', 'ip-cidr', 'geosite', 'geoip', 'process-name', 'remote-rule-set', 'match'];

// 不把未知类型交给编译器默认为域名后缀，避免合法输出掩盖输入错误。
export function assertDraft(value: unknown): asserts value is AnalysisDraft {
  if (!record(value)) throw new BadRequestException('Invalid template object');
  for (const key of ['proxyGroups', 'ruleSets'] as const) {
    if (value[key] !== undefined && (!Array.isArray(value[key]) || value[key].length > (key === 'proxyGroups' ? 500 : 10000))) throw new BadRequestException(`Invalid ${key}`);
  }
  let entries = 0;
  for (const [index, rule] of ((value.ruleSets ?? []) as unknown[]).entries()) {
    if (!record(rule) || (rule.type !== undefined && (typeof rule.type !== 'string' || !RULE_TYPES.includes(canonicalType(rule.type)))) || (rule.target !== undefined && typeof rule.target !== 'string') || (rule.enabled !== undefined && typeof rule.enabled !== 'boolean') || (rule.rules !== undefined && (!Array.isArray(rule.rules) || rule.rules.some((v) => typeof v !== 'string' || v.length > 1024)))) throw new BadRequestException(`Invalid ruleSets[${index}]`);
    entries += Array.isArray(rule.rules) ? rule.rules.length : 0;
  }
  if (entries > 50000) throw new BadRequestException('Template rule limit exceeded');
  for (const group of (value.proxyGroups ?? []) as unknown[]) {
    if (!record(group) || typeof group.name !== 'string' || !group.name.trim() || group.name.length > 256 || (group.proxies !== undefined && group.proxies !== 'all' && (!Array.isArray(group.proxies) || group.proxies.length > 10000 || group.proxies.some((v) => typeof v !== 'string')))) throw new BadRequestException('Invalid proxy group');
  }
  if (value.dnsConfig !== undefined && !record(value.dnsConfig)) throw new BadRequestException('Invalid dnsConfig');
  for (const key of ['customInjectYaml', 'customInjectJson']) if (value[key] != null && (typeof value[key] !== 'string' || (value[key] as string).length > 2000000)) throw new BadRequestException(`Invalid ${key}`);
  parseValidationPolicy(value.validationConfig);
}

export function flattenRules(template: AnalysisDraft): FlatRule[] {
  return (template.ruleSets ?? []).flatMap((raw, i) => {
    if (!record(raw) || raw.enabled === false) return [];
    const type = canonicalType(typeof raw.type === 'string' ? raw.type : 'domain-suffix');
    const target = typeof raw.target === 'string' ? raw.target.split(',')[0].trim() : '';
    if (type === 'match') return [{ type, value: '', target, location: `ruleSets[${i}]` }];
    return (Array.isArray(raw.rules) ? raw.rules : []).filter((v): v is string => typeof v === 'string').map((value, j) => ({ type, value, target, location: `ruleSets[${i}].rules[${j}]` }));
  });
}

export function createReporter(rawPolicy: unknown) {
  const policy = parseValidationPolicy(rawPolicy);
  const diagnostics: Diagnostic[] = [];
  const counts = { error: 0, warning: 0, info: 0 };
  let truncated = 0;
  const emit = (code: Check, reason: string, location: string, extra: Partial<Diagnostic> = {}) => {
    const severity = policy.checks[code];
    if (severity === 'off' || (extra.value && policy.ignoredDomains.includes(extra.value.toLowerCase()) && ['shadow', 'broadKeyword'].includes(code))) return;
    counts[severity]++;
    if (diagnostics.length >= policy.maxDiagnostics) { truncated++; return; }
    diagnostics.push({ ...extra, code, reason, severity, location });
  };
  return { policy, emit, result: () => ({ diagnostics, counts, truncated, enabledChecks: CHECKS.filter((key) => policy.checks[key] !== 'off') }) };
}
export type Reporter = ReturnType<typeof createReporter>;

export function inspectRules(rules: FlatRule[], reporter: Reporter) {
  if (rules.length > 50000) { reporter.emit('coverage', 'budget', 'effective.rules'); rules = rules.slice(0, 50000); }
  const order = new Map(rules.map((rule, index) => [rule, index]));
  const exact = new Map<string, FlatRule>();
  const suffix = new Map<string, FlatRule>();
  const seen = new Map<string, FlatRule>();
  const keywords: FlatRule[] = [];
  let catchAll: FlatRule | undefined;
  let comparisons = 0;
  let limited = false;
  for (const rule of rules) {
    const { type, value, target, location } = rule;
    if (catchAll) reporter.emit('catchAll', 'unreachable', location, { related: catchAll.location });
    if (type === 'match') { catchAll ??= rule; continue; }
    const identity = JSON.stringify([type, value, target]);
    const previous = seen.get(identity);
    if (previous) reporter.emit('duplicate', 'duplicate', location, { related: previous.location, value });
    else seen.set(identity, rule);
    if (type === 'domain' || type === 'domain-suffix') {
      const domain = value.toLowerCase();
      // 后缀只能覆盖子域名；精确规则不能证明覆盖整个后缀集合。
      let first = type === 'domain' ? exact.get(domain) : undefined;
      const labels = domain.split('.');
      const earlier = (candidate: FlatRule | undefined) => {
        if (candidate && (!first || order.get(candidate)! < order.get(first)!)) first = candidate;
      };
      for (let i = 0; i < labels.length; i++) earlier(suffix.get(labels.slice(i).join('.')));
      if (!limited) {
        for (const keyword of keywords) {
          if (++comparisons > 2000000) { limited = true; reporter.emit('coverage', 'budget', location); break; }
          if (domain.includes(keyword.value.toLowerCase())) { earlier(keyword); break; }
        }
      }
      if (first && first.target !== target) reporter.emit('shadow', 'shadow', location, { value, target, previousTarget: first.target, related: first.location });
      if (type === 'domain' && !exact.has(domain)) exact.set(domain, rule);
      if (type === 'domain-suffix' && !suffix.has(domain)) suffix.set(domain, rule);
    }
    if (type === 'domain-keyword') {
      if (value.length < reporter.policy.keywordMinLength) reporter.emit('broadKeyword', 'shortKeyword', location, { value });
      keywords.push(rule);
    }
  }
}

export function inspectGroups(groups: Array<Record<string, unknown>>, reporter: Reporter, names?: Set<string>, field = 'proxyGroups', memberKey = 'proxies') {
  if (groups.length > 500) { reporter.emit('coverage', 'budget', field); groups = groups.slice(0, 500); }
  const map = new Map<string, { members: string[]; location: string }>();
  groups.forEach((g, i) => {
    const name = String(g.name ?? g.tag ?? '');
    const location = `${field}[${i}]`;
    if (map.has(name)) reporter.emit('groups', 'duplicateGroup', location, { related: map.get(name)?.location, value: name });
    const members = Array.isArray(g[memberKey]) ? (g[memberKey] as unknown[]).filter((v): v is string => typeof v === 'string') : [];
    map.set(name, { members, location });
    if (names) for (const member of members) if (!names.has(member)) reporter.emit('groups', 'missingTarget', location, { value: member });
    if (typeof g.interval === 'number' && g.interval > reporter.policy.maxTestInterval) reporter.emit('healthCheck', 'longInterval', location);
    if (typeof g.url === 'string' && g.url.startsWith('http://')) reporter.emit('healthCheck', 'httpTest', location);
  });
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (name: string) => {
    if (visiting.has(name)) { reporter.emit('groups', 'cycle', map.get(name)!.location, { value: name }); return; }
    if (visited.has(name)) return;
    visiting.add(name);
    for (const member of map.get(name)?.members ?? []) if (map.has(member)) visit(member);
    visiting.delete(name); visited.add(name);
  };
  for (const name of map.keys()) visit(name);
}

export function analyzeTemplate(template: AnalysisDraft, rawPolicy: unknown = template.validationConfig) {
  assertDraft(template);
  const reporter = createReporter(rawPolicy);
  inspectRules(flattenRules(template), reporter);
  inspectGroups((template.proxyGroups ?? []).filter(record), reporter);
  for (const [i, raw] of (template.ruleSets ?? []).entries()) {
    if (record(raw) && raw.enabled !== false && ['remote-rule-set', 'geoip', 'geosite', 'process-name', 'ip-cidr'].includes(canonicalType(String(raw.type)))) reporter.emit('coverage', 'conditional', `ruleSets[${i}]`);
  }
  return reporter.result();
}

export function repairTemplate<T extends AnalysisDraft>(template: T, rawPolicy: unknown = template.validationConfig) {
  assertDraft(template);
  const policy = parseValidationPolicy(rawPolicy);
  const next = structuredClone(template);
  const changes: Array<{ location: string; before: unknown; after: unknown }> = [];
  for (const [i, raw] of (next.ruleSets ?? []).entries()) {
    if (!record(raw)) continue;
    if (policy.fixes.aliases && typeof raw.type === 'string' && canonicalType(raw.type) !== raw.type) {
      changes.push({ location: `ruleSets[${i}].type`, before: raw.type, after: canonicalType(raw.type) });
      raw.type = canonicalType(raw.type);
    }
    if (policy.fixes.deduplicate && Array.isArray(raw.rules)) {
      const unique = [...new Set(raw.rules)];
      if (unique.length !== raw.rules.length) {
        changes.push({ location: `ruleSets[${i}].rules`, before: raw.rules, after: unique });
        raw.rules = unique;
      }
    }
  }
  return { template: next, changes };
}
