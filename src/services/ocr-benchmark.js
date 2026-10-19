/**
 * Benchmark of text recognition alone (PaddleOCR on a roster picture), before
 * any parser or model reads rows out of it.
 *
 * Ground truth: the cells of each labeled image (date, day, duty, dep, begin,
 * end, arr). Each cell's text is looked for in what the OCR read off that image:
 *   - read exactly: the cell's text (spaces and case ignored, "00:00 Z" = "00:00Z")
 *     is in one OCR line; each spot of an OCR line serves one cell only, so a
 *     time printed once is not counted for ten cells;
 *   - else the closest stretch of an OCR line (edit distance) is taken as what
 *     the OCR made of it ("OFF(Z" for "OFF(Z)", "17Feb20.Mor" for "MON").
 * A day's date and weekday count once per table, as the picture prints them once.
 * Scores: cells read exactly (word accuracy) and characters right
 * (1 - edit distance / characters, character accuracy), overall, per field
 * and per file, with the misread cells.
 * A cell the label fills in but the picture does not print counts as misread.
 *
 *   runOcrBenchmark({ onEvent, shouldStop }) -> summary
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ocrLines } from './paddle-ocr.js';
import { listLabels, dataFile, labelFile, DATA_ROOT, LABELS_ROOT } from '../utils/data-files.js';
import { groupByContent, pickCanonicalLabels } from '../utils/content-groups.js';
import { ROOT } from '../utils/paths.js';
import { activeRecId } from './rec-models.js';

const DATA = DATA_ROOT;
const LABELS = LABELS_ROOT;
export const OCR_FIELDS = ['date', 'day', 'duty', 'dep', 'begin', 'end', 'arr'];
const USED = '\u0001'; // a spot of an OCR line already given to a cell
const MAX_MISREADS = 200; // per file

const norm = (s) => String(s ?? '').replace(/\s+/g, '').toUpperCase();
const pct = (m, t) => (t ? Math.round((1000 * m) / t) / 10 : null);

/** Labeled images, one per distinct content (as the other benchmarks). */
function labeledImages() {
  const names = listLabels(LABELS, 'image').filter(n => fs.existsSync(dataFile(DATA, n)));
  const { canonical } = pickCanonicalLabels(groupByContent(DATA, names), LABELS);
  const keep = new Set(canonical.values());
  return names.filter(n => keep.has(n)).sort();
}

/** Closest stretch of `text` to `pat` (edit distance, free start and end): { dist, start, end }. */
function closestStretch(pat, text) {
  const m = pat.length, n = text.length;
  let prev = new Array(n + 1).fill(0), prevStart = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = new Array(n + 1), curStart = new Array(n + 1);
    cur[0] = i; curStart[0] = 0;
    for (let j = 1; j <= n; j++) {
      const sub = prev[j - 1] + (pat[i - 1] === text[j - 1] ? 0 : 1);
      const del = prev[j] + 1, ins = cur[j - 1] + 1;
      if (sub <= del && sub <= ins) { cur[j] = sub; curStart[j] = prevStart[j - 1]; }
      else if (del <= ins) { cur[j] = del; curStart[j] = prevStart[j]; }
      else { cur[j] = ins; curStart[j] = curStart[j - 1]; }
    }
    prev = cur; prevStart = curStart;
  }
  let end = 0;
  for (let j = 1; j <= n; j++) if (prev[j] < prev[end]) end = j;
  return { dist: prev[end], start: prevStart[end], end };
}

/** Scores of one image: its label's cells against its OCR lines. */
export function scoreOcr(lines, label) {
  const texts = lines.map(l => norm(l.text));
  const cells = [];
  for (const sec of ['published', 'planned']) {
    const days = new Set(); // a day of several duties prints its date and weekday once; the label repeats them per row
    for (const row of label[sec] || []) {
      const firstOfDay = !days.has(row.date);
      days.add(row.date);
      for (const field of OCR_FIELDS) {
        const want = norm(row[field]);
        if (want && (firstOfDay || (field !== 'date' && field !== 'day'))) cells.push({ field, want, label: String(row[field]), row });
      }
    }
  }
  // exact reads first, longest cells first (a "20" never takes a piece of "20:55Z")
  const order = cells.map((c, i) => i).sort((a, b) => cells[b].want.length - cells[a].want.length);
  for (const i of order) {
    const c = cells[i];
    const k = texts.findIndex(t => t.includes(c.want));
    if (k < 0) continue;
    c.exact = true;
    texts[k] = texts[k].replace(c.want, USED);
  }
  const perField = Object.fromEntries(OCR_FIELDS.map(f => [f, { cells: 0, exact: 0, chars: 0, charErrors: 0 }]));
  const misreads = [];
  for (const c of cells) {
    const pf = perField[c.field];
    pf.cells += 1; pf.chars += c.want.length;
    if (c.exact) { pf.exact += 1; continue; }
    let best = { dist: c.want.length, read: '' };
    for (const t of texts) {
      if (!t) continue;
      const s = closestStretch(c.want, t);
      if (s.dist < best.dist) best = { dist: s.dist, read: t.slice(s.start, s.end).replaceAll(USED, '·') };
    }
    pf.charErrors += Math.min(best.dist, c.want.length);
    misreads.push({ field: c.field, label: c.label, read: best.read, dist: best.dist, date: c.row.date, duty: c.row.duty });
  }
  return { perField, misreads };
}

function total(perFields) {
  const t = { cells: 0, exact: 0, chars: 0, charErrors: 0 };
  for (const pf of perFields) for (const k of Object.keys(t)) t[k] += pf[k];
  return { ...t, wordAcc: pct(t.exact, t.cells), charAcc: pct(t.chars - t.charErrors, t.chars) };
}

function summarize(files) {
  const ok = files.filter(f => !f.error);
  const perField = Object.fromEntries(OCR_FIELDS.map(f => [f, total(ok.map(x => x.perField[f]))]));
  const confidences = ok.flatMap(f => (f.confidence == null ? [] : [f.confidence]));
  return {
    files,
    errors: files.length - ok.length,
    overall: { ...total(Object.values(perField)), files: ok.length, lines: ok.reduce((n, f) => n + f.lines, 0) },
    perField,
    meanConfidence: confidences.length ? Math.round(1000 * confidences.reduce((a, b) => a + b, 0) / confidences.length) / 10 : null,
  };
}

/** Recognition model the OCR server runs (its /health; older servers do not say: the .env one). */
async function recModel() {
  const url = (process.env.OCR_SERVER_URL || 'http://127.0.0.1:8501').replace(/\/+$/, '');
  try {
    const h = await (await fetch(`${url}/health`, { signal: AbortSignal.timeout(3000) })).json();
    if (h.rec) return h.rec;
  } catch { /* server down: the run has already failed per file */ }
  return `${process.env.OCR_CUSTOM_REC || activeRecId() || 'stock'} (MinIO models/rec/active.json)`;
}

export async function runOcrBenchmark({ onEvent, shouldStop } = {}) {
  const todo = labeledImages();
  onEvent?.({ type: 'start', total: todo.length });
  const files = [];
  for (const [i, name] of todo.entries()) {
    if (shouldStop?.()) break;
    const t0 = Date.now();
    const entry = { file: name };
    try {
      const label = JSON.parse(fs.readFileSync(labelFile(LABELS, name), 'utf8'));
      const lines = await ocrLines(dataFile(DATA, name));
      const { perField, misreads } = scoreOcr(lines, label);
      const t = total(Object.values(perField));
      Object.assign(entry, {
        perField, cells: t.cells, exact: t.exact, wordAcc: t.wordAcc, charAcc: t.charAcc, lines: lines.length,
        confidence: lines.length ? lines.reduce((a, l) => a + (Number(l.confidence) || 0), 0) / lines.length : null,
        misreadCount: misreads.length, misreads: misreads.slice(0, MAX_MISREADS),
      });
    } catch (e) {
      entry.error = e.message;
    }
    entry.ms = Date.now() - t0;
    files.push(entry);
    onEvent?.({ type: 'file', file: entry, progress: { current: i + 1, total: todo.length } });
  }
  const result = summarize(files);
  result.stopped = files.length < todo.length;
  result.ocrModel = await recModel();
  onEvent?.({ type: 'done', result });
  return result;
}
