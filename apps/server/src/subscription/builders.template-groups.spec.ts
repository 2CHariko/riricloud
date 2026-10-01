import { buildClashYaml, buildSingboxJson, type SubLine, type SubUser } from './builders';
import { parse } from 'yaml';

describe('builders template proxy-groups resolution', () => {
  const user: SubUser = { uuid: 'a77cf184-4b56-41ee-962c-1357184acd77', email: 'user@example.com', credential: 'user-pass' };
  const mockNodes: SubLine[] = [
    {
      id: 'line-hk',
      name: '香港直连',
      type: 'DIRECT',
      protocolType: 'VLESS',
      serverHost: 'hk.example.com',
      serverPort: 443,
      params: { flow: '', transport: { type: 'tcp' }, tls: { enabled: false } }
    },
    {
      id: 'line-us',
      name: '美国直连',
      type: 'DIRECT',
      protocolType: 'VLESS',
      serverHost: 'us.example.com',
      serverPort: 443,
      params: { flow: '', transport: { type: 'tcp' }, tls: { enabled: false } }
    }
  ];

  it('Clash 输出中保留 DIRECT/REJECT 与策略组引用，不再被强制抹除为节点列表', () => {
    const template = {
      proxyGroupsJson: JSON.stringify([
        {
          name: '🚀 节点选择',
          type: 'select',
          proxies: ['all', '🔯 故障转移', 'DIRECT']
        },
        {
          name: '🔯 故障转移',
          type: 'fallback',
          url: 'http://www.gstatic.com/generate_204',
          interval: 180,
          proxies: 'all'
        },
        {
          name: '🎯 全球直连',
          type: 'select',
          proxies: ['DIRECT', '🚀 节点选择']
        },
        {
          name: '🛑 广告拦截',
          type: 'select',
          proxies: ['REJECT', 'DIRECT']
        },
        {
          name: 'Google AI',
          type: 'select',
          proxies: ['🚀 节点选择', 'DIRECT', 'all']
        }
      ]),
      ruleSetsJson: '[]',
      dnsConfigJson: '{}'
    };

    const yamlStr = buildClashYaml(user, mockNodes, template);
    const config = parse(yamlStr) as { 'proxy-groups': Array<{ name: string; proxies: string[] }> };
    const groups = new Map(config['proxy-groups'].map((g) => [g.name, g.proxies]));

    // 1. 🚀 节点选择 包含节点 + 故障转移 + DIRECT
    expect(groups.get('🚀 节点选择')).toEqual(['香港直连', '美国直连', '🔯 故障转移', 'DIRECT']);

    // 2. 🔯 故障转移 包含全节点
    expect(groups.get('🔯 故障转移')).toEqual(['香港直连', '美国直连']);

    // 3. 🎯 全球直连 保持纯直连与主策略组，绝不塞入代理节点
    expect(groups.get('🎯 全球直连')).toEqual(['DIRECT', '🚀 节点选择']);

    // 4. 🛑 广告拦截 保持 REJECT 与 DIRECT，绝不塞入代理节点
    expect(groups.get('🛑 广告拦截')).toEqual(['REJECT', 'DIRECT']);

    // 5. Google AI 包含控制项和展开的节点
    expect(groups.get('Google AI')).toEqual(['🚀 节点选择', 'DIRECT', '香港直连', '美国直连']);
  });

  it('Sing-box 输出中将 DIRECT/REJECT 分别转为 direct/block，并正确映射策略组 tag', () => {
    const template = {
      proxyGroupsJson: JSON.stringify([
        {
          name: '🚀 节点选择',
          type: 'select',
          proxies: ['all']
        },
        {
          name: '🎯 全球直连',
          type: 'select',
          proxies: ['DIRECT', '🚀 节点选择']
        },
        {
          name: '🛑 广告拦截',
          type: 'select',
          proxies: ['REJECT', 'DIRECT']
        }
      ]),
      ruleSetsJson: '[]',
      dnsConfigJson: '{}'
    };

    const jsonStr = buildSingboxJson(user, mockNodes, template);
    const config = JSON.parse(jsonStr) as { outbounds: Array<{ tag: string; outbounds?: string[] }> };
    const strategyOutbounds = new Map(
      config.outbounds.filter((o) => Array.isArray(o.outbounds)).map((o) => [o.tag, o.outbounds!])
    );

    expect(strategyOutbounds.get('🚀 节点选择')).toEqual(['香港直连', '美国直连']);
    expect(strategyOutbounds.get('🎯 全球直连')).toEqual(['direct', '🚀 节点选择']);
    expect(strategyOutbounds.get('🛑 广告拦截')).toEqual(['block', 'direct']);
  });

  it('将旧式 DNS 配置编译为 Sing-box 1.12+ servers/rules/fakeip 结构', () => {
    const config = JSON.parse(buildSingboxJson(user, mockNodes, {
      proxyGroupsJson: JSON.stringify([{ name: '节点选择', type: 'select', proxies: 'all' }]),
      ruleSetsJson: JSON.stringify([{ name: '中国站点', type: 'geosite', rules: ['cn'], target: 'DIRECT' }]),
      dnsConfigJson: JSON.stringify({ enable: true, 'enhanced-mode': 'fake-ip', nameserver: ['223.5.5.5', 'https://1.1.1.1/dns-query'], fallback: ['https://8.8.8.8/dns-query'], ipv6: false })
    })) as { dns: Record<string, unknown>; route: Record<string, unknown> };

    expect(config.dns).toEqual(expect.objectContaining({
      servers: expect.arrayContaining([
        expect.objectContaining({ tag: 'dns_direct', type: 'udp', server: '223.5.5.5', detour: 'direct' }),
        expect.objectContaining({ tag: 'dns_proxy', type: 'https', server: '8.8.8.8', detour: '节点选择' }),
        expect.objectContaining({ tag: 'dns_fakeip', type: 'fakeip', inet4_range: '198.18.0.0/15' })
      ]),
      strategy: 'ipv4_only'
    }));
    expect(config.dns).not.toHaveProperty('fakeip');
    expect(config.dns).not.toHaveProperty('independent_cache');
    expect(config.dns).not.toHaveProperty('enhanced-mode');
    expect(config.route.default_domain_resolver).toBe('dns_direct');
    expect(config.route.rule_set).toEqual(expect.arrayContaining([expect.objectContaining({ tag: 'geosite-cn', type: 'remote', format: 'binary' })]));
    expect(config.route.rules).toEqual(expect.arrayContaining([expect.objectContaining({ rule_set: ['geosite-cn'], outbound: 'direct' })]));
  });

  it('为 Clash 远程规则集生成 rule-providers 和 RULE-SET 引用', () => {
    const config = parse(buildClashYaml(user, mockNodes, {
      proxyGroupsJson: JSON.stringify([{ name: '节点选择', type: 'select', proxies: 'all' }]),
      ruleSetsJson: JSON.stringify([{ name: 'ads-remote', type: 'remote-rule-set', url: 'https://rules.example/ad.yaml', singboxUrl: 'https://rules.example/ad.srs', target: 'REJECT' }]),
      dnsConfigJson: '{}'
    })) as Record<string, unknown>;
    const providers = config['rule-providers'] as Record<string, Record<string, unknown>>;
    expect(providers).toEqual(expect.objectContaining({
      'ads-remote': expect.objectContaining({ type: 'http', behavior: 'classical', path: './ruleset/ads-remote.yaml', url: 'https://rules.example/ad.yaml', interval: 86400 })
    }));
    expect(config.rules).toContain('RULE-SET,ads-remote,REJECT');
  });

  it('按线路标签、协议和倍率执行 AND 过滤，并保留 fallback/load-balance 类型', () => {
    const nodes: SubLine[] = [
      { ...mockNodes[0], id: 'vip-vless', name: 'VIP 香港', protocolType: 'VLESS', tags: ['vip', 'gaming'], trafficRate: 1 },
      { ...mockNodes[1], id: 'economy-hy2', name: '经济 日本', protocolType: 'HYSTERIA2', params: {}, tags: ['economy'], trafficRate: 0.5 },
      { ...mockNodes[1], id: 'premium-hy2', name: '高级 美国', protocolType: 'HYSTERIA2', params: {}, tags: ['premium'], trafficRate: 2 }
    ];
    const config = parse(buildClashYaml(user, nodes, {
      proxyGroupsJson: JSON.stringify([
        { name: 'VIP VLESS', type: 'fallback', includeTags: ['vip'], protocols: ['VLESS'], maxRate: 1, proxies: 'all' },
        { name: '经济 UDP', type: 'load-balance', includeTags: ['economy'], protocols: ['HYSTERIA2'], maxRate: 1, proxies: 'all' }
      ]),
      ruleSetsJson: '[]',
      dnsConfigJson: '{}'
    })) as { 'proxy-groups': Array<{ name: string; type: string; proxies: string[] }> };
    const groups = new Map(config['proxy-groups'].map((group) => [group.name, group]));
    expect(groups.get('VIP VLESS')).toEqual(expect.objectContaining({ type: 'fallback', proxies: ['VIP 香港'] }));
    expect(groups.get('经济 UDP')).toEqual(expect.objectContaining({ type: 'load-balance', proxies: ['经济 日本 [0.5x]'] }));
  });

  it('将 Sing-box fallback/load-balance 映射为可探测的 urltest 出站', () => {
    const config = JSON.parse(buildSingboxJson(user, mockNodes, {
      proxyGroupsJson: JSON.stringify([
        { name: '故障转移', type: 'fallback', proxies: 'all' },
        { name: '负载均衡', type: 'load-balance', proxies: 'all', tolerance: 80 }
      ]),
      ruleSetsJson: '[]',
      dnsConfigJson: '{}'
    })) as { outbounds: Array<Record<string, unknown>> };
    expect(config.outbounds).toEqual(expect.arrayContaining([
      expect.objectContaining({ tag: '故障转移', type: 'urltest', interruptible: true }),
      expect.objectContaining({ tag: '负载均衡', type: 'urltest', tolerance: 80 })
    ]));
  });

  it('正确解析 geoip, process-name, rule-set 别名并净化 ,no-resolve 目标出站名', () => {
    const template = {
      proxyGroupsJson: JSON.stringify([
        { name: '🚀 节点选择', type: 'select', proxies: 'all' },
        { name: '🎯 全球直连', type: 'select', proxies: ['DIRECT'] },
        { name: '🛑 广告拦截', type: 'select', proxies: ['REJECT'] }
      ]),
      ruleSetsJson: JSON.stringify([
        { name: 'RemoteAds', type: 'rule-set', url: 'https://rules.example/ads.yaml', singboxUrl: 'https://rules.example/ads.srs', target: '🛑 广告拦截' },
        { name: 'BilibiliProcess', type: 'process-name', rules: ['tv.danmaku.bili'], target: '🚀 节点选择' },
        { name: 'TencentIP', type: 'ip-cidr', rules: ['182.254.116.0/24'], target: '🎯 全球直连,no-resolve' },
        { name: 'ChinaIP', type: 'geoip', rules: ['CN'], target: '🎯 全球直连,no-resolve' },
        { name: 'FinalMatch', type: 'match', target: '🚀 节点选择' }
      ]),
      dnsConfigJson: '{}'
    };

    // 1. Clash 验证
    const clashYaml = buildClashYaml(user, mockNodes, template);
    const clashConfig = parse(clashYaml) as { rules: string[]; 'rule-providers': Record<string, Record<string, unknown>> };
    expect(clashConfig['rule-providers']).toHaveProperty('remoteads');
    expect(clashConfig.rules).toContain('RULE-SET,remoteads,🛑 广告拦截');
    expect(clashConfig.rules).toContain('PROCESS-NAME,tv.danmaku.bili,🚀 节点选择');
    expect(clashConfig.rules).toContain('IP-CIDR,182.254.116.0/24,🎯 全球直连,no-resolve');
    expect(clashConfig.rules).toContain('GEOIP,CN,🎯 全球直连');
    expect(clashConfig.rules).toContain('MATCH,🚀 节点选择');

    // 2. Sing-box 验证
    const singboxJson = buildSingboxJson(user, mockNodes, template);
    const singboxConfig = JSON.parse(singboxJson) as {
      route: {
        rule_set?: Array<{ tag: string; url: string }>;
        rules: Array<Record<string, unknown>>;
      };
    };
    expect(singboxConfig.route.rule_set).toEqual(expect.arrayContaining([
      expect.objectContaining({ tag: 'remoteads', url: 'https://rules.example/ads.srs' }),
      expect.objectContaining({ tag: 'geoip-cn' })
    ]));
    // 目标出站名必须被清洗为 direct，绝不能带上 ,no-resolve
    expect(singboxConfig.route.rules).toEqual(expect.arrayContaining([
      expect.objectContaining({ rule_set: ['remoteads'], outbound: '🛑 广告拦截' }),
      expect.objectContaining({ process_name: ['tv.danmaku.bili'], outbound: '🚀 节点选择' }),
      expect.objectContaining({ ip_cidr: ['182.254.116.0/24'], outbound: '🎯 全球直连' }),
      expect.objectContaining({ rule_set: ['geoip-cn'], outbound: '🎯 全球直连' }),
      expect.objectContaining({ action: 'route', outbound: '🚀 节点选择' })
    ]));
  });
});
