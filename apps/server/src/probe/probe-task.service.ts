import { BadRequestException, HttpException, Injectable, NotFoundException, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { SettingsService } from '../system/settings.service';
import { ProbeService } from './probe.service';
import { ProbeResourceService, probeHash, type ProbeSelection, type ResourceSnapshot } from './probe-resource.service';
import { safeProbeResult } from './probe-result';
import type { ProbePolicy, ProbeResult, ProbeSubjectType, ProbeTarget } from './probe.types';

export type ProbeTaskState = 'QUEUED' | 'RUNNING' | 'COMPLETED' | 'CANCELED' | 'FAILED';
interface Task {
  taskId: string; ownerId: string; subjectType: ProbeSubjectType; ids: string[]; sequence: number; key: string;
  policy: ProbePolicy; executionPolicy: ProbePolicy; target: ProbeTarget; timeoutMs: number; state: ProbeTaskState;
  phase: string; createdAt: string; expiresAt: string; startedAt: string | null; finishedAt: string | null;
  results: Map<string, ProbeResult>; controller: AbortController; cursor: number; deadline?: NodeJS.Timeout;
}
const terminal = (state: ProbeTaskState) => ['COMPLETED', 'CANCELED', 'FAILED'].includes(state);
const RETENTION = 15 * 60_000;
const DEADLINE = 30 * 60_000;

@Injectable()
export class ProbeTaskService implements OnModuleInit, OnModuleDestroy {
  private readonly tasks = new Map<string, Task>();
  private readonly queue: Task[] = [];
  private workers = 0;
  private stopping = false;
  private sweepTimer?: NodeJS.Timeout;
  constructor(private readonly resources: ProbeResourceService, private readonly engine: ProbeService, private readonly settings: SettingsService) {}
  onModuleInit() { this.sweepTimer = setInterval(() => this.sweep(), 60_000); this.sweepTimer.unref(); }
  onModuleDestroy() {
    this.stopping = true;
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    for (const task of this.tasks.values()) { if (!terminal(task.state)) this.finish(task, 'CANCELED'); task.results.clear(); }
    this.queue.length = 0; this.tasks.clear();
  }
  async start(ownerId: string, subjectType: ProbeSubjectType, selection: ProbeSelection, policy: ProbePolicy = 'MIHOMO_PREFERRED') {
    if (!ownerId || this.stopping) throw new BadRequestException('探针服务不可用');
    if (!['MIHOMO_PREFERRED', 'MIHOMO_ONLY'].includes(policy)) throw new BadRequestException('探针策略无效');
    const settings = await this.settings.getSettings();
    let url: URL;
    try { url = new URL(settings.lineSpeedtestTargetUrl); } catch { throw new BadRequestException('探针目标配置无效'); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash) throw new BadRequestException('探针目标配置无效');
    const target: ProbeTarget = { id: probeHash(url.href), url: url.href, expectedStatus: /(?:generate_204|\/204)\/?$/.test(url.pathname) ? 204 : 200 };
    const ids = await this.resources.listIds(subjectType, selection);
    if (this.stopping) throw new BadRequestException('探针服务正在关闭');
    if (ids.length > 10000) throw new BadRequestException('单个探针任务最多包含 10000 个资源');
    this.sweep();
    const executionPolicy: ProbePolicy = settings.probeSingboxFallbackEnabled === false ? 'MIHOMO_ONLY' : policy;
    const key = probeHash([subjectType, ids, target, policy, executionPolicy]);
    const duplicate = [...this.tasks.values()].find((task) => !terminal(task.state) && task.key === key && task.ownerId === ownerId);
    if (duplicate) return this.receipt(duplicate);
    if ([...this.tasks.values()].filter((task) => task.ownerId === ownerId && !terminal(task.state)).length >= 2) throw new HttpException('每位管理员最多同时运行两个探针任务', 429);
    if ([...this.tasks.values()].filter((task) => !terminal(task.state)).length >= 20) throw new HttpException('探针队列已满', 429);
    const now = Date.now();
    const task: Task = { taskId: randomUUID(), ownerId, subjectType, ids, sequence: this.resources.reserve(subjectType, ids), key, policy, executionPolicy, target, timeoutMs: Math.min(30000, Math.max(500, settings.lineSpeedtestTimeoutMs)), state: 'QUEUED', phase: 'QUEUED', createdAt: new Date(now).toISOString(), expiresAt: new Date(now + DEADLINE).toISOString(), startedAt: null, finishedAt: null, results: new Map(), controller: new AbortController(), cursor: 0 };
    task.deadline = setTimeout(() => { if (!terminal(task.state)) this.finish(task, 'FAILED', 'TASK_DEADLINE'); }, DEADLINE); task.deadline.unref();
    this.tasks.set(task.taskId, task); this.queue.push(task);
    setImmediate(() => this.pump());
    return this.receipt(task);
  }
  private receipt(task: Task) { return { taskId: task.taskId, state: task.state, total: task.ids.length }; }
  summary(id: string) {
    const task = this.find(id), results = [...task.results.values()];
    const success = results.filter((r) => r.status === 'SUCCESS').length;
    const skipped = results.filter((r) => ['SKIPPED', 'UNSUPPORTED', 'ENVIRONMENT_UNAVAILABLE', 'CANCELED', 'STALE'].includes(r.status)).length;
    return { ...this.receipt(task), completed: results.length, success, failed: results.length - success - skipped, skipped, phase: task.phase, policy: task.policy, targetId: task.target.id, createdAt: task.createdAt, startedAt: task.startedAt, finishedAt: task.finishedAt, expiresAt: task.expiresAt };
  }
  results(id: string, page = 1, pageSize = 20) {
    if (!Number.isInteger(page) || page < 1 || !Number.isInteger(pageSize) || pageSize < 1 || pageSize > 200) throw new BadRequestException('探针分页参数无效');
    const task = this.find(id), data = [...task.results.values()];
    return { data: data.slice((page - 1) * pageSize, page * pageSize), total: data.length, page, pageSize };
  }
  cancel(id: string) { const task = this.find(id); if (!terminal(task.state)) this.finish(task, 'CANCELED'); return this.summary(id); }
  private find(id: string) { this.sweep(); const task = this.tasks.get(id); if (!task) throw new NotFoundException('探针任务不存在或已过期'); return task; }
  private sweep() {
    const now = Date.now();
    for (const task of this.tasks.values()) if (terminal(task.state) && Date.parse(task.expiresAt) <= now) { task.results.clear(); this.tasks.delete(task.taskId); }
    const finished = [...this.tasks.values()].filter((task) => terminal(task.state)).sort((a, b) => Date.parse(a.finishedAt!) - Date.parse(b.finishedAt!));
    for (const task of finished.slice(0, Math.max(0, finished.length - 50))) { task.results.clear(); this.tasks.delete(task.taskId); }
  }
  private pump() {
    if (this.stopping) return;
    while (this.workers < 4 && this.queue.length) {
      const task = this.queue.shift()!;
      if (terminal(task.state)) continue;
      this.workers++;
      void this.chunk(task).catch(() => { if (!terminal(task.state)) this.finish(task, 'FAILED', 'TASK_EXECUTION_FAILED'); }).finally(() => {
        this.workers--;
        if (!terminal(task.state)) this.queue.push(task);
        setImmediate(() => this.pump());
      });
    }
  }
  private async chunk(task: Task) {
    task.state = 'RUNNING'; task.startedAt ??= new Date().toISOString(); task.phase = 'SNAPSHOT';
    const snapshots = new Map<string, ResourceSnapshot>();
    const ids = task.ids.slice(task.cursor, task.cursor + 32); task.cursor += ids.length;
    for (const id of ids) {
      if (task.controller.signal.aborted) return;
      try {
        const snapshot = await this.resources.snapshot(task.subjectType, id, task.sequence);
        if (task.controller.signal.aborted) return;
        if (snapshot) snapshots.set(id, snapshot);
        else task.results.set(id, this.localResult(task, id, 'SKIPPED', 'RESOURCE_UNAVAILABLE'));
      } catch { if (!task.controller.signal.aborted) task.results.set(id, this.localResult(task, id, 'ERROR', 'RESOURCE_INVALID')); }
    }
    if (task.controller.signal.aborted) return;
    task.phase = 'EXECUTE';
    const writes: Promise<void>[] = [];
    const seen = new Set<string>();
    const accept = async (raw: ProbeResult): Promise<void> => {
      const result = safeProbeResult(raw);
      if (task.controller.signal.aborted || !result || seen.has(result.subjectId)) return;
      const snapshot = snapshots.get(result.subjectId);
      if (!snapshot || result.subjectType !== task.subjectType || result.configHash !== snapshot.request.configHash || result.targetId !== task.target.id) return;
      seen.add(result.subjectId);
      const write = (async () => {
        try {
          if (['CANCELED', 'SKIPPED', 'STALE'].includes(result.status)) {
            task.results.set(result.subjectId, { ...result, applied: false });
            return;
          }
          const applied = await this.resources.persist(snapshot, result, task.controller.signal);
          if (task.controller.signal.aborted) return;
          task.results.set(result.subjectId, applied ? { ...result, applied: true } : { ...result, status: 'STALE', errorCode: 'RESOURCE_CHANGED', latencyMs: null, stage: 'PERSIST', applied: false, message: '配置或资源状态已变更，结果未写入' });
        } catch { if (!task.controller.signal.aborted) task.results.set(result.subjectId, { ...result, status: 'ERROR', errorCode: 'PERSIST_FAILED', stage: 'PERSIST', latencyMs: null, applied: false, message: '探针结果保存失败' }); }
      })();
      writes.push(write);
      await write;
    };
    try {
      if (snapshots.size) {
        const results = await this.engine.executeBatch([...snapshots.values()].map((s) => s.request), task.target, task.timeoutMs, task.executionPolicy, task.controller.signal, accept);
        for (const result of results) await accept(result);
      }
    } catch {
      if (!task.controller.signal.aborted) for (const id of snapshots.keys()) if (!seen.has(id)) task.results.set(id, this.localResult(task, id, 'ERROR', 'EXECUTION_FAILED'));
    }
    await Promise.all(writes);
    if (task.controller.signal.aborted) return;
    for (const id of snapshots.keys()) if (!task.results.has(id)) task.results.set(id, this.localResult(task, id, 'ERROR', 'RESULT_MISSING'));
    task.phase = 'QUEUED';
    if (task.cursor >= task.ids.length) this.finish(task, 'COMPLETED');
  }
  private localResult(task: Task, id: string, status: ProbeResult['status'], errorCode: string): ProbeResult {
    return { schemaVersion: 1, subjectType: task.subjectType, subjectId: id, status, errorCode, message: status === 'SKIPPED' ? '资源不可用，已跳过' : status === 'CANCELED' ? '任务已取消' : '探针任务未完成', engine: null, engineVersion: null, fallbackReason: null, mihomoCompatibility: 'UNSUPPORTED', measurement: 'PROXY_HTTP_DELAY', perspective: 'MASTER', routeKind: task.subjectType === 'UPSTREAM_NODE' ? 'UPSTREAM_DIRECT' : 'MANAGED_DIRECT', targetId: task.target.id, targetHost: new URL(task.target.url).hostname, testedAt: new Date().toISOString(), durationMs: 0, latencyMs: null, stage: 'VALIDATE', configHash: '', applied: false };
  }
  private finish(task: Task, state: ProbeTaskState, code = 'TASK_CANCELED') {
    task.state = state; task.phase = state; task.finishedAt = new Date().toISOString(); task.expiresAt = new Date(Date.now() + RETENTION).toISOString();
    if (task.deadline) clearTimeout(task.deadline);
    for (let index = this.queue.length - 1; index >= 0; index--) if (this.queue[index] === task) this.queue.splice(index, 1);
    task.controller.abort();
    for (const id of task.ids) if (!task.results.has(id)) task.results.set(id, this.localResult(task, id, state === 'CANCELED' ? 'CANCELED' : 'ERROR', code));
    this.resources.release(task.subjectType, task.ids, task.sequence);
    this.sweep();
  }
}
