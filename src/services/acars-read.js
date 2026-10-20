/**
 * Reading one ACARS picture: OCR lines (PaddleOCR server), then the AI model (as /acars reads)
 * or the rule-based parser (/label Auto-fill).
 *
 *   acarsLines(file, { cacheName? }) -> { width, height, lines }
 *     cacheName: a dataset picture's name; its OCR lines are kept in <work>/exports/ocr-lines-acars/
 *     (shared with scripts/build-acars-token-data.mjs), read again only when the picture changed.
 *   readAcarsPicture(file, { engine: 'model' | 'parser', dir?, cacheName? })
 *     -> { fields: { flt, dept, dest, out, off, on, in, info }, engine, timings: { ocrMs, readMs } }
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import sharp from 'sharp';
import { ocrLines } from './paddle-ocr.js';
import { acarsWordPages, parseAcars } from './acars.js';
import { extractAcarsWithModel } from './pdf-ai-extract.js';
import { EXPORTS_DIR } from '../utils/paths.js';

const LINES_DIR = path.join(EXPORTS_DIR, 'ocr-lines-acars');

export async function acarsLines(file, { cacheName = null } = {}) {
  const buf = fs.readFileSync(file);
  const hash = crypto.createHash('md5').update(buf).digest('hex');
  const cache = cacheName ? path.join(LINES_DIR, `${cacheName}.json`) : null;
  if (cache && fs.existsSync(cache)) {
    try {
      const c = JSON.parse(fs.readFileSync(cache, 'utf8'));
      if (c.hash === hash) return { ...c, cached: true };
    } catch { /* read again */ }
  }
  const { width, height } = await sharp(buf).metadata();
  const out = { hash, width, height, lines: await ocrLines(file) };
  if (cache) {
    fs.mkdirSync(LINES_DIR, { recursive: true });
    fs.writeFileSync(cache, JSON.stringify(out));
  }
  return out;
}

export async function readAcarsPicture(file, { engine = 'model', dir, cacheName = null } = {}) {
  const t0 = Date.now();
  const { lines, width, height } = await acarsLines(file, { cacheName });
  const t1 = Date.now();
  const fields = engine === 'parser'
    ? parseAcars(acarsWordPages(lines, width, height))
    : (await extractAcarsWithModel(lines, width, height, dir)).fields;
  return { fields, engine, timings: { ocrMs: t1 - t0, readMs: Date.now() - t1 } };
}
