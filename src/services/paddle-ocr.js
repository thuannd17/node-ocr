// /services/paddle-ocr.js
/*
 * PaddleOCR strategy (offline).
 *
 * Kiến trúc:
 *   Node.js --HTTP--> Python micro-service (scripts/ocr_server.py, runtime
 *   PaddleOCR chính thức) --> raw lines {text, confidence, box}
 *   --> services/roster-parser.js parse bảng --> { published, planned }
 *
 * The quality analysis (analyzeExtractionQuality) is returned as `_quality` so
 * /roster can say when a result needs a closer look. (The Gemini/VLM fallback
 * was removed 2026-10-09; backup in tmp/backup-remove-vlm-20261009.)
 *
 * Yêu cầu: chạy `npm run ocr:server` (hoặc `python scripts/ocr_server.py`).
 */
import path from 'node:path';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { parseRoster, analyzeExtractionQuality, cleanExtractionResult } from './roster-parser.js';
import { TMP_DIR } from '../utils/paths.js';

const OCR_SERVER_URL = (process.env.OCR_SERVER_URL || 'http://127.0.0.1:8501').replace(/\/+$/, '');
const OCR_TIMEOUT_MS = Number(process.env.OCR_TIMEOUT_MS || 300000); // Increased to 5min for very large files

const START_HINT = 'PaddleOCR server is not reachable. Start it first: npm run ocr:server '
  + `(expected ${OCR_SERVER_URL}, set OCR_SERVER_URL to override)`;

const FAST_OCR_MAX_WIDTH = Number(process.env.OCR_FAST_OCR_MAX_WIDTH || 1600);
const MAX_OCR_WIDTH = Number(process.env.OCR_MAX_WIDTH || (process.env.OCR_FAST_MODE ? FAST_OCR_MAX_WIDTH : 2000)); // Lower for faster OCR


async function callOcrServer(filePath) {
  let res;
  try {
    res = await fetch(`${OCR_SERVER_URL}/ocr`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: path.resolve(filePath) }),
      signal: AbortSignal.timeout(OCR_TIMEOUT_MS),
    });
  } catch (err) {
    if (err?.name === 'TimeoutError' || err?.name === 'AbortError') {
      throw new Error(`The OCR server gave no result after ${Math.round(OCR_TIMEOUT_MS / 1000)} s `
        + '(it may be overloaded or stuck). Try again later, or restart it: npm run ocr:server');
    }
    const cause = err?.cause?.code || err?.code || '';
    if (cause === 'ECONNREFUSED' || err?.name === 'TypeError') {
      throw new Error(START_HINT);
    }
    throw new Error(`PaddleOCR server request failed: ${err.message}`);
  }

  const data = await res.json().catch(() => null);
  if (res.status === 503 && data?.busy) {
    const busy = new Error(`The OCR server is busy (${data.inflight} images in progress / waiting). Please try again in a few seconds.`);
    busy.code = 'OCR_BUSY';
    throw busy;
  }
  if (!res.ok || !data || !data.ok) {
    const errMsg = data?.error || `HTTP ${res.status}`;
    if (res.status === 502 || /WinError 10061|ECONNREFUSED/i.test(errMsg)) {
      throw new Error(
        `The OCR server is not responding reliably.\n` +
        `Restart it: npm run ocr:server\n` +
        `Details: ${errMsg}`
      );
    }
    throw new Error(`PaddleOCR server error: ${errMsg}`);
  }
  return Array.isArray(data.lines) ? data.lines : [];
}


/**
 * OCR lines of an image: [{ text, confidence, box: [[x, y] x4] }] in the
 * original image's pixels. Wide images are read at MAX_OCR_WIDTH (faster) and
 * the boxes scaled back. Also used for the learned extractor's training words.
 */
export async function ocrLines(filePath) {
  // --- Smart Resize for Speed ---
  // We create a temporary resized image to speed up the OCR detection phase.
  // We then scale the resulting coordinates back to the original image size.
  let processingPath = filePath;
  let scaleFactor = 1.0;
  let tempImagePath = null;

  try {
    const image = sharp(filePath);
    const metadata = await image.metadata();
    
    if (metadata.width > MAX_OCR_WIDTH) {
      scaleFactor = MAX_OCR_WIDTH / metadata.width;
      tempImagePath = path.join(TMP_DIR, `ocr_tmp_${randomUUID()}.jpg`);
      if (!fs.existsSync(path.dirname(tempImagePath))) fs.mkdirSync(path.dirname(tempImagePath), { recursive: true });
      
      await image
        .resize(MAX_OCR_WIDTH)
        .jpeg({ quality: 85 })
        .toFile(tempImagePath);
      
      processingPath = tempImagePath;
      console.log(`[PaddleOCR] Resized image from ${metadata.width}px to ${MAX_OCR_WIDTH}px (scale: ${scaleFactor.toFixed(2)}) for faster OCR`);
    }
  } catch (err) {
    console.warn(`[PaddleOCR] Resize failed: ${err.message}, using original image`);
  }

  let lines = [];
  try {
    lines = await callOcrServer(processingPath);
  } finally {
    if (tempImagePath && fs.existsSync(tempImagePath)) {
      try { fs.unlinkSync(tempImagePath); } catch {}
    }
  }

  // Scale coordinates back to original image size
  if (scaleFactor !== 1.0) {
    const inverseScale = 1 / scaleFactor;
    lines = lines.map(line => ({
      ...line,
      box: line.box.map(pt => [pt[0] * inverseScale, pt[1] * inverseScale])
    }));
  }
  return lines;
}

/**
 * Extract roster từ ảnh: OCR qua micro-service + parse bảng.
 * Trả về { published: [], planned: [] } (+ _quality, _timings).
 */
export async function extractWithPaddleOCR(filePath) {
  const t0 = Date.now();
  const timings = {};
  const lines = await ocrLines(filePath);

   timings.ocrMs = Date.now() - t0;
   console.log(`[PaddleOCR] OCR server responded: ${lines.length} lines in ${timings.ocrMs}ms`);
   
   const t1 = Date.now();
   let result = parseRoster(lines);
   const parserMeta = result?._parserMeta || null;
   timings.parseMs = Date.now() - t1;
   console.log(`[PaddleOCR] Parser took ${timings.parseMs}ms: ${result.published?.length || 0} published, ${result.planned?.length || 0} planned`);
   
   // How trustworthy the result looks (shown on /roster when low).
   const qualityAnalysis = analyzeExtractionQuality(result);
   console.log(`[PaddleOCR] Extraction confidence: ${(qualityAnalysis.confidence * 100).toFixed(0)}%`
     + (qualityAnalysis.lowQuality ? ` - low (${qualityAnalysis.reason})` : ' - satisfactory'));

   // Clean internal confidence tracking from result
   const cleanedResult = cleanExtractionResult(result);
    return {
      ...cleanedResult,
      totalLines: (cleanedResult.published?.length || 0) + (cleanedResult.planned?.length || 0),
      _predictionSource: 'paddleocr',
      _quality: qualityAnalysis,
      _timings: timings,
      _parserMeta: cleanedResult._parserMeta || parserMeta,
    };
}


export async function extract(filePath) {
  return extractWithPaddleOCR(filePath);
}

