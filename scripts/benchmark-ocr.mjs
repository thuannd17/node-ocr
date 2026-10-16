#!/usr/bin/env node
/**
 * Text recognition alone: PaddleOCR on every labeled image, its reading of each
 * labeled cell (services/ocr-benchmark.js). Needs the OCR server.
 *
 *   node --env-file=.env scripts/benchmark-ocr.mjs [--json] [--files] [--misreads=30]
 */
import { runOcrBenchmark, OCR_FIELDS } from '../services/ocr-benchmark.js';

const args = process.argv.slice(2);
const result = await runOcrBenchmark({
  onEvent: (e) => {
    if (e.type === 'file' && !args.includes('--json')) {
      const f = e.file;
      process.stderr.write(`\r${e.progress.current}/${e.progress.total} ${f.file.slice(0, 8)} ${f.error ? 'ERROR' : `${f.exact}/${f.cells}`}      `);
    }
  },
});
if (args.includes('--json')) { console.log(JSON.stringify(result, null, 2)); process.exit(0); }
process.stderr.write('\n');

const o = result.overall;
console.log(`OCR recognition model: ${result.ocrModel}`);
console.log(`${o.files} images, ${o.lines} OCR lines, mean confidence ${result.meanConfidence ?? '-'}%`);
console.log(`Cells read exactly: ${o.exact}/${o.cells} (${o.wordAcc ?? '-'}%)   characters right: ${o.charAcc ?? '-'}%`);
console.log(`Per field: ${OCR_FIELDS.map(f => `${f} ${result.perField[f].wordAcc ?? '-'}% (chars ${result.perField[f].charAcc ?? '-'}%)`).join(', ')}`);
if (result.errors) console.log(`${result.errors} image(s) failed: ${result.files.filter(f => f.error).map(f => `${f.file}: ${f.error}`).join('; ')}`);
if (args.includes('--files')) {
  for (const f of [...result.files].sort((a, b) => (a.wordAcc ?? -1) - (b.wordAcc ?? -1))) {
    console.log(`  ${f.file}  ${f.error ? `ERROR ${f.error}` : `${f.exact}/${f.cells} (${f.wordAcc}%, chars ${f.charAcc}%)`}`);
  }
}
const show = Number((args.find(a => a.startsWith('--misreads=')) || '--misreads=30').split('=')[1]);
const misreads = result.files.flatMap(f => (f.misreads || []).map(m => ({ file: f.file, ...m })));
if (show && misreads.length) console.log(`\nFirst ${Math.min(show, misreads.length)} misread cells:`);
for (const m of misreads.slice(0, show)) console.log(`  ${m.file.slice(0, 8)} ${m.date} ${m.field}: label "${m.label}" -> OCR "${m.read}"`);
