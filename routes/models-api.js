// /api/models: every model of the reading pipeline, by family, for the /models page.
//   GET    /api/models                     -> { families: [{ id, name, ..., versions: [...], training }] }
//   POST   /api/models/:family/:id/activate
//   DELETE /api/models/:family/:id         (never the active one)
//   POST   /api/models/:family/train       (one run at a time per family; GET .../train follows it)
//
// Families (what reads a roster, in order):
//   detect - OCR text detection (where the text is in an image): PaddleOCR's stock model, read only
//   rec    - OCR text recognition (image crop -> text): services/rec-models.js, trained by scripts/ocr-train.mjs
//   roster - AI roster reader (words -> roster rows): services/ai-models.js, trained by scripts/model-train.mjs
import { Router } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { listModels, activateModel, deleteModel } from '../services/ai-models.js';
import { listRecModels, activateRec, deleteRec } from '../services/rec-models.js';
import { startJob, jobState } from '../services/train-jobs.js';

const router = Router();
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Current .env values (the file can change while the app runs: /models switches the OCR model there). */
function envValue(key) {
  const text = fs.existsSync(path.join(ROOT, '.env')) ? fs.readFileSync(path.join(ROOT, '.env'), 'utf8') : '';
  return new RegExp(`^${key}=(.*)$`, 'm').exec(text)?.[1]?.trim() || '';
}

const pct = (m, t) => (t ? `${Math.round((1000 * m) / t) / 10}%` : '–');
const TYPE_NAMES = { image: 'Images', pdf: 'PDF', csv: 'CSV', xls: 'XLS', xlsx: 'XLSX', txt: 'TXT' };

// Text shown on /models is English here, worded per request with __ (req.__, utils/i18n.js).

/** Training files per type ("95 images, 74 PDF, 20 CSV, ..."); older versions only kept images / text files. */
const trainedOn = (m, __) => (m.filesByType
  ? Object.entries(m.filesByType).filter(([, n]) => n).map(([t, n]) => (t === 'image' ? __('{n} images', { n }) : `${n} ${TYPE_NAMES[t] || t}`)).join(', ')
  : __('{images} images, {texts} text files', { images: m.images ?? '?', texts: m.pdfs ?? '?' }));

/** A roster model's benchmark.json as lines: overall, then each file type (older runs: images + all text files). */
function scoreLines(b, __) {
  const line = (k, s) => `${k} ${pct(s.rowMatches, s.rowTotal)} (${__('{ok}/{total} rows', { ok: s.rowMatches, total: s.rowTotal })})`;
  const parts = b.byType
    ? [[__('Overall'), b.overall], ...Object.keys(TYPE_NAMES).map(t => [__(TYPE_NAMES[t]), b.byType[t]])]
    : [[__('Overall'), b.overall], [__('Images'), b.image], [__('Text files (PDF, CSV, XLS…)'), b.pdf]];
  return parts.filter(([, s]) => s?.rowTotal).map(([k, s]) => line(k, s));
}

const REC_STATUS = { deployed: 'in use', candidate: 'candidate', rejected: 'rejected', retired: 'replaced', baseline: 'baseline' };
const VERDICT = { better: 'better', worse: 'worse' };

const FAMILIES = {
  roster: {
    name: 'Roster AI',
    icon: 'fa-brain',
    description: 'Reads the words (OCR text of an image, or the text layer of a PDF) into roster rows: puts every word in a column (date, duty, dep, begin…), then joins them into rows. Learns from the labels in labels/.',
    applyNote: 'Activating takes effect at once on /upload and the AI model benchmark.',
    trainNote: 'Trains a new version on all image labels + PDF, CSV, XLS, XLSX, TXT (about 10 minutes). When done the new version is activated; the old one stays here.',
    train: () => ({ args: ['scripts/model-train.mjs'] }),
    versions: (__) => listModels().map(m => ({
      id: m.id, active: m.active, createdAt: m.trainedAt, status: m.active ? __('in use') : '',
      data: __('{files} files ({by}) · {rows} rows · {words} words', { files: m.files ?? '?', by: trainedOn(m, __), rows: (m.rows ?? 0).toLocaleString('en'), words: (m.words ?? 0).toLocaleString('en') }),
      score: m.benchmark ? scoreLines(m.benchmark, __) : [],
      scoreNote: m.benchmark ? __('measured by the AI model benchmark') : __('not benchmarked yet (Benchmark page → AI model)'),
      scoreAt: m.benchmark?.at || null,
      sizeBytes: m.sizeBytes, deletable: !m.active, keepReason: m.active ? __('Active') : '',
    })),
    activate: activateModel,
    remove: deleteModel,
  },
  rec: {
    name: 'OCR text recognition',
    icon: 'fa-font',
    description: 'Reads the text in every detected image region (PaddleOCR recognition), fine-tuned on the cells of labeled rosters.',
    applyNote: 'Switching the model changes OCR_CUSTOM_REC in .env: restart the OCR server (npm run ocr:server) to load it.',
    trainNote: 'Trains a new version on the labeled rosters, then compares it with the one in use on rosters neither has seen (about 1 hour). Needs the GPU: stop the OCR server before training. Not activated by itself: look at the result and click Activate if it is better.',
    train: () => {
      const env = { ...process.env };
      delete env.OCR_CUSTOM_REC; // read the current one from .env (--env-file does not override what is set)
      return { args: ['--env-file=.env', 'scripts/ocr-train.mjs'], env };
    },
    versions: (__) => listRecModels().map(m => {
      const c = m.comparison;
      return {
        id: m.id, title: m.name ? `${m.id} · ${m.name}` : m.id, active: m.active, createdAt: m.createdAt,
        status: m.active ? __('in use') : (REC_STATUS[m.status] ? __(REC_STATUS[m.status]) : m.status),
        data: m.id === 'stock' ? __('stock PaddleOCR, not fine-tuned')
          : m.trainedOn == null ? __('training data not recorded')
            : __('{n} rosters trained', { n: m.trainedOn }) + (m.testedOn ? ` · ${__('tested on {n} new rosters', { n: m.testedOn })}` : ''),
        score: c?.mine ? [__('{pct} rows right ({ok}/{total}) vs {other} {otherPct} on {n} new rosters: {verdict}', {
          pct: pct(c.mine.rowsCorrect, c.mine.rows), ok: c.mine.rowsCorrect, total: c.mine.rows, other: c.against,
          otherPct: pct(c.theirs.rowsCorrect, c.theirs.rows), n: c.rosters, verdict: __(VERDICT[c.verdict] || 'the same'),
        })] : [],
        scoreNote: c ? '' : (m.notes || ''),
        sizeBytes: m.sizeBytes, deletable: !m.active && m.id !== 'stock',
        keepReason: m.active ? __('Active') : m.id === 'stock' ? __('The stock model is the baseline for comparisons') : '',
      };
    }),
    activate: activateRec,
    remove: deleteRec,
  },
  detect: {
    name: 'OCR text detection',
    icon: 'fa-vector-square',
    description: 'Finds the regions with text in an image (PaddleOCR detection) before the text is read.',
    applyNote: '',
    trainNote: 'There is no training for this model yet: the stock PaddleOCR one is in use.',
    train: null,
    versions: (__) => {
      const custom = envValue('OCR_CUSTOM_DET');
      const limit = envValue('OCR_TEXT_DET_LIMIT_SIDE_LEN');
      return [{
        id: custom || 'PP-OCRv5_mobile_det', active: true, createdAt: null, status: __('in use'),
        data: custom ? __('custom model (OCR_CUSTOM_DET)') : __('stock PaddleOCR, not fine-tuned'),
        score: [], scoreNote: limit ? __('images are processed at up to {n}px on the long side (OCR_TEXT_DET_LIMIT_SIDE_LEN)', { n: limit }) : '',
        sizeBytes: null, deletable: false, keepReason: __('The only model'), readOnly: true,
      }];
    },
  },
};
const ORDER = ['roster', 'rec', 'detect'];

function familyView(id, __) {
  const f = FAMILIES[id];
  return {
    id, name: __(f.name), icon: f.icon, description: __(f.description), applyNote: f.applyNote && __(f.applyNote), trainNote: __(f.trainNote),
    trainable: !!f.train, versions: f.versions(__), training: jobState(id, 0),
  };
}

const familyOf = (req) => {
  const f = FAMILIES[req.params.family];
  if (!f) throw Object.assign(new Error(`No model family ${req.params.family}`), { status: 404 });
  return f;
};
const fail = (res, e) => res.status(e.status || 500).json({ error: e.message });

router.get('/', (req, res) => {
  try { res.json({ families: ORDER.map(id => familyView(id, req.__)) }); } catch (e) { fail(res, e); }
});

router.post('/:family/train', (req, res) => {
  try {
    const f = familyOf(req);
    if (!f.train) throw Object.assign(new Error('This model cannot be trained from the app yet.'), { status: 400 });
    const { args, env } = f.train();
    startJob(req.params.family, args, { env });
    res.json({ started: true, training: jobState(req.params.family) });
  } catch (e) { fail(res, e); }
});

router.get('/:family/train', (req, res) => {
  try { familyOf(req); res.json(jobState(req.params.family)); } catch (e) { fail(res, e); }
});

router.post('/:family/:id/activate', (req, res) => {
  try {
    const f = familyOf(req);
    if (!f.activate) throw Object.assign(new Error('This model cannot be switched.'), { status: 400 });
    f.activate(req.params.id);
    res.json({ ok: true, family: familyView(req.params.family, req.__) });
  } catch (e) { fail(res, e); }
});

router.delete('/:family/:id', (req, res) => {
  try {
    const f = familyOf(req);
    if (!f.remove) throw Object.assign(new Error('This model cannot be deleted.'), { status: 400 });
    f.remove(req.params.id);
    res.json({ ok: true, family: familyView(req.params.family, req.__) });
  } catch (e) { fail(res, e); }
});

export default router;
