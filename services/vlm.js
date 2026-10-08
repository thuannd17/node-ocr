// /services/vlm.js
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { GoogleGenAI } from '@google/genai';

import {
  buildTextPrompt,
  buildFewShotText,
  FEW_SHOT_PICKS,
} from './prompts.js';
import { readCache, writeCache } from './cache.js';

const MAX_LONG_EDGE = 1568; // Google khuyến nghị <= 1568px
const DEFAULT_MODEL = 'gemini-3.5-flash';

let _client = null;

function getClient() {
  const apiKey = process.env.VLM_API_KEY;
  if (!apiKey) {
    throw new Error(
      'VLM_API_KEY is not set. Add it in .env, or use STRATEGY=paddleocr (offline).'
    );
  }
  if (_client) return _client;
  _client = new GoogleGenAI({ apiKey });
  return _client;
}

/**
 * Đọc + resize ảnh về JPEG buffer (giảm token cost và đảm bảo size <= 1568px).
 */
async function prepareImage(filePath) {
  const meta = await sharp(filePath).metadata();
  const longest = Math.max(meta.width || 0, meta.height || 0);
  const pipeline = sharp(filePath, { failOn: 'none' });
  if (longest > MAX_LONG_EDGE) {
    pipeline.resize({ width: MAX_LONG_EDGE, height: MAX_LONG_EDGE, fit: 'inside', withoutEnlargement: true });
  }
  const buf = await pipeline.flatten({ background: '#ffffff' }).jpeg({ quality: 90 }).toBuffer();
  return buf;
}

function toBase64DataUrl(buf, mime = 'image/jpeg') {
  return `data:${mime};base64,${buf.toString('base64')}`;
}

/**
 * Strip markdown fence ```json ... ``` nếu model lỡ trả về.
 */
function stripFences(text) {
  if (!text) return text;
  const t = text.trim();
  const m = t.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return m ? m[1].trim() : t;
}

/**
 * Validate + normalize shape của response.
 * Bảo đảm trả về { published: [], planned: [] } với mỗi row có đủ 6 field.
 */
function normalizeResponse(parsed) {
  const obj = parsed && typeof parsed === 'object' ? parsed : {};
  const makeRows = (arr) => {
    if (!Array.isArray(arr)) return [];
    return arr.map((r) => {
      const row = r && typeof r === 'object' ? r : {};
      return {
        date: String(row.date ?? ''),
        day: String(row.day ?? ''),
        duty: String(row.duty ?? ''),
        dep: String(row.dep ?? ''),
        begin: String(row.begin ?? ''),
        end: String(row.end ?? ''),
        arr: String(row.arr ?? ''),
      };
    });
  };
  return {
    published: makeRows(obj.published),
    planned: makeRows(obj.planned),
  };
}

/**
 * Ráp contents (text + image + few-shot examples) theo định dạng Gemini.
 *  - Few-shot: [example_image, example_text, example_image, example_text, ...]
 *  - Cuối: target_image + instruction_text
 */
function buildContents(targetBase64, fewShotParts = []) {
  const contents = [];

  // Few-shot examples trước
  for (const part of fewShotParts) {
    contents.push(part.image); // inlineData
    contents.push(part.text);  // text
  }

  // Target image
  contents.push({
    inlineData: { mimeType: 'image/jpeg', data: targetBase64 },
  });

  // Instruction
  contents.push(buildTextPrompt());

  return contents;
}

/**
 * Load một few-shot example: ảnh base64 + label JSON từ labels/<file>.json
 */
async function loadFewShotPart(fakeDataDir, labelsDir, fileName) {
  const imgPath = path.join(fakeDataDir, fileName);
  const labelPath = path.join(labelsDir, `${fileName}.json`);
  if (!fs.existsSync(imgPath) || !fs.existsSync(labelPath)) return null;

  const buf = await prepareImage(imgPath);
  const base64 = buf.toString('base64');
  const groundTruth = JSON.parse(fs.readFileSync(labelPath, 'utf8'));

  return {
    image: { inlineData: { mimeType: 'image/jpeg', data: base64 } },
    text: buildFewShotText({ fileName, groundTruth }),
  };
}

/**
 * Extract roster từ ảnh, trả về { published:[], planned:[] }.
 *
 * @param {string} filePath - Đường dẫn ảnh trong fake-data/
 * @param {{ dataDir?: string, labelsDir?: string }} _ctx
 */
export async function extractWithVLM(filePath, _ctx = {}) {
  const model = process.env.VLM_MODEL || DEFAULT_MODEL;
  const fakeDataDir = _ctx.dataDir || path.resolve(process.cwd(), 'fake-data');
  const labelsDir = _ctx.labelsDir || path.resolve(process.cwd(), 'labels');

  // cache key bao gồm danh sách few-shot picks (để đổi example tự invalidate)
  const fewShotSignature = FEW_SHOT_PICKS.join('|');
  const cached = readCache(filePath, model, fewShotSignature);
  if (cached) return normalizeResponse(cached);

  // Chuẩn bị ảnh target
  const targetBuf = await prepareImage(filePath);
  const targetBase64 = targetBuf.toString('base64');

  // Load few-shot parts
  const fewShotParts = [];
  for (const name of FEW_SHOT_PICKS) {
    const part = await loadFewShotPart(fakeDataDir, labelsDir, name);
    if (part) fewShotParts.push(part);
  }

  const ai = getClient();
  const contents = buildContents(targetBase64, fewShotParts);

  // Gọi model, dùng responseMimeType JSON để ké fence.
  // One deadline for both attempts (VLM_TIMEOUT_MS, default 30 s): without it a
  // slow Gemini answer held the upload request for 40 s+ (2026-10-07).
  const timeoutMs = Number(process.env.VLM_TIMEOUT_MS || 30000);
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), timeoutMs);
  const call = (config) => ai.models.generateContent({ model, contents, config: { ...config, abortSignal: abort.signal } });
  let response;
  try {
    try {
      response = await call({ responseMimeType: 'application/json' });
    } catch (err) {
      if (abort.signal.aborted) throw err;
      // Retry 1 lần không JSON mode (một số model/endpoint không support)
      response = await call({});
    }
  } catch (err) {
    if (abort.signal.aborted) throw new Error(`Gemini did not answer within ${timeoutMs >= 1000 ? `${Math.round(timeoutMs / 1000)} s` : `${timeoutMs} ms`} (VLM_TIMEOUT_MS)`);
    throw err;
  } finally {
    clearTimeout(timer);
  }

  let text = response?.text || '';
  text = stripFences(text);

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(`VLM did not return valid JSON. Raw: ${text.slice(0, 500)}`);
  }

  writeCache(filePath, model, parsed, fewShotSignature);
  return normalizeResponse(parsed);
}

export default { extractWithVLM };
