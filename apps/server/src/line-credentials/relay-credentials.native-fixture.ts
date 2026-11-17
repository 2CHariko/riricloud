import { randomBytes, randomUUID } from 'node:crypto';
import { createSocket } from 'node:dgram';
import { access, readFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { createServer as createTcpServer, type Socket } from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';
import { ClientKernelsService, type ResolvedClientKernel } from '../client-kernels/client-kernels.service';
import { KernelExecutionError, ManagedKernelProcess } from '../client-kernels/kernel-process';
import { buildServerInbounds, formatAuthUserName, type InboundUserCredential } from '../common/inbound';
import type { ProxyConnection } from '../common/proxy-connection';
import { KernelReadiness } from '../probe/executors/kernel-readiness';
import { portReady } from '../probe/executors/mihomo.executor';
import { proxyHttpDelay, reserveLoopbackPort, waitForKernel } from '../probe/executors/proxy-http';
import { testCertificate } from '../probe/executors/test-certificate';
import { compileMihomoProxy } from '../subscription/compilers/mihomo-proxy';
import { compileSingboxClient } from '../subscription/compilers/singbox-client';
import { newRelayCredential, revealRelayCredential } from './line-credential.types';

export type NativeRelayProtocol = 'VLESS' | 'VMESS' | 'TROJAN' | 'HYSTERIA2' | 'TUIC' | 'NAIVE';
type Port = { number: number; udp: boolean };
const LOOPBACK = '127.0.0.1';
const CERTIFICATE_HOST = 'relay-auth.fixture.example';

// 已删除的公共固定值仅作认证负例；绝不作为服务端注册身份。
export const legacyRelay: InboundUserCredential = {
  uuid: '00000000-0000-4000-8000-000000000002', email: '__riricloud_relay_transit__',
  credential: 'riricloud-internal-relay-transit-secret'
};
export const legacySpeedtest: InboundUserCredential = {
  uuid: '00000000-0000-4000-8000-000000000003', email: '__riricloud_speedtest_probe__',
  credential: 'riricloud-internal-speedtest-secret'
};
export function randomCredential(lineId: string, version = 1): InboundUserCredential {
  return revealRelayCredential(newRelayCredential(lineId, version));
}

async function bindPort(port: Port): Promise<boolean> {
  if (port.udp) return new Promise<boolean>((resolve) => {
    const socket = createSocket('udp4');
    socket.once('error', () => { socket.close(); resolve(false); });
    socket.bind(port.number, LOOPBACK, () => socket.close(() => resolve(true)));
  });
  return new Promise<boolean>((resolve, reject) => {
    const server = createTcpServer();
    server.once('error', (error: NodeJS.ErrnoException) => error.code === 'EADDRINUSE' ? resolve(false) : reject(error));
    server.listen(port.number, LOOPBACK, () => server.close(() => resolve(true)));
  });
}
async function freePort(udp: boolean): Promise<Port> {
  if (!udp) return { number: await reserveLoopbackPort(), udp };
  return new Promise<Port>((resolve, reject) => {
    const socket = createSocket('udp4');
    socket.once('error', () => { socket.close(); reject(new Error('NATIVE_UDP_RESERVATION_FAILED')); });
    socket.bind(0, LOOPBACK, () => {
      const number = socket.address().port;
      socket.close(() => resolve({ number, udp }));
    });
  });
}
async function freeTcpPort(excluded: Port[]): Promise<Port> {
  let port: Port;
  do { port = await freePort(false); }
  while (excluded.some(existing => !existing.udp && existing.number === port.number));
  return port;
}
async function onlyTcpTimeWait(port: number): Promise<boolean> {
  // Linux 的拨出 socket 不一定设置 SO_REUSEADDR；TIME_WAIT 可阻止重绑，但不是残留监听。
  // 两张内核表都必须可读，且必须确有该端口的 TIME_WAIT，同时不存在任何 IPv4/IPv6 LISTEN。
  const tables = await Promise.all(['/proc/net/tcp', '/proc/net/tcp6'].map(file => readFile(file, 'utf8')));
  const suffix = ':' + port.toString(16).toUpperCase().padStart(4, '0');
  const sockets = tables.flatMap(table => table.trim().split('\n').slice(1).map(row => row.trim().split(/\s+/)))
    .filter(fields => fields[1]?.endsWith(suffix));
  return sockets.some(fields => fields[3] === '06') && sockets.every(fields => fields[3] !== '0A');
}
export async function assertReleased(port: Port): Promise<void> {
  for (let attempt = 0; attempt < 30; attempt++) {
    if (await bindPort(port)) return;
    if (!port.udp && process.platform === 'linux' && await onlyTcpTimeWait(port.number)) return;
    await sleep(50);
  }
  throw new Error('NATIVE_LISTENER_NOT_RELEASED');
}
async function stopKernel(child: ManagedKernelProcess, ports: Port[]): Promise<void> {
  // 同时核验子进程关闭、含秘密的临时目录移除与监听释放；Linux TCP 额外区分 TIME_WAIT。
  await child.stop();
  await child.exited;
  const exited = child.child.exitCode !== null || child.child.signalCode !== null;
  let removed = false;
  try { await access(child.directory); }
  catch (error) { removed = (error as NodeJS.ErrnoException).code === 'ENOENT'; }
  await Promise.all(ports.map(assertReleased));
  if (!exited || !removed) throw new Error('NATIVE_PROCESS_CLEANUP_FAILED');
}

export class RelayNativeFixture {
  readonly lineId = 'native-relay-' + randomUUID();
  readonly otherLineId = 'native-other-' + randomUUID();
  current = randomCredential(this.lineId);
  readonly other = randomCredential(this.otherLineId);
  private version = 1;
  private readonly kernels = new ClientKernelsService();
  private readonly certificate = testCertificate(CERTIFICATE_HOST);
  private readonly sockets = new Set<Socket>();
  private readonly requests = new Map<string, number>();
  private readonly target: Server;
  private targetPort = 0;
  private ports: Port[] = [];
  private server?: ManagedKernelProcess;
  private serverReadinessPort?: Port;
  private serverKernel?: ResolvedClientKernel;
  private clientKernel?: ResolvedClientKernel;
  private targetStatus = 204;
  constructor(readonly protocol: NativeRelayProtocol) {
    this.target = createServer((req, res) => {
      const path = req.url ?? '';
      this.requests.set(path, (this.requests.get(path) ?? 0) + 1);
      const valid = req.method === 'GET' && path.startsWith('/204/') && req.headers.host === this.targetHost;
      res.writeHead(valid ? this.targetStatus : 400, { Connection: 'close' });
      res.end();
    });
    this.target.on('connection', socket => {
      this.sockets.add(socket); socket.once('close', () => this.sockets.delete(socket));
      socket.on('error', () => { /* teardown 销毁连接的错误不进入日志。 */ });
    });
  }
  private get targetHost(): string { return 'relay-target.invalid:' + this.targetPort; }
  private get udp(): boolean { return this.protocol === 'HYSTERIA2' || this.protocol === 'TUIC'; }
  async start(): Promise<void> {
    this.serverKernel = await this.kernels.resolve('SINGBOX') ?? undefined;
    this.clientKernel = await this.kernels.resolve(this.protocol === 'NAIVE' ? 'SINGBOX' : 'MIHOMO') ?? undefined;
    if (!this.serverKernel || !this.clientKernel) throw new Error('NATIVE_REQUIRED_KERNEL_UNAVAILABLE');
    if (this.protocol === 'NAIVE' && !await this.kernels.supportsNaive(this.clientKernel)) {
      throw new Error('NATIVE_LINUX_CRONET_UNAVAILABLE');
    }
    await new Promise<void>((resolve, reject) => {
      this.target.once('error', () => reject(new Error('NATIVE_TARGET_START_FAILED')));
      this.target.listen(0, LOOPBACK, () => {
        this.targetPort = (this.target.address() as { port: number }).port; resolve();
      });
    });
    this.ports = [await freePort(this.udp)];
    // 连续释放随机端口后，OS 可能再次给出同一个端口。
    do { this.ports[1] = await freePort(this.udp); } while (this.ports[0].number === this.ports[1].number);
    await this.startServer();
  }
  private async startServer(): Promise<void> {
    const alpn = this.udp ? ['h3'] : this.protocol === 'NAIVE' ? ['h2'] : ['http/1.1'];
    const params = {
      tls: { enabled: true, mode: 'tls', serverName: CERTIFICATE_HOST,
        certificate: [this.certificate.cert], key: [this.certificate.key], alpn },
      ...(this.protocol === 'HYSTERIA2' ? { upMbps: 100, downMbps: 100 } : {})
    };
    const identities = [this.current, this.other];
    const inbounds = this.ports.flatMap((port, index) => buildServerInbounds({
      type: this.protocol, tag: 'relay-in-' + index, listen: LOOPBACK, port: port.number,
      lineId: index === 0 ? this.lineId : this.otherLineId, params, users: [identities[index]]
    }));
    const readiness = new KernelReadiness();
    try {
      await readiness.listen();
      const readinessPort = await freeTcpPort(this.ports);
      const content = JSON.stringify({
        log: { disabled: true },
        inbounds: [...inbounds, { type: 'mixed', tag: 'kernel-readiness', listen: LOOPBACK, listen_port: readinessPort.number }],
        outbounds: [{ type: 'direct', tag: 'controlled-target' }],
        route: { rules: [
          // 自检仅经独立 listener；业务入站仍只能访问本测试的 HTTP 目标。
          { inbound: ['kernel-readiness'], ip_cidr: [LOOPBACK + '/32'], action: 'route', outbound: 'controlled-target' },
          { ip_cidr: [LOOPBACK + '/32'], port: [this.targetPort], action: 'route', outbound: 'controlled-target' },
          { action: 'reject' }
        ] }
      });
      await this.validate('SINGBOX', content);
      this.server = await ManagedKernelProcess.start(this.serverKernel!.path,
        (file, directory) => ['run', '-D', directory, '-c', file], content, undefined, 180_000);
      this.serverReadinessPort = readinessPort;
      await waitForKernel(this.server, async () => {
        const listenersReady = this.udp
          ? (await Promise.all(this.ports.map(bindPort))).every(released => !released)
          : (await Promise.all(this.ports.map(port => portReady(port.number)))).every(Boolean);
        return listenersReady && await readiness.ready(readinessPort.number);
      });
    } finally { await readiness.close(); }
  }
  private connection(identity: InboundUserCredential, index: number, rawUsername = false, identityLineId?: string): ProxyConnection {
    const params: Record<string, unknown> = {
      tls: this.protocol === 'NAIVE'
        ? { enabled: true, mode: 'tls', serverName: CERTIFICATE_HOST, certificate: [this.certificate.cert] }
        : { enabled: true, mode: 'tls', serverName: CERTIFICATE_HOST, insecure: true, alpn: this.udp ? ['h3'] : ['http/1.1'] }
    };
    // Naive/Cronet 使用临时证书信任；Mihomo 当前编译器不支持自定义 CA，仅回环实验跳过验证。
    // 此套件证明协议认证，不据此声称验证了生产 TLS 信任策略。
    if (['VLESS', 'VMESS', 'TUIC'].includes(this.protocol)) params.uuid = identity.uuid;
    if (['TROJAN', 'HYSTERIA2', 'TUIC', 'NAIVE'].includes(this.protocol)) params.password = identity.credential;
    if (this.protocol === 'VMESS') params.security = 'auto';
    if (this.protocol === 'NAIVE') params.username = rawUsername ? identity.email : formatAuthUserName(identity, identityLineId ?? (index === 0 ? this.lineId : this.otherLineId));
    return { protocolType: this.protocol, serverHost: LOOPBACK, serverPort: this.ports[index].number, params };
  }
  private async validate(engine: 'SINGBOX' | 'MIHOMO', content: string): Promise<void> {
    const check = await this.kernels.validate(engine, content);
    if (check.status !== 'PASSED' || check.executed !== true) throw new Error('NATIVE_' + engine + '_CONFIG_CHECK_FAILED');
  }
  private async withClient(candidate: InboundUserCredential, run: (ports: Port[]) => Promise<void>, rawUsername = false, identityLineId?: string): Promise<void> {
    const connections = [this.connection(this.current, 0), this.connection(this.other, 1), this.connection(candidate, 0, rawUsername, identityLineId)];
    const ports: Port[] = [];
    while (ports.length < connections.length) ports.push(await freeTcpPort([...ports, ...this.ports]));
    const naive = this.protocol === 'NAIVE';
    const readiness = new KernelReadiness();
    try {
      await readiness.listen();
      const readinessPort = await freeTcpPort([...ports, ...this.ports]);
      const content = JSON.stringify(naive ? {
        log: { disabled: true },
        inbounds: [
          ...ports.map((port, index) => ({ type: 'mixed', tag: 'client-in-' + index, listen: LOOPBACK, listen_port: port.number })),
          { type: 'mixed', tag: 'kernel-readiness', listen: LOOPBACK, listen_port: readinessPort.number }
        ],
        outbounds: [...connections.map((connection, index) => compileSingboxClient(connection, 'relay-' + index)), { type: 'direct', tag: 'kernel-readiness-direct' }],
        route: { rules: [
          { inbound: ['kernel-readiness'], ip_cidr: [LOOPBACK + '/32'], action: 'route', outbound: 'kernel-readiness-direct' },
          ...connections.map((_, index) => ({ inbound: ['client-in-' + index], action: 'route', outbound: 'relay-' + index })),
          { action: 'reject' }
        ] }
      } : {
        'allow-lan': false, 'bind-address': LOOPBACK, mode: 'rule', 'log-level': 'silent',
        'geodata-mode': false, 'geo-auto-update': false, tun: { enable: false }, dns: { enable: false },
        proxies: connections.map((connection, index) => compileMihomoProxy(connection, 'relay-' + index)),
        // 业务 listener 固定绑定代理；DIRECT 仅供独立的启动屏障使用。
        listeners: [
          ...ports.map((port, index) => ({ name: 'client-in-' + index, type: 'mixed', listen: LOOPBACK, port: port.number, udp: false, proxy: 'relay-' + index })),
          { name: 'kernel-readiness', type: 'mixed', listen: LOOPBACK, port: readinessPort.number, udp: false, proxy: 'DIRECT' }
        ],
        rules: ['MATCH,REJECT']
      });
      await this.validate(naive ? 'SINGBOX' : 'MIHOMO', content);
      const child = await ManagedKernelProcess.start(this.clientKernel!.path,
        (file, directory) => naive ? ['run', '-D', directory, '-c', file] : ['-d', directory, '-f', file], content, undefined, 25_000);
      try {
        await waitForKernel(child, async () => (await Promise.all(ports.map(port => portReady(port.number)))).every(Boolean)
          && await readiness.ready(readinessPort.number));
        await run(ports);
      } finally { await stopKernel(child, [...ports, readinessPort]); }
    } finally { await readiness.close(); }
  }
  private async exchange(port: number): Promise<{ status: 'HTTP_204' | 'DIAL_FAILED' | 'NETWORK_TIMEOUT' | 'UNEXPECTED_HTTP_STATUS' | 'OTHER_FAILURE'; requests: number }> {
    const path = '/204/' + randomBytes(12).toString('hex');
    let status: 'HTTP_204' | 'DIAL_FAILED' | 'NETWORK_TIMEOUT' | 'UNEXPECTED_HTTP_STATUS' | 'OTHER_FAILURE' = 'HTTP_204';
    try {
      await proxyHttpDelay(port, { id: 'relay-auth-native', url: new URL('http://' + this.targetHost + path), address: LOOPBACK, expectedStatus: 204 }, 2_000);
    } catch (error) {
      status = error instanceof KernelExecutionError && ['DIAL_FAILED', 'NETWORK_TIMEOUT', 'UNEXPECTED_HTTP_STATUS'].includes(error.code)
        ? error.code as typeof status : 'OTHER_FAILURE';
    }
    // 仅输出无秘密的状态和请求数量；禁止将连接对象、内核 stderr 或完整配置交给 Jest。
    return { status, requests: this.requests.get(path) ?? 0 };
  }
  async assertCandidate(candidate: InboundUserCredential, accepted: boolean, rawUsername = false, identityLineId?: string): Promise<void> {
    const before = [...this.requests.values()].reduce((sum, count) => sum + count, 0);
    await this.withClient(candidate, async ports => {
      expect(await this.exchange(ports[0].number)).toEqual({ status: 'HTTP_204', requests: 1 });
      expect(await this.exchange(ports[1].number)).toEqual({ status: 'HTTP_204', requests: 1 });
      const result = await this.exchange(ports[2].number);
      if (accepted) expect(result).toEqual({ status: 'HTTP_204', requests: 1 });
      else {
        expect(['DIAL_FAILED', 'NETWORK_TIMEOUT'].includes(result.status)).toBe(true);
        expect(result.requests).toBe(0);
      }
      expect(await this.exchange(ports[0].number)).toEqual({ status: 'HTTP_204', requests: 1 });
    }, rawUsername, identityLineId);
    // 等客户端完全停止后再核对总量，错误身份超时后的迟到请求也不能漏算。
    const after = [...this.requests.values()].reduce((sum, count) => sum + count, 0);
    expect(after - before).toBe(accepted ? 4 : 3);
  }
  async assertHttpStatusIsChecked(): Promise<void> {
    await this.withClient(this.current, async ports => {
      this.targetStatus = 503;
      try { expect(await this.exchange(ports[0].number)).toEqual({ status: 'UNEXPECTED_HTTP_STATUS', requests: 1 }); }
      finally { this.targetStatus = 204; }
      expect(await this.exchange(ports[0].number)).toEqual({ status: 'HTTP_204', requests: 1 });
    });
  }
  async rotate(): Promise<InboundUserCredential> {
    const previous = this.current;
    await this.stopServer();
    this.current = randomCredential(this.lineId, ++this.version);
    await this.startServer();
    return previous;
  }
  private async stopServer(): Promise<void> {
    if (!this.server) return;
    const server = this.server; this.server = undefined;
    const ports = this.serverReadinessPort ? [...this.ports, this.serverReadinessPort] : this.ports;
    this.serverReadinessPort = undefined;
    await stopKernel(server, ports);
  }
  async close(): Promise<void> {
    const results = await Promise.allSettled([
      this.stopServer(),
      (async () => {
        this.target.closeAllConnections();
        for (const socket of this.sockets) socket.destroy();
        await new Promise<void>(resolve => this.target.close(() => resolve()));
        if (this.targetPort) await assertReleased({ number: this.targetPort, udp: false });
      })()
    ]);
    if (results.some(result => result.status === 'rejected')) throw new Error('NATIVE_FIXTURE_CLEANUP_FAILED');
  }
}
