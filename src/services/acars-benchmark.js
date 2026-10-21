/**
 * Benchmark of the AI model on the labeled ACARS pictures: each picture is read as /acars reads it
 * (OCR -> the model's ACARS fields, services/acars-read.js) and compared with its label field by field
 * (services/acars.js compareAcars: times as HH:MM, info as its flight and block times).
 * Byte-identical copies are scored once. A finished run's scores are saved in the model version's
 * benchmark.json as `acars` (shown on /models).
 * The model learned from these same labels, so the score is on pictures it has seen, except labels made
 * or changed after it was trained (`labelsAfterTraining`).
 *
 *   labeledAcars() -> names (one per content)
 *   runAcarsBenchmark({ onEvent, shouldStop }) -> { model, files, pictures, allRight, perField, errors, files: [...] }
 */
import fs from 'node:fs';
import crypto from 'node:crypto';
import { readAcarsPicture } from './acars-read.js';
import { compareAcars, ACARS_FIELDS } from './acars.js';
import { modelInfo } from './pdf-ai-extract.js';
import { saveBenchmark, syncModels } from './ai-models.js';
import { listReviewedLabels, dataFile, labelFile, ACARS_DATA_ROOT, ACARS_LABELS_ROOT } from '../utils/data-files.js';

const pct = (m, t) => (t ? Math.round((1000 * m) / t) / 10 : null);

/** Labeled ACARS pictures, one per distinct content (the first name). */
export function labeledAcars() {
  const seen = new Set();
  return listReviewedLabels(ACARS_LABELS_ROOT, 'image').filter((n) => {
    const file = dataFile(ACARS_DATA_ROOT, n);
    if (!fs.existsSync(file)) return false;
    const h = crypto.createHash('md5').update(fs.readFileSync(file)).digest('hex');
    if (seen.has(h)) return false;
    seen.add(h);
    return true;
  });
}

function summarize(files) {
  const ok = files.filter(f => !f.error);
  const perField = Object.fromEntries(ACARS_FIELDS.map(f => [f, { matches: 0, total: 0 }]));
  for (const f of ok) for (const k of ACARS_FIELDS) { perField[k].matches += f.perField[k].matches; perField[k].total += f.perField[k].total; }
  for (const v of Object.values(perField)) v.pct = pct(v.matches, v.total);
  const fieldMatches = Object.values(perField).reduce((a, v) => a + v.matches, 0);
  const fieldTotal = Object.values(perField).reduce((a, v) => a + v.total, 0);
  const allRight = ok.filter(f => f.allRight).length;
  return {
    pictures: ok.length, allRight, allRightPct: pct(allRight, ok.length),
    fieldMatches, fieldTotal, fieldPct: pct(fieldMatches, fieldTotal), perField,
  };
}

export async function runAcarsBenchmark({ onEvent, shouldStop } = {}) {
  await syncModels();
  const info = modelInfo();
  if (!info.ready) throw new Error('No AI model yet: label a few files, then click "Train" on /models.');
  if (!info.acars) throw new Error('The AI model in use was not trained on ACARS pictures: label some under "ACARS files" on /label, then train a new version on /models.');
  const trainedAt = info.trainedAt ? Date.parse(info.trainedAt) : null;
  const todo = labeledAcars();
  onEvent?.({ type: 'start', total: todo.length, model: info });
  const files = [];
  for (const [i, name] of todo.entries()) {
    if (shouldStop?.()) break;
    const t0 = Date.now();
    const lp = labelFile(ACARS_LABELS_ROOT, name);
    const entry = { kind: 'acars', file: name, afterTraining: trainedAt != null && fs.statSync(lp).mtimeMs > trainedAt };
    try {
      const label = JSON.parse(fs.readFileSync(lp, 'utf8'));
      const { fields } = await readAcarsPicture(dataFile(ACARS_DATA_ROOT, name), { engine: 'model', dir: info.dir });
      const c = compareAcars(fields, label);
      const right = Object.values(c.perField).reduce((a, v) => a + v.matches, 0);
      Object.assign(entry, { fields, perField: c.perField, allRight: c.allRight, diffs: c.diffs, diffCount: c.diffs.length, fieldsRight: right, fieldTotal: ACARS_FIELDS.length });
    } catch (e) {
      entry.error = e.message;
    }
    entry.ms = Date.now() - t0;
    files.push(entry);
    onEvent?.({ type: 'file', file: entry, progress: { current: i + 1, total: todo.length } });
  }
  const result = { model: info, ...summarize(files), errors: files.filter(f => f.error).length, files };
  result.stopped = files.length < todo.length;
  result.labelsAfterTraining = files.filter(f => f.afterTraining).length;
  if (!result.stopped) {
    await saveBenchmark(info.dir, {
      at: new Date().toISOString(),
      acars: { pictures: result.pictures, allRight: result.allRight, fieldMatches: result.fieldMatches, fieldTotal: result.fieldTotal, fieldPct: result.fieldPct },
    });
  }
  onEvent?.({ type: 'done', result });
  return result;
}
