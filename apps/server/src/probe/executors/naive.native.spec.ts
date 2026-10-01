import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { createSecureServer, type Http2SecureServer, type ServerHttp2Session } from 'node:http2';
import { connect, type Socket } from 'node:net';
import { Transform, type TransformCallback } from 'node:stream';
import { TLSSocket } from 'node:tls';
import { ClientKernelsService } from '../../client-kernels/client-kernels.service';
import type { ProxyConnection } from '../../common/proxy-connection';
import { ProbeService } from '../probe.service';
import type { ProbePolicy } from '../probe.types';
import { testCertificate } from './test-certificate';

// Naive 的前八个数据块使用 uint16be 长度 + uint8 padding 长度；之后是原始字节流。
// 独立 fixture 不使用 Sing-box 入站，避免同内核两端一起错误时产生伪通过。
class NaiveUnpadding extends Transform {
  private pending = Buffer.alloc(0);
  private count = 0;
  override _transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback): void {
    this.pending = Buffer.concat([this.pending, chunk]);
    while (this.count < 8 && this.pending.length >= 3) {
      const length = this.pending.readUInt16BE(0);
      const frameLength = 3 + length + this.pending[2];
      if (this.pending.length < frameLength) break;
      this.push(this.pending.subarray(3, 3 + length));
      this.pending = this.pending.subarray(frameLength);
      this.count += 1;
    }
    if (this.count === 8) { this.push(this.pending); this.pending = Buffer.alloc(0); }
    callback();
  }
  override _flush(callback: TransformCallback): void {
    callback(this.pending.length ? new Error('Incomplete Naive frame') : undefined);
  }
}
class NaivePadding extends Transform {
  private count = 0;
  override _transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback): void {
    for (let offset = 0; offset < chunk.length; offset += 65_535) {
      const data = chunk.subarray(offset, offset + 65_535);
      if (this.count++ < 8) {
        const padding = randomBytes(17);
        const header = Buffer.alloc(3); header.writeUInt16BE(data.length); header[2] = padding.length;
        this.push(Buffer.concat([header, data, padding]));
      } else this.push(data);
    }
    callback();
  }
}

const native = process.env.RUN_NATIVE_CLIENT_TESTS === '1' && process.platform === 'linux' ? describe : describe.skip;
native('Linux real Naive/Cronet capability-whitelisted probes', () => {
  const kernels = new ClientKernelsService();
  const engine = new ProbeService(kernels);
  const certificate = testCertificate('naive.fixture.example');
  const username = randomBytes(12).toString('hex');
  const password = randomBytes(24).toString('hex');
  const sessions = new Set<ServerHttp2Session>();
  const sockets = new Set<Socket>();
  let target: Server;
  let proxy: Http2SecureServer;
  let targetPort: number;
  let proxyPort: number;
  let targetStatus = 204;
  let targetRequests = 0;
  let authenticatedConnects = 0;
  let rejectedConnects = 0;
  let paddedConnects = 0;
  let observedHttp2 = false;

  beforeAll(async () => {
    target = createServer((req, res) => {
      targetRequests += 1;
      if (req.url !== '/204' || req.headers.host !== `target.fixture.example:${targetPort}`) { res.writeHead(400); res.end(); return; }
      res.writeHead(targetStatus); res.end();
    });
    targetPort = await new Promise((resolve) => target.listen(0, '127.0.0.1', () => resolve((target.address() as { port: number }).port)));
    proxy = createSecureServer({ cert: certificate.cert, key: certificate.key, allowHTTP1: false });
    proxy.on('session', (session) => {
      sessions.add(session); session.once('close', () => sessions.delete(session));
      session.on('error', () => {});
    });
    proxy.on('stream', (stream, headers) => {
      stream.on('error', () => {});
      const supplied = Buffer.from(String(headers['proxy-authorization'] ?? ''));
      const expected = Buffer.from(`Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`);
      if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
        rejectedConnects += 1;
        stream.respond({ ':status': 407, 'proxy-authenticate': 'Basic realm="fixture"' }); stream.end(); return;
      }
      // 仅允许访问本次目标，禁止 fixture 成为开放代理。
      if (headers[':method'] !== 'CONNECT' || headers[':authority'] !== `127.0.0.1:${targetPort}`) {
        stream.respond({ ':status': 403 }); stream.end(); return;
      }
      authenticatedConnects += 1;
      if (typeof headers.padding === 'string' && headers.padding.length > 0) paddedConnects += 1;
      const transport = stream.session?.socket;
      observedHttp2 = transport instanceof TLSSocket && transport.alpnProtocol === 'h2';
      const socket = connect({ host: '127.0.0.1', port: targetPort });
      sockets.add(socket); socket.setTimeout(5_000, () => socket.destroy());
      socket.once('close', () => sockets.delete(socket));
      const decoder = new NaiveUnpadding(); const encoder = new NaivePadding();
      const close = () => { decoder.destroy(); encoder.destroy(); socket.destroy(); stream.close(); };
      socket.on('error', close); decoder.on('error', close); encoder.on('error', close);
      stream.once('close', () => { socket.destroy(); decoder.destroy(); encoder.destroy(); });
      socket.once('connect', () => {
        stream.respond({ ':status': 200, padding: 'fixture-padding' });
        stream.pipe(decoder).pipe(socket); socket.pipe(encoder).pipe(stream);
      });
    });
    proxyPort = await new Promise((resolve) => proxy.listen(0, '127.0.0.1', () => resolve((proxy.address() as { port: number }).port)));
    // 只替换公网 DNS/SSRF 策略，真实编译、依赖检查、TLS、认证与请求均不 mock。
    jest.spyOn(engine.targetPolicy, 'target').mockImplementation(async (value) => ({ id: value.id, url: new URL(value.url), address: '127.0.0.1', expectedStatus: value.expectedStatus }));
    jest.spyOn(engine.targetPolicy, 'connection').mockImplementation(async (value) => value);
  }, 10_000);
  afterAll(async () => {
    for (const socket of sockets) socket.destroy();
    for (const session of sessions) session.destroy();
    if (proxy) await new Promise<void>((resolve) => proxy.close(() => resolve()));
    if (target) { target.closeAllConnections(); await new Promise<void>((resolve) => target.close(() => resolve())); }
    jest.restoreAllMocks();
  }, 10_000);

  const connection = (): ProxyConnection => ({ protocolType: 'NAIVE', serverHost: '127.0.0.1', serverPort: proxyPort, params: { username, password, tls: { mode: 'tls', serverName: 'naive.fixture.example', certificate: [certificate.cert] } } });
  const execute = async (value = connection(), policy: ProbePolicy = 'MIHOMO_PREFERRED') => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 12_000);
    try {
      const results = await engine.executeBatch([{ subjectType: 'UPSTREAM_NODE', subjectId: 'naive-fixture', configHash: 'naive-fixture-v1', routeKind: 'UPSTREAM_DIRECT', connection: value }], { id: 'naive-target', url: `http://target.fixture.example:${targetPort}/204`, expectedStatus: 204 }, 2_000, policy, controller.signal);
      return results[0];
    } finally { clearTimeout(timer); }
  };

  it('MIHOMO_PREFERRED makes an authenticated padded HTTP/2 request with explicit Sing-box metadata', async () => {
    const kernel = await kernels.resolve('SINGBOX'); expect(kernel).not.toBeNull();
    expect(await kernels.supportsNaive(kernel!)).toBe(true);
    const before = targetRequests;
    const result = await execute();
    expect(result).toMatchObject({ status: 'SUCCESS', errorCode: null, engine: 'SINGBOX', engineVersion: '1.14.0', mihomoCompatibility: 'UNSUPPORTED', fallbackReason: 'MIHOMO_NAIVE_UNSUPPORTED', stage: 'DIAL_HTTP', latencyMs: expect.any(Number) });
    expect(result.latencyMs).toBeGreaterThan(0);
    expect(targetRequests).toBe(before + 1);
    expect(authenticatedConnects).toBeGreaterThan(0); expect(paddedConnects).toBe(authenticatedConnects); expect(observedHttp2).toBe(true);
  }, 15_000);

  it('MIHOMO_ONLY rejects Naive before starting any kernel or touching the fixture', async () => {
    const before = authenticatedConnects + rejectedConnects;
    const resolve = jest.spyOn(kernels, 'resolve');
    try {
      expect(await execute(connection(), 'MIHOMO_ONLY')).toMatchObject({ status: 'UNSUPPORTED', errorCode: 'MIHOMO_NAIVE_UNSUPPORTED', engine: null, engineVersion: null, fallbackReason: null, latencyMs: null });
      expect(resolve).not.toHaveBeenCalled();
      expect(authenticatedConnects + rejectedConnects).toBe(before);
    } finally { resolve.mockRestore(); }
  }, 15_000);

  it('wrong credentials reach HTTP/2 auth rejection and never reach the target', async () => {
    const value = connection(); value.params.password = randomBytes(24).toString('hex');
    const requests = targetRequests; const rejected = rejectedConnects;
    const result = await execute(value);
    expect(result).toMatchObject({ status: 'ERROR', errorCode: 'DIAL_FAILED', engine: 'SINGBOX', fallbackReason: 'MIHOMO_NAIVE_UNSUPPORTED', stage: 'DIAL_HTTP', latencyMs: null });
    expect(rejectedConnects).toBeGreaterThan(rejected); expect(targetRequests).toBe(requests);
  }, 15_000);

  it.each(['untrusted certificate', 'incorrect SNI'])('%s fails without disabling TLS verification', async (reason) => {
    const value = connection();
    value.params.tls = { mode: 'tls', serverName: reason === 'incorrect SNI' ? 'wrong.fixture.example' : 'naive.fixture.example', ...(reason === 'incorrect SNI' ? { certificate: [certificate.cert] } : {}) };
    const requests = targetRequests; const connects = authenticatedConnects + rejectedConnects;
    expect(await execute(value)).toMatchObject({ status: 'ERROR', errorCode: 'DIAL_FAILED', engine: 'SINGBOX', stage: 'DIAL_HTTP', latencyMs: null });
    expect(targetRequests).toBe(requests); expect(authenticatedConnects + rejectedConnects).toBe(connects);
  }, 15_000);

  it('a real target HTTP 500 cannot be reported as successful delay', async () => {
    targetStatus = 500;
    const before = targetRequests;
    try {
      expect(await execute()).toMatchObject({ status: 'ERROR', errorCode: 'UNEXPECTED_HTTP_STATUS', engine: 'SINGBOX', fallbackReason: 'MIHOMO_NAIVE_UNSUPPORTED', stage: 'DIAL_HTTP', latencyMs: null });
      expect(targetRequests).toBe(before + 1);
    } finally { targetStatus = 204; }
  }, 15_000);
});
