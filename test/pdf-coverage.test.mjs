import assert from 'node:assert/strict';
import { test } from 'node:test';
import { preparePdfInput } from '../pdf-analysis.mjs';

function content(lines) {
  const commands = ['BT /F1 5 Tf 10 1800 Td 7 TL', ...lines.map(line => `(${line}) ' `), 'ET'].join('\n');
  return `<< /Length ${commands.length} >>\nstream\n${commands}\nendstream`;
}

function samplePdf(count, replacements) {
  const objects = ['', '<< /Type /Catalog /Pages 2 0 R >>', '',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', content(['Technical appendix'])];
  const references = [];
  for (let number = 1; number <= count; number++) {
    const stream = replacements.has(number) ? objects.push(content(replacements.get(number))) - 1 : 4;
    references.push(`${objects.length} 0 R`);
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 900 1900] /Resources << /Font << /F1 3 0 R >> >> /Contents ${stream} 0 R >>`);
  }
  objects[2] = `<< /Type /Pages /Count ${count} /Kids [${references.join(' ')}] >>`;
  const offsets = ['0000000000 65535 f '];
  let bytes = '%PDF-1.4\n';
  for (let id = 1; id < objects.length; id++) {
    offsets.push(String(bytes.length).padStart(10, '0') + ' 00000 n ');
    bytes += `${id} 0 obj\n${objects[id]}\nendobj\n`;
  }
  return Buffer.from(bytes + `xref\n0 ${objects.length}\n${offsets.join('\n')}\ntrailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${bytes.length}\n%%EOF\n`);
}

const deadline = 'The deadline for the qualifying repair is 31 July.';
const dense = [...Array(185).fill('These routine administrative entries document the complete general inspection checklist.'), deadline];
const options = {
  mode: 'extract', question: 'When is the qualifying repair due?', pageRange: null, setStage() {},
  findTerms: async () => [['qualifying repair']], legacyText: async () => null,
};

test('dense page keeps evidence beyond character 14000 in full and explicit-range text inputs', async () => {
  const pdf = samplePdf(1, new Map([[1, dense]]));
  for (const pageRange of [null, { from: 1, to: 1 }]) {
    const input = await preparePdfInput(pdf, { ...options, pageCount: 1, pageRange });
    assert.equal(input.scope.kind, pageRange ? 'range' : 'full');
    assert.equal(input.scope.input, 'text');
    assert.ok(input.pages[0].indexOf(deadline) >= 14000);
  }
});

test('multi-thousand page extraction ranks terms in dense late pages and samples to the last page', async () => {
  const total = 2508;
  const hit = 2506;
  const pdf = samplePdf(total, new Map([[hit, dense]]));
  const targeted = await preparePdfInput(pdf, { ...options, pageCount: total });
  assert.equal(targeted.scope.kind, 'targeted');
  const index = targeted.scope.pages.indexOf(hit);
  assert.ok(index >= 0);
  assert.ok(targeted.pages[index].indexOf(deadline) >= 14000);
  const sample = await preparePdfInput(pdf, { ...options, pageCount: total, findTerms: async () => [['no matching terminology']] });
  assert.equal(sample.scope.kind, 'sample');
  assert.equal(sample.scope.pages[0], 1);
  assert.equal(sample.scope.pages.at(-1), total);
  assert.equal(sample.scope.pages.length, 18);
});

test('a selected range exceeding the text budget sends all selected pages as PDF', async () => {
  const count = 13;
  const pdf = samplePdf(count, new Map(Array.from({ length: count }, (_, i) => [i + 1, dense])));
  const input = await preparePdfInput(pdf, { ...options, pageCount: count, pageRange: { from: 1, to: count } });
  assert.equal(input.scope.input, 'pdf');
  assert.deepEqual(input.scope.pages, Array.from({ length: count }, (_, i) => i + 1));
  assert.ok(Buffer.isBuffer(input.pdf));
});
