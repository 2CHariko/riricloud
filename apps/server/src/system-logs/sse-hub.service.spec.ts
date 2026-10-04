import { SSEHubService } from './sse-hub.service';

describe('SSEHubService filters', () => {
  it('与查询对齐模块/trace/user/时间过滤，关闭释放连接', () => {
    const hub = new SSEHubService();
    const entries: unknown[] = [];
    const sub = hub.subscribe({ module: 'singbox', traceId: 'op-1', userId: 'u1', startTime: '2026-10-04T00:00:00Z', endTime: '2026-10-04T01:00:00Z' }).subscribe((entry) => entries.push(entry));
    const item = { id: 'l1', traceId: 'op-1', userId: 'u1', source: 'AGENT', level: 'ERROR', module: 'Singbox', metadata: '{}', message: 'timeout', createdAt: new Date('2026-10-04T00:30:00Z') };
    hub.publish({ ...item, module: 'HTTP' });
    hub.publish({ ...item, traceId: 'op-2' });
    hub.publish({ ...item, userId: 'u2' });
    hub.publish({ ...item, createdAt: new Date('2026-10-03T00:30:00Z') });
    hub.publish(item);
    expect(entries).toHaveLength(1);
    sub.unsubscribe();
    for (let i = 0; i < 40; i++) hub.subscribe().subscribe().unsubscribe();
  });
  it('关键词去除两端空格且匹配元数据，保持与查询一致', () => {
    const hub = new SSEHubService();
    const entries: unknown[] = [];
    const sub = hub.subscribe({ keyword: ' task-123 ' }).subscribe((entry) => entries.push(entry));
    hub.publish({ id: 'l1', source: 'AGENT', level: 'INFO', module: 'NodeDiagnostics', metadata: '{"taskId":"task-123"}', message: 'snapshot', createdAt: new Date() });
    expect(entries).toHaveLength(1);
    sub.unsubscribe();
  });
});
