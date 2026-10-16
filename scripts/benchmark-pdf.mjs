#!/usr/bin/env node
/**
 * Score the PDF duty-plan parser against labels/pdf/ (verified on /upload or /label).
 *
 *   npm run benchmark:pdf [-- --json] [-- --errors=30]
 */
import path from 'node:path';
import { runPdfBenchmark, PDF_FIELDS } from '../services/pdf-benchmark.js';

const args = process.argv.slice(2);
const showErrors = Number((args.find(a => a.startsWith('--errors=')) || '--errors=30').split('=')[1]);
const result = await runPdfBenchmark({ pdfDir: path.resolve('fake-data'), labelsDir: path.resolve('labels') });

if (args.includes('--json')) {
  console.log(JSON.stringify(result, null, 2));
} else if (!result.labeledCount) {
  console.log('No labeled PDFs yet: open /upload, check a PDF and press "Save as Label".');
} else {
  const pct = (m, t) => (t ? (100 * m / t).toFixed(1) : '0.0');
  console.log(`Labeled PDFs: ${result.labeledCount}`);
  console.log(`Rows exactly right: ${result.rowMatches}/${result.rowTotal} (${pct(result.rowMatches, result.rowTotal)}%)`);
  console.log('Per field: ' + PDF_FIELDS.map(f => `${f} ${pct(result.perField[f].matches, result.perField[f].total)}%`).join(', '));
  for (const f of result.files) {
    if (f.error) { console.log(`  ${f.file}: ERROR ${f.error} (0/${f.rowTotal} rows)`); continue; }
    const secs = Object.entries(f.sections).map(([k, v]) => `${k} ${v.rowMatches}/${v.rowTotal}`).join(', ');
    console.log(`  ${f.file}: ${f.rowMatches}/${f.rowTotal} rows (${secs}; parser gave ${f.predCount})`);
  }
  const errors = result.files.flatMap(f => f.errors.map(e => ({ file: f.file, ...e })));
  if (errors.length) console.log(`\nFirst ${Math.min(showErrors, errors.length)} of ${errors.length} differences:`);
  for (const e of errors.slice(0, showErrors)) {
    const where = `${e.file} [${e.section}]`;
    if (e.kind === 'field') console.log(`  ${where} | ${e.date} ${e.duty} | ${e.field}: "${e.pred}" (label "${e.exp}")`);
    else if (e.kind === 'missing') console.log(`  ${where} | missing row ${e.exp.date} ${e.exp.duty}`);
    else console.log(`  ${where} | extra row ${e.pred.date} ${e.pred.duty}`);
  }
}
