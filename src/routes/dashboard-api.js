// /routes/dashboard-api.js
// Admin API of the /dashboard page: one call with the state of everything (admin: not in docs/openapi.json).
//   GET /api/dashboard[?fresh=1] -> { at, cached, health, labels, helpdesk, users, models }
// Every section is read at once and on its own: a server that is down (MinIO, the OCR server, MongoDB, Redis, Firebase)
// gives that section { error } and the others still answer. Each section waits at most SECTION_MS.
// The whole answer is kept for CACHE_SEC (services/cache.js: Redis, per UI language): opening the page again within a
// minute reads it from there (cached: true, `at` = when it was made); ?fresh=1 (the Refresh button) makes it anew.
//   health    [{ id: minio|acars|ocr|mongo|redis, name, ok, ms, detail, error? }]
//   labels    { roster: { image, text }, acars } each { files, labeled, unlabeled, toReview }
//   helpdesk  { open, in_progress, resolved, closed, total }
//   users     { total, admins, disabled, byPlan: [{ id, label, n }] }
//   models    [{ id, name, icon, active: { id, title, createdAt, score } | null, training }]
import { Router } from 'express';
import { mediaHealth, syncMedia, acars, listSuggestions } from '../services/media-client.js';
import { ocrServerHealth, deviceOf, OCR_SERVER_URL } from '../services/paddle-ocr.js';
import { accounts } from '../services/accounts.js';
import { listUsers, authConfig } from '../services/auth.js';
import { PLANS, planOf } from '../services/plans.js';
import { kindOf, reviewState, LABELS_ROOT, ACARS_LABELS_ROOT } from '../utils/data-files.js';
import { ticketOf } from './suggestions-api.js';
import { activeModels } from './models-api.js';
import * as cache from '../services/cache.js';
import { langOf } from '../utils/i18n.js';

const SECTION_MS = 8000;
const CACHE_SEC = 60;
const router = Router();

/** fn's result, or { error } when it throws or takes longer than SECTION_MS. */
async function section(fn) {
  let timer;
  try {
    return await Promise.race([fn(), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('No answer in time')), SECTION_MS); })]);
  } catch (e) {
    return { error: e.message };
  } finally {
    clearTimeout(timer);
  }
}

/** One server's check: { ok, ms, detail } from what it answered, or { ok: false, error }. */
async function check(id, name, fn) {
  const t0 = Date.now();
  try {
    const r = await fn();
    return { id, name, ...r, ms: Date.now() - t0 };
  } catch (e) {
    return { id, name, ok: false, error: e.message, ms: Date.now() - t0 };
  }
}

const storeDetail = (h) => (h.backend === 'minio' ? `${h.endpoint} · ${h.bucket}` : h.backend === 'fs' ? h.dir : h.backend);

async function health() {
  return Promise.all([
    check('minio', 'MinIO (roster files)', async () => { const h = await mediaHealth(); return { ok: h.ok, detail: storeDetail(h), error: h.error }; }),
    check('acars', 'MinIO (ACARS pictures)', async () => { const h = await acars.mediaHealth(); return { ok: h.ok, detail: storeDetail(h), error: h.error }; }),
    check('ocr', 'OCR server', async () => {
      const h = await ocrServerHealth();
      if (!h?.ok) return { ok: false, detail: OCR_SERVER_URL, error: 'not reachable' };
      const d = deviceOf(h);
      return {
        ok: true, detail: `${OCR_SERVER_URL} · ${d?.name || (d?.device || '').toUpperCase()}`,
        info: { engineReady: !!h.engineReady, inflight: h.inflight ?? 0, waiting: h.waiting ?? 0, rec: h.rec, det: h.det },
      };
    }),
    check('mongo', 'MongoDB (accounts)', async () => { await (await accounts()).countKeys(); return { ok: true, detail: process.env.ACCOUNTS_STORE === 'memory' ? 'memory' : '' }; }),
    check('redis', 'Redis (cache)', async () => {
      const h = await cache.health();
      return { ok: h.ok, detail: h.detail, error: h.error, ...(h.ok ? { info: { version: h.version, memory: h.memory, keys: h.keys } } : {}) };
    }),
  ]);
}

/** Labeled / not / waiting for review, by file kind (the review marks are read from the mirror, so it is synced first). */
function tally(index, root, groupOf) {
  const labels = new Map(index.labels.map(l => [l.name, l.md5]));
  const out = {};
  for (const f of index.files) {
    const g = groupOf(f.name);
    if (!g) continue;
    const t = (out[g] ||= { files: 0, labeled: 0, unlabeled: 0, toReview: 0 });
    t.files += 1;
    if (!labels.has(f.name)) { t.unlabeled += 1; continue; }
    t.labeled += 1;
    if (reviewState(root, f.name, labels.get(f.name))) t.toReview += 1;
  }
  return out;
}

async function labels() {
  // a fresh listing, so the counts are right just after an upload
  const [roster, ac] = await Promise.all([syncMedia({ force: true }), acars.syncMedia({ force: true })]);
  const empty = { files: 0, labeled: 0, unlabeled: 0, toReview: 0 };
  const r = tally(roster.index, LABELS_ROOT, (n) => (kindOf(n) === 'image' ? 'image' : kindOf(n) ? 'text' : null));
  const a = tally(ac.index, ACARS_LABELS_ROOT, () => 'acars');
  return { roster: { image: r.image || empty, text: r.text || empty }, acars: a.acars || empty };
}

async function helpdesk() {
  const all = await listSuggestions();
  const out = { open: 0, in_progress: 0, resolved: 0, closed: 0, total: all.length };
  for (const s of all) out[ticketOf(s)] = (out[ticketOf(s)] || 0) + 1;
  return out;
}

async function users() {
  if (!authConfig().enabled) throw new Error('Sign-in is not set up (no Firebase settings), so there are no accounts');
  const [list, store] = await Promise.all([listUsers(), accounts()]);
  const own = await store.listAccounts();
  const byPlan = new Map(Object.keys(PLANS).map(id => [id, 0]));
  for (const u of list) {
    const p = planOf(own.get(u.uid));
    byPlan.set(p, (byPlan.get(p) || 0) + 1);
  }
  return {
    total: list.length, admins: list.filter(u => u.role === 'admin').length, disabled: list.filter(u => u.disabled).length,
    byPlan: [...byPlan].map(([id, n]) => ({ id, label: PLANS[id]?.label || id, n })),
  };
}

async function summary(req) {
  const [h, l, d, u, m] = await Promise.all([section(health), section(labels), section(helpdesk), section(users), section(async () => activeModels(req.__))]);
  return { at: new Date().toISOString(), health: h, labels: l, helpdesk: d, users: u, models: m };
}

router.get('/dashboard', async (req, res) => {
  const key = `dashboard:${langOf(req)}`;
  const fresh = req.query.fresh === '1' || req.query.fresh === 'true';
  const hit = fresh ? null : await cache.get(key);
  if (hit) return res.json({ ...hit, cached: true });
  const out = await summary(req);
  await cache.set(key, out, CACHE_SEC);
  res.json({ ...out, cached: false });
});

export default router;
