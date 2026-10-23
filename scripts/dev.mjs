import { spawn } from 'node:child_process';
const children = [
  spawn('npm', ['run', 'dev:web'], { stdio: 'inherit' }),
  spawn('npm', ['run', 'dev:worker'], { stdio: 'inherit' }),
];
let stopping = false;
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  children.forEach((p) => p.kill('SIGTERM'));
  process.exitCode = code;
}
process.on('SIGINT', () => stop());
process.on('SIGTERM', () => stop());
children.forEach((p) => p.on('exit', (code) => stop(code ?? 1)));
