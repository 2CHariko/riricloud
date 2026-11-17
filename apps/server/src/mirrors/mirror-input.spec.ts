import { BadRequestException, ConflictException, ValidationPipe } from '@nestjs/common';
import { execFileSync } from 'node:child_process';
import { lookup } from 'node:dns/promises';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { PrismaClient } from '@prisma/client';
import { CreateMirrorSiteDto, UpdateMirrorSiteDto } from './dto/mirror-site.dto';
import { MirrorService } from './mirror.service';

jest.mock('../agent-gateway/agent.service', () => ({ AgentService: class {} }));
jest.mock('node:dns/promises', () => ({ lookup: jest.fn().mockResolvedValue([{ address: '93.184.216.34', family: 4 }]) }));
const valid = { name: 'mirror', slug: 'mirror-test', upstreamBaseUrl: 'https://upstream.example/base', allowedOrigins: ['upstream.example'], nodeId: 'node-online', accessMode: 'PUBLIC' as const };
const pipe = new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true });

const invalid = [
  { name: '' }, { name: '   ' }, { name: 'x'.repeat(81) }, { name: null },
  { slug: 'ab' }, { slug: 'a'.repeat(64) }, { slug: 'UPPER' }, { slug: 'bad_slug' }, { slug: '../path' }, { slug: null },
  { upstreamBaseUrl: 'file:///etc/passwd' }, { upstreamBaseUrl: 'https://user:secret@upstream.example' },
  { upstreamBaseUrl: 'https://upstream.example?token=secret' }, { upstreamBaseUrl: 'https://upstream.example/#fragment' },
  { upstreamBaseUrl: '' }, { upstreamBaseUrl: null }, { upstreamBaseUrl: 'https://upstream.example/' + 'x'.repeat(2048) },
  { allowedOrigins: [] }, { allowedOrigins: Array.from({ length: 17 }, (_, i) => 'host' + i + '.example') },
  { allowedOrigins: ['-bad.example', 'upstream.example'] }, { allowedOrigins: ['bad-.example', 'upstream.example'] },
  { allowedOrigins: ['bad..example', 'upstream.example'] }, { allowedOrigins: ['https://upstream.example'] },
  { allowedOrigins: ['localhost', 'upstream.example'] }, { allowedOrigins: ['127.0.0.1', 'upstream.example'] },
  { allowedOrigins: ['other.example'] }, { allowedOrigins: ['x'.repeat(64) + '.example', 'upstream.example'] },
  { allowedOrigins: null }, { allowedOrigins: [42] }, { allowedOrigins: 'upstream.example' },
  { nodeId: '' }, { nodeId: '   ' }, { nodeId: null }, { nodeId: 'missing-node' },
  { accessMode: 'UNKNOWN' }, { accessMode: null }, { enabled: 'false' }, { enabled: null },
  { accessMode: 'SHARE', shareExpiresAt: 'not-a-date' }, { accessMode: 'SHARE', shareExpiresAt: '2000-01-01T00:00:00Z' }
];

describe('Mirror create/update input and SQLite uniqueness', () => {
  jest.setTimeout(120_000);
  let directory: string;
  let prisma: PrismaClient;
  let service: MirrorService;
  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'riricloud-mirror-input-'));
    const url = 'file:' + join(directory, 'mirror.db').replaceAll('\\', '/');
    prisma = new PrismaClient({ datasources: { db: { url } } });
    await prisma.$connect();
    await prisma.$executeRawUnsafe('PRAGMA user_version = 0');
    await prisma.$disconnect();
    execFileSync(process.execPath, [require.resolve('prisma/build/index.js'), 'migrate', 'deploy', '--schema', resolve('prisma/schema.prisma')], { cwd: process.cwd(), env: { ...process.env, DATABASE_URL: url }, stdio: 'pipe', timeout: 90_000 });
    await prisma.$connect();
    await prisma.node.create({ data: { id: 'node-online', name: 'Fixture', serverHost: 'upstream.example', agentToken: 'fixture-only', status: 'ONLINE', communicationMode: 'WS', capabilitiesJson: '["mirror_proxy"]' } });
    service = new MirrorService(prisma as never, { cancelMirrorTask: jest.fn() } as never, { consume: jest.fn().mockReturnValue(true) } as never);
  });
  beforeEach(async () => { await prisma.mirrorSite.deleteMany(); jest.mocked(lookup).mockResolvedValue([{ address: '93.184.216.34', family: 4 }] as never); });
  afterAll(async () => { service?.onModuleDestroy(); await prisma?.$disconnect(); if (directory) await rm(directory, { recursive: true, force: true }); });

  it.each(invalid)('rejects invalid create payload %j without persisting', async (patch) => {
    await expect(service.create({ ...valid, ...patch } as CreateMirrorSiteDto)).rejects.toBeInstanceOf(BadRequestException);
    expect(await prisma.mirrorSite.count()).toBe(0);
  });
  it.each(invalid)('rejects invalid update payload %j without changing the existing site', async (patch) => {
    const created = await service.create(valid);
    const before = await prisma.mirrorSite.findUniqueOrThrow({ where: { id: created.mirror.id } });
    await expect(service.update(created.mirror.id, patch as UpdateMirrorSiteDto)).rejects.toBeInstanceOf(BadRequestException);
    expect(await prisma.mirrorSite.findUniqueOrThrow({ where: { id: created.mirror.id } })).toEqual(before);
  });
  it.each([CreateMirrorSiteDto, UpdateMirrorSiteDto])('rejects string booleans and null optional fields through the HTTP validation pipe', async (metatype) => {
    for (const patch of [{ enabled: 'false' }, { enabled: null }, { nodeId: null }, { slug: null }]) {
      await expect(pipe.transform({ ...valid, ...patch }, { type: 'body', metatype })).rejects.toBeInstanceOf(BadRequestException);
    }
  });
  it.each(['a-b', 'a'.repeat(63)])('persists valid slug boundary %s and safe normalized fields', async (slug) => {
    const input = await pipe.transform({ ...valid, name: '  normalized  ', slug, enabled: false, allowedOrigins: ['UPSTREAM.EXAMPLE', '*.cdn.example', 'cdn.example'] }, { type: 'body', metatype: CreateMirrorSiteDto });
    const result = await service.create(input);
    expect(result.mirror.name).toBe('normalized'); expect(result.mirror.slug).toBe(slug); expect(result.mirror.enabled).toBe(false);
    expect(result.mirror.allowedOrigins).toEqual(['upstream.example', 'cdn.example']);
    const updated = await service.update(result.mirror.id, { name: 'edited', enabled: true, accessMode: 'SHARE', shareExpiresAt: '2099-01-01T00:00:00Z' });
    expect(updated.mirror.enabled).toBe(true); expect(updated.shareToken).toHaveLength(43);
    const stored = await prisma.mirrorSite.findUniqueOrThrow({ where: { id: result.mirror.id } });
    expect(stored.shareTokenHash).toHaveLength(64); expect(JSON.stringify(updated.mirror)).not.toContain(stored.shareTokenHash);
    expect((await service.update(stored.id, { shareExpiresAt: null })).mirror.shareExpiresAt).toBeNull();
    await service.update(stored.id, { accessMode: 'ADMIN' });
    expect((await prisma.mirrorSite.findUniqueOrThrow({ where: { id: stored.id } })).shareTokenHash).toBeNull();
  });
  it('maps the real SQLite unique constraint to 409 for create and update', async () => {
    const first = await service.create(valid);
    await expect(service.create(valid)).rejects.toBeInstanceOf(ConflictException);
    const second = await service.create({ ...valid, slug: 'another-site' });
    await expect(service.update(second.mirror.id, { slug: first.mirror.slug })).rejects.toBeInstanceOf(ConflictException);
    expect((await prisma.mirrorSite.findUniqueOrThrow({ where: { id: second.mirror.id } })).slug).toBe('another-site');
    expect(await prisma.mirrorSite.count()).toBe(2);
  });
  it('allows exactly one concurrent create for the same slug', async () => {
    const results = await Promise.allSettled([service.create(valid), service.create(valid)]);
    expect(results.filter((item) => item.status === 'fulfilled')).toHaveLength(1);
    const failure = results.find((item) => item.status === 'rejected') as PromiseRejectedResult;
    expect(failure.reason).toBeInstanceOf(ConflictException);
    expect(await prisma.mirrorSite.count()).toBe(1);
  });
  it.each([{ status: 'OFFLINE', communicationMode: 'WS', capabilitiesJson: '["mirror_proxy"]' }, { status: 'ONLINE', communicationMode: 'HTTP', capabilitiesJson: '["mirror_proxy"]' }, { status: 'ONLINE', communicationMode: 'WS', capabilitiesJson: 'invalid' }])('rejects unusable node for create and update %j', async (node) => {
    const created = await service.create(valid);
    await prisma.node.create({ data: { id: 'unavailable', name: 'Unavailable', serverHost: 'fixture.example', agentToken: 'fixture-unavailable', ...node } });
    try {
      await expect(service.create({ ...valid, slug: 'new-site', nodeId: 'unavailable' })).rejects.toBeInstanceOf(ConflictException);
      await expect(service.update(created.mirror.id, { nodeId: 'unavailable' })).rejects.toBeInstanceOf(ConflictException);
    } finally { await prisma.node.delete({ where: { id: 'unavailable' } }); }
  });
  it('rejects past expiry when editing an existing SHARE site without resending accessMode', async () => {
    const created = await service.create({ ...valid, accessMode: 'SHARE' });
    await expect(service.update(created.mirror.id, { shareExpiresAt: '2000-01-01T00:00:00Z' })).rejects.toBeInstanceOf(BadRequestException);
  });
  it('rejects private, mixed DNS answers and resolver failures before create/update', async () => {
    const created = await service.create(valid);
    for (const addresses of [[{ address: '127.0.0.1', family: 4 }], [{ address: '93.184.216.34', family: 4 }, { address: '169.254.169.254', family: 4 }]]) {
      jest.mocked(lookup).mockResolvedValue(addresses as never);
      await expect(service.create(valid)).rejects.toBeInstanceOf(BadRequestException);
      await expect(service.update(created.mirror.id, { name: 'edit' })).rejects.toBeInstanceOf(BadRequestException);
    }
    jest.mocked(lookup).mockRejectedValue(new Error('sensitive resolver state'));
    await expect(service.create(valid)).rejects.toBeInstanceOf(BadRequestException);
  });
  it('requires HTTPS in production for create and update', async () => {
    const created = await service.create(valid);
    const previous = process.env.RIRICLOUD_ENV; process.env.RIRICLOUD_ENV = 'production';
    try {
      await expect(service.create({ ...valid, upstreamBaseUrl: 'http://upstream.example' })).rejects.toBeInstanceOf(BadRequestException);
      await expect(service.update(created.mirror.id, { upstreamBaseUrl: 'http://upstream.example' })).rejects.toBeInstanceOf(BadRequestException);
    } finally { if (previous === undefined) delete process.env.RIRICLOUD_ENV; else process.env.RIRICLOUD_ENV = previous; }
  });
});
