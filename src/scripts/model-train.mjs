#!/usr/bin/env node
/**
 * Retrains the learned roster extractor (the AI model /roster and /acars use) from every
 * label, PDFs, images and ACARS pictures (the /models page's "Train" runs this too):
 *   1. training words from the labels (scripts/build-pdf-token-data.mjs for labels/pdf/,
 *      scripts/build-image-token-data.mjs for image labels, scripts/build-acars-token-data.mjs for the
 *      ACARS pictures' labels: OCR lines are cached in <work>/exports/ocr-lines/ and ocr-lines-acars/, so only pictures
 *      new since the last run need the OCR server)
 *   2. what the labels teach about layouts (conventions.json: column-header words, where dates
 *      stand, how values are written; services/pdf-row-assembler.js learnConventions)
 *   3. the word tagger (scripts/train_pdf_tagger.py --no-eval, with those header words) -> <models mirror>/ai/.next/
 *   4. .next -> a new version models/ai/<id>/, uploaded to MinIO, and benchmarked (services/model-benchmark.js)
 *   5. activated only when it reads the files the active version read about as well, no layout losing
 *      many rows (services/model-gate.js); else the active version stays and /models can switch by hand
 *      (earlier versions are kept: /models lists them, activates another one or deletes one; services/ai-models.js)
 * Before step 2, the training words are checked: many more words tagged with a value their label row
 * does not have than the active version was trained with stops the run (a bug in step 1 costs no hour of training).
 * Training words go to <ROSTER_WORK_DIR>/exports/ (utils/paths.js).
 *
 * Step 2 learns each file again only when its words, label, file or the assembler changed (the rest from
 * <work>/exports/conventions-cache.json). Step 3 is incremental unless --full: the stage-1 fields the active version
 * was trained with are reused (stage1-oof.joblib; train_pdf_tagger.py says when a run must be full anyway).
 *
 * First of all: when the labels, their files and the training code are those the active version was trained on
 * (services/train-inputs.js), the run would make the same model again: it stops there, no version made.
 *
 *   node scripts/model-train.mjs [--no-check] [--full | --conventions-only] [--force]
 *     --no-check: neither check stops anything; the new version is activated as soon as it is trained
 *     --full: the word tagger trained from nothing (its 5 fits), not from the active version's saved stage-1 fields
 *     --conventions-only: the conventions learned again, the active version's word tagger kept as it is (minutes)
 *     --force: train even when nothing changed since the active version
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { learnConventions, mergeConventions } from '../services/pdf-row-assembler.js';
import { PYTHON } from '../services/pdf-ai-extract.js';
import { AI_DIR, newVersionDir, activateModel, publishModel, syncModels, activeId, activeModelDir } from '../services/ai-models.js';
import { runModelBenchmark, FILE_TYPES } from '../services/model-benchmark.js';
import { listRuns } from '../services/benchmark-history.js';
import { suspectGrowth, compareRuns } from '../services/model-gate.js';
import { EXPORTS_DIR } from '../utils/paths.js';
import { labelFile, dataFile, extOf, PDF_EXTS, DATA_ROOT, LABELS_ROOT, ACARS_DATA_ROOT, ACARS_LABELS_ROOT } from '../utils/data-files.js';
import { readPdfText } from '../services/pdf-text.js';
import { ROOT } from '../utils/paths.js';
import { syncForScript, acars } from '../services/media-client.js';
import { trainingInputs, inputChanges } from '../services/train-inputs.js';

// The roster data lives in MinIO: bring its local mirror (DATA_ROOT / LABELS_ROOT) up to date.
await syncForScript();
await acars.syncForScript();
await syncModels({ force: true });

const CHECK = !process.argv.includes('--no-check');
const FULL = process.argv.includes('--full');
const CONVENTIONS_ONLY = process.argv.includes('--conventions-only');
// a file's conventions by what they were learned from (step 2)
const CONV_CACHE = path.join(EXPORTS_DIR, 'conventions-cache.json');
const TOKENS = path.join(EXPORTS_DIR, 'pdf-tokens');
const NEXT = path.join(AI_DIR, '.next');

// training files per type as /benchmark counts them: every picture is 'image', a text file its extension
const countByType = (names) => {
  const out = Object.fromEntries(['image', ...PDF_EXTS].map(t => [t, 0]));
  for (const n of names) out[PDF_EXTS.includes(extOf(n)) ? extOf(n) : 'image'] += 1;
  return out;
};

const run = (cmd, args) => new Promise((resolve, reject) => {
  const child = spawn(cmd, args, { cwd: ROOT, windowsHide: true });
  const show = d => String(d).split('\n').filter(l => l.trim() && !/Warning|trace-warnings|warnings.warn/.test(l)).forEach(l => console.log(`  ${l}`));
  child.stdout.on('data', show);
  child.stderr.on('data', show);
  child.on('error', reject);
  child.on('close', code => (code === 0 ? resolve() : reject(new Error(`${path.basename(args[args.length > 1 ? 1 : 0])} failed (${code})`))));
});

const t0 = Date.now();
// "2/4 Conventions" lines (and the "[PDF 12/300]" / "[fields 3/24]" ones of the steps) are the /models page's progress
let stepAt = t0;
// seconds each step took (meta.json stepSeconds: /models shows them beside the training time)
const stepSeconds = {};
let stepKey = null;
const STEP_KEYS = { 1: 'words', 2: 'conventions', 3: 'tagger', 4: 'benchmark', 5: 'activate' };
const mmss = (ms) => `${Math.floor(ms / 60000)}m ${String(Math.round(ms / 1000) % 60).padStart(2, '0')}s`;
const step = (text) => {
  if (text.startsWith('1/')) console.log(`Runs on the CPU (${os.cpus().length} cores): the word tagger is scikit-learn, which has no GPU mode; only "Train" of the OCR model uses a GPU.`);
  else console.log(`  (${mmss(Date.now() - stepAt)})`);
  if (stepKey) stepSeconds[stepKey] = Math.round((Date.now() - stepAt) / 1000);
  stepKey = STEP_KEYS[text.split('/')[0]] || null;
  stepAt = Date.now();
  console.log(text);
};
// Anything new to learn since the active version?
const activeMeta = (() => { try { return JSON.parse(fs.readFileSync(path.join(activeModelDir(), 'meta.json'), 'utf8')); } catch { return {}; } })();
const inputs = trainingInputs({
  collections: [
    { labelsRoot: LABELS_ROOT, dataRoot: DATA_ROOT, kinds: ['pdf', 'image'] },
    { labelsRoot: ACARS_LABELS_ROOT, dataRoot: ACARS_DATA_ROOT, kinds: ['image'] },
  ],
  codeDirs: ['scripts', 'services', 'utils'].map(d => path.join(ROOT, 'src', d)),
});
const changes = activeId() ? inputChanges(activeMeta.inputs, inputs) : null;
// (a full run after incremental ones is not the same model: it is made again on purpose)
const sameRun = !FULL || activeMeta.tagger?.mode === 'full';
if (changes && !changes.length && sameRun && !process.argv.includes('--force')) {
  console.log(`Nothing new to learn: the labels (${inputs.files} files), their files and the training code are those ${activeId()} was trained on. No version made.`);
  console.log('Add or fix labels first (training on the same data makes the same model), or train anyway with: node src/scripts/model-train.mjs --force');
  process.exit(0);
}
console.log(changes ? `Changed since ${activeId()}: ${changes.length ? changes.join('; ') : 'nothing (trained again on purpose)'}` : `(${activeId() || 'no active version'} has no record of what it was trained on: training)`);

step('1/5 Training words from the labels');
fs.rmSync(TOKENS, { recursive: true, force: true });
await run(process.execPath, ['src/scripts/build-pdf-token-data.mjs']);
await run(process.execPath, ['src/scripts/build-image-token-data.mjs']);
await run(process.execPath, ['src/scripts/build-acars-token-data.mjs']);
const imageSummary = JSON.parse(fs.readFileSync(path.join(EXPORTS_DIR, 'image-tokens', 'summary.json'), 'utf8'));
const acarsSummary = JSON.parse(fs.readFileSync(path.join(EXPORTS_DIR, 'acars-tokens', 'summary.json'), 'utf8'));

const summary = JSON.parse(fs.readFileSync(path.join(TOKENS, 'summary.json'), 'utf8'));
// Words tagged with a value their row does not have, per file, against the active version's training words.
const suspect = Object.fromEntries((summary.suspect || []).map(x => [x.file, x.words]));
if (activeMeta.suspect) {
  const g = suspectGrowth(activeMeta.suspect, suspect);
  console.log(`Training words not in their row's value: ${g.total >= 0 ? '+' : ''}${g.total} on the files ${activeId()} was trained on`);
  for (const x of g.grown) console.log(`  ${x.file}: ${x.before} -> ${x.after} (${summary.suspect.find(s => s.file === x.file)?.examples.join(', ')})`);
  if (!g.ok && CHECK) {
    console.log('Stopped before training: the training words changed for the worse (above; scripts/build-pdf-token-data.mjs).');
    console.log('Fix that, or train anyway with: node src/scripts/model-train.mjs --no-check');
    process.exit(1);
  }
} else {
  console.log(`Training words not in their row's value: ${Object.values(suspect).reduce((a, b) => a + b, 0)} in ${Object.keys(suspect).length} files (the active version has no count to compare with)`);
}

step('2/5 Conventions');
fs.rmSync(NEXT, { recursive: true, force: true });
fs.mkdirSync(NEXT, { recursive: true });
const convs = [];
const sha1 = (...parts) => { const h = crypto.createHash('sha1'); for (const p of parts) h.update(p); return h.digest('hex'); };
const assemblerCode = Buffer.concat(['pdf-row-assembler.js', 'pdf-header-words.json'].map(f => fs.readFileSync(fileURLToPath(new URL(`../services/${f}`, import.meta.url)))));
const convCache = (() => { try { return JSON.parse(fs.readFileSync(CONV_CACHE, 'utf8')); } catch { return {}; } })();
const convNext = {};
let learned = 0;
for (const f of summary.files) {
  const docText = fs.readFileSync(path.join(TOKENS, `${f.file}.json`));
  const labelText = fs.readFileSync(labelFile(LABELS_ROOT, f.file));
  const key = sha1(assemblerCode, docText, labelText, fs.readFileSync(dataFile(DATA_ROOT, f.file)));
  let conv = convCache[f.file]?.key === key ? convCache[f.file].conv : null;
  if (!conv) {
    conv = learnConventions(JSON.parse(docText).pages, JSON.parse(labelText), await readPdfText(dataFile(DATA_ROOT, f.file)));
    learned += 1;
  }
  convNext[f.file] = { key, conv };
  convs.push(conv);
}
fs.writeFileSync(CONV_CACHE, JSON.stringify(convNext));
console.log(`  ${learned} files learned, ${summary.files.length - learned} unchanged since the last run`);
fs.writeFileSync(path.join(NEXT, 'conventions.json'), JSON.stringify(mergeConventions(convs), null, 2));

let tagger;
if (CONVENTIONS_ONLY) {
  const from = activeId();
  if (!from) { console.log('There is no active version whose word tagger could be kept: train without --conventions-only.'); process.exit(1); }
  step(`3/5 Word tagger kept from ${from}`);
  const src = activeModelDir();
  for (const f of ['tagger.joblib', 'stage1-oof.joblib']) if (fs.existsSync(path.join(src, f))) fs.copyFileSync(path.join(src, f), path.join(NEXT, f));
  // the header words that tagger was trained with (its features), whatever the new conventions.json learned
  const words = fs.existsSync(path.join(src, 'tagger-words.json'))
    ? JSON.parse(fs.readFileSync(path.join(src, 'tagger-words.json'), 'utf8')).headerWords
    : JSON.parse(fs.readFileSync(path.join(src, 'conventions.json'), 'utf8')).headerWords || [];
  fs.writeFileSync(path.join(NEXT, 'tagger-words.json'), JSON.stringify({ headerWords: words }));
  tagger = { mode: 'conventions', from };
} else {
  step('3/5 Training the word tagger');
  const base = !FULL && activeId() ? ['--base', activeModelDir()] : [];
  await run(PYTHON, ['-I', 'src/scripts/train_pdf_tagger.py', '--no-eval', '--conventions', path.join(NEXT, 'conventions.json'), '--save', NEXT, ...base]);
  const runFile = path.join(NEXT, 'tagger-run.json');
  tagger = JSON.parse(fs.readFileSync(runFile, 'utf8'));
  fs.rmSync(runFile);
}
stepSeconds.tagger = Math.round((Date.now() - stepAt) / 1000);
const meta = {
  trainedAt: new Date().toISOString(),
  files: summary.files.length + imageSummary.files.length + acarsSummary.files.length,
  pdfs: summary.files.length,
  images: imageSummary.files.length,
  acars: acarsSummary.files.length, // ACARS pictures: /acars reads only with a version trained on some
  filesByType: { ...countByType([...summary.files, ...imageSummary.files].map(f => f.file)), acars: acarsSummary.files.length },
  fromLabelOnly: summary.aligned.length, // formats the parser misreads, learned from the label alone
  rows: summary.files.reduce((s, f) => s + f.rows, 0) + imageSummary.rows,
  words: summary.tokens + imageSummary.tokens + acarsSummary.tokens,
  skipped: summary.skipped.map(s => `${s.file}: ${s.reason}`),
  seconds: Math.round((Date.now() - t0) / 1000), // training only (steps 1-3), not the benchmark after it
  stepSeconds: { ...stepSeconds },
  cpus: os.cpus().length,
  inputs, // what it learned from (services/train-inputs.js): the next run stops when nothing changed
  tagger, // { mode: full | incremental | conventions, ... } (train_pdf_tagger.py's tagger-run.json)
  suspect, // (the next run's check compares with these)
};
fs.writeFileSync(path.join(NEXT, 'meta.json'), JSON.stringify(meta, null, 2));

const { id, dir } = newVersionDir(meta.trainedAt);
fs.renameSync(NEXT, dir);
await publishModel(id);
console.log(`Trained in ${meta.seconds} s: ${meta.files} files (${meta.fromLabelOnly} learned from the label alone), ${meta.rows} rows, ${meta.words} words.`);

const prev = activeId();
let use = true;
if (CHECK && prev && prev !== id) {
  step('4/5 Benchmark of the new version');
  const progress = (e) => { if (e.type === 'file') console.log(`  [files ${e.progress.current}/${e.progress.total}] ${e.file.file}`); };
  try {
    // the active version's last run over every file type (a run of it now when it has none)
    let base = (await listRuns('model')).find(r => r.model?.id === prev && FILE_TYPES.every(t => r.types?.includes(t)))?.files;
    if (!base) {
      console.log(`  (${prev} has no benchmark of every file type: running it first)`);
      const r = await runModelBenchmark({ modelDir: activeModelDir(), onEvent: progress });
      base = Object.fromEntries(r.files.map(f => [f.file, f.error ? null : [f.rowMatches, f.rowTotal]]));
    }
    const r = await runModelBenchmark({ modelDir: dir, onEvent: progress });
    const c = compareRuns(base, r.files);
    console.log(`Rows right on the same ${c.same.files} files: ${prev} ${c.same.before}, new ${c.same.after} of ${c.same.rows}; ${c.added.files} files new since: ${c.added.after} of ${c.added.rows}`);
    const moved = c.layouts.filter(l => l.after !== l.before);
    // (the most rows lost first, then the most won)
    for (const l of [...moved.slice(0, 8), ...moved.slice(Math.max(8, moved.length - 5))]) console.log(`  ${l.layout} (${l.files} files) ${l.before} -> ${l.after} of ${l.rows}`);
    use = c.ok;
    if (!use) console.log(`Not activated, ${prev} stays active: ${c.reasons.join('; ')}. /models can activate ${id} by hand.`);
  } catch (e) {
    use = false;
    console.log(`Not activated, ${prev} stays active: the benchmark failed (${e.message}). /models can activate ${id} by hand.`);
  }
}

step('5/5 Switching to the new model');
if (use) {
  await activateModel(id);
  console.log(`New model version ${id} is active.`);
} else {
  console.log(`New model version ${id} is kept, not active.`);
}
console.log(`Done in ${Math.round((Date.now() - t0) / 1000)} s.`);
process.exit(0); // (the tagger kept running for the benchmark)
