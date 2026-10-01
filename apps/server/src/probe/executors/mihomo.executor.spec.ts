import { createServer, request as httpRequest, type Server } from 'node:http';
import { connect, type Socket } from 'node:net';
import { ClientKernelsService } from '../../client-kernels/client-kernels.service';
import { MihomoExecutor } from './mihomo.executor';
import type { PinnedProbeTarget } from '../probe-target-policy';
import { createServer as httpsServer } from 'node:https';
import { testCertificate } from './test-certificate';
import { SingboxExecutor } from './singbox.executor';

const native = process.env.RUN_NATIVE_CLIENT_TESTS === '1' ? describe : describe.skip;
native('Mihomo 1.19.30 real strict HTTP probing', () => {
  const kernels = new ClientKernelsService();
  const executor = new MihomoExecutor(kernels);
  let targetServer: Server;
  let proxyServer: Server;
  let targetPort: number;
  let proxyPort: number;
  let currentStatus = 204;
  const sockets = new Set<Socket>();
  const listen = (server: Server): Promise<number> => new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve((server.address() as { port: number }).port)));
  const target = (): PinnedProbeTarget => ({ id: 'native-test', url: new URL(`http://original.example:${targetPort}/204`), address: '127.0.0.1', expectedStatus: 204 });
  const connection = (password = 'correct') => ({ protocolType: 'HTTP', serverHost: '127.0.0.1', serverPort: proxyPort, params: { username: 'native-user', password } });
  beforeAll(async () => {
    targetServer = createServer((_req, res) => { if (currentStatus !== 0) { res.writeHead(currentStatus); res.end(); } });
    targetPort = await listen(targetServer);
    proxyServer = createServer((req, res) => {
      if (req.headers['proxy-authorization'] !== `Basic ${Buffer.from('native-user:correct').toString('base64')}`) { res.writeHead(407); res.end(); return; }
      const url = new URL(req.url!);
      const upstream = httpRequest({ hostname: url.hostname, port: url.port, path: url.pathname, headers: req.headers }, (reply) => { res.writeHead(reply.statusCode!); reply.pipe(res); });
      upstream.on('error', () => { res.writeHead(502); res.end(); }); req.pipe(upstream);
    });
    proxyServer.on('connect', (req, socket, head) => {
      if (req.headers['proxy-authorization'] !== `Basic ${Buffer.from('native-user:correct').toString('base64')}`) { socket.end('HTTP/1.1 407 Proxy Authentication Required\r\nContent-Length: 0\r\n\r\n'); return; }
      const [host, port] = req.url!.split(':');
      const upstream = connect(Number(port), host, () => { socket.write('HTTP/1.1 200 Connection Established\r\n\r\n'); if (head.length) upstream.write(head); socket.pipe(upstream); upstream.pipe(socket); });
      sockets.add(upstream); upstream.on('close', () => sockets.delete(upstream)); upstream.on('error', () => socket.destroy()); socket.on('error', () => upstream.destroy()); socket.on('close', () => upstream.destroy());
    });
    for (const server of [targetServer, proxyServer]) server.on('connection', (socket) => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
    proxyPort = await listen(proxyServer);
  });
  afterAll(async () => { for (const socket of sockets) socket.destroy(); await Promise.all([targetServer, proxyServer].map((server) => new Promise<void>((resolve) => server.close(() => resolve())))); });
  it('correct credentials succeed, wrong credentials cannot become TCP successes', async () => {
    const kernel = await kernels.resolve('MIHOMO');
    expect(kernel?.version).toBe('1.19.30');
    const results = await executor.execute([connection(), connection('wrong')], target(), 1_000, kernel!);
    expect(results[0]).toMatchObject({ errorCode: null, stage: 'DIAL_HTTP', latencyMs: expect.any(Number) });
    expect(results[1].latencyMs).toBeNull();
    expect(results[1].errorCode).not.toBeNull();
  }, 15_000);
  it('repeated cold starts wait for data-plane readiness before the first real request', async () => {
    const kernel = await kernels.resolve('MIHOMO');
    for (let i = 0; i < 10; i++) {
      expect((await executor.execute([connection()], target(), 1_000, kernel!))[0]).toMatchObject({ errorCode: null, latencyMs: expect.any(Number) });
    }
  }, 30_000);
  it('does not accept unexpected HTTP responses or follow redirects', async () => {
    const kernel = await kernels.resolve('MIHOMO');
    for (const status of [200, 302, 500]) {
      currentStatus = status;
      expect((await executor.execute([connection()], target(), 1_000, kernel!))[0]).toMatchObject({ errorCode: 'UNEXPECTED_HTTP_STATUS', latencyMs: null });
    }
    currentStatus = 204;
  }, 20_000);
  it('times out unresponsive targets and cancels the entire batch without leaked children', async () => {
    const kernel = await kernels.resolve('MIHOMO');
    currentStatus = 0;
    expect((await executor.execute([connection()], target(), 500, kernel!))[0]).toMatchObject({ errorCode: 'NETWORK_TIMEOUT', latencyMs: null });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 400);
    const results = await executor.execute([connection(), connection()], target(), 10_000, kernel!, controller.signal);
    clearTimeout(timer);
    expect(results.every((result) => result.errorCode === 'CANCELED' && result.latencyMs === null)).toBe(true);
    currentStatus = 204;
  }, 15_000);
  it('target TLS rejects untrusted certificates even through a working Mihomo proxy', async () => {
    const server = httpsServer(testCertificate('original.example'), (_req, res) => { res.writeHead(204); res.end(); });
    server.on('tlsClientError', () => undefined);
    const port = await listen(server);
    try {
      const kernel = await kernels.resolve('MIHOMO');
      const pinned = { ...target(), url: new URL(`https://original.example:${port}/204`) };
      expect((await executor.execute([connection()], pinned, 1_000, kernel!))[0]).toMatchObject({ errorCode: 'DIAL_FAILED', latencyMs: null });
    } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
  }, 15_000);
  it('Sing-box independent executor uses the same exact response contract', async () => {
    const kernel = await kernels.resolve('SINGBOX');
    const compat = new SingboxExecutor(kernels);
    expect((await compat.execute(connection(), target(), 1_000, kernel!)).errorCode).toBeNull();
    expect((await compat.execute(connection('wrong'), target(), 1_000, kernel!)).latencyMs).toBeNull();
  }, 15_000);
});
