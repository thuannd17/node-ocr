#!/usr/bin/env node
/**
 * Auto-fill check: the parser that /label's Auto-fill runs (services/pdf-roster-parser.js,
 * through parsePdfFile) on every labeled text file (pdf, csv, xls, xlsx, txt), its rows
 * compared with the label. Meant for after a parser change: each run is saved and compared
 * with the previous one, and the files whose score changed are listed (a regression shows
 * at once). Labels made from Auto-fill score about 100% by themselves: the change between
 * runs is what tells; a file whose label was edited since the last run is marked so.
 *
 *   npm run label:check [-- --files] [-- --errors=N] [-- --no-save]
 *     --files     every file's score, not only the changed ones
 *     --errors=N  the first N wrong fields of each changed file (default 3)
 *     --no-save   do not keep this run as the next run's baseline
 * Image-only PDFs need the OCR server; when it is down they count as errors.
 * Results: <work>/exports/autofill-check.json (the baseline for the next run).
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { parsePdfFile, compareRows, PDF_SECTIONS } from '../services/pdf-benchmark.js';
import { listReviewedLabels, dataFile, labelFile, DATA_ROOT, LABELS_ROOT } from '../utils/data-files.js';
import { syncForScript } from '../services/media-client.js';
import { EXPORTS_DIR } from '../utils/paths.js';

// The roster data lives in MinIO: bring its local mirror (DATA_ROOT / LABELS_ROOT) up to date.
await syncForScript();

const args = process.argv.slice(2);
const showFiles = args.includes('--files');
const showErrors = Number((args.find(a => a.startsWith('--errors=')) || '--errors=3').split('=')[1]);
const OUT = path.join(EXPORTS_DIR, 'autofill-check.json');
const DATA = DATA_ROOT;
const LABELS = LABELS_ROOT;

let before = null;
try { before = JSON.parse(fs.readFileSync(OUT, 'utf8')); } catch { /* first run */ }

const names = listReviewedLabels(LABELS, 'pdf').filter(n => fs.existsSync(dataFile(DATA, n)));
const files = {};
for (const [k, name] of names.entries()) {
  process.stderr.write(`\r${k + 1}/${names.length}`);
  const labelText = fs.readFileSync(labelFile(LABELS, name), 'utf8');
  const label = JSON.parse(labelText);
  // rows only: saving again without a change (new _reviewedAt) is not an edit
  const labelHash = crypto.createHash('md5').update(JSON.stringify(PDF_SECTIONS.map(s => label[s] || []))).digest('hex');
  const total = PDF_SECTIONS.reduce((n, s) => n + (label[s] || []).length, 0);
  try {
    const pred = await parsePdfFile(dataFile(DATA, name));
    const cmp = PDF_SECTIONS.map(s => compareRows(pred[s] || [], label[s] || []));
    files[name] = {
      rows: cmp.reduce((n, c) => n + c.rowMatches, 0), total, format: pred.format, labelHash,
      errors: cmp.flatMap(c => c.errors).filter(e => e.kind === 'field').slice(0, 20).map(e => `${e.date} ${e.duty} ${e.field}: "${e.pred}" (label "${e.exp}")`),
    };
  } catch (e) {
    files[name] = { rows: 0, total, labelHash, error: e.message };
  }
}
process.stderr.write('\r');

const sum = (fs) => Object.values(fs).reduce((s, f) => [s[0] + f.rows, s[1] + f.total], [0, 0]);
const pct = ([a, b]) => `${a}/${b} rows (${b ? ((100 * a) / b).toFixed(1) : '0.0'}%)`;
const ext = (n) => n.split('.').pop().toLowerCase();

console.log(`Auto-fill (parser) vs labels: ${names.length} files, ${pct(sum(files))}`);
const exts = [...new Set(names.map(ext))].sort();
console.log(exts.map(e => `  ${e}: ${pct(sum(Object.fromEntries(Object.entries(files).filter(([n]) => ext(n) === e))))}`).join('\n'));

if (before) {
  const old = before.files || {};
  console.log(`\nAgainst the previous run (${before.at}): ${pct(sum(old))} -> ${pct(sum(files))}`);
  const changed = names.filter(n => old[n] && old[n].rows !== files[n].rows);
  const added = names.filter(n => !old[n]);
  if (!changed.length) console.log('  no file changed');
  for (const n of changed) {
    const d = files[n].rows - old[n].rows;
    // the label was edited since (in /label): the change may be the label's, not the parser's
    const edited = old[n].labelHash && old[n].labelHash !== files[n].labelHash ? '  (label edited since)' : '';
    console.log(`  ${d > 0 ? 'BETTER' : 'WORSE '} ${n}: ${old[n].rows} -> ${files[n].rows}/${files[n].total}${edited}${files[n].error ? `  ERROR ${files[n].error}` : ''}`);
    if (d < 0) for (const e of (files[n].errors || []).slice(0, showErrors)) console.log(`         ${e}`);
  }
  if (added.length) console.log(`  new labeled files: ${added.map(n => `${n} ${files[n].rows}/${files[n].total}`).join(', ')}`);
}

const bad = names.filter(n => files[n].error);
if (bad.length) console.log(`\nErrors: ${bad.map(n => `${n}: ${files[n].error}`).join('\n        ')}`);
if (showFiles) {
  console.log('');
  for (const n of names) console.log(`  ${n}  ${files[n].rows}/${files[n].total}  ${files[n].format || ''}`);
}

if (!args.includes('--no-save')) {
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify({ at: new Date().toISOString(), files }, null, 1));
}
