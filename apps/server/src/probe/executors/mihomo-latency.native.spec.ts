import { createServer, type Server } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { connect, type Socket } from 'node:net';
import { ClientKernelsService } from '../../client-kernels/client-kernels.service';
import { MihomoExecutor } from './mihomo.executor';
import { testCertificate } from './test-certificate';

const native = process.env.RUN_NATIVE_CLIENT_TESTS === '1' ? describe : describe.skip;
native('Mihomo ordinary URLTest production executor', () => {
  const kernels = new ClientKernelsService();
  const executor = new MihomoExecutor(kernels);
  const sockets = new Set<Socket>();
  const hits: string[] = [];
  const destinations: string[] = [];
  let target: Server;
  let proxy: Server;
  let targetPort: number;
  let proxyPort: number;
  let responseStatus = 204;
  let hanging = false;
  const track = (socket: Socket) => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); };
  const listen = (server: Server): Promise<number> => new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve((server.address() as { port: number }).port)));
  const connection = (password = 'correct') => ({ protocolType: 'HTTP', serverHost: '127.0.0.1', serverPort: proxyPort, params: { username: 'fixture', password } });
  const pinned = () => ({ id: 'fixture', url: new URL(`http://original.example:${targetPort}/generate_204`), address: '127.0.0.1', expectedStatus: 204 });
  beforeAll(async () => {
    target = createServer((req, res) => {
      hits.push(req.method!);
      if (!hanging) setTimeout(() => { res.writeHead(responseStatus); res.end(); }, 25);
    });
    proxy = createServer();
    proxy.on('connect', (req, socket, head) => {
      destinations.push(req.url!);
      if (req.headers['proxy-authorization'] !== `Basic ${Buffer.from('fixture:correct').toString('base64')}`) { socket.end('HTTP/1.1 407 Proxy Authentication Required\r\nContent-Length: 0\r\n\r\n'); return; }
      const at = req.url!.lastIndexOf(':');
      const upstream = connect(Number(req.url!.slice(at + 1)), '127.0.0.1', () => {
        socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head.length) upstream.write(head);
        socket.pipe(upstream); upstream.pipe(socket);
      });
      track(upstream); upstream.once('error', () => socket.destroy()); socket.once('error', () => upstream.destroy()); socket.once('close', () => upstream.destroy());
    });
    target.on('connection', track); proxy.on('connection', track);
    targetPort = await listen(target); proxyPort = await listen(proxy);
  });
  beforeEach(() => { hits.length = 0; destinations.length = 0; responseStatus = 204; hanging = false; });
  afterAll(async () => {
    for (const socket of sockets) socket.destroy();
    await Promise.all([target, proxy].map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  });
  it('uses two HEAD requests and passes the original target domain to the proxy', async () => {
    const kernel = await kernels.resolve('MIHOMO');
    expect(kernel?.version).toBe('1.19.30');
    expect((await executor.executeLatency([connection()], pinned(), 1000, kernel!))[0]).toMatchObject({ errorCode: null, latencyMs: expect.any(Number), stage: 'DIAL_HTTP' });
    expect(hits).toEqual(['HEAD', 'HEAD']);
    expect(destinations).toEqual([`original.example:${targetPort}`]);
  }, 15000);
  it('ordinary delay accepts non-204 responses while retained strict implementation rejects them', async () => {
    const kernel = await kernels.resolve('MIHOMO'); responseStatus = 500;
    expect((await executor.executeLatency([connection()], pinned(), 1000, kernel!))[0].errorCode).toBeNull();
    expect((await executor.execute([connection()], pinned(), 1000, kernel!))[0]).toMatchObject({ errorCode: 'UNEXPECTED_HTTP_STATUS', latencyMs: null });
    expect(hits).toEqual(['HEAD', 'HEAD', 'GET']);
    expect(destinations).toEqual([`original.example:${targetPort}`, `127.0.0.1:${targetPort}`]);
  }, 15000);
  it('wrong authentication fails without a direct or strict fallback', async () => {
    const kernel = await kernels.resolve('MIHOMO');
    const result = (await executor.executeLatency([connection('wrong')], pinned(), 1000, kernel!))[0];
    expect(result.latencyMs).toBeNull(); expect(result.errorCode).not.toBeNull(); expect(hits).toEqual([]);
  }, 15000);
  it('times out and cancels stalled URLTests without success results', async () => {
    const kernel = await kernels.resolve('MIHOMO'); hanging = true;
    const result = (await executor.executeLatency([connection()], pinned(), 500, kernel!))[0];
    expect(result).toMatchObject({ errorCode: 'NETWORK_TIMEOUT', latencyMs: null });
    const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 500);
    try {
      const results = await executor.executeLatency([connection(), connection()], pinned(), 10000, kernel!, controller.signal);
      expect(results.every((r) => r.errorCode === 'CANCELED' && r.latencyMs === null)).toBe(true);
    } finally { clearTimeout(timer); }
  }, 15000);
  it('ordinary HTTPS URLTest still rejects an untrusted target certificate', async () => {
    const server = createHttpsServer(testCertificate('original.example'), (_req, res) => { setTimeout(() => { res.writeHead(204); res.end(); }, 25); });
    server.on('connection', track); server.on('tlsClientError', () => undefined);
    const port = await listen(server);
    try {
      const kernel = await kernels.resolve('MIHOMO');
      const result = (await executor.executeLatency([connection()], { ...pinned(), url: new URL(`https://original.example:${port}/generate_204`) }, 1000, kernel!))[0];
      expect(result.errorCode).not.toBeNull(); expect(result.latencyMs).toBeNull();
    } finally { for (const socket of sockets) socket.destroy(); await new Promise<void>((resolve) => server.close(() => resolve())); }
  }, 15000);
});
