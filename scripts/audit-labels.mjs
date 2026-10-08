/**
 * Audit stale/wrong labels by comparing current labels against OCR + parser output.
 *
 * Usage:
 *   npm run audit-labels
 *   npm run audit-labels -- --strategy=paddleocr --top=20
 *   npm run audit-labels -- --json
 */
import fs from 'node:fs';
import path from 'node:path';
import { runBenchmark } from '../services/benchmark.js';

function parseArgs() {
  const args = process.argv.slice(2);
  const get = (name, fallback = null) => {
    const hit = args.find(a => a.startsWith(`--${name}=`));
    return hit ? hit.split('=')[1] : fallback;
  };
  return {
    strategy: get('strategy', 'paddleocr'),
    folderPath: get('folder', path.resolve(process.cwd(), 'fake-data')),
    labelsPath: get('labels', path.resolve(process.cwd(), 'labels')),
    top: Math.max(1, Number(get('top', 20)) || 20),
    minRowMismatch: Number(get('min-row-mismatch', 0.25)) || 0.25,
    minFieldErrors: Number(get('min-field-errors', 3)) || 3,
    maxConfidence: Number(get('max-confidence', 0.85)) || 0.85,
    json: args.includes('--json'),
  };
}

function summarizeFile(r) {
  if (r.error) {
    return {
      file: r.file,
      staleScore: 1,
      rowExact: 0,
      rowMismatchRate: 1,
      fieldErrors: 999,
      reason: r.error,
      published: r.sections?.published,
      planned: r.sections?.planned,
    };
  }

  const pub = r.sections.published;
  const plan = r.sections.planned;
  const rowMatches = pub.rowMatches + plan.rowMatches;
  const rowTotal = pub.rowTotal + plan.rowTotal;
  const rowMismatchRate = rowTotal > 0 ? 1 - rowMatches / rowTotal : 1;
  const fieldErrors = (pub.rowErrors?.length || 0) + (plan.rowErrors?.length || 0);
  const fieldErrorRate = rowTotal > 0 ? fieldErrors / rowTotal : fieldErrors;
  const staleScore = Math.min(1, rowMismatchRate * 0.6 + Math.min(1, fieldErrorRate / 8) * 0.4);
  const confidence = Math.max(0, 1 - staleScore);

  return {
    file: r.file,
    staleScore,
    confidence,
    rowExact: rowTotal > 0 ? rowMatches / rowTotal : 0,
    rowMismatchRate,
    fieldErrors,
    published: { predCount: pub.predCount, expCount: pub.expCount },
    planned: { predCount: plan.predCount, expCount: plan.expCount },
    errorInsights: [...new Set([...(pub.rowErrors || []), ...(plan.rowErrors || [])].map(e => `${e.field}:${e.errorType}`))].slice(0, 5),
  };
}

function isSuspicious(s, opts) {
  return s.rowMismatchRate >= opts.minRowMismatch || s.fieldErrors >= opts.minFieldErrors || s.confidence <= opts.maxConfidence;
}

async function main() {
  const opts = parseArgs();
  if (!fs.existsSync(opts.folderPath)) {
    throw new Error(`fake-data folder not found: ${opts.folderPath}`);
  }
  if (!fs.existsSync(opts.labelsPath)) {
    throw new Error(`labels folder not found: ${opts.labelsPath}`);
  }

  const benchmark = await runBenchmark({
    strategy: opts.strategy,
    folderPath: opts.folderPath,
    labelsPath: opts.labelsPath,
  });

  const scored = (benchmark.files || [])
    .map(summarizeFile)
    .filter(Boolean)
    .sort((a, b) => (b.staleScore - a.staleScore) || (b.fieldErrors - a.fieldErrors));

  const suspicious = scored.filter(s => isSuspicious(s, opts)).slice(0, opts.top);

  const result = {
    strategy: benchmark.strategy,
    labeledCount: benchmark.labeledCount,
    totalFiles: benchmark.files?.length || 0,
    suspiciousCount: suspicious.length,
    suspicious,
  };

  if (opts.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  console.log(`\n🧪 Stale/Wrong Label Audit`);
  console.log(`   Strategy: ${result.strategy}`);
  console.log(`   Labeled files: ${result.labeledCount}`);
  console.log(`   Suspicious: ${result.suspiciousCount}`);
  console.log(`\n   Top ${suspicious.length} suspect labels:`);

  for (const [i, s] of suspicious.entries()) {
    console.log(
      `   ${String(i + 1).padStart(2, '0')}. ${s.file}` +
      ` | score=${s.staleScore.toFixed(2)}` +
      ` | rowExact=${(s.rowExact * 100).toFixed(1)}%` +
      ` | rowMismatch=${(s.rowMismatchRate * 100).toFixed(1)}%` +
      ` | fieldErrors=${s.fieldErrors}`
    );
    if (s.errorInsights?.length) {
      console.log(`       hints: ${s.errorInsights.join(', ')}`);
    }
  }
}

main().catch(err => {
  console.error('Audit failed:', err.message);
  process.exit(1);
});


