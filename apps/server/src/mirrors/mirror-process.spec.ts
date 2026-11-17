import { fork, type ChildProcess } from 'node:child_process';
import { request, type ClientRequest, type IncomingMessage } from 'node:http';
import { resolve } from 'node:path';
import { WebSocket } from 'ws';

type Snapshot = { pid: number; activeTasks: number; gatewaySessions: number; mirrorTimers: number; rateCounters: number; logWrites: number; capacity: { active: number; reservedBufferBytes: number; nodes: number } };
type ChildMessage = { type: string; port: number; snapshot: Snapshot };

class FixtureProcess {
  child: ChildProcess;
  private messages: ChildMessage[] = [];
  private waiters: (() => void)[] = [];
  private errors = '';
  readonly exited: Promise<void>;
  constructor() {
    this.child = fork(resolve('../../scripts/mirror-process.fixture.cjs'), [], { cwd: process.cwd(), env: { ...process.env, NODE_ENV: 'test', RIRICLOUD_ENV: 'test' }, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
    this.child.stderr?.on('data', (data: Buffer) => { this.errors = (this.errors + data.toString()).slice(-4000); });
    this.child.on('message', (message: ChildMessage) => { this.messages.push(message); this.waiters.splice(0).forEach(wake => wake()); });
    this.exited = new Promise(resolveExit => this.child.once('exit', () => { resolveExit(); this.waiters.splice(0).forEach(wake => wake()); }));
  }
  async wait(type: string, timeoutMs = 15_000): Promise<ChildMessage> {
    const timeout = setTimeout(() => this.waiters.splice(0).forEach(wake => wake()), timeoutMs);
    const deadline = Date.now() + timeoutMs;
    try {
      for (;;) {
        const index = this.messages.findIndex(message => message.type === type);
        if (index >= 0) return this.messages.splice(index, 1)[0];
        if (Date.now() >= deadline || this.child.exitCode !== null || this.child.signalCode !== null) throw new Error('fixture missing ' + type + ': ' + this.errors);
        await new Promise<void>(wake => this.waiters.push(wake));
      }
    } finally { clearTimeout(timeout); }
  }
  async inspect() { this.child.send({ type: 'snapshot' }); return (await this.wait('snapshot')).snapshot; }
  async naturalExit() {
    await Promise.race([this.exited, new Promise<never>((_resolve, reject) => { const timer = setTimeout(() => reject(new Error('fixture retained timers or handles')), 3000); this.exited.then(() => clearTimeout(timer)); })]);
    expect(this.child.exitCode).toBe(0);
  }
  async cleanup() { if (this.child.exitCode === null && this.child.signalCode === null) { this.child.kill(); await this.exited; } }
}

function assertEmpty(state: Snapshot, fresh = false) {
  expect(state.activeTasks).toBe(0); expect(state.gatewaySessions).toBe(0); expect(state.mirrorTimers).toBe(0);
  expect(state.capacity).toEqual({ active: 0, reservedBufferBytes: 0, nodes: 0 });
  if (fresh) { expect(state.rateCounters).toBe(0); expect(state.logWrites).toBe(0); }
}

async function connectAgent(fixture: FixtureProcess, port: number) {
  const socket = new WebSocket('ws://127.0.0.1:' + port + '/agent');
  const frames: { type: string; data: { taskId: string } }[] = [];
  socket.on('message', raw => frames.push(JSON.parse(raw.toString())));
  await fixture.wait('agent-connected');
  return { socket, frames };
}
function beginRequest(port: number) {
  let response: IncomingMessage | undefined;
  let finish!: () => void;
  const closed = new Promise<void>(resolveClose => { finish = resolveClose; });
  const req: ClientRequest = request({ hostname: '127.0.0.1', port, path: '/mirror', agent: false }, incoming => { response = incoming; incoming.resume(); incoming.once('close', finish); incoming.once('error', finish); });
  req.once('error', finish); req.end();
  return { closed, close: () => { response?.destroy(); req.destroy(); } };
}
async function waitForTask(fixture: FixtureProcess) {
  for (let i = 0; i < 50; i++) {
    const state = await fixture.inspect();
    if (state.gatewaySessions === 1) return state;
    await new Promise(resolveWait => setTimeout(resolveWait, 10));
  }
  throw new Error('mirror task was not registered');
}
function binary(taskId: string, text: string) { const id = Buffer.from(taskId); const size = Buffer.alloc(2); size.writeUInt16BE(id.length); return Buffer.concat([size, id, Buffer.from(text)]); }

describe('Mirror actual process lifecycle', () => {
  jest.setTimeout(45_000);
  it('recovers empty state after graceful stop and an actual abrupt process restart', async () => {
    const children: FixtureProcess[] = []; const sockets: WebSocket[] = []; const requests: ReturnType<typeof beginRequest>[] = [];
    try {
      const first = new FixtureProcess(); children.push(first);
      const ready = await first.wait('ready'); assertEmpty(ready.snapshot, true);
      const agent = await connectAgent(first, ready.port); sockets.push(agent.socket);
      const pending = beginRequest(ready.port); requests.push(pending);
      const active = await waitForTask(first);
      expect(active.activeTasks).toBe(1); expect(active.capacity.active).toBe(1); expect(active.mirrorTimers).toBe(1); expect(active.rateCounters).toBeGreaterThan(0);
      first.child.send({ type: 'shutdown' });
      const stopped = await first.wait('stopped'); assertEmpty(stopped.snapshot);
      expect(stopped.snapshot.logWrites).toBe(1);
      await pending.closed; await first.naturalExit();

      const second = new FixtureProcess(); children.push(second); const ready2 = await second.wait('ready');
      assertEmpty(ready2.snapshot, true); expect(ready2.snapshot.pid).not.toBe(ready.snapshot.pid);
      const agent2 = await connectAgent(second, ready2.port); sockets.push(agent2.socket);
      const broken = beginRequest(ready2.port); requests.push(broken); await waitForTask(second);
      const oldId = agent2.frames.find(frame => frame.type === 'mirror_request')?.data.taskId;
      expect(oldId).toBeDefined();
      const peerClosed = new Promise<void>(resolveClose => agent2.socket.once('close', () => resolveClose()));
      second.child.kill('SIGKILL'); await second.exited; await peerClosed; await broken.closed;

      const third = new FixtureProcess(); children.push(third); const ready3 = await third.wait('ready');
      assertEmpty(ready3.snapshot, true); expect(ready3.snapshot.pid).not.toBe(ready2.snapshot.pid);
      const agent3 = await connectAgent(third, ready3.port); sockets.push(agent3.socket);
      agent3.socket.send(binary(oldId!, 'stale-body'));
      agent3.socket.send(JSON.stringify({ type: 'mirror_response_end', data: { taskId: oldId, success: true, bytes: 10 } }));
      assertEmpty(await third.inspect(), true);
      const next = beginRequest(ready3.port); requests.push(next); await waitForTask(third);
      agent3.socket.close(); await third.wait('agent-disconnected'); await next.closed;
      const disconnected = await third.inspect(); assertEmpty(disconnected); expect(disconnected.logWrites).toBe(1);
      third.child.send({ type: 'shutdown' }); assertEmpty((await third.wait('stopped')).snapshot); await third.naturalExit();
    } finally {
      requests.forEach(item => item.close()); sockets.forEach(socket => socket.terminate());
      await Promise.all(children.map(child => child.cleanup()));
    }
  });
});
