import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

type Lease = { release(): void | Promise<void>; onParentLost?(handler: () => void): void };
type StorageConfig = { main: string; telemetry: string; dataDir: string };
type ConfigModule = {
  loadEnvironment(): void;
  resolveConfig(): StorageConfig;
  configureDatabaseEnvironment(config: StorageConfig): void;
};
type LockModule = {
  acquireStartupLock(config: StorageConfig): Promise<Lease>;
  assertStartAllowed(config: StorageConfig): void;
};

export async function acquireMasterMaintenanceLock(): Promise<Lease> {
  // 同时适配源码、两种 dist 布局和 E2E 独立输出目录，始终复用发行包中的 JS 实现。
  const candidates = [resolve(process.cwd(), 'prisma'), resolve(__dirname, '../../prisma'), resolve(__dirname, '../../../prisma')];
  const directory = candidates.find((candidate) => existsSync(resolve(candidate, 'maintenance-lock.js')));
  if (!directory) throw new Error('Maintenance startup module is missing');
  const load = createRequire(resolve(directory, 'maintenance-lock.js'));
  const configModule = load('./maintenance-config') as ConfigModule;
  const lockModule = load('./maintenance-lock') as LockModule;
  configModule.loadEnvironment();
  const config = configModule.resolveConfig();
  configModule.configureDatabaseEnvironment(config);
  const lease = await lockModule.acquireStartupLock(config);
  try { lockModule.assertStartAllowed(config); } catch (error) { await lease.release(); throw error; }
  // 锁仅在显式完成关闭后释放；崩溃、SIGKILL 与掉电必须留下残留锁。
  return lease;
}

export function registerMaintenanceShutdown(app: { close(): Promise<void> }, lease: Lease): void {
  let stopping = false;
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    try {
      // Nest close 先运行所有模块关闭钩子，刷新账务并断开双库，再允许冷备。
      await app.close();
      await lease.release();
      process.exit(0);
    } catch {
      console.error('Master shutdown failed; maintenance lock retained for inspection.');
      process.exit(1);
    }
  };
  lease.onParentLost?.(() => { void shutdown(); });
  process.on('SIGTERM', () => { void shutdown(); });
  process.on('SIGINT', () => { void shutdown(); });
}
