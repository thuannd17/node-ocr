// /routes/media-api.js
// Admin API of the /media page: the roster files MinIO holds (services/storage/, services/media-client.js).
// Not part of the public API (docs/openapi.json): roster files are personal data.
//
//   GET  /api/media/status          MinIO (or the fs store), the mirror, counts
//   GET  /api/media/items           every roster file with its label state
//   GET  /api/media/file?name=      the file, read from MinIO (CSV / Excel / TXT as an HTML table)
//   DELETE /api/media/file?name=    move the file (and its label) to trash/<date>/ in MinIO
//   POST /api/media/delete-unlabeled  { kind?: 'image'|'pdf' } move every file without a label to the trash
//   POST /api/media/upload          multipart files (up to 20) + target: roster (default) | acars -> stored as
//                                   <uuid>.<ext>, or the file already there with the same content; label them on /label
import { Router } from 'express';
import fs from 'node:fs';
import multer from 'multer';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { isDataName, extOf, kindOf, dataFile, DATA_ROOT, IMAGE_EXTS } from '../utils/data-files.js';
import { previewHtml } from '../services/table-text.js';
import { mediaHealth, mediaIndex, mirrorState, fileBytes, deleteFile, storeFile, acars, mediaErrorStatus } from '../services/media-client.js';
import { CACHE_DIR, UPLOADS_DIR } from '../utils/paths.js';

const router = Router();
const fail = (res, e) => {
  const status = mediaErrorStatus(e);
  if (status >= 500 && e?.code !== 'MEDIA_DOWN') console.error('[media-api]', e);
  res.status(status).json({ error: e.message });
};

router.get('/media/status', async (req, res) => {
  const service = await mediaHealth();
  let counts = null;
  if (service.ok) {
    try {
      const index = await mediaIndex();
      const labeled = new Set(index.labels.map(l => l.name));
      counts = {
        files: index.files.length,
        labeled: index.files.filter(f => labeled.has(f.name)).length,
        bytes: index.files.reduce((a, f) => a + (f.size || 0), 0),
        byType: index.files.reduce((a, f) => ({ ...a, [extOf(f.name)]: (a[extOf(f.name)] || 0) + 1 }), {}),
      };
    } catch (e) { service.error = e.message; }
  }
  res.json({ service, mirror: mirrorState(), counts });
});

router.get('/media/items', async (req, res) => {
  try {
    const index = await mediaIndex();
    const labels = new Map(index.labels.map(l => [l.name, l]));
    const items = index.files.map(f => ({
      name: f.name, kind: kindOf(f.name), ext: extOf(f.name), size: f.size,
      lastModified: [f.lastModified, labels.get(f.name)?.lastModified].filter(Boolean).sort().pop(),
      labeled: labels.has(f.name), cached: fs.existsSync(dataFile(DATA_ROOT, f.name)),
    })).sort((a, b) => a.name.localeCompare(b.name));
    res.json({ items, counts: { labeled: items.filter(i => i.labeled).length, unlabeled: items.filter(i => !i.labeled).length } });
  } catch (e) { fail(res, e); }
});

router.get('/media/file', async (req, res) => {
  const name = String(req.query.name || '');
  if (!isDataName(name)) return res.status(400).json({ error: 'Missing or invalid ?name=' });
  try {
    const buf = await fileBytes(name);
    if (!buf) return res.status(404).json({ error: 'File not found' });
    const ext = extOf(name);
    if (IMAGE_EXTS.includes(ext)) return res.type(ext === 'jfif' ? 'image/jpeg' : ext).send(buf);
    if (ext === 'pdf') return res.type('application/pdf').send(buf);
    const tmp = path.join(os.tmpdir(), `roster-media-${crypto.randomUUID()}.${ext}`);
    fs.writeFileSync(tmp, buf);
    try { res.type('html').send(previewHtml(tmp)); } finally { fs.rm(tmp, { force: true }, () => {}); }
  } catch (e) { fail(res, e); }
});

// Nothing is erased: the file and its label go to trash/<date>/ in MinIO, so a wrong delete can be undone there.
async function trash(name) {
  const { moved } = await deleteFile(name);
  fs.rmSync(path.join(CACHE_DIR, 'parsed', `${name}.json`), { force: true });
  return moved;
}

router.delete('/media/file', async (req, res) => {
  const name = String(req.query.name || '');
  if (!isDataName(name)) return res.status(400).json({ error: 'Missing or invalid ?name=' });
  try {
    const moved = await trash(name);
    res.json({ ok: true, name, moved });
  } catch (e) { fail(res, e); }
});

// The label state is read fresh from MinIO here, so a file labeled meanwhile on /label is never deleted.
router.post('/media/delete-unlabeled', async (req, res) => {
  const kind = String(req.body?.kind || '');
  if (kind && !['image', 'pdf'].includes(kind)) return res.status(400).json({ error: 'Invalid kind' });
  try {
    const index = await mediaIndex(true);
    const labeled = new Set(index.labels.map(l => l.name));
    const names = index.files.map(f => f.name).filter(n => !labeled.has(n) && (!kind || kindOf(n) === kind));
    const failed = [];
    for (const name of names) {
      try { await trash(name); } catch (e) { failed.push({ name, error: e.message }); }
    }
    res.json({ ok: true, deleted: names.length - failed.length, failed });
  } catch (e) { fail(res, e); }
});

// ---- an admin adds files to the data (as an accepted suggestion would), to label them on /label ----
const upload = multer({ dest: UPLOADS_DIR, limits: { fileSize: 10 * 1024 * 1024, files: 20 } });
const uploadFiles = (req, res, next) => upload.array('files', 20)(req, res, (err) => {
  if (!err) return next();
  const msg = { LIMIT_FILE_SIZE: 'A file is larger than 10 MB', LIMIT_FILE_COUNT: 'At most 20 files at a time', LIMIT_UNEXPECTED_FILE: 'At most 20 files at a time' }[err.code];
  res.status(err.code === 'LIMIT_FILE_SIZE' ? 413 : 400).json({ error: msg || err.message });
});

router.post('/media/upload', uploadFiles, async (req, res) => {
  const files = req.files || [];
  const target = String(req.body?.target || 'roster');
  try {
    if (!['roster', 'acars'].includes(target)) return res.status(400).json({ error: 'target must be roster or acars' });
    if (!files.length) return res.status(400).json({ error: 'Send the files in the multipart field "files"' });
    const items = [];
    for (const f of files) {
      const original = path.basename(f.originalname);
      const kind = kindOf(original);
      if (target === 'acars' ? kind !== 'image' : !kind) {
        items.push({ original, error: target === 'acars' ? 'Not a picture (JPG, PNG, BMP, JFIF)' : 'Not a roster file type' });
        continue;
      }
      try {
        const buf = fs.readFileSync(f.path);
        const { name, isNew } = target === 'acars' ? await acars.storeFile(buf, original) : await storeFile(buf, original);
        items.push({ original, name, isNew, target });
      } catch (e) {
        if (e.code === 'MEDIA_DOWN') throw e;
        items.push({ original, error: e.message });
      }
    }
    res.json({ ok: true, target, items });
  } catch (e) {
    fail(res, e);
  } finally {
    for (const f of files) fs.rm(f.path, { force: true }, () => {});
  }
});

export default router;
