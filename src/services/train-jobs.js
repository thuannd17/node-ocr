/**
 * Training runs started from the app, one at a time per model family (a child
 * process: scripts/model-train.mjs, scripts/ocr-train.mjs, ...). The log
 * is kept in memory for the page that follows the run.
 *
 *   startJob(family, args, { env }) -> job (throws 409 when that family is already training)
 *   stopJob(family)        -> true when a run was going: it and every process it started (Python, an OCR server) end
 *   jobState(family)       -> { running, stopping, stopped, startedAt, finishedAt, ok, log: [last lines], progress }
 * progress (from the lines the scripts print, null before the first step line):
 * { step, steps, title } of the last "2/4 Conventions" line, its last "[PDF 12/300] name" line as
 * { part, done, total, item }, and fraction: of the whole run, 0..1 (steps counted alike).
 */
import path from 'node:path';
import { spawn } from 'node:child_process';
import { ROOT } from '../utils/paths.js';
import { fileURLToPath } from 'node:url';

const jobs = new Map();
const NOISE = /Warning|trace-warnings|warnings\.warn/;

// "2/4 Conventions"; "  [PDF 12/300] name", "  [fit 2/5] stage 1 ...", "    [fields 3/24] dep 12s"
const STEP_RE = /^(\d+)\/(\d+) (.+)$/;
// "Nothing new to learn: ...": model-train.mjs stopped before training
const NOTHING_NEW_RE = /^Nothing new to learn:/;
const SUB_RE = /^\s*\[([A-Za-z]+) (\d+)\/(\d+)\]\s*(.*)$/;
// Parts of step 1, one after another: the PDFs, then the pictures, then the ACARS pictures
const READ_PARTS = ['PDF', 'pictures', 'ACARS'];

function progressOf(j) {
  if (!j.step) return null;
  const { step, steps, title } = j.step;
  const s = j.sub;
  let within = 0;
  if (s?.total && READ_PARTS.includes(s.part)) within = (READ_PARTS.indexOf(s.part) + (s.done - 1) / s.total) / READ_PARTS.length;
  else if (s?.total && s.part === 'fields' && j.fit) within = (j.fit.done - 1 + s.done / s.total) / j.fit.total;
  else if (s?.total) within = (s.done - 1) / s.total;
  const fraction = j.running === false && j.ok ? 1 : Math.min(1, (step - 1 + within) / steps);
  return { step, steps, title, ...(s ? { part: s.part, done: s.done, total: s.total, item: s.item } : {}), ...(j.fit && s?.part === 'fields' ? { fit: `${j.fit.done}/${j.fit.total}` } : {}), fraction };
}

export function jobState(family, lines = 60) {
  const j = jobs.get(family);
  if (!j) return { running: false, startedAt: null, finishedAt: null, ok: null, log: [] };
  return {
    running: j.running, stopping: j.running && !!j.stopRequested, stopped: !j.running && !!j.stopRequested,
    startedAt: j.startedAt, finishedAt: j.finishedAt, ok: j.ok, nothingNew: !!j.nothingNew, log: lines ? j.log.slice(-lines) : [], progress: progressOf(j),
  };
}

export function startJob(family, args, { env = process.env } = {}) {
  if (jobs.get(family)?.running) throw Object.assign(new Error('This model is already training; wait until it finishes.'), { status: 409 });
  const job = { running: true, log: [], startedAt: new Date().toISOString(), finishedAt: null, ok: null };
  jobs.set(family, job);
  // its own process group on Linux / macOS (Docker), so stopJob ends what it started too
  const child = spawn(process.execPath, args, { cwd: ROOT, windowsHide: true, env, detached: process.platform !== 'win32' });
  job.child = child;
  // A status line redrawn in place ("\r") shows as its latest state.
  const add = (d) => String(d).split(/\r?\n/).map(l => l.split('\r').pop()).filter(l => l.trim() && !NOISE.test(l)).forEach((l) => {
    job.log.push(l);
    if (NOTHING_NEW_RE.test(l)) job.nothingNew = true; // (scripts/model-train.mjs: the same data as the active version, no run)
    const st = STEP_RE.exec(l), sub = SUB_RE.exec(l);
    if (st) Object.assign(job, { step: { step: +st[1], steps: +st[2], title: st[3] }, sub: null, fit: null });
    else if (sub) {
      job.sub = { part: sub[1], done: +sub[2], total: +sub[3], item: sub[4].trim() };
      if (sub[1] === 'fit') job.fit = job.sub;
    }
  });
  child.stdout.on('data', add);
  child.stderr.on('data', add);
  child.on('close', (code) => Object.assign(job, { running: false, finishedAt: new Date().toISOString(), ok: code === 0 && !job.stopRequested, child: null }));
  child.on('error', (e) => { job.log.push(e.message); Object.assign(job, { running: false, finishedAt: new Date().toISOString(), ok: false }); });
  return job;
}

/** End the run of this family with the processes it started: taskkill /T on Windows, the process group elsewhere. */
export function stopJob(family) {
  const j = jobs.get(family);
  if (!j?.running || !j.child) return false;
  j.stopRequested = true;
  j.log.push('Stopped by an admin.');
  const pid = j.child.pid;
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true }).on('error', () => j.child?.kill());
  } else {
    try { process.kill(-pid, 'SIGTERM'); } catch { j.child.kill('SIGTERM'); }
    setTimeout(() => { if (j.running) { try { process.kill(-pid, 'SIGKILL'); } catch { /* gone */ } } }, 5000).unref();
  }
  return true;
}
