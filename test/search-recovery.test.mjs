import assert from 'node:assert/strict';
import { test } from 'node:test';
import { contextualDates } from '../search.mjs';
import { aiClient } from '../services.mjs';

test('publication periods preserve month/day precision and do not filter on an event year', () => {
  const examples = [
    ['2022년 7월 이후의 보고서', '2022-07-01', ''],
    ['2024년 2월까지 제출된 보고서', '', '2024-02-29'],
    ['2022년 7월 15일 이후 발행된 승인서', '2022-07-15', ''],
    ['2011년 후쿠시마 사고 이후 발행된 보고서', '', ''],
    ['2011년 후쿠시마 사고에 대해 2022년 작성된 보고서', '2022-01-01', '2022-12-31'],
    ['since 2022-07-15', '2022-07-15', ''],
    ['reports published after July 2022', '2022-08-01', ''],
    ['between 2022-07-15 and 2023-02-28', '2022-07-15', '2023-02-28'],
    ['2023년 2월 29일 이후 보고서', '', ''],
  ];
  for (const [query, from, to] of examples) assert.deepEqual(contextualDates(query), { from, to }, query);
  assert.deepEqual(contextualDates(examples[0][0], '2023-01-01', ''), { from: '2023-01-01', to: '' });
});

test('Gemini can recover a search plan using the same model within the original request deadline', async () => {
  const attempts = [];
  const client = aiClient(async (url, options) => {
    attempts.push({ url, options });
    if (attempts.length === 1) return new Response(null, { status: 503, headers: { 'Retry-After': '0' } });
    const answer = { intent: '검사 보고서', searches: [{ query: 'inspection report', type: '' }] };
    return Response.json({ candidates: [{ content: { parts: [{ text: JSON.stringify(answer) }] } }] });
  }, 'gemini', 'test-model', 'fixture-key');
  assert.equal((await client.planSearch({ q: '검사 보고서' })).searches[0].q, 'inspection report');
  assert.equal(attempts.length, 2);
  assert.equal(attempts[0].url, attempts[1].url);
  assert.equal(attempts[0].options.signal, attempts[1].options.signal);
});

test('persistent Gemini unavailability is bounded and long cooldowns are respected', async () => {
  for (const [status, delay, expectedAttempts] of [[503, '0', 2], [503, '90', 1], [403, '0', 1], [429, '0', 1]]) {
    let attempts = 0;
    const client = aiClient(async () => {
      attempts++;
      return new Response(null, { status, headers: { 'Retry-After': delay } });
    }, 'gemini', 'test-model', 'fixture-key');
    await assert.rejects(client.planSearch({ q: '검사' }), error => error.status === (status === 403 ? 422 : status));
    assert.equal(attempts, expectedAttempts);
  }
});

test('a bilingual document summary recovers from a transient Gemini 503 with the same page data', async () => {
  const sentence = 'The document contains a revised schedule.';
  const pages = Array(25).fill('Other material.');
  pages[24] = sentence;
  const item = { labelEn: 'Schedule', labelKo: '일정', english: 'Revised schedule', korean: '변경된 일정',
    quoteEn: sentence, quoteKo: '문서에 변경된 일정이 있다.', page: 25, status: 'found' };
  const calls = [];
  const client = aiClient(async (url, options) => {
    calls.push({ url, options });
    if (calls.length === 1) return new Response(null, { status: 503, headers: { 'Retry-After': '0' } });
    return Response.json({ candidates: [{ content: { parts: [{ text: JSON.stringify({ items: [item] }) }] } }] });
  }, 'gemini', 'gemini-flash-lite-latest', 'fixture-key');
  const [result] = await client.analyze(null, pages, pages.length, 'summary', '', { kind: 'full' });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, calls[1].url);
  assert.equal(calls[0].options.body, calls[1].options.body);
  assert.equal(calls[0].options.signal, calls[1].options.signal);
  assert.equal(result.page, 25);
  assert.equal(result.evidence, 'matched');
});

test('when Gemini remains unavailable the PDF analysis stops after its one retry', async () => {
  let calls = 0;
  const client = aiClient(async () => {
    calls++;
    return new Response(null, { status: 503, headers: { 'Retry-After': '0' } });
  }, 'gemini', 'fixture-model', 'fixture-key');
  await assert.rejects(client.analyze(Buffer.from('%PDF-fixture'), [''], 1, 'extract', '날짜', { kind: 'full' }),
    error => error.status === 503 && error.message.includes('한 번 더') && !error.message.includes('검색식'));
  assert.equal(calls, 2);
});
