import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import {
  createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID, scrypt, timingSafeEqual,
} from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { aiClient, AppError, downloadPdf, IMPORT_ID, isPdf, listGeminiModels, localPdfText, ML, MODELS, nrcClient,
  PDF_LIMIT, publicAccession, publicPdf, publicSearchLink } from './services.mjs';
import { contextualDates, searchBranches } from './search.mjs';
import { parsePageRange, preparePdfInput, renderOriginalPdfPage } from './pdf-analysis.mjs';

const hashPassword = promisify(scrypt);
const checksum = data => createHash('sha256').update(data).digest('hex');
const SESSION = 'adams_session';
const DAY = 86400000;
const UPLOAD_QUOTA = 128 * 1024 * 1024;
const INPUT_VERSION = 2;
const PREVIEW_CACHE_BYTES = 32 * 1024 * 1024;
const project = fileURLToPath(new URL('.', import.meta.url));
const assets = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8'],
};

function field(value, max) {
  if (value == null) return '';
  if (typeof value !== 'string' || value.length > max) throw new AppError(400, '입력 형식 또는 길이를 확인하세요.');
  return value.trim();
}

async function json(req) {
  if (!/^application\/json(?:;|$)/i.test(req.headers['content-type'] ?? '')) throw new AppError(415, 'JSON 요청이 필요합니다.');
  const parts = [];
  let length = 0;
  for await (const part of req.iterator({ destroyOnReturn: false })) {
    length += part.length;
    if (length > 16384) throw new AppError(413, '입력 내용이 너무 깁니다.');
    parts.push(part);
  }
  try {
    const value = JSON.parse(Buffer.concat(parts));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value;
  } catch {
    throw new AppError(400, '요청 형식을 확인하세요.');
  }
}

function writeJson(res, status, value) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(value));
}

function sendPdf(req, res, length, read) {
  const headers = { 'Content-Type': 'application/pdf', 'Content-Disposition': 'inline', 'Accept-Ranges': 'bytes',
    'Content-Security-Policy': "default-src 'none'; frame-ancestors 'self'" };
  if (req.headers.range) {
    const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
    const [from, to] = range?.slice(1) ?? [];
    const start = from ? Number(from) : to ? Math.max(0, length - Number(to)) : -1;
    const end = from && to ? Math.min(Number(to), length - 1) : length - 1;
    if (start < 0 || start > end || start >= length) {
      res.writeHead(416, { ...headers, 'Content-Range': `bytes */${length}` });
      return res.end();
    }
    const body = read(start, end + 1);
    res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${length}`, 'Content-Length': body.length });
    return res.end(body);
  }
  const body = read(0, length);
  res.writeHead(200, { ...headers, 'Content-Length': length });
  return res.end(body);
}

function seal(key, user, provider, plaintext) {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(Buffer.from(`${user}:${provider}`));
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return Buffer.concat([nonce, cipher.getAuthTag(), ciphertext]).toString('base64url');
}

function unseal(key, user, provider, encrypted) {
  const input = Buffer.from(encrypted, 'base64url');
  const cipher = createDecipheriv('aes-256-gcm', key, input.subarray(0, 12));
  cipher.setAAD(Buffer.from(`${user}:${provider}`));
  cipher.setAuthTag(input.subarray(12, 28));
  return Buffer.concat([cipher.update(input.subarray(28)), cipher.final()]).toString();
}

function init(db) {
  db.exec(`
    PRAGMA foreign_keys = ON;
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, salt TEXT NOT NULL, password TEXT NOT NULL,
      provider TEXT NOT NULL DEFAULT 'gemini'
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY, owner TEXT NOT NULL REFERENCES users(id), expires INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS credentials (
      owner TEXT NOT NULL REFERENCES users(id), provider TEXT NOT NULL, secret TEXT NOT NULL, model TEXT NOT NULL,
      PRIMARY KEY(owner, provider)
    );
    CREATE TABLE IF NOT EXISTS analyses (
      id TEXT PRIMARY KEY, owner TEXT NOT NULL REFERENCES users(id), ml TEXT NOT NULL, mode TEXT NOT NULL,
      question TEXT NOT NULL, provider TEXT NOT NULL, model TEXT NOT NULL, state TEXT NOT NULL, created INTEGER NOT NULL,
      source TEXT, result TEXT, error TEXT
    );
    CREATE INDEX IF NOT EXISTS analyses_by_owner ON analyses(owner, ml, created DESC);
    CREATE TABLE IF NOT EXISTS imports (
      owner TEXT NOT NULL REFERENCES users(id), id TEXT NOT NULL, source TEXT NOT NULL, pdf BLOB,
      PRIMARY KEY(owner, id)
    );
    CREATE TABLE IF NOT EXISTS saved (
      owner TEXT NOT NULL REFERENCES users(id), analysis TEXT NOT NULL REFERENCES analyses(id), row_number INTEGER NOT NULL,
      created INTEGER NOT NULL, PRIMARY KEY(owner, analysis, row_number)
    );
    DELETE FROM sessions WHERE expires < unixepoch() * 1000;
  `);
  const analysisColumns = new Set(db.prepare('PRAGMA table_info(analyses)').all().map(column => column.name));
  if (!analysisColumns.has('page_range')) db.exec("ALTER TABLE analyses ADD COLUMN page_range TEXT NOT NULL DEFAULT ''");
  if (!analysisColumns.has('stage')) db.exec("ALTER TABLE analyses ADD COLUMN stage TEXT NOT NULL DEFAULT ''");
  if (!analysisColumns.has('input_version')) db.exec('ALTER TABLE analyses ADD COLUMN input_version INTEGER NOT NULL DEFAULT 1');
}

export function createApp({ db, encryptionKey, origin, invite, trustProxy = false, localAccess = false, fetcher = fetch, pdfText = localPdfText, renderPage = renderOriginalPdfPage }) {
  init(db);
  const run = (sql, ...values) => db.prepare(sql).run(...values);
  const one = (sql, ...values) => db.prepare(sql).get(...values);
  const all = (sql, ...values) => db.prepare(sql).all(...values);
  const active = new Set();
  const rate = new Map();
  const searchCursors = new Map();
  const pdfCache = new Map();
  const pdfDownloads = new Map();
  let cachedBytes = 0;
  const renderedPages = new Map();
  const pendingPages = new Map();
  const renderQueue = [];
  let renders = 0;
  let renderedBytes = 0;
  const secure = origin?.startsWith('https:') ? '; Secure' : '';
  // Behind a reverse proxy every socket address is the proxy; use the address that proxy appended last.
  const clientAddress = req => (trustProxy && req.headers['x-forwarded-for']?.split(',').at(-1).trim()) || req.socket.remoteAddress;
  const sessionCookie = (token, seconds) => `${SESSION}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${seconds}${secure}`;
  // Loopback-only mode: requests without a session use the first account (created on demand).
  function localUser() {
    const existing = one('SELECT id, email, provider FROM users ORDER BY rowid LIMIT 1');
    if (existing) return existing;
    const id = randomUUID();
    run("INSERT INTO users(id, email, salt, password) VALUES(?, 'local', ?, ?)", id, randomBytes(16).toString('hex'), randomBytes(64).toString('hex'));
    return { id, email: 'local', provider: 'gemini' };
  }
  function credential(owner, provider) {
    const saved = one('SELECT secret, model FROM credentials WHERE owner = ? AND provider = ?', owner, provider);
    if (!saved) throw new AppError(422, provider === 'nrc' ? 'API 설정에서 NRC 키를 먼저 저장하세요.' : 'API 설정에서 선택한 AI 제공자의 키를 먼저 저장하세요.');
    try {
      return { key: unseal(encryptionKey, owner, provider, saved.secret), model: saved.model };
    } catch {
      throw new AppError(422, '저장된 키를 읽을 수 없습니다. API 설정에서 키를 다시 입력하세요.');
    }
  }
  const nrc = owner => nrcClient(fetcher, credential(owner, 'nrc').key);
  function ai(owner, provider) {
    const { key, model } = credential(owner, provider);
    return { model, client: aiClient(fetcher, provider, model, key) };
  }
  function status(owner) {
    const { provider } = one('SELECT provider FROM users WHERE id = ?', owner);
    const keys = Object.fromEntries(all('SELECT provider, model FROM credentials WHERE owner = ?', owner)
      .map(record => [record.provider, { configured: true, model: record.model }]));
    return { provider, keys, models: MODELS };
  }
  function rateLimit(id, maximum, interval) {
    const now = Date.now();
    for (const [key, value] of rate) if (value.until <= now) rate.delete(key);
    const bucket = rate.get(id) ?? { count: 0, until: now + interval };
    if (++bucket.count > maximum) throw new AppError(429, '요청이 너무 많습니다. 잠시 후 다시 시도하세요.');
    rate.set(id, bucket);
  }
  function cursor(owner, next, plan) {
    if (!next.length) return null;
    const now = Date.now();
    for (const [id, search] of searchCursors) if (search.expires <= now) searchCursors.delete(id);
    if (searchCursors.size >= 256) searchCursors.delete(searchCursors.keys().next().value);
    const id = randomUUID();
    searchCursors.set(id, { owner, next, plan, expires: now + 15 * 60000 });
    return id;
  }
  function searchPlan(intent, branches) {
    return {
      intent,
      queries: branches.map(({ criteria }) => ({ query: criteria.q, type: criteria.type, from: criteria.from,
        to: criteria.to, publicLink: publicSearchLink(criteria) })),
    };
  }
  function publicSearchResult(criteria, plan, warnings) {
    return { documents: [], next: null, plan, warnings, publicLink: plan?.queries[0].publicLink || publicSearchLink(criteria) };
  }
  async function executeSearchPlan(owner, branches, plan, warnings = []) {
    const outcome = await searchBranches(nrc(owner), branches);
    if (outcome.failures === branches.length) {
      return publicSearchResult(branches[0].criteria, plan, [...warnings, 'NRC API에 연결하지 못했습니다. 같은 검색식을 공개 검색에서 열 수 있습니다.']);
    }
    if (outcome.failures) warnings.push('일부 검색식의 NRC 응답을 받지 못해 조회된 결과만 표시합니다.');
    return { documents: outcome.documents, next: cursor(owner, outcome.next, plan), plan, warnings };
  }
  function requireMl(value) {
    const id = field(value, 20).toUpperCase();
    if (!ML.test(id)) throw new AppError(400, '올바른 ML 번호를 입력하세요.');
    return id;
  }
  function requireDocumentId(value) {
    const id = field(value, 68);
    return IMPORT_ID.test(id) ? id : requireMl(id);
  }
  function importedSource(owner, id) {
    const row = one('SELECT source FROM imports WHERE owner = ? AND id = ?', owner, id);
    return row && JSON.parse(row.source);
  }
  function uploadedPdf(owner, id) {
    const row = one('SELECT pdf FROM imports WHERE owner = ? AND id = ? AND pdf IS NOT NULL', owner, id);
    if (!row) throw new AppError(404, '업로드한 PDF를 찾을 수 없습니다.');
    return Buffer.from(row.pdf.buffer, row.pdf.byteOffset, row.pdf.byteLength);
  }
  function listUploads(owner) {
    const files = all('SELECT source, length(pdf) AS bytes FROM imports WHERE owner = ? AND pdf IS NOT NULL ORDER BY rowid DESC', owner);
    return { documents: files.map(row => ({ ...JSON.parse(row.source), bytes: row.bytes })),
      usedBytes: files.reduce((total, row) => total + row.bytes, 0), limitBytes: UPLOAD_QUOTA };
  }
  function importRecord(owner, { id, accession, title, url, pdf, metadata }) {
    const source = { title, date: '', types: [], docket: [], members: [], package: false, legacy: false, pageCount: null,
      ...metadata, id, accession, url, imported: true, uploaded: Boolean(pdf) };
    const existing = importedSource(owner, id);
    if (existing) {
      if (!metadata || existing.uploaded) return existing;
      run('UPDATE imports SET source = ? WHERE owner = ? AND id = ?', JSON.stringify(source), owner, id);
      return source;
    }
    if (pdf) {
      const { bytes } = one('SELECT COALESCE(SUM(length(pdf)), 0) AS bytes FROM imports WHERE owner = ?', owner);
      if (bytes + pdf.length > UPLOAD_QUOTA) throw new AppError(413, '이 계정의 PDF 보관 한도 128 MB에 도달했습니다. 업로드한 PDF를 정리한 뒤 다시 시도하세요.');
    }
    run('INSERT INTO imports(owner, id, source, pdf) VALUES(?, ?, ?, ?)', owner, id, JSON.stringify(source), pdf ?? null);
    return source;
  }
  async function readPublicPdf(url) {
    for (const [key, entry] of pdfCache) {
      if (entry.expires > Date.now()) continue;
      pdfCache.delete(key);
      cachedBytes -= entry.pdf.length;
    }
    const saved = pdfCache.get(url);
    if (saved) return saved.pdf;
    if (pdfDownloads.has(url)) return pdfDownloads.get(url);
    if (pdfDownloads.size >= 4) throw new AppError(429, 'NRC PDF를 가져오는 중입니다. 잠시 후 다시 시도하세요.');
    const pending = downloadPdf(fetcher, url).then(pdf => {
      while (cachedBytes + pdf.length > PDF_LIMIT && pdfCache.size) {
        const oldest = pdfCache.keys().next().value;
        cachedBytes -= pdfCache.get(oldest).pdf.length;
        pdfCache.delete(oldest);
      }
      pdfCache.set(url, { pdf, expires: Date.now() + 5 * 60000 });
      cachedBytes += pdf.length;
      return pdf;
    }).finally(() => pdfDownloads.delete(url));
    pdfDownloads.set(url, pending);
    return pending;
  }
  async function importPublic(owner, input, { lookupMetadata = false, metadata } = {}) {
    const id = publicAccession(input);
    if (lookupMetadata && id && one("SELECT 1 FROM credentials WHERE owner = ? AND provider = 'nrc'", owner)) {
      try {
        const doc = await nrc(owner).document(id);
        if (doc.id === id) metadata = doc;
      } catch (error) {
        if (!(error instanceof AppError)) throw error;
      }
    }
    let result;
    if (metadata?.url && metadata.id === id) {
      try {
        await readPublicPdf(metadata.url);
        result = { id, title: metadata.title, url: metadata.url };
      } catch (error) {
        if (!(error instanceof AppError) || [413, 429].includes(error.status)) throw error;
      }
    }
    result ??= await publicPdf(fetcher, input, readPublicPdf);
    return importRecord(owner, { ...result, metadata, accession: result.id, id: result.id || `PDF-${checksum(result.url)}` });
  }
  async function previewPdf(owner, id) {
    const local = importedSource(owner, id);
    if (local?.uploaded) return uploadedPdf(owner, id);
    if (local?.url) return readPublicPdf(local.url);
    if (!ML.test(id)) throw new AppError(404, 'PDF를 찾을 수 없습니다.');
    const previous = one('SELECT source FROM analyses WHERE owner = ? AND ml = ? AND source IS NOT NULL ORDER BY created DESC LIMIT 1', owner, id);
    if (previous) return readPublicPdf(JSON.parse(previous.source).url);
    try {
      const doc = await nrc(owner).document(id);
      if (doc.url) return await readPublicPdf(doc.url);
    } catch (error) {
      if (!(error instanceof AppError) || error.status === 413) throw error;
    }
    const doc = await importPublic(owner, id);
    return readPublicPdf(doc.url);
  }
  function evictPage(key) {
    renderedBytes -= renderedPages.get(key).result.image.length;
    renderedPages.delete(key);
  }
  function forgetPages(owner, id) {
    const prefix = `${owner}:${id}:`;
    for (const key of renderedPages.keys()) if (key.startsWith(prefix)) evictPage(key);
    for (const key of pendingPages.keys()) if (key.startsWith(prefix)) pendingPages.delete(key);
  }
  async function previewPage(owner, id, number) {
    const key = `${owner}:${id}:${number}`;
    const cached = renderedPages.get(key);
    if (cached) {
      if (Date.now() < cached.expires) {
        renderedPages.delete(key);
        renderedPages.set(key, cached);
        return cached.result;
      }
      evictPage(key);
    }
    if (pendingPages.has(key)) return pendingPages.get(key).promise;
    if (renderQueue.length >= 12) throw new AppError(429, '미리보기 요청이 많습니다. 잠시 후 다시 시도하세요.');
    const task = {};
    pendingPages.set(key, task);
    task.promise = (async () => {
      if (renders < 3) renders++;
      else await new Promise(resolve => renderQueue.push(resolve));
      try {
        if (pendingPages.get(key) !== task) throw new AppError(404, '원본 PDF가 삭제되었습니다.');
        const result = await renderPage(await previewPdf(owner, id), number);
        if (pendingPages.get(key) !== task) throw new AppError(404, '원본 PDF가 삭제되었습니다.');
        if (result.image.length <= PREVIEW_CACHE_BYTES) {
          while (renderedBytes + result.image.length > PREVIEW_CACHE_BYTES || renderedPages.size >= 96) {
            evictPage(renderedPages.keys().next().value);
          }
          renderedPages.set(key, { result, expires: Date.now() + 5 * 60000 });
          renderedBytes += result.image.length;
        }
        return result;
      } finally {
        if (pendingPages.get(key) === task) pendingPages.delete(key);
        const next = renderQueue.shift();
        if (next) next();
        else renders--;
      }
    })();
    return task.promise;
  }
  async function upload(owner, req) {
    if (req.headers['content-type'] !== 'application/pdf') throw new AppError(415, 'PDF 파일만 올릴 수 있습니다.');
    if (Number(req.headers['content-length']) > PDF_LIMIT) throw new AppError(413, 'PDF는 최대 96 MB까지 올릴 수 있습니다.');
    let name = '';
    try {
      name = decodeURIComponent(req.headers['x-document-name'] ?? '').replace(/[\x00-\x1f]/g, '');
    } catch {
      throw new AppError(400, 'PDF 파일 이름을 읽을 수 없습니다.');
    }
    const accessionInput = field(req.headers['x-adams-accession'], 20);
    const accession = accessionInput ? requireMl(accessionInput) : '';
    const chunks = [];
    let length = 0;
    for await (const part of req.iterator({ destroyOnReturn: false })) {
      length += part.length;
      if (length > PDF_LIMIT) throw new AppError(413, 'PDF는 최대 96 MB까지 올릴 수 있습니다.');
      chunks.push(part);
    }
    const pdf = Buffer.concat(chunks, length);
    if (!isPdf(pdf)) throw new AppError(400, '유효한 PDF 파일을 선택하세요.');
    const id = `PDF-${createHash('sha256').update(`${accession}\n`).update(pdf).digest('hex')}`;
    return importRecord(owner, { id, accession, title: name.slice(0, 250) || accession || '업로드한 문서',
      url: `/api/pdf/${id}`, pdf });
  }
  function date(value) {
    const text = field(value, 10);
    if (text && (!/^\d{4}-\d{2}-\d{2}$/.test(text) || !Number.isFinite(Date.parse(text)) ||
      new Date(text).toISOString().slice(0, 10) !== text)) throw new AppError(400, '날짜 형식을 확인하세요.');
    return text;
  }
  function analysisRow(owner, id) {
    const record = one('SELECT * FROM analyses WHERE owner = ? AND id = ?', owner, id);
    if (!record) throw new AppError(404, '분석 기록을 찾을 수 없습니다.');
    const { state, error, source, result, created, question, mode, provider, model, stage, page_range } = record;
    return { id, state, error, source: source && JSON.parse(source), items: result && JSON.parse(result), created,
      previousInput: record.input_version < INPUT_VERSION,
      question, mode, provider, model, stage, pageRange: page_range };
  }
  function library(owner) {
    return all(`SELECT saved.analysis AS id, saved.row_number AS idx, saved.created, analyses.ml, analyses.source,
        analyses.result, analyses.input_version, imports.id AS import_id FROM saved JOIN analyses ON analyses.id = saved.analysis AND analyses.owner = saved.owner
        LEFT JOIN imports ON imports.owner = saved.owner AND imports.id = analyses.ml
        WHERE saved.owner = ? ORDER BY saved.created DESC`, owner)
      .map(row => {
        const source = JSON.parse(row.source);
        if (source.uploaded && !row.import_id) source.available = false;
        return { id: row.id, idx: row.idx, created: row.created, ml: row.ml, source, item: JSON.parse(row.result)[row.idx],
          previousInput: row.input_version < INPUT_VERSION };
      });
  }
  async function job(id, owner, ml, mode, question, pageRange, source, nrcApi, modelApi) {
    const setStage = stage => run('UPDATE analyses SET stage = ? WHERE id = ? AND owner = ?', stage, id, owner);
    try {
      let doc = source ?? await nrcApi.document(ml);
      if (doc.package) throw new AppError(422, '패키지 안의 개별 문서를 선택하세요.');
      if (!doc.url && ML.test(ml)) doc = await importPublic(owner, ml, { metadata: doc });
      const pdf = doc.uploaded ? uploadedPdf(owner, ml) : await readPublicPdf(doc.url);
      setStage('reading');
      const input = await preparePdfInput(pdf, { mode, question, pageRange, pageCount: doc.pageCount, legacyText: pdfText,
        setStage, findTerms: value => modelApi.evidenceTerms(value) });
      setStage('generating');
      const items = await modelApi.analyze(input.pdf, input.pages, input.total, mode, question, input.scope);
      const recordSource = { ...doc, pageCount: input.total, analysisScope: input.scope };
      run("UPDATE analyses SET state = 'done', source = ?, result = ? WHERE id = ? AND owner = ?", JSON.stringify(recordSource), JSON.stringify(items), id, owner);
    } catch (error) {
      run("UPDATE analyses SET state = 'failed', error = ? WHERE id = ? AND owner = ?",
        error instanceof AppError ? error.message : '문서 분석 중 문제가 발생했습니다. 다시 시도하세요.', id, owner);
    } finally {
      active.delete(owner);
    }
  }
  const server = createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Adams-App', '1');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; img-src 'self' blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    try {
      const port = server.address().port;
      const canonical = origin || `http://127.0.0.1:${port}`;
      const url = new URL(req.url, canonical);
      const path = url.pathname;
      const method = req.method;
      const allowed = origin ? [canonical] : [canonical, `http://localhost:${port}`];
      if (!origin && !allowed.some(value => new URL(value).host === req.headers.host)) throw new AppError(403, '허용된 주소로 접속하세요.');
      if (!['GET', 'POST'].includes(method)) throw new AppError(405, '지원하지 않는 요청입니다.');
      if (method === 'POST' && !allowed.includes(req.headers.origin)) throw new AppError(403, '다른 사이트에서 보내는 요청은 허용되지 않습니다.');
      if (method === 'GET' && Object.hasOwn(assets, path)) {
        const [name, contentType] = assets[path];
        res.writeHead(200, { 'Content-Type': contentType });
        res.end(await readFile(resolve(project, 'public', name)));
        return;
      }
      const token = /(?:^|;\s*)adams_session=([a-f0-9]{64})(?:;|$)/.exec(req.headers.cookie ?? '')?.[1];
      const sessionUser = token && one('SELECT users.id, users.email, users.provider FROM sessions JOIN users ON users.id = sessions.owner WHERE token = ? AND expires > ?', checksum(token), Date.now());
      // Browsers mark requests from other sites; never give those the implicit local account.
      const sameSite = ['same-origin', 'none', undefined].includes(req.headers['sec-fetch-site']);
      const local = !sessionUser && localAccess && sameSite;
      const user = sessionUser || (local ? localUser() : null);
      if (method === 'GET' && path === '/api/me') return writeJson(res, 200, {
        email: user?.email ?? null, accountId: user?.id ?? null, inviteRequired: Boolean(invite), local,
      });

      if (method === 'POST' && ['/api/signup', '/api/login'].includes(path)) {
        rateLimit(`auth:${clientAddress(req)}`, 30, 600000);
        const input = await json(req);
        const email = field(input.email, 254).toLowerCase();
        const password = input.password;
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || typeof password !== 'string' || password.length < 12 || password.length > 128) {
          throw new AppError(400, '이메일과 12~128자 비밀번호를 입력하세요.');
        }
        rateLimit(`auth-email:${email}`, 10, 600000);
        let account = one('SELECT * FROM users WHERE email = ?', email);
        const signup = path.endsWith('signup');
        if (signup && invite && !timingSafeEqual(Buffer.from(checksum(field(input.invite, 200))), Buffer.from(checksum(invite)))) throw new AppError(403, '초대 코드를 확인하세요.');
        const salt = account?.salt ?? randomBytes(16).toString('hex');
        const digest = await hashPassword(password, salt, 64);
        if (signup) {
          const id = randomUUID();
          const inserted = run('INSERT INTO users(id, email, salt, password) VALUES(?, ?, ?, ?) ON CONFLICT(email) DO NOTHING', id, email, salt, digest.toString('hex'));
          if (!inserted.changes) throw new AppError(409, '이미 등록된 이메일입니다. 로그인하세요.');
          account = { id };
        } else if (!account || !timingSafeEqual(digest, Buffer.from(account.password, 'hex'))) {
          throw new AppError(401, '이메일 또는 비밀번호를 확인하세요.');
        }
        if (token) run('DELETE FROM sessions WHERE token = ?', checksum(token));
        run('DELETE FROM sessions WHERE expires <= ?', Date.now());
        const fresh = randomBytes(32).toString('hex');
        run('INSERT INTO sessions VALUES(?, ?, ?)', checksum(fresh), account.id, Date.now() + 7 * DAY);
        res.setHeader('Set-Cookie', sessionCookie(fresh, 7 * 86400));
        return writeJson(res, 200, { email, accountId: account.id });
      }
      if (!user) throw new AppError(401, '로그인이 필요합니다.');
      const { id: owner, provider } = user;
      const displayedAccount = req.headers['x-adams-account'];
      if ((method === 'POST' || displayedAccount !== undefined) && displayedAccount !== owner) {
        throw new AppError(412, '로그인 계정이 변경되었습니다. 새로고침해서 현재 계정을 확인하세요.');
      }
      if (method === 'POST' && path === '/api/logout') {
        run('DELETE FROM sessions WHERE token = ?', checksum(token));
        res.setHeader('Set-Cookie', sessionCookie('', 0));
        return writeJson(res, 200, {});
      }
      if (path === '/api/settings') {
        if (method === 'GET') return writeJson(res, 200, status(owner));
        const input = await json(req);
        const target = field(input.provider, 20);
        if (input.action === 'select' && Object.hasOwn(MODELS, target)) {
          run('UPDATE users SET provider = ? WHERE id = ?', target, owner);
        } else if (target === 'nrc' || Object.hasOwn(MODELS, target)) {
          if (input.action === 'delete') run('DELETE FROM credentials WHERE owner = ? AND provider = ?', owner, target);
          else if (input.action === 'save') {
            const model = target === 'nrc' ? '' : field(input.model, 100) || MODELS[target];
            if (model && !/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(model)) throw new AppError(400, '모델 ID 형식을 확인하세요.');
            const key = field(input.key, 500);
            if (key && !/^[!-~]{8,500}$/.test(key)) throw new AppError(400, '키에 공백이 없는지 확인하세요.');
            if (key) {
              run(`INSERT INTO credentials VALUES(?, ?, ?, ?) ON CONFLICT(owner, provider)
                DO UPDATE SET secret = excluded.secret, model = excluded.model`, owner, target, seal(encryptionKey, owner, target, key), model);
            } else if (!run('UPDATE credentials SET model = ? WHERE owner = ? AND provider = ?', model, owner, target).changes) {
              throw new AppError(400, '저장할 API 키를 입력하세요.');
            }
          } else throw new AppError(400, '지원하지 않는 설정 작업입니다.');
        } else throw new AppError(400, '지원하지 않는 제공자입니다.');
        return writeJson(res, 200, status(owner));
      }
      if (method === 'POST' && path === '/api/check') {
        rateLimit(`check:${owner}`, 8, 60000);
        const target = field((await json(req)).provider, 20);
        if (target === 'nrc') await nrc(owner).document('ML24017A120');
        else if (Object.hasOwn(MODELS, target)) return writeJson(res, 200, { connected: true, ...await ai(owner, target).client.check() });
        else throw new AppError(400, '지원하지 않는 제공자입니다.');
        return writeJson(res, 200, { connected: true });
      }
      if (method === 'GET' && path === '/api/models/gemini') {
        rateLimit(`models:${owner}`, 12, 60000);
        return writeJson(res, 200, { models: await listGeminiModels(fetcher, credential(owner, 'gemini').key) });
      }
      if (method === 'POST' && path === '/api/translate') {
        rateLimit(`translate:${owner}`, 15, 60000);
        const q = field((await json(req)).q, 500);
        if (!q) throw new AppError(400, '검색어를 입력하세요.');
        return writeJson(res, 200, { query: await ai(owner, provider).client.translate(q) });
      }
      if (method === 'POST' && path === '/api/search') {
        rateLimit(`nrc:${owner}`, 45, 60000);
        const input = await json(req);
        if (typeof input.skip === 'string') {
          const continuation = searchCursors.get(field(input.skip, 40));
          if (!continuation || continuation.owner !== owner || continuation.expires <= Date.now()) {
            throw new AppError(409, '검색 결과가 만료되었습니다. 검색 버튼을 눌러 다시 검색하세요.');
          }
          const { next, plan } = continuation;
          if (!one("SELECT 1 FROM credentials WHERE owner = ? AND provider = 'nrc'", owner)) {
            return writeJson(res, 200, publicSearchResult(next[0].criteria, plan, ['NRC 키가 없어 공개 검색을 사용합니다.']));
          }
          return writeJson(res, 200, await executeSearchPlan(owner, next, plan));
        }
        const q = field(input.q, 500);
        const ml = ML.test(q.toUpperCase()) && q.toUpperCase();
        const canUseApi = !input.public && Boolean(one("SELECT 1 FROM credentials WHERE owner = ? AND provider = 'nrc'", owner));
        if (ml) {
          if (canUseApi) {
            try {
              return writeJson(res, 200, { documents: [await nrc(owner).document(ml)], next: null });
            } catch (error) {
              if (!(error instanceof AppError) || ![404, 422, 429, 502, 504].includes(error.status)) throw error;
            }
          }
          const source = importedSource(owner, ml) ?? await importPublic(owner, ml);
          return writeJson(res, 200, { documents: [source], next: null });
        }
        const docket = field(input.docket, 20).toUpperCase();
        const numericDocket = /^(\d{2,3})-(\d{1,5})$/.exec(docket);
        const normalizedDocket = numericDocket ? numericDocket[1].padStart(3, '0') + numericDocket[2].padStart(5, '0')
          : /^\d{7}$/.test(docket) ? `0${docket}` : docket;
        if (docket && !/^(?:\d{8}|[A-Z][A-Z0-9-]{2,19})$/.test(normalizedDocket)) throw new AppError(400, 'Docket 번호를 확인하세요. 예시 05000271 또는 50-271');
        const from = date(input.from);
        const to = date(input.to);
        const report = field(input.report, 160);
        const title = field(input.title, 240);
        const type = field(input.type, 100);
        if (from && to && from > to) throw new AppError(400, '검색 종료일을 시작일 이후로 설정하세요.');
        if (![q, docket, report, title, type, from, to].some(Boolean)) throw new AppError(400, '검색어 또는 필터를 입력하세요.');
        const skip = input.skip ?? 0;
        if (!Number.isInteger(skip) || skip < 0 || skip > 100000) throw new AppError(400, '검색 페이지 번호가 잘못되었습니다.');
        const criteria = { q, docket: normalizedDocket, report, title, type, from, to, skip, legacy: input.legacy === true };
        const smart = q && input.smart !== false;
        if (smart) Object.assign(criteria, contextualDates(q, from, to));
        const warnings = [];
        if (smart && skip === 0) {
          let planned;
          try {
            rateLimit(`search-plan:${owner}`, 15, 60000);
            const { skip: _skip, legacy: _legacy, ...promptCriteria } = criteria;
            planned = await ai(owner, provider).client.planSearch(promptCriteria);
          } catch (error) {
            if (!(error instanceof AppError)) throw error;
            warnings.push(`${error.message} 검색에는 입력한 원문과 검색 조건을 그대로 사용합니다.`);
          }
          if (planned) {
            const branches = planned.searches.map((search, order) => ({
              order, criteria: { ...criteria, q: search.q, type: type || search.type },
            }));
            const plan = searchPlan(planned.intent, branches);
            const result = canUseApi ? await executeSearchPlan(owner, branches, plan)
              : publicSearchResult(branches[0].criteria, plan, warnings);
            return writeJson(res, 200, result);
          }
        }
        if (canUseApi) {
          try {
            return writeJson(res, 200, { ...await nrc(owner).search(criteria), warnings });
          } catch (error) {
            if (!(error instanceof AppError) || ![422, 429, 502, 504].includes(error.status)) throw error;
            warnings.push('NRC API에서 검색 결과를 받지 못했습니다. 같은 조건으로 NRC 공개 검색을 열 수 있습니다.');
          }
        }
        return writeJson(res, 200, publicSearchResult(criteria, null, warnings));
      }
      if (method === 'POST' && path === '/api/import') {
        rateLimit(`nrc:${owner}`, 45, 60000);
        const input = await json(req);
        return writeJson(res, 200, await importPublic(owner, field(input.source, 2000), { lookupMetadata: input.includeMetadata === true }));
      }
      if (method === 'POST' && path === '/api/upload') {
        rateLimit(`upload:${owner}`, 10, 60000);
        return writeJson(res, 201, await upload(owner, req));
      }
      if (path === '/api/uploads') {
        if (method === 'POST') {
          const input = await json(req);
          const id = field(input.id, 68);
          if (input.action !== 'delete' || !IMPORT_ID.test(id)) throw new AppError(400, '삭제할 업로드 PDF를 선택하세요.');
          if (!run('DELETE FROM imports WHERE owner = ? AND id = ? AND pdf IS NOT NULL', owner, id).changes) {
            throw new AppError(404, '업로드한 원본 PDF를 찾을 수 없습니다.');
          }
          forgetPages(owner, id);
        }
        return writeJson(res, 200, listUploads(owner));
      }
      if (method === 'GET' && path.startsWith('/api/pdf-page/')) {
        rateLimit(`preview:${owner}`, 60, 60000);
        const [, , , rawId, rawPage, extra] = path.split('/');
        const id = requireDocumentId(rawId);
        if (extra != null || !/^\d{1,5}$/.test(rawPage) || Number(rawPage) < 1) {
          throw new AppError(400, '미리 볼 PDF 쪽수를 확인하세요.');
        }
        const { count, image } = await previewPage(owner, id, Number(rawPage));
        res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': image.length, 'X-Pdf-Page-Count': count });
        return res.end(image);
      }
      if (method === 'GET' && path.startsWith('/api/pdf/')) {
        rateLimit(`preview:${owner}`, 60, 60000);
        const id = requireDocumentId(path.split('/').at(-1));
        const upload = IMPORT_ID.test(id) && one('SELECT length(pdf) AS bytes FROM imports WHERE owner = ? AND id = ? AND pdf IS NOT NULL', owner, id);
        if (upload) {
          return sendPdf(req, res, upload.bytes, (start, end) => {
            if (start === 0 && end === upload.bytes) return uploadedPdf(owner, id);
            return one('SELECT substr(pdf, ?, ?) AS part FROM imports WHERE owner = ? AND id = ?', start + 1, end - start, owner, id).part;
          });
        }
        const pdf = await previewPdf(owner, id);
        return sendPdf(req, res, pdf.length, (start, end) => pdf.subarray(start, end));
      }
      if (method === 'GET' && path.startsWith('/api/document/')) {
        rateLimit(`nrc:${owner}`, 45, 60000);
        const id = requireDocumentId(path.split('/').at(-1));
        const source = importedSource(owner, id);
        if (source) return writeJson(res, 200, source);
        if (IMPORT_ID.test(id)) throw new AppError(404, '가져온 문서를 찾을 수 없습니다.');
        return writeJson(res, 200, await nrc(owner).document(requireMl(id)));
      }
      if (method === 'GET' && path === '/api/analysis') {
        const ml = requireDocumentId(url.searchParams.get('ml'));
        return writeJson(res, 200, all('SELECT id, mode, question, state, provider, created FROM analyses WHERE owner = ? AND ml = ? ORDER BY created DESC LIMIT 12', owner, ml));
      }
      if (method === 'GET' && path.startsWith('/api/analysis/')) {
        return writeJson(res, 200, analysisRow(owner, path.split('/').at(-1)));
      }
      if (method === 'POST' && path === '/api/analysis') {
        const input = await json(req);
        const ml = requireDocumentId(input.ml);
        const mode = input.mode;
        const question = mode === 'extract' ? field(input.question, 1200) : '';
        const pageRangeText = mode === 'extract' ? field(input.pageRange, 15) : '';
        const pageRange = parsePageRange(pageRangeText);
        const storedRange = pageRange ? `${pageRange.from}-${pageRange.to}` : '';
        if (mode !== 'summary' && (mode !== 'extract' || !question)) throw new AppError(400, '추출할 정보나 질문을 입력하세요.');
        const modelApi = ai(owner, provider);
        const source = importedSource(owner, ml);
        if (!source && IMPORT_ID.test(ml)) throw new AppError(404, '가져온 문서를 찾을 수 없습니다.');
        const client = source ? null : nrc(owner);
        const existing = one(`SELECT id, state FROM analyses WHERE owner = ? AND ml = ? AND mode = ?
          AND question = ? AND provider = ? AND model = ? AND page_range = ? AND input_version = ? ORDER BY created DESC LIMIT 1`,
          owner, ml, mode, question, provider, modelApi.model, storedRange, INPUT_VERSION);
        if (existing && (existing.state === 'working' || (existing.state === 'done' && !input.force))) {
          return writeJson(res, 200, { id: existing.id });
        }
        if (active.has(owner) || active.size >= 4) throw new AppError(429, '분석이 진행 중입니다. 완료 후 다시 시도하세요.');
        const id = randomUUID();
        run("INSERT INTO analyses(id, owner, ml, mode, question, provider, model, state, created, page_range, stage, input_version) VALUES(?, ?, ?, ?, ?, ?, ?, 'working', ?, ?, 'downloading', ?)",
          id, owner, ml, mode, question, provider, modelApi.model, Date.now(), storedRange, INPUT_VERSION);
        active.add(owner);
        void job(id, owner, ml, mode, question, pageRange, source, client, modelApi.client);
        return writeJson(res, 202, { id });
      }
      if (method === 'GET' && path === '/api/library') return writeJson(res, 200, library(owner));
      if (method === 'POST' && path === '/api/library') {
        const input = await json(req);
        const record = analysisRow(owner, field(input.id, 40));
        if (record.state !== 'done' || !Array.isArray(input.rows) || !input.rows.length || input.rows.length > 20 ||
          input.rows.some(index => !Number.isInteger(index) || !record.items[index] || record.items[index].status !== 'found')) {
          throw new AppError(400, '저장하거나 제거할 항목을 확인하세요.');
        }
        if (!['save', 'delete'].includes(input.action)) throw new AppError(400, '지원하지 않는 보관함 작업입니다.');
        db.exec('BEGIN');
        try {
          for (const index of input.rows) {
            if (input.action === 'delete') run('DELETE FROM saved WHERE owner = ? AND analysis = ? AND row_number = ?', owner, record.id, index);
            else run('INSERT INTO saved VALUES(?, ?, ?, ?) ON CONFLICT DO NOTHING', owner, record.id, index, Date.now());
          }
          db.exec('COMMIT');
        } catch (error) {
          db.exec('ROLLBACK');
          throw error;
        }
        return writeJson(res, 200, {});
      }
      throw new AppError(404, '페이지를 찾을 수 없습니다.');
    } catch (error) {
      if (res.headersSent) return res.destroy();
      writeJson(res, error instanceof AppError ? error.status : 500, {
        error: error instanceof AppError ? error.message : '서버에서 요청을 처리하지 못했습니다.',
      });
    }
  });
  server.once('listening', () => {
    run("UPDATE analyses SET state = 'failed', error = '서버가 다시 시작되었습니다. 분석을 다시 실행하세요.' WHERE state = 'working'");
  });
  return server;
}

async function start() {
  const host = process.env.ADAMS_HOST || '127.0.0.1';
  const port = Number(process.env.ADAMS_PORT || 4317);
  const originValue = process.env.ADAMS_ORIGIN;
  const origin = originValue ? new URL(originValue).origin : undefined;
  const invite = process.env.ADAMS_INVITE_CODE?.trim();
  const trustProxy = process.env.ADAMS_TRUST_PROXY === '1';
  const master = process.env.ADAMS_MASTER_KEY?.trim();
  if ((origin && !origin.startsWith('https:')) ||
      ((origin || host !== '127.0.0.1') && (!origin || !master || !invite || invite.length < 12))) {
    throw new Error('공유 환경에는 HTTPS ADAMS_ORIGIN, ADAMS_MASTER_KEY 및 12자 이상의 ADAMS_INVITE_CODE가 필요합니다.');
  }
  if (master && !/^[a-fA-F0-9]{64}$/.test(master)) throw new Error('ADAMS_MASTER_KEY에는 64자리 16진수 키가 필요합니다.');
  const data = resolve(project, process.env.ADAMS_DATA_DIR || '.data');
  await mkdir(data, { recursive: true });
  const keyFile = resolve(data, 'master.key');
  if (!master) {
    await writeFile(keyFile, randomBytes(32), { flag: 'wx', mode: 0o600 }).catch(error => {
      if (error.code !== 'EEXIST') throw error;
    });
  }
  const encryptionKey = master ? Buffer.from(master, 'hex') : await readFile(keyFile);
  if (encryptionKey.length !== 32) throw new Error('암호화 키를 읽을 수 없습니다.');
  // Hold the lock on a separate database so normal analysis writes remain available.
  const instance = new DatabaseSync(resolve(data, 'instance.sqlite'));
  try {
    instance.exec('BEGIN EXCLUSIVE');
  } catch (error) {
    instance.close();
    if (error.errcode === 5 || error.errcode === 6) throw new Error('이 데이터 폴더를 사용하는 ADAMS 서버가 이미 실행 중입니다.');
    throw error;
  }
  const db = new DatabaseSync(resolve(data, 'adams.sqlite'));
  // Without ADAMS_ORIGIN the server only listens on 127.0.0.1 (checked above), so it can skip sign-in.
  const server = createApp({ db, encryptionKey, origin, invite, trustProxy, localAccess: !origin });
  server.once('close', () => instance.close());
  server.listen(port, host, () => process.stdout.write(`ADAMS 문서 분석 · http://${host}:${server.address().port}\n`));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await start();
