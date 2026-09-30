import { BadRequestException } from '@nestjs/common';
import {
  buildClientTls,
  formatAuthUserName,
  buildClientTransport,
  buildProxyPoolWhitelistRules,
  buildShadowsocksClientPassword,
  buildServerInbound,
  buildServerInbounds,
  buildServerMasquerade,
  buildServerMultiplex,
  buildSharedListenFields,
  generateRealityKeypair,
  InboundMultiplexConfig,
  normalizeMultiplex,
  normalizeShadowsocksPassword,
  normalizeInboundParams,
  protectInboundSecrets,
  parseDest,
  REALITY_DEFAULTS,
  revealInboundSecrets,
  resolveShadowsocksUserPassword,
  SS_DEFAULT_METHOD
} from './inbound';

const users = [
  { uuid: 'uuid-1', email: 'a@x.com', credential: 'pwd-1' },
  { uuid: 'uuid-2', email: 'b@x.com', credential: 'pwd-2' }
];

describe('generateRealityKeypair', () => {
  it('生成 32 字节裸密钥的 base64url（sing-box 内核可解析，非 PEM）', () => {
    const { privateKey, publicKey } = generateRealityKeypair();
    for (const key of [privateKey, publicKey]) {
      expect(key).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(Buffer.from(key, 'base64url').length).toBe(32);
    }
  });
});

describe('parseDest', () => {
  it('解析 host:port', () => {
    expect(parseDest('www.apple.com:443')).toEqual({ host: 'www.apple.com', port: 443 });
  });

  it('非法格式抛出 BadRequest', () => {
    for (const bad of ['apple.com', 'host:0', 'host:99999', ':443']) {
      expect(() => parseDest(bad)).toThrow(BadRequestException);
    }
  });
});

describe('normalizeInboundParams', () => {
  it('VLESS 缺省密钥时自动生成 Reality 密钥对并填充默认值', () => {
    const params = normalizeInboundParams('VLESS', {}) as {
      flow: string;
      transport: { type: string };
      tls: {
        mode: string;
        reality: {
          privateKey: string;
          publicKey: string;
          serverNames: string[];
          dest: string;
          shortIds: string[];
        };
      };
    };
    expect(params.tls.mode).toBe('reality');
    expect(params.tls.reality.privateKey).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(params.tls.reality.publicKey).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(params.tls.reality.serverNames).toEqual(REALITY_DEFAULTS.serverNames);
    expect(params.tls.reality.dest).toBe(REALITY_DEFAULTS.dest);
    expect(params.tls.reality.shortIds).toEqual(REALITY_DEFAULTS.shortIds);
    expect(params.flow).toBe(REALITY_DEFAULTS.flow);
  });

  it('VLESS Reality 密钥只提供一半时抛出 BadRequest', () => {
    expect(() =>
      normalizeInboundParams('VLESS', {
        tls: { mode: 'reality', reality: { privateKey: 'only-priv' } }
      })
    ).toThrow(BadRequestException);
  });

  it('VLESS 关闭 TLS 时自动移除 Vision flow', () => {
    const params = normalizeInboundParams('VLESS', {
      flow: 'xtls-rprx-vision',
      tls: { enabled: false, mode: 'none' }
    }) as { flow?: string; tls: { enabled: boolean; mode: string } };

    expect(params.flow).toBeUndefined();
    expect(params.tls).toEqual({ enabled: false, mode: 'none' });
  });

  it('VLESS 非法 dest 提前抛出 BadRequest', () => {
    expect(() =>
      normalizeInboundParams('VLESS', {
        tls: { mode: 'reality', reality: { dest: 'no-port' } }
      })
    ).toThrow(BadRequestException);
  });

  it('HYSTERIA2 校验 TLS 必填项并填充 h3 alpn', () => {
    const tls = { serverName: 'hy.example.com', certificatePath: '/c.pem', keyPath: '/k.pem' };
    const params = normalizeInboundParams('HYSTERIA2', { upMbps: 100, tls }) as {
      upMbps: number;
      downMbps: number;
      tls: { alpn: string[]; insecure: boolean };
    };
    expect(params.upMbps).toBe(100);
    expect(params.downMbps).toBe(0);
    expect(params.tls.alpn).toEqual(['h3']);
    expect(params.tls.insecure).toBe(false);
  });

  it('TLS ALPN 默认值会按传输层匹配并允许显式清空', () => {
    const websocket = normalizeInboundParams('VLESS', {
      transport: { type: 'ws' },
      tls: { mode: 'tls', certificatePath: '/c.pem', keyPath: '/k.pem' }
    }) as { tls: { alpn: string[] } };
    const grpc = normalizeInboundParams('VMESS', {
      transport: { type: 'grpc' },
      tls: { mode: 'tls', certificatePath: '/c.pem', keyPath: '/k.pem' }
    }) as { tls: { alpn: string[] } };
    const tcp = normalizeInboundParams('TROJAN', {
      tls: { mode: 'tls', certificatePath: '/c.pem', keyPath: '/k.pem' }
    }) as { tls: { alpn: string[] } };
    const empty = normalizeInboundParams('TROJAN', {
      tls: { mode: 'tls', certificatePath: '/c.pem', keyPath: '/k.pem', alpn: [] }
    }) as { tls: { alpn: string[] } };

    expect(websocket.tls.alpn).toEqual(['http/1.1']);
    expect(grpc.tls.alpn).toEqual(['h2']);
    expect(tcp.tls.alpn).toEqual(['h2', 'http/1.1']);
    expect(empty.tls.alpn).toEqual([]);
  });

  it('HYSTERIA2 缺少证书路径抛出 BadRequest', () => {
    expect(() =>
      normalizeInboundParams('HYSTERIA2', { tls: { serverName: 'x' } })
    ).toThrow(BadRequestException);
  });

  it('SHADOWSOCKS 缺省密码按方法长度自动生成 base64 密钥', () => {
    const params = normalizeInboundParams('SHADOWSOCKS', {}) as {
      method: string;
      password: string;
      mode: string;
    };
    expect(params.method).toBe(SS_DEFAULT_METHOD);
    expect(Buffer.from(params.password, 'base64').length).toBe(16);
    expect(params.mode).toBe('shared');
  });

  it('SHADOWSOCKS 2022 会把普通密码归一化为固定长度 Base64 密钥', () => {
    const params = normalizeInboundParams('SHADOWSOCKS', {
      method: '2022-blake3-aes-128-gcm',
      password: 'plain-password',
      mode: 'multi-user'
    }) as { password: string; mode: string };

    expect(params.mode).toBe('multi-user');
    expect(Buffer.from(params.password, 'base64').length).toBe(16);
    expect(params.password).not.toBe('plain-password');
  });

  it('SHADOWSOCKS 2022 客户端凭证组合服务端密钥和用户密钥', () => {
    const serverPassword = normalizeShadowsocksPassword('2022-blake3-aes-128-gcm', 'server-password');
    const userPassword = resolveShadowsocksUserPassword('2022-blake3-aes-128-gcm', 'pwd-1', 'uuid-1');
    expect(buildShadowsocksClientPassword(
      '2022-blake3-aes-128-gcm',
      'server-password',
      'pwd-1',
      'uuid-1'
    )).toBe(`${serverPassword}:${userPassword}`);
  });

  it('TROJAN 协议必须配置 TLS', () => {
    expect(() => normalizeInboundParams('TROJAN', { tls: { enabled: false } })).toThrow(
      BadRequestException
    );
  });

  it('客户端 WebSocket Host 统一映射到 headers.Host', () => {
    expect(buildClientTransport({ type: 'ws', path: '/proxy', host: 'cdn.example.com' })).toEqual({
      type: 'ws',
      path: '/proxy',
      headers: { Host: 'cdn.example.com' }
    });
  });

  it('客户端 Reality TLS 携带公钥、Short ID 与 uTLS', () => {
    expect(buildClientTls({
      enabled: true,
      mode: 'reality',
      serverName: 'www.apple.com',
      reality: {
        dest: 'www.apple.com:443',
        serverNames: ['www.apple.com'],
        privateKey: 'private',
        publicKey: 'public',
        shortIds: ['0123456789abcdef']
      }
    })).toEqual({
      enabled: true,
      server_name: 'www.apple.com',
      utls: { enabled: true, fingerprint: 'chrome' },
      reality: { enabled: true, public_key: 'public', short_id: '0123456789abcdef' }
    });
  });

  it('NaiveProxy 客户端 TLS 不输出不支持的 insecure 字段', () => {
    expect(buildClientTls({
      enabled: true,
      mode: 'tls',
      serverName: 'naive.example.com',
      certificatePath: '/tmp/test.crt',
      keyPath: '/tmp/test.key',
      insecure: true
    }, null, { includeAlpn: false, includeInsecure: false })).toEqual({
      enabled: true,
      server_name: 'naive.example.com'
    });
  });

  it('不支持的协议抛出 BadRequest', () => {
    expect(() => normalizeInboundParams('UNKNOWN_PROTO' as never, {})).toThrow(BadRequestException);
  });
});

describe('线路敏感参数保护', () => {
  const originalKey = process.env.RIRICLOUD_ENCRYPTION_KEY;

  beforeEach(() => {
    process.env.RIRICLOUD_ENCRYPTION_KEY = 'test-inbound-secret-key';
  });

  afterAll(() => {
    if (originalKey === undefined) delete process.env.RIRICLOUD_ENCRYPTION_KEY;
    else process.env.RIRICLOUD_ENCRYPTION_KEY = originalKey;
  });

  it('数据库保存 Reality 私钥密文，Agent 配置组装时可还原', () => {
    const normalized = normalizeInboundParams('VLESS', {});
    const protectedParams = protectInboundSecrets(normalized);
    const stored = ((protectedParams.tls as Record<string, unknown>).reality as Record<string, unknown>).privateKey;
    expect(stored).toMatch(/^enc:v1:/);
    expect(revealInboundSecrets(protectedParams)).toEqual(normalized);
  });
});

describe('sanitizeInboundParams', () => {
  it('脱敏嵌套和旧版扁平 Reality 私钥', async () => {
    const { sanitizeInboundParams } = await import('./inbound');
    const sanitized = sanitizeInboundParams({
      privateKey: 'legacy-private',
      tls: { mode: 'reality', reality: { privateKey: 'nested-private', publicKey: 'public' } }
    });
    expect(sanitized).not.toHaveProperty('privateKey');
    expect((sanitized.tls as { reality: Record<string, unknown> }).reality).not.toHaveProperty('privateKey');
  });
});

describe('buildServerInbound', () => {
  const base = { tag: 'in-1', listen: '::', port: 443 };

  it('VLESS (Reality)：解析 dest 为 handshake，注入 uuid/flow 用户', () => {
    const params = normalizeInboundParams('VLESS', {
      tls: {
        mode: 'reality',
        reality: {
          dest: 'www.apple.com:8443',
          privateKey: 'priv',
          publicKey: 'pub',
          serverNames: ['sni.example.com'],
          shortIds: ['sid-1']
        }
      },
      flow: 'xtls-rprx-vision'
    });
    const inbound = buildServerInbound({ type: 'VLESS', ...base, params, users });
    expect(inbound).toMatchObject({
      type: 'vless',
      tag: 'in-1',
      listen: '::',
      listen_port: 443,
      users: [
        { uuid: 'uuid-1', name: 'a@x.com', flow: 'xtls-rprx-vision' },
        { uuid: 'uuid-2', name: 'b@x.com', flow: 'xtls-rprx-vision' }
      ],
      tls: {
        enabled: true,
        server_name: 'sni.example.com',
        reality: {
          enabled: true,
          handshake: { server: 'www.apple.com', server_port: 8443 },
          private_key: 'priv',
          short_id: ['sid-1']
        }
      }
    });
  });

  it('VLESS (WebSocket + TLS)：注入 transport 与 tls 配置', () => {
    const params = normalizeInboundParams('VLESS', {
      transport: { type: 'ws', path: '/ws-path', host: 'ws.example.com' },
      tls: {
        mode: 'tls',
        serverName: 'ws.example.com',
        certificatePath: '/cert.pem',
        keyPath: '/key.pem'
      }
    });
    const inbound = buildServerInbound({ type: 'VLESS', ...base, params, users });
    expect(inbound).toMatchObject({
      type: 'vless',
      transport: {
        type: 'ws',
        path: '/ws-path',
        headers: { Host: 'ws.example.com' }
      },
      tls: {
        enabled: true,
        server_name: 'ws.example.com',
        certificate_path: '/cert.pem',
        key_path: '/key.pem'
      }
    });
  });

  it('标准 TLS 支持以内嵌 PEM 数组下发，且不再要求 Agent 本地路径', () => {
    const params = normalizeInboundParams('VLESS', {
      tls: {
        mode: 'tls',
        serverName: 'inline.example.com',
        certificate: ['-----BEGIN CERTIFICATE-----\ncert\n-----END CERTIFICATE-----'],
        key: ['-----BEGIN PRIVATE KEY-----\nkey\n-----END PRIVATE KEY-----']
      }
    });
    const inbound = buildServerInbound({ type: 'VLESS', ...base, params, users });
    expect(inbound).toMatchObject({
      tls: {
        enabled: true,
        server_name: 'inline.example.com',
        certificate: ['-----BEGIN CERTIFICATE-----\ncert\n-----END CERTIFICATE-----'],
        key: ['-----BEGIN PRIVATE KEY-----\nkey\n-----END PRIVATE KEY-----']
      }
    });
  });

  it('HTTP 传输保留可视化配置的请求头', () => {
    const params = normalizeInboundParams('VLESS', {
      transport: { type: 'http', path: '/proxy', host: 'cdn.example.com', headers: { 'X-Line': 'demo' } },
      tls: { mode: 'none' }
    });
    const inbound = buildServerInbound({ type: 'VLESS', ...base, params, users });
    expect(inbound.transport).toEqual({ type: 'http', host: ['cdn.example.com'], path: '/proxy', headers: { 'X-Line': 'demo' } });
  });

  it('服务端组装会修复已存储的 VLESS 明文 Vision 配置', () => {
    const inbound = buildServerInbound({
      type: 'VLESS',
      ...base,
      params: {
        flow: 'xtls-rprx-vision',
        transport: { type: 'tcp' },
        tls: { enabled: false, mode: 'none' }
      },
      users
    });

    expect(inbound).not.toHaveProperty('tls');
    expect(inbound.users).toEqual([
      { uuid: 'uuid-1', name: 'a@x.com' },
      { uuid: 'uuid-2', name: 'b@x.com' }
    ]);
  });

  it('VMESS (gRPC)：注入 transport 与 alterId', () => {
    const params = normalizeInboundParams('VMESS', {
      alterId: 0,
      transport: { type: 'grpc', serviceName: 'my-grpc' }
    });
    const inbound = buildServerInbound({ type: 'VMESS', ...base, params, users });
    expect(inbound).toMatchObject({
      type: 'vmess',
      transport: { type: 'grpc', service_name: 'my-grpc' },
      users: [
        { uuid: 'uuid-1', name: 'a@x.com', alterId: 0 },
        { uuid: 'uuid-2', name: 'b@x.com', alterId: 0 }
      ]
    });
  });

  it('TROJAN：注入 password 用户凭证', () => {
    const params = normalizeInboundParams('TROJAN', {
      tls: {
        mode: 'tls',
        serverName: 'tr.example.com',
        certificatePath: '/cert.pem',
        keyPath: '/key.pem'
      }
    });
    const inbound = buildServerInbound({ type: 'TROJAN', ...base, params, users });
    expect(inbound).toMatchObject({
      type: 'trojan',
      users: [
        { password: 'pwd-1', name: 'a@x.com' },
        { password: 'pwd-2', name: 'b@x.com' }
      ]
    });
  });

  it('HYSTERIA2：证书路径与限速注入，用户密码取 credential', () => {
    const params = normalizeInboundParams('HYSTERIA2', {
      upMbps: 100,
      downMbps: 200,
      tls: { serverName: 'hy.example.com', certificatePath: '/c.pem', keyPath: '/k.pem' }
    });
    const inbound = buildServerInbound({ type: 'HYSTERIA2', ...base, params, users });
    expect(inbound).toMatchObject({
      type: 'hysteria2',
      up_mbps: 100,
      down_mbps: 200,
      users: [
        { name: 'a@x.com', password: 'pwd-1' },
        { name: 'b@x.com', password: 'pwd-2' }
      ],
      tls: { certificate_path: '/c.pem', key_path: '/k.pem' }
    });
  });

  it('TUIC：用户注入 uuid + credential，拥塞控制透传', () => {
    const params = normalizeInboundParams('TUIC', {
      congestionControl: 'cubic',
      tls: { serverName: 'tuic.example.com', certificatePath: '/c.pem', keyPath: '/k.pem' }
    });
    const inbound = buildServerInbound({ type: 'TUIC', ...base, params, users });
    expect(inbound).toMatchObject({
      type: 'tuic',
      congestion_control: 'cubic',
      users: [
        { uuid: 'uuid-1', name: 'a@x.com', password: 'pwd-1' },
        { uuid: 'uuid-2', name: 'b@x.com', password: 'pwd-2' }
      ]
    });
  });

  it('SHADOWSOCKS：共享密码模式不注入用户列表', () => {
    const params = normalizeInboundParams('SHADOWSOCKS', {
      method: 'aes-256-gcm',
      password: 'shared'
    });
    const inbound = buildServerInbound({ type: 'SHADOWSOCKS', ...base, params, users });
    expect(inbound).toMatchObject({ type: 'shadowsocks', method: 'aes-256-gcm', password: 'shared' });
    expect((inbound as Record<string, unknown>).users).toBeUndefined();
  });

  it('SHADOWTLS v3：强制内层 SS2022、生成 detour 和回环入站', () => {
    const params = normalizeInboundParams('SHADOWTLS', {
      version: 3,
      handshakeDest: 'gateway.icloud.com:443',
      inner: {
        type: 'SHADOWSOCKS',
        method: '2022-blake3-aes-128-gcm',
        password: 'inner-password'
      }
    });
    const inbound = buildServerInbound({ type: 'SHADOWTLS', ...base, params, users });
    expect(inbound).toMatchObject({
      type: 'shadowtls',
      version: 3,
      detour: 'in-1-inner',
      users: [
        { name: 'a@x.com', password: 'pwd-1' },
        { name: 'b@x.com', password: 'pwd-2' }
      ],
      handshake: { server: 'gateway.icloud.com', server_port: 443 },
      strict_mode: true
    });
    const inbounds = buildServerInbounds({ type: 'SHADOWTLS', ...base, params, users });
    expect(inbounds).toHaveLength(2);
    expect(inbounds[1]).toMatchObject({
      type: 'shadowsocks',
      tag: 'in-1-inner',
      listen: '127.0.0.1',
      listen_port: 0,
      method: '2022-blake3-aes-128-gcm'
    });
    expect(inbounds[1].password).toBe(normalizeShadowsocksPassword('2022-blake3-aes-128-gcm', 'inner-password'));
  });

  it('SHADOWTLS：拒绝旧版独立密码和非 SS2022 内层', () => {
    expect(() => buildServerInbounds({
      type: 'SHADOWTLS',
      ...base,
      params: { version: 2, handshakeDest: 'gateway.icloud.com:443', password: 'legacy-password' },
      users
    })).toThrow('ShadowTLS 仅支持 v3');
    expect(() => normalizeInboundParams('SHADOWTLS', {
      version: 2,
      handshakeDest: 'gateway.icloud.com:443',
      password: 'legacy-password'
    })).toThrow('ShadowTLS 仅支持 v3');
    expect(() => normalizeInboundParams('SHADOWTLS', {
      version: 3,
      handshakeDest: 'gateway.icloud.com:443'
    })).toThrow('必须配置内层 Shadowsocks 2022');
    expect(() => normalizeInboundParams('SHADOWTLS', {
      version: 3,
      handshakeDest: 'gateway.icloud.com:443',
      inner: { type: 'SHADOWSOCKS', method: 'aes-256-gcm', password: 'legacy' }
    })).toThrow('内层必须使用 Shadowsocks 2022 算法');
  });

  it('SHADOWSOCKS 2022 多用户为每个用户生成合法独立密钥', () => {
    const params = normalizeInboundParams('SHADOWSOCKS', {
      method: '2022-blake3-aes-128-gcm',
      password: 'server-password',
      mode: 'multi-user'
    });
    const inbound = buildServerInbound({ type: 'SHADOWSOCKS', ...base, params, users });
    const userEntries = inbound.users as Array<{ name: string; password: string }>;

    expect(userEntries).toEqual([
      { name: 'a@x.com', password: resolveShadowsocksUserPassword('2022-blake3-aes-128-gcm', 'pwd-1', 'uuid-1') },
      { name: 'b@x.com', password: resolveShadowsocksUserPassword('2022-blake3-aes-128-gcm', 'pwd-2', 'uuid-2') }
    ]);
    expect(Buffer.from((inbound.password as string), 'base64').length).toBe(16);
    expect(inbound.password).toBe(normalizeShadowsocksPassword('2022-blake3-aes-128-gcm', 'server-password'));
  });
});

describe('直连代理池（ProxyKey）入站组装', () => {
  const base = { tag: 'mixed-in', listen: '0.0.0.0', port: 10808 };
  const proxyPoolUsers = [
    { username: 'pk_0123456789abcdef01234567', password: 'pwd-a' },
    { username: 'pk_fedcba9876543210fedcba98', password: 'pwd-b' }
  ];

  it('MIXED 入站并列注入订阅用户与 ProxyKey 凭据，用户名保持冒号安全', () => {
    const params = normalizeInboundParams('MIXED', { usersEnabled: true });
    const inbound = buildServerInbound({
      type: 'MIXED',
      ...base,
      params,
      users,
      lineId: 'line-1',
      proxyPoolUsers
    });

    expect(inbound.type).toBe('mixed');
    const entries = inbound.users as Array<{ username: string; password: string }>;
    expect(entries).toEqual([
      { username: formatAuthUserName(users[0], 'line-1'), password: 'pwd-1' },
      { username: formatAuthUserName(users[1], 'line-1'), password: 'pwd-2' },
      { username: 'pk_0123456789abcdef01234567', password: 'pwd-a' },
      { username: 'pk_fedcba9876543210fedcba98', password: 'pwd-b' }
    ]);
    // HTTP CONNECT 走 net/http.parseBasicAuth（按首个冒号切分），用户名必须无冒号
    expect(entries.every((entry) => !entry.username.includes(':'))).toBe(true);
  });

  it('未启用用户认证的 MIXED 入站在注入 ProxyKey 时仍只输出代理池凭据', () => {
    const params = normalizeInboundParams('MIXED', {});
    const inbound = buildServerInbound({ type: 'MIXED', ...base, params, users, proxyPoolUsers });

    expect(inbound.users).toEqual([
      { username: 'pk_0123456789abcdef01234567', password: 'pwd-a' },
      { username: 'pk_fedcba9876543210fedcba98', password: 'pwd-b' }
    ]);
  });

  it('无任何凭据时不生成 users 字段（等价于免认证入站，由上层负责拦截）', () => {
    const params = normalizeInboundParams('MIXED', {});
    const inbound = buildServerInbound({ type: 'MIXED', ...base, params, users: [] });
    expect(inbound.users).toBeUndefined();
  });

  it('SOCKS/HTTP 入站同样支持 ProxyKey 凭据注入', () => {
    for (const type of ['SOCKS', 'HTTP'] as const) {
      const params = normalizeInboundParams(type, { usersEnabled: true });
      const inbound = buildServerInbound({ type, ...base, params, users: [], proxyPoolUsers });
      expect(inbound.type).toBe(type.toLowerCase());
      expect(inbound.users).toEqual(proxyPoolUsers.map((user) => ({ username: user.username, password: user.password })));
    }
  });

  it('默认不携带 tls 字段（标准 TCP 明文监听保证原生工具兼容）', () => {
    const params = normalizeInboundParams('MIXED', { allowLan: false });
    expect(params.tls).toBeUndefined();
    const inbound = buildServerInbound({ type: 'MIXED', ...base, params, users: [], proxyPoolUsers });
    expect(inbound.tls).toBeUndefined();
  });

  it('按需挂载标准 TLS：内嵌 PEM 数组透传为 Sing-box tls 配置块', () => {
    const params = normalizeInboundParams('MIXED', {
      allowLan: false,
      tls: {
        enabled: true,
        mode: 'tls',
        serverName: 'proxy.example.com',
        certificate: ['-----BEGIN CERTIFICATE-----'],
        key: ['-----BEGIN PRIVATE KEY-----']
      }
    });
    expect(params.tls).toEqual(expect.objectContaining({ enabled: true, mode: 'tls', serverName: 'proxy.example.com' }));

    const inbound = buildServerInbound({ type: 'MIXED', ...base, params, users: [], proxyPoolUsers });
    expect(inbound.tls).toEqual({
      enabled: true,
      server_name: 'proxy.example.com',
      certificate: ['-----BEGIN CERTIFICATE-----'],
      key: ['-----BEGIN PRIVATE KEY-----'],
      alpn: ['h2', 'http/1.1']
    });
  });
});

describe('buildProxyPoolWhitelistRules', () => {
  it('按白名单分组生成 logical/and 拒绝规则，内层 invert 只作用于来源网段', () => {
    const rules = buildProxyPoolWhitelistRules({
      tag: 'mixed-in',
      credentials: [
        { username: 'pk_a', whitelistIps: ['203.0.113.10', '198.51.100.0/24'] },
        { username: 'pk_b', whitelistIps: ['203.0.113.10', '198.51.100.0/24'] },
        { username: 'pk_c', whitelistIps: [] }
      ]
    });

    expect(rules).toHaveLength(1);
    expect(rules[0]).toEqual({
      type: 'logical',
      mode: 'and',
      rules: [
        { inbound: ['mixed-in'] },
        { auth_user: ['pk_a', 'pk_b'] },
        { source_ip_cidr: ['203.0.113.10', '198.51.100.0/24'], invert: true }
      ],
      action: 'reject'
    });
    // 顶层规则不能带 invert：否则会把其他凭据与订阅用户的流量一并拒绝
    expect(rules[0]).not.toHaveProperty('invert');
  });

  it('未配置白名单的凭据不产生任何路由规则', () => {
    expect(
      buildProxyPoolWhitelistRules({
        tag: 'mixed-in',
        credentials: [
          { username: 'pk_a', whitelistIps: [] },
          { username: '  ', whitelistIps: ['10.0.0.1'] }
        ]
      })
    ).toEqual([]);
  });
});

describe('线路网络底座与协议增强', () => {
  it('buildSharedListenFields 正确映射 TFO, MPTCP, PROXY Protocol 与 UDP 参数', () => {
    expect(buildSharedListenFields({})).toEqual({});
    expect(buildSharedListenFields({
      tcpFastOpen: true,
      tcpMultiPath: true,
      udpFragment: true,
      udpTimeout: '5m',
      proxyProtocol: true,
      proxyProtocolAcceptNoHeader: true
    })).toEqual({
      tcp_fast_open: true,
      tcp_multi_path: true,
      udp_fragment: true,
      udp_timeout: '5m',
      proxy_protocol: true,
      proxy_protocol_accept_no_header: true
    });
  });

  describe('normalizeMultiplex', () => {
    it('在未启用或格式非法时返回 undefined', () => {
      expect(normalizeMultiplex(undefined)).toBeUndefined();
      expect(normalizeMultiplex(null)).toBeUndefined();
      expect(normalizeMultiplex({ enabled: false })).toBeUndefined();
      expect(normalizeMultiplex([])).toBeUndefined();
    });

    it('支持标准 camelCase 格式解析', () => {
      const result = normalizeMultiplex({
        enabled: true,
        protocol: 'YAMUX',
        maxConnections: 8,
        minStreams: 4,
        padding: true,
        brutal: { enabled: true, upMbps: 50, downMbps: 100 }
      });
      expect(result).toEqual({
        enabled: true,
        protocol: 'yamux',
        maxConnections: 8,
        minStreams: 4,
        maxStreams: undefined,
        padding: true,
        brutal: { enabled: true, upMbps: 50, downMbps: 100 }
      });
    });

    it('兼容解析历史/前端传来的 snake_case 格式', () => {
      const result = normalizeMultiplex({
        enabled: true,
        protocol: 'SMUX',
        max_connections: 16,
        min_streams: 2,
        padding: false,
        brutal: { enabled: true, up_mbps: 30, down_mbps: 60 }
      });
      expect(result).toEqual({
        enabled: true,
        protocol: 'smux',
        maxConnections: 16,
        minStreams: 2,
        maxStreams: undefined,
        padding: false,
        brutal: { enabled: true, upMbps: 30, downMbps: 60 }
      });
    });

    it('maxConnections 与 maxStreams 互斥拦截', () => {
      expect(() => normalizeMultiplex({
        enabled: true,
        maxConnections: 4,
        maxStreams: 16
      })).toThrow(BadRequestException);
    });

    it('开启 Brutal 时若缺失速率或速率<=0 则抛出 BadRequestException 拦截', () => {
      expect(() => normalizeMultiplex({
        enabled: true,
        brutal: { enabled: true, upMbps: 0, downMbps: 100 }
      })).toThrow('TCP Brutal 强力拥塞控制必须配置大于 0 的上行速率期望');

      expect(() => normalizeMultiplex({
        enabled: true,
        brutal: { enabled: true, upMbps: 50, downMbps: 0 }
      })).toThrow('TCP Brutal 强力拥塞控制必须配置大于 0 的下行速率期望');

      expect(() => normalizeMultiplex({
        enabled: true,
        brutal: { enabled: true }
      })).toThrow('TCP Brutal 强力拥塞控制必须配置大于 0 的上行速率期望');
    });
  });

  it('buildServerMultiplex 正确输出 Inbound multiplex 配置并在速率缺失时防御', () => {
    expect(buildServerMultiplex(undefined)).toBeUndefined();
    expect(buildServerMultiplex({ enabled: false })).toBeUndefined();
    expect(buildServerMultiplex({
      enabled: true,
      padding: true,
      brutal: { enabled: true, upMbps: 100, downMbps: 200 }
    })).toEqual({
      enabled: true,
      padding: true,
      brutal: { enabled: true, up_mbps: 100, down_mbps: 200 }
    });

    // 防御脏数据：若 brutal 速率为 0 或缺失，坚决不输出破坏性 brutal 块，防止 sing-box 启动崩溃
    expect(buildServerMultiplex({
      enabled: true,
      padding: true,
      brutal: { enabled: true, upMbps: 0, downMbps: 100 } as unknown as InboundMultiplexConfig['brutal']
    })).toEqual({
      enabled: true,
      padding: true
    });
  });

  it('buildServerMasquerade 正确支持 file, proxy 与 string 伪装', () => {
    expect(buildServerMasquerade({ type: 'file', dir: '/var/www' })).toEqual({
      type: 'file',
      dir: '/var/www'
    });
    expect(buildServerMasquerade({ type: 'proxy', url: 'https://bing.com', rewriteHost: true })).toEqual({
      type: 'proxy',
      url: 'https://bing.com',
      rewrite_host: true
    });
    expect(buildServerMasquerade({ type: 'string', content: 'OK', statusCode: 200 })).toEqual({
      type: 'string',
      content: 'OK',
      status_code: 200
    });
  });

  it('buildServerInbound 注入 shared listen 与 TLS 版本/套件字段', () => {
    const baseInput = {
      tag: 'vless-in',
      listen: '0.0.0.0',
      port: 443,
      lineId: 'line-test'
    };
    const params = normalizeInboundParams('VLESS', {
      tls: {
        enabled: true,
        mode: 'reality',
        serverName: 'apple.com',
        dest: 'apple.com:443',
        minVersion: '1.2',
        maxVersion: '1.3',
        cipherSuites: ['TLS_AES_128_GCM_SHA256']
      },
      multiplex: {
        enabled: true,
        padding: false
      }
    });

    const inbound = buildServerInbound({
      type: 'VLESS',
      ...baseInput,
      params,
      users: [{ uuid: 'uuid-1', email: 'u1@x.com', credential: 'c1' }],
      listenOptions: {
        tcpFastOpen: true,
        proxyProtocol: true,
        proxyProtocolAcceptNoHeader: true
      }
    });

    expect(inbound).toMatchObject({
      type: 'vless',
      tag: 'vless-in',
      tcp_fast_open: true,
      proxy_protocol: true,
      proxy_protocol_accept_no_header: true,
      tls: expect.objectContaining({
        min_version: '1.2',
        max_version: '1.3',
        cipher_suites: ['TLS_AES_128_GCM_SHA256']
      }),
      multiplex: {
        enabled: true,
        padding: false
      }
    });
  });

  it('VLESS 采用 WebSocket 传输时强制省略 XTLS Vision 流控', () => {
    const params = normalizeInboundParams('VLESS', {
      transport: { type: 'ws', path: '/ws' },
      tls: { mode: 'tls', certificatePath: '/c.pem', keyPath: '/k.pem' },
      flow: 'xtls-rprx-vision'
    }) as { flow?: string };

    expect(params.flow).toBeUndefined();
  });

  it('SHADOWSOCKS 开启 UDP over TCP 时抑制 multiplex 配置块', () => {
    const inbound = buildServerInbound({
      type: 'SHADOWSOCKS',
      tag: 'ss-in',
      listen: '0.0.0.0',
      port: 8388,
      params: {
        method: '2022-blake3-aes-128-gcm',
        password: 'password',
        udpOverTcp: true,
        multiplex: {
          enabled: true,
          padding: true
        }
      },
      users: []
    });

    expect(inbound.udp_over_tcp).toBe(true);
    expect(inbound.multiplex).toBeUndefined();
  });
});
