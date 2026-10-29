// /routes/jobs-api.js
// Admin API: the long runs the server is doing (or just finished), for the status bar under the top bar of every
// page (views/assets/nav.js) — they run on the server, so leaving the page that started one does not stop it.
//   GET /api/jobs -> { jobs: [{ id, type: 'training'|'benchmark', title, section, running, ok, stopping, stopped,
//                               startedAt, finishedAt, fraction: 0..1 | null, detail, href, stop: url to POST | null }] }
// section: what part of the app the run is of (the model family; the benchmark and its file types).
// Finished runs stay listed for RECENT_MS (the bar shows "done" a little while), running ones always.
import { Router } from 'express';
import { trainingJobs } from './models-api.js';
import { benchJobs, benchJob, BENCH_TITLES } from '../services/bench-jobs.js';

const RECENT_MS = 2 * 60 * 1000;
// the part of /benchmark a run is of
const SECTIONS = { ocr: 'Text recognition from images (OCR)', model: 'Reading roster data', acars: 'ACARS pictures' };
const router = Router();
const recent = (j) => j.running || (j.finishedAt && Date.now() - Date.parse(j.finishedAt) < RECENT_MS);

router.get('/jobs', (req, res) => {
  const __ = req.__ || ((s, v) => String(s).replace(/\{(\w+)\}/g, (m, k) => (v && k in v ? v[k] : m)));
  const training = trainingJobs(__).map(({ id, name, state: s }) => {
    const p = s.progress;
    const detail = p ? [`${p.step}/${p.steps} ${p.title}`, p.total ? `${p.part} ${p.done}/${p.total}` : ''].filter(Boolean).join(' · ') : '';
    return {
      id: `training:${id}`, type: 'training', title: __('Training {name}', { name }), section: name, running: s.running, ok: s.ok,
      stopping: !!s.stopping, stopped: !!s.stopped, startedAt: s.startedAt, finishedAt: s.finishedAt, fraction: p ? p.fraction : null,
      detail, href: `/models#family-${id}`, stop: s.running && !s.stopping ? `/api/models/${id}/train/stop` : null,
    };
  });
  const bench = benchJobs().map((j) => {
    const types = benchJob(j.kind)?.params?.types;
    const section = j.kind === 'model' && types?.length ? `${__(SECTIONS.model)} · ${types.map(t => (t === 'image' ? __('Image') : t.toUpperCase())).join(', ')}` : __(SECTIONS[j.kind] || j.kind);
    return {
      id: `benchmark:${j.kind}`, type: 'benchmark', title: __(BENCH_TITLES[j.kind] || j.kind), section, running: j.running, ok: j.ok,
      stopping: !!j.stopping, stopped: !j.running && !!j.stopped, startedAt: j.startedAt, finishedAt: j.finishedAt,
      fraction: j.total ? j.current / j.total : null, detail: j.total ? __('{done}/{total} files', { done: j.current, total: j.total }) : '',
      href: `/benchmark#bench-${j.kind}`, stop: j.running && !j.stopping ? `/api/benchmark/stop?runId=${encodeURIComponent(j.runId)}` : null,
    };
  });
  res.json({ jobs: [...training, ...bench].filter(recent) });
});

export default router;
