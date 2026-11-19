import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { createApp } from '../server.mjs';

async function start(trustProxy) {
  const server = createApp({ db: new DatabaseSync(':memory:'), encryptionKey: randomBytes(32), trustProxy }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  const login = (email, forwarded) => fetch(`${origin}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: origin, ...(forwarded && { 'X-Forwarded-For': forwarded }) },
    body: JSON.stringify({ email, password: 'wrong-password-123' }),
  }).then(response => response.status);
  return { server, login };
}

test('login limits apply per forwarded client and per email behind a trusted proxy', async t => {
  const { server, login } = await start(true);
  t.after(() => server.close());
  for (let index = 0; index < 31; index++) assert.equal(await login(`user${index}@example.org`, `198.51.100.${index}`), 401);
  for (let index = 0; index < 10; index++) assert.equal(await login('target@example.org', `203.0.113.${index}`), 401);
  assert.equal(await login('target@example.org', '203.0.113.99'), 429);
});

test('forwarded addresses are ignored unless the proxy is trusted', async t => {
  const { server, login } = await start(false);
  t.after(() => server.close());
  for (let index = 0; index < 30; index++) assert.equal(await login(`user${index}@example.org`, `198.51.100.${index}`), 401);
  assert.equal(await login('other@example.org', '198.51.100.250'), 429);
});
