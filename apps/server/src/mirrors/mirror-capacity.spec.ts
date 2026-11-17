import { ForbiddenException, Logger, ServiceUnavailableException } from '@nestjs/common';
import { EventEmitter } from 'node:events';
import type { Request, Response } from 'express';
import { RateLimitService } from '../common/rate-limit.service';
import { MirrorService } from './mirror.service';
import { MirrorCapacity, MIRROR_GLOBAL_BUFFER_BUDGET_BYTES, MIRROR_GLOBAL_TASK_LIMIT } from './mirror-capacity';
import type { MirrorStreamHandlers } from '../agent-gateway/agent.service';

jest.mock('../agent-gateway/agent.service', () => ({ AgentService: class {} }));

function browser() {
  const response = new EventEmitter() as EventEmitter & { statusCode: number; headersSent: boolean; destroyed: boolean; writableFinished: boolean; writableLength: number; end: () => void };
  Object.assign(response, { statusCode: 200, headersSent: false, destroyed: false, writableFinished: false, writableLength: 0, setHeader: () => undefined, getHeaderNames: () => [], removeHeader: () => undefined });
  response.end = () => { response.writableFinished = true; response.emit('finish'); response.emit('close'); };
  return response as unknown as Response;
}

function rateFixture() {
  const rate = new RateLimitService();
  const prisma = { mirrorSite: {
    findUnique: jest.fn(async ({ where }: { where: { slug?: string; id?: string } }) => ({ id: where.slug ?? where.id, nodeId: 'node', enabled: true, accessMode: 'PUBLIC', upstreamBaseUrl: 'https://fixture.invalid', allowedOriginsJson: '["fixture.invalid"]', node: { id: 'node', status: 'ONLINE', communicationMode: 'WS', capabilitiesJson: '["mirror_proxy"]' } })),
    update: jest.fn(async () => undefined)
  } };
  const agent = { startMirrorTask: jest.fn(async (_node: string, _request: unknown, handlers: MirrorStreamHandlers) => {
    handlers.onHeaders({ taskId: 'fixture', statusCode: 204, headers: {}, finalHost: 'fixture.invalid' });
    handlers.onEnd({ taskId: 'fixture', success: true, bytes: 0 }); return () => undefined;
  }), cancelMirrorTask: jest.fn() };
  const service = new MirrorService(prisma as never, agent as never, rate);
  const access = (site: string, ip: string, user?: string) => service.proxy(site, undefined, { method: 'GET', params: {}, headers: {}, originalUrl: '/mirror/' + site, ip, socket: {} } as Request, browser(), user ? { id: user, role: 'ADMIN' } : undefined);
  return { service, rate, agent, access };
}

describe('Master mirror bounded capacity', () => {
  beforeEach(() => { jest.useFakeTimers(); jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined); });
  afterEach(() => { jest.useRealTimers(); jest.restoreAllMocks(); });
  it('reserves the full 16 MiB budget atomically with no waiter queue', () => {
    const capacity = new MirrorCapacity();
    const leases = Array.from({ length: MIRROR_GLOBAL_TASK_LIMIT }, () => capacity.reserve());
    expect(capacity.snapshot).toEqual({ active: 16, reservedBufferBytes: MIRROR_GLOBAL_BUFFER_BUDGET_BYTES, nodes: 0 });
    expect(() => capacity.reserve()).toThrow(ServiceUnavailableException);
    leases.forEach(lease => lease.abandon());
    expect(capacity.snapshot.active).toBe(0); expect(jest.getTimerCount()).toBe(0);
  });
  it('retains a canceled-start lease until startup resolves and releases it only once', () => {
    const capacity = new MirrorCapacity(); const lease = capacity.reserve(); lease.bindNode('node');
    lease.finish(); lease.finish();
    expect(capacity.snapshot).toEqual({ active: 1, reservedBufferBytes: 1024 * 1024, nodes: 1 });
    lease.started(); lease.started(); lease.finish();
    expect(capacity.snapshot).toEqual({ active: 0, reservedBufferBytes: 0, nodes: 0 });
  });
  it('prevents delayed lookup/start from admitting new work after module shutdown', () => {
    const capacity = new MirrorCapacity(); const lease = capacity.reserve(); capacity.close();
    expect(() => lease.bindNode('node')).toThrow(ServiceUnavailableException);
    expect(() => capacity.reserve()).toThrow(ServiceUnavailableException);
    lease.abandon(); expect(capacity.snapshot.active).toBe(0);
  });
  it.each(['site', 'ip', 'user'])('enforces the existing 60/60s threshold independently per %s', async (dimension) => {
    const f = rateFixture();
    const args = (i: number): [string, string, string | undefined] => [dimension === 'site' ? 'same-site' : 'site-' + i, dimension === 'ip' ? 'same-ip' : 'ip-' + i, dimension === 'user' ? 'same-user' : undefined];
    for (let i = 0; i < 60; i++) await f.access(...args(i));
    await expect(f.access(...args(60))).rejects.toBeInstanceOf(ForbiddenException);
    expect(f.agent.startMirrorTask).toHaveBeenCalledTimes(60);
    jest.advanceTimersByTime(60_000);
    await f.access(...args(61));
    expect(f.agent.startMirrorTask).toHaveBeenCalledTimes(61);
    expect((f.service as unknown as { capacity: MirrorCapacity }).capacity.snapshot.active).toBe(0);
    expect(jest.getTimerCount()).toBe(0);
    f.service.onModuleDestroy();
  });
  it('also rate-limits administrator HEAD tests and keeps counters bounded by the existing limiter', async () => {
    const f = rateFixture();
    for (let i = 0; i < 60; i++) await f.service.test('site-' + i, { id: 'operator', role: 'ADMIN' }, 'ip-' + i);
    await expect(f.service.test('another-site', { id: 'operator', role: 'ADMIN' }, 'another-ip')).rejects.toBeInstanceOf(ForbiddenException);
    for (let i = 0; i < 10_100; i++) f.rate.consume('fixture-key-' + i, 60, 60_000);
    expect(f.rate.size).toBeLessThanOrEqual(10_000);
    expect(jest.getTimerCount()).toBe(0); f.service.onModuleDestroy();
  });
});
