#!/usr/bin/env node
/**
 * Scores the learned PDF extractor's row assembler (services/pdf-row-assembler.js)
 * against the labels in labels/pdf/.
 *
 *   node scripts/model-eval-assembler.mjs                       # true tags (exports/pdf-tokens): the assembler alone
 *   node scripts/model-eval-assembler.mjs --pred exports/pdf-tokens-pred/file   # tags predicted by the tagger
 *   ... --verbose   # per file, and the first differences
 *   ... --file 790407bc --all   # only files whose name starts so; every difference
 *
 * Conventions (how values are written, where dates stand, time zones) are learned
 * from the other files only, so a file never teaches itself; --in-sample learns them
 * from every file, as the trained model does (scripts/model-train.mjs).
 */
import fs from 'node:fs';
import path from 'node:path';
import { readPdfText } from '../services/pdf-text.js';
import { assembleRows, learnConventions, mergeConventions } from '../services/pdf-row-assembler.js';
import { compareRows, PDF_SECTIONS, PDF_FIELDS } from '../services/pdf-benchmark.js';
import { dataFile, labelFile } from '../utils/data-files.js';

const args = process.argv.slice(2);
const opt = (name, def) => (args.includes(name) ? args[args.indexOf(name) + 1] : def);
const goldDir = 'exports/pdf-tokens';
const predDir = opt('--pred', null);
const only = opt('--file', null);
const all = args.includes('--all');
const verbose = args.includes('--verbose') || !!only;

const names = fs.readdirSync(goldDir).filter(f => f !== 'summary.json').map(f => f.slice(0, -5)).sort();
const gold = Object.fromEntries(names.map(n => [n, JSON.parse(fs.readFileSync(path.join(goldDir, `${n}.json`), 'utf8'))]));
const labels = Object.fromEntries(names.map(n => [n, JSON.parse(fs.readFileSync(labelFile('labels', n), 'utf8'))]));
const pdfOf = {};
for (const n of names) pdfOf[n] = await readPdfText(dataFile('fake-data', n));
const conv = Object.fromEntries(names.map(n => [n, learnConventions(gold[n].pages, labels[n], pdfOf[n])]));
const inSample = args.includes('--in-sample');

let rowMatches = 0, rowTotal = 0, predCount = 0;
const perField = Object.fromEntries(PDF_FIELDS.map(f => [f, { matches: 0, total: 0 }]));
const byFormat = {};
for (const name of names) {
  if (only && !name.startsWith(only)) continue;
  if (predDir && !fs.existsSync(path.join(predDir, `${name}.json`))) continue; // not tagged in this split
  const tagPages = predDir ? JSON.parse(fs.readFileSync(path.join(predDir, `${name}.json`), 'utf8')).pages : gold[name].pages;
  const pdfPages = pdfOf[name];
  const conventions = mergeConventions(names.filter(n => inSample || n !== name).map(n => conv[n]));
  const out = assembleRows(tagPages, pdfPages, conventions);
  let fm = 0, ft = 0;
  const errs = [];
  for (const sec of PDF_SECTIONS) {
    const cmp = compareRows(out[sec], labels[name][sec] || []);
    fm += cmp.rowMatches; ft += cmp.rowTotal; predCount += cmp.predCount;
    for (const f of PDF_FIELDS) { perField[f].matches += cmp.perField[f].matches; perField[f].total += cmp.perField[f].total; }
    errs.push(...cmp.errors.map(e => ({ sec, ...e })));
  }
  rowMatches += fm; rowTotal += ft;
  const fmt = gold[name].format;
  (byFormat[fmt] ||= [0, 0]);
  byFormat[fmt][0] += fm; byFormat[fmt][1] += ft;
  if (verbose && fm < ft) {
    console.log(`${name}: ${fm}/${ft}`);
    for (const e of errs.slice(0, all ? Infinity : 6)) {
      if (e.kind === 'field') console.log(`   ${e.sec} ${e.date} ${e.duty} ${e.field}: got "${e.pred}" want "${e.exp}"`);
      else console.log(`   ${e.sec} ${e.kind}: ${JSON.stringify(e.kind === 'extra' ? e.pred : e.exp).slice(0, 160)}`);
    }
  }
}
const pct = (a, b) => (b ? `${(100 * a / b).toFixed(1)}%` : '-');
console.log(`${predDir ? `Predicted tags (${predDir})` : 'True tags'}: rows right ${rowMatches}/${rowTotal} (${pct(rowMatches, rowTotal)}), rows made ${predCount}`);
console.log(`By format: ${Object.entries(byFormat).map(([k, [a, b]]) => `${k} ${a}/${b} (${pct(a, b)})`).join(', ')}`);
console.log(`Fields: ${PDF_FIELDS.map(f => `${f} ${pct(perField[f].matches, perField[f].total)}`).join(', ')}`);
