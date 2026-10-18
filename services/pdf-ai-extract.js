/**
 * Learned roster-PDF extractor (offline, no API): the words of the PDF are
 * tagged by the trained model (scripts/pdf_tagger.py, run through
 * scripts/pdf_tagger_predict.py) and put into rows by services/pdf-row-assembler.js.
 * It reads layouts the parser has no code for once a file of that layout is
 * labeled in /label and the model retrained (scripts/model-train.mjs).
 *
 *   modelInfo() -> { ready, id, trainedAt, files, rows, words } | { ready: false }  (the active version, services/ai-models.js)
 *   extractWithModel(pages, dir?) -> { format: 'ai-model', period, notices, published, planned }
 *   extractImageWithModel(ocrLines, width, height, dir?) -> { format: 'ai-model', published, planned }
 *   readPdfWithModel(file, dir?) -> any PDF: text layer, or an image-only one (see there)
 * dir: a model version's folder; the active one when left out.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { wordsOf, plainTokens } from './pdf-tokens.js';
import { assembleRows } from './pdf-row-assembler.js';
import { findPeriod, findNotices, parseNetlinePdf } from './pdf-roster-parser.js';
import { readPdfText, hasTextLayer } from './pdf-text.js';
import { ocrPdfPages, ocrPdfAsImage } from './pdf-ocr.js';
import { ocrWordPages } from './ocr-tokens.js';
import { activeModelDir } from './ai-models.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const PYTHON = path.join(ROOT, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');

export function modelInfo() {
  const dir = activeModelDir();
  if (!dir || !fs.existsSync(path.join(dir, 'tagger.joblib'))) return { ready: false };
  let meta = {};
  try { meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8')); } catch { /* trained by hand: no meta */ }
  return { ready: true, ...meta, id: path.basename(dir), dir };
}

function conventions(dir) {
  try { return JSON.parse(fs.readFileSync(path.join(dir, 'conventions.json'), 'utf8')); } catch { return {}; }
}

/** Runs a Python script with JSON on stdin, returns its parsed stdout. */
export function runPython(script, args, input, { timeoutMs = 120000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(PYTHON, ['-I', path.join(ROOT, 'scripts', script), ...args], { cwd: ROOT, windowsHide: true });
    let out = '', err = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error(`${script}: no answer after ${timeoutMs / 1000} s`)); }, timeoutMs);
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(`${script} failed (${code}): ${err.split('\n').filter(l => l && !/Warning/.test(l)).slice(-3).join(' | ')}`));
      try { resolve(JSON.parse(out)); } catch { reject(new Error(`${script}: not JSON: ${out.slice(0, 200)}`)); }
    });
    child.stdin.end(JSON.stringify(input));
  });
}

/** Rows of a PDF (readPdfText pages) from the learned model. */
export async function extractWithModel(pages, dir = activeModelDir()) {
  if (!dir || !fs.existsSync(path.join(dir, 'tagger.joblib'))) throw new Error('No AI model yet: label a few files, then click "Train" on /models.');
  const tagPages = plainTokens(wordsOf(pages));
  const { fields } = await runPython('pdf_tagger_predict.py', [dir], { pages: tagPages });
  tagPages.forEach((p, i) => p.tokens.forEach((t, k) => { t.field = fields[i][k]; }));
  const rows = assembleRows(tagPages, pages, conventions(dir));
  return {
    format: 'ai-model',
    recognized: rows.published.length + rows.planned.length > 0,
    period: findPeriod(pages)?.text || null,
    notices: findNotices(pages),
    published: rows.published,
    planned: rows.planned,
  };
}

/**
 * Rows of a roster IMAGE from the same learned model: its OCR lines become words
 * (services/ocr-tokens.js, as in scripts/build-image-token-data.mjs), the model
 * tags them, the assembler makes rows with the OCR repairs (conventions.ocr).
 */
/**
 * A PDF read by the AI model: its text layer; an image-only PDF of a duty plan
 * (NetLine on OCR text) by the parser, as the model has no words for it; any
 * other image-only PDF (a roster screen printed to PDF) as one tall roster picture.
 * -> { format, published, planned, source: 'model' | 'parser', readMode }
 */
export async function readPdfWithModel(filePath, dir = activeModelDir()) {
  const pages = await readPdfText(filePath);
  if (hasTextLayer(pages)) return { ...(await extractWithModel(pages, dir)), source: 'model', readMode: 'text' };
  const plan = parseNetlinePdf(await ocrPdfPages(filePath));
  if (plan.published.length + plan.planned.length) return { ...plan, source: 'parser', readMode: 'ocr' };
  const { lines, width, height } = await ocrPdfAsImage(filePath);
  return { ...(await extractImageWithModel(lines, width, height, dir)), source: 'model', readMode: 'ocr-image' };
}

export async function extractImageWithModel(lines, width, height, dir = activeModelDir()) {
  if (!dir || !fs.existsSync(path.join(dir, 'tagger.joblib'))) throw new Error('No AI model yet: label a few files, then click "Train" on /models.');
  const pages = ocrWordPages(lines, width, height);
  const { fields } = await runPython('pdf_tagger_predict.py', [dir], { pages });
  pages.forEach((p, i) => p.tokens.forEach((t, k) => { t.field = fields[i][k]; }));
  const rows = assembleRows(pages, [], { ...conventions(dir), ocr: true });
  return {
    format: 'ai-model',
    recognized: rows.published.length + rows.planned.length > 0,
    published: rows.published,
    planned: rows.planned,
  };
}
