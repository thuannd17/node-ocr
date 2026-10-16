#!/usr/bin/env node
/**
 * Draft labels for rosters exported as CSV / XLS / XLSX / TXT: the parser's rows
 * (services/pdf-roster-parser.js, which reads table files by their column headers
 * through services/table-roster-parser.js) are written to labels/<ext>/<file>.json
 * for every such file in fake-data/ that has no label yet. A label already there
 * (checked by a person in /label) is never touched.
 *
 *   node scripts/auto-label-tables.mjs [--dry] [--redo-auto]
 *     --redo-auto: also rewrite labels this script wrote before (`_autoLabel`, never saved in /label)
 *
 * The labels carry `_autoLabel: 'parser'` and `_reviewedByUser: false`; /label
 * says so until the file is checked and saved there. Files the parser reads no
 * rows from are listed and left without a label.
 */
import fs from 'node:fs';
import path from 'node:path';
import { parsePdfFile, PDF_FIELDS } from '../services/pdf-benchmark.js';
import { TABLE_EXTS } from '../services/table-text.js';
import { listData, dataFile, labelFile, hasLabel, extOf } from '../utils/data-files.js';

const dry = process.argv.includes('--dry');
const redoAuto = process.argv.includes('--redo-auto');
const isAuto = (name) => { try { return !!JSON.parse(fs.readFileSync(labelFile(LABELS, name), 'utf8'))._autoLabel; } catch { return false; } };
const DATA = path.resolve('fake-data');
const LABELS = path.resolve('labels');

const names = listData(DATA, 'pdf').filter(n => TABLE_EXTS.includes(extOf(n)));
let written = 0;
for (const name of names) {
  if (hasLabel(LABELS, name) && !(redoAuto && isAuto(name))) { console.log(`  labeled   ${name}`); continue; }
  let result;
  try {
    result = await parsePdfFile(dataFile(DATA, name));
  } catch (e) {
    console.log(`  ERROR     ${name}: ${e.message}`);
    continue;
  }
  const rows = (result.published?.length || 0) + (result.planned?.length || 0);
  if (!rows) { console.log(`  no rows   ${name} (layout not read: label it by hand in /label)`); continue; }
  const clean = (list) => (list || []).map(r => Object.fromEntries(PDF_FIELDS.map(f => [f, String(r?.[f] ?? '').trim()])));
  const label = {
    period: result.period || null,
    published: clean(result.published),
    planned: clean(result.planned),
    _reviewedByUser: false,
    _autoLabel: 'parser',
    _format: result.format,
    _autoAt: new Date().toISOString(),
  };
  if (!dry) {
    fs.mkdirSync(path.dirname(labelFile(LABELS, name)), { recursive: true });
    fs.writeFileSync(labelFile(LABELS, name), JSON.stringify(label, null, 2), 'utf8');
  }
  written += 1;
  console.log(`  ${dry ? 'would add' : 'added    '} ${name}  ${result.format}  ${label.published.length} + ${label.planned.length} rows`);
}
console.log(`\n${written} draft label(s) ${dry ? 'to write' : 'written'} of ${names.length} CSV/Excel/TXT files.`);
