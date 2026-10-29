/**
 * What a roster model training run learns from, as hashes (scripts/model-train.mjs, meta.json `inputs`):
 *   labels: every label it trains on (the reviewed ones, services' listReviewedLabels) with its file's bytes
 *   code:   the code that turns them into training words, conventions and the tagger (src/scripts, src/services,
 *           src/utils), and the PDF_TAGGER_ settings
 * A run whose inputs are those of the active version would make the same model again: it stops before training
 * (nothingNew). Code outside those folders (routes, views) never changes what is learned.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { listReviewedLabels, dataFile, labelFile } from '../utils/data-files.js';

const CODE_EXTS = new Set(['.js', '.mjs', '.py', '.json']);

const filesUnder = (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
  const p = path.join(dir, d.name);
  if (d.isDirectory()) return d.name === '__pycache__' || d.name === 'node_modules' ? [] : filesUnder(p);
  return CODE_EXTS.has(path.extname(d.name)) ? [p] : [];
}) : []);

/**
 * collections: [{ labelsRoot, dataRoot, kinds: ['pdf', 'image'] }]; codeDirs: folders of training code.
 * -> { labels, code, files } (files: how many labels)
 */
export function trainingInputs({ collections, codeDirs, env = process.env }) {
  const labels = crypto.createHash('sha1');
  let files = 0;
  for (const c of collections) {
    for (const kind of c.kinds) {
      for (const name of listReviewedLabels(c.labelsRoot, kind)) {
        const data = dataFile(c.dataRoot, name);
        if (!fs.existsSync(data)) continue; // (training skips a label without its file too)
        labels.update(`${name}\0`).update(fs.readFileSync(labelFile(c.labelsRoot, name))).update('\0').update(fs.readFileSync(data)).update('\0');
        files += 1;
      }
    }
  }
  const code = crypto.createHash('sha1');
  for (const dir of codeDirs) {
    for (const f of filesUnder(dir).sort()) code.update(`${path.relative(dir, f).split(path.sep).join('/')}\0`).update(fs.readFileSync(f)).update('\0');
  }
  code.update(JSON.stringify(Object.entries(env).filter(([k]) => k.startsWith('PDF_TAGGER_') && k !== 'PDF_TAGGER_JOBS').sort()));
  return { labels: labels.digest('hex'), code: code.digest('hex'), files };
}

/** What changed from the active version's inputs (before) to these (after): [] when nothing did; null: not recorded. */
export function inputChanges(before, after) {
  if (!before?.labels || !before?.code) return null;
  const out = [];
  if (before.labels !== after.labels) out.push(before.files === after.files ? `labels or their files edited (${after.files} files)` : `labels: ${before.files} -> ${after.files} files`);
  if (before.code !== after.code) out.push('training code or PDF_TAGGER_ settings');
  return out;
}
