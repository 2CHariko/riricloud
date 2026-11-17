import { randomBytes } from 'node:crypto';
import { createSocket } from 'node:dgram';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import network from 'node:net';
import fileSystem from 'node:fs/promises';
import { EventEmitter } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KernelExecutionError, ManagedKernelProcess } from '../client-kernels/kernel-process';
import { KernelReadiness } from '../probe/executors/kernel-readiness';
import { reserveLoopbackPort } from '../probe/executors/proxy-http';
import { assertReleased, RelayNativeFixture, type NativeRelayProtocol } from './relay-credentials.native-fixture';

type Port = { number: number; udp: boolean };
type FixtureInternals = {
  clientKernel: { path: string };
  serverKernel: { path: string };
  ports: Port[];
  validate: (engine: string, content: string) => Promise<void>;
  startServer: () => Promise<void>;
  withClient: (candidate: RelayNativeFixture['current'], run: (ports: Port[]) => Promise<void>) => Promise<void>;
};
type KernelConfig = {
  inbounds?: Array<{ type: string; tag: string; listen_port: number }>;
  listeners?: Array<{ name: string; port: number; proxy: string }>;
  route?: { rules: Array<Record<string, unknown>> };
  rules?: string[];
};

describe('relay native fixture startup barrier', () => {
  let encryptionKey: string | undefined;
  let fixture: RelayNativeFixture;
  let internals: FixtureInternals;
  let managed: ManagedKernelProcess;
  let config: KernelConfig;

  async function setup(protocol: NativeRelayProtocol): Promise<void> {
    fixture = new RelayNativeFixture(protocol);
    internals = fixture as unknown as FixtureInternals;
    internals.clientKernel = { path: 'fixture-client' };
    internals.serverKernel = { path: 'fixture-server' };
    const first = await reserveLoopbackPort();
    let second: number;
    do { second = await reserveLoopbackPort(); } while (second === first);
    internals.ports = [first, second].map(number => ({ number, udp: protocol === 'HYSTERIA2' }));
    jest.spyOn(internals, 'validate').mockResolvedValue();
  }

  beforeEach(() => {
    encryptionKey = process.env.RIRICLOUD_ENCRYPTION_KEY;
    process.env.RIRICLOUD_ENCRYPTION_KEY = randomBytes(32).toString('hex');
    jest.spyOn(ManagedKernelProcess, 'start').mockImplementation(async (_binary, _args, content) => {
      config = JSON.parse(content);
      const directory = await mkdtemp(join(tmpdir(), 'riri-relay-startup-'));
      const close: Array<() => Promise<void>> = [];
      try {
        const listeners = config.inbounds?.map(inbound => ({ port: inbound.listen_port, udp: ['hysteria2', 'tuic'].includes(inbound.type) }))
          ?? config.listeners!.map(listener => ({ port: listener.port, udp: false }));
        // 真实绑定能抓住把自检 HTTP 端口复用为代理端口的回归；TCP 接受并不代表代理流已 ready。
        for (const listener of listeners) {
          if (listener.udp) {
            const socket = createSocket('udp4');
            close.push(() => new Promise<void>(resolve => socket.close(() => resolve())));
            await new Promise<void>((resolve, reject) => { socket.once('error', reject); socket.bind(listener.port, '127.0.0.1', resolve); });
          } else {
            const server = createServer(socket => socket.destroy());
            close.push(() => new Promise<void>(resolve => server.close(() => resolve())));
            await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(listener.port, '127.0.0.1', resolve); });
          }
        }
      } catch (error) {
        await Promise.allSettled(close.map(stop => stop()));
        await rm(directory, { recursive: true, force: true });
        throw error;
      }
      let exit!: (code: number) => void;
      const child = { exitCode: null as number | null, signalCode: null };
      const exited = new Promise<number>(resolve => { exit = resolve; });
      let stopping: Promise<void> | undefined;
      managed = { directory, child, exited, stop: jest.fn(() => stopping ??= (async () => {
        child.exitCode = 0; exit(0);
        await Promise.all(close.map(stop => stop()));
        await rm(directory, { recursive: true, force: true });
      })()) } as unknown as ManagedKernelProcess;
      return managed;
    });
  });
  afterEach(async () => {
    try { await fixture?.close(); await managed?.stop(); }
    finally {
      jest.restoreAllMocks();
      if (encryptionKey === undefined) delete process.env.RIRICLOUD_ENCRYPTION_KEY;
      else process.env.RIRICLOUD_ENCRYPTION_KEY = encryptionKey;
    }
  });

  it.each<NativeRelayProtocol>(['VLESS', 'HYSTERIA2', 'NAIVE'])('%s client waits for data plane readiness after TCP accepts', async protocol => {
    await setup(protocol);
    let probes = 0;
    const ready = jest.spyOn(KernelReadiness.prototype, 'ready').mockImplementation(async () => ++probes >= 3);
    const run = jest.fn(async () => {
      expect(probes).toBe(3);
      if (protocol === 'NAIVE') {
        const direct = config.inbounds!.filter(inbound => inbound.tag === 'kernel-readiness');
        expect(direct).toHaveLength(1);
        expect(ready).toHaveBeenLastCalledWith(direct[0].listen_port);
        expect(config.route!.rules).toEqual([
          { inbound: ['kernel-readiness'], ip_cidr: ['127.0.0.1/32'], action: 'route', outbound: 'kernel-readiness-direct' },
          ...[0, 1, 2].map(index => ({ inbound: ['client-in-' + index], action: 'route', outbound: 'relay-' + index })),
          { action: 'reject' }
        ]);
      } else {
        const direct = config.listeners!.filter(listener => listener.proxy === 'DIRECT');
        expect(direct).toHaveLength(1);
        expect(ready).toHaveBeenLastCalledWith(direct[0].port);
        expect(config.listeners!.filter(listener => listener.proxy !== 'DIRECT').map(listener => listener.proxy)).toEqual(['relay-0', 'relay-1', 'relay-2']);
        expect(config.rules).toEqual(['MATCH,REJECT']);
      }
    });
    await internals.withClient(fixture.current, run);
    expect(run).toHaveBeenCalledTimes(1);
    expect(managed.stop).toHaveBeenCalled();
  });

  it.each<NativeRelayProtocol>(['VLESS', 'HYSTERIA2', 'NAIVE'])('%s server waits for an isolated proxy flow after TCP/UDP binds', async protocol => {
    await setup(protocol);
    let probes = 0;
    const ready = jest.spyOn(KernelReadiness.prototype, 'ready').mockImplementation(async () => ++probes >= 3);
    await internals.startServer();
    expect(probes).toBe(3);
    const direct = config.inbounds!.filter(inbound => inbound.tag === 'kernel-readiness');
    expect(direct).toHaveLength(1);
    expect(ready).toHaveBeenLastCalledWith(direct[0].listen_port);
    expect(config.inbounds!.filter(inbound => inbound.tag !== 'kernel-readiness').map(inbound => inbound.listen_port)).toEqual(internals.ports.map(port => port.number));
    expect(config.route!.rules).toEqual([
      { inbound: ['kernel-readiness'], ip_cidr: ['127.0.0.1/32'], action: 'route', outbound: 'controlled-target' },
      { ip_cidr: ['127.0.0.1/32'], port: [0], action: 'route', outbound: 'controlled-target' },
      { action: 'reject' }
    ]);
  });

  it.each(['client', 'server'])('never enters business assertions when the %s exits before readiness', async side => {
    await setup('HYSTERIA2');
    jest.spyOn(KernelReadiness.prototype, 'ready').mockImplementation(async () => { await managed.stop(); return false; });
    const run = jest.fn(async () => {});
    await expect(side === 'client' ? internals.withClient(fixture.current, run) : internals.startServer())
      .rejects.toMatchObject({ code: 'KERNEL_START_FAILED' });
    expect(run).not.toHaveBeenCalled();
    expect(managed.stop).toHaveBeenCalled();
  });

  it.each(['DIAL_FAILED', 'UNEXPECTED_HTTP_STATUS'])('propagates %s after readiness without retrying the business request', async code => {
    await setup('HYSTERIA2');
    const ready = jest.spyOn(KernelReadiness.prototype, 'ready').mockResolvedValue(true);
    const run = jest.fn(async () => { throw new KernelExecutionError(code); });
    await expect(internals.withClient(fixture.current, run)).rejects.toMatchObject({ code });
    expect(ready).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledTimes(1);
    expect(managed.stop).toHaveBeenCalled();
  });
});

describe('relay native fixture listener cleanup', () => {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
  afterEach(() => { Object.defineProperty(process, 'platform', platform); jest.restoreAllMocks(); });

  function linuxBindConflict(code = 'EADDRINUSE') {
    Object.defineProperty(process, 'platform', { ...platform, value: 'linux' });
    return jest.spyOn(network, 'createServer').mockImplementation(() => {
      const server = new EventEmitter();
      Object.assign(server, { listen: () => {
        queueMicrotask(() => server.emit('error', Object.assign(new Error(code), { code })));
        return server;
      } });
      return server as ReturnType<typeof createServer>;
    });
  }
  const row = (port: number, state: string, ipv6 = false) =>
    ' 0: ' + (ipv6 ? '00000000000000000000000001000000' : '0100007F') + ':' + port.toString(16).toUpperCase().padStart(4, '0')
    + ' 0100007F:1234 ' + state + ' 0:0 0:0 0 0 0 0';
  function tcpTables(ipv4: string[], ipv6: string[] = []) {
    return jest.spyOn(fileSystem, 'readFile').mockImplementation(async file =>
      ' sl local_address rem_address st\n' + (String(file) === '/proc/net/tcp' ? ipv4 : ipv6).join('\n') + '\n');
  }

  it('accepts free TCP and UDP ports using the original rebind assertion', async () => {
    const port = await reserveLoopbackPort();
    await expect(assertReleased({ number: port, udp: false })).resolves.toBeUndefined();
    await expect(assertReleased({ number: port, udp: true })).resolves.toBeUndefined();
  });
  it('still rejects a real live TCP listener', async () => {
    const server = createServer(socket => socket.destroy());
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      const port = (server.address() as { port: number }).port;
      await expect(assertReleased({ number: port, udp: false })).rejects.toThrow('NATIVE_LISTENER_NOT_RELEASED');
      expect(server.listening).toBe(true);
    } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
  });
  it('still rejects a real live UDP socket', async () => {
    const socket = createSocket('udp4');
    await new Promise<void>(resolve => socket.bind(0, '127.0.0.1', resolve));
    try {
      await expect(assertReleased({ number: socket.address().port, udp: true })).rejects.toThrow('NATIVE_LISTENER_NOT_RELEASED');
    } finally { await new Promise<void>(resolve => socket.close(resolve)); }
  });
  it('accepts a confirmed Linux TIME_WAIT bind conflict without extending the cleanup deadline', async () => {
    const binding = linuxBindConflict();
    const tables = tcpTables([row(23456, '06')]);
    await expect(assertReleased({ number: 23456, udp: false })).resolves.toBeUndefined();
    expect(binding).toHaveBeenCalledTimes(1);
    expect(tables.mock.calls.map(([file]) => file)).toEqual(['/proc/net/tcp', '/proc/net/tcp6']);
  });
  it.each([false, true])('rejects TIME_WAIT when an IPv6=%s LISTEN still exists at the same port', async ipv6 => {
    linuxBindConflict();
    tcpTables([row(23456, '06'), ...(!ipv6 ? [row(23456, '0A')] : [])], ipv6 ? [row(23456, '0A', true)] : []);
    await expect(assertReleased({ number: 23456, udp: false })).rejects.toThrow('NATIVE_LISTENER_NOT_RELEASED');
  });
  it('does not treat another port TIME_WAIT or an unexplained bind conflict as proof of cleanup', async () => {
    linuxBindConflict();
    tcpTables([row(23457, '06'), row(23456, '01')]);
    await expect(assertReleased({ number: 23456, udp: false })).rejects.toThrow('NATIVE_LISTENER_NOT_RELEASED');
  });
  it('fails closed if either kernel socket table cannot be read', async () => {
    linuxBindConflict();
    jest.spyOn(fileSystem, 'readFile').mockRejectedValue(Object.assign(new Error('EACCES'), { code: 'EACCES' }));
    await expect(assertReleased({ number: 23456, udp: false })).rejects.toMatchObject({ code: 'EACCES' });
  });
  it('does not turn a bind permission error into successful TIME_WAIT cleanup', async () => {
    linuxBindConflict('EACCES');
    const tables = tcpTables([row(23456, '06')]);
    await expect(assertReleased({ number: 23456, udp: false })).rejects.toMatchObject({ code: 'EACCES' });
    expect(tables).not.toHaveBeenCalled();
  });
});
