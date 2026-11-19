import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { DatabaseSync, constants } from 'node:sqlite';
import { test } from 'node:test';
import { createApp } from '../server.mjs';

async function startFixture(t, options = {}) {
  const db = new DatabaseSync(':memory:');
  const server = createApp({ db, encryptionKey: randomBytes(32), ...options });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    const closed = once(server, 'close');
    server.close();
    server.closeAllConnections();
    await closed;
    db.close();
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  async function signup(email) {
    const response = await fetch(origin + '/api/signup', {
      method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password: 'local-test-passphrase' }),
    });
    const { accountId } = await response.json();
    assert.equal(response.status, 200);
    assert.ok(accountId);
    const headers = { Cookie: response.headers.get('set-cookie').split(';')[0], 'X-ADAMS-Account': accountId };
    const get = (path, extra = {}) => fetch(origin + path, { headers: { ...headers, ...extra } });
    const post = (path, type, body, extra = {}) => fetch(origin + path, {
      method: 'POST', body, headers: { ...headers, Origin: origin, 'Content-Type': type, ...extra },
    });
    return { accountId, get, upload: (pdf, filename) => post('/api/upload', 'application/pdf', pdf, { 'X-Document-Name': filename }),
      remove: id => post('/api/uploads', 'application/json', JSON.stringify({ id, action: 'delete' })) };
  }
  return { db, server, signup };
}

test('deleting an upload frees quota and retains saved analysis with accurate source availability', async t => {
  const { db, signup } = await startFixture(t);
  const alice = await signup('alice@example.test');
  const file = '%PDF-1.5\nfixture retained in history';
  const upload = await alice.upload(file, 'test.pdf');
  assert.equal(upload.status, 201);
  const doc = await upload.json();
  const { limitBytes } = await (await alice.get('/api/uploads')).json();
  const seed = db.prepare('INSERT INTO imports(owner,id,source,pdf) VALUES(?,?,?,zeroblob(?))');
  const remaining = limitBytes - Buffer.byteLength(file);
  for (let index = 0; index < 2; index++) {
    const id = `PDF-${String(index).repeat(64)}`;
    seed.run(alice.accountId, id, JSON.stringify({ id, uploaded: true }), index ? remaining - Math.floor(remaining / 2) : Math.floor(remaining / 2));
  }
  assert.equal((await (await alice.get('/api/uploads')).json()).usedBytes, limitBytes);
  const replacement = '%PDF-1.5\nreplacement';
  assert.equal((await alice.upload(replacement, 'replacement.pdf')).status, 413);

  const row = { status: 'found', english: 'An archived finding' };
  db.prepare(`INSERT INTO analyses(id,owner,ml,mode,question,provider,model,state,created,source,result)
    VALUES('existing-analysis',?,?,'summary','','gemini','fixture','done',?,?,?)`)
    .run(alice.accountId, doc.id, Date.now(), JSON.stringify(doc), JSON.stringify([row]));
  db.prepare("INSERT INTO saved VALUES(?,'existing-analysis',0,?)").run(alice.accountId, Date.now());
  const deletion = await alice.remove(doc.id);
  assert.equal(deletion.status, 200);
  assert.equal((await deletion.json()).usedBytes, remaining);
  assert.equal((await alice.get(doc.url)).status, 404);
  assert.equal((await alice.get('/api/document/' + doc.id)).status, 404);
  const saved = await (await alice.get('/api/library')).json();
  assert.deepEqual(saved[0].item, row);
  assert.equal(saved[0].source.available, false);
  const newUpload = await alice.upload(replacement, 'replacement.pdf');
  assert.equal(newUpload.status, 201);
  assert.equal((await (await alice.get('/api/uploads')).json()).usedBytes, remaining + Buffer.byteLength(replacement));
});

test('preview cache coalesces concurrent renders, remains per-account and invalidates in-flight content', async t => {
  const calls = [];
  const pages = new Map();
  const { db, server, signup } = await startFixture(t, {
    async renderPage(pdf, page) {
      assert.equal(pdf.toString(), '%PDF-1.5\nshared fixture');
      const call = calls.push(page);
      const gate = pages.get(page);
      if (gate) {
        gate.started.resolve();
        await gate.finish.promise;
      }
      return { count: 3, image: Buffer.from('render-' + call) };
    },
  });
  const alice = await signup('alice@example.test');
  const bob = await signup('bob@example.test');
  const file = '%PDF-1.5\nshared fixture';
  const doc = await (await alice.upload(file, 'page.pdf')).json();
  const page = '/api/pdf-page/' + doc.id + '/';

  if (db.setAuthorizer) {
    // Metadata endpoints must remain usable even when the entire BLOB column is inaccessible.
    db.setAuthorizer((action, table, column) => action === constants.SQLITE_READ && table === 'imports' && column === 'pdf'
      ? constants.SQLITE_DENY : constants.SQLITE_OK);
  }
  try {
    assert.deepEqual(await (await alice.get('/api/document/' + doc.id)).json(), doc);
  } finally {
    db.setAuthorizer?.(null);
  }
  const range = await alice.get(doc.url, { Range: 'bytes=2-6' });
  assert.equal(range.status, 206);
  assert.equal(await range.text(), file.slice(2, 7));

  const firstGate = { started: Promise.withResolvers(), finish: Promise.withResolvers() };
  pages.set(1, firstGate);
  const first = alice.get(page + '1');
  await firstGate.started.promise;
  const nextRequest = once(server, 'request');
  const second = alice.get(page + '1');
  await nextRequest;
  firstGate.finish.resolve();
  assert.equal(await (await first).text(), 'render-1');
  assert.equal(await (await second).text(), 'render-1');
  assert.equal(await (await alice.get(page + '1')).text(), 'render-1');
  assert.deepEqual(calls, [1]);
  assert.equal((await bob.get(page + '1')).status, 404);
  assert.equal((await bob.remove(doc.id)).status, 404);
  assert.equal((await (await bob.upload(file, 'second-owner.pdf')).json()).id, doc.id);
  assert.equal(await (await bob.get(page + '1')).text(), 'render-2');

  const pending = { started: Promise.withResolvers(), finish: Promise.withResolvers() };
  pages.set(2, pending);
  const old = alice.get(page + '2');
  await pending.started.promise;
  assert.equal((await alice.remove(doc.id)).status, 200);
  assert.equal((await alice.get(page + '1')).status, 404);
  assert.equal(await (await bob.get(page + '1')).text(), 'render-2');
  assert.equal((await alice.upload(file, 'restored.pdf')).status, 201);
  pages.delete(2);
  assert.equal(await (await alice.get(page + '2')).text(), 'render-4');
  pending.finish.resolve();
  assert.equal((await old).status, 404);
  assert.equal(await (await alice.get(page + '2')).text(), 'render-4');
  assert.deepEqual(calls, [1, 1, 2, 2]);
});

test('distinct preview requests share a bounded worker pool and can retry a failed page', async t => {
  const release = Promise.withResolvers();
  let active = 0;
  let peak = 0;
  let failFirst = true;
  const { server, signup } = await startFixture(t, {
    async renderPage(pdf, number) {
      active++;
      peak = Math.max(peak, active);
      try {
        await release.promise;
        if (number === 6 && failFirst) {
          failFirst = false;
          throw new Error('Test-only render failure');
        }
        return { count: 6, image: Buffer.from('page-' + number) };
      } finally {
        active--;
      }
    },
  });
  const alice = await signup('alice@example.test');
  const { id } = await (await alice.upload('%PDF-1.5\nparallel fixture', 'test.pdf')).json();
  const path = '/api/pdf-page/' + id + '/';
  const received = Promise.withResolvers();
  let requests = 0;
  server.on('request', req => {
    if (req.url.startsWith(path) && ++requests === 6) received.resolve();
  });
  const responses = Array.from({ length: 6 }, (_, i) => alice.get(path + (i + 1)));
  await received.promise;
  release.resolve();
  const results = await Promise.all(responses);
  assert.equal(peak, 3);
  assert.deepEqual(results.map(result => result.status), [200, 200, 200, 200, 200, 500]);
  assert.equal(await (await alice.get(path + '6')).text(), 'page-6');
});

test('duplicate startup on the same port leaves active jobs alone and successful restart recovers them', async () => {
  const db = new DatabaseSync(':memory:');
  const opts = { db, encryptionKey: randomBytes(32) };
  const running = createApp(opts);
  const listening = once(running, 'listening');
  running.listen(0, '127.0.0.1');
  await listening;
  const port = running.address().port;
  let duplicate;
  try {
    db.exec(`INSERT INTO users(id,email,salt,password) VALUES('alice','alice@example.test','unused','unused');
      INSERT INTO analyses(id,owner,ml,mode,question,provider,model,state,created)
      VALUES('pending','alice','ML24017A120','summary','','gemini','fixture','working',1);`);
    const state = () => db.prepare("SELECT state FROM analyses WHERE id='pending'").get().state;
    duplicate = createApp(opts);
    assert.equal(state(), 'working');
    const portError = once(duplicate, 'error');
    duplicate.listen(port, '127.0.0.1');
    const [error] = await portError;
    assert.equal(error.code, 'EADDRINUSE');
    assert.equal(state(), 'working');
    const stopped = once(running, 'close');
    running.close();
    await stopped;
    const restarted = once(duplicate, 'listening');
    duplicate.listen(port, '127.0.0.1');
    await restarted;
    assert.equal(state(), 'failed');
  } finally {
    for (const app of [running, duplicate]) {
      if (app?.listening) {
        const stopped = once(app, 'close');
        app.close();
        await stopped;
      }
    }
    db.close();
  }
});
