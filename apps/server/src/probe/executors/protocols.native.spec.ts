import { createServer, type Server } from 'node:http';
import { ClientKernelsService } from '../../client-kernels/client-kernels.service';
import { ManagedKernelProcess } from '../../client-kernels/kernel-process';
import { MihomoExecutor } from './mihomo.executor';
import { reserveLoopbackPort, waitForKernel } from './proxy-http';
import { portReady } from './mihomo.executor';
import { testCertificate } from './test-certificate';
import type { ProxyConnection } from '../../common/proxy-connection';

const native = process.env.RUN_NATIVE_CLIENT_TESTS === '1' ? describe : describe.skip;
native('real Mihomo connections through independent Sing-box protocol fixtures', () => {
  const kernels = new ClientKernelsService();
  const uuid = 'a77cf184-4b56-41ee-962c-1357184acd77';
  let target: Server;
  let targetPort: number;
  beforeAll(async () => {
    target = createServer((_req, res) => { res.writeHead(204); res.end(); });
    targetPort = await new Promise((resolve) => target.listen(0, '127.0.0.1', () => resolve((target.address() as { port: number }).port)));
  });
  afterAll(async () => new Promise<void>((resolve) => target.close(() => resolve())));
  it.each(['VLESS', 'SHADOWSOCKS', 'HYSTERIA2', 'TUIC'])('%s authenticates over the real protocol; incorrect credentials cannot succeed', async (protocolType) => {
    const serverKernel = await kernels.resolve('SINGBOX');
    const clientKernel = await kernels.resolve('MIHOMO');
    expect(serverKernel).not.toBeNull(); expect(clientKernel).not.toBeNull();
    const port = await reserveLoopbackPort();
    const certificate = testCertificate('proxy.example');
    const inbound: Record<string, unknown> = { type: protocolType.toLowerCase(), tag: 'fixture', listen: '127.0.0.1', listen_port: port };
    let params: Record<string, unknown>;
    if (protocolType === 'VLESS') { inbound.users = [{ uuid }]; inbound.transport = { type: 'ws', path: '/real-ws' }; params = { uuid, transport: { type: 'ws', path: '/real-ws' } }; }
    else if (protocolType === 'SHADOWSOCKS') { inbound.method = 'aes-256-gcm'; inbound.password = 'correct'; params = { method: 'aes-256-gcm', password: 'correct' }; }
    else {
      inbound.tls = { enabled: true, certificate: [certificate.cert], key: [certificate.key], alpn: ['h3'] };
      inbound.users = protocolType === 'TUIC' ? [{ uuid, password: 'correct' }] : [{ password: 'correct' }];
      if (protocolType === 'HYSTERIA2') { inbound.up_mbps = 100; inbound.down_mbps = 100; }
      params = { ...(protocolType === 'TUIC' ? { uuid } : {}), password: 'correct', tls: { mode: 'tls', serverName: 'proxy.example', insecure: true, alpn: ['h3'] } };
    }
    const content = JSON.stringify({ log: { disabled: true }, inbounds: [inbound], outbounds: [{ type: 'direct', tag: 'direct' }], route: { final: 'direct' } });
    expect(await kernels.validate('SINGBOX', content)).toMatchObject({ status: 'PASSED', executed: true });
    const fixture = await ManagedKernelProcess.start(serverKernel!.path, (file, directory) => ['run', '-D', directory, '-c', file], content, undefined, 20_000);
    try {
      if (protocolType === 'HYSTERIA2' || protocolType === 'TUIC') await new Promise((resolve) => setTimeout(resolve, 200));
      else await waitForKernel(fixture, () => portReady(port));
      const connection: ProxyConnection = { protocolType, serverHost: '127.0.0.1', serverPort: port, params };
      const wrong = { ...connection, params: { ...params, ...(protocolType === 'VLESS' ? { uuid: '00000000-0000-0000-0000-000000000000' } : { password: 'wrong' }) } };
      const pinned = { id: 'fixture', url: new URL(`http://target.example:${targetPort}/204`), address: '127.0.0.1', expectedStatus: 204 };
      const results = await new MihomoExecutor(kernels).execute([connection, wrong], pinned, 1_500, clientKernel!);
      expect(results[0]).toMatchObject({ errorCode: null, latencyMs: expect.any(Number) });
      expect(results[1].latencyMs).toBeNull();
      expect(results[1].errorCode).not.toBeNull();
      if (protocolType === 'VLESS') {
        const incorrectPath = { ...connection, params: { ...params, transport: { type: 'ws', path: '/wrong-ws' } } };
        expect((await new MihomoExecutor(kernels).execute([incorrectPath], pinned, 500, clientKernel!))[0].latencyMs).toBeNull();
      }
    } finally { await fixture.stop(); }
  }, 25_000);
});
