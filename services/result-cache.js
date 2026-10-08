/**
 * Result Cache
 * 
 * Cache parsed results by filename to avoid re-parsing the same image.
 * When user labels an image, the result is cached here.
 * Next time the same image is uploaded, we return the cached result.
 */
import fs from 'node:fs';
import path from 'node:path';

function getCacheDir() {
  return process.env.RESULT_CACHE_DIR
    ? path.resolve(process.env.RESULT_CACHE_DIR)
    : path.resolve(process.cwd(), 'cache', 'parsed');
}

function ensureCacheDir() {
  const dir = getCacheDir();
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

function getCachePath(fileName) {
  return path.join(getCacheDir(), `${fileName}.json`);
}

function normalizeResult(result) {
  return {
    published: result?.published || [],
    planned: result?.planned || [],
  };
}

function normalizeEntry(data) {
  if (!data || typeof data !== 'object') return null;

  if ('predictedResult' in data || 'labelResult' in data) {
    return {
      version: data.version || 2,
      updatedAt: data.updatedAt || null,
      predictedResult: data.predictedResult ? normalizeResult(data.predictedResult) : null,
      predictedMeta: data.predictedMeta || {},
      labelResult: data.labelResult ? normalizeResult(data.labelResult) : null,
      labelMeta: data.labelMeta || {},
    };
  }

  return {
    version: 1,
    updatedAt: data._cachedAt || null,
    predictedResult: normalizeResult(data),
    predictedMeta: {
      source: data._source || 'parser',
      strategy: data._predictionSource || data._source || null,
      savedAt: data._cachedAt || null,
      parserMeta: data._parserMeta || null,
      quality: data._quality || null,
    },
    labelResult: null,
    labelMeta: {},
  };
}

function readCacheEntry(fileName) {
  if (!fileName) return null;

  const cachePath = getCachePath(fileName);
  if (!fs.existsSync(cachePath)) return null;

  try {
    const data = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
    return normalizeEntry(data);
  } catch {
    return null;
  }
}

function writeCacheEntry(fileName, entry) {
  if (!fileName || !entry) return;
  ensureCacheDir();
  fs.writeFileSync(getCachePath(fileName), JSON.stringify(entry, null, 2), 'utf8');
}

/**
 * Get cached result for a filename
 * @param {string} fileName - Original filename (e.g., "Main1879.jpeg")
 * @returns {object|null} Cached {published, planned} or null
 */
export function getCachedResult(fileName) {
  const entry = readCacheEntry(fileName);
  if (!entry) return null;

  const preferred = entry.labelResult || entry.predictedResult;
  const meta = entry.labelResult ? entry.labelMeta : entry.predictedMeta;
  if (!preferred) return null;

  return {
    ...normalizeResult(preferred),
    totalLines: (preferred.published?.length || 0) + (preferred.planned?.length || 0),
    _fromCache: true,
    _cachedAt: meta?.savedAt || entry.updatedAt,
    _source: meta?.source || (entry.labelResult ? 'label' : 'prediction'),
    _isLabel: !!entry.labelResult,
    _pipeline: meta?.pipeline || null,
  };
}

/** The stored OCR prediction (never the label), with the pipeline id that made it. */
export function getCachedPrediction(fileName) {
  const entry = readCacheEntry(fileName);
  if (!entry?.predictedResult) return null;
  return { ...entry.predictedResult, _pipeline: entry.predictedMeta?.pipeline || null };
}

export function savePredictedResult(fileName, result, meta = {}) {
  if (!fileName || !result) return;

  const existing = readCacheEntry(fileName) || normalizeEntry({});
  const savedAt = new Date().toISOString();
  const nextEntry = {
    version: 2,
    updatedAt: savedAt,
    predictedResult: normalizeResult(result),
    predictedMeta: {
      source: meta.source || result._predictionSource || result._source || 'prediction',
      strategy: meta.strategy || result._predictionSource || null,
      savedAt,
      parserMeta: meta.parserMeta || result._parserMeta || null,
      quality: meta.quality || result._quality || null,
      // Which model/parser produced it; a prediction is only reused by the same one.
      pipeline: meta.pipeline || null,
    },
    labelResult: existing.labelResult,
    labelMeta: existing.labelMeta || {},
  };

  writeCacheEntry(fileName, nextEntry);
}

export function saveLabelResult(fileName, result, meta = {}) {
  if (!fileName || !result) return;

  const existing = readCacheEntry(fileName) || normalizeEntry({});
  const savedAt = new Date().toISOString();
  const nextEntry = {
    version: 2,
    updatedAt: savedAt,
    predictedResult: existing.predictedResult,
    predictedMeta: existing.predictedMeta || {},
    labelResult: normalizeResult(result),
    labelMeta: {
      source: meta.source || result._labelSource || 'manual-label',
      reviewedByUser: meta.reviewedByUser ?? result._reviewedByUser ?? false,
      savedAt,
      parserMeta: meta.parserMeta || result._parserMeta || null,
    },
  };

  writeCacheEntry(fileName, nextEntry);
}

