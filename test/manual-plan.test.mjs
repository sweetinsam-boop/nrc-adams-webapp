import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { createApp } from '../server.mjs';

test('without an AI key the search offers a chat prompt and accepts the pasted answer', async t => {
  const server = createApp({ db: new DatabaseSync(':memory:'), encryptionKey: randomBytes(32), localAccess: true,
    fetcher: async url => { throw new Error(`Unexpected request ${url}`); } }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => server.close());
  const origin = `http://127.0.0.1:${server.address().port}`;
  const { accountId } = await (await fetch(`${origin}/api/me`)).json();
  const search = body => fetch(`${origin}/api/search`, {
    method: 'POST', body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json', Origin: origin, 'X-ADAMS-Account': accountId },
  });
  const request = { q: 'Palo Verde 2호기 변경 승인 문서', smart: true, public: true };

  const first = await (await search(request)).json();
  assert.match(first.manualPrompt, /Palo Verde 2호기/);
  assert.match(first.manualPrompt, /Reply with only this JSON object/);
  assert.ok(first.publicLink);

  const answer = 'Here you go:\n```json\n{"intent": "Palo Verde 2호기 변경 승인 문서를 찾습니다.", "searches": ' +
    '[{"query": "\\"Palo Verde\\" \\"safety evaluation\\"", "type": "Safety Evaluation"}, {"query": "Palo Verde amendment", "type": ""}]}\n```';
  const planned = await (await search({ ...request, manualPlan: answer })).json();
  assert.equal(planned.manualPrompt, undefined);
  assert.equal(planned.plan.intent, 'Palo Verde 2호기 변경 승인 문서를 찾습니다.');
  assert.deepEqual(planned.plan.queries.map(query => [query.query, query.type]),
    [['"Palo Verde" "safety evaluation"', 'Safety Evaluation'], ['Palo Verde amendment', '']]);
  assert.match(planned.plan.queries[0].publicLink, /^https:\/\/adams-search\.nrc\.gov\/results\//);

  const invalid = await search({ ...request, manualPlan: '검색식을 만들 수 없습니다.' });
  assert.equal(invalid.status, 400);
});
