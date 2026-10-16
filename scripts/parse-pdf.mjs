#!/usr/bin/env node
/**
 * Print the rows parsed from NetLine/Crew duty-plan PDFs.
 *
 *   node [--env-file=.env] scripts/parse-pdf.mjs <file.pdf | folder> [--json]
 * Image-only PDFs are read with OCR: the OCR server must be running.
 */
import fs from 'node:fs';
import path from 'node:path';
import { parsePdfFile } from '../services/pdf-benchmark.js';

const args = process.argv.slice(2);
const json = args.includes('--json');
const target = args.find(a => !a.startsWith('--')) || 'fake-data/pdf';
const files = fs.statSync(target).isDirectory()
  ? fs.readdirSync(target).filter(f => /\.(pdf|csv|xlsx?|txt)$/i.test(f)).sort().map(f => path.join(target, f))
  : [target];

const COLS = ['date', 'day', 'dc', 'duty', 'registration', 'dep', 'begin', 'end', 'arr', 'ac', 'crew', 'info'];
const out = {};
for (const file of files) {
  const result = await parsePdfFile(file); // OCR (needs the OCR server) when the PDF has no text layer
  out[path.basename(file)] = result;
  if (json) continue;
  console.log(`\n=== ${path.basename(file)}  period ${result.period}  published ${result.published.length} rows, planned ${result.planned.length} rows${result.readMode === 'ocr' ? '  (read by OCR)' : ''}${result.recognized ? '' : '  (layout NOT recognized)'}`);
  for (const n of result.notices || []) console.log(`  ! ${n}`);
  const all = [...result.published, ...result.planned];
  const widths = COLS.map(c => Math.min(c === 'info' || c === 'crew' ? 60 : 16, Math.max(c.length, ...all.map(r => String(r[c] || '').length))));
  for (const sec of ['published', 'planned']) {
    if (!result[sec].length) continue;
    console.log(`--- ${sec}`);
    console.log(COLS.map((c, i) => c.padEnd(widths[i])).join(' '));
    for (const r of result[sec]) console.log(COLS.map((c, i) => String(r[c] || '').slice(0, widths[i]).padEnd(widths[i])).join(' '));
  }
}
if (json) console.log(JSON.stringify(out, null, 2));
