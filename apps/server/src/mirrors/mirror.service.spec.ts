import { BadRequestException, ConflictException, ForbiddenException, Logger, NotFoundException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { Request, Response } from 'express';
import type { MirrorRequestData } from '../agent-gateway/agent-message';
import type { MirrorStreamHandlers } from '../agent-gateway/agent.service';
import { MirrorService } from './mirror.service';

jest.mock('../agent-gateway/agent.service', () => ({ AgentService: class {} }));
jest.mock('node:dns/promises', () => ({ lookup: jest.fn().mockResolvedValue([{ address: '93.184.216.34', family: 4 }]) }));
const hash = (token: string) => createHash('sha256').update(token).digest('hex');
const MIB = 1024 * 1024;

// 可控的浏览器写入端：writableLength 与 drain 对应尚未交付的字节。
class BrowserResponse extends EventEmitter {
  statusCode = 200;
  headersSent = false;
  destroyed = false;
  writableFinished = false;
  writableLength = 0;
  blocked = false;
  endCalls = 0;
  headers = new Map<string, string>();
  chunks: Buffer[] = [];
  jsonBody?: unknown;
  setHeader(key: string, value: string) { this.headers.set(key.toLowerCase(), value); return this; }
  getHeader(key: string) { return this.headers.get(key.toLowerCase()); }
  getHeaderNames() { return [...this.headers.keys()]; }
  removeHeader(key: string) { this.headers.delete(key.toLowerCase()); }
  status(code: number) { this.statusCode = code; return this; }
  json(body: unknown) { this.jsonBody = body; this.end(); return this; }
  write(chunk: Buffer) {
    this.headersSent = true;
    this.chunks.push(Buffer.from(chunk));
    if (this.blocked) this.writableLength += chunk.length;
    return !this.blocked;
  }
  end() {
    this.endCalls += 1;
    this.headersSent = true;
    if (!this.blocked) { this.writableFinished = true; this.emit('finish'); this.emit('close'); }
    return this;
  }
  destroy() { this.destroyed = true; this.emit('close'); return this; }
  drain() {
    this.writableLength = 0;
    this.blocked = false;
    this.emit('drain');
    if (this.endCalls && !this.writableFinished) { this.writableFinished = true; this.emit('finish'); this.emit('close'); }
  }
  asResponse() { return this as unknown as Response; }
}

function makeRequest(overrides: Record<string, unknown> = {}) {
  return { method: 'GET', params: { path: 'asset.bin' }, headers: {}, originalUrl: '/mirror/test/asset.bin', ip: '127.0.0.1', socket: {}, ...overrides } as unknown as Request;
}

function createService(overrides: Record<string, unknown> = {}) {
  let site = {
    id: 'site-1', name: 'test', slug: 'test', enabled: true, upstreamBaseUrl: 'https://upstream.example/base',
    allowedOriginsJson: '["upstream.example"]', nodeId: 'node-1', accessMode: 'PUBLIC',
    shareTokenHash: null as string | null, shareExpiresAt: null as Date | null, shareRotatedAt: null,
    lastRequestAt: null, lastStatusCode: null, lastErrorCode: null, createdAt: new Date(), updatedAt: new Date(),
    node: { id: 'node-1', name: 'node', status: 'ONLINE', communicationMode: 'WS', capabilitiesJson: '["mirror_proxy"]' },
    ...overrides
  };
  let deleted = false;
  const prisma = {
    mirrorSite: {
      findUnique: jest.fn().mockImplementation(async ({ where }: { where: Record<string, string> }) => {
        if (deleted || where.shareTokenHash && where.shareTokenHash !== site.shareTokenHash) return null;
        return { ...site };
      }),
      create: jest.fn(),
      update: jest.fn().mockImplementation(async ({ data }: { data: Partial<typeof site> }) => { site = { ...site, ...data }; return site; }),
      delete: jest.fn().mockImplementation(async () => { deleted = true; })
    },
    node: { findUnique: jest.fn().mockImplementation(async () => site.node) }
  };
  const tasks: { request: MirrorRequestData; handlers: MirrorStreamHandlers; stop: jest.Mock }[] = [];
  const agent = {
    startMirrorTask: jest.fn().mockImplementation(async (_node: string, request: MirrorRequestData, handlers: MirrorStreamHandlers) => {
      const stop = jest.fn();
      tasks.push({ request, handlers, stop });
      return stop;
    }),
    cancelMirrorTask: jest.fn()
  };
  const rateLimit = { consume: jest.fn().mockReturnValue(true) };
  const service = new MirrorService(prisma as never, agent as never, rateLimit as never);
  const response = new BrowserResponse();
  const start = (request = makeRequest(), user?: { role?: string }, token?: string) => service.proxy('test', token, request, response.asResponse(), user);
  const headers = (index = 0, statusCode = 200, values: Record<string, string> = {}) => tasks[index].handlers.onHeaders({ taskId: tasks[index].request.taskId, statusCode, headers: values, contentLength: 0, finalHost: 'upstream.example' });
  const end = (index = 0, bytes = 0) => tasks[index].handlers.onEnd({ taskId: tasks[index].request.taskId, success: true, bytes });
  const activeCount = () => [...(service as unknown as { activeTaskIds: Map<string, { size: number }> }).activeTaskIds.values()].reduce((total, active) => total + active.size, 0);
  return { service, prisma, agent, rateLimit, tasks, response, start, headers, end, activeCount };
}

async function flushPromises() { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); }

describe('MirrorService', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => { jest.useRealTimers(); jest.restoreAllMocks(); });

  it('rejects private upstream addresses before persisting', async () => {
    const { service, prisma } = createService();
    await expect(service.create({ name: 'internal', slug: 'internal-site', upstreamBaseUrl: 'http://127.0.0.1', allowedOrigins: ['upstream.example'], nodeId: 'node-1', accessMode: 'ADMIN' })).rejects.toThrow('private or metadata');
    expect(prisma.mirrorSite.create).not.toHaveBeenCalled();
  });
  it.each(['https://user:password@upstream.example', 'file:///etc/passwd'])('rejects invalid upstream %s', async (upstreamBaseUrl) => {
    const { service } = createService();
    await expect(service.create({ name: 'test', slug: 'test', upstreamBaseUrl, allowedOrigins: ['upstream.example'], nodeId: 'node-1', accessMode: 'ADMIN' })).rejects.toThrow(BadRequestException);
  });
  it.each(['../secret', '%2e%2e/secret', '%252e%252e/secret', 'https://upstream.example:444/secret', 'http://upstream.example/secret', '//evil.example/secret', 'x\\secret', 'x\0secret'])('rejects path escape %s before starting a task', async (path) => {
    const f = createService();
    await expect(f.start(makeRequest({ params: { path } }))).rejects.toThrow(BadRequestException);
    expect(f.agent.startMirrorTask).not.toHaveBeenCalled();
    expect(jest.getTimerCount()).toBe(0);
  });
  it('preserves decoded wildcard arrays, literal characters and raw query parameters', async () => {
    const f = createService();
    await f.start(makeRequest({ params: { path: ['release', 'a b?#.bin'] }, originalUrl: '/mirror/test/release/a?tag=v1%2B2&tag=v3' }));
    expect(f.tasks[0].request.url).toBe('https://upstream.example/base/release/a%20b%3F%23.bin?tag=v1%2B2&tag=v3');
    f.headers(); f.end();
  });
  it.each([undefined, { role: 'USER' }])('denies non-admin access to ADMIN mirrors', async (user) => {
    const f = createService({ accessMode: 'ADMIN' });
    await expect(f.start(makeRequest(), user)).rejects.toThrow(ForbiddenException);
    expect(f.agent.startMirrorTask).not.toHaveBeenCalled();
  });
  it.each(['ADMIN', 'PUBLIC', 'SHARE'])('permits authorized %s access', async (accessMode) => {
    const f = createService({ accessMode, shareTokenHash: hash('valid-token') });
    await f.start(makeRequest(), accessMode === 'ADMIN' ? { role: 'ADMIN' } : undefined, accessMode === 'SHARE' ? 'valid-token' : undefined);
    f.headers(); f.end();
    expect(f.response.writableFinished).toBe(true);
    expect(f.activeCount()).toBe(0);
    expect(jest.getTimerCount()).toBe(0);
  });
  it.each([{ token: undefined, expires: null }, { token: 'wrong', expires: null }, { token: 'valid-token', expires: new Date(0) }])('denies missing, guessed or expired share tokens: %j', async ({ token, expires }) => {
    const f = createService({ accessMode: 'SHARE', shareTokenHash: hash('valid-token'), shareExpiresAt: expires });
    await expect(f.start(makeRequest(), undefined, token)).rejects.toThrow(ForbiddenException);
    expect(f.agent.startMirrorTask).not.toHaveBeenCalled();
  });
  it('denies unknown access modes', async () => {
    const f = createService({ accessMode: 'UNKNOWN' });
    await expect(f.start()).rejects.toThrow(ForbiddenException);
  });
  it('denies disabled PUBLIC mirrors and rate-limited callers', async () => {
    await expect(createService({ enabled: false }).start()).rejects.toThrow(NotFoundException);
    const f = createService(); f.rateLimit.consume.mockReturnValue(false);
    await expect(f.start()).rejects.toThrow(ForbiddenException);
    expect(f.agent.startMirrorTask).not.toHaveBeenCalled();
  });
  it.each([{ status: 'OFFLINE', communicationMode: 'WS', capabilitiesJson: '["mirror_proxy"]' }, { status: 'ONLINE', communicationMode: 'HTTP', capabilitiesJson: '["mirror_proxy"]' }, { status: 'ONLINE', communicationMode: 'WS', capabilitiesJson: '[]' }])('rejects unavailable nodes: %j', async (node) => {
    const f = createService({ node });
    await expect(f.start()).rejects.toThrow(ConflictException);
    expect(f.agent.startMirrorTask).not.toHaveBeenCalled();
  });
  it('forwards only safe request headers, excluding Connection-nominated fields', async () => {
    const f = createService();
    await f.start(makeRequest({ method: 'HEAD', headers: { range: 'bytes=1-3', 'if-none-match': '"abc"', 'if-modified-since': 'date', 'if-range': '"tag"', accept: 'text/plain', 'accept-encoding': 'gzip', authorization: 'secret', cookie: 'session=secret', host: 'evil.example', connection: 'accept', 'x-agent-token': 'secret' } }));
    expect(f.tasks[0].request.method).toBe('HEAD');
    expect(f.tasks[0].request.requestHeaders).toEqual({ range: 'bytes=1-3', 'if-none-match': '"abc"', 'if-modified-since': 'date', 'if-range': '"tag"', 'accept-encoding': 'gzip' });
    f.headers(); f.end();
  });
  it.each([200, 206, 304, 404, 416, 500])('preserves upstream HTTP %i and filters response headers', async (statusCode) => {
    const f = createService(); await f.start();
    f.headers(0, statusCode, { 'content-type': 'application/octet-stream', 'content-range': 'bytes 0-2/10', etag: '"abc"', 'set-cookie': 'secret', authorization: 'secret', connection: 'etag' });
    f.end();
    expect(f.response.statusCode).toBe(statusCode);
    expect(f.response.headers).toEqual(new Map([['content-type', 'application/octet-stream'], ['content-range', 'bytes 0-2/10']]));
  });
  it('bounds a slow browser at 1 MiB and does not stop another mirror stream', async () => {
    const f = createService(); f.response.blocked = true;
    await f.start(); f.headers();
    const other = new BrowserResponse();
    await f.service.proxy('test', undefined, makeRequest(), other.asResponse()); f.headers(1);
    for (let i = 0; i < 32; i++) f.tasks[0].handlers.onChunk(Buffer.alloc(32 * 1024));
    expect(f.response.destroyed).toBe(false);
    f.tasks[0].handlers.onChunk(Buffer.from('overflow'));
    expect(f.response.destroyed).toBe(true);
    expect(f.response.writableLength).toBeLessThanOrEqual(MIB);
    expect(f.prisma.mirrorSite.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ lastErrorCode: 'SLOW_CONSUMER' }) }));
    f.tasks[1].handlers.onChunk(Buffer.from('healthy')); f.end(1, 7);
    expect(Buffer.concat(other.chunks).toString()).toBe('healthy');
    expect(other.writableFinished).toBe(true);
    expect(f.activeCount()).toBe(0);
    expect(jest.getTimerCount()).toBe(0);
  });
  it('waits for drain before writing queued chunks or ending, preserving byte order', async () => {
    const f = createService(); f.response.blocked = true;
    await f.start(); f.headers();
    f.tasks[0].handlers.onChunk(Buffer.from('first')); f.tasks[0].handlers.onChunk(Buffer.from('second')); f.end(0, 11);
    expect(f.response.chunks.map((chunk) => chunk.toString())).toEqual(['first']);
    expect(f.response.endCalls).toBe(0);
    f.response.drain();
    expect(Buffer.concat(f.response.chunks).toString()).toBe('firstsecond');
    expect(f.response.writableFinished).toBe(true);
    expect(f.prisma.mirrorSite.update).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);
  });
  it.each(['NODE_DISCONNECTED', 'RESPONSE_TOO_LARGE'])('settles %s exactly once and clears timers/listeners', async (code) => {
    const f = createService(); await f.start();
    const error = { taskId: f.tasks[0].request.taskId, code, message: 'upstream unavailable' };
    f.tasks[0].handlers.onError(error); f.tasks[0].handlers.onError(error); f.end(); f.response.emit('close');
    expect(f.prisma.mirrorSite.update).toHaveBeenCalledTimes(1);
    expect(Logger.prototype.warn).toHaveBeenCalledTimes(1);
    expect(f.activeCount()).toBe(0);
    expect(jest.getTimerCount()).toBe(0);
    for (const event of ['close', 'drain', 'finish', 'error']) expect(f.response.listenerCount(event)).toBe(0);
  });
  it.each(['close', 'timeout', 'headers'])('cleans a task that resolves start after %s', async (event) => {
    const f = createService(); let resolveStart!: (stop: () => void) => void; let handlers!: MirrorStreamHandlers;
    f.agent.startMirrorTask.mockImplementation((_node, _request, current) => { handlers = current; return new Promise((resolve) => { resolveStart = resolve; }); });
    const started = f.start(); await flushPromises();
    if (event === 'close') f.response.destroy();
    if (event === 'timeout') jest.advanceTimersByTime(600_000);
    if (event === 'headers') { handlers.onHeaders({ taskId: 'unused', statusCode: 200, headers: {}, contentLength: 0, finalHost: 'upstream.example' }); handlers.onEnd({ taskId: 'unused', success: true, bytes: 0 }); }
    const stop = jest.fn(); resolveStart(stop); await started;
    expect(stop).toHaveBeenCalledTimes(1);
    expect(f.activeCount()).toBe(0);
    expect(f.prisma.mirrorSite.update).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);
  });
  it('settles a rejected start without leaking details or waiting for close', async () => {
    const f = createService(); f.agent.startMirrorTask.mockRejectedValue(new Error('secret upstream token'));
    await f.start();
    expect(f.response.jsonBody).toEqual(expect.objectContaining({ code: 'START_FAILED' }));
    expect(JSON.stringify(f.response.jsonBody)).not.toContain('secret');
    expect(f.prisma.mirrorSite.update).toHaveBeenCalledTimes(1);
    expect(f.activeCount()).toBe(0); expect(jest.getTimerCount()).toBe(0);
  });
  it.each(['rotate', 'disable', 'delete'])('revokes active share requests on %s and rejects the old address', async (operation) => {
    const f = createService({ accessMode: 'SHARE', shareTokenHash: hash('valid-token') });
    await f.start(makeRequest(), undefined, 'valid-token');
    if (operation === 'rotate') await f.service.rotateShareToken('site-1');
    if (operation === 'disable') await f.service.update('site-1', { enabled: false });
    if (operation === 'delete') await f.service.remove('site-1');
    expect(f.activeCount()).toBe(0);
    expect(f.response.writableFinished || f.response.destroyed).toBe(true);
    expect(jest.getTimerCount()).toBe(0);
    await expect(f.service.proxy('test', 'valid-token', makeRequest(), new BrowserResponse().asResponse())).rejects.toThrow();
  });
  it.each(['HEAD', 'GET'])('never forwards bodies forbidden by method/status (%s)', async (method) => {
    const f = createService(); await f.start(makeRequest({ method })); f.headers(0, method === 'HEAD' ? 200 : 304);
    f.tasks[0].handlers.onChunk(Buffer.from('must not be sent')); f.end(0, 17);
    expect(f.response.chunks).toHaveLength(0);
    expect(f.response.writableFinished).toBe(true);
  });
  it('rejects a declared oversized body before writing headers', async () => {
    const f = createService(); await f.start();
    f.tasks[0].handlers.onHeaders({ taskId: f.tasks[0].request.taskId, statusCode: 200, headers: { 'content-length': String(257 * MIB) }, contentLength: 257 * MIB, finalHost: 'upstream.example' });
    expect(f.response.jsonBody).toEqual(expect.objectContaining({ code: 'RESPONSE_TOO_LARGE' }));
    expect(f.response.headers.has('content-length')).toBe(false);
    expect(f.tasks[0].stop).toHaveBeenCalledTimes(1);
  });
  it('enforces the body limit without trusting the advertised length or terminal byte count', async () => {
    const f = createService(); await f.start(); f.headers();
    jest.spyOn(f.response, 'write').mockImplementation(() => { f.response.headersSent = true; return true; });
    const chunk = Buffer.alloc(512 * 1024);
    for (let i = 0; i < 513; i++) f.tasks[0].handlers.onChunk(chunk);
    expect(f.response.destroyed).toBe(true);
    expect(f.prisma.mirrorSite.update).toHaveBeenLastCalledWith(expect.objectContaining({ data: expect.objectContaining({ lastErrorCode: 'RESPONSE_TOO_LARGE' }) }));
    f.end(0, 0);
    expect(f.prisma.mirrorSite.update).toHaveBeenCalledTimes(1);
  });
  it('clears prepared upstream metadata before reporting an error', async () => {
    const f = createService(); await f.start(); f.headers(0, 200, { 'content-length': '123', 'content-encoding': 'gzip', 'content-type': 'application/octet-stream' });
    f.tasks[0].handlers.onError({ taskId: 'unused', code: 'NODE_DISCONNECTED', message: 'safe error' });
    expect(f.response.jsonBody).toEqual(expect.objectContaining({ code: 'NODE_DISCONNECTED' }));
    expect(f.response.headers.has('content-length')).toBe(false);
    expect(f.response.headers.has('content-encoding')).toBe(false);
    expect(f.response.headers.get('cache-control')).toBe('no-store');
  });
  it.each(['body-before-headers', 'duplicate-headers', 'invalid-status', 'end-before-headers'])('terminates malformed event order %s', async (event) => {
    const f = createService(); await f.start();
    if (event === 'body-before-headers') f.tasks[0].handlers.onChunk(Buffer.from('bad'));
    if (event === 'duplicate-headers') { f.headers(); f.headers(); }
    if (event === 'invalid-status') f.headers(0, 999);
    if (event === 'end-before-headers') f.end();
    expect(f.response.statusCode).toBe(502);
    expect(f.prisma.mirrorSite.update).toHaveBeenCalledTimes(1);
    expect(f.activeCount()).toBe(0); expect(jest.getTimerCount()).toBe(0);
  });
  it('handles write exceptions without escaping into the gateway', async () => {
    const f = createService(); await f.start(); f.headers();
    jest.spyOn(f.response, 'write').mockImplementation(() => { throw new Error('socket closed'); });
    expect(() => f.tasks[0].handlers.onChunk(Buffer.from('data'))).not.toThrow();
    expect(f.response.jsonBody).toEqual(expect.objectContaining({ code: 'CLIENT_ERROR' }));
    expect(f.activeCount()).toBe(0); expect(jest.getTimerCount()).toBe(0);
  });
  it('times out a response still waiting for browser drain after upstream end', async () => {
    const f = createService(); f.response.blocked = true; await f.start(); f.headers();
    f.tasks[0].handlers.onChunk(Buffer.from('data')); f.end(0, 4);
    jest.advanceTimersByTime(600_000);
    expect(f.response.destroyed).toBe(true);
    expect(f.prisma.mirrorSite.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ lastErrorCode: 'TIMEOUT' }) }));
    expect(f.activeCount()).toBe(0); expect(jest.getTimerCount()).toBe(0);
  });
  it('cancels a share stream when its token expires during transfer', async () => {
    const f = createService({ accessMode: 'SHARE', shareTokenHash: hash('valid-token'), shareExpiresAt: new Date(Date.now() + 1000) });
    await f.start(makeRequest(), undefined, 'valid-token'); f.headers();
    jest.advanceTimersByTime(1000);
    expect(f.response.jsonBody).toEqual(expect.objectContaining({ code: 'TOKEN_EXPIRED' }));
    expect(f.tasks[0].stop).toHaveBeenCalledTimes(1);
    expect(f.activeCount()).toBe(0); expect(jest.getTimerCount()).toBe(0);
  });
  it('does not revoke an active stream when token persistence fails', async () => {
    const f = createService({ accessMode: 'SHARE', shareTokenHash: hash('valid-token') });
    await f.start(makeRequest(), undefined, 'valid-token');
    f.prisma.mirrorSite.update.mockRejectedValueOnce(new Error('database busy'));
    await expect(f.service.rotateShareToken('site-1')).rejects.toThrow('database busy');
    expect(f.activeCount()).toBe(1); expect(f.tasks[0].stop).not.toHaveBeenCalled();
    f.headers(); f.end();
  });
  it('re-reads a stale access lookup when revocation commits while it is pending', async () => {
    const f = createService({ accessMode: 'SHARE', shareTokenHash: hash('valid-token') });
    const snapshot = await f.prisma.mirrorSite.findUnique({ where: { id: 'site-1' } });
    let resolveLookup!: (value: typeof snapshot) => void;
    f.prisma.mirrorSite.findUnique.mockImplementationOnce(() => new Promise((resolve) => { resolveLookup = resolve; }));
    const access = f.start(makeRequest(), undefined, 'valid-token');
    await f.service.rotateShareToken('site-1'); resolveLookup(snapshot);
    await expect(access).rejects.toThrow(ForbiddenException);
    expect(f.agent.startMirrorTask).not.toHaveBeenCalled();
  });
  it('settles pending admin HEAD tests on timeout and cleans a late start', async () => {
    const f = createService(); let resolveStart!: (stop: () => void) => void;
    f.agent.startMirrorTask.mockImplementation(() => new Promise((resolve) => { resolveStart = resolve; }));
    const result = f.service.test('site-1'); await flushPromises();
    jest.advanceTimersByTime(30_000);
    await expect(result).resolves.toEqual(expect.objectContaining({ success: false, code: 'TIMEOUT' }));
    const stop = jest.fn(); resolveStart(stop); await flushPromises();
    expect(stop).toHaveBeenCalledTimes(1);
    expect(f.activeCount()).toBe(0); expect(jest.getTimerCount()).toBe(0);
  });
  it('cancels active admin tests and HTTP streams on module shutdown', async () => {
    const f = createService(); await f.start();
    const result = f.service.test('site-1'); await flushPromises();
    f.service.onModuleDestroy();
    await expect(result).resolves.toEqual(expect.objectContaining({ success: false, code: 'REVOKED' }));
    expect(f.tasks.every((task) => task.stop.mock.calls.length === 1)).toBe(true);
    expect(f.activeCount()).toBe(0); expect(jest.getTimerCount()).toBe(0);
  });

  it('also counts native HTTP framing in the pending-byte limit after write', async () => {
    const f = createService(); await f.start(); f.headers();
    jest.spyOn(f.response, 'write').mockImplementation(() => { f.response.headersSent = true; f.response.writableLength = MIB + 1; return false; });
    f.tasks[0].handlers.onChunk(Buffer.alloc(MIB));
    expect(f.response.destroyed).toBe(true);
    expect(f.prisma.mirrorSite.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ lastErrorCode: 'SLOW_CONSUMER' }) }));
    expect(f.activeCount()).toBe(0); expect(jest.getTimerCount()).toBe(0);
  });
  it('encodes literal percent signs in decoded path segments without allowing traversal', async () => {
    const f = createService(); await f.start(makeRequest({ params: { path: ['release', '100% complete.bin'] } }));
    expect(f.tasks[0].request.url).toBe('https://upstream.example/base/release/100%25%20complete.bin');
    f.headers(); f.end();
  });

  it('accepts the newly rotated token and persists only its hash', async () => {
    const f = createService({ accessMode: 'SHARE', shareTokenHash: hash('valid-token') });
    const rotated = await f.service.rotateShareToken('site-1');
    expect(rotated.shareToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(f.prisma.mirrorSite.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ shareTokenHash: hash(rotated.shareToken) }) }));
    const detail = await f.service.detail('site-1');
    expect(JSON.stringify(detail)).not.toContain('shareTokenHash');
    expect(JSON.stringify(detail)).not.toContain(rotated.shareToken);
    await f.start(makeRequest(), undefined, rotated.shareToken); f.headers(); f.end();
    expect(f.response.writableFinished).toBe(true);
    expect(f.activeCount()).toBe(0); expect(jest.getTimerCount()).toBe(0);
  });

  it('reserves at most 16 global slots before any asynchronous site lookup', async () => {
    const f = createService();
    const snapshot = await f.prisma.mirrorSite.findUnique({ where: { id: 'site-1' } });
    const resolveLookups: ((value: typeof snapshot) => void)[] = [];
    f.prisma.mirrorSite.findUnique.mockImplementation(() => new Promise((resolve) => resolveLookups.push(resolve)));
    const requests = Array.from({ length: 20 }, (_, i) => f.service.proxy('site-' + i, undefined, makeRequest(), new BrowserResponse().asResponse()));
    const results = Promise.allSettled(requests);
    await flushPromises();
    const lookupCount = f.prisma.mirrorSite.findUnique.mock.calls.length - 1;
    // 先释放全部夹具，再断言，避免旧实现在失败用例里遗留挂起请求。
    resolveLookups.forEach((resolve, i) => resolve({ ...snapshot, id: 'site-' + i, nodeId: 'node-' + i, node: { ...snapshot.node, id: 'node-' + i } }));
    const settled = await results;
    f.service.onModuleDestroy();
    expect(lookupCount).toBe(16);
    expect(settled.filter((result) => result.status === 'rejected')).toHaveLength(4);
    expect(f.tasks).toHaveLength(16);
    expect(f.activeCount()).toBe(0); expect(jest.getTimerCount()).toBe(0);
  });
  it('rejects a fifth stream for a node before sending it to the Agent and reclaims capacity', async () => {
    const f = createService();
    for (let i = 0; i < 4; i++) await f.service.proxy('test', undefined, makeRequest(), new BrowserResponse().asResponse());
    const overflow = await Promise.allSettled([f.service.proxy('test', undefined, makeRequest(), new BrowserResponse().asResponse())]);
    f.service.onModuleDestroy();
    expect(overflow[0].status).toBe('rejected');
    expect(f.tasks).toHaveLength(4);
    expect(jest.getTimerCount()).toBe(0);
  });
  it('counts HEAD diagnostics in the same global/node quota', async () => {
    const f = createService();
    for (let i = 0; i < 4; i++) await f.service.proxy('test', undefined, makeRequest(), new BrowserResponse().asResponse());
    const diagnostic = f.service.test('site-1');
    const diagnosticResult = Promise.allSettled([diagnostic]);
    await flushPromises(); f.service.onModuleDestroy();
    expect((await diagnosticResult)[0].status).toBe('rejected');
    expect(f.tasks).toHaveLength(4);
    expect(jest.getTimerCount()).toBe(0);
  });
  it('retains the global reservation while an upstream-ended response waits for drain', async () => {
    const f = createService();
    const snapshot = await f.prisma.mirrorSite.findUnique({ where: { id: 'site-1' } });
    let number = 0;
    f.prisma.mirrorSite.findUnique.mockImplementation(async () => { const i = number++; return { ...snapshot, id: 'site-' + i, nodeId: 'node-' + i }; });
    const responses: BrowserResponse[] = [];
    for (let i = 0; i < 16; i++) {
      const response = new BrowserResponse(); response.blocked = true; responses.push(response);
      await f.service.proxy('test', undefined, makeRequest(), response.asResponse()); f.headers(i);
      f.tasks[i].handlers.onChunk(Buffer.from('queued')); f.end(i, 6);
    }
    const overflow = await Promise.allSettled([f.service.proxy('test', undefined, makeRequest(), new BrowserResponse().asResponse())]);
    responses[0].drain();
    await f.service.proxy('test', undefined, makeRequest(), new BrowserResponse().asResponse());
    f.service.onModuleDestroy();
    expect(overflow[0].status).toBe('rejected');
    expect(f.tasks).toHaveLength(17);
    expect(f.activeCount()).toBe(0); expect(jest.getTimerCount()).toBe(0);
  });

  it('bounds queued chunk descriptors as well as byte buffers for a one-byte producer', async () => {
    const f = createService(); f.response.blocked = true; await f.start(); f.headers();
    for (let i = 0; i < 1026; i++) f.tasks[0].handlers.onChunk(Buffer.from('x'));
    expect(f.response.destroyed).toBe(true);
    expect(f.prisma.mirrorSite.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ lastErrorCode: 'SLOW_CONSUMER' }) }));
    expect(f.activeCount()).toBe(0); expect(jest.getTimerCount()).toBe(0);
  });
  it('does not release a canceled pending-start slot until the late stop handle is reclaimed', async () => {
    const f = createService();
    const snapshot = await f.prisma.mirrorSite.findUnique({ where: { id: 'site-1' } });
    let number = 0;
    f.prisma.mirrorSite.findUnique.mockImplementation(async () => ({ ...snapshot, id: 'site-' + number, nodeId: 'node-' + number++ }));
    const resolvers: ((stop: () => void) => void)[] = [];
    f.agent.startMirrorTask.mockImplementation(() => new Promise(resolve => resolvers.push(resolve)));
    const pending: Promise<void>[] = []; const responses: BrowserResponse[] = [];
    for (let i = 0; i < 16; i++) { const response = new BrowserResponse(); responses.push(response); pending.push(f.service.proxy('test', undefined, makeRequest(), response.asResponse())); }
    await flushPromises(); responses.forEach(response => response.destroy());
    const overflow = await Promise.allSettled([f.service.proxy('test', undefined, makeRequest(), new BrowserResponse().asResponse())]);
    const stops = resolvers.map(() => jest.fn()); resolvers.forEach((resolve, i) => resolve(stops[i]));
    await Promise.all(pending);
    expect(overflow[0].status).toBe('rejected');
    expect(stops.every(stop => stop.mock.calls.length === 1)).toBe(true);
    expect(f.activeCount()).toBe(0); expect(jest.getTimerCount()).toBe(0);
    f.service.onModuleDestroy();
  });

  it('does not retain a large incoming frame allocation through a small queued slice', async () => {
    const f = createService(); f.response.blocked = true; await f.start(); f.headers();
    const writes = jest.spyOn(f.response, 'write');
    f.tasks[0].handlers.onChunk(Buffer.from('first'));
    const frame = Buffer.alloc(4 * 1024 * 1024);
    f.tasks[0].handlers.onChunk(frame.subarray(0, 128));
    f.response.drain(); f.end(0, 133);
    const queued = writes.mock.calls[1][0];
    expect(queued.byteLength).toBe(128);
    expect(queued.buffer.byteLength).toBe(128);
    expect(f.activeCount()).toBe(0); expect(jest.getTimerCount()).toBe(0);
  });

});
