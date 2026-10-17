#!/usr/bin/env node
/**
 * Retrains the learned roster extractor (the AI model /upload uses) from every
 * label, PDFs and images (the /models page's "Train" runs this too):
 *   1. training words from the labels (scripts/build-pdf-token-data.mjs for labels/pdf/,
 *      scripts/build-image-token-data.mjs for image labels: OCR lines are cached in
 *      exports/ocr-lines/, so only images new since the last run need the OCR server)
 *   2. what the labels teach about layouts (conventions.json: column-header words, where dates
 *      stand, how values are written; services/pdf-row-assembler.js learnConventions)
 *   3. the word tagger (scripts/train_pdf_tagger.py --no-eval, with those header words) -> models/ai/.next/
 *   4. models/ai/.next -> a new version models/ai/<id>/, activated (earlier versions are kept:
 *      /models lists them, activates another one or deletes one; services/ai-models.js)
 *
 *   node scripts/model-train.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { learnConventions, mergeConventions } from '../services/pdf-row-assembler.js';
import { PYTHON } from '../services/pdf-ai-extract.js';
import { AI_DIR, newVersionDir, activateModel } from '../services/ai-models.js';
import { labelFile, dataFile, extOf, PDF_EXTS } from '../utils/data-files.js';
import { readPdfText } from '../services/pdf-text.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TOKENS = path.join(ROOT, 'exports', 'pdf-tokens');
const NEXT = path.join(AI_DIR, '.next');

// training files per type as /benchmark counts them: every picture is 'image', a text file its extension
const countByType = (names) => {
  const out = Object.fromEntries(['image', ...PDF_EXTS].map(t => [t, 0]));
  for (const n of names) out[PDF_EXTS.includes(extOf(n)) ? extOf(n) : 'image'] += 1;
  return out;
};

const run = (cmd, args) => new Promise((resolve, reject) => {
  const child = spawn(cmd, args, { cwd: ROOT, windowsHide: true });
  const show = d => String(d).split('\n').filter(l => l.trim() && !/Warning|trace-warnings|warnings.warn/.test(l)).forEach(l => console.log(`  ${l}`));
  child.stdout.on('data', show);
  child.stderr.on('data', show);
  child.on('error', reject);
  child.on('close', code => (code === 0 ? resolve() : reject(new Error(`${path.basename(args[args.length > 1 ? 1 : 0])} failed (${code})`))));
});

const t0 = Date.now();
console.log('1/4 Training words from the labels');
fs.rmSync(TOKENS, { recursive: true, force: true });
await run(process.execPath, ['scripts/build-pdf-token-data.mjs']);
await run(process.execPath, ['scripts/build-image-token-data.mjs']);
const imageSummary = JSON.parse(fs.readFileSync(path.join(ROOT, 'exports', 'image-tokens', 'summary.json'), 'utf8'));

console.log('2/4 Conventions');
fs.rmSync(NEXT, { recursive: true, force: true });
fs.mkdirSync(NEXT, { recursive: true });
const summary = JSON.parse(fs.readFileSync(path.join(TOKENS, 'summary.json'), 'utf8'));
const convs = [];
for (const f of summary.files) {
  const doc = JSON.parse(fs.readFileSync(path.join(TOKENS, `${f.file}.json`), 'utf8'));
  const label = JSON.parse(fs.readFileSync(labelFile(path.join(ROOT, 'labels'), f.file), 'utf8'));
  convs.push(learnConventions(doc.pages, label, await readPdfText(dataFile(path.join(ROOT, 'fake-data'), f.file))));
}
fs.writeFileSync(path.join(NEXT, 'conventions.json'), JSON.stringify(mergeConventions(convs), null, 2));

console.log('3/4 Training the word tagger');
await run(PYTHON, ['-I', 'scripts/train_pdf_tagger.py', '--no-eval', '--conventions', path.join(NEXT, 'conventions.json'), '--save', NEXT]);
const meta = {
  trainedAt: new Date().toISOString(),
  files: summary.files.length + imageSummary.files.length,
  pdfs: summary.files.length,
  images: imageSummary.files.length,
  filesByType: countByType([...summary.files, ...imageSummary.files].map(f => f.file)),
  fromLabelOnly: summary.aligned.length, // formats the parser misreads, learned from the label alone
  rows: summary.files.reduce((s, f) => s + f.rows, 0) + imageSummary.rows,
  words: summary.tokens + imageSummary.tokens,
  skipped: summary.skipped.map(s => `${s.file}: ${s.reason}`),
  seconds: Math.round((Date.now() - t0) / 1000),
};
fs.writeFileSync(path.join(NEXT, 'meta.json'), JSON.stringify(meta, null, 2));

console.log('4/4 Switching to the new model');
const { id, dir } = newVersionDir(meta.trainedAt);
fs.renameSync(NEXT, dir);
activateModel(id);
console.log(`New model version ${id} is active.`);
console.log(`Done in ${meta.seconds} s: ${meta.files} files (${meta.fromLabelOnly} learned from the label alone), ${meta.rows} rows, ${meta.words} words.`);
