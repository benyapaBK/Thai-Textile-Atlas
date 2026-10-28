import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
dotenv.config({ path: path.join(root, '.env.local') });
dotenv.config({ path: path.join(root, '.env') });

const node = process.execPath;
const api = spawn(node, [path.join(root, 'server', 'dev-api.js')], {
  cwd: root,
  stdio: ['inherit', 'inherit', 'inherit', 'ipc']
});
let vite;
let shuttingDown = false;

function shutdown(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  process.exitCode = code;
  if (vite && !vite.killed) vite.kill();
  if (!api.killed) api.kill();
}

api.on('message', message => {
  if (message !== 'ready' || vite || shuttingDown) return;
  vite = spawn(node, [path.join(root, 'node_modules', 'vite', 'bin', 'vite.js'), '--port=3000', '--host=0.0.0.0'], {
    cwd: root,
    stdio: 'inherit',
    env: process.env
  });
  vite.once('error', error => {
    console.error('Unable to start Vite:', error);
    shutdown(1);
  });
  vite.once('exit', code => {
    if (!shuttingDown) shutdown(code ?? 1);
  });
});

api.once('error', error => {
  console.error('Unable to start the admin API process:', error);
  shutdown(1);
});
api.once('exit', code => {
  if (!shuttingDown) shutdown(code ?? 1);
});

process.once('SIGINT', () => shutdown(0));
process.once('SIGTERM', () => shutdown(0));
