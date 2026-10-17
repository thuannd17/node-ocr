#!/usr/bin/env node
/**
 * Training words for the learned extractor from the labeled roster IMAGES
 * (fake-data/ + labels/), so one model learns from images and PDFs.
 *
 *   node --env-file=.env scripts/build-image-token-data.mjs [--refresh]
 *
 * Each distinct image (byte-identical copies once) is read by the OCR server
 * (npm run ocr:server; the lines are kept in exports/ocr-lines/, --refresh reads
 * again, e.g. after a new recognition model), turned into words with positions
 * (services/ocr-tokens.js) and tagged from its label (services/pdf-label-align.js
 * with OCR-tolerant matching). Output like build-pdf-token-data.mjs:
 * exports/image-tokens/<file>.json and summary.json.
 *
 * A labeled image-only PDF that is not a duty plan (a roster screen printed to
 * PDF, e.g. Ryanair eCrew) is a roster picture too: its pages are read by OCR and
 * stacked into one tall picture (services/pdf-ocr.js ocrPdfAsImage), as /upload reads it.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import sharp from 'sharp';
import { ocrLines } from '../services/paddle-ocr.js';
import { ocrWordPages } from '../services/ocr-tokens.js';
import { alignLabel } from '../services/pdf-label-align.js';
import { listLabels, dataFile, labelFile, kindOf } from '../utils/data-files.js';
import { readPdfText, hasTextLayer } from '../services/pdf-text.js';
import { parseNetlinePdf } from '../services/pdf-roster-parser.js';
import { ocrPdfPages, ocrPdfAsImage } from '../services/pdf-ocr.js';

const refresh = process.argv.includes('--refresh');
const imgDir = path.resolve('fake-data');
const labelsDir = path.resolve('labels');
const linesDir = path.resolve('exports/ocr-lines');
const outDir = path.resolve('exports/image-tokens');
fs.mkdirSync(linesDir, { recursive: true });
fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });

const seen = new Set();
const summary = { files: [], skipped: [], tokens: 0, tagged: 0, unsure: 0, byField: {}, rows: 0, anchored: 0, missing: {} };
const names = [...listLabels(labelsDir, 'image'), ...listLabels(labelsDir, 'pdf')].filter(n => fs.existsSync(dataFile(imgDir, n)));
const isPdf = (name) => kindOf(name) === 'pdf'; // also CSV / Excel / TXT: read as text, never a picture

/** OCR lines of a file as one roster picture; null for a PDF that is not one (text layer, or a duty plan). */
async function readLines(name, file, hash) {
  if (!isPdf(name)) {
    const meta = await sharp(file).metadata();
    return { hash, width: meta.width, height: meta.height, lines: await ocrLines(file) };
  }
  if (hasTextLayer(await readPdfText(file))) return { hash, notPicture: 'text layer' };
  const plan = parseNetlinePdf(await ocrPdfPages(file));
  if (plan.published.length + plan.planned.length) return { hash, notPicture: 'image-only duty plan' };
  return { hash, ...(await ocrPdfAsImage(file)) };
}

for (const name of names) {
  const file = dataFile(imgDir, name);
  const hash = crypto.createHash('md5').update(fs.readFileSync(file)).digest('hex');
  if (seen.has(hash)) { summary.skipped.push({ file: name, reason: 'copy of another image' }); continue; }
  seen.add(hash);
  const label = JSON.parse(fs.readFileSync(labelFile(labelsDir, name), 'utf8'));
  const cache = path.join(linesDir, `${name}.json`);
  let cached = !refresh && fs.existsSync(cache) ? JSON.parse(fs.readFileSync(cache, 'utf8')) : null;
  if (!cached || cached.hash !== hash) {
    cached = await readLines(name, file, hash);
    fs.writeFileSync(cache, JSON.stringify(cached));
  }
  if (cached.notPicture) continue; // a PDF read from its words (scripts/build-pdf-token-data.mjs)
  const pages = ocrWordPages(cached.lines, cached.width, cached.height);
  const st = alignLabel(pages, label, { ocr: true });
  summary.rows += st.rows;
  summary.anchored += st.anchored;
  for (const [k, v] of Object.entries(st.missing)) summary.missing[k] = (summary.missing[k] || 0) + v;
  for (const t of pages[0].tokens) {
    summary.tokens += 1;
    if (t.field === '?') summary.unsure += 1; else if (t.field !== 'O') summary.tagged += 1;
    summary.byField[t.field] = (summary.byField[t.field] || 0) + 1;
  }
  fs.writeFileSync(path.join(outDir, `${name}.json`), JSON.stringify({ file: name, kind: 'image', source: 'label', format: 'image-roster', pages }));
  summary.files.push({ file: name, rows: st.rows, anchored: st.anchored, tokens: pages[0].tokens.length });
  process.stdout.write('.');
}
fs.writeFileSync(path.join(outDir, 'summary.json'), JSON.stringify(summary, null, 2));
const pct = (a, b) => (b ? (100 * a / b).toFixed(1) : '-');
console.log(`\nImages used: ${summary.files.length} (skipped ${summary.skipped.length} copies)`);
console.log(`Label rows found among the OCR words: ${summary.anchored}/${summary.rows} (${pct(summary.anchored, summary.rows)}%), values not found: ${JSON.stringify(summary.missing)}`);
console.log(`Words: ${summary.tokens}, tagged ${summary.tagged} (${pct(summary.tagged, summary.tokens)}%), unsure (left out of training) ${summary.unsure}`);
console.log(`Words per field: ${Object.entries(summary.byField).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(', ')}`);
