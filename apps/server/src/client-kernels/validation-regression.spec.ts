import { ClientKernelsService } from './client-kernels.service';
import * as processRunner from './kernel-process';

describe('preview validation resource regression', () => {
  afterEach(() => jest.restoreAllMocks());
  function service() {
    const service = new ClientKernelsService();
    jest.spyOn(service, 'resolve').mockResolvedValue({ path: 'unused', version: '1.19.30' });
    jest.spyOn(processRunner, 'runKernelCommand').mockResolvedValue({ code: 0, output: '' });
    return service;
  }
  it('does not confuse a sing-box inline rule-set with an external file', async () => {
    const check = await service().validate('SINGBOX', JSON.stringify({ route: { rule_set: [{ type: 'inline', tag: 'local', rules: [{ domain_suffix: ['example.com'] }] }] } }));
    expect(check).toMatchObject({ status: 'PASSED', executed: true });
  });
  it('reports remote providers with safe locations instead of the source URL', async () => {
    const check = await service().validate('MIHOMO', JSON.stringify({ 'rule-providers': { 'secret-name': { type: 'http', url: 'https://user:secret@example.com/rules?token=secret' } } }));
    expect(check).toMatchObject({ status: 'EXTERNAL_RESOURCES_REQUIRED', executed: false,
      resourceRequirements: [expect.objectContaining({ kind: 'RULE_PROVIDER', location: 'rule-providers[0]', state: 'REMOTE_DISABLED' })] });
    expect(JSON.stringify(check)).not.toContain('secret');
    expect(processRunner.runKernelCommand).not.toHaveBeenCalled();
  });
  it('does not interpret unrelated local/remote type metadata as a resource', async () => {
    expect(await service().validate('MIHOMO', JSON.stringify({ metadata: { type: 'local' }, rules: ['MATCH,DIRECT'] }))).toMatchObject({ status: 'PASSED', executed: true });
  });
  it('rejects duplicate YAML keys as invalid configuration before dependency analysis', async () => {
    expect(await service().validate('MIHOMO', 'rules: []\nrules: [GEOIP,CN,DIRECT]\n')).toMatchObject({ status: 'FAILED', executed: false, diagnostics: ['INVALID_CONFIG'] });
    expect(processRunner.runKernelCommand).not.toHaveBeenCalled();
  });
});
