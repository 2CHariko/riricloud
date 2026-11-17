import { AgentService, type MirrorStreamHandlers } from '../agent-gateway/agent.service';

// 在镜像域验证既有 Gateway 路由契约，不复制实现或改动安全核心。
function fixture() {
  const handlers = (): MirrorStreamHandlers => ({ onHeaders: jest.fn(), onChunk: jest.fn(), onEnd: jest.fn(), onError: jest.fn() });
  const first = handlers(); const second = handlers();
  const sessions = new Map([['first', { nodeId: 'node-1', handlers: first }], ['second', { nodeId: 'node-1', handlers: second }]]);
  const gateway = Object.create(AgentService.prototype) as AgentService;
  Object.assign(gateway, { mirrorSessions: sessions });
  return { gateway, sessions, first, second };
}
function frame(taskId: string, body: string) {
  const id = Buffer.from(taskId); const size = Buffer.alloc(2); size.writeUInt16BE(id.length);
  return Buffer.concat([size, id, Buffer.from(body)]);
}

describe('Mirror Gateway routing contract', () => {
  it('ignores malformed, unknown and cross-node frames while preserving per-task ordering', () => {
    const f = fixture();
    for (const bad of [Buffer.alloc(0), Buffer.from([0]), Buffer.from([0, 0, 1]), Buffer.from([0, 128, 1]), frame('x'.repeat(129), 'payload'), frame('unknown', 'payload')]) f.gateway.handleMirrorBinary('node-1', bad);
    f.gateway.handleMirrorBinary('node-2', frame('first', 'cross-node'));
    expect(f.first.onChunk).not.toHaveBeenCalled(); expect(f.second.onChunk).not.toHaveBeenCalled();
    f.gateway.handleMirrorBinary('node-1', frame('first', 'one'));
    f.gateway.handleMirrorBinary('node-1', frame('second', 'other'));
    f.gateway.handleMirrorBinary('node-1', frame('first', 'two'));
    expect(f.first.onChunk).toHaveBeenNthCalledWith(1, Buffer.from('one'));
    expect(f.first.onChunk).toHaveBeenNthCalledWith(2, Buffer.from('two'));
    expect(f.second.onChunk).toHaveBeenCalledWith(Buffer.from('other'));
  });
  it('removes a terminal session before callbacks and ignores late chunks/end/error', () => {
    const f = fixture();
    f.gateway.handleMirrorText('node-2', 'mirror_response_end', { taskId: 'first', bytes: 1, success: true });
    expect(f.first.onEnd).not.toHaveBeenCalled();
    f.gateway.handleMirrorText('node-1', 'mirror_response_end', { taskId: 'first', bytes: 1, success: true });
    f.gateway.handleMirrorText('node-1', 'mirror_error', { taskId: 'first', code: 'late', message: 'late' });
    f.gateway.handleMirrorBinary('node-1', frame('first', 'late'));
    expect(f.sessions.has('first')).toBe(false);
    expect(f.first.onEnd).toHaveBeenCalledTimes(1);
    expect(f.first.onError).not.toHaveBeenCalled(); expect(f.first.onChunk).not.toHaveBeenCalled();
    expect(f.sessions.has('second')).toBe(true);
  });
});
