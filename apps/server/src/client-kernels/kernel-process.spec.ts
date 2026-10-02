import fs from 'node:fs/promises';
import { access, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { kernelProcessSlots, ManagedKernelProcess, runKernelCommand } from './kernel-process';

describe('kernel preparation and execution lifecycle', () => {
  afterEach(() => jest.restoreAllMocks());
  it('releases the slot even when preparation cleanup fails', async () => {
    const release = jest.fn();
    const acquire = jest.spyOn(kernelProcessSlots, 'acquire').mockResolvedValue(release);
    const originalRm = fs.rm;
    const cleanup = jest.spyOn(fs, 'rm').mockRejectedValue(Object.assign(new Error('busy'), { code: 'EBUSY' }));
    let directory = '';
    try {
      await expect(ManagedKernelProcess.start(process.execPath, () => ['-v'], '{}', undefined, 5000, false, async (dir) => { directory = dir; throw new Error('prepare'); })).rejects.toThrow();
      expect(release).toHaveBeenCalledTimes(1);
    } finally { cleanup.mockRestore(); acquire.mockRestore(); if (directory) await originalRm(directory, { recursive: true, force: true }); }
  });
  it('prepares private resources before spawn and removes the directory after exit', async () => {
    let directory = '';
    const result = await runKernelCommand(process.execPath, () => ['-e', 'process.stdout.write(require("fs").readFileSync("fixture.txt"))'], '{}', 5000, undefined, true, async (dir) => {
      directory = dir;
      expect(await readFile(join(dir, 'config.json'), 'utf8')).toBe('{}');
      await writeFile(join(dir, 'fixture.txt'), 'prepared', { mode: 0o600 });
    });
    expect(result).toMatchObject({ code: 0, output: 'prepared', executed: true });
    await expect(access(directory)).rejects.toThrow();
  });
  it('cleans failed preparation and releases slots', async () => {
    let directory = '';
    for (let i = 0; i < 3; i++) {
      await expect(ManagedKernelProcess.start(process.execPath, () => ['-v'], '{}', undefined, 5000, false, async (dir) => { directory = dir; throw new Error('secret'); })).rejects.toMatchObject({ code: 'RESOURCE_PREPARATION_FAILED' });
      await expect(access(directory)).rejects.toThrow();
    }
    expect((await runKernelCommand(process.execPath, () => ['-v'])).code).toBe(0);
  });
  it('distinguishes timeout from config failure', async () => {
    expect(await runKernelCommand(process.execPath, () => ['-e', 'setInterval(()=>{},1000)'], '{}', 100)).toMatchObject({ executed: true, reason: 'TIMEOUT' });
  });
  it('marks spawn failures as not executed', async () => {
    expect(await runKernelCommand('nonexistent-riri-test-binary', () => [])).toMatchObject({ executed: false, reason: 'START_FAILED', code: null });
  });
  it('cancels before spawn when canceled during preparation', async () => {
    const controller = new AbortController();
    let directory = '';
    await expect(ManagedKernelProcess.start(process.execPath, () => ['-v'], '{}', controller.signal, 5000, false, async (dir) => { directory = dir; controller.abort(); })).rejects.toMatchObject({ code: 'CANCELED' });
    await expect(access(directory)).rejects.toThrow();
  });
});
