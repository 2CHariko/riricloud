import { encryptSecret } from '../common/secret-crypto';
import { formatAuthUserName, parseTrafficCredential } from '../common/inbound';
import { buildSingboxJson, buildUriList, buildClashYaml } from '../subscription/builders';
import { parse } from 'yaml';
import { AgentService } from './agent-gateway.service';
import { INTERNAL_SPEEDTEST_EMAIL, INTERNAL_SPEEDTEST_UUID } from '../common/constants';

describe('AgentService per-line authorization', () => {
  const userOne = {
    uuid: '11111111-1111-4111-8111-111111111111',
    email: 'one@example.com',
    password: 'one-password',
    isActive: true
  };
  const userTwo = {
    uuid: '22222222-2222-4222-8222-222222222222',
    email: 'two@example.com',
    password: 'two-password',
    isActive: true
  };
  const vlessParams = JSON.stringify({
    flow: 'xtls-rprx-vision',
    transport: { type: 'tcp' },
    tls: {
      enabled: true,
      mode: 'reality',
      serverName: 'www.apple.com',
      reality: { dest: 'www.apple.com:443', serverNames: ['www.apple.com'], privateKey: 'private', publicKey: 'public', shortIds: ['sid'] }
    }
  });
  const line = (id: string, isPublic: boolean, tagsJson: string) => ({
    id,
    name: id,
    tag: null,
    listen: '0.0.0.0',
    type: 'DIRECT',
    relayMode: null,
    protocolType: 'VLESS',
    paramsJson: vlessParams,
    entryNodeId: 'node-1',
    entryPort: id === 'public-line' ? 24443 : 24444,
    landingNodeId: null,
    landingPort: null,
    tagsJson,
    isPublic,
    status: 'ACTIVE',
    entryNode: { status: 'ONLINE' },
    landingNode: null,
    certificate: null
  });
  const prisma = {
    node: { findUnique: jest.fn() },
    subscription: { findMany: jest.fn() },
    user: { findMany: jest.fn() }
  };

  beforeEach(() => jest.clearAllMocks());

  it('仅按套餐匹配或用户额外授权注入每条线路的凭证', async () => {
    const publicLine = line('public-line', true, '["vip"]');
    const hiddenLine = line('hidden-line', false, '["internal"]');
    prisma.node.findUnique.mockResolvedValue({
      id: 'node-1',
      serverHost: '198.51.100.10',
      status: 'ONLINE',
      configOverride: null,
      entryLines: [publicLine, hiddenLine],
      landingLines: []
    });
    prisma.subscription.findMany.mockResolvedValue([
      {
        id: 'sub-one',
        status: 'ACTIVE',
        trafficLimitBytes: 1000n,
        trafficUsedBytes: 0n,
        expireAt: null,
        user: { ...userOne, extraLineGrants: [] },
        plan: { lineMatchMode: 'TAGS', lineTagsJson: '["vip"]', lineIdsJson: '[]' }
      },
      {
        id: 'sub-two',
        status: 'ACTIVE',
        trafficLimitBytes: 1000n,
        trafficUsedBytes: 0n,
        expireAt: null,
        user: { ...userTwo, extraLineGrants: [{ lineId: 'hidden-line' }] },
        plan: { lineMatchMode: 'TAGS', lineTagsJson: '["vip"]', lineIdsJson: '[]' }
      }
    ]);

    const service = new AgentService(prisma as never);
    const result = await service.buildConfigSync('node-1');
    const inbounds = result.singboxConfig.inbounds as Array<Record<string, unknown>>;
    const publicInbound = inbounds.find((inbound) => inbound.tag === 'line-public-line');
    const hiddenInbound = inbounds.find((inbound) => inbound.tag === 'line-hidden-line');

    const speedtestUser = { uuid: INTERNAL_SPEEDTEST_UUID, name: INTERNAL_SPEEDTEST_EMAIL, flow: 'xtls-rprx-vision' };
    expect(publicInbound?.users).toEqual([
      { uuid: userOne.uuid, name: `${userOne.email}::public-line`, flow: 'xtls-rprx-vision' },
      { uuid: userTwo.uuid, name: `${userTwo.email}::public-line`, flow: 'xtls-rprx-vision' },
      speedtestUser
    ]);
    expect(hiddenInbound?.users).toEqual([
      { uuid: userTwo.uuid, name: `${userTwo.email}::hidden-line`, flow: 'xtls-rprx-vision' },
      speedtestUser
    ]);
    expect((result.singboxConfig.experimental as { v2ray_api: { stats: { users: string[] } } }).v2ray_api.stats.users)
      .toEqual([`${userOne.email}::public-line`, `${userTwo.email}::public-line`, INTERNAL_SPEEDTEST_EMAIL, `${userTwo.email}::hidden-line`]);
  });
  it('EXTERNAL 和已禁用源、到期、缺失及无用户归属的中继不生成监听', async () => {
    const upstream = { status: 'ACTIVE', presenceStatus: 'PRESENT', protocolType: 'TROJAN', serverHost: 'up.example.com', serverPort: 443, paramsJson: encryptSecret(JSON.stringify({ password: 'external-secret' })), subscription: { status: 'ACTIVE', userInfoUsedBytes: null, userInfoTotalBytes: null, userInfoExpireAt: null } };
    const base = { ...line('relay', true, '[]'), type: 'RELAY', relayMode: 'UPSTREAM_NODE', upstreamNode: upstream };
    prisma.node.findUnique.mockResolvedValue({ id: 'node-1', serverHost: 'entry.example.com', status: 'ONLINE', entryLines: [
      { ...base, id: 'external', type: 'EXTERNAL', entryNodeId: null, entryPort: null },
      { ...base, id: 'disabled-source', upstreamNode: { ...upstream, subscription: { ...upstream.subscription, status: 'DISABLED' } } },
      { ...base, id: 'expired', upstreamNode: { ...upstream, subscription: { ...upstream.subscription, userInfoExpireAt: new Date(0) } } },
      { ...base, id: 'missing', upstreamNode: { ...upstream, presenceStatus: 'MISSING' } },
      { ...base, id: 'shared-ss', protocolType: 'SHADOWSOCKS', paramsJson: JSON.stringify({ method: 'aes-256-gcm', password: 'shared' }) },
      { ...base, id: 'unauth', protocolType: 'SOCKS', paramsJson: JSON.stringify({ usersEnabled: false }) },
      { ...base, id: 'unauth-mixed', protocolType: 'MIXED', paramsJson: JSON.stringify({ usersEnabled: false }) },
      { ...base, id: 'missing-auth-mixed', protocolType: 'MIXED', paramsJson: '{}' }
    ], landingLines: [] });
    prisma.subscription.findMany.mockResolvedValue([]);
    const result = await new AgentService(prisma as never).buildConfigSync('node-1');
    expect(result.singboxConfig.inbounds).toEqual([]);
    expect(JSON.stringify(result)).not.toContain('external-secret');
  });

  it.each(['MIXED', 'SOCKS', 'HTTP', 'NAIVE'] as const)('密码协议 %s 客户端用户名和真实入站完全一致', async (protocolType) => {
    const localLine = { ...line('password-line', true, '[]'), protocolType, paramsJson: JSON.stringify({ usersEnabled: true, ...(protocolType === 'NAIVE' ? { tls: { mode: 'tls', enabled: true, certificatePath: '/cert', keyPath: '/key' } } : {}) }) };
    const upstream = { status: 'ACTIVE', presenceStatus: 'PRESENT', protocolType: 'TROJAN', serverHost: 'up.example.com', serverPort: 443, paramsJson: encryptSecret(JSON.stringify({ password: 'up-secret' })), subscription: { status: 'ACTIVE', userInfoUsedBytes: null, userInfoTotalBytes: null, userInfoExpireAt: null } };
    prisma.node.findUnique.mockResolvedValue({ id: 'node-1', serverHost: 'entry.example.com', status: 'ONLINE', entryLines: [{ ...localLine, type: 'RELAY', relayMode: 'UPSTREAM_NODE', upstreamNode: upstream }], landingLines: [] });
    prisma.subscription.findMany.mockResolvedValue([{ id: 'sub', status: 'ACTIVE', trafficLimitBytes: 1000n, trafficUsedBytes: 0n, expireAt: null, user: userOne, plan: { lineMatchMode: 'ALL', lineTagsJson: '[]', lineIdsJson: '[]' } }]);
    const config = await new AgentService(prisma as never).buildConfigSync('node-1');
    const inbound = (config.singboxConfig.inbounds as Array<{ users: Array<{ username: string }> }>)[0];
    expect(inbound.users[0].username).toBe(formatAuthUserName(userOne, 'password-line'));
    expect(inbound.users[0].username).not.toContain(':');
    expect(parseTrafficCredential(inbound.users[0].username)).toEqual({ rawCredential: userOne.email, lineId: 'password-line' });
    expect(inbound.users).toHaveLength(2);
    expect(inbound.users.some((item) => item.username.startsWith('pk_'))).toBe(false);
    expect((config.singboxConfig.experimental as { v2ray_api: { stats: { users: string[] } } }).v2ray_api.stats.users).toContain(inbound.users[0].username);
    const source = { id: localLine.id, name: 'Password line', protocolType, params: JSON.parse(localLine.paramsJson), serverHost: 'entry.example.com', serverPort: 24443 };
    const credentials = { ...userOne, credential: userOne.password };
    expect(JSON.parse(buildSingboxJson(credentials, [source])).outbounds.find((out: { tag: string }) => out.tag === source.name).username).toBe(inbound.users[0].username);
    expect(decodeURIComponent(buildUriList(credentials, [source])[0])).toContain(inbound.users[0].username);
    if (protocolType !== 'NAIVE') expect(parse(buildClashYaml(credentials, [source])).proxies[0].username).toBe(inbound.users[0].username);
  });
});
