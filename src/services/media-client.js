/**
 * The app's access to the roster data: the roster files, their labels and the correction suggestions
 * live in MinIO (services/storage/; MINIO_* settings, or MEDIA_BACKEND=fs for a folder), not in
 * this project.
 *
 * Code that needs real files (OCR server by path, Python, sharp, training, benchmarks) uses the local
 * mirror in MEDIA_CACHE_DIR (utils/data-files.js: DATA_ROOT / LABELS_ROOT, same layout as the old
 * fake-data/ and labels/ folders):
 *   syncMedia()        mirror everything (only what changed is downloaded; .manifest.json keeps the MD5s)
 *   localFile(name)    one file, downloaded when missing
 * Writes go to MinIO first, then to the mirror: storeFile, saveLabel, deleteFile.
 * MEDIA_OFFLINE=1 (scripts): use the mirror as it is, without asking MinIO.
 *
 * The ACARS pictures are a second collection with the same functions: `acars.syncMedia()`,
 * `acars.localFile(name)`, ... (bucket ACARS_BUCKET, default acars-ocr; mirror ACARS_CACHE_DIR).
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createMedia, storeFromEnv } from './storage/index.js';
import {
  MEDIA_CACHE_DIR, DATA_ROOT, LABELS_ROOT, ACARS_CACHE_DIR, ACARS_DATA_ROOT, ACARS_LABELS_ROOT,
  dataFile, labelFile, listData, listLabels, isDataName,
} from '../utils/data-files.js';

const md5 = (buf) => crypto.createHash('md5').update(buf).digest('hex');

async function pool(items, size, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, async () => {
    while (i < items.length) await fn(items[i++]);
  }));
}

/**
 * One collection of files + labels in MinIO and its local mirror (cacheDir/files, cacheDir/labels).
 * makeMedia: creates the storage library on first use, from the environment of that moment.
 */
function collection({ tag, makeMedia, cacheDir, dataRoot, labelsRoot, kind = 'all' }) {
  let lib = null;
  const media = () => (lib ||= makeMedia());

  // ---- local mirror ----
  const MANIFEST = path.join(cacheDir, '.manifest.json');
  let manifest = null; // 'f:<name>' | 'l:<name>' -> md5 of the copy on disk
  const loadManifest = () => {
    if (!manifest) {
      try { manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8')); } catch { manifest = {}; }
    }
    return manifest;
  };
  const saveManifest = () => {
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.writeFileSync(MANIFEST, JSON.stringify(loadManifest()));
  };
  function writeCached(target, buf, key) {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const tmp = `${target}.${process.pid}.part`;
    fs.writeFileSync(tmp, buf);
    fs.renameSync(tmp, target);
    loadManifest()[key] = md5(buf);
  }
  function dropCached(target, key) {
    fs.rmSync(target, { force: true });
    delete loadManifest()[key];
  }
  /** Is the copy on disk the one MinIO has? (hashes it once when the manifest does not know it) */
  function isCurrent(target, key, remoteMd5) {
    if (!fs.existsSync(target)) return false;
    const m = loadManifest();
    if (!m[key]) m[key] = md5(fs.readFileSync(target));
    return m[key] === remoteMd5;
  }

  let inflight = null;
  let last = { at: 0, index: null, downloaded: 0, removed: 0, ms: 0, error: null };

  /**
   * Mirror MinIO into the cache folder. Cheap when nothing changed (one listing).
   * maxAgeMs: skip when the last sync is newer than that. -> { index, downloaded, removed, ms }
   */
  async function syncMedia({ maxAgeMs = 10000, force = false } = {}) {
    if (process.env.MEDIA_OFFLINE === '1') return { index: null, downloaded: 0, removed: 0, ms: 0, offline: true };
    if (inflight) return inflight;
    if (!force && last.index && Date.now() - last.at < maxAgeMs) return last;
    inflight = (async () => {
      const t0 = Date.now();
      try {
        const index = await media().index(force);
        const todo = [];
        for (const f of index.files) if (!isCurrent(dataFile(dataRoot, f.name), `f:${f.name}`, f.md5)) todo.push(['f', f.name]);
        for (const l of index.labels) if (!isCurrent(labelFile(labelsRoot, l.name), `l:${l.name}`, l.md5)) todo.push(['l', l.name]);
        await pool(todo, 8, async ([t, name]) => {
          const buf = t === 'f' ? await media().getFile(name) : await media().getLabel(name);
          if (buf) writeCached(t === 'f' ? dataFile(dataRoot, name) : labelFile(labelsRoot, name), buf, `${t}:${name}`);
        });
        // gone from MinIO: gone from the mirror
        const files = new Set(index.files.map(f => f.name)), labels = new Set(index.labels.map(l => l.name));
        let removed = 0;
        for (const n of listData(dataRoot, kind)) if (!files.has(n)) { dropCached(dataFile(dataRoot, n), `f:${n}`); removed++; }
        for (const n of listLabels(labelsRoot, kind)) if (!labels.has(n)) { dropCached(labelFile(labelsRoot, n), `l:${n}`); removed++; }
        saveManifest();
        last = { at: Date.now(), index, downloaded: todo.length, removed, ms: Date.now() - t0, error: null };
        if (todo.length || removed) console.log(`[${tag}] mirror: ${todo.length} downloaded, ${removed} removed (${last.ms} ms) -> ${cacheDir}`);
        return last;
      } catch (e) {
        last = { ...last, error: e.message };
        throw e;
      } finally {
        inflight = null;
      }
    })();
    return inflight;
  }

  /**
   * For CLI scripts (training, benchmarks, label checks): bring the mirror up to date before reading it,
   * or stop with a clear message. MEDIA_OFFLINE=1 skips this and uses the mirror as it is.
   */
  async function syncForScript() {
    if (process.env.MEDIA_OFFLINE === '1') return;
    try {
      const r = await syncMedia();
      if (r.downloaded || r.removed) console.log(`[${tag}] ${r.index.files.length} files, ${r.index.labels.length} labels in ${cacheDir}`);
    } catch (e) {
      console.error(`${e.message}\n(MEDIA_OFFLINE=1 uses the local mirror ${cacheDir} as it is.)`);
      process.exit(1);
    }
  }

  /** Path of one file on disk, downloaded when missing; null when MinIO has no such file. */
  async function localFile(name) {
    if (!isDataName(name)) return null;
    const target = dataFile(dataRoot, name);
    if (fs.existsSync(target)) return target;
    if (process.env.MEDIA_OFFLINE === '1') return null;
    const buf = await media().getFile(name);
    if (!buf) return null;
    writeCached(target, buf, `f:${name}`);
    saveManifest();
    return target;
  }

  /**
   * Keep a new file: stored as '<uuid>.<ext>', or the file with the same content when there is
   * one (a labeled copy first). -> { name, isNew }
   */
  async function storeFile(buf, originalName) {
    const r = await media().storeFile(buf, originalName);
    const target = dataFile(dataRoot, r.name);
    if (!fs.existsSync(target)) {
      if (r.isNew) writeCached(target, buf, `f:${r.name}`);
      else await localFile(r.name);
      saveManifest();
    }
    return r;
  }

  /** Move a file and its label to the trash (trash/<date>/ in MinIO). -> { moved } */
  async function deleteFile(name) {
    const r = await media().deleteFile(name);
    dropCached(dataFile(dataRoot, name), `f:${name}`);
    dropCached(labelFile(labelsRoot, name), `l:${name}`);
    saveManifest();
    return r;
  }

  /** The label of a file, fresh from MinIO (null: none yet). The mirror is updated too. */
  async function readLabel(name) {
    const buf = await media().getLabel(name);
    if (!buf) return null;
    writeCached(labelFile(labelsRoot, name), buf, `l:${name}`);
    saveManifest();
    return JSON.parse(buf.toString('utf8'));
  }

  /** Save a label (JSON, 2-space indented as before). */
  async function saveLabel(name, payload) {
    const buf = Buffer.from(JSON.stringify(payload, null, 2), 'utf8');
    await media().putLabel(name, buf);
    writeCached(labelFile(labelsRoot, name), buf, `l:${name}`);
    saveManifest();
    return { name };
  }

  return {
    media,
    mediaStore: () => media().describe(),
    syncMedia,
    syncForScript,
    mirrorState: () => ({ dir: cacheDir, lastSyncAt: last.at ? new Date(last.at).toISOString() : null, downloaded: last.downloaded, removed: last.removed, ms: last.ms, error: last.error }),
    localFile,
    mediaIndex: (fresh = false) => media().index(fresh),
    mediaHealth: () => media().health(),
    fileBytes: (name) => media().getFile(name),
    storeFile,
    importFile: (name, buf) => media().putFile(name, buf),
    deleteFile,
    readLabel,
    saveLabel,
    importLabel: (name, buf) => media().putLabel(name, buf),
  };
}

const roster = collection({
  tag: 'media', makeMedia: () => createMedia(storeFromEnv()), cacheDir: MEDIA_CACHE_DIR, dataRoot: DATA_ROOT, labelsRoot: LABELS_ROOT,
});
const media = roster.media;

/** The ACARS pictures (bucket ACARS_BUCKET, default acars-ocr: files/<name>, labels/<name>.json). */
export const acars = collection({
  tag: 'acars',
  makeMedia: () => createMedia(storeFromEnv(process.env, { bucket: process.env.ACARS_BUCKET || 'acars-ocr' }), { flat: true }),
  cacheDir: ACARS_CACHE_DIR, dataRoot: ACARS_DATA_ROOT, labelsRoot: ACARS_LABELS_ROOT, kind: 'image',
});

// ---- the roster collection (the names the app has always used) ----
/** Where the data is: { backend: 'minio', endpoint, bucket } | { backend: 'fs', dir } */
export const {
  mediaStore, syncMedia, syncForScript, mirrorState, localFile, mediaIndex, mediaHealth, fileBytes,
  storeFile, importFile, deleteFile, readLabel, saveLabel, importLabel,
} = roster;

// ---- correction suggestions (routes/suggestions-api.js) ----
export const listSuggestions = () => media().listSuggestions();
export const getSuggestion = (id) => media().getSuggestion(id);
export const putSuggestion = (meta, file = null) => media().putSuggestion(meta, file);
export const patchSuggestion = (id, part) => media().patchSuggestion(id, part);
export const suggestionFile = (id) => media().getSuggestionFile(id);
export const deleteSuggestionFile = (id) => media().deleteSuggestionFile(id);
export const deleteSuggestion = (id) => media().deleteSuggestion(id);

/** Express error answer for media errors (503 when MinIO is down). */
export function mediaErrorStatus(e) {
  return e?.code === 'MEDIA_DOWN' ? 503 : (e?.status >= 400 && e?.status < 600 ? e.status : 500);
}

// ---- models (services/ai-models.js): objects under models/ in MinIO, mirrored to a local folder ----

/** Every file under dir (relative, with /), leaving out names starting with '.' (work in progress, the manifest). */
function walkFiles(dir, base = dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
    if (d.name.startsWith('.')) continue;
    const p = path.join(dir, d.name);
    if (d.isDirectory()) walkFiles(p, base, out);
    else out.push(path.relative(base, p).split(path.sep).join('/'));
  }
  return out;
}

const prefixSyncs = new Map(); // prefix -> { inflight, at }

/**
 * Mirror the objects under a MinIO prefix ('models/ai/') into localDir: downloads what changed
 * (MD5 in localDir/.manifest.json), removes what is gone. maxAgeMs: skip when synced that recently.
 * skip(rel): leave these out (not downloaded, and a local copy is kept).
 * MEDIA_OFFLINE=1: uses localDir as it is. -> { downloaded, removed }
 */
export async function syncPrefix(prefix, localDir, { maxAgeMs = 10000, force = false, skip = () => false } = {}) {
  if (process.env.MEDIA_OFFLINE === '1') return { downloaded: 0, removed: 0, offline: true };
  const st = prefixSyncs.get(prefix) || {};
  if (st.inflight) return st.inflight;
  if (!force && st.at && Date.now() - st.at < maxAgeMs) return { downloaded: 0, removed: 0 };
  st.inflight = (async () => {
    const manFile = path.join(localDir, '.manifest.json');
    let man = {};
    try { man = JSON.parse(fs.readFileSync(manFile, 'utf8')); } catch { /* none yet */ }
    const objects = await media().listObjects(prefix);
    const remote = new Map(objects.map(o => [o.key.slice(prefix.length), o]).filter(([rel]) => !skip(rel)));
    const todo = [...remote].filter(([rel, o]) => {
      const p = path.join(localDir, rel);
      if (!fs.existsSync(p)) return true;
      if (!man[rel]) man[rel] = md5(fs.readFileSync(p));
      return man[rel] !== o.md5;
    });
    await pool(todo, 4, async ([rel, o]) => {
      const buf = await media().getObject(o.key);
      if (!buf) return;
      const p = path.join(localDir, rel);
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(`${p}.${process.pid}.part`, buf);
      fs.renameSync(`${p}.${process.pid}.part`, p);
      man[rel] = md5(buf);
    });
    let removed = 0;
    for (const rel of walkFiles(localDir)) {
      if (remote.has(rel) || skip(rel)) continue;
      fs.rmSync(path.join(localDir, rel), { force: true });
      delete man[rel];
      removed++;
    }
    fs.mkdirSync(localDir, { recursive: true });
    fs.writeFileSync(manFile, JSON.stringify(man));
    st.at = Date.now();
    if (todo.length || removed) console.log(`[media] ${prefix}: ${todo.length} downloaded, ${removed} removed -> ${localDir}`);
    return { downloaded: todo.length, removed };
  })().finally(() => { st.inflight = null; });
  prefixSyncs.set(prefix, st);
  return st.inflight;
}

/** Upload local files to MinIO: each rel path under localDir -> prefix + rel (and note it in the manifest). */
export async function pushFiles(prefix, localDir, rels = walkFiles(localDir)) {
  const manFile = path.join(localDir, '.manifest.json');
  let man = {};
  try { man = JSON.parse(fs.readFileSync(manFile, 'utf8')); } catch { /* none yet */ }
  for (const rel of rels) {
    const buf = fs.readFileSync(path.join(localDir, rel));
    await media().putObject(prefix + rel, buf);
    man[rel] = md5(buf);
  }
  fs.mkdirSync(localDir, { recursive: true });
  fs.writeFileSync(manFile, JSON.stringify(man));
  return rels.length;
}

export const listModelObjects = (prefix) => media().listObjects(prefix);
export const getModelObject = (key) => media().getObject(key);
export const putModelObject = (key, buf) => media().putObject(key, buf);
/** Move everything under a prefix to MinIO's trash/<date>/. */
export const trashModelObjects = (prefix) => media().trashObjects(prefix);
