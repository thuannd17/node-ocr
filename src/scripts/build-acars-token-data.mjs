#!/usr/bin/env node
/**
 * Training words for the learned extractor from the labeled ACARS pictures (MinIO bucket
 * ACARS_BUCKET, mirrored by services/media-client.js `acars`), so the one AI model also reads ACARS.
 *
 *   node --env-file=.env scripts/build-acars-token-data.mjs [--refresh]
 *
 * Each distinct picture (byte-identical copies once) is read by the OCR server (npm run ocr:server;
 * the lines are kept in <work>/exports/ocr-lines-acars/, --refresh reads again), turned into words
 * (services/acars.js acarsWordPages, kind 'acars') and tagged from its label (alignAcars).
 * Output like build-image-token-data.mjs: <work>/exports/acars-tokens/<file>.json and summary.json.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import sharp from 'sharp';
import { ocrLines } from '../services/paddle-ocr.js';
import { acarsWordPages, alignAcars } from '../services/acars.js';
import { listReviewedLabels, dataFile, labelFile, ACARS_DATA_ROOT, ACARS_LABELS_ROOT } from '../utils/data-files.js';
import { acars } from '../services/media-client.js';
import { EXPORTS_DIR } from '../utils/paths.js';

await acars.syncForScript();

const refresh = process.argv.includes('--refresh');
const linesDir = path.join(EXPORTS_DIR, 'ocr-lines-acars');
const outDir = path.join(EXPORTS_DIR, 'acars-tokens');
fs.mkdirSync(linesDir, { recursive: true });
fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });

const seen = new Set();
const summary = { files: [], skipped: [], tokens: 0, tagged: 0, unsure: 0, byField: {}, values: 0, found: 0, missing: {} };
const names = listReviewedLabels(ACARS_LABELS_ROOT, 'image').filter(n => fs.existsSync(dataFile(ACARS_DATA_ROOT, n)));

for (const name of names) {
  const file = dataFile(ACARS_DATA_ROOT, name);
  const hash = crypto.createHash('md5').update(fs.readFileSync(file)).digest('hex');
  if (seen.has(hash)) { summary.skipped.push({ file: name, reason: 'copy of another picture' }); continue; }
  seen.add(hash);
  const label = JSON.parse(fs.readFileSync(labelFile(ACARS_LABELS_ROOT, name), 'utf8'));
  const cache = path.join(linesDir, `${name}.json`);
  let cached = !refresh && fs.existsSync(cache) ? JSON.parse(fs.readFileSync(cache, 'utf8')) : null;
  if (!cached || cached.hash !== hash) {
    const meta = await sharp(file).metadata();
    cached = { hash, width: meta.width, height: meta.height, lines: await ocrLines(file) };
    fs.writeFileSync(cache, JSON.stringify(cached));
  }
  const pages = acarsWordPages(cached.lines, cached.width, cached.height);
  const st = alignAcars(pages, label);
  summary.values += st.found + st.missing.length;
  summary.found += st.found;
  for (const m of st.missing) summary.missing[m] = (summary.missing[m] || 0) + 1;
  for (const t of pages[0].tokens) {
    summary.tokens += 1;
    if (t.field === '?') summary.unsure += 1; else if (t.field !== 'O') summary.tagged += 1;
    summary.byField[t.field] = (summary.byField[t.field] || 0) + 1;
  }
  fs.writeFileSync(path.join(outDir, `${name}.json`), JSON.stringify({ file: name, kind: 'acars', source: 'label', format: 'acars', pages }));
  summary.files.push({ file: name, found: st.found, missing: st.missing, tokens: pages[0].tokens.length });
  process.stdout.write('.');
}
fs.writeFileSync(path.join(outDir, 'summary.json'), JSON.stringify(summary, null, 2));
const pct = (a, b) => (b ? (100 * a / b).toFixed(1) : '-');
console.log(`\nACARS pictures used: ${summary.files.length} (skipped ${summary.skipped.length} copies)`);
console.log(`Label values found among the OCR words: ${summary.found}/${summary.values} (${pct(summary.found, summary.values)}%), not found: ${JSON.stringify(summary.missing)}`);
console.log(`Words: ${summary.tokens}, tagged ${summary.tagged}, unsure (left out of training) ${summary.unsure}`);
