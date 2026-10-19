// Storage of Roster OCR (MinIO): the only code that reads or writes the roster data and the trained models. The app server and
// its scripts use it through services/media-client.js (which adds the local mirror); it talks to
// MinIO directly (no service of its own). Object layout (MinIO bucket, or a folder with MEDIA_BACKEND=fs):
//
//   files/<ext>/<name>                 a roster file: image, PDF, CSV, XLS, XLSX, TXT
//   labels/<ext>/<name>.json           its verified label (ground truth)
//   suggestions/<id>/meta.json         a correction suggestion sent from /upload
//   suggestions/<id>/file.<ext>        ... and its roster file (removed once handled)
//   trash/<YYYY-MM-DD>/<key>           files and labels deleted on /label, models deleted on /models (nothing is erased)
//   models/ai/<id>/...                 a trained version of the AI roster model; models/ai/active.json: the one in use
//   models/rec/<ver>/checkpoint/...    OCR training checkpoints kept for later (not needed to read)
//
//   MEDIA_BACKEND = minio (default: MINIO_* settings) | fs (MEDIA_FS_DIR, a folder; tests / no MinIO)
//
// Errors carry .status (400 / 404 / ...); a store that cannot be reached gives code MEDIA_DOWN, status 503.
import crypto from 'node:crypto';
import path from 'node:path';
import { createMinioStore } from './minio-store.js';
import { createFsStore } from './fs-store.js';

export const EXTS = ['jpg', 'jpeg', 'png', 'jfif', 'bmp', 'pdf', 'csv', 'xls', 'xlsx', 'txt'];
const TYPES = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', jfif: 'image/jpeg', png: 'image/png', bmp: 'image/bmp', pdf: 'application/pdf',
  csv: 'text/csv', txt: 'text/plain', xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};
const extOf = (name) => path.extname(String(name)).slice(1).toLowerCase();
/** A plain file name of a roster type: no folders, no leading dot. */
export const isDataName = (name) => !!name && /^[^/\\]+$/.test(name) && !name.startsWith('.') && EXTS.includes(extOf(name));
const isSuggestionId = (id) => /^[0-9A-Za-z-]{6,64}$/.test(String(id));
/** A key of a model object: models/<part>/<part>..., plain parts only. */
const isModelKey = (key) => /^models(\/[A-Za-z0-9_][A-Za-z0-9._-]*)+$/.test(String(key)) && !String(key).split('/').includes('..');
const fileKey = (name) => `files/${extOf(name)}/${name}`;
const labelKey = (name) => `labels/${extOf(name)}/${name}.json`;
const md5 = (buf) => crypto.createHash('md5').update(buf).digest('hex');
const typeOf = (name) => TYPES[extOf(name)] || 'application/octet-stream';

const httpError = (status, message) => Object.assign(new Error(message), { status });
const DOWN_CODES = new Set(['ECONNREFUSED', 'ENOTFOUND', 'ETIMEDOUT', 'ECONNRESET', 'EHOSTUNREACH', 'EAI_AGAIN']);

/** The media functions on one object store (minio-store.js or fs-store.js). */
export function createMedia(store) {
  const where = () => {
    const d = store.describe();
    return d.backend === 'minio' ? `MinIO at ${d.endpoint}` : `the folder ${d.dir}`;
  };
  // every store call: a store that does not answer -> MEDIA_DOWN (503)
  const s = Object.fromEntries(['check', 'list', 'stat', 'get', 'put', 'remove'].map(k => [k, async (...a) => {
    try { return await store[k](...a); } catch (e) {
      if (DOWN_CODES.has(e.code) || DOWN_CODES.has(e.cause?.code) || e.errors?.some?.(x => DOWN_CODES.has(x.code))) {
        throw Object.assign(new Error(`Cannot reach ${where()} (is it running?)`), { code: 'MEDIA_DOWN', status: 503, cause: e });
      }
      throw e;
    }
  }]));
  const getOrNull = async (key) => {
    try { return await s.get(key); } catch (e) { if (e.code === 'NotFound') return null; throw e; }
  };
  const checkName = (name) => {
    if (!isDataName(name)) throw httpError(400, 'Invalid file name');
    return name;
  };

  // In-memory index of files/ and labels/; writes through here keep it current, and it is re-read
  // after 30 s so changes made elsewhere (another process, the MinIO console) show up too.
  let index = null, indexAt = 0;
  async function getIndex(fresh = false) {
    if (!index || fresh || Date.now() - indexAt > 30000) {
      const [files, labels] = await Promise.all([s.list('files/'), s.list('labels/')]);
      const pick = (objs, re) => new Map(objs.map(o => [re.exec(o.key)?.[1], o]).filter(([n]) => isDataName(n))
        .map(([n, o]) => [n, { name: n, size: o.size, md5: o.etag, lastModified: o.lastModified }]));
      index = { files: pick(files, /^files\/[^/]+\/([^/]+)$/), labels: pick(labels, /^labels\/[^/]+\/([^/]+)\.json$/) };
      indexAt = Date.now();
    }
    return index;
  }

  async function putFile(name, buf) {
    checkName(name);
    if (!buf?.length) throw httpError(400, 'Empty file');
    await s.put(fileKey(name), buf, typeOf(name));
    (await getIndex()).files.set(name, { name, size: buf.length, md5: md5(buf), lastModified: new Date() });
    return { name, md5: md5(buf) };
  }

  // ---- correction suggestions ----
  const sKey = (id, part) => `suggestions/${id}/${part}`;
  const sFile = (meta) => sKey(meta.id, `file.${String(meta.fileType || '').toLowerCase()}`);
  const readMeta = async (id) => {
    if (!isSuggestionId(id)) return null;
    const buf = await getOrNull(sKey(id, 'meta.json'));
    return buf ? JSON.parse(buf.toString('utf8')) : null;
  };
  const metaOr404 = async (id) => (await readMeta(id)) || Promise.reject(httpError(404, 'Suggestion not found'));
  const writeMeta = (meta) => s.put(sKey(meta.id, 'meta.json'), Buffer.from(JSON.stringify(meta, null, 2)), 'application/json');

  return {
    describe: () => store.describe(),
    /** { ok, backend, endpoint?, bucket?, dir?, error? } — never throws. */
    async health() {
      try {
        await s.check();
        return { ok: true, ...store.describe() };
      } catch (e) {
        return { ok: false, ...store.describe(), error: e.message };
      }
    },
    /** { files: [{ name, size, md5, lastModified }], labels: [...] } */
    async index(fresh = false) {
      const idx = await getIndex(fresh);
      return { files: [...idx.files.values()], labels: [...idx.labels.values()] };
    },

    // ---- roster files ----
    /** The bytes (null: no such file). */
    getFile: async (name) => getOrNull(fileKey(checkName(name))),
    /**
     * Keep a new roster file: stored as '<uuid>.<ext>', or the file with the same content when there
     * is one (a labeled copy first). -> { name, isNew }
     */
    async storeFile(buf, originalName) {
      const original = path.basename(String(originalName || ''));
      if (!isDataName(original)) throw httpError(400, 'The original file name must be of a roster type');
      if (!buf?.length) throw httpError(400, 'Empty file');
      const idx = await getIndex(true);
      const hash = md5(buf);
      const same = [...idx.files.values()].filter(f => f.md5 === hash).map(f => f.name).sort();
      if (same.length) return { name: same.find(n => idx.labels.has(n)) || same[0], isNew: false };
      const name = `${crypto.randomUUID()}.${extOf(original)}`;
      await putFile(name, buf);
      return { name, isNew: true };
    },
    /** Store under exactly this name (one-time import of the old folders). */
    putFile,
    /** Move the file and its label to trash/<date>/. -> { moved: [keys] } */
    async deleteFile(name) {
      checkName(name);
      const idx = await getIndex();
      if (!(await s.stat(fileKey(name)))) throw httpError(404, 'File not found');
      const day = new Date().toISOString().slice(0, 10);
      const moved = [];
      for (const key of [fileKey(name), labelKey(name)]) {
        if (!(await s.stat(key))) continue;
        await s.put(`trash/${day}/${key}`, await s.get(key), key.endsWith('.json') ? 'application/json' : typeOf(name));
        await s.remove(key);
        moved.push(`trash/${day}/${key}`);
      }
      idx.files.delete(name);
      idx.labels.delete(name);
      return { name, moved };
    },

    // ---- labels ----
    /** The label JSON bytes (null: none yet). */
    getLabel: async (name) => getOrNull(labelKey(checkName(name))),
    /** Save a label's JSON text byte for byte; its file must exist. */
    async putLabel(name, buf) {
      checkName(name);
      let label;
      try { label = JSON.parse(Buffer.from(buf).toString('utf8')); } catch { throw httpError(400, 'The label must be JSON'); }
      if (!label || typeof label !== 'object' || Array.isArray(label)) throw httpError(400, 'The label must be a JSON object');
      if (!(await s.stat(fileKey(name)))) throw httpError(404, 'File not found');
      await s.put(labelKey(name), buf, 'application/json');
      (await getIndex()).labels.set(name, { name, size: buf.length, md5: md5(buf), lastModified: new Date() });
      return { name, md5: md5(buf) };
    },
    async deleteLabel(name) {
      await s.remove(labelKey(checkName(name)));
      (await getIndex()).labels.delete(name);
    },

    // ---- correction suggestions ----
    /** Every meta, newest first, each with hasFile. */
    async listSuggestions() {
      const objects = await s.list('suggestions/');
      const keys = new Set(objects.map(o => o.key));
      const metas = [];
      for (const o of objects.filter(o => o.key.endsWith('/meta.json'))) {
        try {
          const meta = JSON.parse((await s.get(o.key)).toString('utf8'));
          metas.push({ ...meta, hasFile: keys.has(sFile(meta)) });
        } catch (e) { if (e.code === 'MEDIA_DOWN') throw e; /* a broken meta.json: skipped */ }
      }
      return metas.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
    },
    /** meta with hasFile (null: none). */
    async getSuggestion(id) {
      const meta = await readMeta(id);
      return meta && { ...meta, hasFile: !!(await s.stat(sFile(meta))) };
    },
    /** Write a suggestion's meta (meta.id) and, when given, its file (meta.fileType). -> meta */
    async putSuggestion(meta, file = null) {
      if (!meta || typeof meta !== 'object' || !isSuggestionId(meta.id)) throw httpError(400, 'A suggestion needs a valid id');
      if (file) {
        if (!EXTS.includes(String(meta.fileType || '').toLowerCase())) throw httpError(400, 'meta.fileType must be a roster type');
        await s.put(sFile(meta), file, typeOf(`x.${meta.fileType}`));
      }
      await writeMeta(meta);
      return meta;
    },
    /** Merge fields into a suggestion's meta. -> meta */
    async patchSuggestion(id, part) {
      const meta = { ...(await metaOr404(id)), ...(part || {}), id };
      await writeMeta(meta);
      return meta;
    },
    /** The bytes of a suggestion's file (null: no such suggestion, or its file was removed). */
    async getSuggestionFile(id) {
      const meta = await readMeta(id);
      return meta ? getOrNull(sFile(meta)) : null;
    },
    async deleteSuggestionFile(id) {
      await s.remove(sFile(await metaOr404(id)));
    },
    async deleteSuggestion(id) {
      if (!isSuggestionId(id)) throw httpError(404, 'Suggestion not found');
      for (const o of await s.list(`suggestions/${id}/`)) await s.remove(o.key);
    },

    // ---- models (keys under models/: trained versions, checkpoints) ----
    /** [{ key, size, md5, lastModified }] under a prefix ('models/ai/') */
    async listObjects(prefix) {
      if (!/^models\//.test(String(prefix))) throw httpError(400, 'Only models/ can be listed');
      return (await s.list(prefix)).map(o => ({ key: o.key, size: o.size, md5: o.etag, lastModified: o.lastModified }));
    },
    /** The bytes (null: none). */
    async getObject(key) {
      if (!isModelKey(key)) throw httpError(400, `Invalid model key: ${key}`);
      return getOrNull(key);
    },
    async putObject(key, buf) {
      if (!isModelKey(key)) throw httpError(400, `Invalid model key: ${key}`);
      await s.put(key, buf, key.endsWith('.json') ? 'application/json' : 'application/octet-stream');
      return { key, md5: md5(buf) };
    },
    /** Move every object under a prefix ('models/ai/<id>/') to trash/<date>/. -> moved keys */
    async trashObjects(prefix) {
      if (!isModelKey(prefix.replace(/\/$/, ''))) throw httpError(400, `Invalid model key: ${prefix}`);
      const day = new Date().toISOString().slice(0, 10);
      const moved = [];
      for (const o of await s.list(prefix)) {
        await s.put(`trash/${day}/${o.key}`, await s.get(o.key), 'application/octet-stream');
        await s.remove(o.key);
        moved.push(`trash/${day}/${o.key}`);
      }
      return moved;
    },
  };
}

/** The store chosen by the environment: MinIO (MINIO_*) or a folder (MEDIA_BACKEND=fs, MEDIA_FS_DIR). */
export function storeFromEnv(env = process.env) {
  return String(env.MEDIA_BACKEND || 'minio').toLowerCase() === 'fs'
    ? createFsStore(env.MEDIA_FS_DIR || 'media-data')
    : createMinioStore(env);
}
