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
 *   extractAcarsWithModel(ocrLines, width, height, dir?) -> { flt, dept, dest, out, off, on, in, info } (services/acars.js)
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
import { ocrPdfPages, ocrPdfAsImage, ocrEmptyPages } from './pdf-ocr.js';
import { ocrWordPages } from './ocr-tokens.js';
import { acarsWordPages, assembleAcars } from './acars.js';
import { ROOT } from '../utils/paths.js';
import { activeModelDir } from './ai-models.js';

export const PYTHON = path.join(ROOT, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');

/** The active version, or the one in `dir` (a new version checked before it is used). */
export function modelInfo(dir = activeModelDir()) {
  if (!dir || !fs.existsSync(path.join(dir, 'tagger.joblib'))) return { ready: false };
  let meta = {};
  try { meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8')); } catch { /* trained by hand: no meta */ }
  return { ready: true, ...meta, id: path.basename(dir), dir };
}

function conventions(dir) {
  try { return JSON.parse(fs.readFileSync(path.join(dir, 'conventions.json'), 'utf8')); } catch { return {}; }
}

/**
 * The tagger kept running (scripts/pdf_tagger_server.py): a fresh Python per file spent ~2-3 s on its
 * imports alone. One request per line, answered by id; a crash or a stuck request ends the process
 * and the next call starts another. Unref'd, so a CLI run still exits (a pending request's timer
 * keeps it alive while it waits).
 */
let tagger = null;
let nextId = 1;

function startTagger() {
  const child = spawn(PYTHON, ['-I', path.join(ROOT, 'src', 'scripts', 'pdf_tagger_server.py')], { cwd: ROOT, windowsHide: true });
  const t = { child, pending: new Map(), err: '' };
  let buf = '';
  child.stdout.on('data', (d) => {
    buf += d;
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      const p = t.pending.get(msg.id);
      if (!p) continue;
      t.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) p.reject(new Error(`pdf_tagger_server.py: ${msg.error}`));
      else p.resolve(msg.fields);
    }
  });
  child.stderr.on('data', (d) => { t.err = (t.err + d).slice(-4000); });
  const fail = (why) => {
    if (tagger === t) tagger = null;
    for (const p of t.pending.values()) { clearTimeout(p.timer); p.reject(new Error(why)); }
    t.pending.clear();
  };
  child.on('error', (e) => fail(`pdf_tagger_server.py: ${e.message}`));
  child.on('close', (code) => fail(`pdf_tagger_server.py stopped (${code}): ${t.err.split('\n').filter(l => l && !/Warning/.test(l)).slice(-3).join(' | ')}`));
  child.stdin.on('error', () => { /* it stopped: 'close' rejects what is pending */ });
  child.unref();
  for (const s of [child.stdin, child.stdout, child.stderr]) s.unref?.();
  return t;
}

/** [[field per token] per page] from the model in dir. */
export function tagWords(dir, pages, { timeoutMs = 120000 } = {}) {
  tagger ||= startTagger();
  const t = tagger, id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      t.pending.delete(id);
      reject(new Error(`pdf_tagger_server.py: no answer after ${timeoutMs / 1000} s`));
      t.child.kill(); // stuck: the next call starts a new one
    }, timeoutMs);
    t.pending.set(id, { resolve, reject, timer });
    t.child.stdin.write(`${JSON.stringify({ id, dir, pages })}\n`);
  });
}

/** Rows of a PDF (readPdfText pages) from the learned model. */
export async function extractWithModel(pages, dir = activeModelDir()) {
  if (!dir || !fs.existsSync(path.join(dir, 'tagger.joblib'))) throw new Error('No AI model yet: label a few files, then click "Train" on /models.');
  const tagPages = plainTokens(wordsOf(pages));
  const fields = await tagWords(dir, tagPages);
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
  if (hasTextLayer(pages)) {
    // pages without text beside pages with text (drawn as outlines): OCR'd when the OCR server answers, else left out
    const all = await ocrEmptyPages(filePath, pages).catch(() => pages);
    return { ...(await extractWithModel(all, dir)), source: 'model', readMode: all.some(p => p.ocr) ? 'text+ocr' : 'text' };
  }
  const plan = parseNetlinePdf(await ocrPdfPages(filePath));
  if (plan.published.length + plan.planned.length) return { ...plan, source: 'parser', readMode: 'ocr' };
  const { lines, width, height } = await ocrPdfAsImage(filePath);
  return { ...(await extractImageWithModel(lines, width, height, dir)), source: 'model', readMode: 'ocr-image' };
}

export async function extractImageWithModel(lines, width, height, dir = activeModelDir()) {
  if (!dir || !fs.existsSync(path.join(dir, 'tagger.joblib'))) throw new Error('No AI model yet: label a few files, then click "Train" on /models.');
  const pages = ocrWordPages(lines, width, height);
  const fields = await tagWords(dir, pages);
  pages.forEach((p, i) => p.tokens.forEach((t, k) => { t.field = fields[i][k]; }));
  const rows = assembleRows(pages, [], { ...conventions(dir), ocr: true });
  return {
    format: 'ai-model',
    recognized: rows.published.length + rows.planned.length > 0,
    published: rows.published,
    planned: rows.planned,
  };
}

/**
 * An ACARS picture read by the same model: its OCR words (services/acars.js acarsWordPages) tagged with
 * the ACARS fields only, then one value per field (assembleAcars). A version trained before ACARS
 * pictures were labeled knows no ACARS field: 409 with what to do.
 */
export async function extractAcarsWithModel(lines, width, height, dir = activeModelDir()) {
  if (!dir || !fs.existsSync(path.join(dir, 'tagger.joblib'))) throw new Error('No AI model yet: label a few files, then click "Train" on /models.');
  let meta = {};
  try { meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8')); } catch { /* trained by hand */ }
  if (!meta.acars) {
    throw Object.assign(new Error('The AI model in use was not trained on ACARS pictures: label some under "ACARS files" on /label, then train a new version on /models.'), { status: 409 });
  }
  const pages = acarsWordPages(lines, width, height);
  const fields = await tagWords(dir, pages);
  pages.forEach((p, i) => p.tokens.forEach((t, k) => { t.field = fields[i][k]; }));
  return { format: 'acars-model', fields: assembleAcars(pages) };
}
