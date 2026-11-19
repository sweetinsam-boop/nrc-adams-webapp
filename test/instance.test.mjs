import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempDisposable } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

test('two production servers using different ports cannot recover each other’s jobs', { timeout: 15000 }, async t => {
  const directory = await mkdtempDisposable(join(tmpdir(), 'adams-instance-test-'));
  const children = [];
  t.after(async () => {
    for (const { child, stopped } of children) {
      if (child.exitCode === null && child.signalCode === null) child.kill();
      await stopped;
    }
    await directory.remove();
  });
  const start = () => {
    const child = spawn(process.execPath, [fileURLToPath(new URL('../server.mjs', import.meta.url))], {
      env: { ...process.env, ADAMS_DATA_DIR: directory.path, ADAMS_PORT: '0', ADAMS_HOST: '127.0.0.1',
        ADAMS_ORIGIN: '', ADAMS_INVITE_CODE: '', ADAMS_MASTER_KEY: '' }, windowsHide: true, stdio: ['ignore','pipe','pipe'],
    });
    const stopped = once(child, 'close');
    children.push({ child, stopped });
    return { child, stopped };
  };
  const first = start();
  await once(first.child.stdout, 'data');
  const db = new DatabaseSync(join(directory.path, 'adams.sqlite'));
  try {
    db.exec(`INSERT INTO users(id,email,salt,password) VALUES('qa','qa@example.test','unused','unused');
      INSERT INTO analyses(id,owner,ml,mode,question,provider,model,state,created)
      VALUES('job','qa','ML24017A120','summary','','gemini','fixture','working',1)`);
    const second = start();
    let message = '';
    second.child.stderr.on('data', part => { message += part; });
    assert.notEqual((await second.stopped)[0], 0);
    assert.match(message, /이미 실행 중/);
    const state = () => db.prepare("SELECT state FROM analyses WHERE id='job'").get().state;
    assert.equal(state(), 'working');
    first.child.kill();
    await first.stopped;
    const replacement = start();
    await once(replacement.child.stdout, 'data');
    assert.equal(state(), 'failed');
  } finally {
    db.close();
  }
});
