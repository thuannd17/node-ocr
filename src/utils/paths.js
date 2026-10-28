/**
 * Where the app and its scripts keep what they make while running: never inside the project.
 *
 *   ROSTER_WORK_DIR (default: <system temp>/roster-ocr-work)
 *     media/       mirror of the roster files + labels in MinIO (MEDIA_CACHE_DIR, utils/data-files.js)
 *     models/      mirror of the trained models in MinIO (models/ai/..., services/ai-models.js)
 *     site/        mirror of the public site data in MinIO (airports.json, services/site-data.js)
 *     cache/       OCR / parse results kept to run faster again (ocr, parsed, rec-lines, ...)
 *     exports/     datasets built from the data for training (ocr-lines, pdf-tokens, recognition-groundtruth, ...)
 *     uploads/     files being read right now (removed afterwards)
 *     tmp/         other short-lived files (OCR crops, load tests, diagnostics)
 *     train/       OCR training runs that are not a version yet (k-fold folds)
 *     pretrained/  the PaddleOCR base model for retraining (downloaded, see README)
 *
 * Everything here can be deleted: the data and the models are in MinIO, the rest is rebuilt.
 * Child processes (Python, training scripts) inherit ROSTER_WORK_DIR, so they find the same folders.
 */
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** The project folder (package.json, .env, .venv, models/, docs/); the code is in SRC_DIR. */
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const SRC_DIR = path.join(ROOT, 'src');
export const SCRIPTS_DIR = path.join(SRC_DIR, 'scripts');
export const WORK_DIR = path.resolve(process.env.ROSTER_WORK_DIR || path.join(os.tmpdir(), 'roster-ocr-work'));
process.env.ROSTER_WORK_DIR = WORK_DIR;

export const MODELS_MIRROR = path.join(WORK_DIR, 'models');
export const SITE_MIRROR = path.join(WORK_DIR, 'site');
export const CACHE_DIR = path.join(WORK_DIR, 'cache');
export const EXPORTS_DIR = path.join(WORK_DIR, 'exports');
export const UPLOADS_DIR = path.join(WORK_DIR, 'uploads');
export const TMP_DIR = path.join(WORK_DIR, 'tmp');
export const TRAIN_DIR = path.join(WORK_DIR, 'train');
export const PRETRAINED_DIR = path.join(WORK_DIR, 'pretrained');

/** A path for a PaddleOCR yml: relative ("./models/...") inside the project, absolute with / outside it. */
export function ymlPath(p) {
  const rel = path.relative(ROOT, p);
  return rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? `./${rel.replace(/\\/g, '/')}` : path.resolve(p).replace(/\\/g, '/');
}
