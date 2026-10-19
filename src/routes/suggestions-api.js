// /routes/suggestions-api.js
// Correction suggestions: a user of /upload thinks the AI model read their roster wrong and sends
// the file (POST /api/roster/suggestions, public, in routes/roster-api.js). Uploads are never kept
// otherwise, so this is the only way a roster from outside reaches the training data.
// Admins handle them on /label (admin API, not in docs/openapi.json):
//   GET  /api/suggestions?status=pending|accepted|dismissed|all   list (newest first)
//   GET  /api/suggestions/:id/file                                the file (CSV / Excel / TXT as an HTML table)
//   POST /api/suggestions/:id/accept   add the file to the data (deduplicated) -> { name } to label
//   POST /api/suggestions/:id/dismiss  drop it: the file is deleted, the record kept
// Stored by MinIO (suggestions/<id>/meta.json + file.<ext>, services/media-client.js).
import { Router } from 'express';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import crypto from 'node:crypto';

import { previewHtml } from '../services/table-text.js';
import { extOf, kindOf } from '../utils/data-files.js';
import {
  listSuggestions, getSuggestion, putSuggestion, patchSuggestion, suggestionFile, deleteSuggestionFile,
  storeFile, mediaErrorStatus,
} from '../services/media-client.js';

const ID_RE = /^\d{8}-\d{6}-[0-9a-f]{6}$/;
const STATUSES = ['pending', 'accepted', 'dismissed'];
const MIME = { jpg: 'image/jpeg', jpeg: 'image/jpeg', jfif: 'image/jpeg', png: 'image/png', bmp: 'image/bmp', pdf: 'application/pdf' };

/** Rows sent with a suggestion: only the two tables, as arrays of plain objects. */
function cleanRows(rows) {
  if (!rows || typeof rows !== 'object') return null;
  const pick = (a) => (Array.isArray(a) ? a.filter(r => r && typeof r === 'object').slice(0, 2000) : []);
  return { published: pick(rows.published), planned: pick(rows.planned) };
}

/** Keep a suggestion: the multer temp file goes to MinIO with its meta. -> meta */
export async function createSuggestion(file, { note = '', rows = null, lang = 'en' } = {}) {
  const now = new Date();
  const stamp = now.toISOString().replace(/\D/g, '');
  const id = `${stamp.slice(0, 8)}-${stamp.slice(8, 14)}-${crypto.randomBytes(3).toString('hex')}`;
  const buf = fs.readFileSync(file.path);
  const meta = {
    id,
    createdAt: now.toISOString(),
    status: 'pending',
    fileName: path.basename(file.originalname),
    fileType: extOf(file.originalname),
    kind: kindOf(file.originalname),
    size: buf.length,
    md5: crypto.createHash('md5').update(buf).digest('hex'),
    note,
    lang,
    rows: cleanRows(rows),
  };
  await putSuggestion(meta, buf);
  return meta;
}

const router = Router();
const fail = (res, e) => {
  const status = mediaErrorStatus(e);
  if (status >= 500 && e?.code !== 'MEDIA_DOWN') console.error('[suggestions]', e);
  res.status(status).json({ error: e.message });
};

// One suggestion by :id (404 when unknown)
router.param('id', async (req, res, next, id) => {
  try {
    const meta = ID_RE.test(id) ? await getSuggestion(id) : null;
    if (!meta) return res.status(404).json({ error: 'Suggestion not found' });
    req.suggestion = meta;
    next();
  } catch (e) { fail(res, e); }
});

router.get('/suggestions', async (req, res) => {
  const status = String(req.query.status || 'pending');
  if (status !== 'all' && !STATUSES.includes(status)) return res.status(400).json({ error: `status must be one of: ${[...STATUSES, 'all'].join(', ')}` });
  try {
    const all = await listSuggestions();
    const counts = Object.fromEntries(STATUSES.map(s => [s, all.filter(x => x.status === s).length]));
    const items = all.filter(x => status === 'all' || x.status === status).map(({ rows, ...m }) => ({
      ...m, rowCount: rows ? rows.published.length + rows.planned.length : null,
    }));
    res.json({ items, counts });
  } catch (e) { fail(res, e); }
});

router.get('/suggestions/:id', (req, res) => res.json(req.suggestion));

router.get('/suggestions/:id/file', async (req, res) => {
  const meta = req.suggestion;
  try {
    const buf = await suggestionFile(meta.id);
    if (!buf) return res.status(410).json({ error: 'The file of this suggestion was removed' });
    if (MIME[meta.fileType]) return res.type(MIME[meta.fileType]).send(buf);
    // CSV / Excel / TXT: shown as a table or as text (the readers need a file with its extension)
    const tmp = path.join(os.tmpdir(), `roster-suggestion-${crypto.randomUUID()}.${meta.fileType}`);
    fs.writeFileSync(tmp, buf);
    try { res.type('html').send(previewHtml(tmp)); } finally { fs.rm(tmp, { force: true }, () => {}); }
  } catch (e) { fail(res, e); }
});

router.post('/suggestions/:id/accept', async (req, res) => {
  const meta = req.suggestion;
  if (meta.status !== 'pending') return res.status(409).json({ error: `This suggestion is already ${meta.status}` });
  try {
    const buf = await suggestionFile(meta.id);
    if (!buf) return res.status(410).json({ error: 'The file of this suggestion was removed' });
    const { name, isNew } = await storeFile(buf, meta.fileName);
    await patchSuggestion(meta.id, { status: 'accepted', handledAt: new Date().toISOString(), dataName: name, alreadyInData: !isNew });
    await deleteSuggestionFile(meta.id); // the roster now is in the data
    res.json({ ok: true, name, isNew });
  } catch (e) { fail(res, e); }
});

router.post('/suggestions/:id/dismiss', async (req, res) => {
  const meta = req.suggestion;
  if (meta.status !== 'pending') return res.status(409).json({ error: `This suggestion is already ${meta.status}` });
  try {
    await deleteSuggestionFile(meta.id); // not kept: it is someone's roster
    await patchSuggestion(meta.id, { status: 'dismissed', handledAt: new Date().toISOString(), rows: null });
    res.json({ ok: true });
  } catch (e) { fail(res, e); }
});

export default router;
