/**
 * Training runs started from the app, one at a time per model family (a child
 * process: scripts/train-pdf-model.mjs, scripts/retrain-check.mjs, ...). The log
 * is kept in memory for the page that follows the run.
 *
 *   startJob(family, args, { env }) -> job (throws 409 when that family is already training)
 *   jobState(family)       -> { running, startedAt, finishedAt, ok, log: [last lines] }
 */
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const jobs = new Map();
const NOISE = /Warning|trace-warnings|warnings\.warn/;

export function jobState(family, lines = 60) {
  const j = jobs.get(family);
  if (!j) return { running: false, startedAt: null, finishedAt: null, ok: null, log: [] };
  return { running: j.running, startedAt: j.startedAt, finishedAt: j.finishedAt, ok: j.ok, log: lines ? j.log.slice(-lines) : [] };
}

export function startJob(family, args, { env = process.env } = {}) {
  if (jobs.get(family)?.running) throw Object.assign(new Error('Đang train model này, chờ xong đã.'), { status: 409 });
  const job = { running: true, log: [], startedAt: new Date().toISOString(), finishedAt: null, ok: null };
  jobs.set(family, job);
  const child = spawn(process.execPath, args, { cwd: ROOT, windowsHide: true, env });
  // A status line redrawn in place ("\r") shows as its latest state.
  const add = (d) => String(d).split(/\r?\n/).map(l => l.split('\r').pop()).filter(l => l.trim() && !NOISE.test(l)).forEach(l => job.log.push(l));
  child.stdout.on('data', add);
  child.stderr.on('data', add);
  child.on('close', (code) => Object.assign(job, { running: false, finishedAt: new Date().toISOString(), ok: code === 0 }));
  child.on('error', (e) => { job.log.push(e.message); Object.assign(job, { running: false, finishedAt: new Date().toISOString(), ok: false }); });
  return job;
}
