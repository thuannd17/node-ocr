/**
 * Trained versions of the AI model (the learned word tagger /upload uses).
 * They live in MinIO (services/media-client.js): models/ai/<id>/ (tagger.joblib, meta.json,
 * conventions.json, and benchmark.json once it has been benchmarked); models/ai/active.json names
 * the one the app reads files with. Python loads a model from disk, so they are mirrored into
 * AI_DIR (<ROSTER_WORK_DIR>/models/ai, utils/paths.js) by syncModels().
 *
 *   syncModels({ force })   -> brings AI_DIR up to date (cheap when nothing changed)
 *   listModels()            -> [{ id, active, trainedAt, files, pdfs, images, rows, words, seconds, sizeBytes, benchmark }]
 *   activeModelDir()        -> folder of the active version (null when there is none)
 *   activateModel(id), deleteModel(id) (never the active one; moved to MinIO's trash)
 *   newVersionDir(trainedAt)-> { id, dir } for a training run to write to; publishModel(id) uploads it
 *   saveBenchmark(dir, part)-> merges a benchmark summary into that version's benchmark.json
 * The read functions are synchronous and read the mirror; the others write to MinIO first.
 */
import fs from 'node:fs';
import path from 'node:path';
import { MODELS_MIRROR } from '../utils/paths.js';
import { syncPrefix, pushFiles, putModelObject, trashModelObjects } from './media-client.js';

export const AI_DIR = path.join(MODELS_MIRROR, 'ai');
const PREFIX = 'models/ai/';
const ACTIVE_FILE = path.join(AI_DIR, 'active.json');
const ID_RE = /^\d{8}-\d{6}$/;

/** "2026-10-14T19:12:56.148Z" -> "20261014-191256" (UTC). */
export const idFor = (iso) => new Date(iso).toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);

const readJson = (file, fallback = null) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; } };
const isVersion = (id) => ID_RE.test(id) && fs.existsSync(path.join(AI_DIR, id, 'tagger.joblib'));
const versionIds = () => (fs.existsSync(AI_DIR) ? fs.readdirSync(AI_DIR).filter(isVersion).sort() : []);
const notFound = (id) => Object.assign(new Error(`No model ${id}`), { status: 404 });

/** Mirror models/ai/ from MinIO into AI_DIR. */
export const syncModels = ({ force = false, maxAgeMs = 10000 } = {}) => syncPrefix(PREFIX, AI_DIR, { force, maxAgeMs });

export function activeId() {
  const id = readJson(ACTIVE_FILE)?.id;
  if (id && isVersion(id)) return id;
  return versionIds().at(-1) || null; // active one missing: the newest
}

export function activeModelDir() {
  const id = activeId();
  return id ? path.join(AI_DIR, id) : null;
}

function dirSize(dir) {
  return fs.readdirSync(dir, { withFileTypes: true })
    .reduce((n, e) => n + (e.isDirectory() ? dirSize(path.join(dir, e.name)) : fs.statSync(path.join(dir, e.name)).size), 0);
}

export function listModels() {
  const active = activeId();
  return versionIds().reverse().map((id) => {
    const dir = path.join(AI_DIR, id);
    const meta = readJson(path.join(dir, 'meta.json'), {});
    return { id, active: id === active, ...meta, sizeBytes: dirSize(dir), benchmark: readJson(path.join(dir, 'benchmark.json')) };
  });
}

export async function activateModel(id) {
  await syncModels();
  if (!isVersion(id)) throw notFound(id);
  const buf = Buffer.from(JSON.stringify({ id }, null, 2));
  await putModelObject(`${PREFIX}active.json`, buf);
  fs.writeFileSync(ACTIVE_FILE, buf);
  await syncModels({ force: true }); // notes the new active.json in the mirror's manifest
}

export async function deleteModel(id) {
  await syncModels();
  if (!isVersion(id)) throw notFound(id);
  if (id === activeId()) throw Object.assign(new Error('Cannot delete the active model: activate another one first.'), { status: 409 });
  await trashModelObjects(`${PREFIX}${id}/`);
  fs.rmSync(path.join(AI_DIR, id), { recursive: true, force: true });
}

/** A new version's folder for a training run (made by the caller when done, then publishModel + activateModel). */
export function newVersionDir(trainedAt) {
  const id = idFor(trainedAt);
  return { id, dir: path.join(AI_DIR, id) };
}

/** Upload a version's folder (written by a training run) to MinIO. */
export async function publishModel(id) {
  if (!isVersion(id)) throw notFound(id);
  const dir = path.join(AI_DIR, id);
  const rels = fs.readdirSync(dir).filter(n => fs.statSync(path.join(dir, n)).isFile()).map(n => `${id}/${n}`);
  await pushFiles(PREFIX, AI_DIR, rels);
}

/** Merge one benchmark run ({ at, image?, pdf?, overall?, byType? }) into the version's benchmark.json (mirror + MinIO). */
export async function saveBenchmark(dir, part) {
  if (!dir || !fs.existsSync(dir)) return;
  const file = path.join(dir, 'benchmark.json');
  const old = readJson(file, {});
  // byType merges per type: a run of some types keeps the others' last scores
  const byType = part.byType ? { ...old.byType, ...part.byType } : old.byType;
  fs.writeFileSync(file, JSON.stringify({ ...old, ...part, ...(byType ? { byType } : {}) }, null, 2));
  await pushFiles(PREFIX, AI_DIR, [`${path.basename(dir)}/benchmark.json`]);
}
