// /routes/pdf-api.js
// API for NetLine/Crew duty-plan PDFs (text layer, no OCR), mounted at /api/pdf.
// Same flow as images: upload -> check/fix the table -> Save as Label -> benchmark.
// PDFs live in fake-data/pdf/<guid>.pdf, verified labels in labels/pdf/ (both local only).
// CSV / XLS / XLSX / TXT rosters go the same way (fake-data/csv/, labels/csv/, ...), read as text.
import { Router } from 'express';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import multer from 'multer';

import { parsePdfFile, compareRows, PDF_FIELDS, PDF_SECTIONS } from '../services/pdf-benchmark.js';
import { compareSection } from '../services/benchmark.js';
import { readPdfWithModel, modelInfo } from '../services/pdf-ai-extract.js';
import { listData, dataFile, labelFile as labelPathOf, newDataName, PDF_EXTS, extOf } from '../utils/data-files.js';
import { previewHtml } from '../services/table-text.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pdfDir = path.resolve(__dirname, '..', 'fake-data');
const labelsDir = path.resolve(__dirname, '..', 'labels');
for (const ext of PDF_EXTS) for (const root of [pdfDir, labelsDir]) fs.mkdirSync(path.join(root, ext), { recursive: true });

const router = Router();
const md5 = (buf) => crypto.createHash('md5').update(buf).digest('hex');
const listPdfs = () => listData(pdfDir, 'pdf');
const pdfFile = (name) => dataFile(pdfDir, name);
const labelFile = (name) => labelPathOf(labelsDir, name);
const hasLabel = (name) => fs.existsSync(labelFile(name));
const validName = (name) => !!name && path.basename(name) === name && PDF_EXTS.includes(extOf(name));

/** Same PDF already stored: reuse it (a labeled copy first); else a new '<guid>.pdf'. */
function storedNameFor(originalName, hash) {
  const same = listPdfs().filter(n => md5(fs.readFileSync(pdfFile(n))) === hash);
  if (same.length) return same.find(hasLabel) || same[0];
  return newDataName(originalName);
}

/**
 * Rows of a stored PDF.
 *   engine 'model'  (/upload, always): the learned model, to try out a newly trained one.
 *                   An image-only PDF has no words for it: the parser (on OCR text) reads it, with a notice.
 *   engine 'parser' (/label Auto-fill): services/pdf-roster-parser.js.
 *   useLabel: return the verified label instead, when there is one (/upload?pdf=<name>).
 * When the file has a label, vsLabel = how many label rows the result got exactly right.
 */
async function resultFor(name, { engine = 'model', useLabel = false } = {}) {
  const t0 = Date.now();
  const file = pdfFile(name);
  let parsed = await parsePdfFile(file); // also for the model / a label: period and notices come from the PDF
  let source = 'parser';
  const notices = [...(parsed.notices || [])];
  const labeled = hasLabel(name);
  if (useLabel && labeled) {
    const label = JSON.parse(fs.readFileSync(labelFile(name), 'utf8'));
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
    const label = JSON.parse(fs.readFileSync(labelFile(name), 'utf8'));
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
  dest: 'tmp/uploads/',
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => (PDF_EXTS.includes(extOf(file.originalname)) ? cb(null, true) : cb(new Error('Only PDF, CSV, XLS, XLSX and TXT files are accepted'))),
});

const uploadFile = (req, res, next) => upload.single('file')(req, res, (err) => (err ? res.status(400).json({ error: err.message }) : next()));

router.post('/upload', uploadFile, async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Please choose a PDF file' });
  try {
    const buf = fs.readFileSync(req.file.path);
    const name = storedNameFor(path.basename(req.file.originalname), md5(buf));
    const target = pdfFile(name);
    const isNew = !fs.existsSync(target);
    if (isNew) fs.copyFileSync(req.file.path, target);
    // /upload is for trying the AI model: always the model, never a saved label or the parser.
    let result;
    try {
      result = await resultFor(name, { engine: 'model' });
    } catch (e) {
      if (isNew) fs.rmSync(target, { force: true }); // a file that cannot be read is not kept in fake-data/
      throw e;
    }
    res.json({ ...result, newFile: isNew });
  } catch (e) {
    console.error('[PDF upload]', e);
    res.status(500).json({ error: e.message });
  } finally {
    fs.rm(req.file.path, { force: true }, () => {});
  }
});

router.get('/files', (req, res) => {
  const items = listPdfs().map(name => ({ name, labeled: hasLabel(name) }));
  res.json({ items, counts: { files: items.length, labeled: items.filter(i => i.labeled).length } });
});

// Rows for a stored PDF. ?engine=parser|model (default model); ?label=true returns its label when there is one.
router.get('/parse', async (req, res) => {
  const name = String(req.query.name || '');
  if (!validName(name)) return res.status(400).json({ error: 'Missing or invalid ?name=' });
  if (!fs.existsSync(pdfFile(name))) return res.status(404).json({ error: 'PDF not found' });
  const engine = String(req.query.engine || 'model');
  if (!['parser', 'model'].includes(engine)) return res.status(400).json({ error: 'engine must be parser or model' });
  try {
    res.json(await resultFor(name, { engine, useLabel: req.query.label === 'true' }));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/raw', (req, res) => {
  const name = String(req.query.name || '');
  if (!validName(name)) return res.status(400).send('Missing or invalid ?name=');
  const file = pdfFile(name);
  if (!fs.existsSync(file)) return res.status(404).send('PDF not found');
  if (extOf(name) === 'pdf') return res.type('application/pdf').sendFile(file);
  try {
    res.type('html').send(previewHtml(file)); // CSV / Excel / TXT: shown as a table or as text
  } catch (e) {
    res.status(500).send(req.__('Could not read the file: {error}', { error: e.message }));
  }
});

router.get('/labels', (req, res) => {
  const name = String(req.query.name || '');
  if (!validName(name)) return res.status(400).json({ error: 'Missing or invalid ?name=' });
  if (!hasLabel(name)) return res.status(404).json({ error: 'No label yet' });
  res.json(JSON.parse(fs.readFileSync(labelFile(name), 'utf8')));
});

// Save the tables a person checked ({ published: [rows], planned: [rows] }). Only known fields are kept.
router.post('/labels', (req, res) => {
  const name = String(req.query.name || '');
  if (!validName(name)) return res.status(400).json({ error: 'Missing or invalid ?name=' });
  if (!fs.existsSync(pdfFile(name))) return res.status(404).json({ error: 'PDF not found in fake-data/pdf' });
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
  fs.writeFileSync(labelFile(name), JSON.stringify(payload, null, 2), 'utf8');
  res.json({ ok: true, file: `labels/${extOf(name)}/${name}.json`, published: payload.published.length, planned: payload.planned.length });
});

export default router;
