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
import { runAcarsBenchmark, labeledAcars } from '../services/acars-benchmark.js';
import * as history from '../services/benchmark-history.js';
import { ocrLines, extractWithPaddleOCR, ocrServerHealth, deviceOf, OCR_SERVER_URL } from '../services/paddle-ocr.js';
import { extractImageWithModel, modelInfo } from '../services/pdf-ai-extract.js';
import { saveLabelResult, savePredictedResult } from '../services/result-cache.js';
import { syncMedia, localFile, readLabel, saveLabel, deleteFile, mediaIndex, mediaErrorStatus, acars } from '../services/media-client.js';
import sharp from 'sharp';
import { isDataName, kindOf, extOf, reviewState, LABELS_ROOT } from '../utils/data-files.js';
import { UPLOADS_DIR, CACHE_DIR } from '../utils/paths.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const router = Router();

// The roster files and labels live in MinIO (services/media-client.js); a file is read
// from the local mirror (localFile), a label fresh from the service (readLabel).
const mediaFail = (res, e, where) => {
  const status = mediaErrorStatus(e);
  if (status >= 500 && e?.code !== 'MEDIA_DOWN') console.error(`[${where}]`, e);
  return res.status(status).json({ error: e.message || String(e) });
};

/** Rows of a roster image read by the learned AI model: PaddleOCR lines -> model -> rows. */
async function readImageWithModel(filePath) {
  const t0 = Date.now();
  const lines = await ocrLines(filePath);
  const ocrMs = Date.now() - t0;
  const { width, height } = await sharp(fs.readFileSync(filePath)).metadata();
  const t1 = Date.now();
  const result = await extractImageWithModel(lines, width, height);
  return { ...result, _timings: { ocrMs, modelMs: Date.now() - t1 } };
}

/** How many rows of the image's verified label a result got exactly right (null when unlabeled). */
function scoreVsLabel(label, result) {
  if (!label) return null;
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
  dest: UPLOADS_DIR,
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

/**
 * Read an uploaded roster image (a multer file in <work>/uploads/, utils/paths.js) with the AI model. The image is NOT kept:
 * the temp file is removed afterwards (since 2026-10-18 a roster only joins the data (MinIO) when an admin
 * accepts a correction suggestion, routes/suggestions-api.js). Used by POST /api/roster/upload
 * (routes/roster-api.js) and the deprecated POST /api/ocr/upload.
 * { engine: 'parser' }: OCR + services/roster-parser.js instead of the model (/roster "Try to parse").
 * Throws on failure (err.code 'OCR_BUSY' when the queue is full).
 */
export async function readRosterImage(file, { engine = 'model' } = {}) {
  let finalPath = null; // the temp file, also removed when reading fails
  try {
    const req = { file };
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
        const buf = await sharp(fs.readFileSync(finalPath)).jpeg({ quality: 95 }).toBuffer(); // from a buffer: no file handle left open (Windows could not delete it)
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
    // /roster reads every upload with the AI model (OCR + learned tagger), never from a saved label;
    // the parser only when asked (engine 'parser': "Try to parse" while correcting a reading).
    let result, timings;
    if (engine === 'parser') {
      uploadPhase = 'ocr+parser';
      const t1 = Date.now();
      result = await extractWithPaddleOCR(finalPath);
      timings = { parseMs: Date.now() - t1 };
    } else {
      if (!modelInfo().ready) throw new Error('No AI model yet: label a few files, then click "Train" on /models.');
      uploadPhase = 'ocr+model';
      result = await readImageWithModel(finalPath);
      timings = result._timings;
      console.log(`[OCR Upload] AI model: OCR ${timings.ocrMs}ms + model ${timings.modelMs}ms`);
    }

    console.log(`[OCR Upload] Result: published=${result?.published?.length || 0}, planned=${result?.planned?.length || 0}`);

    if (!result || (!result.published && !result.planned)) {
      throw new Error('Layout not supported: no text lines found');
    }

    // The upload is not kept (no auto-save to the data): remove the temp file(s)
    try {
      // the multer file, its renamed copy (+ extension) and a converted .jpg
      for (const p of new Set([tempPath, tempPath + origExt, finalPath])) fs.rmSync(p, { force: true });
    } catch (err) {
      console.warn('[OCR Upload] Failed to delete temp file:', err.message);
    }

    const totalLines = (result.published?.length || 0) + (result.planned?.length || 0);
    const totalTime = Date.now() - t0;
    console.log(`[OCR Upload] Total time: ${totalTime}ms | Phase: ${uploadPhase}`);
    console.log(`[OCR Upload] Sending response: ${totalLines} total lines`);
    
    return {
      published: result.published || [],
      planned: result.planned || [],
      totalLines,
      totalMs: totalTime,
      timings: { ...timings, totalMs: totalTime },
      strategy: effectiveStrategy,
      fileName: path.basename(req.file.originalname),
      fromCache: false,
      source: engine === 'parser' ? 'parser' : 'model',
      model: { trainedAt: modelInfo().trainedAt || null },
      quality: null,
      success: true
    };
  } catch (err) {
    console.error('[OCR Upload] Error:', err.message);

    // Cleanup temp file(s) on error
    try {
      for (const p of new Set([finalPath, file.path, file.path + path.extname(file.originalname), file.path + '.jpg'])) if (p) fs.rmSync(p, { force: true });
    } catch (unlinkErr) {
      console.warn('[OCR Upload] Failed to delete temp file:', unlinkErr.message);
    }
    throw err;
  }
}

// Deprecated (2026-10-18): use POST /api/roster/upload. Kept for old clients, not in docs/openapi.json.
router.post('/ocr/upload', upload.single('image'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Please choose an image' });
  res.set('Deprecation', 'true').set('Link', '</api/roster/upload>; rel="successor-version"');
  try {
    res.json(await readRosterImage(req.file));
  } catch (err) {
    res.status(err.code === 'OCR_BUSY' ? 503 : 500).json({
      error: err.message || 'Something went wrong during OCR',
      busy: err.code === 'OCR_BUSY' || undefined,
      success: false
    });
  }
});

// List the roster images of MinIO (JSON). `files` = names (as before); `items`
// adds whether each has a label and, for byte-identical copies, which file it
// duplicates (the first copy by name). New rosters to label = unlabeled, not duplicate.
// `review`: the label waits for a person's review (a user's submitted correction, ...: utils/data-files.js reviewState).
router.get('/files', async (req, res) => {
  try {
    const { index } = await syncMedia({ maxAgeMs: 2000 });
    const labeled = new Set(index.labels.map(l => l.name));
    const files = index.files.filter(f => kindOf(f.name) === 'image').sort((a, b) => a.name.localeCompare(b.name));
    const firstByHash = new Map();
    for (const f of files) if (!firstByHash.has(f.md5)) firstByHash.set(f.md5, f.name);
    const items = files.map(f => {
      const first = firstByHash.get(f.md5);
      return { name: f.name, labeled: labeled.has(f.name), review: labeled.has(f.name) ? reviewState(LABELS_ROOT, f.name) : null, duplicateOf: first === f.name ? null : first };
    });
    const unique = items.filter(i => !i.duplicateOf);
    res.json({
      files: items.map(i => i.name),
      items,
      counts: { files: items.length, unique: unique.length, uniqueUnlabeled: unique.filter(i => !i.labeled && !items.some(o => o.duplicateOf === i.name && o.labeled)).length },
    });
  } catch (e) {
    mediaFail(res, e, 'GET /api/files');
  }
});

// Remove a roster file (image or PDF) from the dataset, from /label. Nothing is
// erased: media/ moves the file and its label to trash/<date>/, so a
// wrong delete can be undone there. The cached OCR result is dropped.
router.delete('/files', async (req, res) => {
  const name = String(req.query.name || '');
  if (!isDataName(name)) return res.status(400).json({ error: 'Missing or invalid ?name=' });
  try {
    const { moved } = await deleteFile(name);
    fs.rmSync(path.join(CACHE_DIR, 'parsed', `${name}.json`), { force: true });
    res.json({ ok: true, name, moved });
  } catch (e) {
    mediaFail(res, e, 'DELETE /api/files');
  }
});

/**
 * Byte-identical copies in the data (roster files and ACARS pictures): of each group of copies one stays (the one
 * whose label was saved last, else the first by name), the others and their labels go to trash/<date>/.
 *   GET  /api/files/duplicates          what would go: { roster: [{ name, keep, labeled }], acars: [...], labelsDiffer: n }
 *   POST /api/files/delete-duplicates   { dry?: true } -> the same plus { deleted, failed: [{ name, error }] }
 * `labelsDiffer`: groups whose copies' labels differ in their rows (not only in "_reviewedAt" and such);
 * the kept copy's label wins, the others stay in the trash.
 */
const labelRows = (label) => JSON.stringify(label, (k, v) => (k.startsWith('_') ? undefined : v));
async function duplicatePlan() {
  const plan = { roster: [], acars: [], labelsDiffer: 0 };
  for (const [key, index, read] of [['roster', await mediaIndex(true), readLabel], ['acars', await acars.mediaIndex(true), acars.readLabel]]) {
    const labelAt = new Map(index.labels.map(l => [l.name, new Date(l.lastModified || 0).getTime()]));
    const groups = new Map();
    for (const f of [...index.files].sort((a, b) => a.name.localeCompare(b.name))) {
      if (!f.md5) continue;
      (groups.get(f.md5) || groups.set(f.md5, []).get(f.md5)).push(f.name);
    }
    for (const names of groups.values()) {
      if (names.length < 2) continue;
      const labeled = names.filter(n => labelAt.has(n));
      const keep = labeled.sort((a, b) => labelAt.get(b) - labelAt.get(a) || a.localeCompare(b))[0] || names[0];
      if (labeled.length > 1) {
        const rows = new Set();
        for (const n of labeled) rows.add(labelRows(await read(n)));
        if (rows.size > 1) plan.labelsDiffer += 1;
      }
      for (const name of names) if (name !== keep) plan[key].push({ name, keep, labeled: labelAt.has(name) });
    }
  }
  return plan;
}

router.get('/files/duplicates', async (req, res) => {
  try { res.json(await duplicatePlan()); } catch (e) { mediaFail(res, e, 'GET /api/files/duplicates'); }
});

router.post('/files/delete-duplicates', async (req, res) => {
  try {
    const plan = await duplicatePlan();
    if (req.body?.dry) return res.json({ ...plan, deleted: 0, failed: [] });
    let deleted = 0;
    const failed = [];
    for (const { name } of plan.roster) {
      try { await deleteFile(name); fs.rmSync(path.join(CACHE_DIR, 'parsed', `${name}.json`), { force: true }); deleted += 1; } catch (e) { failed.push({ name, error: e.message }); }
    }
    for (const { name } of plan.acars) {
      try { await acars.deleteFile(name); deleted += 1; } catch (e) { failed.push({ name, error: e.message }); }
    }
    res.json({ ...plan, deleted, failed });
  } catch (e) { mediaFail(res, e, 'POST /api/files/delete-duplicates'); }
});

// Serve raw image file (dùng cho <img src="/api/raw?name=...">)
router.get('/raw', async (req, res) => {
  const name = String(req.query.name || '');
  if (!isDataName(name)) return res.status(400).send('Missing or invalid ?name=');
  try {
    const filePath = await localFile(name);
    if (!filePath) return res.status(404).send('File not found');
    res.sendFile(filePath);
  } catch (e) {
    res.status(mediaErrorStatus(e)).send(e.message);
  }
});

// GET label JSON cho 1 file
router.get('/labels', async (req, res) => {
  const name = String(req.query.name || '');
  if (!isDataName(name)) return res.status(400).json({ error: 'Missing or invalid ?name=' });
  try {
    const label = await readLabel(name);
    if (!label) return res.status(404).json({ error: 'No label yet' });
    res.json(label);
  } catch (e) {
    mediaFail(res, e, 'GET /api/labels');
  }
});

// POST label JSON cho 1 file. Lưu đúng nhãn người dùng đã kiểm tra, không học gì
// tự động (learned corrections / auto-calibrate đã bị gỡ 2026-10-06).
router.post('/labels', async (req, res) => {
  const name = String(req.query.name || '');
  if (!isDataName(name) || kindOf(name) !== 'image') return res.status(400).json({ error: 'Missing or invalid ?name=' });
  if (!Array.isArray(req.body?.published) || !Array.isArray(req.body?.planned)) {
    return res.status(400).json({ error: 'Body must have published[] and planned[]' });
  }
  try {
    if (!(await localFile(name))) return res.status(404).json({ error: 'File not found' });
    const labelPayload = {
      published: req.body.published,
      planned: req.body.planned,
      _reviewedByUser: true,
      _reviewedAt: new Date().toISOString(),
      _labelSource: 'manual-label',
    };
    await saveLabel(name, labelPayload);
    // Next upload of the same image returns this reviewed label.
    saveLabelResult(name, labelPayload, { source: 'manual-label', reviewedByUser: true });
    console.log(`[Labels] Saved label + cache for ${name}`);
    res.json({ ok: true, file: `labels/${extOf(name)}/${name}.json` });
  } catch (e) {
    mediaFail(res, e, 'POST /api/labels');
  }
});

// Review one labeled image against its label (/benchmark "Xem & sửa" -> /label?review=1).
// Prediction = the AI model's reading, as /roster and the AI model benchmark read it.
// Rows are paired with the benchmark's own alignRows, so the marked cells are the benchmark's errors.
const REVIEW_FIELDS = ['date', 'day', 'duty', 'dep', 'begin', 'end', 'arr'];
router.get('/review', async (req, res) => {
  const name = String(req.query.name || '');
  if (!isDataName(name) || kindOf(name) !== 'image') return res.status(400).json({ error: 'Missing or invalid ?name=' });
  if (!modelInfo().ready) return res.status(409).json({ error: 'No AI model yet: click "Train" on /models first.' });
  try {
    const filePath = await localFile(name);
    if (!filePath) return res.status(404).json({ error: 'File not found' });
    const label = await readLabel(name);
    if (!label) return res.status(404).json({ error: 'This image has no label yet' });
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
    mediaFail(res, e, '/api/review');
  }
});

// Predict (inference) trên một ảnh của dữ liệu — dùng cho Auto-fill trong label tool.
// ?engine=parser (mặc định: OCR + services/roster-parser.js) | model (OCR + AI model).
router.get('/predict', async (req, res) => {
  const engine = String(req.query.engine || 'parser');
  if (!['parser', 'model'].includes(engine)) return res.status(400).json({ error: 'engine must be parser or model' });
  const name = String(req.query.name || '');
  if (!isDataName(name) || kindOf(name) !== 'image') return res.status(400).json({ error: 'Missing or invalid ?name=' });
  try {
    const filePath = await localFile(name);
    if (!filePath) return res.status(404).json({ error: 'File not found' });
    if (engine === 'model') {
      if (!modelInfo().ready) return res.status(409).json({ error: 'No AI model yet: click "Train" on /models first.' });
      const data = await readImageWithModel(filePath);
      return res.json({ ...data, source: 'model', vsLabel: scoreVsLabel(await readLabel(name), data) });
    }
    const data = await extractWithPaddleOCR(filePath);
    savePredictedResult(name, data, { source: 'paddleocr', strategy: 'paddleocr' });
    res.json({ ...data, source: 'parser', vsLabel: scoreVsLabel(await readLabel(name), data) });
  } catch (e) {
    mediaFail(res, e, '/api/predict');
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

// Labeled files per type, for the /benchmark choices: { image: 75, pdf: 74, csv: 20, ... }; acars: labeled ACARS pictures
router.get('/benchmark/types', async (req, res) => {
  try {
    await Promise.all([syncMedia(), acars.syncMedia()]);
    res.json({ types: FILE_TYPES, counts: labeledCounts(), acars: labeledAcars().length });
  } catch (e) {
    mediaFail(res, e, '/api/benchmark/types');
  }
});

// The OCR server's status for /benchmark: { url, running, device: { device: 'gpu' | 'cpu', name } | null, rec, inflight, waiting }
router.get('/benchmark/ocr-server', async (req, res) => {
  const h = await ocrServerHealth();
  res.json({
    url: OCR_SERVER_URL, running: !!h, device: deviceOf(h),
    rec: h?.rec || null, inflight: h?.inflight ?? 0, waiting: h?.waiting ?? 0,
  });
});

// Benchmarks read the local mirror of MinIO: bring it up to date first.
// Text recognition alone: PaddleOCR on every labeled image (services/ocr-benchmark.js).
router.get('/benchmark/ocr/stream', (req, res) => streamBenchmark(req, res, async (opts) => { await syncMedia({ force: true }); return runOcrBenchmark(opts); }));

// AI model over the labeled files of the chosen types (?types=image,pdf,csv; default all),
// as /roster reads them (services/model-benchmark.js).
router.get('/benchmark/model/stream', (req, res) => {
  const asked = String(req.query.types || '').split(',').map(t => t.trim().toLowerCase()).filter(t => FILE_TYPES.includes(t));
  const types = asked.length ? asked : FILE_TYPES;
  return streamBenchmark(req, res, async (opts) => { await syncMedia({ force: true }); return runModelBenchmark({ types, ...opts }); });
});

// AI model over the labeled ACARS pictures, as /acars reads them (services/acars-benchmark.js).
router.get('/benchmark/acars/stream', (req, res) => streamBenchmark(req, res, async (opts) => { await acars.syncMedia({ force: true }); return runAcarsBenchmark(opts); }));

// History of the finished runs (services/benchmark-history.js), to compare them on /benchmark.
//   GET /api/benchmark/history/:kind -> { runs: [summary] } (newest first; kind ocr | model | acars)
//   GET /api/benchmark/history/:kind/:id -> { summary, result }; PATCH { note }; DELETE (to MinIO's trash)
router.get('/benchmark/history/:kind', async (req, res) => {
  try { res.json({ runs: await history.listRuns(req.params.kind) }); } catch (e) { mediaFail(res, e, '/api/benchmark/history'); }
});
router.get('/benchmark/history/:kind/:id', async (req, res) => {
  try { res.json(await history.getRun(req.params.kind, req.params.id)); } catch (e) { mediaFail(res, e, '/api/benchmark/history'); }
});
router.patch('/benchmark/history/:kind/:id', async (req, res) => {
  try { res.json({ summary: await history.setNote(req.params.kind, req.params.id, req.body?.note) }); } catch (e) { mediaFail(res, e, '/api/benchmark/history'); }
});
router.delete('/benchmark/history/:kind/:id', async (req, res) => {
  try { await history.deleteRun(req.params.kind, req.params.id); res.json({ ok: true }); } catch (e) { mediaFail(res, e, '/api/benchmark/history'); }
});

export default router;
