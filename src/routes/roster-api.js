// /routes/roster-api.js
// POST /api/roster/upload: the public way to read a roster, whatever its file type
// (documented in docs/openapi.json, /api-docs; used by /roster).
// One multipart field "file"; the server picks the reader from the file type:
//   image (JPG, PNG, BMP, JFIF)          -> OCR + AI model          (routes/api.js readRosterImage)
//   PDF, CSV, XLS, XLSX, TXT             -> text / OCR + AI model   (routes/pdf-api.js readRosterFile)
// and answers with one shape for all of them (see RosterResult in docs/openapi.json).
// ?engine=parser: the parser instead of the AI model (/roster "Try to parse", while correcting a reading).
// The file is only read, never kept: to send it to the admins use POST /api/roster/suggestions (a report:
// what is wrong) or POST /api/roster/corrections (the rows the user corrected, to be reviewed on /label).
// The older POST /api/ocr/upload and /api/pdf/upload still work but are deprecated.
import { Router } from 'express';
import fs from 'node:fs';
import multer from 'multer';

import { readRosterImage } from './api.js';
import { readRosterFile } from './pdf-api.js';
import { modelInfo } from '../services/pdf-ai-extract.js';
import { IMAGE_EXTS, PDF_EXTS, extOf, kindOf } from '../utils/data-files.js';
import { createSuggestion, submitCorrection, cleanEmail } from './suggestions-api.js';
import { UPLOADS_DIR } from '../utils/paths.js';

const router = Router();

const upload = multer({
  dest: UPLOADS_DIR,
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => (kindOf(file.originalname)
    ? cb(null, true)
    : cb(new Error(`Only ${[...IMAGE_EXTS, ...PDF_EXTS].map(e => e.toUpperCase()).join(', ')} files are accepted`))),
});
const uploadFile = (req, res, next) => upload.single('file')(req, res, (err) => {
  if (!err) return next();
  res.status(err.code === 'LIMIT_FILE_SIZE' ? 413 : 400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'File larger than 10 MB' : err.message });
});

router.post('/roster/upload', uploadFile, async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Send the roster in the multipart field "file"' });
  const engine = String(req.query.engine || 'model');
  if (!['model', 'parser'].includes(engine)) return res.status(400).json({ error: 'engine must be model or parser' });
  const t0 = Date.now();
  const fileType = extOf(req.file.originalname);
  try {
    let out;
    if (kindOf(req.file.originalname) === 'image') {
      const r = await readRosterImage(req.file, { engine });
      out = {
        fileName: r.fileName, fileType,
        readMode: 'ocr-image', source: r.source, period: r.period || null, notices: [],
        published: r.published, planned: r.planned, timings: r.timings,
      };
    } else {
      const r = await readRosterFile(req.file, { engine, preview: req.query.preview === '1' || req.query.preview === 'true' });
      out = {
        fileName: r.fileName, fileType,
        readMode: r.readMode || 'text', source: r.source, period: r.period || null, notices: r.notices || [],
        published: r.published || [], planned: r.planned || [],
        ...(r.previewHtml ? { previewHtml: r.previewHtml } : {}),
      };
    }
    res.json({ ...out, model: { trainedAt: modelInfo().trainedAt || null }, ms: Date.now() - t0 });
  } catch (e) {
    console.error('[roster upload]', e.message);
    res.status(e.code === 'OCR_BUSY' ? 503 : 500).json({ error: e.message || 'Something went wrong', busy: e.code === 'OCR_BUSY' || undefined });
  } finally {
    fs.rm(req.file.path, { force: true }, () => {}); // the upload is never kept (already removed for images)
  }
});

/**
 * POST /api/roster/suggestions  multipart: file (the roster), note? (what is wrong), email? (to get an answer), rows? (JSON
 * { published, planned } as read by POST /api/roster/upload). Sends the roster to the admins, who
 * label it (it then joins the training data) or dismiss it on /label. -> 201 { id, status: 'pending' }
 */
router.post('/roster/suggestions', uploadFile, async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Send the roster in the multipart field "file"' });
  try {
    let rows = null;
    if (req.body?.rows) {
      try { rows = JSON.parse(req.body.rows); } catch { return res.status(400).json({ error: '"rows" must be JSON: { "published": [...], "planned": [...] }' }); }
    }
    const note = String(req.body?.note || '').trim();
    if (note.length > 2000) return res.status(400).json({ error: 'The note is longer than 2000 characters' });
    const email = cleanEmail(req.body?.email);
    if (email === null) return res.status(400).json({ error: 'The email address is not valid' });
    const s = await createSuggestion(req.file, { note, rows, lang: req.lang, email });
    res.status(201).json({ id: s.id, status: s.status, createdAt: s.createdAt });
  } catch (e) {
    if (e.code !== 'MEDIA_DOWN') console.error('[roster suggestion]', e);
    res.status(e.code === 'MEDIA_DOWN' ? 503 : 500).json({ error: e.code === 'MEDIA_DOWN' ? 'Suggestions cannot be received right now, please try again later' : e.message });
  } finally {
    fs.rm(req.file.path, { force: true }, () => {});
  }
});

/**
 * POST /api/roster/corrections  multipart: file (the roster), rows (JSON { published, planned }: the rows as the user
 * corrected them), period?, note?. The roster joins the data with these rows as its label, waiting for an admin's
 * review on /label (it is not used for training until then). -> 201 { id, status: 'accepted', review: true }
 */
router.post('/roster/corrections', uploadFile, async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Send the roster in the multipart field "file"' });
  try {
    let rows;
    try { rows = JSON.parse(req.body?.rows || ''); } catch { return res.status(400).json({ error: '"rows" must be JSON: { "published": [...], "planned": [...] }' }); }
    if (!Array.isArray(rows?.published) || !Array.isArray(rows?.planned)) return res.status(400).json({ error: '"rows" must be JSON: { "published": [...], "planned": [...] }' });
    if (!rows.published.length && !rows.planned.length) return res.status(400).json({ error: 'Both tables are empty: add the rows of the roster, or report it instead' });
    const note = String(req.body?.note || '').trim();
    if (note.length > 2000) return res.status(400).json({ error: 'The note is longer than 2000 characters' });
    const { meta } = await submitCorrection(req.file, { rows, period: req.body?.period, note, lang: req.lang });
    res.status(201).json({ id: meta.id, status: meta.status, createdAt: meta.createdAt, review: true });
  } catch (e) {
    if (e.code !== 'MEDIA_DOWN') console.error('[roster correction]', e);
    res.status(e.code === 'MEDIA_DOWN' ? 503 : 500).json({ error: e.code === 'MEDIA_DOWN' ? 'Corrections cannot be received right now, please try again later' : e.message });
  } finally {
    fs.rm(req.file.path, { force: true }, () => {});
  }
});

export default router;
