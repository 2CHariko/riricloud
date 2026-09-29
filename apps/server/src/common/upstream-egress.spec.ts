import { protectEntryParams, resolveUpstreamCredentials, revealEntryParams } from './upstream-egress';

describe('upstream-egress 上游凭据保护', () => {
  const rawParams = {
    uuid: '11111111-1111-4111-8111-111111111111',
    password: 'upstream-secret',
    username: 'upstream-user',
    tls: { enabled: true, mode: 'reality', serverName: 'www.apple.com', reality: { publicKey: 'pub', shortIds: ['sid'] } }
  };

  it('落库前加密 uuid/password/username，且不改变非凭据字段', () => {
    const protectedParams = protectEntryParams(rawParams);

    for (const field of ['uuid', 'password', 'username'] as const) {
      expect(protectedParams[field]).not.toBe(rawParams[field]);
      expect(String(protectedParams[field]).startsWith('enc:v1:')).toBe(true);
    }
    // 非凭据字段保持原值，TLS/Reality 客户端字段不被破坏
    expect(protectedParams.tls).toEqual(rawParams.tls);
  });

  it('加密后可完整还原，且重复加密是幂等的', () => {
    const once = protectEntryParams(rawParams);
    const twice = protectEntryParams(once);

    expect(revealEntryParams(JSON.stringify(once))).toEqual(rawParams);
    expect(twice).toEqual(once);
  });

  it('提取出的凭证与 buildProtocolRelayOutbound 需要的三元组一致', () => {
    const entry = {
      id: 'entry-1',
      name: '🇯🇵 东京 01',
      paramsJson: JSON.stringify(protectEntryParams(rawParams))
    };

    expect(resolveUpstreamCredentials(entry)).toEqual({
      uuid: rawParams.uuid,
      email: rawParams.username,
      secret: rawParams.password
    });
  });

  it('缺失 uuid 时回退条目 id，避免生成空凭证出站', () => {
    const entry = {
      id: 'entry-fallback',
      name: '无 uuid 节点',
      paramsJson: JSON.stringify(protectEntryParams({ password: 'only-password' }))
    };

    expect(resolveUpstreamCredentials(entry)).toMatchObject({
      uuid: 'entry-fallback',
      email: '无 uuid 节点',
      secret: 'only-password'
    });
  });

  it('参数损坏或非对象时不抛异常，返回空对象', () => {
    expect(revealEntryParams('not-json')).toEqual({});
    expect(revealEntryParams('[]')).toEqual({});
    expect(revealEntryParams('null')).toEqual({});
  });
});
