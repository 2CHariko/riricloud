import { createServer, type Server } from 'node:http';
import { mihomoUrlTest } from './mihomo-urltest';

const target = { id: 'fixture', url: new URL('https://original.example/generate_204'), address: '1.1.1.1', expectedStatus: 204 };
describe('bounded Mihomo delay controller client', () => {
  let server: Server;
  let port: number;
  let status = 200;
  let body = '{"delay":25}';
  let hang = false;
  let seen: { path?: string; authorization?: string };
  beforeEach(async () => {
    status = 200; body = '{"delay":25}'; hang = false; seen = {};
    server = createServer((req, res) => {
      seen = { path: req.url, authorization: req.headers.authorization };
      if (hang) return;
      res.writeHead(status); res.end(body);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as { port: number }).port;
  });
  afterEach(async () => { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); });
  it('uses authenticated loopback API, encoded proxy name and original HTTPS URL', async () => {
    expect(await mihomoUrlTest(port, 'secret', 'name /?', target, 500)).toBe(25);
    expect(seen.authorization).toBe('Bearer secret');
    const parsed = new URL(seen.path!, 'http://127.0.0.1');
    expect(parsed.pathname).toBe('/proxies/name%20%2F%3F/delay');
    expect(parsed.searchParams.get('url')).toBe(target.url.href);
    expect(parsed.searchParams.get('timeout')).toBe('500');
    expect(parsed.searchParams.get('expected')).toBe('204');
    expect(seen.path).not.toContain('1.1.1.1');
  });
  it.each(['{}', '[]', 'null', 'not-json', '{"delay":0}', '{"delay":-1}', '{"delay":1.5}', '{"delay":"25"}', '{"delay":65536}'])('rejects invalid delay body %s', async (value) => {
    body = value;
    await expect(mihomoUrlTest(port, 'secret', 'proxy', target, 500)).rejects.toThrow('URLTEST_RESPONSE_INVALID');
  });
  it('bounds controller response bytes and ignores raw error details', async () => {
    body = 'x'.repeat(16_385);
    await expect(mihomoUrlTest(port, 'secret', 'proxy', target, 500)).rejects.toThrow('URLTEST_RESPONSE_INVALID');
    status = 503; body = '{"message":"private-server-password"}';
    await expect(mihomoUrlTest(port, 'secret', 'proxy', target, 500)).rejects.toThrow('URLTEST_FAILED');
  });
  it.each([408, 504])('maps HTTP %s to timeout', async (value) => {
    status = value;
    await expect(mihomoUrlTest(port, 'secret', 'proxy', target, 500)).rejects.toThrow('NETWORK_TIMEOUT');
  });
  it('bounds a stalled controller and cancels immediately', async () => {
    hang = true;
    await expect(mihomoUrlTest(port, 'secret', 'proxy', target, 20)).rejects.toThrow('NETWORK_TIMEOUT');
    const controller = new AbortController();
    const pending = mihomoUrlTest(port, 'secret', 'proxy', target, 10000, controller.signal);
    controller.abort();
    await expect(pending).rejects.toThrow('CANCELED');
  });
});
