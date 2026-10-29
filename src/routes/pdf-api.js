// /routes/pdf-api.js
// API for NetLine/Crew duty-plan PDFs (text layer, no OCR), mounted at /api/pdf.
// Same flow as images: upload -> check/fix the table -> Save as Label -> benchmark.
// The files and their verified labels live in MinIO (services/media-client.js):
// files/pdf/<guid>.pdf + labels/pdf/<guid>.pdf.json, the same for CSV / XLS / XLSX / TXT (read as text).
// A file is read from the local mirror (localFile), a label fresh from the service (readLabel).
import { Router } from 'express';
import path from 'node:path';
import fs from 'node:fs';
import multer from 'multer';

import { parsePdfFile, compareRows, PDF_FIELDS, PDF_SECTIONS } from '../services/pdf-benchmark.js';
import { compareSection } from '../services/benchmark.js';
import { readPdfWithModel, modelInfo } from '../services/pdf-ai-extract.js';
import { PDF_EXTS, extOf, reviewState, LABELS_ROOT } from '../utils/data-files.js';
import { syncMedia, localFile, readLabel, saveLabel, mediaErrorStatus } from '../services/media-client.js';
import { previewHtml } from '../services/table-text.js';
import { UPLOADS_DIR } from '../utils/paths.js';

const router = Router();
const validName = (name) => !!name && path.basename(name) === name && PDF_EXTS.includes(extOf(name));
const notFound = (message) => Object.assign(new Error(message), { status: 404 });
const fail = (res, e, where) => {
  const status = mediaErrorStatus(e);
  if (status >= 500 && e?.code !== 'MEDIA_DOWN') console.error(`[${where}]`, e);
  return res.status(status).json({ error: e.message || String(e) });
};

/**
 * Rows of a stored PDF.
 *   engine 'model'  (/roster, always): the learned model, to try out a newly trained one.
 *                   An image-only PDF has no words for it: the parser (on OCR text) reads it, with a notice.
 *   engine 'parser' (/label Auto-fill): services/pdf-roster-parser.js.
 *   useLabel: return the verified label instead, when there is one (?label=true, /label).
 * When the file has a label, vsLabel = how many label rows the result got exactly right.
 */
async function resultFor(name, { engine = 'model', useLabel = false } = {}) {
  const t0 = Date.now();
  const file = await localFile(name);
  if (!file) throw notFound('PDF not found');
  let parsed = await parsePdfFile(file); // also for the model / a label: period and notices come from the PDF
  let source = 'parser';
  const notices = [...(parsed.notices || [])];
  const label = await readLabel(name);
  const labeled = !!label;
  if (useLabel && labeled) {
    return {
      fileName: name, source: 'label', labeled: true, period: label.period || parsed.period, notices, readMode: parsed.readMode,
      published: label.published || [], planned: label.planned || [], ms: Date.now() - t0,
    };
  }
  if (engine === 'model') {
    if (!modelInfo().ready) throw new Error('No AI model yet: label a few files, then click "Train" on /models.');
    // text layer: the model on its words; a roster picture printed to PDF: the model on its OCR lines, as for an image;
    // an image-only duty plan: the parser on OCR text (the model has no words for it)
    const read = await readPdfWithModel(file);
    parsed = { ...parsed, ...read, period: read.period || parsed.period };
    source = read.source;
    if (read.source === 'parser') notices.unshift('This PDF only has images (no text layer), so the AI model cannot read it yet; the table below is what the parser read from the OCR text.');
    else if (read.readMode === 'ocr-image') notices.unshift('This PDF only has images: its pages were OCRed, joined into one roster image and read by the AI model like an image.');
  }
  let vsLabel = null;
  if (labeled) {
    vsLabel = { rowMatches: 0, rowTotal: 0 };
    for (const sec of PDF_SECTIONS) {
      // a roster picture printed to PDF: compared as an image (OCR-tolerant)
      const c = parsed.readMode === 'ocr-image'
        ? (({ rowMatches, expCount }) => ({ rowMatches, rowTotal: expCount }))(compareSection(parsed[sec] || [], label[sec] || []))
        : compareRows(parsed[sec] || [], label[sec] || []);
      vsLabel.rowMatches += c.rowMatches;
      vsLabel.rowTotal += c.rowTotal;
    }
  }
  return {
    fileName: name,
    source,
    labeled,
    vsLabel,
    recognized: parsed.recognized,
    period: parsed.period,
    notices,
    readMode: parsed.readMode,
    published: parsed.published,
    planned: parsed.planned,
    ms: Date.now() - t0,
  };
}

const upload = multer({
  dest: UPLOADS_DIR,
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => (PDF_EXTS.includes(extOf(file.originalname)) ? cb(null, true) : cb(new Error('Only PDF, CSV, XLS, XLSX and TXT files are accepted'))),
});

const uploadFile = (req, res, next) => upload.single('file')(req, res, (err) => (err ? res.status(400).json({ error: err.message }) : next()));

/**
 * Read an uploaded PDF / CSV / XLS / XLSX / TXT roster (a multer file) with the AI model, as for
 * /roster: never from a saved label. The file is NOT kept (since 2026-10-18 a roster only joins
 * the data when an admin accepts a correction suggestion, routes/suggestions-api.js).
 * Used by POST /api/roster/upload (routes/roster-api.js) and the deprecated POST /api/pdf/upload.
 * { preview: true } adds previewHtml for CSV / Excel / TXT (the page cannot show those itself);
 * { engine: 'parser' } gives the parser's rows instead of the model's (/roster "Try to parse").
 * The caller removes the multer temp file; the copy made here is removed here.
 */
export async function readRosterFile(file, { preview = false, engine = 'model' } = {}) {
  const t0 = Date.now();
  if (engine !== 'parser' && !modelInfo().ready) throw new Error('No AI model yet: label a few files, then click "Train" on /models.');
  // the readers pick the format from the extension: read a copy named <temp>.<ext>
  const ext = extOf(file.originalname);
  const tmp = `${file.path}.${ext}`;
  fs.copyFileSync(file.path, tmp);
  try {
    const parsed = await parsePdfFile(tmp); // period and notices come from the file
    // engine 'parser' (/roster "Try to parse"): the parser's rows
    const read = engine === 'parser' ? { ...parsed, source: 'parser' } : await readPdfWithModel(tmp);
    const notices = [...(parsed.notices || [])];
    if (read.source === 'parser' && engine !== 'parser') notices.unshift('This PDF only has images (no text layer), so the AI model cannot read it yet; the table below is what the parser read from the OCR text.');
    else if (read.readMode === 'ocr-image') notices.unshift('This PDF only has images: its pages were OCRed, joined into one roster image and read by the AI model like an image.');
    return {
      fileName: path.basename(file.originalname),
      source: read.source,
      recognized: parsed.recognized,
      period: read.period || parsed.period,
      notices,
      readMode: read.readMode,
      published: read.published || [],
      planned: read.planned || [],
      ...(preview && ext !== 'pdf' ? { previewHtml: previewHtml(tmp) } : {}),
      ms: Date.now() - t0,
    };
  } finally {
    fs.rm(tmp, { force: true }, () => {});
  }
}

// Deprecated (2026-10-18): use POST /api/roster/upload. Kept for old clients, not in docs/openapi.json.
router.post('/upload', uploadFile, async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Please choose a PDF file' });
  res.set('Deprecation', 'true').set('Link', '</api/roster/upload>; rel="successor-version"');
  try {
    res.json(await readRosterFile(req.file));
  } catch (e) {
    console.error('[PDF upload]', e);
    res.status(e.code === 'OCR_BUSY' ? 503 : 500).json({ error: e.message, busy: e.code === 'OCR_BUSY' || undefined });
  } finally {
    fs.rm(req.file.path, { force: true }, () => {});
  }
});

router.get('/files', async (req, res) => {
  try {
    const { index } = await syncMedia({ maxAgeMs: 2000 });
    const labeled = new Map(index.labels.map(l => [l.name, l.md5]));
    const items = index.files.filter(f => PDF_EXTS.includes(extOf(f.name))).map(f => f.name).sort()
      .map(name => ({ name, labeled: labeled.has(name), review: labeled.has(name) ? reviewState(LABELS_ROOT, name, labeled.get(name)) : null }));
    res.json({ items, counts: { files: items.length, labeled: items.filter(i => i.labeled).length } });
  } catch (e) {
    fail(res, e, 'GET /api/pdf/files');
  }
});

// Rows for a stored PDF. ?engine=parser|model (default model); ?label=true returns its label when there is one.
router.get('/parse', async (req, res) => {
  const name = String(req.query.name || '');
  if (!validName(name)) return res.status(400).json({ error: 'Missing or invalid ?name=' });
  const engine = String(req.query.engine || 'model');
  if (!['parser', 'model'].includes(engine)) return res.status(400).json({ error: 'engine must be parser or model' });
  try {
    res.json(await resultFor(name, { engine, useLabel: req.query.label === 'true' }));
  } catch (e) {
    fail(res, e, 'GET /api/pdf/parse');
  }
});

router.get('/raw', async (req, res) => {
  const name = String(req.query.name || '');
  if (!validName(name)) return res.status(400).send('Missing or invalid ?name=');
  let file;
  try { file = await localFile(name); } catch (e) { return res.status(mediaErrorStatus(e)).send(e.message); }
  if (!file) return res.status(404).send('PDF not found');
  if (extOf(name) === 'pdf') return res.type('application/pdf').sendFile(file);
  try {
    res.type('html').send(previewHtml(file)); // CSV / Excel / TXT: shown as a table or as text
  } catch (e) {
    res.status(500).send(req.__('Could not read the file: {error}', { error: e.message }));
  }
});

router.get('/labels', async (req, res) => {
  const name = String(req.query.name || '');
  if (!validName(name)) return res.status(400).json({ error: 'Missing or invalid ?name=' });
  try {
    const label = await readLabel(name);
    if (!label) return res.status(404).json({ error: 'No label yet' });
    res.json(label);
  } catch (e) {
    fail(res, e, 'GET /api/pdf/labels');
  }
});

// Save the tables a person checked ({ published: [rows], planned: [rows] }). Only known fields are kept.
router.post('/labels', async (req, res) => {
  const name = String(req.query.name || '');
  if (!validName(name)) return res.status(400).json({ error: 'Missing or invalid ?name=' });
  if (!PDF_SECTIONS.every(sec => Array.isArray(req.body?.[sec]))) {
    return res.status(400).json({ error: 'Body must have published[] and planned[]' });
  }
  const clean = (rows) => rows.map(r => Object.fromEntries(PDF_FIELDS.map(f => [f, String(r?.[f] ?? '').trim()])));
  const payload = {
    period: req.body.period || null,
    published: clean(req.body.published),
    planned: clean(req.body.planned),
    _reviewedByUser: true,
    _reviewedAt: new Date().toISOString(),
  };
  try {
    if (!(await localFile(name))) return res.status(404).json({ error: 'PDF not found' });
    await saveLabel(name, payload);
  } catch (e) {
    return fail(res, e, 'POST /api/pdf/labels');
  }
  res.json({ ok: true, file: `labels/${extOf(name)}/${name}.json`, published: payload.published.length, planned: payload.planned.length });
});

export default router;
