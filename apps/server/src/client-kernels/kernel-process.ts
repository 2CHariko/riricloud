import { spawn, type ChildProcess } from 'node:child_process';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export class KernelExecutionError extends Error {
  constructor(public readonly code: string) { super(code); }
}
export class ResourceSemaphore {
  private active = 0;
  private readonly waiters: Array<() => void> = [];
  constructor(private readonly maximum: number) {}
  async acquire(signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) throw new KernelExecutionError('CANCELED');
    if (this.active >= this.maximum) await new Promise<void>((resolve, reject) => {
      const ready = () => { signal?.removeEventListener('abort', abort); resolve(); };
      const abort = () => { const index = this.waiters.indexOf(ready); if (index >= 0) this.waiters.splice(index, 1); reject(new KernelExecutionError('CANCELED')); };
      this.waiters.push(ready);
      signal?.addEventListener('abort', abort, { once: true });
    });
    else this.active += 1;
    if (signal?.aborted) { this.release(); throw new KernelExecutionError('CANCELED'); }
    let released = false;
    return () => { if (!released) { released = true; this.release(); } };
  }
  private release(): void {
    const next = this.waiters.shift();
    if (next) next(); else this.active -= 1;
  }
}
// 进程限额跨验证、版本读取和所有任务共享，不按批次重新创建。
export const kernelProcessSlots = new ResourceSemaphore(2);
export const probeConnectionSlots = new ResourceSemaphore(4);
const running = new Set<ManagedKernelProcess>();
let shuttingDown = false;

export class ManagedKernelProcess {
  readonly child: ChildProcess;
  readonly exited: Promise<number | null>;
  private stopped?: Promise<void>;
  private readonly onAbort = () => { void this.stop(); };
  private timer?: ReturnType<typeof setTimeout>;
  private output = '';
  private constructor(path: string, args: string[], readonly directory: string, private readonly release: () => void, private readonly signal?: AbortSignal, timeoutMs = 35_000, captureOutput = false) {
    this.child = spawn(path, args, { cwd: directory, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, HTTP_PROXY: '', HTTPS_PROXY: '', ALL_PROXY: '', http_proxy: '', https_proxy: '', all_proxy: '' } });
    this.exited = new Promise((resolve) => {
      this.child.once('error', () => resolve(null));
      this.child.once('close', (code) => resolve(code));
    });
    for (const stream of [this.child.stdout, this.child.stderr]) stream?.on('data', (data: Buffer) => { if (captureOutput && this.output.length < 16_384) this.output += data.toString().slice(0, 16_384 - this.output.length); });
    this.timer = setTimeout(() => { void this.stop(); }, timeoutMs);
    signal?.addEventListener('abort', this.onAbort, { once: true });
    running.add(this);
    void this.exited.then(() => this.stop());
  }
  static async start(path: string, args: (configPath: string, directory: string) => string[], content: string, signal?: AbortSignal, timeoutMs = 35_000, captureOutput = false): Promise<ManagedKernelProcess> {
    const release = await kernelProcessSlots.acquire(signal);
    let directory: string | undefined;
    try {
      if (shuttingDown || signal?.aborted) throw new KernelExecutionError('CANCELED');
      directory = await mkdtemp(join(tmpdir(), 'riri-client-'));
      await chmod(directory, 0o700);
      const configPath = join(directory, 'config.json');
      await writeFile(configPath, content, { mode: 0o600 });
      const process = new ManagedKernelProcess(path, args(configPath, directory), directory, release, signal, timeoutMs, captureOutput);
      if (signal?.aborted) await process.stop();
      return process;
    } catch {
      if (directory) await rm(directory, { recursive: true, force: true });
      release();
      throw new KernelExecutionError(signal?.aborted ? 'CANCELED' : 'KERNEL_START_FAILED');
    }
  }
  get capturedOutput(): string { return this.output; }
  stop(): Promise<void> {
    if (!this.stopped) this.stopped = this.cleanup();
    return this.stopped;
  }
  private async cleanup(): Promise<void> {
    clearTimeout(this.timer);
    this.signal?.removeEventListener('abort', this.onAbort);
    if (this.child.exitCode === null) {
      this.child.kill('SIGTERM');
      const force = setTimeout(() => { this.child.kill('SIGKILL'); }, 2_000);
      await this.exited;
      clearTimeout(force);
    } else await this.exited;
    try { await rm(this.directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); }
    finally { running.delete(this); this.release(); }
  }
}
export async function runKernelCommand(path: string, args: (configPath: string, directory: string) => string[], content = '{}', timeoutMs = 5_000, signal?: AbortSignal, captureOutput = true): Promise<{ code: number | null; output: string }> {
  const child = await ManagedKernelProcess.start(path, args, content, signal, timeoutMs, captureOutput);
  try { const code = await child.exited; return { code, output: child.capturedOutput }; }
  finally { await child.stop(); }
}
export async function shutdownKernelProcesses(): Promise<void> {
  shuttingDown = true;
  await Promise.all([...running].map((child) => child.stop()));
}
