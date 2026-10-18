/**
 * Trained versions of the AI model (the learned word tagger /upload uses).
 * Each training run is kept as models/ai/<id>/ (tagger.joblib, meta.json,
 * conventions.json, and benchmark.json once it has been benchmarked); one of them
 * is active (models/ai/active.json) and is the one the app reads files with.
 *
 *   listModels()            -> [{ id, active, trainedAt, files, pdfs, images, rows, words, seconds, sizeBytes, benchmark }]
 *   activeModelDir()        -> folder of the active version (null when there is none)
 *   activateModel(id), deleteModel(id) (never the active one)
 *   newVersionDir(trainedAt)-> { id, dir } for a training run to write to
 *   saveBenchmark(dir, part)-> merges a benchmark summary into that version's benchmark.json
 *
 * Before versions existed the model lived in models/pdf-tagger (and the one
 * before it in models/pdf-tagger-prev): the first call copies them in as versions.
 * The old folders are left as they were.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const AI_DIR = path.join(ROOT, 'models', 'ai');
const ACTIVE_FILE = path.join(AI_DIR, 'active.json');
const LEGACY = path.join(ROOT, 'models', 'pdf-tagger');
const ID_RE = /^\d{8}-\d{6}$/;

/** "2026-10-14T19:12:56.148Z" -> "20261014-191256" (UTC). */
export const idFor = (iso) => new Date(iso).toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);

const readJson = (file, fallback = null) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; } };
const isVersion = (id) => ID_RE.test(id) && fs.existsSync(path.join(AI_DIR, id, 'tagger.joblib'));
const versionIds = () => (fs.existsSync(AI_DIR) ? fs.readdirSync(AI_DIR).filter(isVersion).sort() : []);

function ensureVersions() {
  if (versionIds().length) return;
  let active = null;
  for (const dir of [`${LEGACY}-prev`, LEGACY]) {
    if (!fs.existsSync(path.join(dir, 'tagger.joblib'))) continue;
    const meta = readJson(path.join(dir, 'meta.json'), {});
    const id = idFor(meta.trainedAt || fs.statSync(path.join(dir, 'tagger.joblib')).mtime);
    if (!isVersion(id)) fs.cpSync(dir, path.join(AI_DIR, id), { recursive: true });
    active = id; // the last one copied is models/pdf-tagger, the one in use
  }
  if (active) fs.writeFileSync(ACTIVE_FILE, JSON.stringify({ id: active }, null, 2));
}

export function activeId() {
  ensureVersions();
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

export function activateModel(id) {
  if (!isVersion(id)) throw Object.assign(new Error(`No model ${id}`), { status: 404 });
  fs.writeFileSync(ACTIVE_FILE, JSON.stringify({ id }, null, 2));
}

export function deleteModel(id) {
  if (!isVersion(id)) throw Object.assign(new Error(`No model ${id}`), { status: 404 });
  if (id === activeId()) throw Object.assign(new Error('Cannot delete the active model: activate another one first.'), { status: 409 });
  fs.rmSync(path.join(AI_DIR, id), { recursive: true, force: true });
}

/** A new version's folder for a training run (made by the caller when done; activated by it too). */
export function newVersionDir(trainedAt) {
  ensureVersions();
  const id = idFor(trainedAt);
  return { id, dir: path.join(AI_DIR, id) };
}

/** Merge one benchmark run ({ at, image?, pdf?, overall?, byType? }) into the version's benchmark.json. */
export function saveBenchmark(dir, part) {
  if (!dir || !fs.existsSync(dir)) return;
  const file = path.join(dir, 'benchmark.json');
  const old = readJson(file, {});
  // byType merges per type: a run of some types keeps the others' last scores
  const byType = part.byType ? { ...old.byType, ...part.byType } : old.byType;
  fs.writeFileSync(file, JSON.stringify({ ...old, ...part, ...(byType ? { byType } : {}) }, null, 2));
}
