import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ClientKernelsService } from './client-kernels.service';

const native = process.env.RUN_NATIVE_CLIENT_TESTS === '1' ? describe : describe.skip;
native('offline native template validation', () => {
  const previous = process.env.CLIENT_VALIDATION_RESOURCES_DIR;
  afterEach(() => { if (previous === undefined) delete process.env.CLIENT_VALIDATION_RESOURCES_DIR; else process.env.CLIENT_VALIDATION_RESOURCES_DIR = previous; });
  const config = (rules: string[], extra: Record<string, unknown> = {}) => JSON.stringify({ mode: 'rule', dns: { enable: false }, proxies: [], rules, ...extra });
  it.each(['skip-src-address', 'skip-dst-address'])('checks sniffer %s with offline GeoIP', async (field) => {
    const content = config(['MATCH,DIRECT'], { sniffer: { enable: true, [field]: ['geoip:cn'] } });
    expect(await new ClientKernelsService().validate('MIHOMO', content)).toMatchObject({ status: 'PASSED', executed: true });
    process.env.CLIENT_VALIDATION_RESOURCES_DIR = join(__dirname, 'missing-native-resources');
    expect(await new ClientKernelsService().validate('MIHOMO', content)).toMatchObject({ status: 'EXTERNAL_RESOURCES_REQUIRED', executed: false });
  });
  it('checks DNS geosite rules without silently downloading', async () => {
    const content = config(['MATCH,DIRECT'], { dns: { enable: true, nameserver: ['1.1.1.1'], 'enhanced-mode': 'fake-ip', 'fake-ip-filter-mode': 'rule', 'fake-ip-filter': ['GEOSITE,cn,real-ip'] } });
    expect(await new ClientKernelsService().validate('MIHOMO', content)).toMatchObject({ status: 'PASSED', executed: true });
  });
  it.each([
    ['mmdb', {}, ['GEOIP,CN,DIRECT', 'MATCH,DIRECT']],
    ['dat', { 'geodata-mode': true }, ['GEOIP,CN,DIRECT', 'MATCH,DIRECT']],
    ['geosite', {}, ['GEOSITE,cn,DIRECT', 'MATCH,DIRECT']],
    ['asn', {}, ['IP-ASN,13335,DIRECT', 'MATCH,DIRECT']],
    ['private', {}, ['GEOIP,private,DIRECT', 'MATCH,DIRECT']],
    ['nested', {}, ['AND,((NETWORK,TCP),(GEOIP,CN)),DIRECT', 'MATCH,DIRECT']]
  ])('checks %s rules using the original configuration', async (_, extra, rules) => {
    const content = config(rules as string[], extra as Record<string, unknown>);
    const check = await new ClientKernelsService().validate('MIHOMO', content);
    expect(check).toMatchObject({ status: 'PASSED', executed: true, scope: 'FULL', diagnostics: [] });
    expect(content).toBe(config(rules as string[], extra as Record<string, unknown>));
  }, 15_000);
  it('keeps missing resources unexecuted', async () => {
    process.env.CLIENT_VALIDATION_RESOURCES_DIR = join(__dirname, 'missing-native-resources');
    expect(await new ClientKernelsService().validate('MIHOMO', config(['GEOIP,CN,DIRECT']))).toMatchObject({ status: 'EXTERNAL_RESOURCES_REQUIRED', executed: false, resourceRequirements: [expect.objectContaining({ state: 'MISSING' })] });
  });
  it('validates inline rule providers without an external file', async () => {
    process.env.CLIENT_VALIDATION_RESOURCES_DIR = join(__dirname, 'missing-native-resources');
    expect(await new ClientKernelsService().validate('MIHOMO', config(['RULE-SET,inline,DIRECT', 'MATCH,DIRECT'], { 'rule-providers': { inline: { type: 'inline', behavior: 'domain', payload: ['example.com'] } } }))).toMatchObject({ status: 'PASSED', executed: true });
  });
  it('checks a controlled local rule snapshot without changing its source', async () => {
    const root = await mkdtemp(join(tmpdir(), 'riri-native-rules-'));
    process.env.CLIENT_VALIDATION_RESOURCES_DIR = root;
    try {
      await mkdir(join(root, 'rules'));
      const body = Buffer.from('payload:\n  - example.com\n');
      await writeFile(join(root, 'rules/domains.yaml'), body);
      await writeFile(join(root, 'manifest.json'), JSON.stringify({ schemaVersion: 1, files: [{ path: 'rules/domains.yaml', size: body.length, sha256: createHash('sha256').update(body).digest('hex') }] }));
      expect(await new ClientKernelsService().validate('MIHOMO', config(['RULE-SET,local,DIRECT', 'MATCH,DIRECT'], { 'rule-providers': { local: { type: 'file', path: 'rules/domains.yaml', behavior: 'domain' } } }))).toMatchObject({ status: 'PASSED', executed: true });
      expect(await readFile(join(root, 'rules/domains.yaml'))).toEqual(body);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it('never contacts remote providers or custom geodata endpoints', async () => {
    let requests = 0;
    const server = createServer((_, response) => { requests++; response.end('unexpected'); });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/private-token`;
    try {
      for (const extra of [{ 'rule-providers': { remote: { type: 'http', url, behavior: 'domain' } } }, { 'geox-url': { mmdb: url } }, { 'external-ui-url': url }]) {
        expect(await new ClientKernelsService().validate('MIHOMO', config(['MATCH,DIRECT'], extra))).toMatchObject({ status: 'EXTERNAL_RESOURCES_REQUIRED', executed: false });
      }
      expect(requests).toBe(0);
    } finally { await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
  });
  it('rejects native invalid rules without leaking input in diagnostics', async () => {
    const check = await new ClientKernelsService().validate('MIHOMO', config(['INVALID,secret,DIRECT']));
    expect(check).toMatchObject({ status: 'FAILED', executed: true, diagnostics: ['NATIVE_CONFIG_CHECK_FAILED'] });
    expect(JSON.stringify(check)).not.toContain('secret');
  });
});
