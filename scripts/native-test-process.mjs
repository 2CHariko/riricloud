import { spawn } from 'node:child_process';

// 将整个子进程组纳入超时/取消回收，Jest 启动的内核不能成为孤儿进程。
export function runCommand(command, args, { cwd, env = process.env, timeoutMs = 120_000, capture = false, input } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, windowsHide: true, detached: process.platform !== 'win32', stdio: ['pipe', capture ? 'pipe' : 'inherit', capture ? 'pipe' : 'inherit'] });
    let output = '';
    let failure;
    const stop = (reason) => {
      if (failure) return;
      failure = new Error(reason);
      if (!child.pid) return;
      if (process.platform === 'win32') {
        const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
        killer.on('error', () => child.kill('SIGKILL'));
        killer.on('exit', (code) => { if (code !== 0) child.kill('SIGKILL'); });
      } else {
        try { process.kill(-child.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') child.kill('SIGKILL'); }
      }
    };
    const interrupt = () => stop('Native command interrupted');
    process.once('SIGINT', interrupt);
    process.once('SIGTERM', interrupt);
    const timer = setTimeout(() => stop(`Command timed out after ${timeoutMs} ms: ${command}`), timeoutMs);
    const cleanup = () => { clearTimeout(timer); process.off('SIGINT', interrupt); process.off('SIGTERM', interrupt); };
    if (capture) {
      const collect = (data) => { output += data.toString(); if (output.length > 1024 * 1024) stop('Native command output exceeded limit'); };
      child.stdout.on('data', collect);
      child.stderr.on('data', collect);
    }
    child.stdin.on('error', (error) => { if (error.code !== 'EPIPE') stop(error.message); });
    child.stdin.end(input);
    child.once('error', (error) => { cleanup(); reject(error); });
    child.once('close', (code, signal) => {
      cleanup();
      if (failure) reject(failure);
      else if (code !== 0) reject(new Error(`Command failed (${signal ?? code}): ${command}
${output.trim()}`));
      else resolve(output.trim());
    });
  });
}
