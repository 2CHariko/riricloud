import { createServer as createHttpServer } from 'node:http';
import { connect, createServer, type Socket } from 'node:net';
import { proxyHttpDelay } from './proxy-http';
import { getEventListeners } from 'node:events';
import { controllerRequest } from './proxy-http';
import { portReady } from './mihomo.executor';

const listen = (server: ReturnType<typeof createServer>) => new Promise<number>((resolve) => server.listen(0, '127.0.0.1', () => resolve((server.address() as { port: number }).port)));
describe('TLS handshake lifecycle', () => {
  it.each(['timeout', 'cancel'])('settles a silent TLS handshake on %s and releases sockets', async (mode) => {
    const sockets = new Set<Socket>();
    const track = (socket: Socket) => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); };
    const silentTarget = createServer(track);
    const proxy = createHttpServer();
    proxy.on('connection', track);
    proxy.on('connect', (_req, socket) => {
      const upstream = connect(targetPort, '127.0.0.1', () => { socket.write('HTTP/1.1 200 Connection Established\r\n\r\n'); socket.pipe(upstream); upstream.pipe(socket); });
      track(upstream); upstream.on('error', () => socket.destroy()); socket.on('error', () => upstream.destroy()); socket.on('close', () => upstream.destroy());
    });
    const targetPort = await listen(silentTarget);
    const proxyPort = await listen(proxy);
    const abort = new AbortController();
    const timer = mode === 'cancel' ? setTimeout(() => abort.abort(), 50) : undefined;
    try {
      const outcome = await Promise.race([
        proxyHttpDelay(proxyPort, { id: 'silent', url: new URL(`https://target.example:${targetPort}/204`), address: '127.0.0.1', expectedStatus: 204 }, 100, abort.signal).then(() => 'SUCCESS', (error: Error & { code: string }) => error.code),
        new Promise<string>((resolve) => setTimeout(() => resolve('HANG'), 700))
      ]);
      expect(outcome).toBe(mode === 'cancel' ? 'CANCELED' : 'NETWORK_TIMEOUT');
    } finally {
      clearTimeout(timer); abort.abort(); for (const socket of sockets) socket.destroy();
      await Promise.all([proxy, silentTarget].map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
    }
  });
  it('startup polling does not retain abort listeners on a long-lived signal', async () => {
    const server = createHttpServer((_req, res) => { res.writeHead(200); res.end(); });
    const port = await listen(server);
    const controller = new AbortController();
    try {
      for (let i = 0; i < 12; i++) { expect(await controllerRequest(port, 'fixture', controller.signal)).toBe(true); expect(await portReady(port, controller.signal)).toBe(true); }
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
    } finally { controller.abort(); server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); }
  });
});
