import { createHash } from 'node:crypto';
import { mkdtemp, writeFile, readFile, rm, mkdir, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { analyzeConfigResources } from './config-resources';
import { safeResourcePath, ValidationResourcesService } from './validation-resources.service';

describe('controlled validation resource snapshots', () => {
  let root: string;
  const previous = process.env.CLIENT_VALIDATION_RESOURCES_DIR;
  beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'riri-validation-test-')); process.env.CLIENT_VALIDATION_RESOURCES_DIR = root; });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); if (previous === undefined) delete process.env.CLIENT_VALIDATION_RESOURCES_DIR; else process.env.CLIENT_VALIDATION_RESOURCES_DIR = previous; });
  async function asset(file: string, content: string) {
    await mkdir(join(root, 'rules'), { recursive: true });
    const body = Buffer.from(content);
    await writeFile(join(root, file), body);
    await writeFile(join(root, 'manifest.json'), JSON.stringify({ schemaVersion: 1, version: 'test', files: [{ path: file, size: body.length, sha256: createHash('sha256').update(body).digest('hex') }] }));
  }
  it.each(['Country.mmdb', 'geoip.dat', 'geosite.dat', 'ASN.mmdb'])('rejects checksum-matching but noncanonical geo data %s', async (file) => {
    await asset(file, 'not a geo database');
    const rule = file === 'geosite.dat' ? 'GEOSITE,cn,DIRECT' : file === 'ASN.mmdb' ? 'IP-ASN,13335,DIRECT' : 'GEOIP,CN,DIRECT';
    const entries = analyzeConfigResources('MIHOMO', { 'geodata-mode': file === 'geoip.dat', rules: [rule] });
    expect((await new ValidationResourcesService().resolve(entries)).requirements[0].state).toBe('INVALID');
  });
  const resources = (file = 'rules/domains.yaml') => analyzeConfigResources('MIHOMO', { 'rule-providers': { local: { type: 'file', path: file, behavior: 'domain' } } });
  it('reports missing resources without silently falling back from an explicit directory', async () => {
    const check = await new ValidationResourcesService().resolve(resources());
    expect(check).toMatchObject({ blocked: true, requirements: [expect.objectContaining({ state: 'MISSING' })] });
  });
  it('validates hashes and stages immutable independent snapshots', async () => {
    await asset('rules/domains.yaml', 'payload:\n  - example.com\n');
    const check = await new ValidationResourcesService().resolve(resources());
    expect(check.blocked).toBe(false);
    const destination = join(root, 'snapshot'); await mkdir(destination);
    await writeFile(join(root, 'rules/domains.yaml'), 'changed');
    await check.prepare(destination);
    expect(await readFile(join(destination, 'rules/domains.yaml'), 'utf8')).toContain('example.com');
    expect(await readFile(join(root, 'rules/domains.yaml'), 'utf8')).toBe('changed');
  });
  it('rejects corrupted bytes and untrusted file syntax', async () => {
    await asset('rules/domains.yaml', 'payload:\n  - example.com\n');
    await writeFile(join(root, 'rules/domains.yaml'), 'corrupted');
    expect((await new ValidationResourcesService().resolve(resources())).requirements[0].state).toBe('INVALID');
    await asset('rules/domains.yaml', 'payload:\n  - GEOIP,CN,DIRECT\n');
    expect((await new ValidationResourcesService().resolve(resources())).requirements[0].state).toBe('INVALID');
  });
  it.each(['../secret', '/etc/passwd', 'C:/secret', 'rules/../../secret', 'rules\\secret', 'config.json', 'manifest.json'])('rejects unsafe path %s', async (file) => {
    expect(safeResourcePath(file)).toBe(false);
    expect((await new ValidationResourcesService().resolve(resources(file))).requirements[0].state).toBe('INVALID');
  });
  it('rejects symlink directory escapes', async () => {
    await asset('rules/domains.yaml', 'payload: [example.com]');
    const escaped = join(root, 'escaped');
    await symlink(join(root, 'rules'), escaped, process.platform === 'win32' ? 'junction' : 'dir');
    await writeFile(join(root, 'manifest.json'), JSON.stringify({ schemaVersion: 1, files: [{ path: 'escaped/domains.yaml', size: 22, sha256: 'a'.repeat(64) }] }));
    expect((await new ValidationResourcesService().resolve(resources('escaped/domains.yaml'))).requirements[0].state).toBe('INVALID');
  });
  it('caps details but never hides a blocker beyond the cap', async () => {
    const config = { 'rule-providers': Object.fromEntries(Array.from({ length: 75 }, (_, i) => [`secret-${i}`, { type: 'http', url: 'https://secret/' }])) };
    const result = await new ValidationResourcesService().resolve(analyzeConfigResources('MIHOMO', config));
    expect(result).toMatchObject({ blocked: true, truncated: 25 });
    expect(result.requirements).toHaveLength(50);
    expect(JSON.stringify(result.requirements)).not.toContain('secret');
  });
});
