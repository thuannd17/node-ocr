// /routes/api.js
// Tất cả API endpoints (JSON) — không render HTML
import { Router } from 'express';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import multer from 'multer';

import { extractRaw } from '../services/parsers.js';
import { runBenchmark, alignRows, normalizeField } from '../services/benchmark.js';
import { listFilesInFolder } from '../utils/helpers.js';
import { getCachedResult, getCachedPrediction, saveLabelResult, savePredictedResult } from '../services/result-cache.js';
import sharp from 'sharp';
import crypto from 'node:crypto';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const router = Router();

const folderPath = path.resolve(__dirname, '..', 'fake-data');
const labelsPath = path.resolve(__dirname, '..', 'labels');
// Neither folder is in git (roster data stays local): create them on a fresh clone.
for (const dir of [folderPath, labelsPath]) fs.mkdirSync(dir, { recursive: true });
const md5 = (buf) => crypto.createHash('md5').update(buf).digest('hex');
// Identifies what produced a prediction: recognition model, detector limit and
// parser code. A cached prediction from an older model/parser is not reused.
const PIPELINE_ID = md5([
  process.env.STRATEGY || 'paddleocr',
  process.env.OCR_CUSTOM_REC || '',
  process.env.OCR_TEXT_DET_LIMIT_SIDE_LEN || '',
  fs.readFileSync(path.resolve(__dirname, '..', 'services', 'roster-parser.js')),
].join('|')).slice(0, 12);

// fake-data/ content index: file name -> md5, re-hashed only when a file's
// mtime/size changes, so lookups by content stay cheap as the folder grows.
const contentIndex = new Map();
function indexFakeData() {
  const seen = new Set();
  for (const f of listFilesInFolder(folderPath)) {
    const abs = path.join(folderPath, f.name);
    const st = fs.statSync(abs);
    const key = `${st.mtimeMs}:${st.size}`;
    const cur = contentIndex.get(f.name);
    if (!cur || cur.key !== key) contentIndex.set(f.name, { key, hash: md5(fs.readFileSync(abs)) });
    seen.add(f.name);
  }
  for (const name of contentIndex.keys()) if (!seen.has(name)) contentIndex.delete(name);
  return contentIndex;
}
const hasLabel = (name) => fs.existsSync(path.join(labelsPath, `${name}.json`));

/** Name to store an upload under in fake-data/.
 * - Same image already there (any name): reuse that file, preferring a copy
 *   that has a label, so a re-upload neither duplicates the dataset nor loses
 *   its reviewed label.
 * - Otherwise the original name, or name-<hash8>.ext when a different image
 *   already has that name. */
function storedNameFor(originalName, contentHash) {
  const sameContent = [...indexFakeData()].filter(([, v]) => v.hash === contentHash).map(([n]) => n);
  if (sameContent.length) {
    return sameContent.find(n => n === originalName && hasLabel(n))
      || sameContent.find(hasLabel)
      || (sameContent.includes(originalName) ? originalName : sameContent[0]);
  }
  if (!fs.existsSync(path.join(folderPath, originalName))) return originalName;
  const ext = path.extname(originalName);
  return `${path.basename(originalName, ext)}-${contentHash.slice(0, 8)}${ext}`;
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
      return cb(new Error('Chỉ accept JPG, PNG, BMP, JFIF'));
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

// Upload ảnh rồi OCR. ?strategy=vlm|paddleocr (mặc định theo STRATEGY env, fallback paddleocr)
router.post('/ocr/upload', upload.single('image'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'Vui lòng chọn ảnh' });
    }

    const tempPath = req.file.path;
    const strategy = req.query.strategy;
    const effectiveStrategy = strategy || process.env.STRATEGY || 'paddleocr';

    // Ensure temp file has the original extension (PaddleOCR needs it)
    const origExt = path.extname(req.file.originalname);
    let finalPath = tempPath;
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
    const isNewRoster = !fs.existsSync(path.join(folderPath, storedName));
    if (storedName !== req.file.originalname) console.log(`[OCR Upload] ${isNewRoster ? 'Name taken by a different image' : 'Same image already stored'} -> ${storedName}`);

    // Reuse a reviewed label, or a prediction made by this same model/parser
    // (PIPELINE_ID); anything older is re-run. ?force=true always re-runs.
    const forceParse = req.query.force === 'true';
    // A label in labels/ (however it was made) is the reviewed answer for this image.
    const labelFile = path.join(labelsPath, `${storedName}.json`);
    const labelResult = !forceParse && fs.existsSync(labelFile)
      ? (() => { const l = JSON.parse(fs.readFileSync(labelFile, 'utf8')); return { published: l.published || [], planned: l.planned || [], _isLabel: true, _source: 'label', _cachedAt: l._reviewedAt || null }; })()
      : null;
    const cachedEntry = forceParse || labelResult ? null : getCachedResult(storedName);
    const cachedResult = labelResult || (cachedEntry && (cachedEntry._isLabel || cachedEntry._pipeline === PIPELINE_ID) ? cachedEntry : null);
    let result;
    let fromCache = false;
    let timings = null; // per-step ms, only when this request actually ran OCR / Gemini
    
    if (cachedResult) {
      console.log(`[OCR Upload] Cache HIT for ${storedName} (${cachedResult._isLabel ? 'reviewed label' : 'same pipeline'}, cached at ${cachedResult._cachedAt})`);
      result = cachedResult;
      fromCache = true;
    } else {
      console.log(`[OCR Upload] Cache MISS${forceParse ? ' (forced)' : ''} - parsing...`);
      uploadPhase = 'ocr';
      const t1 = Date.now();
      result = await extractRaw(finalPath, { strategy: effectiveStrategy });
      const ocrTime = Date.now() - t1;
      console.log(`[OCR Upload] OCR + Parse took ${ocrTime}ms`);
      // paddleocr reports its own steps; a direct Gemini run is all "vlm"
      timings = result?._timings || (effectiveStrategy === 'vlm' ? { vlmMs: ocrTime } : {});
      
      // Save to cache for next time
      uploadPhase = 'cache-save';
      savePredictedResult(storedName, result, {
        source: result?._predictionSource || effectiveStrategy,
        strategy: effectiveStrategy,
        pipeline: PIPELINE_ID,
      });
    }

    console.log(`[OCR Upload] Result: published=${result?.published?.length || 0}, planned=${result?.planned?.length || 0}`);

    if (!result || (!result.published && !result.planned)) {
      throw new Error('Layout không phù hợp - Không tìm thấy dòng text nào');
    }

    // Move file to fake-data/ (rename if same filesystem, else copy)
    uploadPhase = 'file-move';
    const destPath = path.join(folderPath, storedName);
    try {
      if (!fs.existsSync(destPath)) {
        // Try rename first (faster than copy)
        try {
          fs.renameSync(finalPath, destPath);
          console.log(`[OCR Upload] Moved to fake-data/${storedName}`);
          finalPath = null; // Already moved, don't delete
        } catch {
          // Rename failed (cross-device), fallback to copy
          fs.copyFileSync(finalPath, destPath);
          console.log(`[OCR Upload] Copied to fake-data/${storedName}`);
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
    console.log(`[OCR Upload] Total time: ${totalTime}ms ${fromCache ? '(from cache)' : ''} | Phase: ${uploadPhase}`);
    console.log(`[OCR Upload] Sending response: ${totalLines} total lines`);
    
    res.json({
      published: result.published || [],
      planned: result.planned || [],
      totalLines,
      totalMs: totalTime,
      timings: timings ? { ...timings, totalMs: totalTime } : null,
      vlmSuggested: !fromCache && !!result?._vlmSuggested,
      strategy: effectiveStrategy,
      fileName: storedName,
      fromCache,
      source: fromCache ? cachedResult._source : (result?._predictionSource || effectiveStrategy),
      newRoster: isNewRoster,
      labeled: fs.existsSync(path.join(labelsPath, `${storedName}.json`)),
      quality: result?._quality ? { confidence: result._quality.confidence, reason: result._quality.reason } : null,
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
      error: err.message || 'Đã có lỗi xảy ra khi OCR',
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

// Serve raw image file (dùng cho <img src="/api/raw?name=...">)
router.get('/raw', (req, res) => {
  const name = req.query.name;
  if (!name) return res.status(400).send('Missing ?name=');
  const filePath = path.join(folderPath, name);
  if (!fs.existsSync(filePath)) return res.status(404).send('File not found');
  res.sendFile(filePath);
});

// GET label JSON cho 1 file
router.get('/labels', (req, res) => {
  const name = req.query.name;
  if (!name) return res.status(400).json({ error: 'Missing ?name=' });
  const labelFile = path.join(labelsPath, `${name}.json`);
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
  if (!name) return res.status(400).json({ error: 'Missing ?name=' });
  if (path.basename(name) !== name) return res.status(400).json({ error: 'Invalid name' });
  if (!fs.existsSync(path.join(folderPath, name))) return res.status(404).json({ error: 'Image not found in fake-data' });
  if (!Array.isArray(req.body?.published) || !Array.isArray(req.body?.planned)) {
    return res.status(400).json({ error: 'Body must have published[] and planned[]' });
  }
  if (!fs.existsSync(labelsPath)) fs.mkdirSync(labelsPath, { recursive: true });
  const labelFile = path.join(labelsPath, `${name}.json`);
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
    res.json({ ok: true, file: `labels/${name}.json` });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// Review one labeled image against its label (benchmark "Xem" -> /upload?review=<name>).
// Prediction = cached one from this same model/parser (PIPELINE_ID), else a fresh
// OCR run without Gemini, i.e. what the benchmark scores. Rows are paired with
// the benchmark's own alignRows, so the marked cells are the benchmark's errors.
const REVIEW_FIELDS = ['date', 'day', 'duty', 'dep', 'begin', 'end', 'arr'];
router.get('/review', async (req, res) => {
  const name = String(req.query.name || '');
  if (!name || path.basename(name) !== name) return res.status(400).json({ error: 'Missing or invalid ?name=' });
  const filePath = path.join(folderPath, name);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Image not found in fake-data' });
  const labelFile = path.join(labelsPath, `${name}.json`);
  if (!fs.existsSync(labelFile)) return res.status(404).json({ error: 'This image has no label yet' });
  try {
    const label = JSON.parse(fs.readFileSync(labelFile, 'utf8'));
    const t0 = Date.now();
    let pred = getCachedPrediction(name);
    const fromCache = !!pred && pred._pipeline === PIPELINE_ID;
    if (!fromCache) {
      pred = await extractRaw(filePath, { strategy: 'paddleocr', allowVlmFallback: false });
      savePredictedResult(name, pred, { source: 'paddleocr', strategy: 'paddleocr', pipeline: PIPELINE_ID });
    }
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
    res.json({ fileName: name, sections, diffCells, missingRows, extraRows, fromCache, totalMs: Date.now() - t0 });
  } catch (e) {
    console.error('[/api/review]', e);
    res.status(500).json({ error: e.message });
  }
});

// Predict (inference) trên ảnh trong fake-data — dùng cho Auto-fill trong label tool
router.get('/predict', async (req, res) => {
  const name = req.query.name;
  if (!name) return res.status(400).json({ error: 'Missing ?name=' });
  const filePath = path.join(folderPath, name);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File not found' });
  try {
    const strategy = req.query.strategy; // 'vlm' | 'trocr'
    const data = await extractRaw(filePath, strategy ? { strategy } : undefined);
    savePredictedResult(name, data, {
      source: data?._predictionSource || strategy || process.env.STRATEGY || 'paddleocr',
      strategy: strategy || process.env.STRATEGY || 'paddleocr',
    });
    res.json(data);
  } catch (e) {
    console.error('[/api/predict]', e);
    res.status(500).json({ error: String(e) });
  }
});

// Benchmark JSON raw — view /benchmark sẽ fetch endpoint này
router.get('/benchmark', async (req, res) => {
  try {
    const strategy = req.query.strategy;
    // dedupe: byte-identical copies (69 of 160 files) are scored once, as in `npm run benchmark`.
    const result = await runBenchmark({ strategy, folderPath, labelsPath, dedupe: true });
    res.json(result);
  } catch (e) {
    console.error('[/api/benchmark]', e);
    res.status(500).json({ error: String(e) });
  }
});

// Stop benchmark đang chạy (SSE mode)
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

// Benchmark stream (SSE) - realtime progress per file
router.get('/benchmark/stream', async (req, res) => {
  const strategy = req.query.strategy;
  const runId = String(req.query.runId || `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`);
  let closed = false;

  if (activeBenchmarks.has(runId)) {
    return res.status(409).json({ error: `Benchmark runId already active: ${runId}` });
  }

  const runState = {
    runId,
    stopRequested: false,
    startedAt: Date.now(),
    stoppedAt: null,
  };
  activeBenchmarks.set(runId, runState);

  const send = (event, payload) => {
    if (closed) return;
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify({ runId, ...payload })}\n\n`);
  };

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  const heartbeat = setInterval(() => {
    if (!closed) res.write(': keep-alive\n\n');
  }, 15000);

  req.on('close', () => {
    closed = true;
    runState.stopRequested = true;
    clearInterval(heartbeat);
  });

  try {
    await runBenchmark({
      strategy,
      folderPath,
      labelsPath,
      dedupe: true,
      shouldStop: () => closed || runState.stopRequested,
      onEvent: (evt) => {
        if (evt?.type === 'start') send('start', evt);
        else if (evt?.type === 'file') send('file', evt);
        else if (evt?.type === 'done') send('done', evt);
      },
    });
  } catch (e) {
    send('error', { error: String(e?.message || e) });
  } finally {
    clearInterval(heartbeat);
    activeBenchmarks.delete(runId);
    if (!closed) res.end();
  }
});

export default router;
