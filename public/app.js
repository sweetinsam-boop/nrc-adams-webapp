const $ = id => document.getElementById(id);
const providers = {
  nrc: ['NRC ADAMS', 'APS 구독 키', 'https://adams-api-developer.nrc.gov/profile'],
  gemini: ['Google Gemini', 'Google AI Studio API 키', 'https://aistudio.google.com/apikey'],
  openai: ['OpenAI', 'OpenAI Platform API 키', 'https://platform.openai.com/api-keys'],
  claude: ['Anthropic Claude', 'Claude Console API 키', 'https://platform.claude.com/settings/keys'],
};
const state = { session: 0, view: 'search', mode: 'summary', docs: [], resultsLoaded: false, analysisToken: 0, documentToken: 0,
  previewRequest: null, previewPage: 1, previewTotal: null, previewObject: null };
let authMode = 'login';
let inviteRequired = false;
let localAccess = false;
let searchToken = 0;
let accountCheck = 0;
const authEvent = 'adams-account-change';

function el(tag, content, className) {
  const node = document.createElement(tag);
  if (content != null) node.textContent = content;
  if (className) node.className = className;
  return node;
}

function button(label, callback, className) {
  const node = el('button', label, className);
  node.type = 'button';
  node.addEventListener('click', () => busy(node, callback));
  return node;
}

function link(label, href) {
  const node = el('a', label);
  node.href = href;
  node.target = '_blank';
  node.rel = 'noreferrer';
  return node;
}

async function accountFetch(path, options = {}) {
  if (!state.accountId) throw new Error('로그인이 필요합니다.');
  const current = state.session;
  const response = await fetch(path, {
    ...options, headers: { ...options.headers, 'X-ADAMS-Account': state.accountId },
  });
  if (current !== state.session) throw new Error('로그인 계정이 변경되었습니다.');
  if (response.status === 401 || response.status === 412) {
    await response.body?.cancel();
    await syncAccount();
    throw new Error('현재 로그인 계정을 확인한 뒤 다시 시도하세요.');
  }
  return response;
}

async function api(path, data) {
  const send = ['/api/me', '/api/login', '/api/signup'].includes(path) ? fetch : accountFetch;
  const response = await send(path, data === undefined ? undefined : {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data),
  });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || '요청을 처리하지 못했습니다.');
  return body;
}

async function uploadPdf(form) {
  const data = new FormData(form);
  const file = data.get('pdf');
  if (!(file instanceof File) || !file.size) throw new Error('PDF 파일을 선택하세요.');
  if (file.size > 96 * 1024 * 1024) throw new Error('PDF는 최대 96 MB까지 올릴 수 있습니다.');
  const accession = String(data.get('accession')).trim().toUpperCase();
  if (accession && !/^ML\d{5}[A-Z0-9]\d{3}$/.test(accession)) throw new Error('ML 번호를 확인하세요.');
  const response = await accountFetch('/api/upload', { method: 'POST', body: file, headers: {
    'Content-Type': 'application/pdf', 'X-Document-Name': encodeURIComponent(file.name.slice(0, 250)), 'X-ADAMS-Accession': accession,
  } });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || 'PDF를 올리지 못했습니다.');
  return result;
}

function notice(message = '', error = false) {
  $('notice').hidden = !message;
  $('notice').textContent = message;
  $('notice').classList.toggle('error', error);
}

async function busy(control, task, onError = error => notice(error.message, true)) {
  if (control.disabled) return;
  control.disabled = true;
  const session = state.session;
  try { await task(); } catch (error) {
    if (state.session === session) onError(error);
  } finally {
    control.disabled = false;
  }
}

function authTab(mode) {
  authMode = mode;
  const signup = mode === 'signup';
  $('login-tab').setAttribute('aria-pressed', !signup);
  $('signup-tab').setAttribute('aria-pressed', signup);
  $('invite-field').hidden = !(signup && inviteRequired);
  $('invite-field').querySelector('input').required = signup && inviteRequired;
  $('auth-form').elements.password.autocomplete = signup ? 'new-password' : 'current-password';
  $('auth-submit').textContent = signup ? '계정 만들기' : '로그인';
  $('auth-message').textContent = '';
}

function resetWorkspace() {
  Object.assign(state, {
    session: state.session + 1, documentToken: state.documentToken + 1, analysisToken: state.analysisToken + 1,
    docs: [], resultsLoaded: false, next: null, search: null, publicSearch: null, searchPlan: null, searchWarnings: [],
    doc: null, settings: null, library: [], record: null, history: [], geminiModels: null, geminiLoading: false, geminiError: '',
    modelsVersion: 0,
  });
  searchToken++;
  $('search-form').reset();
  $('public-form').reset();
  $('upload-form').reset();
  $('import-panel').open = false;
  $('uploads-panel').open = false;
  $('analysis-form').reset();
  $('library-query').value = '';
  for (const id of ['credentials', 'library-items', 'upload-list', 'analysis-results', 'package', 'history']) $(id).replaceChildren();
  $('upload-usage').textContent = '';
  resetPreview();
  $('doc-source').removeAttribute('href');
  $('notebook-tools').hidden = true;
  $('notebook-pdf').removeAttribute('href');
  $('preview-link').removeAttribute('href');
  $('doc-title').textContent = '';
  $('doc-meta').textContent = '';
  $('pdf-page').textContent = '';
  showSearch();
}

async function session({ email, accountId }) {
  accountCheck++;
  resetWorkspace();
  state.accountId = accountId;
  notice();
  $('session').hidden = !email;
  $('auth').hidden = Boolean(email);
  $('workspace').hidden = !email;
  $('email').textContent = localAccess ? '로컬 모드' : email || '';
  $('logout').hidden = localAccess;
  if (!email) {
    authTab('login');
    return;
  }
  const current = state.session;
  const settings = await api('/api/settings');
  if (current !== state.session) return;
  state.settings = settings;
  $('search-form').elements.public.checked = !settings.keys.nrc;
  await view('search');
}

async function syncAccount() {
  const version = ++accountCheck;
  const account = await api('/api/me');
  if (version !== accountCheck) return;
  inviteRequired = account.inviteRequired;
  localAccess = account.local === true;
  if (state.accountId !== account.accountId) await session(account);
}

function publishAccountChange() {
  try { localStorage.setItem(authEvent, crypto.randomUUID()); } catch { /* Focus and request checks still apply. */ }
}

function refreshAccount() {
  void syncAccount().catch(error => notice(error.message, true));
}
window.addEventListener('storage', event => {
  if (event.key === authEvent) {
    void session({ email: null, accountId: null });
    refreshAccount();
  }
});
window.addEventListener('pageshow', event => { if (event.persisted) refreshAccount(); });
document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshAccount(); });

async function view(name) {
  if (state.view === 'document' && name !== 'document') resetPreview();
  state.view = name;
  if (name !== 'document') {
    state.analysisToken++;
    state.documentToken++;
  }
  notice();
  for (const section of ['search', 'document', 'library', 'settings']) $(`${section}-view`).hidden = section !== name;
  for (const control of document.querySelectorAll('[data-view]')) {
    if (control.dataset.view === (name === 'document' ? 'search' : name)) control.setAttribute('aria-current', 'page');
    else control.removeAttribute('aria-current');
  }
  const current = state.session;
  if (name === 'library') {
    const [items, uploads] = await Promise.all([api('/api/library'), api('/api/uploads')]);
    if (state.view !== 'library' || current !== state.session) return;
    state.library = items;
    showUploads(uploads);
    showLibrary();
  }
  if (name === 'settings') showSettings();
  window.scrollTo(0, 0);
}

function updateGeminiMenu(selected) {
  const menu = $('gemini-model');
  const feedback = $('gemini-model-status');
  if (!menu || !feedback) return;
  const value = selected || menu.value || state.settings.keys.gemini?.model || state.settings.models.gemini;
  const available = (state.geminiModels ?? []).filter(({ id }) =>
    !/-(?:tts|image)(?:-|$)|^(?:gemini-omni|veo|imagen)/i.test(id));
  const options = available.map(({ id, label }) => {
    const option = el('option', label === id ? id : `${label} (${id})`);
    option.value = id;
    return option;
  });
  if (!available.some(model => model.id === value)) {
    const current = el('option', `${value}${state.geminiModels ? ' (현재 설정)' : ''}`);
    current.value = value;
    options.unshift(current);
  }
  menu.replaceChildren(...options);
  menu.value = value;
  feedback.textContent = state.geminiLoading ? 'Google에서 모델 목록을 불러오는 중입니다.'
    : state.geminiError || (state.geminiModels ? `Google에서 받은 문서 분석용 후보 ${available.length}개. 선택 후 저장하고 연결을 확인하세요.`
      : '키를 저장하면 Google에서 선택 가능한 모델을 불러옵니다.');
}

async function refreshGeminiModels() {
  if (!state.settings?.keys.gemini || state.geminiLoading) return;
  const sessionId = state.session;
  const version = ++state.modelsVersion;
  state.geminiLoading = true;
  state.geminiError = '';
  updateGeminiMenu();
  try {
    const { models } = await api('/api/models/gemini');
    if (sessionId === state.session && version === state.modelsVersion) state.geminiModels = models;
  } catch (error) {
    if (sessionId === state.session && version === state.modelsVersion) state.geminiError = error.message;
  } finally {
    if (sessionId === state.session && version === state.modelsVersion) {
      state.geminiLoading = false;
      updateGeminiMenu();
    }
  }
}

function clearGeminiModels() {
  state.modelsVersion++;
  state.geminiModels = null;
  state.geminiLoading = false;
  state.geminiError = '';
}

function showSettings() {
  if (!state.settings) return;
  const { provider, keys, models } = state.settings;
  $('provider').value = provider;
  $('credentials').replaceChildren(...Object.entries(providers).map(([id, [name, keyLabel, url]]) => {
    const existing = keys[id];
    const card = el('section', null, 'panel credential');
    const heading = el('div', null, 'row-head');
    heading.append(el('h2', name), el('span', existing ? '저장됨' : '미설정', existing ? 'chip ok' : 'chip'));
    const form = el('form');
    const key = el('input');
    key.type = 'password';
    key.placeholder = existing ? '교체할 때만 입력' : '키 입력';
    key.autocomplete = 'off';
    key.maxLength = 500;
    const label = el('label', keyLabel);
    label.append(key);
    form.append(label);
    let model;
    if (id === 'gemini') {
      model = el('select');
      model.id = 'gemini-model';
      const area = el('div', null, 'model-controls');
      const label = el('label', 'Gemini 모델');
      label.append(model);
      const feedback = el('p', null, 'metadata');
      feedback.id = 'gemini-model-status';
      feedback.setAttribute('role', 'status');
      area.append(label, feedback);
      if (existing) area.append(button('모델 목록 새로고침', refreshGeminiModels, 'quiet'));
      form.append(area);
    } else if (id !== 'nrc') {
      model = el('input');
      model.value = existing?.model || models[id];
      model.maxLength = 100;
      const modelLabel = el('label', '모델 ID');
      modelLabel.append(model);
      form.append(modelLabel);
    }
    const actions = el('div', null, 'actions');
    const save = el('button', '저장', 'primary');
    actions.append(save);
    if (existing) {
      actions.append(button('연결 확인', async () => {
        const current = state.session;
        notice(`${name} 연결을 확인하는 중입니다.`);
        const result = await api('/api/check', { provider: id });
        if (current === state.session) notice(result.model
          ? `${result.model} 생성 성공 · ${(result.elapsedMs / 1000).toFixed(1)}초`
          : `${name} 연결을 확인했습니다.`);
      }), button('키 삭제', async () => {
        const current = state.session;
        const settings = await api('/api/settings', { action: 'delete', provider: id });
        if (current !== state.session) return;
        state.settings = settings;
        if (id === 'nrc') $('search-form').elements.public.checked = true;
        if (id === 'gemini') clearGeminiModels();
        showSettings();
        notice(`${name} 키를 삭제했습니다.`);
      }, 'quiet danger'));
    }
    form.append(actions);
    form.addEventListener('submit', event => {
      event.preventDefault();
      void busy(save, async () => {
        const current = state.session;
        const settings = await api('/api/settings', { action: 'save', provider: id, key: key.value, model: model?.value });
        if (current !== state.session) return;
        state.settings = settings;
        if (id === 'nrc' && !existing) $('search-form').elements.public.checked = false;
        if (id === 'gemini' && key.value) clearGeminiModels();
        key.value = '';
        showSettings();
        notice(`${name} 설정을 저장했습니다.`);
      });
    });
    card.append(heading, form, link('키 발급·관리 ↗', url));
    return card;
  }));
  updateGeminiMenu(keys.gemini?.model || models.gemini);
  if (keys.gemini && !state.geminiModels && !state.geminiLoading && !state.geminiError) void refreshGeminiModels();
}

function docCard(doc) {
  const card = el('article', null, 'panel doc-card');
  const main = el('div');
  main.append(el('p', [doc.accession ?? doc.id, doc.date, ...doc.types, doc.uploaded && '업로드한 PDF', doc.package && '패키지', doc.legacy && 'Legacy'].filter(Boolean).join(' · '), 'metadata'));
  main.append(button(doc.title, async () => { await openDocument(doc); }, 'doc-link'));
  if (doc.docket.length) main.append(el('p', `Docket ${doc.docket.join(', ')}`, 'metadata'));
  card.append(main);
  if (doc.url) card.append(link('원문 ↗', doc.url));
  return card;
}

function showSearch() {
  const items = state.searchWarnings.map(warning => el('p', warning, 'notice'));
  if (state.searchPlan) {
    const { intent, queries } = state.searchPlan;
    const card = el('section', null, 'panel search-plan');
    card.append(el('h3', 'AI가 파악한 검색 의도'), el('p', intent));
    const details = el('details');
    details.open = Boolean(state.publicSearch);
    details.append(el('summary', `검색식 ${queries.length}개`));
    const list = el('ol', null, 'search-queries');
    for (const { query, type, from, to, publicLink } of queries) {
      const item = el('li');
      item.append(state.publicSearch ? link(`${query} ↗`, publicLink) : el('span', query));
      const metadata = [type, (from || to) && `작성일 ${from || '시작 제한 없음'} ~ ${to || '종료 제한 없음'}`].filter(Boolean);
      if (metadata.length) item.append(el('div', metadata.join(' · '), 'metadata'));
      list.append(item);
    }
    details.append(list);
    card.append(details);
    items.push(card);
  }
  if (state.publicSearch) {
    const card = el('div', null, 'empty public-results');
    card.append(el('p', 'NRC 공개 검색에서 결과를 확인한 뒤, ML 번호 또는 PDF를 가져오세요.'));
    const actions = el('div', null, 'actions');
    if (!state.searchPlan) actions.append(link('NRC 공개 검색 결과 열기 ↗', state.publicSearch.publicLink));
    actions.append(button('PDF 가져오기', () => {
      $('import-panel').open = true;
      $('public-form').elements.source.focus();
    }, 'quiet'));
    card.append(actions);
    items.push(card);
  }
  if (state.docs.length) {
    items.push(...state.docs.map(docCard));
  } else if (!state.publicSearch) {
    items.push(el('p', state.resultsLoaded ? '조건에 맞는 문서가 없습니다. 검색어 또는 필터를 확인하세요.' : '검색 결과가 여기에 표시됩니다.', 'empty'));
  }
  $('search-results').replaceChildren(...items);
  $('more').hidden = state.next == null;
}

async function search(input, append = false) {
  const stamp = ++searchToken;
  const smart = input.smart && input.q?.trim() && !/^ML\d{5}[A-Z0-9]\d{3}$/i.test(input.q.trim());
  notice(smart && !append ? 'AI가 검색 의도를 파악하고 NRC 검색식을 만드는 중입니다.' : 'NRC ADAMS에서 검색하는 중입니다.');
  const data = await api('/api/search', input);
  if (stamp !== searchToken) return;
  state.search = input;
  state.publicSearch = data.publicLink ? data : null;
  state.searchPlan = data.plan ?? (append ? state.searchPlan : null);
  state.searchWarnings = data.warnings ?? [];
  state.resultsLoaded = true;
  const union = [...(append ? state.docs : []), ...data.documents];
  state.docs = [...new Map(union.map(doc => [doc.id, doc])).values()];
  state.next = data.next;
  showSearch();
  if (state.view === 'search') notice();
}

function pdfUrl(id, page) {
  const url = new URL(`/api/pdf/${encodeURIComponent(id)}`, location.origin);
  url.hash = page ? `page=${page}` : '';
  return url;
}

function resetPreview() {
  state.previewRequest?.abort();
  state.previewRequest = null;
  state.previewPage = 1;
  state.previewTotal = null;
  if (state.previewObject) URL.revokeObjectURL(state.previewObject);
  state.previewObject = null;
  $('pdf-preview').querySelector('img')?.remove();
  $('retry-preview').hidden = true;
  $('retry-preview').onclick = null;
  $('preview-status').hidden = true;
  $('preview-controls').hidden = true;
}

async function sourcePage(page) {
  state.previewRequest?.abort();
  const request = new AbortController();
  state.previewRequest = request;
  const id = state.doc.id;
  $('retry-preview').hidden = true;
  $('preview-status').hidden = false;
  $('preview-status').textContent = `PDF ${page}쪽을 불러오는 중입니다.`;
  $('preview-prev').disabled = true;
  $('preview-next').disabled = true;
  try {
    const response = await accountFetch(`/api/pdf-page/${encodeURIComponent(id)}/${page}`, { signal: request.signal });
    if (!response.ok) throw new Error((await response.json()).error || 'PDF 미리보기를 열 수 없습니다.');
    const data = await response.blob();
    if (request.signal.aborted) return;
    state.previewPage = page;
    state.previewTotal = Number(response.headers.get('x-pdf-page-count')) || null;
    if (state.previewObject) URL.revokeObjectURL(state.previewObject);
    state.previewObject = URL.createObjectURL(data);
    const preview = el('img');
    preview.alt = `원문 PDF ${page}쪽`;
    preview.src = state.previewObject;
    $('pdf-preview').querySelector('img')?.remove();
    $('pdf-preview').append(preview);
    $('preview-link').href = pdfUrl(id, page).href;
    $('pdf-page').textContent = state.previewTotal ? `${page} / ${state.previewTotal}쪽` : `PDF ${page}쪽`;
    $('preview-controls').hidden = false;
    $('preview-status').hidden = true;
  } catch (error) {
    if (request.signal.aborted) return;
    $('preview-status').textContent = error.message;
    $('retry-preview').hidden = false;
    $('retry-preview').onclick = () => { void sourcePage(page); };
  } finally {
    if (state.previewRequest === request) {
      state.previewRequest = null;
      $('preview-prev').disabled = state.previewPage <= 1;
      $('preview-next').disabled = !state.previewTotal || state.previewPage >= state.previewTotal;
    }
  }
}

function showDocumentSource(doc) {
  $('doc-source').hidden = !doc.url;
  $('doc-source').textContent = doc.uploaded ? '업로드한 PDF 열기 ↗' : 'NRC 원문 열기 ↗';
  if (doc.url) $('doc-source').href = doc.url;
  else $('doc-source').removeAttribute('href');
  $('preview-link').href = pdfUrl(doc.id).href;
  $('workbench').hidden = doc.package || !doc.url;
  $('notebook-tools').hidden = $('workbench').hidden;
  if (!$('notebook-tools').hidden) {
    const download = $('notebook-pdf');
    download.href = pdfUrl(doc.id).href;
    const filename = doc.accession || (doc.id.startsWith('PDF-') ? doc.title : doc.id);
    download.download = filename.replace(/\.pdf$/i, '') + '.pdf';
  } else $('notebook-pdf').removeAttribute('href');
}

async function openDocument(doc) {
  const version = ++state.documentToken;
  state.analysisToken++;
  state.doc = doc;
  state.record = null;
  state.history = [];
  $('doc-title').textContent = doc.title;
  $('doc-meta').textContent = [doc.accession || doc.id, doc.date, ...doc.types, ...doc.docket].filter(Boolean).join(' · ');
  resetPreview();
  $('pdf-page').textContent = '';
  showDocumentSource(doc);
  $('package').replaceChildren();
  $('question').value = '';
  $('analysis-range').value = '';
  setMode('summary');
  showHistory();
  await view('document');
  if (version !== state.documentToken) return;
  if (doc.package) {
    const detailed = doc.members.length ? doc : await api(`/api/document/${doc.id}`);
    if (version !== state.documentToken) return;
    const card = el('section', null, 'panel doc-card');
    const inner = el('div');
    inner.append(el('h2', '패키지 구성 문서'));
    if (detailed.members.length) {
      const members = el('div', null, 'actions');
      members.append(...detailed.members.map(id => button(id, async () => {
        const member = await api(`/api/document/${id}`);
        if (version === state.documentToken) await openDocument(member);
      })));
      inner.append(members);
    } else inner.append(el('p', '구성 문서 목록이 제공되지 않았습니다. NRC에서 패키지를 열어 확인하세요.'));
    card.append(inner);
    $('package').append(card);
    return;
  }
  if (!doc.url) {
    if (!/^ML\d{5}[A-Z0-9]\d{3}$/.test(doc.id)) {
      $('package').append(el('p', '내려받을 수 있는 원문 PDF가 없습니다.', 'empty'));
      return;
    }
    $('package').append(el('p', 'ML 번호로 NRC 공개 원문을 찾는 중입니다.', 'metadata'));
    try {
      const resolved = await api('/api/import', { source: doc.id, includeMetadata: true });
      if (version !== state.documentToken) return;
      state.doc = { ...doc, url: resolved.url };
      state.docs = state.docs.map(item => item.id === doc.id ? state.doc : item);
      showDocumentSource(state.doc);
      $('package').replaceChildren();
    } catch (error) {
      if (version !== state.documentToken) return;
      $('package').replaceChildren(el('p', error.message, 'notice'), button('공개 원문 다시 찾기', () => openDocument(doc)));
      return;
    }
  }
  void sourcePage(1);
  const analysisVersion = state.analysisToken;
  await loadHistory(version);
  if (version === state.documentToken && analysisVersion === state.analysisToken && !state.record) {
    const summary = state.history.find(record => record.mode === 'summary');
    if (summary) await loadAnalysis(summary.id);
  }
}

function setMode(mode, clear = true) {
  state.mode = mode;
  $('summary-tab').setAttribute('aria-pressed', mode === 'summary');
  $('extract-tab').setAttribute('aria-pressed', mode === 'extract');
  $('question-label').hidden = mode !== 'extract';
  $('analysis-range-label').hidden = mode !== 'extract';
  $('question').required = mode === 'extract';
  $('run-analysis').textContent = mode === 'summary' ? '요약 생성' : '맞춤 추출';
  if (clear) {
    state.analysisToken++;
    state.record = null;
    $('history').value = '';
    renderAnalysis();
  }
}

function showHistory() {
  const menu = $('history');
  const blank = el('option', '기록 선택');
  blank.value = '';
  menu.replaceChildren(blank, ...state.history.map(record => {
    const date = new Date(record.created).toLocaleString('ko-KR', { dateStyle: 'short', timeStyle: 'short' });
    const option = el('option', `${date} · ${record.mode === 'summary' ? '요약' : record.question.slice(0, 35)} · ${providers[record.provider][0]}`);
    option.value = record.id;
    return option;
  }));
  $('history-label').hidden = !state.history.length;
  if (state.record) menu.value = state.record.id;
}

async function loadHistory(version) {
  const history = await api(`/api/analysis?ml=${state.doc.id}`);
  if (version !== state.documentToken) return;
  state.history = history;
  showHistory();
}

function pair(english, korean, enLabel = 'English', koLabel = '한국어') {
  const block = el('div', null, 'pair');
  for (const [lang, name, content] of [['en', enLabel, english], ['ko', koLabel, korean]]) {
    if (!content) continue;
    const column = el('div');
    const value = el('p', content);
    value.lang = lang;
    column.append(el('span', name, 'language'), value);
    block.append(column);
  }
  return block;
}

function sameQuote(value, quote) {
  const normalize = text => (text || '').normalize('NFC').replace(/\s+/gu, ' ').trim()
    .replace(/^(?:"(.*)"|“(.*)”)$/u, (_, straight, curly) => straight ?? curly).trim();
  return Boolean(quote?.trim()) && normalize(value) === normalize(quote);
}

function resultCard(item, pageAction, selection, partial = false) {
  const card = el('article', null, 'finding');
  const head = el('div', null, 'row-head');
  const title = el('div');
  title.append(el('h3', item.labelKo), el('p', item.labelEn, 'metadata'));
  head.append(title);
  if (selection) head.append(selection);
  card.append(head);
  if (item.status === 'missing') {
    card.append(el('p', partial ? '분석한 페이지에서 확인되지 않음 · Not found in the analyzed pages'
      : '문서에서 확인되지 않음 · Not found in the document', 'muted'));
    return card;
  }
  const sameEn = sameQuote(item.english, item.quoteEn);
  const sameKo = sameQuote(item.korean, item.quoteKo);
  card.append(pair(item.english, item.korean, sameEn ? 'English · 인용문' : 'English', sameKo ? '한국어 · 인용문 번역' : '한국어'));
  const quoteEn = sameEn ? '' : item.quoteEn;
  const quoteKo = sameKo ? '' : item.quoteKo;
  if (quoteEn || quoteKo) {
    const evidence = el('details', null, 'evidence');
    evidence.append(el('summary', quoteEn ? '근거 인용문 보기' : '인용문 번역 보기'), pair(quoteEn, quoteKo, '영문 인용문', '인용문 번역'));
    card.append(evidence);
  }
  const source = el('div', null, 'actions');
  source.append(el('span', item.evidence === 'matched' ? '영문 인용 · PDF 텍스트 일치' : '영문 인용 · PDF 대조 필요', 'metadata'));
  if (item.page) source.append(pageAction(item.page));
  card.append(source);
  return card;
}

function describeScope(scope) {
  if (!scope) return '';
  if (scope.kind === 'full') return scope.total ? `전체 PDF · ${scope.total}쪽` : '전체 PDF';
  const labels = { overview: '개요 요약', targeted: '질문 관련 페이지', range: '지정한 페이지', sample: '표본 페이지 · 관련 위치를 자동 확인하지 못함' };
  const runs = [];
  for (const page of scope.pages) {
    const last = runs.at(-1);
    if (last && last[1] + 1 === page) last[1] = page;
    else runs.push([page, page]);
  }
  const pages = runs.map(([from, to]) => from === to ? from : `${from}–${to}`).join(', ');
  return `${labels[scope.kind]} · 전체 ${scope.total}쪽 중 PDF ${pages}쪽 분석`;
}

function renderAnalysis() {
  const root = $('analysis-results');
  const record = state.record;
  $('rerun').hidden = !record || record.state === 'working';
  root.replaceChildren();
  if (!record || record.state === 'working') {
    const stages = { downloading: 'NRC에서 PDF 가져오는 중', reading: 'PDF 쪽수와 원문 텍스트 읽는 중',
      selecting: '질문과 관련된 PDF 페이지 찾는 중', generating: 'AI가 한영 결과와 원문 근거를 작성하는 중' };
    const elapsed = record ? Math.max(0, Math.floor((Date.now() - record.created) / 1000)) : 0;
    root.append(el('p', record ? `${stages[record.stage] || '문서 분석 중'} · ${elapsed}초` : '이 문서의 요약을 만들거나 추출할 항목을 지정하세요.', 'empty'));
    return;
  }
  if (record.state === 'failed') {
    root.append(el('p', record.error, 'notice error'));
    return;
  }
  const rows = [];
  if (record.previousInput) root.append(el('p', '이전 PDF 처리 방식으로 만든 결과입니다. 최신 방식으로 확인하려면 다시 분석을 누르세요.', 'notice'));
  root.append(el('p', `${providers[record.provider][0]} · ${record.model}`, 'metadata'));
  const scope = record.source?.analysisScope;
  const description = describeScope(scope);
  if (description) root.append(el('p', description, scope.pages ? 'notice' : 'metadata'));
  record.items.forEach((item, index) => {
    let selection;
    if (item.status === 'found') {
      const box = el('input');
      box.type = 'checkbox';
      rows.push([index, box]);
      selection = el('label', '선택', 'checkbox');
      selection.prepend(box);
    }
    root.append(resultCard(item, page => button(`PDF ${page}쪽 확인`, () => sourcePage(page), 'quiet'), selection, Boolean(scope?.pages)));
  });
  if (rows.length) root.append(button('선택 항목 저장', async () => {
    const chosen = rows.filter(([, box]) => box.checked).map(([index]) => index);
    if (!chosen.length) return notice('저장할 항목을 선택하세요.', true);
    const current = state.session;
    await api('/api/library', { id: record.id, action: 'save', rows: chosen });
    if (current !== state.session) return;
    rows.forEach(([, box]) => { box.checked = false; });
    notice(`${chosen.length}개 항목을 보관함에 저장했습니다.`);
  }, 'primary'));
}

async function loadAnalysis(id) {
  const token = ++state.analysisToken;
  let first = true;
  for (;;) {
    const record = await api(`/api/analysis/${id}`);
    if (token !== state.analysisToken) return;
    if (first) {
      setMode(record.mode, false);
      $('question').value = record.question;
      $('analysis-range').value = record.pageRange || '';
      first = false;
    }
    state.record = record;
    $('history').value = id;
    renderAnalysis();
    if (record.state !== 'working') return;
    await new Promise(resolve => setTimeout(resolve, 1500));
    if (token !== state.analysisToken) return;
  }
}

async function runAnalysis(force) {
  const version = state.documentToken;
  const { id } = await api('/api/analysis', { ml: state.doc.id, mode: state.mode, question: $('question').value,
    pageRange: $('analysis-range').value, force });
  if (state.documentToken !== version) return;
  notice();
  await loadHistory(version);
  if (state.documentToken === version) await loadAnalysis(id);
}

function libraryItems() {
  const query = $('library-query').value.trim().toLowerCase();
  return state.library.filter(({ ml, item, source }) => [ml, source.accession, source.title, item.labelKo, item.labelEn, item.korean, item.english]
    .some(value => typeof value === 'string' && value.toLowerCase().includes(query)));
}

function showUploads({ documents, usedBytes, limitBytes }) {
  const size = bytes => bytes < 1024 * 1024 ? `${Math.ceil(bytes / 1024)} KB` : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  $('upload-usage').textContent = `${size(usedBytes)} / ${size(limitBytes)} 사용 중 · 원본 PDF를 삭제해도 저장한 요약과 인용은 보관됩니다.`;
  const rows = documents.map(doc => {
    const row = el('div', null, 'upload-row');
    const info = el('div');
    info.append(button(doc.title, () => openDocument(doc), 'doc-link'), el('p', [doc.accession, size(doc.bytes)].filter(Boolean).join(' · '), 'metadata'));
    row.append(info, button('원본 삭제', async () => {
      if (!window.confirm(`‘${doc.title}’ 원본 PDF를 삭제할까요? 저장한 분석 결과는 보관됩니다.`)) return;
      const current = state.session;
      await api('/api/uploads', { action: 'delete', id: doc.id });
      if (current !== state.session) return;
      state.docs = state.docs.filter(item => item.id !== doc.id);
      showSearch();
      if (state.view === 'library') {
        await view('library');
        if (state.session === current && state.view === 'library') notice('원본 PDF를 삭제했습니다.');
      }
    }, 'quiet danger'));
    return row;
  });
  $('upload-list').replaceChildren(...(rows.length ? rows : [el('p', '업로드한 PDF가 없습니다.', 'metadata')]));
}

function showLibrary() {
  const items = libraryItems();
  $('csv').disabled = !items.length;
  $('library-items').replaceChildren(...(items.length ? items.map(({ id, idx, item, source, previousInput }) => {
    const card = el('section', null, 'panel library-card');
    const remove = button('보관함에서 제거', async () => {
      const current = state.session;
      await api('/api/library', { id, action: 'delete', rows: [idx] });
      if (current === state.session) await view('library');
    }, 'quiet danger');
    const head = el('div', null, 'row-head');
    const title = [source.accession || source.id, source.title].filter(Boolean).join(' · ');
    head.append(source.available === false ? el('span', `${title} · 원본 삭제됨`) : link(`${title} ↗`, source.url), remove);
    card.append(head);
    if (previousInput) card.append(el('p', '이전 PDF 처리 방식으로 분석한 기록', 'metadata'));
    card.append(resultCard(item, page => {
      return source.available === false ? el('span', `PDF ${page}쪽`, 'metadata') : link(`PDF ${page}쪽 ↗`, pdfUrl(source.id, page).href);
    }));
    return card;
  }) : [el('p', state.library.length ? '검색 조건과 일치하는 항목이 없습니다.' : '저장한 항목이 없습니다.', 'empty')]));
}

function downloadCsv() {
  const rows = [
    ['ML 번호', '문서 제목', '항목 (영어)', '항목 (한국어)', '값 (영어)', '값 (한국어)', '근거 (영어)', '근거 (한국어)', 'PDF 페이지', '확인 상태', '원문 URL'],
    ...libraryItems().map(({ item, source }) => [
      source.accession ?? source.id, source.title, item.labelEn, item.labelKo, item.english, item.korean, item.quoteEn, item.quoteKo, item.page ?? '',
      item.evidence === 'matched' ? '인용 대조 완료' : '직접 확인 필요', source.available === false ? '' : new URL(source.url, location.origin).href,
    ]),
  ];
  const cell = value => {
    const text = String(value);
    return `"${/^[\s]*[=+\-@]/.test(text) || /^[\t\r\n]/.test(text) ? "'" : ''}${text.replaceAll('"', '""')}"`;
  };
  const blob = new Blob(['\uFEFF', rows.map(row => row.map(cell).join(',')).join('\r\n')], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = el('a');
  anchor.href = url;
  anchor.download = 'nrc-adams-library.csv';
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

$('login-tab').onclick = () => authTab('login');
$('signup-tab').onclick = () => authTab('signup');
$('auth-form').onsubmit = event => {
  event.preventDefault();
  void busy($('auth-submit'), async () => {
    $('auth-message').textContent = '';
    const account = await api(`/api/${authMode}`, Object.fromEntries(new FormData(event.currentTarget)));
    $('auth-form').reset();
    publishAccountChange();
    await session(account);
  }, error => { $('auth-message').textContent = error.message; });
};
$('logout').onclick = () => busy($('logout'), async () => {
  await api('/api/logout', {});
  publishAccountChange();
  await session({ email: null, accountId: null });
});
for (const control of document.querySelectorAll('[data-view]')) control.onclick = () => busy(control, () => view(control.dataset.view));
$('provider').onchange = () => busy($('provider'), async () => {
  const current = state.session;
  const settings = await api('/api/settings', { action: 'select', provider: $('provider').value });
  if (current !== state.session) return;
  state.settings = settings;
  notice(settings.keys[settings.provider] ? '기본 AI를 저장했습니다.' : '선택한 제공자의 API 키를 입력해 주세요.');
}, error => { $('provider').value = state.settings.provider; notice(error.message, true); });
$('search-form').onsubmit = event => {
  event.preventDefault();
  const form = event.currentTarget;
  const input = Object.fromEntries(new FormData(form));
  void busy(form.querySelector('button.primary'), () => search({ ...input, smart: input.smart === 'on',
    public: input.public === 'on', legacy: input.legacy === 'on' }));
};
$('public-form').onsubmit = event => {
  event.preventDefault();
  const form = event.currentTarget;
  void busy(form.querySelector('button'), async () => {
    const current = state.session;
    const doc = await api('/api/import', { source: form.elements.source.value });
    if (current !== state.session) return;
    form.reset();
    await openDocument(doc);
  });
};
$('upload-form').onsubmit = event => {
  event.preventDefault();
  const form = event.currentTarget;
  void busy(form.querySelector('button'), async () => {
    const current = state.session;
    const doc = await uploadPdf(form);
    if (current !== state.session) return;
    form.reset();
    await openDocument(doc);
  });
};
$('more').onclick = () => busy($('more'), () => search({ ...state.search, skip: state.next }, true));
$('back').onclick = () => view('search');
$('preview-prev').onclick = () => { void sourcePage(state.previewPage - 1); };
$('preview-next').onclick = () => { void sourcePage(state.previewPage + 1); };
$('summary-tab').onclick = () => setMode('summary');
$('extract-tab').onclick = () => setMode('extract');
$('analysis-form').onsubmit = event => {
  event.preventDefault();
  void busy($('run-analysis'), () => runAnalysis(false));
};
$('rerun').onclick = () => { if ($('analysis-form').reportValidity()) void busy($('rerun'), () => runAnalysis(true)); };
$('history').onchange = () => {
  if ($('history').value) void loadAnalysis($('history').value).catch(error => notice(error.message, true));
  else setMode(state.mode);
};
$('library-query').oninput = showLibrary;
$('manage-uploads').onclick = () => busy($('manage-uploads'), async () => {
  $('uploads-panel').open = true;
  await view('library');
});
$('csv').onclick = downloadCsv;

try {
  await syncAccount();
} catch (error) {
  $('auth').hidden = false;
  $('auth-message').textContent = error.message;
}
