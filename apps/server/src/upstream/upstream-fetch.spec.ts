jest.mock('node:dns/promises', () => ({ lookup: jest.fn() }));
jest.mock('node:http', () => ({ request: jest.fn() }));
jest.mock('node:https', () => ({ request: jest.fn() }));
import { EventEmitter } from 'node:events';
import { lookup } from 'node:dns/promises';
import * as http from 'node:http';
import * as https from 'node:https';
import { fetchUpstream, isPublicUpstreamAddress, validateUpstreamHeaders, UPSTREAM_FETCH_LIMITS } from './upstream-fetch';

interface FakeResponse { status?: number; headers?: Record<string, string>; body?: Buffer; complete?: boolean; stall?: boolean }
const nativeRequest = jest.mocked(https.request);
function responses(...responses: FakeResponse[]) {
  for (const entry of responses) nativeRequest.mockImplementationOnce(((options: http.RequestOptions, callback: (response: http.IncomingMessage) => void) => {
    const request = new EventEmitter();
    const signal = options.signal;
    const abort = () => request.emit('error', new Error('private-secret-url'));
    signal?.addEventListener('abort', abort, { once: true });
    Object.assign(request, { end: () => {
      queueMicrotask(() => {
        const response = Object.assign(new EventEmitter(), { statusCode: entry.status ?? 200, headers: entry.headers ?? {}, complete: entry.complete ?? true, destroy: jest.fn() });
        callback(response as unknown as http.IncomingMessage);
        if (entry.stall) return;
        if (entry.body) response.emit('data', entry.body);
        response.emit('end');
        signal?.removeEventListener('abort', abort);
      });
    } });
    return request as unknown as http.ClientRequest;
  }) as typeof https.request);
}

describe('公共上游原生拉取', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    nativeRequest.mockReset();
    jest.mocked(lookup).mockResolvedValue([{ address: '8.8.8.8', family: 4 }] as never);
  });
  afterEach(() => jest.useRealTimers());
  it.each(['127.0.0.1', '10.1.2.3', '169.254.169.254', '100.100.100.200', '::1', 'fc00::1', 'fe80::1', '::ffff:127.0.0.1', '2001:db8::1', '2002:7f00:1::'])('拒绝私网/元数据/过渡地址 %s', (address) => {
    expect(isPublicUpstreamAddress(address)).toBe(false);
  });
  it('实际连接使用校验后地址并保留 Host 和 SNI，无第二次 DNS 查询', async () => {
    responses({ body: Buffer.from('trojan://secret'), headers: { 'subscription-userinfo': 'total=9007199254740993' } });
    const result = await fetchUpstream('https://example.com/sub?token=secret', { Authorization: 'secret' });
    expect(nativeRequest).toHaveBeenCalledWith(expect.objectContaining({ hostname: '8.8.8.8', servername: 'example.com', headers: expect.objectContaining({ Host: 'example.com', Authorization: 'secret' }) }), expect.any(Function));
    expect(lookup).toHaveBeenCalledTimes(1);
    expect(result.userInfo).toBe('total=9007199254740993');
  });
  it('逐跳 DNS 门禁拒绝重定向私网', async () => {
    responses({ status: 302, headers: { location: 'https://private.example/sub' } });
    jest.mocked(lookup).mockResolvedValueOnce([{ address: '8.8.8.8', family: 4 }] as never).mockResolvedValueOnce([{ address: '127.0.0.1', family: 4 }] as never);
    await expect(fetchUpstream('https://example.com/sub', {})).rejects.toThrow('公共');
    expect(nativeRequest).toHaveBeenCalledTimes(1);
  });
  it('跨 origin 丢弃所有自定义 Header，五次跳转封顶', async () => {
    responses({ status: 302, headers: { location: 'https://other.example/sub' } }, { body: Buffer.from('body') });
    await fetchUpstream('https://example.com/sub', { Authorization: 'secret', 'X-Custom-Token': 'secret' });
    const options = nativeRequest.mock.calls[1][0] as http.RequestOptions;
    expect(options.headers).not.toHaveProperty('Authorization');
    expect(options.headers).not.toHaveProperty('X-Custom-Token');
    expect(options.headers).toHaveProperty('Host', 'other.example');
    nativeRequest.mockReset();
    responses(...Array.from({ length: 6 }, () => ({ status: 302, headers: { location: '/again' } })));
    await expect(fetchUpstream('https://example.com/sub', {})).rejects.toThrow('超限');
    expect(nativeRequest).toHaveBeenCalledTimes(6);
  });
  it('拒绝超限、截断、压缩和 HTTP 错误，异常不含秘密', async () => {
    responses({ headers: { 'content-length': String(UPSTREAM_FETCH_LIMITS.maxBytes + 1) } }, { body: Buffer.alloc(UPSTREAM_FETCH_LIMITS.maxBytes + 1) }, { body: Buffer.from('x'), headers: { 'content-length': '2' } }, { headers: { 'content-encoding': 'gzip' } }, { status: 403 });
    for (let i = 0; i < 5; i++) await expect(fetchUpstream('https://example.com/secret', {})).rejects.toThrow();
  });
  it('DNS 与整个响应共享 20 秒总预算，关闭取消响应', async () => {
    jest.useFakeTimers();
    jest.mocked(lookup).mockImplementationOnce(() => new Promise(() => undefined));
    const timed = fetchUpstream('https://example.com/sub', {});
    const rejected = expect(timed).rejects.toThrow('超时');
    await jest.advanceTimersByTimeAsync(20_001);
    await rejected;
    responses({ stall: true });
    const controller = new AbortController();
    const pending = fetchUpstream('https://example.com/sub', {}, controller.signal);
    const cancelled = expect(pending).rejects.toThrow('取消');
    await jest.advanceTimersByTimeAsync(0);
    controller.abort();
    await cancelled;
  });
  it('Header 类型、CRLF 和 Host 覆写被拒绝', () => {
    expect(() => validateUpstreamHeaders({ Host: 'private' })).toThrow();
    expect(() => validateUpstreamHeaders({ Authorization: 'secret\r\nX: injected' })).toThrow();
    expect(() => validateUpstreamHeaders({ Authorization: 1 } as never)).toThrow();
  });
});
