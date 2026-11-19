import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { AI_PDF_LIMIT, AppError } from './services.mjs';

const exec = promisify(execFile);
const worker = fileURLToPath(new URL('./pdf_pages.py', import.meta.url));
const stopwords = new Set('a an and about are as at be by do does for from how in is it of on or that the their these this to was were what when where which who will with would document find identify list report specify extract'.split(' '));
const TEXT_LIMIT = 160000;

function pythonCommand() {
  if (process.env.ADAMS_PYTHON) return [process.env.ADAMS_PYTHON];
  const bundled = join(homedir(), '.cache', 'codex-runtimes', 'codex-primary-runtime', 'dependencies', 'python', 'python.exe');
  if (process.platform === 'win32' && existsSync(bundled)) return [bundled];
  return process.platform === 'win32' ? ['py', '-3'] : ['python3'];
}

function invokePdf(...args) {
  const [command, ...prefix] = pythonCommand();
  return exec(command, [...prefix, worker, ...args], { timeout: 45000, windowsHide: true });
}

export function parsePageRange(value) {
  if (!value) return null;
  const range = /^(\d{1,5})(?:\s*[-–]\s*(\d{1,5}))?$/.exec(value);
  const from = Number(range?.[1]);
  const to = Number(range?.[2] ?? range?.[1]);
  if (!range || from < 1 || to < from || to - from >= 36) {
    throw new AppError(400, 'PDF 쪽수를 1부터 입력하세요. 한 번에 최대 36쪽을 선택할 수 있습니다. 예시 121-145');
  }
  return { from, to };
}

export async function renderOriginalPdfPage(pdf, number) {
  const directory = await mkdtemp(join(tmpdir(), 'adams-preview-'));
  try {
    const source = join(directory, 'source.pdf');
    const output = join(directory, 'page.png');
    const metadata = join(directory, 'info.json');
    await writeFile(source, pdf);
    await invokePdf('render', source, output, String(number), metadata);
    const { count } = JSON.parse(await readFile(metadata, 'utf8'));
    if (number > count) throw new AppError(404, `이 PDF는 총 ${count}쪽입니다.`);
    return { count, image: await readFile(output) };
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError(422, '미리보기 페이지를 만들지 못했습니다. 새 탭에서 원문 PDF를 열 수 있습니다.');
  } finally {
    await rm(directory, { recursive: true, force: true }).catch(() => {});
  }
}

const pageNumbers = (from, to) => Array.from({ length: to - from + 1 }, (_, index) => from + index);
const normalize = value => value.toLowerCase().normalize('NFKC').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const textSize = texts => texts.reduce((total, text) => total + text.length, 0);

function useText(texts, question, clipped = []) {
  if (clipped.length || !texts?.length || /(?:표\s*(?:에서|의|에|로|\d)|도면|그래프|그림|차트|스캔|서명)|\b(?:chart|figure|diagram|image|scan|signature|table|column)\b/i.test(question)) return false;
  const readable = texts.filter(text => text.trim().length >= 35).length;
  const size = textSize(texts);
  return readable === texts.length && size >= 100 && size <= TEXT_LIMIT;
}

function overviewPages(texts) {
  const patterns = [/^(?:\d+(?:\.\d+)*\.?\s+)?executive summary\s*$/im,
    /^(?:\d+(?:\.\d+)*\.?\s+)?(?:abstract|summary|overview)\s*$/im];
  const heading = patterns.map(pattern => texts.findIndex((text, index) => index > 0 && pattern.test(text.slice(0, 2600)) &&
    !/table of contents/i.test(text.slice(0, 550)))).find(index => index >= 0);
  if (heading == null) return pageNumbers(1, Math.min(12, texts.length));
  const followup = texts.slice(heading + 1, heading + 7).findIndex(text =>
    /^(?:\d+(?:\.\d+)*\.?\s+)?(?:introduction|background|methodology|table of contents)\s*$/im.test(text.slice(0, 450)));
  return pageNumbers(heading + 1, followup < 0 ? Math.min(heading + 6, texts.length) : heading + 1 + followup);
}

function searchTerms(groups, question) {
  const meaningful = normalize(question).split(' ').filter(term => term.length > 2 && !stopwords.has(term));
  return (groups.length ? groups : [meaningful]).map(group => [...new Set(group.map(normalize))]
    .filter(term => term.length > 2 && !stopwords.has(term)).slice(0, 16));
}

export async function preparePdfInput(pdf, { mode, question, pageRange, pageCount, findTerms, legacyText, setStage }) {
  const large = pdf.length > AI_PDF_LIMIT || pageCount > (mode === 'extract' ? 44 : 100);
  let directory;
  try {
    directory = await mkdtemp(join(tmpdir(), 'adams-pages-'));
    const source = join(directory, 'source.pdf');
    const inventory = join(directory, 'inventory.json');
    const cropped = join(directory, 'selected.pdf');
    await writeFile(source, pdf);
    let inspected;
    try {
      await invokePdf('inspect', source, inventory, mode, String(pageRange?.from ?? 1), String(pageRange?.to ?? 0));
      inspected = JSON.parse(await readFile(inventory, 'utf8'));
    } catch {
      if (large || pageRange) throw new AppError(422, 'PDF 페이지를 나눌 수 없습니다. Python의 pypdfium2와 Pillow 설치 또는 PDF 상태를 확인하세요.');
      const pages = await legacyText(pdf);
      if (pages?.length > (mode === 'extract' ? 44 : 100)) throw new AppError(422, '큰 PDF를 처리하려면 Python의 pypdfium2와 Pillow가 필요합니다.');
      const total = pages?.length ?? pageCount;
      const textOnly = useText(pages, question);
      return { pdf: textOnly ? null : pdf, pages, total, scope: { kind: 'full', total, input: textOnly ? 'text' : 'pdf' } };
    }
    const { pages: texts, count: total } = inspected;
    if (pageRange && !texts.length) throw new AppError(400, `범위 시작은 PDF의 전체 ${total}쪽 이내여야 합니다.`);
    if (!pageRange && total === texts.length && total <= (mode === 'extract' ? 44 : 100) &&
        pdf.length <= AI_PDF_LIMIT && (total === 1 || textSize(texts) <= TEXT_LIMIT)) {
      const textOnly = useText(texts, question, inspected.clipped);
      return { pdf: textOnly ? null : pdf, pages: texts, total, scope: { kind: 'full', total, input: textOnly ? 'text' : 'pdf' } };
    }
    let selected;
    let kind;
    let pages;
    let clipped;
    if (pageRange) {
      selected = pageNumbers(pageRange.from, Math.min(pageRange.to, total));
      kind = 'range';
    } else if (mode === 'summary') {
      selected = overviewPages(texts);
      kind = 'overview';
    } else {
      setStage('selecting');
      let groups = [];
      try { groups = await findTerms(question); } catch { /* Use the question or sampling when keyword generation is unavailable. */ }
      try {
        try {
          await invokePdf('select', source, inventory, JSON.stringify(searchTerms(groups, question)));
        } catch (error) {
          if (!error.killed) throw error;
          // If indexing exceeds the worker deadline, explicitly sample across the entire PDF.
          await invokePdf('select', source, inventory, '[]');
        }
        ({ kind, selected, pages, clipped } = JSON.parse(await readFile(inventory, 'utf8')));
      } catch {
        throw new AppError(422, 'PDF에서 관련 페이지를 읽지 못했습니다. PDF 쪽수를 지정해 다시 시도하세요.');
      }
    }
    if (!selected.length) throw new AppError(422, '읽을 PDF 페이지를 찾지 못했습니다.');
    if (!pages) {
      const offset = pageRange?.from ?? 1;
      pages = selected.map(number => texts[number - offset]);
      clipped = inspected.clipped.filter(number => selected.includes(number));
    }
    if (useText(pages, question, clipped)) return { pdf: null, pages, total, scope: { kind, total, pages: selected, input: 'text' } };
    try {
      await invokePdf('slice', source, cropped, ...selected.map(String));
      const selectedPdf = await readFile(cropped);
      if (selectedPdf.length > AI_PDF_LIMIT) throw new Error('Selected PDF exceeds the model input size.');
      return { pdf: selectedPdf, pages, total, scope: { kind, total, pages: selected, input: 'pdf' } };
    } catch {
      throw new AppError(422, '선택한 PDF 페이지를 분석용으로 만들지 못했습니다. 맞춤 추출에서 페이지 범위를 줄여 다시 시도하세요.');
    }
  } finally {
    if (directory) await rm(directory, { recursive: true, force: true }).catch(() => {});
  }
}
