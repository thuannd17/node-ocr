// /routes/acars-api.js
// ACARS pictures (services/acars.js): the cockpit's OOOI page read into Flt No, Dept, Dest, Out, Off, On, In, Info.
//
// Public (docs/openapi.json, used by /acars):
//   POST   /api/acars/read            multipart "file" (JPG, PNG, BMP, JFIF) -> { fields, ms, model } (the AI model;
//                                     ?engine=parser: the parser, /acars "Try to parse"; the picture is only read, never kept)
//   POST   /api/acars/suggestions     report a wrong reading (the picture + what is wrong) to the admins
//   POST   /api/acars/corrections     the fields as the user corrected them: the picture joins the data, its label
//                                     waiting for review on /label
// Admin (/label "ACARS files"; the pictures and labels live in MinIO, bucket ACARS_BUCKET, services/media-client.js acars):
//   GET    /api/acars/files           every picture with its label state and byte-identical copies
//   GET    /api/acars/raw?name=       the picture
//   GET    /api/acars/labels?name=    its label            POST: save a label { flt, dept, dest, out, off, on, in, info }
//   GET    /api/acars/parse?name=&engine=parser|model      Auto-fill: the parser (default) or the AI model
//   DELETE /api/acars/files?name=     move the picture and its label to trash/<date>/
import { Router } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import multer from 'multer';

import { acars, mediaErrorStatus } from '../services/media-client.js';
import { readAcarsPicture } from '../services/acars-read.js';
import { ACARS_FIELDS } from '../services/acars.js';
import { modelInfo } from '../services/pdf-ai-extract.js';
import { isDataName, kindOf, IMAGE_EXTS, reviewState, ACARS_LABELS_ROOT } from '../utils/data-files.js';
import { UPLOADS_DIR } from '../utils/paths.js';
import { createSuggestion, submitCorrection, cleanEmail } from './suggestions-api.js';

const router = Router();

const fail = (res, e, where) => {
  const status = e?.code === 'OCR_BUSY' ? 503 : mediaErrorStatus(e);
  if (status >= 500 && !['MEDIA_DOWN', 'OCR_BUSY'].includes(e?.code)) console.error(`[${where}]`, e);
  return res.status(status).json({ error: e.message || String(e), busy: e?.code === 'OCR_BUSY' || undefined });
};
const nameOf = (req) => {
  const name = String(req.query.name || '');
  return isDataName(name) && kindOf(name) === 'image' ? name : null;
};

// ---- public: read a picture ----

const upload = multer({
  dest: UPLOADS_DIR,
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => (kindOf(file.originalname) === 'image'
    ? cb(null, true)
    : cb(new Error(`Only ${IMAGE_EXTS.map(e => e.toUpperCase()).join(', ')} pictures are accepted`))),
});
const uploadFile = (req, res, next) => upload.single('file')(req, res, (err) => {
  if (!err) return next();
  res.status(err.code === 'LIMIT_FILE_SIZE' ? 413 : 400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'File larger than 10 MB' : err.message });
});

router.post('/acars/read', uploadFile, async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Send the ACARS picture in the multipart field "file"' });
  const engine = String(req.query.engine || 'model');
  if (!['model', 'parser'].includes(engine)) return res.status(400).json({ error: 'engine must be model or parser' });
  const t0 = Date.now();
  // the OCR server needs the extension to know the picture's format
  const file = req.file.path + path.extname(req.file.originalname).toLowerCase();
  try {
    fs.renameSync(req.file.path, file);
    const r = await readAcarsPicture(file, { engine });
    res.json({ fileName: req.file.originalname, source: engine, fields: r.fields, timings: r.timings, model: { trainedAt: modelInfo().trainedAt || null }, ms: Date.now() - t0 });
  } catch (e) {
    if (e.status === 409) return res.status(409).json({ error: e.message });
    fail(res, e, 'POST /api/acars/read');
  } finally {
    for (const p of [req.file.path, file]) fs.rm(p, { force: true }, () => {});
  }
});

/**
 * POST /api/acars/suggestions  multipart: file (the picture), email? (to get an answer), note? (what is wrong),
 * fields? (JSON, as read by POST /api/acars/read). Sends the picture to the admins (/helpdesk), who label it
 * (it then joins the ACARS training data) or dismiss it. -> 201 { id, status: 'pending' }
 */
router.post('/acars/suggestions', uploadFile, async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Send the ACARS picture in the multipart field "file"' });
  try {
    let fields = null;
    if (req.body?.fields) {
      try { fields = JSON.parse(req.body.fields); } catch { return res.status(400).json({ error: '"fields" must be JSON: { "flt": "...", "out": "...", ... }' }); }
    }
    const note = String(req.body?.note || '').trim();
    if (note.length > 2000) return res.status(400).json({ error: 'The note is longer than 2000 characters' });
    const email = cleanEmail(req.body?.email);
    if (email === null) return res.status(400).json({ error: 'The email address is not valid' });
    const s = await createSuggestion(req.file, { note, fields, acars: true, lang: req.lang, email });
    res.status(201).json({ id: s.id, status: s.status, createdAt: s.createdAt });
  } catch (e) {
    if (e.code !== 'MEDIA_DOWN') console.error('[acars suggestion]', e);
    res.status(e.code === 'MEDIA_DOWN' ? 503 : 500).json({ error: e.code === 'MEDIA_DOWN' ? 'Suggestions cannot be received right now, please try again later' : e.message });
  } finally {
    fs.rm(req.file.path, { force: true }, () => {});
  }
});

/**
 * POST /api/acars/corrections  multipart: file (the picture), fields (JSON { flt, date, dept, dest, out, off, on, in, info }:
 * as the user corrected them), note?. The picture joins the ACARS data with these fields as its label, waiting for an
 * admin's review on /label (not used for training until then). -> 201 { id, status: 'accepted', review: true }
 */
router.post('/acars/corrections', uploadFile, async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Send the ACARS picture in the multipart field "file"' });
  try {
    let fields;
    try { fields = JSON.parse(req.body?.fields || ''); } catch { return res.status(400).json({ error: '"fields" must be JSON: { "flt": "...", "out": "...", ... }' }); }
    if (!fields || typeof fields !== 'object' || !ACARS_FIELDS.some(f => String(fields[f] || '').trim())) {
      return res.status(400).json({ error: 'Every field is empty: fill in what the picture shows, or report it instead' });
    }
    const note = String(req.body?.note || '').trim();
    if (note.length > 2000) return res.status(400).json({ error: 'The note is longer than 2000 characters' });
    const { meta } = await submitCorrection(req.file, { fields, acars: true, note, lang: req.lang });
    res.status(201).json({ id: meta.id, status: meta.status, createdAt: meta.createdAt, review: true });
  } catch (e) {
    if (e.code !== 'MEDIA_DOWN') console.error('[acars correction]', e);
    res.status(e.code === 'MEDIA_DOWN' ? 503 : 500).json({ error: e.code === 'MEDIA_DOWN' ? 'Corrections cannot be received right now, please try again later' : e.message });
  } finally {
    fs.rm(req.file.path, { force: true }, () => {});
  }
});

// ---- admin: the dataset ----

router.get('/acars/files', async (req, res) => {
  try {
    const { index } = await acars.syncMedia({ maxAgeMs: 2000 });
    const labeled = new Map(index.labels.map(l => [l.name, l.md5]));
    const files = index.files.filter(f => kindOf(f.name) === 'image').sort((a, b) => a.name.localeCompare(b.name));
    const items = files.map(f => ({ name: f.name, labeled: labeled.has(f.name), review: labeled.has(f.name) ? reviewState(ACARS_LABELS_ROOT, f.name, labeled.get(f.name)) : null }));
    res.json({ items, counts: { files: items.length, labeled: items.filter(i => i.labeled).length } });
  } catch (e) {
    fail(res, e, 'GET /api/acars/files');
  }
});

router.get('/acars/raw', async (req, res) => {
  const name = nameOf(req);
  if (!name) return res.status(400).send('Missing or invalid ?name=');
  try {
    const file = await acars.localFile(name);
    if (!file) return res.status(404).send('File not found');
    res.sendFile(file);
  } catch (e) {
    res.status(mediaErrorStatus(e)).send(e.message);
  }
});

router.get('/acars/labels', async (req, res) => {
  const name = nameOf(req);
  if (!name) return res.status(400).json({ error: 'Missing or invalid ?name=' });
  try {
    const label = await acars.readLabel(name);
    if (!label) return res.status(404).json({ error: 'No label yet' });
    res.json(label);
  } catch (e) {
    fail(res, e, 'GET /api/acars/labels');
  }
});

router.post('/acars/labels', async (req, res) => {
  const name = nameOf(req);
  if (!name) return res.status(400).json({ error: 'Missing or invalid ?name=' });
  const body = req.body || {};
  if (ACARS_FIELDS.some(f => body[f] != null && typeof body[f] !== 'string')) return res.status(400).json({ error: `Fields must be text: ${ACARS_FIELDS.join(', ')}` });
  try {
    if (!(await acars.localFile(name))) return res.status(404).json({ error: 'File not found' });
    const label = Object.fromEntries(ACARS_FIELDS.map(f => [f, String(body[f] || '').trim()]));
    await acars.saveLabel(name, { ...label, _reviewedAt: new Date().toISOString() });
    res.json({ ok: true, name });
  } catch (e) {
    fail(res, e, 'POST /api/acars/labels');
  }
});

router.get('/acars/parse', async (req, res) => {
  const name = nameOf(req);
  if (!name) return res.status(400).json({ error: 'Missing or invalid ?name=' });
  const engine = req.query.engine === 'model' ? 'model' : 'parser';
  try {
    const file = await acars.localFile(name);
    if (!file) return res.status(404).json({ error: 'File not found' });
    res.json(await readAcarsPicture(file, { engine, cacheName: name }));
  } catch (e) {
    if (e.status === 409) return res.status(409).json({ error: e.message });
    fail(res, e, 'GET /api/acars/parse');
  }
});

router.delete('/acars/files', async (req, res) => {
  const name = nameOf(req);
  if (!name) return res.status(400).json({ error: 'Missing or invalid ?name=' });
  try {
    const { moved } = await acars.deleteFile(name);
    res.json({ ok: true, name, moved });
  } catch (e) {
    fail(res, e, 'DELETE /api/acars/files');
  }
});

export default router;
