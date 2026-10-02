import { ClientKernelsService } from './client-kernels.service';
import { ResourceSemaphore, ManagedKernelProcess } from './kernel-process';
import { access, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

describe('client kernel resolution and honest validation', () => {
  const original = process.env.MIHOMO_BINARY_PATH;
  const originalResources = process.env.CLIENT_VALIDATION_RESOURCES_DIR;
  afterEach(() => { if (originalResources === undefined) delete process.env.CLIENT_VALIDATION_RESOURCES_DIR; else process.env.CLIENT_VALIDATION_RESOURCES_DIR = originalResources; });
  afterEach(() => { if (original === undefined) delete process.env.MIHOMO_BINARY_PATH; else process.env.MIHOMO_BINARY_PATH = original; jest.restoreAllMocks(); });
  it('invalid explicit binary is terminal and missing validation never passes', async () => {
    process.env.MIHOMO_BINARY_PATH = 'not-installed/mihomo';
    const service = new ClientKernelsService();
    expect(await service.resolve('MIHOMO')).toBeNull();
    expect(await service.validate('MIHOMO', '{}')).toMatchObject({ status: 'UNAVAILABLE', executed: false, scope: 'FULL' });
  });
  it('does not rewrite georules or pretend full validation without external resources', async () => {
    process.env.CLIENT_VALIDATION_RESOURCES_DIR = join(__dirname, 'not-installed-resources');
    const service = new ClientKernelsService();
    jest.spyOn(service, 'resolve').mockResolvedValue({ path: 'unused', version: '1.19.30' });
    const config = { proxies: [], rules: ['GEOSITE,cn,DIRECT', 'MATCH,DIRECT'] };
    expect(await service.validate('MIHOMO', JSON.stringify(config))).toMatchObject({ status: 'EXTERNAL_RESOURCES_REQUIRED', executed: false, scope: 'FULL' });
    expect(config.rules[0]).toBe('GEOSITE,cn,DIRECT');
  });
  it('semaphore globally limits simultaneous work and promptly removes aborted waiters', async () => {
    const slots = new ResourceSemaphore(1);
    const release = await slots.acquire();
    const controller = new AbortController();
    const queued = slots.acquire(controller.signal);
    controller.abort();
    await expect(queued).rejects.toThrow('CANCELED');
    release();
    (await slots.acquire())();
  });
  it('writes private credentials only to private temporary files and cleans on cancellation', async () => {
    const controller = new AbortController();
    const child = await ManagedKernelProcess.start(process.execPath, () => ['-e', 'setInterval(()=>{},1000)'], '{"password":"test-secret"}', controller.signal);
    const file = join(child.directory, 'config.json');
    expect(await readFile(file, 'utf8')).toContain('test-secret');
    if (process.platform !== 'win32') { expect((await stat(child.directory)).mode & 0o777).toBe(0o700); expect((await stat(file)).mode & 0o777).toBe(0o600); }
    controller.abort();
    await child.stop();
    await expect(access(child.directory)).rejects.toThrow();
  });
});
const native = process.env.RUN_NATIVE_CLIENT_TESTS === '1' ? describe : describe.skip;
native('native fixed client kernel checks', () => {
  it('resolves cwd-independent fixed Mihomo and validates minimal real configurations', async () => {
    const service = new ClientKernelsService();
    expect((await service.resolve('MIHOMO'))?.version).toBe('1.19.30');
    expect(await service.validate('MIHOMO', JSON.stringify({ mode: 'rule', dns: { enable: false }, proxies: [], rules: ['MATCH,DIRECT'] }))).toMatchObject({ status: 'PASSED', executed: true });
    expect(await service.validate('SINGBOX', JSON.stringify({ outbounds: [{ type: 'direct', tag: 'direct' }] }))).toMatchObject({ status: 'PASSED', executed: true });
  }, 15_000);
});
