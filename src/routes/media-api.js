// /routes/media-api.js
// Admin API of the /media page: what MinIO holds (media/, services/media-client.js) and the local mirror.
// Not part of the public API (docs/openapi.json): roster files are personal data.
//
//   GET  /api/media/status          MinIO (or the fs store), the mirror, counts
//   POST /api/media/sync            bring the local mirror up to date now
//   GET  /api/media/items           every roster file with its label state
//   GET  /api/media/file?name=      the file, read from MinIO (CSV / Excel / TXT as an HTML table)
//   GET  /api/media/label?name=     its label
import { Router } from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { isDataName, extOf, kindOf, dataFile, DATA_ROOT, IMAGE_EXTS } from '../utils/data-files.js';
import { previewHtml } from '../services/table-text.js';
import { mediaHealth, mediaIndex, mirrorState, syncMedia, fileBytes, readLabel, mediaErrorStatus } from '../services/media-client.js';

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

router.post('/media/sync', async (req, res) => {
  try {
    const r = await syncMedia({ force: true });
    res.json({ downloaded: r.downloaded, removed: r.removed, ms: r.ms, files: r.index.files.length, labels: r.index.labels.length });
  } catch (e) { fail(res, e); }
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

router.get('/media/label', async (req, res) => {
  const name = String(req.query.name || '');
  if (!isDataName(name)) return res.status(400).json({ error: 'Missing or invalid ?name=' });
  try {
    const label = await readLabel(name);
    if (!label) return res.status(404).json({ error: 'No label yet' });
    res.json(label);
  } catch (e) { fail(res, e); }
});

export default router;
