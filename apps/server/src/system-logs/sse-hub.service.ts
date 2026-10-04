import { HttpException, HttpStatus, Injectable, type MessageEvent } from '@nestjs/common';
import { filter, finalize, map, Observable, Subject } from 'rxjs';

export interface SystemLogEntry {
  id: string;
  traceId?: string | null;
  source: string;
  level: string;
  module: string;
  message: string;
  metadata: string;
  nodeId?: string | null;
  userId?: string | null;
  createdAt: Date;
}

export interface StreamFilter {
  level?: string;
  source?: string;
  nodeId?: string;
  keyword?: string;
  module?: string;
  traceId?: string;
  userId?: string;
  startTime?: string;
  endTime?: string;
}

@Injectable()
export class SSEHubService {
  private readonly stream$ = new Subject<SystemLogEntry>();
  private activeConnections = 0;
  private readonly maxConnections = 32;

  /**
   * 发布单条实时日志到 SSE 广播池
   */
  publish(entry: SystemLogEntry): void {
    this.stream$.next(entry);
  }

  /**
   * 订阅实时日志流并根据入参过滤
   */
  subscribe(filterCriteria?: StreamFilter): Observable<MessageEvent> {
    if (this.activeConnections >= this.maxConnections) {
      throw new HttpException('实时日志连接数已达上限', HttpStatus.TOO_MANY_REQUESTS);
    }
    this.activeConnections += 1;
    return this.stream$.pipe(
      filter((entry) => {
        if (!filterCriteria) return true;

        if (filterCriteria.level && filterCriteria.level !== 'ALL') {
          if (entry.level !== filterCriteria.level) return false;
        }

        if (filterCriteria.source && filterCriteria.source !== 'ALL') {
          if (entry.source !== filterCriteria.source) return false;
        }

        if (filterCriteria.nodeId && filterCriteria.nodeId !== 'ALL') {
          if (entry.nodeId !== filterCriteria.nodeId) return false;
        }
        if (filterCriteria.module && !entry.module.toLowerCase().includes(filterCriteria.module.trim().toLowerCase())) return false;
        if (filterCriteria.traceId && entry.traceId !== filterCriteria.traceId) return false;
        if (filterCriteria.userId && entry.userId !== filterCriteria.userId) return false;
        if (filterCriteria.startTime && entry.createdAt < new Date(filterCriteria.startTime)) return false;
        if (filterCriteria.endTime && entry.createdAt > new Date(filterCriteria.endTime)) return false;

        if (filterCriteria.keyword) {
          const kw = filterCriteria.keyword.trim().toLowerCase();
          const matchMsg = entry.message.toLowerCase().includes(kw);
          const matchMod = entry.module.toLowerCase().includes(kw);
          const matchMeta = entry.metadata.toLowerCase().includes(kw);
          const matchTrace = entry.traceId ? entry.traceId.toLowerCase().includes(kw) : false;
          if (!matchMsg && !matchMod && !matchMeta && !matchTrace) {
            return false;
          }
        }

        return true;
      }),
      map((entry) => ({
        data: entry,
        id: entry.id
      })),
      finalize(() => {
        this.activeConnections = Math.max(0, this.activeConnections - 1);
      })
    );
  }
}
