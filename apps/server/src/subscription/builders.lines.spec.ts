import { buildClashYaml, buildSingboxJson, buildUriList, entryLabels, type SubLine, type SubUser } from './builders';
import { parse } from 'yaml';

describe('subscription builders with lines', () => {
  const user: SubUser = { uuid: 'a77cf184-4b56-41ee-962c-1357184acd77', email: 'user@example.com', credential: 'user-password' };
  const line: SubLine = {
    id: 'line-1',
    name: '香港中继',
    type: 'RELAY',
    relayMode: 'BLIND_FORWARD',
    endpointOverrideEnabled: true,
    serverHost: 'relay.example.com',
    serverPort: 8443,
    serverName: 'www.apple.com',
    host: 'cdn.example.com',
    trafficRate: 1.5,
    tags: ['hk', 'relay'],
    level: 2,
    targetInbound: {
      type: 'VLESS',
      tag: 'vless-in',
      port: 443,
      params: {
        flow: '',
        transport: { type: 'ws', path: '/proxy', host: 'origin.example.com' },
        tls: { enabled: true, mode: 'tls', serverName: 'origin.example.com', alpn: ['http/1.1'], insecure: false }
      }
    }
  };

  it('线路名称包含倍率且连接覆盖参数进入 Clash 输出', () => {
    expect(entryLabels([line])).toEqual(['香港中继 [1.5x]']);
    const config = parse(buildClashYaml(user, [line])) as { proxies: Array<Record<string, unknown>> };
    expect(config.proxies[0]).toMatchObject({
      name: '香港中继 [1.5x]',
      server: 'relay.example.com',
      port: 8443,
      servername: 'www.apple.com',
      alpn: ['http/1.1'],
      'ws-opts': { path: '/proxy', headers: { Host: 'cdn.example.com' } }
    });
  });

  it('线路覆盖参数进入 Sing-box 与 Base64 URI 输出', () => {
    const config = JSON.parse(buildSingboxJson(user, [line])) as { outbounds: Array<Record<string, unknown>> };
    expect(config.outbounds[0]).toMatchObject({
      tag: '香港中继 [1.5x]',
      server: 'relay.example.com',
      server_port: 8443,
      tls: { server_name: 'www.apple.com', alpn: ['http/1.1'] },
      transport: { type: 'ws', path: '/proxy', headers: { Host: 'cdn.example.com' } }
    });
    const [uri] = buildUriList(user, [line]);
    expect(uri).toContain(`vless://${user.uuid}@relay.example.com:8443`);
    expect(uri).toContain('sni=www.apple.com');
    expect(uri).toContain('host=cdn.example.com');
  });

  it('关闭线路覆盖时回退到目标入站的 SNI 与 Host', () => {
    const disabledLine = {
      ...line,
      endpointOverrideEnabled: false,
      serverName: 'stale.example.com',
      host: 'stale-cdn.example.com'
    };
    const config = parse(buildClashYaml(user, [disabledLine])) as { proxies: Array<Record<string, unknown>> };

    expect(config.proxies[0]).toMatchObject({
      servername: 'origin.example.com',
      'ws-opts': { headers: { Host: 'origin.example.com' } }
    });
  });

  it('Sing-box 默认策略组与 DIRECT/REJECT 路由目标均有对应出站', () => {
    const config = JSON.parse(buildSingboxJson(user, [line], {
      proxyGroupsJson: JSON.stringify([{ name: '代理组', type: 'select' }]),
      ruleSetsJson: JSON.stringify([
        { type: 'match', target: 'DIRECT' },
        { type: 'domain-suffix', rules: ['example.com'], target: 'REJECT' }
      ])
    })) as { outbounds: Array<Record<string, unknown>>; route: { rules: Array<Record<string, unknown>> } };

    expect(config.outbounds).toEqual(expect.arrayContaining([
      { type: 'direct', tag: 'direct' },
      { type: 'block', tag: 'block' },
      { type: 'selector', tag: '代理组', outbounds: ['香港中继 [1.5x]'] }
    ]));
    expect(config.route.rules).toEqual([
      { action: 'route', outbound: 'direct' },
      { domain_suffix: ['example.com'], outbound: 'block' }
    ]);
  });

  it('ShadowTLS 输出为 SS2022 + ShadowTLS v3 组合线路', () => {
    const shadowtlsLine: SubLine = {
      ...line,
      name: 'ShadowTLS v3',
      targetInbound: {
        type: 'SHADOWTLS',
        tag: 'shadowtls-in',
        port: 443,
        params: {
          version: 3,
          handshakeDest: 'www.apple.com:443',
          strictMode: true,
          inner: {
            type: 'SHADOWSOCKS',
            method: '2022-blake3-aes-128-gcm',
            password: 'inner-password'
          }
        }
      }
    };
    const clash = parse(buildClashYaml(user, [shadowtlsLine])) as { proxies: Array<Record<string, unknown>> };
    expect(clash.proxies[0]).toMatchObject({
      name: 'ShadowTLS v3 [1.5x]',
      type: 'ss',
      cipher: '2022-blake3-aes-128-gcm',
      plugin: 'shadow-tls',
      'client-fingerprint': 'chrome',
      'plugin-opts': { host: 'www.apple.com', password: user.credential, version: 3 }
    });

    const singbox = JSON.parse(buildSingboxJson(user, [shadowtlsLine])) as {
      outbounds: Array<Record<string, unknown>>;
    };
    expect(singbox.outbounds).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'shadowsocks', tag: 'ShadowTLS v3 [1.5x]', detour: 'ShadowTLS v3 [1.5x] · ShadowTLS' }),
      expect.objectContaining({ type: 'shadowtls', tag: 'ShadowTLS v3 [1.5x] · ShadowTLS', version: 3, password: user.credential })
    ]));
    const selector = singbox.outbounds.find((outbound) => outbound.type === 'selector') as { outbounds: string[] };
    expect(selector.outbounds).toEqual(['ShadowTLS v3 [1.5x]']);

    const [uri] = buildUriList(user, [shadowtlsLine]);
    expect(uri).toContain('ss://');
    expect(uri).toContain('plugin=shadow-tls%3Bhost%3Dwww.apple.com');
  });

  it('支持限速参数与多路复用配置进入 Clash 与 Sing-box 输出', () => {
    const shapedLine: SubLine = {
      id: 'line-shaped',
      name: '限速节点 [50M]',
      type: 'DIRECT',
      serverHost: 'node.example.com',
      serverPort: 10086,
      speedLimitMbps: 50,
      protocolType: 'SHADOWSOCKS',
      params: {
        method: '2022-blake3-aes-128-gcm',
        password: 'pass',
        udpOverTcp: false,
        multiplex: {
          enabled: true,
          protocol: 'smux',
          maxConnections: 4,
          minStreams: 4
        }
      }
    };

    const clash = parse(buildClashYaml(user, [shapedLine])) as { proxies: Array<Record<string, unknown>> };
    expect(clash.proxies[0]).toMatchObject({
      name: '限速节点 [50M]',
      type: 'ss',
      'bandwidth-limit': '50 Mbps',
      smux: {
        enabled: true,
        protocol: 'smux',
        'max-connections': 4,
        'min-streams': 4
      }
    });

    const singbox = JSON.parse(buildSingboxJson(user, [shapedLine])) as {
      outbounds: Array<Record<string, unknown>>;
    };
    expect(singbox.outbounds[0]).toMatchObject({
      tag: '限速节点 [50M]',
      type: 'shadowsocks',
      multiplex: {
        enabled: true,
        protocol: 'smux',
        max_connections: 4,
        min_streams: 4
      }
    });
  });

  it('Shadowsocks 开启 udpOverTcp 时自动抑制 multiplex / smux', () => {
    const uotLine: SubLine = {
      id: 'line-uot',
      name: 'UoT 节点',
      type: 'DIRECT',
      serverHost: 'node.example.com',
      serverPort: 10086,
      protocolType: 'SHADOWSOCKS',
      params: {
        method: '2022-blake3-aes-128-gcm',
        password: 'pass',
        udpOverTcp: true,
        multiplex: {
          enabled: true,
          protocol: 'smux'
        }
      }
    };

    const clash = parse(buildClashYaml(user, [uotLine])) as { proxies: Array<Record<string, unknown>> };
    expect(clash.proxies[0]['udp-over-tcp']).toBe(true);
    expect(clash.proxies[0].smux).toBeUndefined();

    const singbox = JSON.parse(buildSingboxJson(user, [uotLine])) as {
      outbounds: Array<Record<string, unknown>>;
    };
    expect(singbox.outbounds[0].udp_over_tcp).toBe(true);
    expect(singbox.outbounds[0].multiplex).toBeUndefined();
  });

  it('Sing-box 订阅中正确输出合法 Brutal 配置并在缺失速率时防御性抑制', () => {
    const validBrutalLine: SubLine = {
      id: 'line-brutal-ok',
      name: 'Brutal 合法节点',
      type: 'DIRECT',
      serverHost: 'node.example.com',
      serverPort: 10086,
      protocolType: 'SHADOWSOCKS',
      params: {
        method: '2022-blake3-aes-128-gcm',
        password: 'pass',
        udpOverTcp: false,
        multiplex: {
          enabled: true,
          protocol: 'smux',
          brutal: { enabled: true, upMbps: 50, downMbps: 100 }
        }
      }
    };

    const invalidBrutalLine: SubLine = {
      id: 'line-brutal-bad',
      name: 'Brutal 脏数据节点',
      type: 'DIRECT',
      serverHost: 'node.example.com',
      serverPort: 10087,
      protocolType: 'SHADOWSOCKS',
      params: {
        method: '2022-blake3-aes-128-gcm',
        password: 'pass',
        udpOverTcp: false,
        multiplex: {
          enabled: true,
          protocol: 'smux',
          brutal: { enabled: true, upMbps: 0, downMbps: 100 }
        }
      }
    };

    const singboxValid = JSON.parse(buildSingboxJson(user, [validBrutalLine])) as {
      outbounds: Array<Record<string, unknown>>;
    };
    expect((singboxValid.outbounds[0].multiplex as Record<string, unknown>).brutal).toEqual({
      enabled: true,
      up_mbps: 50,
      down_mbps: 100
    });

    const singboxInvalid = JSON.parse(buildSingboxJson(user, [invalidBrutalLine])) as {
      outbounds: Array<Record<string, unknown>>;
    };
    expect((singboxInvalid.outbounds[0].multiplex as Record<string, unknown>).brutal).toBeUndefined();
  });
});
