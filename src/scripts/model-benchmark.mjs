#!/usr/bin/env node
/**
 * The AI model over every labeled file, images and PDFs together, as /roster reads
 * them (services/model-benchmark.js). Images need the OCR server.
 *
 *   node --env-file=.env scripts/model-benchmark.mjs [--image | --pdf | --types=image,csv,...] [--json] [--files]
 *     --pdf = every text file (pdf, csv, xls, xlsx, txt); the scores are also given per file type
 */
import { runModelBenchmark, FILE_TYPES, typeOf } from '../services/model-benchmark.js';
import { syncForScript } from '../services/media-client.js';

// The roster data lives in MinIO: bring its local mirror (DATA_ROOT / LABELS_ROOT) up to date.
await syncForScript();

const args = process.argv.slice(2);
const typesArg = args.find(a => a.startsWith('--types='))?.slice(8).split(',').map(t => t.trim().toLowerCase()).filter(Boolean);
const types = typesArg || (args.includes('--image') ? ['image'] : args.includes('--pdf') ? FILE_TYPES.filter(t => t !== 'image') : FILE_TYPES);
const unknown = types.filter(t => !FILE_TYPES.includes(t));
if (unknown.length) { console.error(`Unknown file type(s): ${unknown.join(', ')} (known: ${FILE_TYPES.join(', ')})`); process.exit(1); }
const result = await runModelBenchmark({
  types,
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
console.log(line('text', result.pdf) + '  (pdf, csv, xls, xlsx, txt)');
for (const [t, s] of Object.entries(result.byType)) console.log(line(`  ${t}`, s));
console.log(`Per field (images + PDFs): ${Object.entries(result.overall.perField).map(([k, v]) => `${k} ${v.pct}%`).join(', ')}`);
console.log(`PDF-only fields: ${Object.entries(result.pdf.perField).filter(([k]) => !(k in result.overall.perField)).map(([k, v]) => `${k} ${v.pct}%`).join(', ')}`);
const byParser = result.files.filter(f => f.source === 'parser').length;
if (byParser) console.log(`${byParser} picture-only PDF(s) read by the parser on OCR text (the model cannot read them), as on /roster`);
if (result.errors) console.log(`${result.errors} file(s) failed: ${result.files.filter(f => f.error).map(f => `${f.file}: ${f.error}`).join('; ')}`);
console.log(`Note: the model learned from these labels; ${result.labelsAfterTraining} label(s) were made or changed after it was trained.`);
if (args.includes('--files')) {
  for (const f of [...result.files].sort((a, b) => (a.rowExact ?? -1) - (b.rowExact ?? -1))) {
    console.log(`  ${typeOf(f.file).padEnd(5)} ${f.file}  ${f.error ? `ERROR ${f.error}` : `${f.rowMatches}/${f.rowTotal} (${f.rowExact}%)${f.source === 'parser' ? ' [parser]' : ''}${f.afterTraining ? ' [label after training]' : ''}`}`);
  }
}
