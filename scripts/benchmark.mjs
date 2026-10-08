/**
 * CLI benchmark runner (single-worker stability mode).
 *
 * Usage:
 *   npm run benchmark -- --strategy=paddleocr
 *   npm run benchmark -- --strategy=vlm --json
 *   npm run benchmark -- --no-dedupe   (score every file, even byte-identical copies)
 *   npm run benchmark -- --split=val   (only images held out of recognition training)
 *   npm run benchmark -- --split=val --folds=5 --fold=2 --fold-map=exports/kfold/<id>/folds.json
 *     (held-out fold of a k-fold build; pass the run's fold map so the split matches training)
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
    json: args.includes('--json'),
    // fake-data/ holds many byte-identical copies; score each image once by default.
    dedupe: !args.includes('--no-dedupe'),
    split: get('split', 'all'),
    trainRatio: Number(get('train-ratio', '0.8')),
    folds: Number(get('folds', '0')),
    fold: Number(get('fold', '0')),
    foldMapPath: get('fold-map', null),
  };
}

async function main() {
  const opts = parseArgs();
  const result = await runBenchmark({
    strategy: opts.strategy,
    folderPath: opts.folderPath,
    labelsPath: opts.labelsPath,
    dedupe: opts.dedupe,
    split: opts.split,
    trainRatio: opts.trainRatio,
    folds: opts.folds,
    fold: opts.fold,
    foldMap: opts.foldMapPath ? JSON.parse(fs.readFileSync(path.resolve(opts.foldMapPath), 'utf8')) : null,
  });

  if (opts.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  console.log(`\n📊 Benchmark complete`);
  console.log(`   Strategy: ${result.strategy}`);
  console.log(`   Labeled: ${result.labeledCount}`);
  console.log(`   Split: ${result.split}`);
  console.log(`   Row exact match: ${Math.round((result.aggregate?.rowExactMatchRate || 0) * 100)}%`);
  for (const [sec, s] of Object.entries(result.aggregate?.perSection || {})) {
    console.log(`   ${sec}: rows ${s.rowMatches}/${s.rowTotal} exact (${(s.rowExactMatchRate * 100).toFixed(1)}%), rows found ${s.predRows}/${s.expRows}, table missed in ${s.filesTableMissed}/${s.filesWithTable} files`);
  }
  console.log(`   Mode: single-worker stability`);

  if (Array.isArray(result.errorInsights) && result.errorInsights.length > 0) {
    console.log(`\n   Top issues:`);
    for (const s of result.errorInsights) console.log(`   - ${s}`);
  }
}

main().catch(err => {
  console.error('Benchmark failed:', err.message);
  process.exit(1);
});

