/**
 * Benchmark of the AI model over every labeled file, images and PDFs together:
 * each file is read exactly as /roster reads it and compared with its verified
 * label (ground truth).
 *
 *   image: PaddleOCR lines -> learned tagger -> rows (extractImageWithModel),
 *          scored like the image benchmark (compareSection: 7 fields, OCR-tolerant).
 *   PDF:   text layer -> learned tagger -> rows (extractWithModel), scored like the
 *          PDF benchmark (compareRows: 13 fields, exact). A picture-only PDF, as on /roster
 *          (readPdfWithModel): a duty plan by the parser on its OCR text (source 'parser'),
 *          a roster picture by the model on its OCR lines as an image.
 *
 * Byte-identical copies of a file are scored once.
 * The model version active at the start (or modelDir's) is used for the whole run; a finished run's
 * scores are saved in that version's benchmark.json (shown on /models).
 * The model learned from these same labels, so the score is on data it has seen,
 * except labels made or changed after it was trained (counted in `labelsAfterTraining`).
 *
 *   runModelBenchmark({ types: ['image', 'pdf', 'csv', ...], onEvent, shouldStop, modelDir }) -> summary
 *     modelDir: another version than the active one (scripts/model-train.mjs checks a new one with it)
 *     types: FILE_TYPES to read (default all); the summary scores each type on its own
 *     (byType) besides images, text files (kind 'pdf') and both together.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { ocrLines, ocrDevice } from './paddle-ocr.js';
import { extractImageWithModel, readPdfWithModel, modelInfo } from './pdf-ai-extract.js';
import { compareSection, alignRows, normalizeField } from './benchmark.js';
import { compareRows, PDF_FIELDS } from './pdf-benchmark.js';
import { listReviewedLabels, dataFile, labelFile, extOf, PDF_EXTS, DATA_ROOT, LABELS_ROOT } from '../utils/data-files.js';
import { saveBenchmark, syncModels } from './ai-models.js';
import { saveRun } from './benchmark-history.js';
import { eachInPool, benchmarkConcurrency } from '../utils/pool.js';
import { ROOT, EXPORTS_DIR } from '../utils/paths.js';
import { groupByContent, pickCanonicalLabels } from '../utils/content-groups.js';

const DATA = DATA_ROOT;
const LABELS = LABELS_ROOT;
const SECTIONS = ['published', 'planned'];
// Fields both kinds of file have: their accuracy is also given over images and PDFs together.
export const COMMON_FIELDS = ['date', 'day', 'duty', 'dep', 'begin', 'end', 'arr'];
const IMAGE_FIELDS = COMMON_FIELDS;
// File types scored on their own: every picture is 'image'; text files by extension.
export const FILE_TYPES = ['image', ...PDF_EXTS];
export const typeOf = (name) => (PDF_EXTS.includes(extOf(name)) ? extOf(name) : 'image');

/** Labeled files of each type: { image: n, pdf: n, csv: n, ... } (for the /benchmark choices). */
export function labeledCounts() {
  const out = Object.fromEntries(FILE_TYPES.map(t => [t, 0]));
  for (const kind of ['image', 'pdf']) for (const n of labeledFiles(kind)) out[typeOf(n)] += 1;
  return out;
}

/** Layout of each text file as the parser recognizes it (written by the training data
 * build, <work>/exports/pdf-tokens/summary.json); pictures are one layout. */
function layoutReader() {
  let byFile = {};
  try {
    const s = JSON.parse(fs.readFileSync(path.join(EXPORTS_DIR, 'pdf-tokens', 'summary.json'), 'utf8'));
    byFile = Object.fromEntries((s.files || []).map(f => [f.file, f.format || 'unknown']));
  } catch { /* not built yet: every text file is 'unknown' */ }
  return (kind, name) => (kind === 'image' ? 'roster-image' : byFile[name] || 'unknown');
}

/** Labeled files of one kind, one per distinct content. */
function labeledFiles(kind) {
  const names = listReviewedLabels(LABELS, kind).filter(n => fs.existsSync(dataFile(DATA, n)));
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

// as /roster does (an image-only duty plan: the parser; a roster picture: the model as on an image)
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
  const out = { rowMatches: 0, coreRowMatches: 0, rowTotal: 0, predCount: 0, perField: {}, diffs: [] };
  const fields = kind === 'pdf' ? PDF_FIELDS : IMAGE_FIELDS;
  for (const f of fields) out.perField[f] = { matches: 0, total: 0 };
  for (const sec of SECTIONS) {
    if (kind === 'pdf') {
      const c = compareRows(pred[sec] || [], label[sec] || []);
      out.rowMatches += c.rowMatches; out.coreRowMatches += c.coreRowMatches; out.rowTotal += c.rowTotal; out.predCount += c.predCount;
      for (const f of fields) { out.perField[f].matches += c.perField[f].matches; out.perField[f].total += c.perField[f].total; }
      out.diffs.push(...c.errors.map(e => ({ section: sec, ...e })));
    } else {
      const c = compareSection(pred[sec] || [], label[sec] || []);
      // pictures are scored on the 7 core fields only: every right row is core right
      out.rowMatches += c.rowMatches; out.coreRowMatches += c.rowMatches; out.rowTotal += c.expCount; out.predCount += c.predCount;
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
    const s = { files: list.length, rowMatches: 0, coreRowMatches: 0, rowTotal: 0, predCount: 0, perField: {} };
    for (const f of list) {
      s.rowMatches += f.rowMatches; s.coreRowMatches += f.coreRowMatches || 0; s.rowTotal += f.rowTotal; s.predCount += f.predCount;
      for (const [k, v] of Object.entries(f.perField)) {
        s.perField[k] ||= { matches: 0, total: 0 };
        s.perField[k].matches += v.matches; s.perField[k].total += v.total;
      }
    }
    s.rowExact = pct(s.rowMatches, s.rowTotal);
    // rows right on the 7 core fields (date, day, duty, dep, begin, end, arr), extras aside
    s.coreRowExact = pct(s.coreRowMatches, s.rowTotal);
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
    byType: Object.fromEntries(FILE_TYPES.map(t => [t, sum(ok.filter(f => typeOf(f.file) === t))]).filter(([, s]) => s.files)),
    // each layout on its own (no per-field detail), weakest by rows lost first
    byLayout: Object.fromEntries([...new Set(ok.map(f => f.layout || 'unknown'))]
      .map(l => { const { perField, ...s } = sum(ok.filter(f => (f.layout || 'unknown') === l)); return [l, s]; })
      .sort((a, b) => (b[1].rowTotal - b[1].rowMatches) - (a[1].rowTotal - a[1].rowMatches))),
    errors: files.filter(f => f.error).length,
    files,
  };
}

export async function runModelBenchmark({ types = FILE_TYPES, onEvent, shouldStop, modelDir } = {}) {
  await syncModels();
  const info = modelInfo(modelDir); // (modelDir: a version not active yet, scripts/model-train.mjs)
  if (!info.ready) throw new Error('No AI model yet: label a few files, then click "Train" on /models.');
  const trainedAt = info.trainedAt ? Date.parse(info.trainedAt) : null;
  const todo = ['image', 'pdf'].flatMap(kind => labeledFiles(kind).filter(n => types.includes(typeOf(n))).map(name => ({ kind, name })));
  // a kind's score is saved to the model version (/models) only when all of its types were run
  const kinds = ['image', 'pdf'].filter(k => FILE_TYPES.filter(t => (t === 'image') === (k === 'image')).every(t => types.includes(t)));
  onEvent?.({ type: 'start', total: todo.length, model: info });
  const layoutOf = layoutReader();
  // a few files at once (utils/pool.js): an image's OCR on the GPU overlaps another file's tagging
  const files = await eachInPool(todo, benchmarkConcurrency(), async ({ kind, name }) => {
    const t0 = Date.now();
    const lp = labelFile(LABELS, name);
    const entry = { kind, file: name, layout: layoutOf(kind, name), afterTraining: trainedAt != null && fs.statSync(lp).mtimeMs > trainedAt };
    try {
      const label = JSON.parse(fs.readFileSync(lp, 'utf8'));
      const pred = kind === 'pdf' ? await readPdf(dataFile(DATA, name), info.dir) : await readImage(dataFile(DATA, name), info.dir);
      // a roster picture printed to PDF is scored as the image it is (7 fields, OCR-tolerant)
      Object.assign(entry, scoreFile(pred.readMode === 'ocr-image' ? 'image' : kind, pred, label), { source: pred.source });
      entry.rowExact = pct(entry.rowMatches, entry.rowTotal);
      entry.coreRowExact = pct(entry.coreRowMatches, entry.rowTotal);
    } catch (e) {
      entry.error = e.message;
    }
    entry.ms = Date.now() - t0;
    return entry;
  }, { shouldStop, onDone: (entry, done) => onEvent?.({ type: 'file', file: entry, progress: { current: done, total: todo.length } }) });
  const result = summarize(files, info);
  result.stopped = files.length < todo.length;
  result.labelsAfterTraining = files.filter(f => f.afterTraining).length;
  if (!result.stopped) {
    const brief = (s) => ({ files: s.files, rowMatches: s.rowMatches, rowTotal: s.rowTotal, rowExact: s.rowExact, coreRowMatches: s.coreRowMatches, coreRowExact: s.coreRowExact });
    const part = { at: new Date().toISOString() };
    for (const k of kinds) part[k] = brief(result[k]);
    if (kinds.length === 2) part.overall = brief(result.overall);
    // every type asked for was run in full: its own score (/models lists each type)
    part.byType = Object.fromEntries(types.map(t => [t, brief(result.byType[t] || { files: 0, rowMatches: 0, rowTotal: 0, rowExact: null })]));
    await saveBenchmark(info.dir, part);
  }
  if (todo.some(t => t.kind === 'image')) result.ocrDevice = await ocrDevice(); // the images went through the OCR server
  result.historyId = await saveRun('model', result); // /benchmark history (null: stopped part way)
  onEvent?.({ type: 'done', result });
  return result;
}
