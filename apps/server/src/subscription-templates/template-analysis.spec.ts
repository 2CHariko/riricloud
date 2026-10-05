import { analyzeTemplate, parseValidationPolicy, repairTemplate } from './template-analysis';
import { analyzeCompiled } from './compiled-analysis';
import { buildClashYaml } from '../subscription/builders';

describe('模板机械诊断', () => {
  it('重现关键词遮挡后置直连，保留规则意图', () => {
    const template = { ruleSets: [
      { type: 'domain-keyword', rules: ['domob'], target: 'REJECT' },
      { type: 'domain', rules: ['koodomobile.com'], target: 'DIRECT' }
    ] };
    const result = analyzeTemplate(template);
    expect(result.diagnostics).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'shadow', location: 'ruleSets[1].rules[0]', related: 'ruleSets[0].rules[0]' })]));
    expect(repairTemplate(template).template).toEqual(template);
  });

  it('修复只去除块内完全重复条目并规范等价别名，幂等且不改原对象', () => {
    const template = { ruleSets: [{ type: 'domain_suffix', target: 'DIRECT', rules: ['a.test', 'a.test', 'b.test'] }] };
    const repaired = repairTemplate(template);
    expect(repaired.template.ruleSets).toEqual([{ type: 'domain-suffix', target: 'DIRECT', rules: ['a.test', 'b.test'] }]);
    expect(template.ruleSets[0].rules).toHaveLength(3);
    expect(repairTemplate(repaired.template).changes).toEqual([]);
  });

  it('关闭检查、域名例外和修复策略可分别配置', () => {
    const template = { ruleSets: [{ type: 'domain', target: 'DIRECT', rules: ['a.test', 'a.test'] }] };
    const policy = { checks: { duplicate: 'off' }, fixes: { deduplicate: false, aliases: false } };
    expect(analyzeTemplate(template, policy).diagnostics).toEqual([]);
    expect(repairTemplate(template, policy).changes).toEqual([]);
  });

  it('诊断截断不掩盖错误总数', () => {
    const result = analyzeTemplate({ proxyGroups: [{ name: 'a', proxies: ['a'] }, { name: 'a', proxies: ['a'] }] }, { maxDiagnostics: 1 });
    expect(result.diagnostics).toHaveLength(1);
    expect(result.counts.error).toBeGreaterThan(1);
    expect(result.truncated).toBeGreaterThan(0);
  });

  it('拒绝未知策略键与非法资源预算', () => {
    expect(() => parseValidationPolicy({ checks: { typo: 'off' } })).toThrow();
    expect(() => parseValidationPolicy({ maxDiagnostics: -1 })).toThrow();
  });

  it('覆盖证据始终指向最早规则，而非更靠后的精确规则', () => {
    const result = analyzeTemplate({ ruleSets: [
      { type: 'domain-keyword', rules: ['test'], target: 'REJECT' },
      { type: 'domain', rules: ['a.test'], target: 'DIRECT' },
      { type: 'domain', rules: ['a.test'], target: 'DIRECT' }
    ] });
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: 'shadow', location: 'ruleSets[2].rules[0]', related: 'ruleSets[0].rules[0]' }));
  });

  it('精确域名不能证明整个后缀不可达，例外不修改实际规则', () => {
    const draft = { ruleSets: [
      { type: 'domain', rules: ['a.test'], target: 'REJECT' },
      { type: 'domain-suffix', rules: ['a.test'], target: 'DIRECT' }
    ] };
    expect(analyzeTemplate(draft).diagnostics.some((d) => d.code === 'shadow')).toBe(false);
    const covered = { ruleSets: [{ type: 'domain-suffix', rules: ['test'], target: 'REJECT' }, ...draft.ruleSets] };
    expect(analyzeTemplate(covered, { ignoredDomains: ['a.test'] }).diagnostics.some((d) => d.code === 'shadow')).toBe(false);
    expect(repairTemplate(covered, { ignoredDomains: ['a.test'] }).template).toEqual(covered);
  });

  it('按真实生成器识别 DNS 数组清空和空对象保留', () => {
    const draft = { dnsConfig: { enable: true, directDns: ['223.5.5.5'], proxyDns: ['https://1.1.1.1/dns-query'] }, customInjectYaml: 'dns:\n  fallback: []\n  fallback-filter: {}' };
    const content = buildClashYaml({ uuid: 'test', credential: 'test' }, [], { dnsConfigJson: JSON.stringify(draft.dnsConfig), customInjectYaml: draft.customInjectYaml });
    const result = analyzeCompiled(draft, 'clash', content);
    expect(result.diagnostics.map((d) => d.reason)).toEqual(expect.arrayContaining(['emptyFallback', 'emptyObject']));
  });

  it('最终覆写的规则和丢失目标独立检查，未知逻辑明确限制', () => {
    const content = 'proxy-groups: []\nrules:\n - DOMAIN-SUFFIX,test,REJECT\n - DOMAIN,a.test,missing\n - AND,((NETWORK,udp)),DIRECT';
    const result = analyzeCompiled({ customInjectYaml: content }, 'clash', content);
    expect(result.diagnostics.map((d) => d.reason)).toEqual(expect.arrayContaining(['missingTarget', 'rulesReplaced', 'shadow', 'conditional']));
  });

  it('拒绝会被生成器静默解释的未知规则类型', () => {
    expect(() => analyzeTemplate({ ruleSets: [{ type: 'typo', rules: ['a.test'] }] })).toThrow();
    expect(() => repairTemplate({ ruleSets: [{ type: 'geo_ip', rules: ['CN'] }] })).toThrow();
  });

  it('检查复杂覆写策略组时有资源上限', () => {
    const groups = Array.from({ length: 501 }, (_, i) => ({ name: `g${i}`, proxies: [`g${i + 1}`] }));
    const result = analyzeCompiled({}, 'clash', JSON.stringify({ 'proxy-groups': groups }));
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ reason: 'budget' }));
  });
});
