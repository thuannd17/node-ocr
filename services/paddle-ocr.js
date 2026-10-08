// /services/paddle-ocr.js
/*
 * PaddleOCR strategy (offline) with VLM fallback.
 *
 * Kiến trúc:
 *   Node.js --HTTP--> Python micro-service (scripts/ocr_server.py, runtime
 *   PaddleOCR chính thức) --> raw lines {text, confidence, box}
 *   --> services/roster-parser.js parse bảng --> { published, planned }
 *
 * Gemini (VLM) when the OCR result looks poor (analyzeExtractionQuality):
 *   default            return the OCR result at once and flag it
 *                      (_vlmSuggested) so the page can offer a Gemini re-parse;
 *   VLM_FALLBACK=auto  call Gemini right away and wait for it (old behaviour,
 *                      up to VLM_TIMEOUT_MS);
 *   VLM_FALLBACK=0     never call or suggest Gemini.
 *   Waiting for Gemini by default made some uploads take 40 s+ even when its
 *   answer was then thrown away (2026-10-07). Gemini output never goes to labels/.
 *
 * Yêu cầu: chạy `npm run ocr-server` (hoặc `python scripts/ocr_server.py`)
 * trước khi dùng strategy paddleocr.
 */
import path from 'node:path';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { parseRoster, analyzeExtractionQuality, cleanExtractionResult } from './roster-parser.js';
import { extractWithVLM } from './vlm.js';

const OCR_SERVER_URL = (process.env.OCR_SERVER_URL || 'http://127.0.0.1:8501').replace(/\/+$/, '');
const OCR_TIMEOUT_MS = Number(process.env.OCR_TIMEOUT_MS || 300000); // Increased to 5min for very large files

const START_HINT = 'PaddleOCR server is not reachable. Start it first: npm run ocr-server '
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
      throw new Error(`OCR server không trả kết quả sau ${Math.round(OCR_TIMEOUT_MS / 1000)} s `
        + '(server có thể đang quá tải hoặc bị treo). Thử lại sau, hoặc restart: npm run ocr-server');
    }
    const cause = err?.cause?.code || err?.code || '';
    if (cause === 'ECONNREFUSED' || err?.name === 'TypeError') {
      throw new Error(START_HINT);
    }
    throw new Error(`PaddleOCR server request failed: ${err.message}`);
  }

  const data = await res.json().catch(() => null);
  if (res.status === 503 && data?.busy) {
    const busy = new Error(`OCR server đang bận (${data.inflight} ảnh đang xử lý/chờ). Vui lòng thử lại sau vài giây.`);
    busy.code = 'OCR_BUSY';
    throw busy;
  }
  if (!res.ok || !data || !data.ok) {
    const errMsg = data?.error || `HTTP ${res.status}`;
    if (res.status === 502 || /WinError 10061|ECONNREFUSED/i.test(errMsg)) {
      throw new Error(
        `OCR server không phản hồi ổn định.\n` +
        `Hãy restart OCR server: npm run ocr-server\n` +
        `Chi tiết: ${errMsg}`
      );
    }
    throw new Error(`PaddleOCR server error: ${errMsg}`);
  }
  return Array.isArray(data.lines) ? data.lines : [];
}


/**
 * Extract roster từ ảnh: OCR qua micro-service + parse bảng.
 * Low quality -> see the Gemini note at the top of this file.
 * Trả về { published: [], planned: [] } cùng format với VLM strategy.
 */
export async function extractWithPaddleOCR(filePath, opts = {}) {
  const vlmMode = opts.allowVlmFallback === false ? 'off'
    : ({ '0': 'off', auto: 'auto' }[String(process.env.VLM_FALLBACK || '').toLowerCase()] || 'suggest');
  const t0 = Date.now();
  const timings = {};
  
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
      tempImagePath = path.join(process.cwd(), 'tmp', `ocr_tmp_${randomUUID()}.jpg`);
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

   timings.ocrMs = Date.now() - t0;
   console.log(`[PaddleOCR] OCR server responded: ${lines.length} lines in ${timings.ocrMs}ms`);
   
   const t1 = Date.now();
   let result = parseRoster(lines);
   const parserMeta = result?._parserMeta || null;
   timings.parseMs = Date.now() - t1;
   console.log(`[PaddleOCR] Parser took ${timings.parseMs}ms: ${result.published?.length || 0} published, ${result.planned?.length || 0} planned`);
   
   const totalRows = (result.published?.length || 0) + (result.planned?.length || 0);

   // Analyze extraction quality and determine if VLM fallback is needed
   const qualityAnalysis = analyzeExtractionQuality(result);
   let finalResult = result;
   let predictionSource = 'paddleocr';
   let vlmSuggested = false;
   const lowQuality = qualityAnalysis.shouldUseVLM && process.env.VLM_API_KEY && vlmMode !== 'off';
   if (lowQuality) {
     console.log(`[PaddleOCR] Extraction quality is low (${(qualityAnalysis.confidence * 100).toFixed(0)}% confidence)`);
     console.log(`[PaddleOCR] Reason: ${qualityAnalysis.reason}`);
   }
   if (lowQuality && vlmMode === 'suggest') {
     vlmSuggested = true;
     console.log('[PaddleOCR] Not waiting for Gemini (VLM_FALLBACK=auto to do so); the page offers a Gemini re-parse.');
   } else if (lowQuality) {
     console.log(`[PaddleOCR] Falling back to VLM...`);
     const t2 = Date.now();
     try {
       const vlmResult = await extractWithVLM(filePath);
       const vlmRows = (vlmResult.published?.length || 0) + (vlmResult.planned?.length || 0);
       if (vlmRows > totalRows) {
         console.log(`[PaddleOCR] VLM returned ${vlmRows} rows (better than ${totalRows}). Using VLM result.`);
         finalResult = vlmResult;
          predictionSource = 'vlm-fallback';
         // Not written to labels/: an unreviewed Gemini answer must not become
         // ground truth for the benchmark and training (4 such labels found 2026-10-06).
       }
     } catch (vlmErr) {
       console.warn(`[PaddleOCR] VLM fallback failed: ${vlmErr.message}`);
     }
     timings.vlmMs = Date.now() - t2;
     console.log(`[PaddleOCR] Gemini took ${timings.vlmMs}ms`);
   } else if (!qualityAnalysis.shouldUseVLM) {
     console.log(`[PaddleOCR] Extraction confidence: ${(qualityAnalysis.confidence * 100).toFixed(0)}% - satisfactory`);
   }

   // Clean internal confidence tracking from result
   const cleanedResult = cleanExtractionResult(finalResult);
    return {
      ...cleanedResult,
      totalLines: (cleanedResult.published?.length || 0) + (cleanedResult.planned?.length || 0),
      _predictionSource: predictionSource,
      _quality: qualityAnalysis,
      _vlmSuggested: vlmSuggested,
      _timings: timings,
      _parserMeta: cleanedResult._parserMeta || parserMeta,
    };
}


export async function extract(filePath) {
  return extractWithPaddleOCR(filePath);
}

