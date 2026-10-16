/**
 * Benchmark of the AI model over every labeled file, images and PDFs together:
 * each file is read exactly as /upload reads it and compared with its verified
 * label (ground truth).
 *
 *   image: PaddleOCR lines -> learned tagger -> rows (extractImageWithModel),
 *          scored like the image benchmark (compareSection: 7 fields, OCR-tolerant).
 *   PDF:   text layer -> learned tagger -> rows (extractWithModel), scored like the
 *          PDF benchmark (compareRows: 13 fields, exact). A picture-only PDF, as on /upload
 *          (readPdfWithModel): a duty plan by the parser on its OCR text (source 'parser'),
 *          a roster picture by the model on its OCR lines as an image.
 *
 * Byte-identical copies of a file are scored once (as `npm run benchmark`).
 * The model version active at the start is used for the whole run; a finished run's
 * scores are saved in that version's benchmark.json (shown on /models).
 * The model learned from these same labels, so the score is on data it has seen,
 * except labels made or changed after it was trained (counted in `labelsAfterTraining`).
 *
 *   runModelBenchmark({ kinds: ['image', 'pdf'], onEvent, shouldStop }) -> summary
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { ocrLines } from './paddle-ocr.js';
import { extractImageWithModel, readPdfWithModel, modelInfo } from './pdf-ai-extract.js';
import { compareSection, alignRows, normalizeField } from './benchmark.js';
import { compareRows, PDF_FIELDS } from './pdf-benchmark.js';
import { listLabels, dataFile, labelFile } from '../utils/data-files.js';
import { saveBenchmark } from './ai-models.js';
import { groupByContent, pickCanonicalLabels } from '../utils/content-groups.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = path.join(ROOT, 'fake-data');
const LABELS = path.join(ROOT, 'labels');
const SECTIONS = ['published', 'planned'];
// Fields both kinds of file have: their accuracy is also given over images and PDFs together.
export const COMMON_FIELDS = ['date', 'day', 'duty', 'dep', 'begin', 'end', 'arr'];
const IMAGE_FIELDS = COMMON_FIELDS;

/** Labeled files of one kind, one per distinct content. */
function labeledFiles(kind) {
  const names = listLabels(LABELS, kind).filter(n => fs.existsSync(dataFile(DATA, n)));
  const groups = groupByContent(path.join(DATA), names);
  const { canonical } = pickCanonicalLabels(groups, LABELS);
  const keep = new Set(canonical.values());
  return names.filter(n => keep.has(n)).sort();
}

async function readImage(file, dir) {
  const lines = await ocrLines(file);
  const { width, height } = await sharp(file).metadata();
  return { ...(await extractImageWithModel(lines, width, height, dir)), source: 'model' };
}

// as /upload does (an image-only duty plan: the parser; a roster picture: the model as on an image)
const readPdf = (file, dir) => readPdfWithModel(file, dir);

const MAX_DIFFS = 200; // per file, enough to see what is wrong without a huge page

/** Differences of an image section in the PDF benchmark's shape: { kind: field|missing|extra, ... }. */
function imageDiffs(predRows, expRows) {
  const out = [];
  for (const { pred, exp } of alignRows(predRows, expRows)) {
    if (!exp) { out.push({ kind: 'extra', pred }); continue; }
    if (!pred) { out.push({ kind: 'missing', exp }); continue; }
    for (const f of IMAGE_FIELDS) {
      const p = normalizeField(f, pred[f]), e = normalizeField(f, exp[f]);
      if (p !== e) out.push({ kind: 'field', field: f, pred: pred[f] || '', exp: exp[f] || '', date: exp.date, duty: exp.duty });
    }
  }
  return out;
}

/** Row and per-field scores of one file, with its differences from the label. */
function scoreFile(kind, pred, label) {
  const out = { rowMatches: 0, rowTotal: 0, predCount: 0, perField: {}, diffs: [] };
  const fields = kind === 'pdf' ? PDF_FIELDS : IMAGE_FIELDS;
  for (const f of fields) out.perField[f] = { matches: 0, total: 0 };
  for (const sec of SECTIONS) {
    if (kind === 'pdf') {
      const c = compareRows(pred[sec] || [], label[sec] || []);
      out.rowMatches += c.rowMatches; out.rowTotal += c.rowTotal; out.predCount += c.predCount;
      for (const f of fields) { out.perField[f].matches += c.perField[f].matches; out.perField[f].total += c.perField[f].total; }
      out.diffs.push(...c.errors.map(e => ({ section: sec, ...e })));
    } else {
      const c = compareSection(pred[sec] || [], label[sec] || []);
      out.rowMatches += c.rowMatches; out.rowTotal += c.expCount; out.predCount += c.predCount;
      for (const f of fields) { out.perField[f].matches += c.perField[f]?.matches || 0; out.perField[f].total += c.perField[f]?.total || 0; }
      out.diffs.push(...imageDiffs(pred[sec] || [], label[sec] || []).map(e => ({ section: sec, ...e })));
    }
  }
  out.diffCount = out.diffs.length;
  out.diffs = out.diffs.slice(0, MAX_DIFFS);
  return out;
}

const pct = (m, t) => (t ? Math.round((1000 * m) / t) / 10 : null);

function summarize(files, info) {
  const sum = (list) => {
    const s = { files: list.length, rowMatches: 0, rowTotal: 0, predCount: 0, perField: {} };
    for (const f of list) {
      s.rowMatches += f.rowMatches; s.rowTotal += f.rowTotal; s.predCount += f.predCount;
      for (const [k, v] of Object.entries(f.perField)) {
        s.perField[k] ||= { matches: 0, total: 0 };
        s.perField[k].matches += v.matches; s.perField[k].total += v.total;
      }
    }
    s.rowExact = pct(s.rowMatches, s.rowTotal);
    for (const v of Object.values(s.perField)) v.pct = pct(v.matches, v.total);
    return s;
  };
  const ok = files.filter(f => !f.error);
  const all = sum(ok);
  all.perField = Object.fromEntries(Object.entries(all.perField).filter(([k]) => COMMON_FIELDS.includes(k)));
  return {
    model: info,
    overall: all,
    image: sum(ok.filter(f => f.kind === 'image')),
    pdf: sum(ok.filter(f => f.kind === 'pdf')),
    errors: files.filter(f => f.error).length,
    files,
  };
}

export async function runModelBenchmark({ kinds = ['image', 'pdf'], onEvent, shouldStop } = {}) {
  const info = modelInfo();
  if (!info.ready) throw new Error('Chưa có AI model: label vài file rồi bấm "Train" ở /models.');
  const trainedAt = info.trainedAt ? Date.parse(info.trainedAt) : null;
  const todo = kinds.flatMap(kind => labeledFiles(kind).map(name => ({ kind, name })));
  onEvent?.({ type: 'start', total: todo.length, model: info });
  const files = [];
  for (const [i, { kind, name }] of todo.entries()) {
    if (shouldStop?.()) break;
    const t0 = Date.now();
    const lp = labelFile(LABELS, name);
    const entry = { kind, file: name, afterTraining: trainedAt != null && fs.statSync(lp).mtimeMs > trainedAt };
    try {
      const label = JSON.parse(fs.readFileSync(lp, 'utf8'));
      const pred = kind === 'pdf' ? await readPdf(dataFile(DATA, name), info.dir) : await readImage(dataFile(DATA, name), info.dir);
      // a roster picture printed to PDF is scored as the image it is (7 fields, OCR-tolerant)
      Object.assign(entry, scoreFile(pred.readMode === 'ocr-image' ? 'image' : kind, pred, label), { source: pred.source });
      entry.rowExact = pct(entry.rowMatches, entry.rowTotal);
    } catch (e) {
      entry.error = e.message;
    }
    entry.ms = Date.now() - t0;
    files.push(entry);
    onEvent?.({ type: 'file', file: entry, progress: { current: i + 1, total: todo.length } });
  }
  const result = summarize(files, info);
  result.stopped = files.length < todo.length;
  result.labelsAfterTraining = files.filter(f => f.afterTraining).length;
  if (!result.stopped) {
    const brief = (s) => ({ files: s.files, rowMatches: s.rowMatches, rowTotal: s.rowTotal, rowExact: s.rowExact });
    const part = { at: new Date().toISOString() };
    for (const k of kinds) part[k] = brief(result[k]);
    if (kinds.length === 2) part.overall = brief(result.overall);
    saveBenchmark(info.dir, part);
  }
  onEvent?.({ type: 'done', result });
  return result;
}
