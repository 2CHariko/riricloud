import { createServer, type Server } from 'node:http';
import { ClientKernelsService } from '../../client-kernels/client-kernels.service';
import { ManagedKernelProcess } from '../../client-kernels/kernel-process';
import type { ProxyConnection } from '../../common/proxy-connection';
import { ProbeService } from '../probe.service';
import { portReady } from './mihomo.executor';
import { reserveLoopbackPort, waitForKernel } from './proxy-http';
import { testCertificate } from './test-certificate';

const native = process.env.RUN_NATIVE_CLIENT_TESTS === '1' ? describe : describe.skip;
native('real capability-whitelisted Sing-box fallback', () => {
  const kernels = new ClientKernelsService();
  const engine = new ProbeService(kernels);
  let target: Server;
  let targetPort: number;
  beforeAll(async () => {
    target = createServer((_req, res) => { res.writeHead(204); res.end(); });
    targetPort = await new Promise((resolve) => target.listen(0, '127.0.0.1', () => resolve((target.address() as { port: number }).port)));
    // 回环 fixture 仅替换测试 DNS/地址策略，不绕过真实协议、内核和 HTTP 契约。
    jest.spyOn(engine.targetPolicy, 'target').mockImplementation(async (value) => ({ id: value.id, url: new URL(value.url), address: '127.0.0.1', expectedStatus: value.expectedStatus }));
    jest.spyOn(engine.targetPolicy, 'connection').mockImplementation(async (value) => value);
  });
  afterAll(async () => new Promise<void>((resolve) => target.close(() => resolve())));
  const execute = (connection: ProxyConnection, policy: 'MIHOMO_ONLY' | 'MIHOMO_PREFERRED' = 'MIHOMO_PREFERRED') => engine.executeBatch([{ subjectType: 'UPSTREAM_NODE', subjectId: 'fixture', configHash: 'fixture-v1', routeKind: 'UPSTREAM_DIRECT', connection }], { id: 'fixture-target', url: `http://target.example:${targetPort}/204`, expectedStatus: 204 }, 1_500, policy);

  it.each(['4', '4a'])('SOCKS%s runs a real request with explicit compatibility metadata', async (version) => {
    const kernel = await kernels.resolve('SINGBOX'); expect(kernel).not.toBeNull();
    const port = await reserveLoopbackPort();
    const content = JSON.stringify({ log: { disabled: true }, inbounds: [{ type: 'socks', tag: 'fixture', listen: '127.0.0.1', listen_port: port }], outbounds: [{ type: 'direct' }] });
    const fixture = await ManagedKernelProcess.start(kernel!.path, (file, directory) => ['run', '-D', directory, '-c', file], content, undefined, 15_000);
    try {
      await waitForKernel(fixture, () => portReady(port));
      const connection = { protocolType: 'SOCKS', serverHost: '127.0.0.1', serverPort: port, params: { version } };
      expect((await execute(connection))[0]).toMatchObject({ status: 'SUCCESS', engine: 'SINGBOX', mihomoCompatibility: 'UNSUPPORTED', fallbackReason: 'MIHOMO_SOCKS_VERSION_UNSUPPORTED', latencyMs: expect.any(Number) });
      expect((await execute(connection, 'MIHOMO_ONLY'))[0]).toMatchObject({ status: 'UNSUPPORTED', engine: null, latencyMs: null });
    } finally { await fixture.stop(); }
  }, 20_000);

  it('TLS certificate fallback authenticates and rejects incorrect credentials without retrying Mihomo', async () => {
    const kernel = await kernels.resolve('SINGBOX'); expect(kernel).not.toBeNull();
    const certificate = testCertificate('proxy.example');
    const port = await reserveLoopbackPort();
    const content = JSON.stringify({ log: { disabled: true }, inbounds: [{ type: 'http', tag: 'fixture', listen: '127.0.0.1', listen_port: port, users: [{ username: 'fixture', password: 'correct' }], tls: { enabled: true, certificate: [certificate.cert], key: [certificate.key] } }], outbounds: [{ type: 'direct' }] });
    const fixture = await ManagedKernelProcess.start(kernel!.path, (file, directory) => ['run', '-D', directory, '-c', file], content, undefined, 15_000);
    try {
      await waitForKernel(fixture, () => portReady(port));
      const connection = { protocolType: 'HTTP', serverHost: '127.0.0.1', serverPort: port, params: { username: 'fixture', password: 'correct', tls: { mode: 'tls', serverName: 'proxy.example', certificate: [certificate.cert] } } };
      expect((await execute(connection))[0]).toMatchObject({ status: 'SUCCESS', engine: 'SINGBOX', mihomoCompatibility: 'UNSUPPORTED', fallbackReason: 'MIHOMO_CERTIFICATE_UNSUPPORTED', latencyMs: expect.any(Number) });
      const wrong = { ...connection, params: { ...connection.params, password: 'wrong' } };
      expect((await execute(wrong))[0]).toMatchObject({ engine: 'SINGBOX', latencyMs: null });
      expect((await execute(connection, 'MIHOMO_ONLY'))[0]).toMatchObject({ status: 'UNSUPPORTED', engine: null });
    } finally { await fixture.stop(); }
  }, 20_000);
});
