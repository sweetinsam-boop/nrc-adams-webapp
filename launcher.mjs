import { execFile, spawn } from 'node:child_process';
import { mkdir, open } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { setTimeout as sleep } from 'node:timers/promises';

const root = fileURLToPath(new URL('.', import.meta.url));
const port = Number(process.env.ADAMS_PORT || 4317);
const origin = `http://127.0.0.1:${port}`;

async function probe() {
  let response;
  try {
    response = await fetch(`${origin}/api/me`, { signal: AbortSignal.timeout(750), redirect: 'error' });
  } catch {
    return 'offline';
  }
  await response.body?.cancel();
  return response.ok && response.headers.get('X-Adams-App') === '1' ? 'ready' : 'other';
}

async function launch() {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('ADAMS_PORT must be between 1 and 65535.');
  if (Number(process.versions.node.split('.')[0]) < 24) throw new Error('Node.js 24 or later is required.');
  const initial = await probe();
  if (initial === 'other') throw new Error(`Port ${port} is in use by another application.`);
  if (initial === 'offline') {
    const storage = resolve(root, process.env.ADAMS_DATA_DIR || '.data');
    await mkdir(storage, { recursive: true });
    const filename = join(storage, 'launcher.log');
    const output = await open(filename, 'a');
    let exited = false;
    try {
      const child = spawn(process.execPath, [join(root, 'server.mjs')], {
        cwd: root, env: process.env, detached: true, windowsHide: true,
        stdio: ['ignore', output.fd, output.fd],
      });
      child.on('error', () => { exited = true; });
      child.on('exit', () => { exited = true; });
      child.unref();
    } finally {
      await output.close();
    }
    for (let attempt = 0; attempt < 32; attempt++) {
      const status = await probe();
      if (status === 'ready') break;
      if (status === 'other' || exited || attempt === 31) throw new Error(`ADAMS could not start. See ${filename}`);
      await sleep(250, undefined, { ref: true });
    }
  }
  console.log(`NRC ADAMS · ${origin}`);
  if (process.env.ADAMS_LAUNCH_NO_BROWSER !== '1') {
    const browserUrl = process.env.ADAMS_ORIGIN ? new URL(process.env.ADAMS_ORIGIN).origin : origin;
    if (process.env.ADAMS_ORIGIN && !browserUrl.startsWith('https:')) throw new Error('ADAMS_ORIGIN must use HTTPS.');
    await promisify(execFile)('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      `Start-Process -FilePath '${browserUrl.replaceAll("'", "''")}'`], { windowsHide: true });
  }
}

try {
  await launch();
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
