import { isMeteredUpstreamEntry, getUpstreamUnavailableReason } from './upstream-availability';
import { encryptSecret } from './secret-crypto';
import { buildServerInbound, parseTrafficCredential } from './inbound';
import { buildSingboxJson } from '../subscription/builders';

describe('上游受控入口边界', () => {
  it.each(['MIXED', 'HTTP', 'SOCKS'])('%s 只有显式开启用户鉴权才能作为计费上游入口', (type) => {
    expect(isMeteredUpstreamEntry(type, { usersEnabled: true })).toBe(true);
    for (const params of [{}, { usersEnabled: false }, { users_enabled: true }, { usersEnabled: true, users_enabled: false }]) {
      expect(isMeteredUpstreamEntry(type, params)).toBe(false);
    }
  });
  it('SS2022 共享密码仍然不可按用户计费', () => {
    expect(isMeteredUpstreamEntry('SHADOWSOCKS', { method: '2022-blake3-aes-128-gcm', mode: 'shared' })).toBe(false);
    expect(isMeteredUpstreamEntry('SHADOWSOCKS', { method: '2022-blake3-aes-128-gcm', mode: 'multi-user' })).toBe(true);
  });
  it('上游零配额不等同于已知正数配额耗尽', () => {
    const node = { status: 'ACTIVE', presenceStatus: 'PRESENT', protocolType: 'TROJAN', serverHost: 'example.com', serverPort: 443, paramsJson: encryptSecret('{"password":"test"}'), subscription: { status: 'ACTIVE', userInfoUsedBytes: 0n, userInfoTotalBytes: 0n, userInfoExpireAt: null } };
    expect(getUpstreamUnavailableReason(node)).toBeNull();
  });
  it.each(['MIXED', 'HTTP', 'SOCKS', 'NAIVE'] as const)('用户名 %s 冒号安全且客户端一致，统计可还原线路', (type) => {
    const user = { email: 'user@example.com', uuid: '11111111-2222-4333-8444-555555555555', credential: 'test-password' };
    const params = { usersEnabled: true, tls: { enabled: true, mode: 'tls', serverName: 'example.com', certificatePath: '/test/cert', keyPath: '/test/key' } };
    const inbound = buildServerInbound({ type, tag: 'entry', listen: '127.0.0.1', port: 23456, params, users: [user], lineId: 'test-line' });
    const username = (inbound.users as Array<{ username: string }>)[0].username;
    expect(username).not.toContain(':');
    const client = JSON.parse(buildSingboxJson(user, [{ id: 'test-line', name: 'test', type: 'RELAY', protocolType: type, serverHost: 'example.com', serverPort: 23456, params }]));
    expect(client.outbounds.find((out: { tag: string }) => out.tag === 'test').username).toBe(username);
    expect(parseTrafficCredential(username)).toEqual({ rawCredential: user.email, lineId: 'test-line' });
  });
});
