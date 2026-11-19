import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { createApp } from '../server.mjs';

async function start(localAccess) {
  const server = createApp({ db: new DatabaseSync(':memory:'), encryptionKey: randomBytes(32), localAccess }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  const get = (path, headers = {}) => fetch(origin + path, { headers });
  return { server, get };
}

test('local mode serves one implicit account without sign-in', async t => {
  const { server, get } = await start(true);
  t.after(() => server.close());
  const first = await (await get('/api/me')).json();
  const second = await (await get('/api/me')).json();
  assert.equal(first.local, true);
  assert.ok(first.accountId);
  assert.equal(second.accountId, first.accountId);
  const settings = await get('/api/settings', { 'X-ADAMS-Account': first.accountId });
  assert.equal(settings.status, 200);
});

test('local mode refuses the implicit account to cross-site requests', async t => {
  const { server, get } = await start(true);
  t.after(() => server.close());
  const me = await (await get('/api/me', { 'Sec-Fetch-Site': 'cross-site' })).json();
  assert.equal(me.accountId, null);
  assert.equal((await get('/api/settings', { 'Sec-Fetch-Site': 'cross-site' })).status, 401);
});

test('sign-in stays required when local mode is off', async t => {
  const { server, get } = await start(false);
  t.after(() => server.close());
  const me = await (await get('/api/me')).json();
  assert.equal(me.accountId, null);
  assert.equal(me.local, false);
  assert.equal((await get('/api/settings')).status, 401);
});
