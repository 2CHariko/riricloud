import assert from 'node:assert/strict';
import test from 'node:test';
import { extractResourceList, parseCookieJar } from './dev-e2e-sync-resource.mjs';

test('解析 curl Netscape Cookie jar 中的 HttpOnly 管理员 Cookie', () => {
  const token = 'jwt-cookie-token';
  const jar = [
    '# Netscape HTTP Cookie File',
    '#HttpOnly_localhost\tFALSE\t/\tTRUE\t0\triricloud_access\t' + token,
    ''
  ].join('\n');

  assert.equal(parseCookieJar(jar), `riricloud_access=${token}`);
});

test('忽略普通注释并解析非 HttpOnly Cookie', () => {
  const token = 'plain-cookie-token';
  const jar = ['# comment', `localhost\tFALSE\t/\tFALSE\t0\triricloud_access\t${token}`].join('\n');

  assert.equal(parseCookieJar(jar), `riricloud_access=${token}`);
});

test('解析分页资源列表响应中的 data 数组', () => {
  const resources = [{ id: 'release-1', kind: 'AGENT' }];

  assert.deepEqual(extractResourceList({
    data: resources,
    total: 1,
    page: 1,
    pageSize: 100,
    supportedTargets: [],
    summary: { totalBytes: 0, reclaimableBytes: 0 }
  }), resources);
});

test('兼容旧版数组格式并拒绝无效资源列表响应', () => {
  const resources = [{ id: 'release-1', kind: 'AGENT' }];

  assert.deepEqual(extractResourceList(resources), resources);
  assert.throws(() => extractResourceList({ data: null }), /资源列表响应格式无效/);
});

test('连接失败显示请求方法、路径和错误码，不输出 Cookie 或底层敏感消息', async () => {
  const { createResourceRequest } = await import('./dev-e2e-sync-resource.mjs');
  const request = createResourceRequest('http://localhost:30800', 'secret-cookie', async () => {
    throw new TypeError('fetch failed', {
      cause: new AggregateError([
        Object.assign(new Error('secret-cookie'), { code: 'ECONNREFUSED' }),
        Object.assign(new Error('private-node-address'), { code: 'ECONNREFUSED' })
      ])
    });
  });
  await assert.rejects(request('/api/v1/admin/binary-resources'), (error) => {
    assert.match(error.message, /GET \/api\/v1\/admin\/binary-resources/);
    assert.match(error.message, /ECONNREFUSED/);
    assert.match(error.message, /主控/);
    assert.doesNotMatch(error.message, /secret-cookie|private-node-address/);
    return true;
  });
});

test('上传失败和响应读取中断均有阶段信息且不会自动重试', async () => {
  const { createResourceRequest } = await import('./dev-e2e-sync-resource.mjs');
  let calls = 0;
  const request = createResourceRequest('http://localhost:30800', 'secret-cookie', async () => {
    calls += 1;
    return { text: async () => { throw new Error('private detail', { cause: { code: 'UND_ERR_SOCKET' } }); } };
  });
  await assert.rejects(request('/api/v1/admin/binary-resources/upload', { method: 'POST' }), /POST .*upload.*UND_ERR_SOCKET/);
  assert.equal(calls, 1);
});

test('同步请求有超时边界并仍传递管理员 Cookie 和解析 JSON', async () => {
  const { createResourceRequest } = await import('./dev-e2e-sync-resource.mjs');
  const request = createResourceRequest('http://localhost:30800', 'secret-cookie', async (url, init) => {
    assert.equal(url, 'http://localhost:30800/api/v1/admin/binary-resources');
    assert.equal(init.headers.Cookie, 'secret-cookie');
    assert.ok(init.signal instanceof AbortSignal);
    return { ok: true, text: async () => '{"data":[]}' };
  });
  assert.deepEqual(await request('/api/v1/admin/binary-resources'), { data: [] });
});

test('HTTP 401 不伪装为网络错误，超时错误不会泄露底层消息', async () => {
  const { createResourceRequest } = await import('./dev-e2e-sync-resource.mjs');
  const denied = createResourceRequest('http://localhost:30800', 'secret', async () => ({ ok: false, status: 401, text: async () => '{"message":"Unauthorized"}' }));
  await assert.rejects(denied('/api/v1/admin/binary-resources'), /HTTP 401/);
  const timedOut = createResourceRequest('http://localhost:30800', 'secret', async () => { throw new DOMException('private data', 'TimeoutError'); });
  await assert.rejects(timedOut('/api/v1/admin/binary-resources'), /TIMEOUT/);
});
