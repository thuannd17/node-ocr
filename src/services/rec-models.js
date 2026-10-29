/**
 * Versions of the OCR text-recognition model (PaddleOCR rec, fine-tuned on roster crops). They live in
 * MinIO (services/media-client.js):
 *   models/rec/<vN|stock>/infer/       what the OCR server loads
 *   models/rec/<vN>/model.json         recipe, what it was trained/tested on, its ocr:train comparison, status
 *   models/rec/<vN>/checkpoint/        kept only with ocr:train --keep-checkpoint (never downloaded here)
 *   models/rec/active.json             { id }: the one in use
 * The OCR server downloads the active one at start (scripts/rec_model.py), so switching needs a server
 * restart. This side mirrors them (without checkpoints) into REC_DIR (<ROSTER_WORK_DIR>/models/rec) for
 * /models and for ocr:train / ocr:kfold, which run OCR servers on a version's folder.
 *
 *   syncRecModels({ force }) -> brings REC_DIR up to date
 *   listRecModels() -> [{ id, active, name, createdAt, seconds, status, trainedOn, testedOn, comparison, notes, sizeBytes }]
 *   activeRecId(), activateRec(id), deleteRec(id), publishRec(id, { withCheckpoint })
 * OCR_REC_VERSION in .env pins a version on this machine (instead of active.json).
 * Training a new version: scripts/ocr-train.mjs (npm run ocr:train).
 */
import fs from 'node:fs';
import path from 'node:path';
import { MODELS_MIRROR } from '../utils/paths.js';
import { syncPrefix, pushFiles, trashModelObjects } from './media-client.js';

export const REC_DIR = path.join(MODELS_MIRROR, 'rec');
const PREFIX = 'models/rec/';
const ID_RE = /^(v\d+|stock)$/;
const readJson = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return {}; } };
const today = () => new Date().toISOString().slice(0, 10);
const fail = (msg, status) => Object.assign(new Error(msg), { status });
const isCheckpoint = (rel) => /^[^/]+\/checkpoint\//.test(rel);

const isVersion = (id) => ID_RE.test(id) && fs.existsSync(path.join(REC_DIR, id, 'infer', 'inference.pdiparams'));

/** Mirror models/rec/ (without checkpoints) from MinIO into REC_DIR. */
export const syncRecModels = ({ force = false, maxAgeMs = 10000 } = {}) => syncPrefix(PREFIX, REC_DIR, { force, maxAgeMs, skip: isCheckpoint });

/** The folder of a version's weights (what OCR_CUSTOM_REC takes). */
export const recInferDir = (id) => path.join(REC_DIR, id, 'infer');

export function activeRecId() {
  return process.env.OCR_REC_VERSION?.trim() || readJson(path.join(REC_DIR, 'active.json')).id || null;
}

function dirSize(dir) {
  return fs.readdirSync(dir, { withFileTypes: true })
    .reduce((n, e) => n + (e.isDirectory() ? dirSize(path.join(dir, e.name)) : fs.statSync(path.join(dir, e.name)).size), 0);
}

export function listRecModels() {
  if (!fs.existsSync(REC_DIR)) return [];
  const active = activeRecId();
  return fs.readdirSync(REC_DIR).filter(isVersion)
    .sort((a, b) => (a === 'stock') - (b === 'stock') || Number(b.slice(1)) - Number(a.slice(1)))
    .map((id) => {
      const m = readJson(path.join(REC_DIR, id, 'model.json'));
      return {
        id, active: id === active, name: m.name || '', createdAt: m.createdAt || null, seconds: m.seconds ?? null, status: m.status || '',
        trainedOn: m.trainedOn?.length ?? null, testedOn: m.testedOn?.length ?? null,
        comparison: m.comparison ? { against: m.comparison.against, rosters: m.comparison.rosters, verdict: m.comparison.verdict,
          mine: m.comparison[id], theirs: m.comparison[m.comparison.against] } : null,
        notes: m.notes || '', sizeBytes: dirSize(path.join(REC_DIR, id)),
      };
    });
}

/** Write one JSON file of the mirror and to MinIO. */
async function putJson(rel, obj) {
  const buf = Buffer.from(JSON.stringify(obj, null, 2) + '\n', 'utf8');
  fs.mkdirSync(path.dirname(path.join(REC_DIR, rel)), { recursive: true });
  fs.writeFileSync(path.join(REC_DIR, rel), buf);
  await pushFiles(PREFIX, REC_DIR, [rel]);
}

/** Make this version the one in use (models/rec/active.json in MinIO) and update the statuses. */
export async function activateRec(id) {
  await syncRecModels();
  if (!isVersion(id)) throw fail(`No OCR model ${id}`, 404);
  if (process.env.OCR_REC_VERSION?.trim()) throw fail(`OCR_REC_VERSION=${process.env.OCR_REC_VERSION} in .env pins the OCR model on this machine: remove it first.`, 409);
  const active = activeRecId();
  if (id === active) return;
  if (active && active !== 'stock' && isVersion(active)) {
    await putJson(`${active}/model.json`, { ...readJson(path.join(REC_DIR, active, 'model.json')), status: 'retired', retiredAt: today() });
  }
  await putJson(`${id}/model.json`, { ...readJson(path.join(REC_DIR, id, 'model.json')), status: id === 'stock' ? 'baseline' : 'deployed', deployedAt: today() });
  await putJson('active.json', { id, since: today(), previous: active });
}

/** Move a version (and its checkpoint) to MinIO's trash. */
export async function deleteRec(id) {
  await syncRecModels();
  if (!isVersion(id)) throw fail(`No OCR model ${id}`, 404);
  if (id === activeRecId()) throw fail('Cannot delete the active model: activate another one first.', 409);
  if (id === 'stock') throw fail('Cannot delete the stock model: it is the baseline the fine-tuned versions are compared with.', 409);
  await trashModelObjects(`${PREFIX}${id}/`);
  fs.rmSync(path.join(REC_DIR, id), { recursive: true, force: true });
}

/** Upload a version folder of REC_DIR (written by ocr:train) to MinIO; its checkpoint only when asked. */
export async function publishRec(id, { withCheckpoint = false } = {}) {
  if (!isVersion(id)) throw fail(`No OCR model ${id}`, 404);
  const walk = (dir, out = []) => {
    for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, d.name);
      if (d.isDirectory()) walk(p, out); else out.push(path.relative(REC_DIR, p).split(path.sep).join('/'));
    }
    return out;
  };
  const rels = walk(path.join(REC_DIR, id)).filter(rel => withCheckpoint || !isCheckpoint(rel));
  await pushFiles(PREFIX, REC_DIR, rels);
  return rels.length;
}
