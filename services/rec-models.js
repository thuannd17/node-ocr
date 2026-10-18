/**
 * Versions of the OCR text-recognition model (PaddleOCR rec, fine-tuned on roster crops):
 * models/rec/<vN|stock>/infer (what the OCR server loads) + model.json (recipe, what it was
 * trained/tested on, its ocr:train comparison, status). The active one is .env
 * OCR_CUSTOM_REC; the OCR server loads it at start, so switching needs a server restart.
 *
 *   listRecModels() -> [{ id, active, name, createdAt, status, trainedOn, testedOn, comparison, notes, sizeBytes }]
 *   activeRecId(), activateRec(id) (edits .env, keeps the old line as a comment), deleteRec(id)
 * Training a new version: scripts/ocr-train.mjs (npm run ocr:train).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const REC_DIR = path.join(ROOT, 'models', 'rec');
const ENV = path.join(ROOT, '.env');
const ID_RE = /^(v\d+|stock)$/;
const readJson = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return {}; } };
const writeJson = (p, o) => fs.writeFileSync(p, JSON.stringify(o, null, 2) + '\n', 'utf8');
const today = () => new Date().toISOString().slice(0, 10);
const fail = (msg, status) => Object.assign(new Error(msg), { status });

const isVersion = (id) => ID_RE.test(id) && fs.existsSync(path.join(REC_DIR, id, 'infer', 'inference.pdiparams'));
const envLine = () => /^OCR_CUSTOM_REC=(.*)$/m.exec(fs.existsSync(ENV) ? fs.readFileSync(ENV, 'utf8') : '');

export function activeRecId() {
  return /models\/rec\/(v\d+|stock)\/infer/.exec(envLine()?.[1] || '')?.[1] || null;
}

function dirSize(dir) {
  return fs.readdirSync(dir, { withFileTypes: true })
    .reduce((n, e) => n + (e.isDirectory() ? dirSize(path.join(dir, e.name)) : fs.statSync(path.join(dir, e.name)).size), 0);
}

export function listRecModels() {
  if (!fs.existsSync(REC_DIR)) return [];
  const active = activeRecId();
  return fs.readdirSync(REC_DIR).filter(isVersion)
    .sort((a, b) => (a === 'stock') - (b === 'stock') || Number(b.slice(1)) - Number(a.slice(1)))
    .map((id) => {
      const m = readJson(path.join(REC_DIR, id, 'model.json'));
      return {
        id, active: id === active, name: m.name || '', createdAt: m.createdAt || null, status: m.status || '',
        trainedOn: m.trainedOn?.length ?? null, testedOn: m.testedOn?.length ?? null,
        comparison: m.comparison ? { against: m.comparison.against, rosters: m.comparison.rosters, verdict: m.comparison.verdict,
          mine: m.comparison[id], theirs: m.comparison[m.comparison.against] } : null,
        notes: m.notes || '', sizeBytes: dirSize(path.join(REC_DIR, id)),
      };
    });
}

/** Point .env at this version (the old line kept as a comment) and update the statuses. */
export function activateRec(id) {
  if (!isVersion(id)) throw fail(`No OCR model ${id}`, 404);
  const active = activeRecId();
  if (id === active) return;
  const text = fs.readFileSync(ENV, 'utf8');
  const line = envLine();
  const newLine = `OCR_CUSTOM_REC=models/rec/${id}/infer`;
  fs.writeFileSync(ENV, line
    ? text.replace(line[0], `# ${today()}: switched from ${active || line[1]} (rollback: npm run ocr:use-model -- ${active || '?'})\n# ${line[0]}\n${newLine}`)
    : `${text.trimEnd()}\n${newLine}\n`, 'utf8');
  if (active && active !== 'stock') {
    const prev = path.join(REC_DIR, active, 'model.json');
    writeJson(prev, { ...readJson(prev), status: 'retired', retiredAt: today() });
  }
  const meta = path.join(REC_DIR, id, 'model.json');
  writeJson(meta, { ...readJson(meta), status: id === 'stock' ? 'baseline' : 'deployed', deployedAt: today() });
}

export function deleteRec(id) {
  if (!isVersion(id)) throw fail(`No OCR model ${id}`, 404);
  if (id === activeRecId()) throw fail('Cannot delete the active model: activate another one first.', 409);
  if (id === 'stock') throw fail('Cannot delete the stock model: it is the baseline the fine-tuned versions are compared with.', 409);
  fs.rmSync(path.join(REC_DIR, id), { recursive: true, force: true });
}
