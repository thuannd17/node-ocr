#!/usr/bin/env node
/**
 * ACARS pictures as OCR recognition training data: one crop per OCR line whose true text is known
 * from the picture's label (services/acars.js acarsLineTruths: values in their printed form, screen
 * words, OCR slips undone), added to a PaddleOCR SimpleDataSet that scripts/ocr-groundtruth.mjs made.
 * scripts/ocr-train.mjs runs it after the roster crops.
 *
 *   node --env-file=.env scripts/ocr-acars-crops.mjs --dataset=<dir> --lines-dir=<dir> [--test=<file>] [--repeat=5]
 *     --dataset    the dataset folder: images/{train,val}/acars_*.jpg are written, train_list.txt / val_list.txt appended
 *     --lines-dir  OCR lines of each picture, <name>.json (a lines array, or { lines })
 *     --test       a JSON list of picture MD5s that go to val (the pictures the new model is tested on)
 *     --repeat     each training crop is listed this many times: ~200 ACARS crops next to ~20,000 roster crops
 *                  would hardly count otherwise
 * Writes <dataset>/acars-manifest.json (pictures and crops per split, crops that fix an OCR misread).
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import sharp from 'sharp';
import { acarsLineTruths } from '../services/acars.js';
import { listReviewedLabels, dataFile, labelFile, ACARS_DATA_ROOT, ACARS_LABELS_ROOT } from '../utils/data-files.js';
import { acars } from '../services/media-client.js';
import { ROOT } from '../utils/paths.js';

const arg = (k, d = null) => process.argv.find(a => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const dataset = arg('dataset');
const linesDir = arg('lines-dir');
const repeat = Math.max(1, Number(arg('repeat', 5)));
if (!dataset || !linesDir) { console.error('usage: ocr-acars-crops.mjs --dataset=<dir> --lines-dir=<dir> [--test=<file>] [--repeat=5]'); process.exit(1); }
const testHashes = new Set(arg('test') ? JSON.parse(fs.readFileSync(arg('test'), 'utf8')) : []);

await acars.syncForScript();

// the recognizer's characters (models/rec/train-template.yml: en_dict.txt + space); max 25 per crop
const DICT = new Set([...fs.readFileSync(path.join(ROOT, 'models', 'dict', 'en_dict.txt'), 'utf8').split(/\r?\n/).filter(Boolean), ' ']);
const MAX_LEN = 25;

const md5 = (file) => crypto.createHash('md5').update(fs.readFileSync(file)).digest('hex');
const seen = new Set();
const lists = { train: [], val: [] };
const stats = { pictures: { train: 0, val: 0 }, crops: { train: 0, val: 0 }, fixesMisread: 0, skippedNoLines: [], skippedChars: 0 };

for (const name of listReviewedLabels(ACARS_LABELS_ROOT, 'image')) {
  const file = dataFile(ACARS_DATA_ROOT, name);
  if (!fs.existsSync(file)) continue;
  const hash = md5(file);
  if (seen.has(hash)) continue; // a byte-identical copy
  seen.add(hash);
  const linesFile = path.join(linesDir, `${name}.json`);
  if (!fs.existsSync(linesFile)) { stats.skippedNoLines.push(name); continue; }
  const raw = JSON.parse(fs.readFileSync(linesFile, 'utf8'));
  const lines = Array.isArray(raw) ? raw : raw.lines;
  const label = JSON.parse(fs.readFileSync(labelFile(ACARS_LABELS_ROOT, name), 'utf8'));
  // PaddleOCR reads the picture with OpenCV, which turns it by its EXIF orientation: crop the same way
  const img = sharp(file).rotate();
  const { width, height } = await sharp(await img.clone().toBuffer()).metadata();
  const split = testHashes.has(hash) ? 'val' : 'train';
  const outDir = path.join(dataset, 'images', split);
  fs.mkdirSync(outDir, { recursive: true });
  stats.pictures[split]++;
  for (const { index, ocr, truth } of acarsLineTruths(lines, width, height, label)) {
    if (truth.length > MAX_LEN || [...truth].some(c => !DICT.has(c))) { stats.skippedChars++; continue; }
    const xs = lines[index].box.map(p => p[0]), ys = lines[index].box.map(p => p[1]);
    const h = Math.max(...ys) - Math.min(...ys);
    const pad = Math.round(h * 0.12);
    const left = Math.max(0, Math.floor(Math.min(...xs)) - pad), top = Math.max(0, Math.floor(Math.min(...ys)) - pad);
    const right = Math.min(width, Math.ceil(Math.max(...xs)) + pad), bottom = Math.min(height, Math.ceil(Math.max(...ys)) + pad);
    if (right - left < 4 || bottom - top < 4) continue;
    const rel = `images/${split}/acars_${hash.slice(0, 10)}_${index}.jpg`;
    await img.clone().extract({ left, top, width: right - left, height: bottom - top }).jpeg({ quality: 95 }).toFile(path.join(dataset, rel));
    for (let k = 0; k < (split === 'train' ? repeat : 1); k++) lists[split].push(`${rel}\t${truth}`);
    stats.crops[split]++;
    if (truth.replace(/\s/g, '') !== ocr.replace(/\s/g, '')) stats.fixesMisread++;
  }
}

for (const split of ['train', 'val']) {
  if (lists[split].length) fs.appendFileSync(path.join(dataset, `${split}_list.txt`), `${lists[split].join('\n')}\n`, 'utf8');
}
fs.writeFileSync(path.join(dataset, 'acars-manifest.json'), JSON.stringify({ repeat, ...stats }, null, 2));
console.log(`ACARS crops: ${stats.crops.train} train (each listed ${repeat}x) from ${stats.pictures.train} pictures, `
  + `${stats.crops.val} val from ${stats.pictures.val}; ${stats.fixesMisread} teach a misread the model makes today`
  + `${stats.skippedNoLines.length ? `; no OCR lines for ${stats.skippedNoLines.length}` : ''}`);
