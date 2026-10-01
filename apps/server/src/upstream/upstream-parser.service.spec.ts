import { UpstreamParserService } from './upstream-parser.service';

describe('UpstreamParserService', () => {
  let parser: UpstreamParserService;

  beforeEach(() => {
    parser = new UpstreamParserService();
  });

  describe('parseUserInfoHeader', () => {
    it('正确解析 subscription-userinfo 头', () => {
      const header = 'upload=1000; download=2000; total=10737418240; expire=1735689600';
      const info = parser.parseUserInfoHeader(header);
      expect(info).not.toBeNull();
      expect(info?.uploadBytes).toBe(1000n);
      expect(info?.downloadBytes).toBe(2000n);
      expect(info?.usedBytes).toBe(3000n);
      expect(info?.totalBytes).toBe(10737418240n);
      expect(info?.expireAt?.getTime()).toBe(1735689600 * 1000);
    });

    it('空或格式错误时返回 null', () => {
      expect(parser.parseUserInfoHeader('')).toBeNull();
      expect(parser.parseUserInfoHeader(null)).toBeNull();
      expect(parser.parseUserInfoHeader('invalid-header')).toBeNull();
    });
  });

  describe('Clash Meta (YAML) 解析', () => {
    it('解析包含 VLESS-Reality、Hysteria2 与 Shadowsocks 的 YAML', () => {
      const yaml = `
proxies:
  - name: "🇭🇰 香港 01 [Reality]"
    type: vless
    server: hk.example.com
    port: 443
    uuid: "11111111-2222-3333-4444-555555555555"
    network: ws
    ws-opts:
      path: /vless-ws
    tls: true
    reality-opts:
      public-key: "pbk_example_123"
      short-id: "abcd"
    client-fingerprint: chrome

  - name: "🇯🇵 日本 02 [Hy2]"
    type: hysteria2
    server: jp.example.com
    port: 8443
    password: "hy2password"
    up: 100
    down: 500
    sni: jp.example.com

  - name: "🇺🇸 美国 03 [SS]"
    type: ss
    server: us.example.com
    port: 8388
    cipher: 2022-blake3-aes-128-gcm
    password: "sspassword"
`;
      const result = parser.parse(yaml);
      expect(result.format).toBe('CLASH_META');
      expect(result.nodes.length).toBe(3);

      const [vless, hy2, ss] = result.nodes;
      expect(vless.name).toBe('🇭🇰 香港 01 [Reality]');
      expect(vless.protocolType).toBe('VLESS');
      expect(vless.serverHost).toBe('hk.example.com');
      expect(vless.serverPort).toBe(443);
      expect(vless.params.uuid).toBe('11111111-2222-3333-4444-555555555555');
      expect(vless.tags).toContain('HK');
      expect((vless.params.tls as { reality?: { publicKey?: string } })?.reality?.publicKey).toBe('pbk_example_123');

      expect(hy2.name).toBe('🇯🇵 日本 02 [Hy2]');
      expect(hy2.protocolType).toBe('HYSTERIA2');
      expect(hy2.serverHost).toBe('jp.example.com');
      expect(hy2.serverPort).toBe(8443);
      expect(hy2.params.password).toBe('hy2password');
      expect(hy2.params.upMbps).toBe(100);
      expect(hy2.tags).toContain('JP');

      expect(ss.name).toBe('🇺🇸 美国 03 [SS]');
      expect(ss.protocolType).toBe('SHADOWSOCKS');
      expect(ss.serverHost).toBe('us.example.com');
      expect(ss.serverPort).toBe(8388);
      expect(ss.params.method).toBe('2022-blake3-aes-128-gcm');
      expect(ss.tags).toContain('US');
    });
  });

  describe('Sing-box (JSON) 解析', () => {
    it('解析包含 Outbounds 的 Sing-box 配置并过滤 direct/block/dns', () => {
      const json = JSON.stringify({
        outbounds: [
          { type: 'direct', tag: 'direct-out' },
          { type: 'dns', tag: 'dns-out' },
          {
            type: 'trojan',
            tag: '🇸🇬 新加坡 01 [Trojan]',
            server: 'sg.example.com',
            server_port: 443,
            password: 'trojan_pass',
            tls: { enabled: true, server_name: 'sg.example.com' }
          },
          {
            type: 'tuic',
            tag: '🇹🇼 台湾 01 [TUIC]',
            server: 'tw.example.com',
            server_port: 8443,
            uuid: '11111111-2222-3333-4444-555555555555',
            password: 'tuic_pass',
            congestion_control: 'bbr'
          }
        ]
      });

      const result = parser.parse(json);
      expect(result.format).toBe('SINGBOX');
      expect(result.nodes.length).toBe(2);

      const [trojan, tuic] = result.nodes;
      expect(trojan.name).toBe('🇸🇬 新加坡 01 [Trojan]');
      expect(trojan.protocolType).toBe('TROJAN');
      expect(trojan.serverHost).toBe('sg.example.com');
      expect((trojan.params.tls as { serverName?: string })?.serverName).toBe('sg.example.com');
      expect(trojan.tags).toContain('SG');

      expect(tuic.name).toBe('🇹🇼 台湾 01 [TUIC]');
      expect(tuic.protocolType).toBe('TUIC');
      expect(tuic.params.congestionControl).toBe('bbr');
      expect(tuic.params).not.toHaveProperty('congestion_control');
      expect(tuic.tags).toContain('TW');
    });
  });

  describe('URI 列表解析', () => {
    it('解析多行 URI 链接', () => {
      const uris = [
        'vless://11111111-2222-3333-4444-555555555555@hk.node.com:443?security=reality&pbk=testkey&sid=123#%F0%9F%87%AD%F0%9F%87%B0%20%E9%A6%99%E6%B8%AF%2001',
        'hy2://mypassword@us.node.com:8443?sni=us.node.com#%F0%9F%87%BA%F0%9F%87%B8%20%E7%BE%8E%E5%9B%BD%2001'
      ].join('\n');

      const result = parser.parse(uris);
      expect(result.format).toBe('URI_LIST');
      expect(result.nodes.length).toBe(2);
      expect(result.nodes[0].protocolType).toBe('VLESS');
      expect(result.nodes[0].tags).toContain('HK');
      expect(result.nodes[1].protocolType).toBe('HYSTERIA2');
      expect(result.nodes[1].tags).toContain('US');
    });

    it('解析 Base64 编码的 URI 列表', () => {
      const raw = 'trojan://pass123@jp.node.com:443?sni=jp.node.com#%E6%97%A5%E6%9C%AC%E8%8A%82%E7%82%B9';
      const b64 = Buffer.from(raw).toString('base64');
      const result = parser.parse(b64);
      expect(result.format).toBe('URI_LIST');
      expect(result.nodes.length).toBe(1);
      expect(result.nodes[0].protocolType).toBe('TROJAN');
      expect(result.nodes[0].serverHost).toBe('jp.node.com');
      expect(result.nodes[0].tags).toContain('JP');
    });
  });

  describe('完整连接哈希稳定性', () => {
    it('规范化参数产生确定性的 SHA256', () => {
      const fp1 = parser.computeConnectionHash('VLESS', 'hk.example.com', 443, { uuid: 'u1' });
      const fp2 = parser.computeConnectionHash('VLESS', 'hk.example.com', 443, { uuid: 'u1' });
      const fp3 = parser.computeConnectionHash('VLESS', 'hk.example.com', 443, { uuid: 'u2' });
      expect(fp1).toBe(fp2);
      expect(fp1).not.toBe(fp3);
    });
  });
});

describe('上游破坏性快照回归', () => {
  const parser = new UpstreamParserService();
  const valid = 'trojan://secret@example.com:443#node';
  it('无效或未知代理不能提交部分成功快照', () => {
    expect(() => parser.parse(`${valid}\nwireguard://private-secret`)).toThrow();
    expect(() => parser.parse(`${valid}\ntrojan://secret@example.com:70000`)).toThrow();
  });
  it('错误只包含代理索引，不包含输入秘密', () => {
    try { parser.parse(`${valid}\nunknown://private-secret`); } catch (error) {
      expect(String(error)).not.toContain('private-secret');
      expect(String(error)).toContain('2');
      return;
    }
    throw new Error('应拒绝不完整快照');
  });
  it('解析 Clash JSON 和隐式 Trojan TLS', () => {
    const result = parser.parse(JSON.stringify({ proxies: [{ name: 'n', type: 'trojan', server: 'example.com', port: 443, password: 'p' }] }));
    expect(result.format).toBe('CLASH_META');
    expect(result.nodes[0].params.tls).toMatchObject({ enabled: true });
  });
  it('支持 IPv6、百分号凭据和 SS 冒号密码及 plugin', () => {
    const node = parser.parse('trojan://p%3A%40%23@[2001:db8::1]:443#n').nodes[0];
    expect(node.serverHost).toBe('2001:db8::1');
    expect(node.params.password).toBe('p:@#');
    const ss = parser.parse('ss://aes-128-gcm:p%3Aa@[2001:db8::2]:8388/?plugin=v2ray-plugin%3Bmode%3Dwebsocket#n').nodes[0];
    expect(ss.params.password).toBe('p:a');
    expect(ss.params.plugin).toBe('v2ray-plugin');
  });
  it('完整连接哈希区分 WS 路径并去重完全相同条目', () => {
    const a = 'vless://11111111-2222-3333-4444-555555555555@example.com:443?type=ws&path=%2Fa#n';
    const b = 'vless://11111111-2222-3333-4444-555555555555@example.com:443?type=ws&path=%2Fb#n';
    const result = parser.parse(`${a}\n${a}\n${b}`);
    expect(result.nodes).toHaveLength(2);
    expect(result.nodes[0]).toHaveProperty('connectionHash', expect.stringMatching(/^[0-9a-f]{64}$/));
    expect(result.nodes[0]).not.toHaveProperty('fingerprint');
    expect(result).toHaveProperty('diagnostics', { recognized: 3, duplicates: 1, skipped: 0 });
  });
  it('显式格式不能回退且无效元信息不能保留', () => {
    expect(() => parser.parse(valid, 'SINGBOX')).toThrow();
    expect(parser.parseUserInfoHeader('upload=-1; total=1.5; expire=9999999999999999')).toBeNull();
  });
  it('元信息不假定缺失的方向为零，字节保留 BigInt', () => {
    expect(parser.parseUserInfoHeader('upload=9007199254740993')?.usedBytes).toBeUndefined();
    expect(parser.parseUserInfoHeader('upload=9007199254740993; download=1')?.usedBytes).toBe(9007199254740994n);
  });
  it('结构化无效或未知代理阻止整个快照，只跳过明确非代理', () => {
    for (const entry of [{ name: 'bad', type: 'wireguard', server: 'secret', port: 443 }, { name: 'bad', type: 'trojan', server: 'example.com', port: 443 }, { name: 'bad', type: 'trojan', server: 'example.com', port: 0, password: 'secret' }]) {
      expect(() => parser.parse(JSON.stringify({ proxies: [{ name: 'good', type: 'trojan', server: 'example.com', port: 443, password: 'p' }, entry] }))).toThrow('2');
    }
    const parsed = parser.parse(JSON.stringify({ outbounds: [{ type: 'selector' }, { type: 'direct' }, { tag: 'good', type: 'trojan', server: 'example.com', server_port: 443, password: 'p' }] }));
    expect(parsed.diagnostics).toEqual({ recognized: 1, skipped: 2, duplicates: 0 });
  });
  it('支持 SS Base64 全身和 URL-safe 用户信息，SOCKS5 统一协议', () => {
    const full = Buffer.from('aes-128-gcm:p:ass@[2001:4860::1]:8388').toString('base64');
    expect(parser.parse(`ss://${full}#n`).nodes[0].params.password).toBe('p:ass');
    const credential = Buffer.from('aes-128-gcm:p:ass').toString('base64url');
    expect(parser.parse(`ss://${credential}@example.com:8388#n`).nodes[0].params.password).toBe('p:ass');
    const socks = parser.parse('socks5://user:p%3A%40%23@[2001:4860::1]:1080#n').nodes[0];
    expect(socks.protocolType).toBe('SOCKS');
    expect(socks.params.password).toBe('p:@#');
  });
  it('AUTO 每次探测，空/HTML/超限/坏端口与缺凭据不能导入', () => {
    expect(parser.parse(valid).format).toBe('URI_LIST');
    expect(parser.parse('{"proxies":[{"name":"n","type":"trojan","server":"example.com","port":443,"password":"p"}]}').format).toBe('CLASH_META');
    for (const value of ['', '<html>secret</html>', 'x'.repeat(5 * 1024 * 1024 + 1), 'trojan://@example.com:443', 'trojan://p@example.com:1.5']) expect(() => parser.parse(value)).toThrow();
  });
  it('参数键顺序不改变完整哈希，TLS/Reality/Transport/plugin 改变哈希', () => {
    const first = parser.computeConnectionHash('SHADOWSOCKS', 'EXAMPLE.COM', 443, { method: 'aes-128-gcm', password: 'p', plugin: 'v2ray-plugin', pluginOpts: { mode: 'websocket', host: 'example.com' } });
    const second = parser.computeConnectionHash('SHADOWSOCKS', 'example.com', 443, { pluginOpts: { host: 'example.com', mode: 'websocket' }, plugin: 'v2ray-plugin', password: 'p', method: 'aes-128-gcm' });
    expect(first).toBe(second);
    expect(first).not.toBe(parser.computeConnectionHash('SHADOWSOCKS', 'example.com', 443, { method: 'aes-128-gcm', password: 'p' }));
  });
});
