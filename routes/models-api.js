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
const TYPE_NAMES = { image: 'Ảnh', pdf: 'PDF', csv: 'CSV', xls: 'XLS', xlsx: 'XLSX', txt: 'TXT' };

/** Training files per type ("95 ảnh, 74 PDF, 20 CSV, ..."); older versions only kept images / text files. */
const trainedOn = (m) => (m.filesByType
  ? Object.entries(m.filesByType).filter(([, n]) => n).map(([t, n]) => `${n} ${t === 'image' ? 'ảnh' : TYPE_NAMES[t] || t}`).join(', ')
  : `${m.images ?? '?'} ảnh, ${m.pdfs ?? '?'} file text`);

/** A roster model's benchmark.json as lines: overall, then each file type (older runs: images + all text files). */
function scoreLines(b) {
  const line = (k, s) => `${k} ${pct(s.rowMatches, s.rowTotal)} (${s.rowMatches}/${s.rowTotal} dòng)`;
  const parts = b.byType
    ? [['Chung', b.overall], ...Object.keys(TYPE_NAMES).map(t => [TYPE_NAMES[t], b.byType[t]])]
    : [['Chung', b.overall], ['Ảnh', b.image], ['File text (PDF, CSV, XLS…)', b.pdf]];
  return parts.filter(([, s]) => s?.rowTotal).map(([k, s]) => line(k, s));
}

const REC_STATUS ={ deployed: 'đang dùng', candidate: 'ứng viên', rejected: 'bị loại', retired: 'đã thay', baseline: 'bản gốc' };

const FAMILIES = {
  roster: {
    name: 'AI đọc roster',
    icon: 'fa-brain',
    description: 'Đọc các từ (chữ OCR của ảnh, hoặc lớp text của PDF) thành các dòng roster: gắn mỗi từ vào cột (date, duty, dep, begin…) rồi ghép thành dòng. Tự học từ các nhãn trong labels/.',
    applyNote: 'Kích hoạt có tác dụng ngay với /upload và benchmark AI model.',
    trainNote: 'Train một phiên bản mới từ toàn bộ nhãn ảnh + PDF, CSV, XLS, XLSX, TXT (khoảng 10 phút). Xong thì phiên bản mới tự kích hoạt; bản cũ vẫn giữ ở đây.',
    train: () => ({ args: ['scripts/model-train.mjs'] }),
    versions: () => listModels().map(m => ({
      id: m.id, active: m.active, createdAt: m.trainedAt, status: m.active ? 'đang dùng' : '',
      data: `${m.files ?? '?'} file (${trainedOn(m)}) · ${(m.rows ?? 0).toLocaleString('en')} dòng · ${(m.words ?? 0).toLocaleString('en')} từ`,
      score: m.benchmark ? scoreLines(m.benchmark) : [],
      scoreNote: m.benchmark ? 'đo bằng benchmark AI model' : 'chưa benchmark (trang Benchmark → AI model)',
      scoreAt: m.benchmark?.at || null,
      sizeBytes: m.sizeBytes, deletable: !m.active, keepReason: m.active ? 'Đang kích hoạt' : '',
    })),
    activate: activateModel,
    remove: deleteModel,
  },
  rec: {
    name: 'OCR nhận dạng chữ',
    icon: 'fa-font',
    description: 'Đọc chữ trong từng vùng ảnh đã phát hiện (PaddleOCR recognition), fine-tune trên các ô của roster đã label.',
    applyNote: 'Đổi model sửa OCR_CUSTOM_REC trong .env: cần khởi động lại OCR server (npm run ocr:server) để nạp model mới.',
    trainNote: 'Train một phiên bản mới trên các roster đã label, rồi so với bản đang dùng trên những roster cả hai chưa từng học (khoảng 1 giờ). Cần GPU: tắt OCR server trước khi train. Không tự kích hoạt: xem kết quả rồi bấm Kích hoạt nếu tốt hơn.',
    train: () => {
      const env = { ...process.env };
      delete env.OCR_CUSTOM_REC; // read the current one from .env (--env-file does not override what is set)
      return { args: ['--env-file=.env', 'scripts/ocr-train.mjs'], env };
    },
    versions: () => listRecModels().map(m => {
      const c = m.comparison;
      return {
        id: m.id, title: m.name ? `${m.id} · ${m.name}` : m.id, active: m.active, createdAt: m.createdAt,
        status: m.active ? 'đang dùng' : (REC_STATUS[m.status] || m.status),
        data: m.id === 'stock' ? 'PaddleOCR gốc, không fine-tune'
          : m.trainedOn == null ? 'không ghi lại dữ liệu train'
            : `${m.trainedOn} roster train${m.testedOn ? ` · test trên ${m.testedOn} roster mới` : ''}`,
        score: c?.mine ? [`${pct(c.mine.rowsCorrect, c.mine.rows)} dòng đúng (${c.mine.rowsCorrect}/${c.mine.rows}) so với ${c.against} ${pct(c.theirs.rowsCorrect, c.theirs.rows)} trên ${c.rosters} roster mới: ${c.verdict === 'better' ? 'tốt hơn' : c.verdict === 'worse' ? 'kém hơn' : 'ngang'}`] : [],
        scoreNote: c ? '' : (m.notes || ''),
        sizeBytes: m.sizeBytes, deletable: !m.active && m.id !== 'stock',
        keepReason: m.active ? 'Đang kích hoạt' : m.id === 'stock' ? 'Bản gốc dùng làm mốc so sánh' : '',
      };
    }),
    activate: activateRec,
    remove: deleteRec,
  },
  detect: {
    name: 'OCR phát hiện vùng chữ',
    icon: 'fa-vector-square',
    description: 'Tìm các vùng có chữ trong ảnh (PaddleOCR detection) trước khi đọc chữ.',
    applyNote: '',
    trainNote: 'Chưa có quy trình train cho model này: đang dùng bản gốc của PaddleOCR.',
    train: null,
    versions: () => {
      const custom = envValue('OCR_CUSTOM_DET');
      const limit = envValue('OCR_TEXT_DET_LIMIT_SIDE_LEN');
      return [{
        id: custom || 'PP-OCRv5_mobile_det', active: true, createdAt: null, status: 'đang dùng',
        data: custom ? 'model tuỳ chỉnh (OCR_CUSTOM_DET)' : 'bản gốc PaddleOCR, chưa fine-tune',
        score: [], scoreNote: limit ? `ảnh được xử lý ở cạnh dài tối đa ${limit}px (OCR_TEXT_DET_LIMIT_SIDE_LEN)` : '',
        sizeBytes: null, deletable: false, keepReason: 'Model duy nhất', readOnly: true,
      }];
    },
  },
};
const ORDER = ['roster', 'rec', 'detect'];

function familyView(id) {
  const f = FAMILIES[id];
  return {
    id, name: f.name, icon: f.icon, description: f.description, applyNote: f.applyNote, trainNote: f.trainNote,
    trainable: !!f.train, versions: f.versions(), training: jobState(id, 0),
  };
}

const familyOf = (req) => {
  const f = FAMILIES[req.params.family];
  if (!f) throw Object.assign(new Error(`Không có loại model ${req.params.family}`), { status: 404 });
  return f;
};
const fail = (res, e) => res.status(e.status || 500).json({ error: e.message });

router.get('/', (req, res) => {
  try { res.json({ families: ORDER.map(familyView) }); } catch (e) { fail(res, e); }
});

router.post('/:family/train', (req, res) => {
  try {
    const f = familyOf(req);
    if (!f.train) throw Object.assign(new Error('Model này chưa train được từ app.'), { status: 400 });
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
    if (!f.activate) throw Object.assign(new Error('Model này không đổi được.'), { status: 400 });
    f.activate(req.params.id);
    res.json({ ok: true, family: familyView(req.params.family) });
  } catch (e) { fail(res, e); }
});

router.delete('/:family/:id', (req, res) => {
  try {
    const f = familyOf(req);
    if (!f.remove) throw Object.assign(new Error('Model này không xoá được.'), { status: 400 });
    f.remove(req.params.id);
    res.json({ ok: true, family: familyView(req.params.family) });
  } catch (e) { fail(res, e); }
});

export default router;
