import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { randomBytes } from 'node:crypto';
import { proxyHttpDelay } from './proxy-http';
import { probeConnectionSlots } from '../../client-kernels/kernel-process';

// 仅回环自检：确认内核已处理代理流，而非只确认 listener 接受 TCP。
// 此请求绝不访问业务目标、不计入业务延迟，DIRECT 只属于独立启动屏障 listener。
export class KernelReadiness {
  private readonly secret = randomBytes(32).toString('hex');
  private readonly server: Server;
  private port = 0;
  constructor() {
    this.server = createServer((req, res) => { res.writeHead(req.url === `/${this.secret}` ? 204 : 404); res.end(); });
  }
  async listen(): Promise<void> {
    await new Promise<void>((resolve, reject) => { this.server.once('error', reject); this.server.listen(0, '127.0.0.1', () => { this.port = (this.server.address() as { port: number }).port; resolve(); }); });
  }
  async ready(proxyPort: number, signal?: AbortSignal): Promise<boolean> {
    let release: (() => void) | undefined;
    try { release = await probeConnectionSlots.acquire(signal); await proxyHttpDelay(proxyPort, { id: 'kernel-readiness', url: new URL(`http://127.0.0.1:${this.port}/${this.secret}`), address: '127.0.0.1', expectedStatus: 204 }, 250, signal); return true; }
    catch { return false; }
    finally { release?.(); }
  }
  async close(): Promise<void> {
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }
}
