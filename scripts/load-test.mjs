/**
 * Load test for the PaddleOCR server: sends the same image set at several
 * concurrency levels and reports throughput, latency, and how much of the
 * latency is queueing (waiting for the server's single model lock) vs inference.
 *
 *   node --env-file=.env scripts/load-test.mjs [--url http://127.0.0.1:8502[,http://...]]
 *     [--concurrency 1,2,4,8] [--images 16] [--dir fake-data] [--pid <pid>[,<pid>]]
 *
 * Several --url values = several OCR server processes; requests are spread
 * round-robin over them. RAM is summed over all --pid processes.
 *
 * Images are pre-resized the same way services/paddle-ocr.js does (width capped
 * at OCR_MAX_WIDTH / 1600 in fast mode) into tmp/load-test/, so the server sees
 * what the app would send. Only side effect on the server: resets its /stats counters.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import sharp from 'sharp';

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) => {
  if (a.startsWith('--')) acc.push([a.slice(2), all[i + 1]?.startsWith('--') ? 'true' : all[i + 1]]);
  return acc;
}, []));

const URLS = String(args.url || process.env.OCR_SERVER_URL || 'http://127.0.0.1:8501')
  .split(',').map((u) => u.trim().replace(/\/+$/, '')).filter(Boolean);
const LEVELS = String(args.concurrency || '1,2,4,8').split(',').map(Number).filter((n) => n > 0);
const IMAGE_COUNT = Number(args.images || 16);
const SRC_DIR = path.resolve(args.dir || 'fake-data');
const SERVER_PIDS = args.pid ? String(args.pid).split(',').map(Number).filter(Boolean) : [];
const MAX_WIDTH = Number(process.env.OCR_MAX_WIDTH || (process.env.OCR_FAST_MODE ? (process.env.OCR_FAST_OCR_MAX_WIDTH || 1600) : 2000));
const WORK_DIR = path.resolve('tmp', 'load-test');

const pct = (arr, p) => {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)];
};
const avg = (arr) => (arr.length ? Math.round(arr.reduce((a, b) => a + b, 0) / arr.length) : 0);

async function prepareImages() {
  fs.mkdirSync(WORK_DIR, { recursive: true });
  const files = fs.readdirSync(SRC_DIR)
    .filter((f) => /\.(png|jpe?g|jfif|webp)$/i.test(f))
    .sort()
    .slice(0, IMAGE_COUNT);
  const out = [];
  for (const [i, f] of files.entries()) {
    const dest = path.join(WORK_DIR, `img_${String(i).padStart(3, '0')}.jpg`);
    if (!fs.existsSync(dest)) {
      const img = sharp(path.join(SRC_DIR, f));
      const { width } = await img.metadata();
      await (width > MAX_WIDTH ? img.resize(MAX_WIDTH) : img).jpeg({ quality: 92 }).toFile(dest);
    }
    out.push(dest);
  }
  return out;
}

async function getStats(url) {
  const res = await fetch(`${url}/stats`).catch(() => null);
  return res?.ok ? res.json() : null;
}

async function ocr(file, url) {
  const t0 = performance.now();
  const res = await fetch(`${url}/ocr`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path: file }),
    signal: AbortSignal.timeout(600000),
  });
  const data = await res.json().catch(() => ({}));
  return {
    ok: res.ok && data.ok,
    busy: res.status === 503 && !!data.busy,
    error: data.error,
    latencyMs: Math.round(performance.now() - t0),
    queueMs: data.queueMs ?? null,
    inferMs: data.inferMs ?? null,
  };
}

// Samples GPU memory (nvidia-smi) and the OCR server processes' RAM (tasklist) while a level runs.
function startResourceSampler() {
  const peak = { gpuMiB: null, ramMiB: null };
  const sample = () => {
    try {
      const gpu = execFileSync('nvidia-smi', ['--query-gpu=memory.used', '--format=csv,noheader,nounits'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
      const v = Number(gpu.trim().split('\n')[0]);
      if (Number.isFinite(v)) peak.gpuMiB = Math.max(peak.gpuMiB ?? 0, v);
    } catch { /* no GPU / no nvidia-smi */ }
    let ramKb = 0;
    for (const pid of SERVER_PIDS) {
      try {
        const csv = execFileSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { encoding: 'utf8' });
        ramKb += Number((csv.split('","')[4] || '').replace(/[^\d]/g, '')) || 0;
      } catch { /* process gone */ }
    }
    if (ramKb) peak.ramMiB = Math.max(peak.ramMiB ?? 0, Math.round(ramKb / 1024));
  };
  sample();
  const timer = setInterval(sample, 1000);
  return () => { clearInterval(timer); sample(); return peak; };
}

async function runLevel(images, concurrency) {
  const results = [];
  let next = 0;
  await Promise.all(URLS.map((u) => fetch(`${u}/stats/reset`, { method: 'POST' }).catch(() => null)));
  const stopSampler = startResourceSampler();
  const t0 = performance.now();
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (next < images.length) {
      const i = next++;
      results.push(await ocr(images[i], URLS[i % URLS.length])
        .catch((e) => ({ ok: false, error: `${e.message}${e.cause?.code ? ` (${e.cause.code})` : ''}`, latencyMs: null })));
    }
  }));
  const wallMs = Math.round(performance.now() - t0);
  const peak = stopSampler();
  const after = await Promise.all(URLS.map(getStats));

  const okRes = results.filter((r) => r.ok);
  const lat = okRes.map((r) => r.latencyMs);
  const queue = okRes.map((r) => r.queueMs).filter((v) => v != null);
  const infer = okRes.map((r) => r.inferMs).filter((v) => v != null);
  return {
    concurrency,
    requests: results.length,
    ok: okRes.length,
    busy: results.filter((r) => r.busy).length,
    failed: results.filter((r) => !r.ok && !r.busy).length,
    errors: [...new Set(results.filter((r) => !r.ok && !r.busy).map((r) => r.error))].slice(0, 3),
    wallMs,
    imgPerSec: +(okRes.length / (wallMs / 1000)).toFixed(2),
    latency: { avg: avg(lat), p50: pct(lat, 50), p95: pct(lat, 95), max: Math.max(0, ...lat) },
    queueMs: { avg: avg(queue), p95: pct(queue, 95), max: Math.max(0, ...queue) },
    inferMs: { avg: avg(infer), p95: pct(infer, 95) },
    serverMaxWaiting: after.some(Boolean) ? Math.max(...after.map((a) => a?.maxWaiting ?? 0)) : null,
    peakGpuMiB: peak.gpuMiB,
    peakServerRamMiB: peak.ramMiB,
  };
}

async function main() {
  let health = null;
  for (const u of URLS) {
    health = await fetch(`${u}/health`).then((r) => r.json()).catch(() => null);
    if (!health?.ok) {
      console.error(`OCR server not reachable at ${u}. Start one, e.g.:\n  OCR_SERVER_PORT=8502 npm run ocr-server`);
      process.exit(1);
    }
  }
  if (!(await getStats(URLS[0]))) console.warn('[warn] server has no /stats endpoint (old ocr_server.py?) — queue/infer split unavailable.');

  const images = await prepareImages();
  console.log(`Server ${URLS.join(' + ')} (${health.device}, max queue ${health.maxQueue ?? '?'}), ${images.length} images (max width ${MAX_WIDTH}px), levels ${LEVELS.join(',')}`);

  console.log('Warm-up...');
  await Promise.all(URLS.map((u) => ocr(images[0], u)));

  const rows = [];
  for (const c of LEVELS) {
    process.stdout.write(`concurrency ${c}... `);
    const r = await runLevel(images, c);
    rows.push(r);
    console.log(`${r.wallMs} ms, ${r.imgPerSec} img/s, p95 latency ${r.latency.p95} ms, busy ${r.busy}, failed ${r.failed}`);
  }

  console.log('\n conc | img/s | wall s | lat p50 | lat p95 | lat max | queue avg | queue p95 | infer avg | maxWait | GPU MiB | RAM MiB | busy | fail');
  for (const r of rows) {
    console.log([
      String(r.concurrency).padStart(5), String(r.imgPerSec).padStart(5), (r.wallMs / 1000).toFixed(1).padStart(6),
      String(r.latency.p50).padStart(7), String(r.latency.p95).padStart(7), String(r.latency.max).padStart(7),
      String(r.queueMs.avg).padStart(9), String(r.queueMs.p95).padStart(9), String(r.inferMs.avg).padStart(9),
      String(r.serverMaxWaiting ?? '-').padStart(7), String(r.peakGpuMiB ?? '-').padStart(7),
      String(r.peakServerRamMiB ?? '-').padStart(7), String(r.busy).padStart(4), String(r.failed).padStart(4),
    ].join(' | '));
  }

  const outFile = path.resolve('tmp', `load-test-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  fs.writeFileSync(outFile, JSON.stringify({ urls: URLS, device: health.device, images: images.length, maxWidth: MAX_WIDTH, rows }, null, 2));
  console.log(`\nSaved ${path.relative(process.cwd(), outFile)}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
