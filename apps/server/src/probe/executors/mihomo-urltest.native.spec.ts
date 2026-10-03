import { randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { connect, type Socket } from 'node:net';
import { ClientKernelsService } from '../../client-kernels/client-kernels.service';
import { ManagedKernelProcess } from '../../client-kernels/kernel-process';
import { KernelReadiness } from './kernel-readiness';
import { controllerRequest, proxyHttpDelay, reserveLoopbackPort, waitForKernel } from './proxy-http';

const native = process.env.RUN_NATIVE_CLIENT_TESTS === '1' ? describe : describe.skip;
const listen = (server: Server, host = '127.0.0.1', port = 0): Promise<number> => new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(port, host, () => resolve((server.address() as { port: number }).port));
});

// 固定版本证据：证明 hosts 不能保证 URLTest 的实际目标已被固定，不是生产安全边界的豁免。
// 所有端点仅属于隔离本地夹具，不请求公网、默认数据库或业务节点。
native('Mihomo 1.19.30 URLTest target-address boundary', () => {
  it.each([false, true])('forwards the original target to an HTTP upstream with DNS enabled=%s', async (dnsEnabled) => {
    const kernels = new ClientKernelsService();
    const kernel = await kernels.resolve('MIHOMO');
    expect(kernel?.version).toBe('1.19.30');
    const connections: string[] = [];
    const hits: Array<{ destination: string; method: string | undefined; host: string | undefined }> = [];
    const sockets = new Set<Socket>();
    let status = 204;
    const target = createServer((req, res) => {
      hits.push({ destination: 'validated-address', method: req.method, host: req.headers.host });
      setTimeout(() => { res.writeHead(204); res.end(); }, 25);
    });
    const alternate = createServer((req, res) => {
      hits.push({ destination: 'proxy-resolved-alternate', method: req.method, host: req.headers.host });
      // 避免固定版本把本地小于 1 ms 的有效响应归为零延迟失败。
      setTimeout(() => { res.writeHead(status); res.end(); }, 25);
    });
    const proxy = createServer();
    let targetPort = 0;
    proxy.on('connect', (req, socket, head) => {
      connections.push(req.url!);
      const host = req.url!.split(':')[0];
      // 模拟代理侧解析与 Master 已校验地址不同，但仍保留 URL 的端口。
      const upstream = connect(targetPort, host === 'original.example' ? '127.0.0.2' : host, () => {
        socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head.length) upstream.write(head);
        socket.pipe(upstream); upstream.pipe(socket);
      });
      sockets.add(upstream); upstream.on('close', () => sockets.delete(upstream));
      upstream.on('error', () => socket.destroy()); socket.on('error', () => upstream.destroy()); socket.on('close', () => upstream.destroy());
    });
    const servers = [target, alternate, proxy];
    for (const server of servers) server.on('connection', (socket) => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
    const readiness = new KernelReadiness();
    let child: ManagedKernelProcess | undefined;
    try {
      targetPort = await listen(target);
      await listen(alternate, '127.0.0.2', targetPort);
      const proxyPort = await listen(proxy);
      await readiness.listen();
      const controllerPort = await reserveLoopbackPort();
      const readinessPort = await reserveLoopbackPort();
      const secret = randomBytes(32).toString('hex');
      const config = JSON.stringify({
        'external-controller': `127.0.0.1:${controllerPort}`, secret,
        'log-level': 'silent', 'allow-lan': false, 'bind-address': '127.0.0.1',
        'geodata-mode': false, 'geo-auto-update': false, 'unified-delay': true,
        tun: { enable: false },
        dns: { enable: dnsEnabled, 'use-hosts': true, nameserver: ['1.1.1.1'], 'default-nameserver': ['1.1.1.1'] },
        hosts: { 'original.example': '127.0.0.1' },
        proxies: [{ name: 'fixture', type: 'http', server: '127.0.0.1', port: proxyPort }],
        listeners: [{ name: 'kernel-readiness', type: 'mixed', listen: '127.0.0.1', port: readinessPort, udp: false, proxy: 'DIRECT' }],
        rules: ['MATCH,REJECT']
      });
      child = await ManagedKernelProcess.start(kernel!.path, (file, directory) => ['-d', directory, '-f', file], config, undefined, 12_000);
      await waitForKernel(child, async () => await controllerRequest(controllerPort, secret) && await readiness.ready(readinessPort));
      const url = new URL(`http://original.example:${targetPort}/generate_204`);
      const query = new URLSearchParams({ url: url.href, timeout: '2000', expected: '204' });
      const check = async () => {
        const response = await fetch(`http://127.0.0.1:${controllerPort}/proxies/fixture/delay?${query}`, {
          headers: { Authorization: `Bearer ${secret}` }, signal: AbortSignal.timeout(4_000)
        });
        const result: unknown = await response.json();
        expect(response.status).toBe(200);
        expect(result).toEqual({ delay: expect.any(Number) });
      };
      await check();
      expect(connections).toEqual([`original.example:${targetPort}`]);
      expect(hits).toEqual(Array.from({ length: 2 }, () => ({ destination: 'proxy-resolved-alternate', method: 'HEAD', host: url.host })));
      connections.length = 0; hits.length = 0; status = 500;
      await check();
      expect(connections).toEqual([`original.example:${targetPort}`]);
      expect(hits).toHaveLength(2);
      expect(hits.every((hit) => hit.destination === 'proxy-resolved-alternate')).toBe(true);
      connections.length = 0; hits.length = 0;
      // 控制组调用现有严格请求算法：使用固定 IP，Host 仍为原域名，无法命中替代目标。
      expect(await proxyHttpDelay(proxyPort, { id: 'address-boundary', url, address: '127.0.0.1', expectedStatus: 204 }, 2_000)).toBeGreaterThan(0);
      expect(connections).toEqual([`127.0.0.1:${targetPort}`]);
      expect(hits).toEqual([{ destination: 'validated-address', method: 'GET', host: url.host }]);
    } finally {
      await child?.stop(); await readiness.close();
      for (const socket of sockets) socket.destroy();
      await Promise.all(servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
    }
  }, 20_000);
});
