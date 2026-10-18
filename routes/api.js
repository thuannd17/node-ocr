// /routes/api.js
// Tất cả API endpoints (JSON) — không render HTML
import { Router } from 'express';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import multer from 'multer';

import { alignRows, normalizeField, compareSection } from '../services/benchmark.js';
import { runModelBenchmark, labeledCounts, FILE_TYPES } from '../services/model-benchmark.js';
import { runOcrBenchmark } from '../services/ocr-benchmark.js';
import { ocrLines, extractWithPaddleOCR } from '../services/paddle-ocr.js';
import { extractImageWithModel, modelInfo } from '../services/pdf-ai-extract.js';
import { saveLabelResult, savePredictedResult } from '../services/result-cache.js';
import sharp from 'sharp';
import crypto from 'node:crypto';
import { IMAGE_EXTS, listData, dataFile, labelFile as labelPathOf, newDataName, isDataName, kindOf } from '../utils/data-files.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const router = Router();

const folderPath = path.resolve(__dirname, '..', 'fake-data');
const labelsPath = path.resolve(__dirname, '..', 'labels');
// Neither folder is in git (roster data stays local): create them on a fresh clone.
// Files sit in one subfolder per extension: fake-data/jpg/<guid>.jpg, labels/jpg/<guid>.jpg.json.
for (const ext of IMAGE_EXTS) for (const root of [folderPath, labelsPath]) fs.mkdirSync(path.join(root, ext), { recursive: true });
const md5 = (buf) => crypto.createHash('md5').update(buf).digest('hex');
// fake-data/ content index: file name -> md5, re-hashed only when a file's
// mtime/size changes, so lookups by content stay cheap as the folder grows.
const contentIndex = new Map();
function indexFakeData() {
  const seen = new Set();
  for (const name of listData(folderPath, 'image')) {
    const abs = dataFile(folderPath, name);
    const st = fs.statSync(abs);
    const key = `${st.mtimeMs}:${st.size}`;
    const cur = contentIndex.get(name);
    if (!cur || cur.key !== key) contentIndex.set(name, { key, hash: md5(fs.readFileSync(abs)) });
    seen.add(name);
  }
  for (const name of contentIndex.keys()) if (!seen.has(name)) contentIndex.delete(name);
  return contentIndex;
}
const hasLabel = (name) => fs.existsSync(labelPathOf(labelsPath, name));

/** Name to store an upload under in fake-data/<ext>/.
 * - Same image already there (any name): reuse that file, preferring a copy
 *   that has a label, so a re-upload neither duplicates the dataset nor loses
 *   its reviewed label.
 * - Otherwise a new '<guid>.<ext>' (the original name is not kept). */
function storedNameFor(originalName, contentHash) {
  const sameContent = [...indexFakeData()].filter(([, v]) => v.hash === contentHash).map(([n]) => n);
  if (sameContent.length) return sameContent.find(hasLabel) || sameContent[0];
  return newDataName(originalName);
}

/** Rows of a roster image read by the learned AI model: PaddleOCR lines -> model -> rows. */
async function readImageWithModel(filePath) {
  const t0 = Date.now();
  const lines = await ocrLines(filePath);
  const ocrMs = Date.now() - t0;
  const { width, height } = await sharp(filePath).metadata();
  const t1 = Date.now();
  const result = await extractImageWithModel(lines, width, height);
  return { ...result, _timings: { ocrMs, modelMs: Date.now() - t1 } };
}

/** How many rows of the image's verified label a result got exactly right (null when unlabeled). */
function scoreVsLabel(name, result) {
  if (!hasLabel(name)) return null;
  const label = JSON.parse(fs.readFileSync(labelPathOf(labelsPath, name), 'utf8'));
  const score = { rowMatches: 0, rowTotal: 0 };
  for (const sec of ['published', 'planned']) {
    const c = compareSection(result[sec] || [], label[sec] || []);
    score.rowMatches += c.rowMatches;
    score.rowTotal += c.expCount;
  }
  return score;
}

const activeBenchmarks = new Map();

// Multipart upload parsing
const upload = multer({
  dest: 'tmp/uploads/',
  limits: {
    fileSize: 10 * 1024 * 1024 // 10MB max file size
  },
  fileFilter: (req, file, cb) => {
    if (!file.originalname.match(/\.(jpg|jpeg|png|bmp|jfif)$/i)) {
      return cb(new Error('Only JPG, PNG, BMP and JFIF files are accepted'));
    }
    cb(null, true);
  },
  // Keep original extension so PaddleOCR can detect format
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    const uniqueName = Date.now() + '-' + Math.round(Math.random() * 1e6) + ext;
    cb(null, uniqueName);
  }
});

// Upload ảnh rồi OCR (PaddleOCR + parser).
router.post('/ocr/upload', upload.single('image'), async (req, res) => {
  let finalPath = null; // the temp file, also removed when reading fails
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'Please choose an image' });
    }

    const tempPath = req.file.path;
    const effectiveStrategy = 'paddleocr'; // the only reader since Gemini was removed (2026-10-09)

    // Ensure temp file has the original extension (PaddleOCR needs it)
    const origExt = path.extname(req.file.originalname);
    finalPath = tempPath;
    if (origExt && !tempPath.toLowerCase().endsWith(origExt.toLowerCase())) {
      finalPath = tempPath + origExt;
      fs.renameSync(tempPath, finalPath);
      console.log(`[OCR Upload] Renamed: ${path.basename(tempPath)} -> ${path.basename(finalPath)}`);
    }

    // Auto-convert jfif/webp/bmp to jpg (PaddleOCR can't read these formats directly)
    const problematicExts = ['.jfif', '.webp', '.bmp'];
    if (problematicExts.includes(path.extname(finalPath).toLowerCase())) {
      const jpgPath = finalPath.replace(/\.\w+$/, '.jpg');
      try {
        // Use toBuffer() to avoid Windows file-lock issues with toFile()
        const buf = await sharp(finalPath).jpeg({ quality: 95 }).toBuffer();
        fs.writeFileSync(jpgPath, buf);
        finalPath = jpgPath;
        console.log(`[OCR Upload] Converted ${path.extname(req.file.originalname)} -> .jpg (${buf.length} bytes)`);
      } catch (convErr) {
        console.warn('[OCR Upload] Convert failed:', convErr.message);
      }
    }

    console.log(`[OCR Upload] === Start ===`);
    console.log(`[OCR Upload] File: ${req.file.originalname}`);
    console.log(`[OCR Upload] Saved to: ${finalPath}`);
    console.log(`[OCR Upload] File size: ${fs.statSync(finalPath).size} bytes`);
    console.log(`[OCR Upload] Strategy: ${effectiveStrategy}`);

    const t0 = Date.now();
    let uploadPhase = 'init';
    const storedName = storedNameFor(req.file.originalname, md5(fs.readFileSync(finalPath)));
    // New roster = this image content was not in fake-data/ yet; it is kept there
    // (unlabeled) as future training/benchmark data once someone reviews it.
    const isNewRoster = !fs.existsSync(dataFile(folderPath, storedName));
    console.log(`[OCR Upload] ${isNewRoster ? 'New roster, stored as' : 'Same image already stored as'} ${storedName}`);

    // /upload is for trying the AI model: every upload is read by the model (OCR + learned
    // tagger), never answered from a saved label or the parser. /label Auto-fill offers the parser.
    if (!modelInfo().ready) throw new Error('No AI model yet: label a few files, then click "Train" on /models.');
    uploadPhase = 'ocr+model';
    const result = await readImageWithModel(finalPath);
    const timings = result._timings;
    console.log(`[OCR Upload] AI model: OCR ${timings.ocrMs}ms + model ${timings.modelMs}ms`);

    console.log(`[OCR Upload] Result: published=${result?.published?.length || 0}, planned=${result?.planned?.length || 0}`);

    if (!result || (!result.published && !result.planned)) {
      throw new Error('Layout not supported: no text lines found');
    }

    // Move file to fake-data/ (rename if same filesystem, else copy)
    uploadPhase = 'file-move';
    const destPath = dataFile(folderPath, storedName);
    fs.mkdirSync(path.dirname(destPath), { recursive: true });
    try {
      if (!fs.existsSync(destPath)) {
        // Try rename first (faster than copy)
        try {
          fs.renameSync(finalPath, destPath);
          console.log(`[OCR Upload] Moved to fake-data/${path.relative(folderPath, destPath)}`);
          finalPath = null; // Already moved, don't delete
        } catch {
          // Rename failed (cross-device), fallback to copy
          fs.copyFileSync(finalPath, destPath);
          console.log(`[OCR Upload] Copied to fake-data/${path.relative(folderPath, destPath)}`);
        }
      }
    } catch (copyErr) {
      console.warn('[OCR Upload] Failed to save to fake-data:', copyErr.message);
    }

    // Cleanup temp file (if not already moved)
    try {
      if (finalPath && fs.existsSync(finalPath)) {
        fs.unlinkSync(finalPath);
      }
    } catch (err) {
      console.warn('[OCR Upload] Failed to delete temp file:', err.message);
    }

    const totalLines = (result.published?.length || 0) + (result.planned?.length || 0);
    const totalTime = Date.now() - t0;
    console.log(`[OCR Upload] Total time: ${totalTime}ms | Phase: ${uploadPhase}`);
    console.log(`[OCR Upload] Sending response: ${totalLines} total lines`);
    
    res.json({
      published: result.published || [],
      planned: result.planned || [],
      totalLines,
      totalMs: totalTime,
      timings: { ...timings, totalMs: totalTime },
      strategy: effectiveStrategy,
      fileName: storedName,
      fromCache: false,
      source: 'model',
      model: { trainedAt: modelInfo().trainedAt || null },
      newRoster: isNewRoster,
      labeled: hasLabel(storedName),
      vsLabel: scoreVsLabel(storedName, result),
      quality: null,
      success: true
    });
  } catch (err) {
    console.error('[OCR Upload] Error:', err.message);
    console.error('[OCR Upload] Stack:', err.stack);

    // Cleanup temp file on error
    try {
      if (finalPath && fs.existsSync(finalPath)) {
        fs.unlinkSync(finalPath);
      }
    } catch (unlinkErr) {
      console.warn('[OCR Upload] Failed to delete temp file:', unlinkErr.message);
    }

    res.status(err.code === 'OCR_BUSY' ? 503 : 500).json({
      error: err.message || 'Something went wrong during OCR',
      busy: err.code === 'OCR_BUSY' || undefined,
      success: false
    });
  }
});

// List all files in fake-data (JSON). `files` = names (as before); `items`
// adds whether each has a label and, for byte-identical copies, which file it
// duplicates (the first copy by name). New rosters to label = unlabeled, not duplicate.
router.get('/files', (req, res) => {
  try {
    const index = indexFakeData();
    const firstByHash = new Map();
    const names = [...index.keys()].sort();
    for (const n of names) if (!firstByHash.has(index.get(n).hash)) firstByHash.set(index.get(n).hash, n);
    const items = names.map(n => {
      const first = firstByHash.get(index.get(n).hash);
      return { name: n, labeled: hasLabel(n), duplicateOf: first === n ? null : first };
    });
    const unique = items.filter(i => !i.duplicateOf);
    res.json({
      files: names,
      items,
      counts: { files: items.length, unique: unique.length, uniqueUnlabeled: unique.filter(i => !i.labeled && !items.some(o => o.duplicateOf === i.name && o.labeled)).length },
    });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// Remove a roster file (image or PDF) from the dataset, from /label. Nothing is
// erased: the file, its label and its cached OCR result move to
// tmp/trash/<date>/ (same relative paths), so a wrong delete can be undone by
// moving them back. Training and benchmarks list fake-data/, so they skip it.
router.delete('/files', (req, res) => {
  const name = String(req.query.name || '');
  if (!isDataName(name)) return res.status(400).json({ error: 'Missing or invalid ?name=' });
  const root = path.resolve(__dirname, '..');
  const file = dataFile(folderPath, name);
  if (!fs.existsSync(file)) return res.status(404).json({ error: 'File not found' });
  const trash = path.join(root, 'tmp', 'trash', new Date().toISOString().slice(0, 10));
  const moved = [];
  try {
    for (const src of [file, labelPathOf(labelsPath, name), path.join(root, 'cache', 'parsed', `${name}.json`)]) {
      if (!fs.existsSync(src)) continue;
      const dst = path.join(trash, path.relative(root, src));
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.renameSync(src, dst);
      moved.push(path.relative(root, dst).replace(/\\/g, '/'));
    }
    contentIndex.delete(name);
    res.json({ ok: true, name, moved });
  } catch (e) {
    console.error('[DELETE /api/files]', e);
    res.status(500).json({ error: e.message, moved });
  }
});

// Serve raw image file (dùng cho <img src="/api/raw?name=...">)
router.get('/raw', (req, res) => {
  const name = String(req.query.name || '');
  if (!isDataName(name)) return res.status(400).send('Missing or invalid ?name=');
  const filePath = dataFile(folderPath, name);
  if (!fs.existsSync(filePath)) return res.status(404).send('File not found');
  res.sendFile(filePath);
});

// GET label JSON cho 1 file
router.get('/labels', (req, res) => {
  const name = String(req.query.name || '');
  if (!isDataName(name)) return res.status(400).json({ error: 'Missing or invalid ?name=' });
  const labelFile = labelPathOf(labelsPath, name);
  if (!fs.existsSync(labelFile)) return res.status(404).json({ error: 'No label yet' });
  try {
    const raw = fs.readFileSync(labelFile, 'utf8');
    res.json(JSON.parse(raw));
  } catch (e) {
    res.status(500).json({ error: 'Invalid label JSON: ' + e.message });
  }
});

// POST label JSON cho 1 file. Lưu đúng nhãn người dùng đã kiểm tra, không học gì
// tự động (learned corrections / auto-calibrate đã bị gỡ 2026-10-06).
router.post('/labels', async (req, res) => {
  const name = String(req.query.name || '');
  if (!isDataName(name) || kindOf(name) !== 'image') return res.status(400).json({ error: 'Missing or invalid ?name=' });
  if (!fs.existsSync(dataFile(folderPath, name))) return res.status(404).json({ error: 'Image not found in fake-data' });
  if (!Array.isArray(req.body?.published) || !Array.isArray(req.body?.planned)) {
    return res.status(400).json({ error: 'Body must have published[] and planned[]' });
  }
  const labelFile = labelPathOf(labelsPath, name);
  fs.mkdirSync(path.dirname(labelFile), { recursive: true });
  try {
    const labelPayload = {
      published: req.body.published,
      planned: req.body.planned,
      _reviewedByUser: true,
      _reviewedAt: new Date().toISOString(),
      _labelSource: 'manual-label',
    };
    fs.writeFileSync(labelFile, JSON.stringify(labelPayload, null, 2), 'utf8');
    // Next upload of the same image returns this reviewed label.
    saveLabelResult(name, labelPayload, { source: 'manual-label', reviewedByUser: true });
    console.log(`[Labels] Saved label + cache for ${name}`);
    res.json({ ok: true, file: `labels/${path.relative(labelsPath, labelFile).replace(/\\/g, '/')}` });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// Review one labeled image against its label (/benchmark "Xem & sửa" -> /label?review=1).
// Prediction = the AI model's reading, as /upload and the AI model benchmark read it.
// Rows are paired with the benchmark's own alignRows, so the marked cells are the benchmark's errors.
const REVIEW_FIELDS = ['date', 'day', 'duty', 'dep', 'begin', 'end', 'arr'];
router.get('/review', async (req, res) => {
  const name = String(req.query.name || '');
  if (!isDataName(name) || kindOf(name) !== 'image') return res.status(400).json({ error: 'Missing or invalid ?name=' });
  const filePath = dataFile(folderPath, name);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Image not found in fake-data' });
  const labelFile = labelPathOf(labelsPath, name);
  if (!fs.existsSync(labelFile)) return res.status(404).json({ error: 'This image has no label yet' });
  if (!modelInfo().ready) return res.status(409).json({ error: 'No AI model yet: click "Train" on /models first.' });
  try {
    const label = JSON.parse(fs.readFileSync(labelFile, 'utf8'));
    const t0 = Date.now();
    const pred = await readImageWithModel(filePath);
    const sections = {};
    let diffCells = 0, missingRows = 0, extraRows = 0;
    for (const sec of ['published', 'planned']) {
      sections[sec] = alignRows(pred[sec] || [], label[sec] || []).map(({ pred: p, exp: e }) => {
        if (!e) { extraRows++; return { kind: 'extra', row: p, label: null, diff: [] }; }
        if (!p) { missingRows++; return { kind: 'missing', row: null, label: e, diff: [] }; }
        const diff = REVIEW_FIELDS.filter(f => normalizeField(f, p[f]) !== normalizeField(f, e[f]));
        diffCells += diff.length;
        return { kind: diff.length ? 'diff' : 'match', row: p, label: e, diff };
      });
    }
    res.json({ fileName: name, sections, diffCells, missingRows, extraRows, totalMs: Date.now() - t0 });
  } catch (e) {
    console.error('[/api/review]', e);
    res.status(500).json({ error: e.message });
  }
});

// Predict (inference) trên ảnh trong fake-data — dùng cho Auto-fill trong label tool.
// ?engine=parser (mặc định: OCR + services/roster-parser.js) | model (OCR + AI model).
router.get('/predict', async (req, res) => {
  const engine = String(req.query.engine || 'parser');
  if (!['parser', 'model'].includes(engine)) return res.status(400).json({ error: 'engine must be parser or model' });
  const name = String(req.query.name || '');
  if (!isDataName(name) || kindOf(name) !== 'image') return res.status(400).json({ error: 'Missing or invalid ?name=' });
  const filePath = dataFile(folderPath, name);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File not found' });
  try {
    if (engine === 'model') {
      if (!modelInfo().ready) return res.status(409).json({ error: 'No AI model yet: click "Train" on /models first.' });
      const data = await readImageWithModel(filePath);
      return res.json({ ...data, source: 'model', vsLabel: scoreVsLabel(name, data) });
    }
    const data = await extractWithPaddleOCR(filePath);
    savePredictedResult(name, data, { source: 'paddleocr', strategy: 'paddleocr' });
    res.json({ ...data, source: 'parser', vsLabel: scoreVsLabel(name, data) });
  } catch (e) {
    console.error('[/api/predict]', e);
    res.status(500).json({ error: String(e) });
  }
});

// Stop a running AI model benchmark (GET /api/benchmark/model/stream below)
router.post('/benchmark/stop', (req, res) => {
  const runId = String(req.query.runId || req.body?.runId || '').trim();
  if (!runId) return res.status(400).json({ ok: false, error: 'Missing runId' });

  const run = activeBenchmarks.get(runId);
  if (!run) {
    return res.status(404).json({ ok: false, runId, error: 'Benchmark run not found or already finished' });
  }

  run.stopRequested = true;
  run.stoppedAt = Date.now();
  return res.json({ ok: true, runId, stopping: true });
});

/**
 * Runs one benchmark as a server-sent event stream (start, file per file, done | error);
 * stop it with POST /api/benchmark/stop?runId=… or by closing the stream.
 */
async function streamBenchmark(req, res, run) {
  const runId = String(req.query.runId || `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`);
  if (activeBenchmarks.has(runId)) return res.status(409).json({ error: `Benchmark runId already active: ${runId}` });
  const runState = { runId, stopRequested: false, startedAt: Date.now(), stoppedAt: null };
  activeBenchmarks.set(runId, runState);
  let closed = false;
  const send = (event, payload) => {
    if (closed) return;
    res.write(`event: ${event}\ndata: ${JSON.stringify({ runId, ...payload })}\n\n`);
  };
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();
  const heartbeat = setInterval(() => { if (!closed) res.write(': keep-alive\n\n'); }, 15000);
  req.on('close', () => { closed = true; runState.stopRequested = true; clearInterval(heartbeat); });
  try {
    await run({
      shouldStop: () => closed || runState.stopRequested,
      onEvent: (evt) => send(evt.type, evt),
    });
  } catch (e) {
    send('error', { error: String(e?.message || e) });
  } finally {
    clearInterval(heartbeat);
    activeBenchmarks.delete(runId);
    if (!closed) res.end();
  }
}

// Labeled files per type, for the /benchmark choices: { image: 75, pdf: 74, csv: 20, ... }
router.get('/benchmark/types', (req, res) => {
  res.json({ types: FILE_TYPES, counts: labeledCounts() });
});

// Text recognition alone: PaddleOCR on every labeled image (services/ocr-benchmark.js).
router.get('/benchmark/ocr/stream', (req, res) => streamBenchmark(req, res, (opts) => runOcrBenchmark(opts)));

// AI model over the labeled files of the chosen types (?types=image,pdf,csv; default all),
// as /upload reads them (services/model-benchmark.js).
router.get('/benchmark/model/stream', (req, res) => {
  const asked = String(req.query.types || '').split(',').map(t => t.trim().toLowerCase()).filter(t => FILE_TYPES.includes(t));
  const types = asked.length ? asked : FILE_TYPES;
  return streamBenchmark(req, res, (opts) => runModelBenchmark({ types, ...opts }));
});

export default router;
