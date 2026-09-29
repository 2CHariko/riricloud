import {
  computeEntryKey,
  extractProxyProviderUrls,
  looksLikeSingboxConfig,
  parseMihomoProxies,
  parseSingboxOutbounds,
  parseUpstreamContent,
  parseUriList,
  UpstreamFormatError
} from './index';
import { protectEntryParams, resolveUpstreamCredentials, revealEntryParams } from '../../common/upstream-egress';

const MIHOMO_SAMPLE = `
port: 7890
mode: rule
proxy-providers:
  airport-a:
    type: http
    url: https://sub.example.com/api/v1/client/subscribe?token=secret-token
    interval: 3600
proxies:
  - name: "🇯🇵 东京 01"
    type: vless
    server: jp1.example.com
    port: 443
    uuid: 11111111-1111-4111-8111-111111111111
    network: tcp
    tls: true
    flow: xtls-rprx-vision
    servername: www.apple.com
    reality-opts:
      public-key: PUBKEY_AAAA
      short-id: 1a2b3c4d
    client-fingerprint: chrome
  - name: "🇸🇬 新加坡 WS"
    type: vmess
    server: sg1.example.com
    port: 8443
    uuid: 22222222-2222-4222-8222-222222222222
    alterId: 0
    cipher: auto
    network: ws
    tls: true
    sni: cdn.example.com
    skip-cert-verify: true
    ws-opts:
      path: /ray
      headers:
        Host: cdn.example.com
  - name: "🇭🇰 香港 SS2022"
    type: ss
    server: hk1.example.com
    port: 25001
    cipher: 2022-blake3-aes-128-gcm
    password: SS_PASSWORD_BASE64
  - name: "🇺🇸 洛杉矶 Hy2"
    type: hysteria2
    server: us1.example.com
    port: 443
    password: hy2-password
    sni: us1.example.com
    up: "100 Mbps"
    down: "200 Mbps"
    obfs: salamander
    obfs-password: obfs-secret
  - name: "🇩🇪 法兰克福 TUIC"
    type: tuic
    server: de1.example.com
    port: 443
    uuid: 33333333-3333-4333-8333-333333333333
    password: tuic-password
    congestion-controller: bbr
    sni: de1.example.com
  - name: "🇷🇺 SS-legacy"
    type: ssr
    server: ru1.example.com
    port: 8080
    cipher: aes-256-cfb
    password: ssr-password
    protocol: auth_sha1_v4
  - name: "坏节点 无地址"
    type: vless
    port: 443
    uuid: 44444444-4444-4444-8444-444444444444
  - name: "坏节点 无凭据"
    type: trojan
    server: bad.example.com
    port: 443
`;

const SINGBOX_SAMPLE = JSON.stringify({
  outbounds: [
    { type: 'selector', tag: 'select', outbounds: ['jp'] },
    { type: 'direct', tag: 'direct' },
    { type: 'block', tag: 'block' },
    {
      type: 'vless',
      tag: 'JP Reality',
      server: 'jp2.example.com',
      server_port: 443,
      uuid: '55555555-5555-4555-8555-555555555555',
      flow: 'xtls-rprx-vision',
      tls: {
        enabled: true,
        server_name: 'www.microsoft.com',
        utls: { enabled: true, fingerprint: 'chrome' },
        reality: { enabled: true, public_key: 'PUBKEY_BBBB', short_id: 'aabbccdd' }
      }
    },
    {
      type: 'trojan',
      tag: 'HK Trojan WS',
      server: 'hk2.example.com',
      server_port: 443,
      password: 'trojan-secret',
      tls: { enabled: true, server_name: 'hk2.example.com', alpn: ['h2', 'http/1.1'] },
      transport: { type: 'ws', path: '/trojan', headers: { Host: 'hk2.example.com' } }
    },
    {
      type: 'shadowsocks',
      tag: 'SG SS',
      server: 'sg2.example.com',
      server_port: 8388,
      method: '2022-blake3-aes-256-gcm',
      password: 'ss256-password'
    },
    { type: 'wireguard', tag: 'WG', server: 'wg.example.com', server_port: 51820 }
  ]
});

const URI_LIST_SAMPLE = [
  'vless://66666666-6666-4666-8666-666666666666@uri-jp.example.com:443?encryption=none&type=tcp&security=reality&sni=www.apple.com&fp=chrome&pbk=PUBKEY_CCCC&sid=deadbeef&flow=xtls-rprx-vision#URI%20JP',
  'trojan://trojan-uri-pass@uri-hk.example.com:443?type=ws&sni=uri-hk.example.com&path=%2Fws&host=uri-hk.example.com#URI%20HK',
  'hy2://hy2-uri-pass@uri-us.example.com:443?sni=uri-us.example.com&upmbps=50&downmbps=100&obfs=salamander&obfs-password=obfs-uri#URI%20US',
  'tuic://77777777-7777-4777-8777-777777777777:tuic-uri-pass@uri-de.example.com:443?congestion_control=bbr&sni=uri-de.example.com#URI%20DE',
  'ss://MjAyMi1ibGFrZTMtYWVzLTEyOC1nY206c3MtdXJpLXBhc3M@uri-sg.example.com:25002#URI%20SG',
  `vmess://${Buffer.from(JSON.stringify({
    v: '2', ps: 'URI VMess', add: 'uri-vm.example.com', port: 443,
    id: '88888888-8888-4888-8888-888888888888', aid: 0, scy: 'auto',
    net: 'ws', type: 'none', host: 'uri-vm.example.com', path: '/vm', tls: 'tls', sni: 'uri-vm.example.com'
  }), 'utf8').toString('base64')}`,
  'ssr://unsupported-scheme',
  ''
].join('\n');

describe('上游订阅解析器', () => {
  describe('mihomo (Clash Meta) 解析', () => {
    it('识别 mihomo 格式并解析出全部受支持协议', () => {
      const parsed = parseUpstreamContent(MIHOMO_SAMPLE);
      expect(parsed.format).toBe('MIHOMO');

      const byName = new Map(parsed.nodes.map((node) => [node.name, node]));
      expect(new Set(byName.keys())).toEqual(new Set([
        '🇩🇪 法兰克福 TUIC',
        '🇭🇰 香港 SS2022',
        '🇯🇵 东京 01',
        '🇺🇸 洛杉矶 Hy2',
        '🇸🇬 新加坡 WS'
      ]));
      expect(byName.get('🇯🇵 东京 01')?.protocolType).toBe('VLESS');
      expect(byName.get('🇸🇬 新加坡 WS')?.protocolType).toBe('VMESS');
      expect(byName.get('🇭🇰 香港 SS2022')?.protocolType).toBe('SHADOWSOCKS');
      expect(byName.get('🇺🇸 洛杉矶 Hy2')?.protocolType).toBe('HYSTERIA2');
      expect(byName.get('🇩🇪 法兰克福 TUIC')?.protocolType).toBe('TUIC');
    });

    it('Reality 参数映射为 publicKey 与 shortIds，而不是入站私钥语义', () => {
      const node = parseUpstreamContent(MIHOMO_SAMPLE).nodes.find((item) => item.name === '🇯🇵 东京 01');
      expect(node?.params.tls).toMatchObject({
        enabled: true,
        mode: 'reality',
        serverName: 'www.apple.com',
        reality: { publicKey: 'PUBKEY_AAAA', shortIds: ['1a2b3c4d'] }
      });
      expect(node?.params.tls.reality).not.toHaveProperty('privateKey');
      expect(node?.params.flow).toBe('xtls-rprx-vision');
    });

    it('ws-opts 的 path 与 Host 请求头映射到传输层', () => {
      const node = parseUpstreamContent(MIHOMO_SAMPLE).nodes.find((item) => item.name === '🇸🇬 新加坡 WS');
      expect(node?.params.transport).toMatchObject({ type: 'ws', path: '/ray', host: 'cdn.example.com' });
      expect(node?.params.tls).toMatchObject({ enabled: true, mode: 'tls', serverName: 'cdn.example.com', insecure: true });
    });

    it('hysteria2 的带宽字符串与 obfs 正确解析', () => {
      const node = parseUpstreamContent(MIHOMO_SAMPLE).nodes.find((item) => item.name === '🇺🇸 洛杉矶 Hy2');
      expect(node?.params).toMatchObject({
        password: 'hy2-password',
        upMbps: 100,
        downMbps: 200,
        obfs: { type: 'salamander', password: 'obfs-secret' }
      });
    });

    it('不支持的协议与残缺节点进入跳过清单并带明确原因', () => {
      const { skipped } = parseUpstreamContent(MIHOMO_SAMPLE);
      const byName = new Map(skipped.map((item) => [item.name, item]));
      expect(byName.get('🇷🇺 SS-legacy')?.reason).toBe('UNSUPPORTED_PROTOCOL');
      expect(byName.get('坏节点 无地址')?.reason).toBe('MISSING_SERVER');
      expect(byName.get('坏节点 无凭据')?.reason).toBe('MISSING_CREDENTIAL');
    });

    it('空输入不抛异常，返回空结果', () => {
      expect(parseMihomoProxies([]).nodes).toEqual([]);
      expect(parseMihomoProxies(null).nodes).toEqual([]);
      expect(parseMihomoProxies(undefined).nodes).toEqual([]);
    });
  });

  describe('sing-box 解析', () => {
    it('识别 sing-box 格式，解析代理出站并静默跳过结构性出站', () => {
      const parsed = parseUpstreamContent(SINGBOX_SAMPLE);
      expect(parsed.format).toBe('SINGBOX');
      expect(parsed.nodes.map((node) => node.name)).toEqual(['JP Reality', 'HK Trojan WS', 'SG SS']);
      // selector / direct / block 属结构性出站，不应污染跳过清单
      expect(parsed.skipped.map((item) => item.name)).toEqual(['WG']);
      expect(parsed.skipped[0].reason).toBe('UNSUPPORTED_PROTOCOL');
    });

    it('snake_case 的 Reality 与 transport 字段正确映射', () => {
      const parsed = parseUpstreamContent(SINGBOX_SAMPLE);
      const jp = parsed.nodes.find((node) => node.name === 'JP Reality');
      expect(jp?.params.tls).toMatchObject({
        mode: 'reality',
        serverName: 'www.microsoft.com',
        reality: { publicKey: 'PUBKEY_BBBB', shortIds: ['aabbccdd'] }
      });
      const hk = parsed.nodes.find((node) => node.name === 'HK Trojan WS');
      expect(hk?.params.transport).toMatchObject({ type: 'ws', path: '/trojan', host: 'hk2.example.com' });
      expect(hk?.params.tls).toMatchObject({ enabled: true, mode: 'tls', alpn: ['h2', 'http/1.1'] });
    });

    it('looksLikeSingboxConfig 只认顶层含 outbounds 数组的对象', () => {
      expect(looksLikeSingboxConfig({ outbounds: [] })).toBe(true);
      expect(looksLikeSingboxConfig({ inbounds: [] })).toBe(false);
      expect(looksLikeSingboxConfig([])).toBe(false);
      expect(parseSingboxOutbounds('nope').nodes).toEqual([]);
    });
  });

  describe('URI 列表解析', () => {
    it('解析明文 URI 列表的六种协议', () => {
      const parsed = parseUpstreamContent(URI_LIST_SAMPLE);
      expect(parsed.format).toBe('BASE64_URI');
      expect(parsed.nodes.map((node) => node.protocolType).sort()).toEqual([
        'HYSTERIA2', 'SHADOWSOCKS', 'TROJAN', 'TUIC', 'VLESS', 'VMESS'
      ]);
    });

    it('vless Reality URI 的 pbk/sid/sni 映射为 Reality 客户端参数', () => {
      const node = parseUpstreamContent(URI_LIST_SAMPLE).nodes.find((item) => item.name === 'URI JP');
      expect(node).toMatchObject({ protocolType: 'VLESS', server: 'uri-jp.example.com', port: 443 });
      expect(node?.params.uuid).toBe('66666666-6666-4666-8666-666666666666');
      expect(node?.params.tls).toMatchObject({
        mode: 'reality',
        serverName: 'www.apple.com',
        reality: { publicKey: 'PUBKEY_CCCC', shortIds: ['deadbeef'] }
      });
    });

    it('tuic URI 的 uuid 与 password 分别落在正确字段', () => {
      const node = parseUpstreamContent(URI_LIST_SAMPLE).nodes.find((item) => item.name === 'URI DE');
      expect(node?.params.uuid).toBe('77777777-7777-4777-8777-777777777777');
      expect(node?.params.password).toBe('tuic-uri-pass');
      expect(node?.params.congestionControl).toBe('bbr');
    });

    it('hy2 URI 的带宽与 obfs 参数被解析', () => {
      const node = parseUpstreamContent(URI_LIST_SAMPLE).nodes.find((item) => item.name === 'URI US');
      expect(node?.params).toMatchObject({
        password: 'hy2-uri-pass',
        upMbps: 50,
        downMbps: 100,
        obfs: { type: 'salamander', password: 'obfs-uri' }
      });
    });

    it('ss URI 同时支持 base64url userinfo 与旧式整体编码', () => {
      const modern = parseUpstreamContent(URI_LIST_SAMPLE).nodes.find((item) => item.name === 'URI SG');
      expect(modern?.params).toMatchObject({ method: '2022-blake3-aes-128-gcm', password: 'ss-uri-pass' });

      const legacyPayload = Buffer.from('aes-256-gcm:legacy-pass@legacy.example.com:8388', 'utf8').toString('base64');
      const legacy = parseUriList(`ss://${legacyPayload}#Legacy`).nodes[0];
      expect(legacy).toMatchObject({ server: 'legacy.example.com', port: 8388, protocolType: 'SHADOWSOCKS' });
      expect(legacy.params).toMatchObject({ method: 'aes-256-gcm', password: 'legacy-pass' });
    });

    it('不支持的 scheme 进入跳过清单', () => {
      const skipped = parseUriList('ssr://whatever\n').skipped;
      expect(skipped).toEqual([expect.objectContaining({ reason: 'UNSUPPORTED_PROTOCOL', detail: 'ssr' })]);
    });

    it('整体 Base64 编码的 URI 列表可被识别', () => {
      const encoded = Buffer.from(URI_LIST_SAMPLE, 'utf8').toString('base64');
      const parsed = parseUpstreamContent(encoded);
      expect(parsed.format).toBe('BASE64_URI');
      expect(parsed.nodes.length).toBe(6);
    });
  });

  describe('entryKey 稳定性与凭据解耦', () => {
    it('凭据轮换不改变 entryKey，保证线路不被判定为孤儿', () => {
      const base = { protocolType: 'TROJAN' as const, server: 'hk.example.com', port: 443 };
      const paramsBefore = parseUpstreamContent(URI_LIST_SAMPLE).nodes
        .find((node) => node.name === 'URI HK')!.params;
      const paramsAfter = { ...paramsBefore, password: 'ROTATED-PASSWORD' };

      expect(computeEntryKey({ ...base, params: paramsBefore }))
        .toBe(computeEntryKey({ ...base, params: paramsAfter }));
    });

    it('不同服务器、端口、传输路径或 Reality 公钥产生不同 entryKey', () => {
      const params = parseUpstreamContent(URI_LIST_SAMPLE).nodes
        .find((node) => node.name === 'URI JP')!.params;
      const base = { protocolType: 'VLESS' as const, server: 'a.example.com', port: 443, params };

      const keys = new Set([
        computeEntryKey(base),
        computeEntryKey({ ...base, server: 'b.example.com' }),
        computeEntryKey({ ...base, port: 8443 }),
        computeEntryKey({ ...base, params: { ...params, transport: { type: 'ws', path: '/x' } } }),
        computeEntryKey({ ...base, params: { ...params, tls: { ...params.tls, reality: { publicKey: 'OTHER', shortIds: [] } } } })
      ]);
      expect(keys.size).toBe(5);
    });

    it('解析产物经加密落库后可完整还原，且与出站凭证三元组一致', () => {
      const node = parseUpstreamContent(URI_LIST_SAMPLE).nodes.find((item) => item.name === 'URI HK')!;
      const stored = JSON.stringify(protectEntryParams(node.params));

      expect(revealEntryParams(stored)).toEqual(node.params);
      expect(resolveUpstreamCredentials({ id: 'e1', name: node.name, paramsJson: stored })).toEqual({
        uuid: 'e1',
        email: node.name,
        secret: 'trojan-uri-pass'
      });
    });
  });

  describe('格式识别与 proxy-providers', () => {
    it('无法识别的内容抛出带原因的格式错误', () => {
      expect(() => parseUpstreamContent('hello world')).toThrow(UpstreamFormatError);
      expect(() => parseUpstreamContent('   ')).toThrow('订阅内容为空');
    });

    it('抽取 proxy-providers 的远程地址并去重', () => {
      expect(extractProxyProviderUrls(MIHOMO_SAMPLE)).toEqual([
        'https://sub.example.com/api/v1/client/subscribe?token=secret-token'
      ]);
      expect(extractProxyProviderUrls('proxies: []')).toEqual([]);
      expect(extractProxyProviderUrls('not: [valid')).toEqual([]);
    });

    it('同 key 的重复节点被去重并记录原因', () => {
      const duplicated = parseMihomoProxies([
        { name: 'A', type: 'trojan', server: 'dup.example.com', port: 443, password: 'p' },
        { name: 'B', type: 'trojan', server: 'dup.example.com', port: 443, password: 'p' }
      ]);
      expect(duplicated.nodes.map((node) => node.name)).toEqual(['A']);
      expect(duplicated.skipped).toEqual([
        expect.objectContaining({ name: 'B', reason: 'DUPLICATE' })
      ]);
    });
  });
});
