import { spawn } from 'node:child_process';
const [duration, command, ...args] = process.argv.slice(2);
const seconds = Number(duration);
if (!command || !Number.isFinite(seconds) || seconds <= 0)
  throw new Error('Usage: node scripts/check.mjs SECONDS COMMAND [...ARGS]');
const child = spawn(command, args, { stdio: 'inherit', detached: process.platform !== 'win32' });
const timer = setTimeout(() => {
  console.error(`Command exceeded ${seconds}s hard timeout`);
  if (process.platform === 'win32') child.kill('SIGKILL');
  else process.kill(-child.pid, 'SIGKILL');
  process.exitCode = 1;
}, seconds * 1000);
child.on('error', (error) => {
  clearTimeout(timer);
  console.error(error);
  process.exitCode = 1;
});
child.on('exit', (code) => {
  clearTimeout(timer);
  process.exitCode = code ?? 1;
});
