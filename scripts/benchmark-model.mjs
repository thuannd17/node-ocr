#!/usr/bin/env node
/**
 * The AI model over every labeled file, images and PDFs together, as /upload reads
 * them (services/model-benchmark.js). Images need the OCR server.
 *
 *   node --env-file=.env scripts/benchmark-model.mjs [--image | --pdf] [--json] [--files]
 */
import { runModelBenchmark } from '../services/model-benchmark.js';

const args = process.argv.slice(2);
const kinds = args.includes('--image') ? ['image'] : args.includes('--pdf') ? ['pdf'] : ['image', 'pdf'];
const result = await runModelBenchmark({
  kinds,
  onEvent: (e) => {
    if (e.type === 'file' && !args.includes('--json')) {
      const f = e.file;
      process.stderr.write(`\r${e.progress.current}/${e.progress.total} ${f.kind} ${f.file.slice(0, 8)} ${f.error ? 'ERROR' : `${f.rowMatches}/${f.rowTotal}`}      `);
    }
  },
});
if (args.includes('--json')) { console.log(JSON.stringify(result, null, 2)); process.exit(0); }
process.stderr.write('\n');

const line = (name, s) => `${name.padEnd(8)} ${String(s.files).padStart(4)} files  rows exactly right ${s.rowMatches}/${s.rowTotal} (${s.rowExact ?? '-'}%)  rows made ${s.predCount}`;
console.log(`AI model trained ${result.model.trainedAt || '?'} on ${result.model.files ?? '?'} files`);
console.log(line('overall', result.overall));
console.log(line('images', result.image));
console.log(line('PDFs', result.pdf));
console.log(`Per field (images + PDFs): ${Object.entries(result.overall.perField).map(([k, v]) => `${k} ${v.pct}%`).join(', ')}`);
console.log(`PDF-only fields: ${Object.entries(result.pdf.perField).filter(([k]) => !(k in result.overall.perField)).map(([k, v]) => `${k} ${v.pct}%`).join(', ')}`);
const byParser = result.files.filter(f => f.source === 'parser').length;
if (byParser) console.log(`${byParser} picture-only PDF(s) read by the parser on OCR text (the model cannot read them), as on /upload`);
if (result.errors) console.log(`${result.errors} file(s) failed: ${result.files.filter(f => f.error).map(f => `${f.file}: ${f.error}`).join('; ')}`);
console.log(`Note: the model learned from these labels; ${result.labelsAfterTraining} label(s) were made or changed after it was trained.`);
if (args.includes('--files')) {
  for (const f of [...result.files].sort((a, b) => (a.rowExact ?? -1) - (b.rowExact ?? -1))) {
    console.log(`  ${f.kind.padEnd(5)} ${f.file}  ${f.error ? `ERROR ${f.error}` : `${f.rowMatches}/${f.rowTotal} (${f.rowExact}%)${f.source === 'parser' ? ' [parser]' : ''}${f.afterTraining ? ' [label after training]' : ''}`}`);
  }
}
