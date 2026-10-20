#!/usr/bin/env node
/**
 * The AI model over every labeled ACARS picture, as /acars reads them (services/acars-benchmark.js).
 * Needs the OCR server.
 *
 *   node --env-file=.env scripts/acars-benchmark.mjs [--json] [--files]
 */
import { runAcarsBenchmark } from '../services/acars-benchmark.js';
import { acars } from '../services/media-client.js';

await acars.syncForScript();

const args = process.argv.slice(2);
const result = await runAcarsBenchmark({
  onEvent: (e) => {
    if (e.type === 'file' && !args.includes('--json')) {
      const f = e.file;
      process.stderr.write(`\r${e.progress.current}/${e.progress.total} ${f.file.slice(0, 30).padEnd(30)} ${f.error ? 'ERROR' : `${f.fieldsRight}/${f.fieldTotal}`}      `);
    }
  },
});
if (args.includes('--json')) { console.log(JSON.stringify(result, null, 2)); process.exit(0); }
process.stderr.write('\n');
console.log(`AI model trained ${result.model.trainedAt || '?'} on ${result.model.acars ?? '?'} ACARS pictures`);
console.log(`Fields right: ${result.fieldMatches}/${result.fieldTotal} (${result.fieldPct ?? '-'}%), pictures fully right: ${result.allRight}/${result.pictures}`);
console.log(`Per field: ${Object.entries(result.perField).map(([k, v]) => `${k} ${v.pct ?? '-'}%`).join(', ')}`);
if (result.errors) console.log(`${result.errors} picture(s) failed: ${result.files.filter(f => f.error).map(f => `${f.file}: ${f.error}`).join('; ')}`);
console.log(`Note: the model learned from these labels; ${result.labelsAfterTraining} label(s) were made or changed after it was trained.`);
if (args.includes('--files')) {
  for (const f of [...result.files].sort((a, b) => (a.fieldsRight ?? -1) - (b.fieldsRight ?? -1))) {
    console.log(`  ${f.file}  ${f.error ? `ERROR ${f.error}` : `${f.fieldsRight}/${f.fieldTotal}`}${f.diffs?.length ? `  ${f.diffs.map(d => `${d.field}: ${d.pred || '-'} != ${d.exp || '-'}`).join('; ')}` : ''}`);
  }
}
