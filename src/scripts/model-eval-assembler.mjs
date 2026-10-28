#!/usr/bin/env node
/**
 * Scores the learned PDF extractor's row assembler (services/pdf-row-assembler.js)
 * against the labels in labels/pdf/.
 *
 *   node scripts/model-eval-assembler.mjs                       # true tags (<work>/exports/pdf-tokens): the assembler alone
 *   node scripts/model-eval-assembler.mjs --pred <work>/exports/pdf-tokens-pred/file   # tags predicted by the tagger
 *   ... --verbose   # per file, and the first differences
 *   ... --file 790407bc --all   # only files whose name starts so; every difference
 *   ... --format jaa-logbook    # only files of one layout (+ --quick: learn from that layout alone, faster)
 *   ... --json out.json         # save the scores (per format, per file) to compare runs
 *   ... --compare old.json      # print per-format changes against a saved run
 *
 * With true tags the score is the model's ceiling: the tagger can only lose rows
 * from there. "core" = rows right on date, day, duty, dep, begin, end, arr (the
 * fields every roster has); "rows" = all 14 fields exact.
 *
 * Conventions (how values are written, where dates stand, time zones) are learned
 * from the other files only, so a file never teaches itself; --in-sample learns them
 * from every file, as the trained model does (scripts/model-train.mjs).
 *
 * Text read from the files is cached in <work>/exports/eval-pdftext-cache.json,
 * keyed by file content and by the code that reads it (pdf-text.js, table-text.js).
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { readPdfText } from '../services/pdf-text.js';
import { assembleRows, learnConventions, mergeConventions } from '../services/pdf-row-assembler.js';
import { compareRows, PDF_SECTIONS, PDF_FIELDS } from '../services/pdf-benchmark.js';
import { dataFile, labelFile, DATA_ROOT, LABELS_ROOT } from '../utils/data-files.js';
import { syncForScript } from '../services/media-client.js';
import { EXPORTS_DIR, SRC_DIR } from '../utils/paths.js';

// The roster data lives in MinIO: bring its local mirror (DATA_ROOT / LABELS_ROOT) up to date.
await syncForScript();

const args = process.argv.slice(2);
const opt = (name, def) => (args.includes(name) ? args[args.indexOf(name) + 1] : def);
const goldDir = path.join(EXPORTS_DIR, 'pdf-tokens');
const predDir = opt('--pred', null);
const only = opt('--file', null);
const onlyFormat = opt('--format', null);
const jsonOut = opt('--json', null);
const compareTo = opt('--compare', null);
const all = args.includes('--all');
const verbose = args.includes('--verbose') || !!only || !!onlyFormat;
const inSample = args.includes('--in-sample');

const md5 = (buf) => crypto.createHash('md5').update(buf).digest('hex');
// layout as the parser recognizes it (token files say 'unknown' where the label, not the parser, gave the tags)
const summary = JSON.parse(fs.readFileSync(path.join(goldDir, 'summary.json'), 'utf8'));
const formatOf = Object.fromEntries((summary.files || []).map(f => [f.file, f.format || 'unknown']));
// (--quick with --format: only that layout's files are read and learned from, minutes faster while working on one layout)
const quick = args.includes('--quick') && onlyFormat;
const names = fs.readdirSync(goldDir).filter(f => f !== 'summary.json').map(f => f.slice(0, -5)).sort()
  .filter(n => !quick || formatOf[n] === onlyFormat);
const gold = Object.fromEntries(names.map(n => [n, JSON.parse(fs.readFileSync(path.join(goldDir, `${n}.json`), 'utf8'))]));
const labels = Object.fromEntries(names.map(n => [n, JSON.parse(fs.readFileSync(labelFile(LABELS_ROOT, n), 'utf8'))]));
const fmtOf = (n) => formatOf[n] || gold[n].format || 'unknown';

// Text of every file, cached between runs.
const readerVersion = md5(['pdf-text.js', 'table-text.js'].map(f => fs.readFileSync(path.join(SRC_DIR, 'services', f), 'utf8')).join('|'));
const cachePath = path.join(EXPORTS_DIR, 'eval-pdftext-cache.json');
let cache = {};
try { cache = JSON.parse(fs.readFileSync(cachePath, 'utf8')); } catch { /* first run */ }
if (cache.readerVersion !== readerVersion) cache = { readerVersion, files: {} };
const pdfOf = {};
let fresh = 0;
for (const n of names) {
  const buf = fs.readFileSync(dataFile(DATA_ROOT, n));
  const key = md5(buf);
  const hit = cache.files[n];
  if (hit && hit.key === key) pdfOf[n] = hit.pages;
  else { pdfOf[n] = await readPdfText(dataFile(DATA_ROOT, n)); cache.files[n] = { key, pages: pdfOf[n] }; fresh++; }
}
if (!quick) for (const n of Object.keys(cache.files)) if (!gold[n]) delete cache.files[n];
if (fresh) fs.writeFileSync(cachePath, JSON.stringify(cache));

const conv = Object.fromEntries(names.map(n => [n, learnConventions(gold[n].pages, labels[n], pdfOf[n])]));
const mergedAll = inSample ? mergeConventions(names.map(n => conv[n])) : null;

let rowMatches = 0, coreMatches = 0, rowTotal = 0, predCount = 0;
const perField = Object.fromEntries(PDF_FIELDS.map(f => [f, { matches: 0, total: 0 }]));
const byFormat = {};
const perFile = {};
for (const name of names) {
  if (only && !name.startsWith(only)) continue;
  if (onlyFormat && fmtOf(name) !== onlyFormat) continue;
  if (predDir && !fs.existsSync(path.join(predDir, `${name}.json`))) continue; // not tagged in this split
  const tagPages = predDir ? JSON.parse(fs.readFileSync(path.join(predDir, `${name}.json`), 'utf8')).pages : gold[name].pages;
  const conventions = mergedAll || mergeConventions(names.filter(n => n !== name).map(n => conv[n]));
  const out = assembleRows(tagPages, pdfOf[name], conventions);
  let fm = 0, fc = 0, ft = 0, fp = 0;
  const errs = [];
  for (const sec of PDF_SECTIONS) {
    const cmp = compareRows(out[sec], labels[name][sec] || []);
    fm += cmp.rowMatches; fc += cmp.coreRowMatches; ft += cmp.rowTotal; fp += cmp.predCount;
    for (const f of PDF_FIELDS) { perField[f].matches += cmp.perField[f].matches; perField[f].total += cmp.perField[f].total; }
    errs.push(...cmp.errors.map(e => ({ sec, ...e })));
  }
  rowMatches += fm; coreMatches += fc; rowTotal += ft; predCount += fp;
  const fmt = fmtOf(name);
  const b = (byFormat[fmt] ||= { files: 0, rows: 0, core: 0, total: 0, made: 0 });
  b.files++; b.rows += fm; b.core += fc; b.total += ft; b.made += fp;
  perFile[name] = { format: fmt, rows: fm, core: fc, total: ft, made: fp };
  if (verbose && fm < ft) {
    console.log(`${name} [${fmt}]: rows ${fm}/${ft}, core ${fc}/${ft}, made ${fp}`);
    for (const e of errs.slice(0, all ? Infinity : 6)) {
      if (e.kind === 'field') console.log(`   ${e.sec} ${e.date} ${e.duty} ${e.field}: got "${e.pred}" want "${e.exp}"`);
      else console.log(`   ${e.sec} ${e.kind}: ${JSON.stringify(e.kind === 'extra' ? e.pred : e.exp).slice(0, 160)}`);
    }
  }
}
const pct = (a, b) => (b ? `${(100 * a / b).toFixed(1)}%` : '-');
console.log(`${predDir ? `Predicted tags (${predDir})` : 'True tags'}${inSample ? ', in-sample conventions' : ''}: rows right ${rowMatches}/${rowTotal} (${pct(rowMatches, rowTotal)}), core right ${coreMatches}/${rowTotal} (${pct(coreMatches, rowTotal)}), rows made ${predCount}`);
const old = compareTo ? JSON.parse(fs.readFileSync(compareTo, 'utf8')) : null;
console.log(`By format (most rows lost first):${old ? '   [change vs ' + compareTo + ']' : ''}`);
for (const [k, b] of Object.entries(byFormat).sort((a, c) => (c[1].total - c[1].rows) - (a[1].total - a[1].rows))) {
  const o = old?.byFormat?.[k];
  const delta = o ? `   rows ${b.rows - o.rows >= 0 ? '+' : ''}${b.rows - o.rows}, core ${b.core - o.core >= 0 ? '+' : ''}${b.core - o.core}` : '';
  console.log(`  ${k.padEnd(26)} files ${String(b.files).padStart(3)}  rows ${`${b.rows}/${b.total}`.padEnd(12)} ${pct(b.rows, b.total).padStart(6)}  core ${pct(b.core, b.total).padStart(6)}  lost ${String(b.total - b.rows).padStart(5)}  made ${b.made}${delta}`);
}
if (old) console.log(`Total change: rows ${rowMatches - old.rowMatches >= 0 ? '+' : ''}${rowMatches - old.rowMatches}, core ${coreMatches - old.coreMatches >= 0 ? '+' : ''}${coreMatches - old.coreMatches}`);
console.log(`Fields: ${PDF_FIELDS.map(f => `${f} ${pct(perField[f].matches, perField[f].total)}`).join(', ')}`);
if (jsonOut) {
  fs.writeFileSync(jsonOut, JSON.stringify({ at: new Date().toISOString(), pred: predDir, inSample, rowMatches, coreMatches, rowTotal, predCount, byFormat, perField, perFile }, null, 1));
  console.log(`Saved ${jsonOut}`);
}
