import { parse } from 'yaml';
import { buildClashYaml, buildSingboxJson, type SubLine, type SubUser } from './builders';

describe('builders with modernized template configuration', () => {
  const user: SubUser = { uuid: 'a77cf184-4b56-41ee-962c-1357184acd77', email: 'user@example.com', credential: 'user-pass' };
  const mockNodes: SubLine[] = [
    {
      id: 'line-hk',
      name: '香港直连 01',
      type: 'DIRECT',
      protocolType: 'VLESS',
      serverHost: 'hk.example.com',
      serverPort: 443,
      params: { flow: '', transport: { type: 'tcp' }, tls: { enabled: false } }
    },
    {
      id: 'line-jp',
      name: '日本优选 01',
      type: 'DIRECT',
      protocolType: 'HYSTERIA2',
      serverHost: 'jp.example.com',
      serverPort: 443,
      params: { upMbps: 100, downMbps: 200 }
    },
    {
      id: 'line-us',
      name: '美国节点 01',
      type: 'DIRECT',
      protocolType: 'VLESS',
      serverHost: 'us.example.com',
      serverPort: 443,
      params: { flow: '', transport: { type: 'tcp' }, tls: { enabled: false } }
    }
  ];

  const rawPayload = {
    proxyGroups: [
      { name: '🔰 节点选择', type: 'select', proxies: ['all', '🔯 自动优选', 'DIRECT'] },
      { name: '🔯 自动优选', type: 'fallback', url: 'http://www.gstatic.com/generate_204', interval: 180, proxies: 'all' },
      { name: '🤖 ChatGPT', type: 'select', proxies: ['🔰 节点选择', 'DIRECT', 'all'] },
      { name: '🧠 Google AI', type: 'select', proxies: ['🔰 节点选择', 'DIRECT', 'all'] },
      { name: '🎬 YouTube', type: 'select', proxies: ['🔰 节点选择', 'DIRECT', 'all'] },
      { name: '🍎 Apple', type: 'select', proxies: ['DIRECT', '🔰 节点选择', 'all'] },
      { name: '🎮 Steam', type: 'select', proxies: ['DIRECT', '🔰 节点选择', 'all'] },
      { name: '📲 Telegram', type: 'select', proxies: ['🔰 节点选择', 'all'] },
      { name: '☁️ CloudFlare', type: 'select', proxies: ['DIRECT', '🔰 节点选择', 'all'] },
      { name: '📺 哔哩哔哩', type: 'select', proxies: ['DIRECT', '🔰 节点选择', 'all'] },
      { name: '🎵 网易云音乐', type: 'select', proxies: ['DIRECT', '🔰 节点选择'] },
      { name: 'Ⓜ️ 微软云盘', type: 'select', proxies: ['DIRECT', '🔰 节点选择'] },
      { name: '💚 Nvidia', type: 'select', proxies: ['🔰 节点选择', 'DIRECT'] },
      { name: '🐱 GitHub', type: 'select', proxies: ['🔰 节点选择', 'all'] },
      { name: '🎨 Pixiv', type: 'select', proxies: ['🔰 节点选择', 'all'] },
      { name: '🎯 全球直连', type: 'select', proxies: ['DIRECT', '🔰 节点选择'] },
      { name: '🛑 广告拦截', type: 'select', proxies: ['REJECT', 'DIRECT'] },
      { name: '🐟 漏网之鱼', type: 'select', proxies: ['🔰 节点选择', 'DIRECT'] }
    ],
    ruleSets: [
      {
        name: 'Private IP',
        type: 'ip-cidr',
        rules: ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '127.0.0.0/8', '100.64.0.0/10', '::1/128', 'fc00::/7', 'fe80::/10', 'fd00::/8'],
        target: '🎯 全球直连,no-resolve',
        enabled: true
      },
      {
        name: 'Advertising',
        type: 'remote-rule-set',
        target: '🛑 广告拦截',
        url: 'https://cdn.jsdelivr.net/gh/blackmatrix7/ios_rule_script@master/rule/Clash/Advertising/Advertising.yaml',
        singboxUrl: 'https://cdn.jsdelivr.net/gh/blackmatrix7/ios_rule_script@master/rule/Sing-Box/Advertising/Advertising.srs',
        format: 'binary',
        behavior: 'classical',
        enabled: true
      },
      {
        name: 'ChatGPT',
        type: 'remote-rule-set',
        target: '🤖 ChatGPT',
        url: 'https://cdn.jsdelivr.net/gh/blackmatrix7/ios_rule_script@master/rule/Clash/OpenAI/OpenAI.yaml',
        singboxUrl: 'https://cdn.jsdelivr.net/gh/blackmatrix7/ios_rule_script@master/rule/Sing-Box/OpenAI/OpenAI.srs',
        format: 'binary',
        behavior: 'classical',
        enabled: true
      },
      {
        name: 'Google AI',
        type: 'remote-rule-set',
        target: '🧠 Google AI',
        url: 'https://cdn.jsdelivr.net/gh/blackmatrix7/ios_rule_script@master/rule/Clash/Gemini/Gemini.yaml',
        singboxUrl: 'https://cdn.jsdelivr.net/gh/blackmatrix7/ios_rule_script@master/rule/Sing-Box/Gemini/Gemini.srs',
        format: 'binary',
        behavior: 'classical',
        enabled: true
      },
      {
        name: 'YouTube',
        type: 'remote-rule-set',
        target: '🎬 YouTube',
        url: 'https://cdn.jsdelivr.net/gh/blackmatrix7/ios_rule_script@master/rule/Clash/YouTube/YouTube.yaml',
        singboxUrl: 'https://cdn.jsdelivr.net/gh/blackmatrix7/ios_rule_script@master/rule/Sing-Box/YouTube/YouTube.srs',
        format: 'binary',
        behavior: 'classical',
        enabled: true
      },
      {
        name: 'Telegram',
        type: 'remote-rule-set',
        target: '📲 Telegram',
        url: 'https://cdn.jsdelivr.net/gh/blackmatrix7/ios_rule_script@master/rule/Clash/Telegram/Telegram.yaml',
        singboxUrl: 'https://cdn.jsdelivr.net/gh/blackmatrix7/ios_rule_script@master/rule/Sing-Box/Telegram/Telegram.srs',
        format: 'binary',
        behavior: 'classical',
        enabled: true
      },
      {
        name: 'Apple',
        type: 'remote-rule-set',
        target: '🍎 Apple',
        url: 'https://cdn.jsdelivr.net/gh/blackmatrix7/ios_rule_script@master/rule/Clash/Apple/Apple.yaml',
        singboxUrl: 'https://cdn.jsdelivr.net/gh/blackmatrix7/ios_rule_script@master/rule/Sing-Box/Apple/Apple.srs',
        format: 'binary',
        behavior: 'classical',
        enabled: true
      },
      {
        name: 'Steam',
        type: 'remote-rule-set',
        target: '🎮 Steam',
        url: 'https://cdn.jsdelivr.net/gh/blackmatrix7/ios_rule_script@master/rule/Clash/Steam/Steam.yaml',
        singboxUrl: 'https://cdn.jsdelivr.net/gh/blackmatrix7/ios_rule_script@master/rule/Sing-Box/Steam/Steam.srs',
        format: 'binary',
        behavior: 'classical',
        enabled: true
      },
      {
        name: 'CloudFlare',
        type: 'remote-rule-set',
        target: '☁️ CloudFlare',
        url: 'https://cdn.jsdelivr.net/gh/blackmatrix7/ios_rule_script@master/rule/Clash/Cloudflare/Cloudflare.yaml',
        singboxUrl: 'https://cdn.jsdelivr.net/gh/blackmatrix7/ios_rule_script@master/rule/Sing-Box/Cloudflare/Cloudflare.srs',
        format: 'binary',
        behavior: 'classical',
        enabled: true
      },
      {
        name: 'BiliBili',
        type: 'remote-rule-set',
        target: '📺 哔哩哔哩',
        url: 'https://cdn.jsdelivr.net/gh/blackmatrix7/ios_rule_script@master/rule/Clash/BiliBili/BiliBili.yaml',
        singboxUrl: 'https://cdn.jsdelivr.net/gh/blackmatrix7/ios_rule_script@master/rule/Sing-Box/BiliBili/BiliBili.srs',
        format: 'binary',
        behavior: 'classical',
        rules: ['bilibili.com', 'b23.tv', 'biliapi.net', 'bilivideo.com', 'hdslb.com'],
        enabled: true
      },
      {
        name: 'NetEaseMusic',
        type: 'remote-rule-set',
        target: '🎵 网易云音乐',
        url: 'https://cdn.jsdelivr.net/gh/blackmatrix7/ios_rule_script@master/rule/Clash/NetEaseMusic/NetEaseMusic.yaml',
        singboxUrl: 'https://cdn.jsdelivr.net/gh/blackmatrix7/ios_rule_script@master/rule/Sing-Box/NetEaseMusic/NetEaseMusic.srs',
        format: 'binary',
        behavior: 'classical',
        enabled: true
      },
      {
        name: 'OneDrive',
        type: 'remote-rule-set',
        target: 'Ⓜ️ 微软云盘',
        url: 'https://cdn.jsdelivr.net/gh/blackmatrix7/ios_rule_script@master/rule/Clash/OneDrive/OneDrive.yaml',
        singboxUrl: 'https://cdn.jsdelivr.net/gh/blackmatrix7/ios_rule_script@master/rule/Sing-Box/OneDrive/OneDrive.srs',
        format: 'binary',
        behavior: 'classical',
        enabled: true
      },
      {
        name: 'Nvidia',
        type: 'remote-rule-set',
        target: '💚 Nvidia',
        url: 'https://cdn.jsdelivr.net/gh/blackmatrix7/ios_rule_script@master/rule/Clash/Nvidia/Nvidia.yaml',
        singboxUrl: 'https://cdn.jsdelivr.net/gh/blackmatrix7/ios_rule_script@master/rule/Sing-Box/Nvidia/Nvidia.srs',
        format: 'binary',
        behavior: 'classical',
        enabled: true
      },
      {
        name: 'GitHub',
        type: 'remote-rule-set',
        target: '🐱 GitHub',
        url: 'https://cdn.jsdelivr.net/gh/blackmatrix7/ios_rule_script@master/rule/Clash/GitHub/GitHub.yaml',
        singboxUrl: 'https://cdn.jsdelivr.net/gh/blackmatrix7/ios_rule_script@master/rule/Sing-Box/GitHub/GitHub.srs',
        format: 'binary',
        behavior: 'classical',
        enabled: true
      },
      {
        name: 'Pixiv',
        type: 'remote-rule-set',
        target: '🎨 Pixiv',
        url: 'https://cdn.jsdelivr.net/gh/blackmatrix7/ios_rule_script@master/rule/Clash/Pixiv/Pixiv.yaml',
        singboxUrl: 'https://cdn.jsdelivr.net/gh/blackmatrix7/ios_rule_script@master/rule/Sing-Box/Pixiv/Pixiv.srs',
        format: 'binary',
        behavior: 'classical',
        enabled: true
      },
      {
        name: 'ChinaMax',
        type: 'remote-rule-set',
        target: '🎯 全球直连',
        url: 'https://cdn.jsdelivr.net/gh/blackmatrix7/ios_rule_script@master/rule/Clash/ChinaMax/ChinaMax.yaml',
        singboxUrl: 'https://cdn.jsdelivr.net/gh/blackmatrix7/ios_rule_script@master/rule/Sing-Box/ChinaMax/ChinaMax.srs',
        format: 'binary',
        behavior: 'classical',
        enabled: true
      },
      {
        name: 'China IP',
        type: 'geoip',
        rules: ['CN'],
        target: '🎯 全球直连',
        enabled: true
      },
      {
        name: 'Final Match',
        type: 'match',
        rules: [],
        target: '🐟 漏网之鱼',
        enabled: true
      }
    ],
    dnsConfig: {
      enable: true,
      ipv6: false,
      'default-nameserver': ['223.5.5.5', '119.29.29.29'],
      'enhanced-mode': 'fake-ip',
      'fake-ip-range': '198.18.0.1/16',
      'use-hosts': true,
      nameserver: ['https://doh.pub/dns-query', 'https://dns.alidns.com/dns-query'],
      fallback: ['https://1.1.1.1/dns-query', 'https://dns.google/dns-query'],
      'fallback-filter': {
        geoip: true,
        'geoip-code': 'CN',
        ipcidr: ['240.0.0.0/4', '0.0.0.0/32']
      }
    },
    customInjectYaml: 'mixed-port: 7890\nallow-lan: true\nmode: rule\nlog-level: info\nprofile:\n  store-selected: true\n  store-fake-ip: true\n',
    customInjectJson: '{\n  "log": {\n    "level": "info"\n  },\n  "inbounds": [\n    {\n      "type": "mixed",\n      "tag": "mixed-in",\n      "listen": "127.0.0.1",\n      "listen_port": 7890\n    }\n  ],\n  "experimental": {\n    "clash_api": {\n      "external_controller": "127.0.0.1:9090",\n      "secret": ""\n    }\n  }\n}'
  };

  const templateConfig = {
    proxyGroupsJson: JSON.stringify(rawPayload.proxyGroups),
    ruleSetsJson: JSON.stringify(rawPayload.ruleSets),
    dnsConfigJson: JSON.stringify(rawPayload.dnsConfig),
    customInjectYaml: rawPayload.customInjectYaml,
    customInjectJson: rawPayload.customInjectJson
  };

  it('成功构建 Clash 配置，具备全部 18 个策略组、远端规则集及 Fake-IP DNS', () => {
    const yamlStr = buildClashYaml(user, mockNodes, templateConfig);
    expect(yamlStr).toBeTruthy();

    const config = parse(yamlStr) as {
      'mixed-port': number;
      'allow-lan': boolean;
      mode: string;
      dns: {
        enable: boolean;
        'enhanced-mode': string;
        nameserver: string[];
      };
      'proxy-groups': Array<{ name: string; type: string; proxies: string[] }>;
      'rule-providers': Record<string, { type: string; url: string; behavior: string }>;
      rules: string[];
    };

    // 1. 基础与注入参数
    expect(config['mixed-port']).toBe(7890);
    expect(config['allow-lan']).toBe(true);
    expect(config.mode).toBe('rule');

    // 2. DNS 配置
    expect(config.dns.enable).toBe(true);
    expect(config.dns['enhanced-mode']).toBe('fake-ip');

    // 3. 策略组覆盖 (18 个业务策略组)
    const groupNames = config['proxy-groups'].map((g) => g.name);
    expect(groupNames).toEqual(expect.arrayContaining([
      '🔰 节点选择',
      '🔯 自动优选',
      '🤖 ChatGPT',
      '🧠 Google AI',
      '🎬 YouTube',
      '🍎 Apple',
      '🎮 Steam',
      '📲 Telegram',
      '☁️ CloudFlare',
      '📺 哔哩哔哩',
      '🎵 网易云音乐',
      'Ⓜ️ 微软云盘',
      '💚 Nvidia',
      '🐱 GitHub',
      '🎨 Pixiv',
      '🎯 全球直连',
      '🛑 广告拦截',
      '🐟 漏网之鱼'
    ]));

    // 4. 远程规则提供者校验
    const providers = config['rule-providers'];
    expect(providers['bilibili']).toEqual(expect.objectContaining({
      type: 'http',
      behavior: 'classical',
      path: './ruleset/bilibili.yaml'
    }));
    expect(Object.keys(providers)).toEqual(expect.arrayContaining([
      'advertising',
      'chatgpt',
      'google-ai',
      'youtube',
      'telegram',
      'apple',
      'steam',
      'cloudflare',
      'bilibili',
      'neteasemusic',
      'onedrive',
      'nvidia',
      'github',
      'pixiv',
      'chinamax'
    ]));

    // 5. 规则序列正确包含 RULE-SET、GEOIP、MATCH 且无出站名字污染
    expect(config.rules).toEqual(expect.arrayContaining([
      'DOMAIN-SUFFIX,bilibili.com,📺 哔哩哔哩',
      'RULE-SET,bilibili,📺 哔哩哔哩',
      'RULE-SET,chatgpt,🤖 ChatGPT',
      'RULE-SET,google-ai,🧠 Google AI',
      'RULE-SET,youtube,🎬 YouTube',
      'RULE-SET,steam,🎮 Steam',
      'GEOIP,CN,🎯 全球直连',
      'MATCH,🐟 漏网之鱼'
    ]));

    // 确认绝无残存的 ",no-resolve" 污染进入策略名
    for (const rule of config.rules) {
      const parts = rule.split(',');
      if (parts[0] === 'RULE-SET') {
        expect(parts[2]).not.toContain(',no-resolve');
      }
    }
  });

  it('成功构建 Sing-box 配置，生成合规的 route.rule_set, route.rules 与 inbounds', () => {
    const jsonStr = buildSingboxJson(user, mockNodes, templateConfig);
    expect(jsonStr).toBeTruthy();

    const config = JSON.parse(jsonStr) as {
      inbounds: Array<{ type: string; listen_port: number }>;
      outbounds: Array<{ tag: string; type: string }>;
      dns: {
        servers: Array<{ tag: string; type?: string; server?: string; inet4_range?: string }>;
        fakeip?: { enabled: boolean };
      };
      route: {
        default_domain_resolver?: string;
        rule_set: Array<{ tag: string; type: string; format: string; url: string }>;
        rules: Array<Record<string, unknown>>;
      };
      experimental?: {
        clash_api?: { external_controller: string };
      };
    };

    // 1. 注入入站与控制器
    expect(config.inbounds).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'mixed', listen_port: 7890 })
    ]));
    expect(config.experimental?.clash_api?.external_controller).toBe('127.0.0.1:9090');

    // 2. DNS
    expect(config.dns.servers).toEqual(expect.arrayContaining([
      expect.objectContaining({ tag: 'dns_direct', type: 'https', server: 'doh.pub' }),
      expect.objectContaining({ tag: 'dns_direct_2', type: 'https', server: 'dns.alidns.com' }),
      expect.objectContaining({ tag: 'dns_proxy', type: 'https', server: '1.1.1.1' }),
      expect.objectContaining({ tag: 'dns_proxy_2', type: 'https', server: 'dns.google' }),
      expect.objectContaining({ tag: 'dns_fakeip', type: 'fakeip', inet4_range: '198.18.0.0/15' })
    ]));
    expect(config.dns).not.toHaveProperty('fakeip');
    expect(config.route.default_domain_resolver).toBe('dns_direct');

    // 3. 策略组标签与核心出站
    const outboundTags = config.outbounds.map((o) => o.tag);
    expect(outboundTags).toEqual(expect.arrayContaining([
      'direct',
      'block',
      '🔰 节点选择',
      '🔯 自动优选',
      '🤖 ChatGPT',
      '🧠 Google AI',
      '🎬 YouTube',
      '🍎 Apple',
      '🎮 Steam',
      '📲 Telegram',
      '🎯 全球直连',
      '🛑 广告拦截',
      '🐟 漏网之鱼'
    ]));

    // 4. Sing-box remote rule_set 列表
    expect(config.route.rule_set).toEqual(expect.arrayContaining([
      expect.objectContaining({ tag: 'advertising', format: 'binary' }),
      expect.objectContaining({ tag: 'chatgpt', format: 'binary' }),
      expect.objectContaining({ tag: 'google-ai', format: 'binary' }),
      expect.objectContaining({ tag: 'youtube', format: 'binary' }),
      expect.objectContaining({ tag: 'steam', format: 'binary' }),
      expect.objectContaining({ tag: 'chinamax', format: 'binary' }),
      expect.objectContaining({ tag: 'geoip-cn', format: 'binary' })
    ]));

    // 5. 路由匹配规则正确映射 outbound
    expect(config.route.rules).toEqual(expect.arrayContaining([
      expect.objectContaining({ rule_set: ['chatgpt'], outbound: '🤖 ChatGPT' }),
      expect.objectContaining({ rule_set: ['google-ai'], outbound: '🧠 Google AI' }),
      expect.objectContaining({ rule_set: ['youtube'], outbound: '🎬 YouTube' }),
      expect.objectContaining({ rule_set: ['steam'], outbound: '🎮 Steam' }),
      expect.objectContaining({ rule_set: ['geoip-cn'], outbound: '🎯 全球直连' }),
      expect.objectContaining({ action: 'route', outbound: '🐟 漏网之鱼' })
    ]));
  });
});
