import { ClientKernelsService } from '../../client-kernels/client-kernels.service';
import { compileMihomoProxy } from './mihomo-proxy';
import { compileSingboxClient } from './singbox-client';

const native = process.env.RUN_NATIVE_CLIENT_TESTS === '1' ? describe : describe.skip;
const uuid = 'a77cf184-4b56-41ee-962c-1357184acd77';
const connections = [
  { protocolType: 'VLESS', params: { uuid } },
  { protocolType: 'VMESS', params: { uuid, tls: { mode: 'tls' }, transport: { type: 'ws', path: '/ws', host: 'cdn.example.com', maxEarlyData: 1024, earlyDataHeaderName: 'Sec-WebSocket-Protocol' } } },
  { protocolType: 'TROJAN', params: { password: 'password', transport: { type: 'grpc', serviceName: 'grpc' } } },
  { protocolType: 'SHADOWSOCKS', params: { method: 'aes-256-gcm', password: 'password', plugin: 'obfs-local', pluginOpts: 'obfs=http;obfs-host=example.com' } },
  { protocolType: 'SHADOWSOCKS', params: { method: '2022-blake3-aes-128-gcm', password: Buffer.alloc(16, 1).toString('base64') } },
  { protocolType: 'SHADOWTLS', params: { version: 3, password: 'outer', handshakeDest: 'example.com:443', inner: { type: 'SHADOWSOCKS', method: '2022-blake3-aes-128-gcm', password: Buffer.alloc(16, 1).toString('base64') } } },
  { protocolType: 'HYSTERIA2', params: { password: 'password', upMbps: 100, downMbps: 200, obfs: { type: 'salamander', password: 'obfs' } } },
  { protocolType: 'TUIC', params: { uuid, password: 'password', heartbeat: '10s', zeroRttHandshake: true } },
  { protocolType: 'SOCKS', params: { tls: { mode: 'tls', serverName: 'example.com' } } },
  { protocolType: 'HTTP', params: { username: 'user', password: 'password', tls: { mode: 'tls' } } }
];
native('real client compiler capability checks', () => {
  const kernels = new ClientKernelsService();
  it.each(connections)('validates Mihomo $protocolType connection without Sing-box dependency', async (item) => {
    const proxy = compileMihomoProxy({ ...item, serverHost: '1.1.1.1', serverPort: 443 }, 'native-proxy');
    expect(await kernels.validate('MIHOMO', JSON.stringify({ dns: { enable: false }, proxies: [proxy], rules: ['MATCH,REJECT'] }))).toMatchObject({ status: 'PASSED', executed: true });
  }, 10_000);
  it.each(['4', '4a'])('validates Sing-box SOCKS%s fallback config natively', async (version) => {
    const outbound = compileSingboxClient({ protocolType: 'SOCKS', serverHost: '1.1.1.1', serverPort: 1080, params: { version } }, 'probe');
    expect(await kernels.validate('SINGBOX', JSON.stringify({ outbounds: [outbound] }))).toMatchObject({ status: 'PASSED', executed: true });
  }, 10_000);
  it('validates Sing-box certificate trust fallback with real PEM input', async () => {
    const { testCertificate } = await import('../../probe/executors/test-certificate');
    const certificate = testCertificate('example.com').cert;
    const outbound = compileSingboxClient({ protocolType: 'HTTP', serverHost: '1.1.1.1', serverPort: 443, params: { tls: { mode: 'tls', certificate: [certificate] } } }, 'probe');
    expect(await kernels.validate('SINGBOX', JSON.stringify({ outbounds: [outbound] }))).toMatchObject({ status: 'PASSED', executed: true });
  }, 10_000);
  it('reports real Naive native dependencies rather than assuming a compiled tag is usable', async () => {
    const kernel = await kernels.resolve('SINGBOX');
    expect(kernel).not.toBeNull();
    expect(typeof await kernels.supportsNaive(kernel!)).toBe('boolean');
  }, 10_000);
});
