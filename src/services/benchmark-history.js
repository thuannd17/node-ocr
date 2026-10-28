/**
 * History of the benchmark runs on /benchmark (and npm run ocr:benchmark / model:benchmark / acars:benchmark),
 * kept in MinIO (services/storage: benchmarks/<kind>/<id>/) so two runs can be compared.
 *
 *   saveRun(kind, result)        -> id | null   a finished run (kind ocr | model | acars); never throws
 *   listRuns(kind)               -> [summary]   newest first
 *   getRun(kind, id)             -> { summary, result }
 *   setNote(kind, id, note)      -> summary     a few words on what changed ("after the parser fix…")
 *   deleteRun(kind, id)
 *
 * A summary has the scores, the OCR server's device (device: { device: 'gpu' | 'cpu', name } | null) and, per file, [right, total] (rows, cells or fields), so the page can
 * compare runs without loading the whole results.
 */
import crypto from 'node:crypto';
import { listBenchmarks, getBenchmark, putBenchmark, deleteBenchmark } from './media-client.js';

export const KINDS = ['ocr', 'model', 'acars'];

/** "2026-10-23T09:15:02.123Z" -> "20261023-091502-x7k2" */
const newId = (at) => `${at.replace(/[-:]/g, '').replace('T', '-').slice(0, 15)}-${crypto.randomBytes(3).toString('hex').slice(0, 4)}`;
const brief = (s) => s && { files: s.files, rowMatches: s.rowMatches, rowTotal: s.rowTotal, rowExact: s.rowExact, perField: s.perField };
const modelOf = (m) => m && { id: m.id || null, trainedAt: m.trainedAt || null, files: m.files ?? null, acars: m.acars ?? null };
const perFile = (files, ok, total) => Object.fromEntries(files.map(f => [f.file, f.error ? null : [f[ok] ?? 0, f[total] ?? 0]]));

const SUMMARIES = {
  ocr: (r) => ({
    model: r.ocrModel || null, overall: r.overall, perField: r.perField, meanConfidence: r.meanConfidence, errors: r.errors,
    files: perFile(r.files, 'exact', 'cells'),
  }),
  model: (r) => ({
    model: modelOf(r.model), types: Object.keys(r.byType || {}), overall: brief(r.overall),
    byType: Object.fromEntries(Object.entries(r.byType || {}).map(([t, s]) => [t, brief(s)])),
    errors: r.errors, labelsAfterTraining: r.labelsAfterTraining, files: perFile(r.files, 'rowMatches', 'rowTotal'),
  }),
  acars: (r) => ({
    model: modelOf(r.model), pictures: r.pictures, allRight: r.allRight, allRightPct: r.allRightPct,
    fieldMatches: r.fieldMatches, fieldTotal: r.fieldTotal, fieldPct: r.fieldPct, perField: r.perField, errors: r.errors,
    labelsAfterTraining: r.labelsAfterTraining, files: perFile(r.files, 'fieldsRight', 'fieldTotal'),
  }),
};

const checkKind = (kind) => {
  if (!KINDS.includes(kind)) throw Object.assign(new Error(`No benchmark kind ${kind}`), { status: 404 });
};

/** Keep one finished run (a stopped one is not kept: its scores only count part of the files). */
export async function saveRun(kind, result) {
  checkKind(kind);
  if (!result || result.stopped) return null;
  const at = new Date().toISOString();
  const id = newId(at);
  try {
    const stored = { ...result, model: result.model && { ...result.model, dir: undefined } }; // no local paths
    await putBenchmark(kind, id, { id, kind, at, note: '', device: result.ocrDevice || null, ...SUMMARIES[kind](result) }, stored);
    return id;
  } catch (e) {
    console.warn(`[benchmark] could not keep the ${kind} run in the history: ${e.message}`);
    return null;
  }
}

const cache = new Map(); // "<kind>/<id>" -> { md5, summary }

export async function listRuns(kind) {
  checkKind(kind);
  const objects = await listBenchmarks(kind);
  const out = await Promise.all(objects.map(async ({ id, md5 }) => {
    const hit = cache.get(`${kind}/${id}`);
    if (hit && hit.md5 === md5) return hit.summary;
    const summary = await getBenchmark(kind, id, 'summary').catch(() => null);
    if (summary) cache.set(`${kind}/${id}`, { md5, summary });
    return summary;
  }));
  return out.filter(Boolean).sort((a, b) => b.id.localeCompare(a.id));
}

export async function getRun(kind, id) {
  checkKind(kind);
  const [summary, result] = await Promise.all([getBenchmark(kind, id, 'summary'), getBenchmark(kind, id, 'result')]);
  if (!summary) throw Object.assign(new Error('Benchmark run not found'), { status: 404 });
  return { summary, result };
}

export async function setNote(kind, id, note) {
  checkKind(kind);
  const summary = await getBenchmark(kind, id, 'summary');
  if (!summary) throw Object.assign(new Error('Benchmark run not found'), { status: 404 });
  summary.note = String(note ?? '').trim().slice(0, 300);
  await putBenchmark(kind, id, summary);
  cache.delete(`${kind}/${id}`);
  return summary;
}

export async function deleteRun(kind, id) {
  checkKind(kind);
  await deleteBenchmark(kind, id);
  cache.delete(`${kind}/${id}`);
}
