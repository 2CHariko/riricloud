import { ServiceUnavailableException } from '@nestjs/common';

export const MIRROR_STREAM_BUFFER_BYTES = 1024 * 1024;
export const MIRROR_GLOBAL_TASK_LIMIT = 16;
export const MIRROR_NODE_TASK_LIMIT = 4;
export const MIRROR_GLOBAL_BUFFER_BUDGET_BYTES = MIRROR_GLOBAL_TASK_LIMIT * MIRROR_STREAM_BUFFER_BYTES;

// 每个任务预留完整单流预算，异步启动、HEAD 和等待 drain 期间都占槽。
// 无等待队列或清理定时器；租约数同时限制待处理查询、任务对象和正文缓冲总量。
export class MirrorCapacity {
  private readonly leases = new Set<MirrorReservation>();
  private readonly nodes = new Map<string, number>();
  private closing = false;

  reserve(): MirrorReservation {
    if (this.closing || this.leases.size >= MIRROR_GLOBAL_TASK_LIMIT) throw this.busy();
    const lease = new MirrorReservation(this);
    this.leases.add(lease);
    return lease;
  }

  bind(lease: MirrorReservation, nodeId: string) {
    if (this.closing || !this.leases.has(lease) || (this.nodes.get(nodeId) ?? 0) >= MIRROR_NODE_TASK_LIMIT) throw this.busy();
    this.nodes.set(nodeId, (this.nodes.get(nodeId) ?? 0) + 1);
  }

  release(lease: MirrorReservation) {
    if (!this.leases.delete(lease)) return;
    if (lease.nodeId) {
      const remaining = (this.nodes.get(lease.nodeId) ?? 1) - 1;
      if (remaining) this.nodes.set(lease.nodeId, remaining);
      else this.nodes.delete(lease.nodeId);
    }
  }

  close() { this.closing = true; }

  get snapshot() {
    return { active: this.leases.size, reservedBufferBytes: this.leases.size * MIRROR_STREAM_BUFFER_BYTES, nodes: this.nodes.size };
  }

  private busy() { return new ServiceUnavailableException({ code: 'BUSY', message: '镜像任务容量已满或服务正在关闭' }); }
}

export class MirrorReservation {
  nodeId?: string;
  private starting = true;
  private finished = false;
  constructor(private readonly capacity: MirrorCapacity) {}

  bindNode(nodeId: string) {
    if (this.nodeId) return;
    this.capacity.bind(this, nodeId);
    this.nodeId = nodeId;
  }

  // 任务已终止但启动仍未返回时保留槽，防止反复取消制造无界迟到启动。
  finish() { this.finished = true; this.releaseIfComplete(); }
  started() { this.starting = false; this.releaseIfComplete(); }
  abandon() { this.finished = true; this.starting = false; this.releaseIfComplete(); }
  private releaseIfComplete() { if (this.finished && !this.starting) this.capacity.release(this); }
}
