import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as sleep } from 'node:timers/promises';
import { test } from 'node:test';
import { createApp } from '../server.mjs';
import { preparePdfInput, renderOriginalPdfPage } from '../pdf-analysis.mjs';

const ml = 'ML24017A120';
const source = 'https://www.nrc.gov/docs/ML2401/ML24017A120.pdf';
const quote = 'The licensee must respond within 30 days.';
const document = { AccessionNumber: ml, DocumentTitle: 'Inspection report', DocumentType: ['Inspection Report'],
  DocketNumber: ['05000271'], Url: source, EstimatedPageCount: '2' };
const items = [
  { labelEn: 'Deadline', labelKo: '제출기한', english: '30 days', korean: '30일', quoteEn: quote,
    quoteKo: '사업자는 30일 이내에 회신해야 한다.', page: 2, status: 'found' },
  { labelEn: 'Approval date', labelKo: '승인일', english: 'Wrong', korean: '잘못된 값', quoteEn: '', quoteKo: '', page: 0, status: 'missing' },
];

test('per-user keys and Gemini, OpenAI and Claude document workflows', async t => {
  const calls = [];
  let planUnavailable = false;
  const db = new DatabaseSync(':memory:');
  const server = createApp({
    db, encryptionKey: randomBytes(32), invite: 'test-invite-code', pdfText: async () => [quote, 'Page two'],
    fetcher: async (address, response) => {
      const url = new URL(address);
      const body = response.body && JSON.parse(response.body);
      calls.push({ url: url.hostname, headers: response.headers, body });
      if (url.hostname === 'adams-api.nrc.gov') {
        assert.equal(response.headers['Ocp-Apim-Subscription-Key'], 'fixture-nrc-alice');
        if (response.method === 'POST') {
          if (body.q.includes('safety evaluation') && body.skip === 0) return Response.json({
            count: 3, results: [{ document: { ...document, AccessionNumber: 'ML24017A121' } }, { document }],
          });
          return Response.json({ count: body.skip ? 3 : 1, results: [{ document }], pageNumber: 1 });
        }
        if (url.pathname.endsWith('ML24017A122')) return Response.json({ document: { ...document,
          AccessionNumber: 'ML24017A122', DocumentTitle: 'Record without URL', Url: '' } });
        return Response.json({ document });
      }
      if (url.hostname === 'www.nrc.gov' && url.pathname.endsWith('/ML24017A122.pdf')) return new Response('%PDF-1.5\npublic fallback');
      if (address === source) return new Response('%PDF-1.5\nfixture');
      if (url.hostname === 'generativelanguage.googleapis.com') {
        assert.equal(response.headers['x-goog-api-key'], 'fixture-gemini-alice');
        if (url.pathname.endsWith('/models')) {
          const model = { name: 'models/gemini-3.8-flash', displayName: 'Gemini 3.8 Flash', supportedGenerationMethods: ['generateContent'] };
          return Response.json(url.searchParams.has('pageToken') ? { models: [model] } : {
            models: [model, { name: 'models/embed', supportedGenerationMethods: ['embedContent'] }],
            nextPageToken: 'next',
          });
        }
        assert.equal(body.generationConfig.responseMimeType, 'application/json');
        const pdf = body.contents[0].parts[0].inlineData;
        if (pdf) assert.equal(pdf.mimeType, 'application/pdf');
        const schema = body.generationConfig.responseJsonSchema.properties;
        if (schema.intent && planUnavailable) return new Response(null, { status: 503, headers: { 'Retry-After': '0' } });
        const result = pdf ? { items } : schema.status ? { status: 'OK' } : schema.intent ? {
          intent: 'Palo Verde 2호기의 변경 승인 근거를 확인합니다.',
          searches: [{ query: '"Palo Verde" "safety evaluation"', type: 'Safety Evaluation' },
            { query: '"Palo Verde" "issued amendment"', type: '' }],
        } : { query: 'inspection report' };
        return Response.json({ candidates: [{ content: { parts: [{ text: JSON.stringify(result) }] } }] });
      }
      if (url.hostname === 'api.openai.com') {
        assert.equal(response.headers.Authorization, 'Bearer fixture-openai-alice');
        assert.equal(body.input[0].content[0].type, 'input_file');
        assert.equal(body.store, false);
        return Response.json({ output: [{ content: [{ type: 'output_text', text: JSON.stringify({ items }) }] }] });
      }
      if (url.hostname === 'api.anthropic.com') {
        assert.equal(response.headers['x-api-key'], 'fixture-claude-alice');
        assert.equal(body.messages[0].content[0].type, 'document');
        return Response.json({ content: [{ type: 'text', text: JSON.stringify({ items }) }] });
      }
      throw new Error(`Unexpected URL ${url}`);
    },
  }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    const closed = once(server, 'close');
    server.close();
    await closed;
    db.close();
  });
  const root = `http://127.0.0.1:${server.address().port}`;
  function browser() {
    let cookie;
    let accountId;
    return async (route, body, expected = 200, origin = root) => {
      const headers = cookie ? { Cookie: cookie, 'X-ADAMS-Account': accountId } : {};
      const options = body === undefined ? { headers } : {
        method: 'POST', headers: { ...headers, Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      };
      const response = await fetch(root + route, options);
      const content = await response.json();
      assert.equal(response.status, expected, JSON.stringify(content));
      const newCookie = response.headers.get('set-cookie');
      if (newCookie) {
        assert.match(newCookie, /HttpOnly; SameSite=Strict/);
        cookie = newCookie.split(';')[0];
        if (content.accountId) accountId = content.accountId;
      }
      return content;
    };
  }
  assert.match(await (await fetch(root)).text(), /NRC ADAMS/);
  const alice = browser();
  const bob = browser();
  const signup = email => ({ email, password: 'a-test-passphrase-123', invite: 'test-invite-code' });
  await bob('/api/settings', undefined, 401);
  await bob('/api/signup', { ...signup('bob@example.test'), invite: 'wrong' }, 403);
  await alice('/api/signup', signup('alice@example.test'), 403, 'https://unrelated.test');
  const aliceAccount = await alice('/api/signup', signup('alice@example.test'));
  const bobAccount = await bob('/api/signup', signup('bob@example.test'));
  assert.equal((await alice('/api/me')).accountId, aliceAccount.accountId);
  const bobLogin = await fetch(root + '/api/login', { method: 'POST', headers: { Origin: root, 'Content-Type': 'application/json' },
    body: JSON.stringify(signup('bob@example.test')) });
  const bobCookie = bobLogin.headers.get('set-cookie').split(';')[0];
  for (const staleHeader of [{}, { 'X-ADAMS-Account': aliceAccount.accountId }]) {
    const stale = await fetch(root + '/api/settings', { method: 'POST',
      headers: { Origin: root, Cookie: bobCookie, 'Content-Type': 'application/json', ...staleHeader },
      body: JSON.stringify({ action: 'save', provider: 'gemini', key: 'old-tab-fixture' }) });
    assert.equal(stale.status, 412);
    assert.deepEqual((await bob('/api/settings')).keys, {});
  }
  assert.notEqual(aliceAccount.accountId, bobAccount.accountId);
  for (const provider of ['nrc', 'gemini', 'openai', 'claude']) {
    const key = `fixture-${provider}-alice`;
    const settings = await alice('/api/settings', { action: 'save', provider, key });
    assert.equal(settings.keys[provider].configured, true);
    assert.doesNotMatch(JSON.stringify(settings), /fixture/);
  }
  assert.deepEqual((await bob('/api/settings')).keys, {});
  assert.equal(db.prepare('SELECT count(*) AS size FROM credentials WHERE secret LIKE ?').get('%fixture%').size, 0);
  const keyless = await bob('/api/search', { q: 'inspection report', docket: '50-271', to: '2024-12-31' });
  const handoff = new URL(keyless.publicLink);
  const linkQuery = JSON.parse(decodeURIComponent(handoff.pathname.split('/').at(-1)));
  assert.equal(handoff.origin, 'https://adams-search.nrc.gov');
  assert.equal(linkQuery.keywords, 'inspection report');
  assert.equal(linkQuery.all[0].keywords, '05000271');
  assert.equal(linkQuery.all[1].startDate, '2024-12-31');
  assert.equal(linkQuery.all[1].dateOperator, 'ends');
  assert.equal(calls.length, 0);
  await alice('/api/check', { provider: 'nrc' });
  const check = await alice('/api/check', { provider: 'gemini' });
  assert.equal(check.model, 'gemini-3.8-flash');
  assert.ok(Number.isFinite(check.elapsedMs));
  assert.deepEqual((await alice('/api/models/gemini')).models, [{ id: 'gemini-3.8-flash', label: 'Gemini 3.8 Flash' }]);
  await bob('/api/models/gemini', undefined, 422);
  assert.equal((await alice('/api/search', { q: ml.toLowerCase() })).documents[0].id, ml);
  const search = await alice('/api/search', { docket: '50-271', from: '2024-01-01', to: '2024-02-03' });
  assert.equal(search.documents[0].url, source);
  assert.equal(calls.at(-1).body.filters[0].value, '05000271');
  assert.equal(calls.at(-1).body.filters[1].value, "(DocumentDate ge '2024-01-01') and (DocumentDate le '2024-02-03')");
  assert.equal((await alice('/api/translate', { q: '검사 보고서 50-271 "integrated inspection"' })).query, 'inspection report 50-271 "integrated inspection"');
  const contextual = { q: '2022년 이후 Palo Verde 2호기 NRC 승인 문서 NUREG-0800', docket: '05000529' };
  const searchStart = calls.length;
  const smart = await alice('/api/search', contextual);
  assert.equal(smart.plan.queries.length, 2);
  assert.equal(smart.documents[0].id, ml);
  assert.equal(smart.documents.length, 2);
  for (const call of calls.slice(searchStart).filter(call => call.url === 'adams-api.nrc.gov')) {
    assert.match(call.body.q, /NUREG-0800/);
    assert.ok(call.body.filters.some(filter => filter.value === '05000529'));
    assert.ok(call.body.filters.some(filter => filter.value === "(DocumentDate ge '2022-01-01')"));
  }
  assert.ok(smart.next);
  const moreStart = calls.length;
  await bob('/api/search', { skip: smart.next }, 409);
  await alice('/api/search', { skip: smart.next });
  assert.ok(calls.slice(moreStart).every(call => call.url === 'adams-api.nrc.gov'));
  const keylessSmart = await alice('/api/search', { ...contextual, public: true });
  const publicQuery = JSON.parse(decodeURIComponent(new URL(keylessSmart.plan.queries[0].publicLink).pathname.split('/').at(-1)));
  assert.ok(publicQuery.all.some(filter => filter.dateOperator === 'starts' && filter.startDate === '2022-01-01'));
  assert.ok(publicQuery.all.some(filter => filter.keywords === 'Safety Evaluation'));

  planUnavailable = true;
  const rawQuery = '2022년 7월 이후의 보고서';
  const fallback = await alice('/api/search', { q: rawQuery, public: true });
  const rawLink = JSON.parse(decodeURIComponent(new URL(fallback.publicLink).pathname.split('/').at(-1)));
  assert.equal(rawLink.keywords, rawQuery);
  assert.ok(rawLink.all.some(filter => filter.startDate === '2022-07-01' && filter.dateOperator === 'starts'));
  assert.match(fallback.warnings.join(' '), /503/);
  planUnavailable = false;

  const missingUrlResult = await alice('/api/search', { q: 'ML24017A122' });
  assert.equal(missingUrlResult.documents[0].url, '');
  const resolved = await alice('/api/import', { source: 'ML24017A122', includeMetadata: true });
  assert.equal(resolved.title, 'Record without URL');
  assert.equal(resolved.url, 'https://www.nrc.gov/docs/ML2401/ML24017A122.pdf');
  assert.equal((await alice('/api/document/ML24017A122')).title, resolved.title);

  const request = { ml, mode: 'extract', question: '제출기한과 승인일' };
  db.prepare(`INSERT INTO analyses(id,owner,ml,mode,question,provider,model,state,created)
    VALUES('previous-input',?,?,'extract',?,'gemini','gemini-3.8-flash','done',1)`).run(aliceAccount.accountId, ml, request.question);
  assert.equal((await alice('/api/analysis/previous-input')).previousInput, true);
  for (const provider of ['gemini', 'openai', 'claude']) {
    await alice('/api/settings', { action: 'select', provider });
    const { id } = await alice('/api/analysis', request, 202);
    assert.notEqual(id, 'previous-input');
    let record = await alice(`/api/analysis/${id}`);
    for (let i = 0; record.state === 'working' && i < 100; i++) {
      await sleep(15);
      record = await alice(`/api/analysis/${id}`);
    }
    assert.equal(record.state, 'done', record.error);
    assert.equal(record.provider, provider);
    assert.equal(record.items[0].korean, '30일');
    assert.equal(record.items[0].evidence, 'matched');
    assert.equal(record.items[0].page, 1);
    assert.equal(record.items[1].english, '');
    assert.equal((await alice('/api/analysis', request)).id, id);
    await bob(`/api/analysis/${id}`, undefined, 404);
    await bob('/api/library', { action: 'save', id, rows: [0] }, 404);
    await alice('/api/library', { action: 'save', id, rows: [1] }, 400);
    await alice('/api/library', { action: 'save', id, rows: [0, 0] });
  }
  assert.equal((await alice('/api/library')).length, 3);
  assert.deepEqual(await bob('/api/library'), []);
  const [{ id, idx }] = await alice('/api/library');
  await alice('/api/library', { action: 'delete', id, rows: [idx] });
  assert.equal((await alice('/api/library')).length, 2);
  await alice('/api/logout', {});
  await alice('/api/library', undefined, 401);
  await alice('/api/login', signup('alice@example.test'));
  assert.equal((await alice('/api/library')).length, 2);
  await alice('/api/settings', { action: 'delete', provider: 'claude' });
  await alice('/api/check', { provider: 'claude' }, 422);

  await alice('/api/settings', { action: 'delete', provider: 'nrc' });
  await alice('/api/settings', { action: 'select', provider: 'gemini' });
  calls.length = 0;
  const docs = await alice('/api/search', { q: ml });
  assert.equal(docs.documents[0].imported, true);
  assert.equal(docs.documents[0].id, ml);
  assert.equal((await alice('/api/import', { source })).accession, ml);
  await alice('/api/import', { source: 'https://example.com/sample.pdf' }, 400);
  async function analyzeWithoutNrc(id, mode) {
    const started = await alice('/api/analysis', { ml: id, mode }, 202);
    for (let i = 0; i < 100; i++) {
      const record = await alice(`/api/analysis/${started.id}`);
      if (record.state !== 'working') {
        assert.equal(record.state, 'done', record.error);
        return record;
      }
      await sleep(15);
    }
    assert.fail('Keyless analysis did not complete');
  }
  await analyzeWithoutNrc(ml, 'summary');
  const auth = await fetch(`${root}/api/login`, { method: 'POST', headers: { Origin: root, 'Content-Type': 'application/json' },
    body: JSON.stringify(signup('alice@example.test')) });
  const cookie = auth.headers.get('set-cookie').split(';')[0];
  const { accountId } = await auth.json();
  const uploadHeaders = { Origin: root, Cookie: cookie, 'X-ADAMS-Account': accountId, 'Content-Type': 'application/pdf',
    'X-Document-Name': encodeURIComponent('검사.pdf'), 'X-ADAMS-Accession': ml };
  const invalidPdf = await fetch(`${root}/api/upload`, { method: 'POST', headers: uploadHeaders, body: '<html>not a PDF</html>' });
  assert.equal(invalidPdf.status, 400);
  const upload = await fetch(`${root}/api/upload`, { method: 'POST', headers: uploadHeaders, body: '%PDF-1.5\nfixture user upload' });
  assert.equal(upload.status, 201);
  const uploaded = await upload.json();
  assert.equal(uploaded.title, '검사.pdf');
  assert.equal(uploaded.accession, ml);
  await bob(uploaded.url, undefined, 404);
  const pdf = await fetch(root + uploaded.url, { headers: { Cookie: cookie } });
  assert.equal(pdf.headers.get('content-type'), 'application/pdf');
  assert.equal(await pdf.text(), '%PDF-1.5\nfixture user upload');
  const range = await fetch(root + '/api/pdf/' + ml, { headers: { Cookie: cookie, Range: 'bytes=0-6' } });
  assert.equal(range.status, 206);
  assert.equal(await range.text(), '%PDF-1.');
  const uploadResult = await analyzeWithoutNrc(uploaded.id, 'summary');
  await alice('/api/library', { action: 'save', id: uploadResult.id, rows: [0] });
  assert.ok((await alice('/api/library')).some(item => item.source.accession === ml && item.source.uploaded));
  assert.ok(calls.every(call => call.url !== 'adams-api.nrc.gov'));
});

function longPdf() {
  const count = 125;
  const firstPage = 4;
  const last = firstPage + count * 2;
  const references = [];
  const objects = [null, '<< /Type /Catalog /Pages 2 0 R >>', '',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
  for (let index = 0; index < count; index++) {
    const id = firstPage + index * 2;
    references.push(`${id} 0 R`);
    const text = index === 4 ? 'Executive Summary' : index === 117 ? 'Licensee shall submit a repair schedule within 30 days.' : `Technical appendix page ${index + 1}`;
    const stream = `BT /F1 13 Tf 72 730 Td (${text}) Tj ET`;
    objects[id] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${id + 1} 0 R >>`;
    objects[id + 1] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
  }
  objects[2] = `<< /Type /Pages /Count ${count} /Kids [${references.join(' ')}] >>`;
  let bytes = '%PDF-1.5\n';
  const offsets = ['0000000000 65535 f '];
  for (let id = 1; id < last; id++) {
    offsets.push(`${String(bytes.length).padStart(10, '0')} 00000 n `);
    bytes += `${id} 0 obj\n${objects[id]}\nendobj\n`;
  }
  const xref = bytes.length;
  return Buffer.from(`${bytes}xref\n0 ${last}\n${offsets.join('\n')}\ntrailer\n<< /Size ${last} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
}

test('long PDFs supply overview and relevant pages with original page mapping', async () => {
  const pdf = longPdf();
  const options = { question: '수리 일정 제출기한', pageCount: 125, pageRange: null, setStage() {},
    findTerms: async () => [['repair schedule', 'submit']], legacyText: async () => null };
  const overview = await preparePdfInput(pdf, { ...options, mode: 'summary' });
  assert.equal(overview.scope.kind, 'overview');
  assert.equal(overview.scope.total, 125);
  assert.ok(overview.scope.pages.includes(5));
  assert.ok(!overview.scope.pages.includes(118));
  assert.ok(overview.pdf.length < pdf.length);
  const specific = await preparePdfInput(pdf, { ...options, mode: 'extract' });
  assert.equal(specific.scope.kind, 'targeted');
  const position = specific.scope.pages.indexOf(118);
  assert.match(specific.pages[position], /repair schedule/);
  const ranged = await preparePdfInput(pdf, { ...options, mode: 'extract', pageRange: { from: 118, to: 119 } });
  assert.deepEqual(ranged.scope.pages, [118, 119]);
  assert.match(ranged.pages[0], /30 days/);
  const preview = await renderOriginalPdfPage(pdf, 118);
  assert.equal(preview.count, 125);
  assert.equal(preview.image.subarray(1, 4).toString(), 'PNG');
});
