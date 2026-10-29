/**
 * Benchmark runs started from /benchmark, one at a time per kind (ocr | model | acars), run by this server on their
 * own: a page only follows one (GET /api/benchmark/<kind>/stream), and leaving the page no longer stops it. A page
 * that comes back (or another tab) follows it again from the start: the events so far are played back.
 * The last finished run of a kind is kept FINISHED_KEEP_MS so a page opened after it ended still shows its result.
 *
 *   startBenchJob(kind, params, run, nonce) -> job   (409 when that kind is running); run({ onEvent, shouldStop });
 *                                    nonce: the page's id of this start (a reconnect with it only follows)
 *   benchJob(kind)                   -> the running or recently finished job, or null
 *   follow(job, send)                -> plays back the events, then sends the new ones; -> stop following
 *   stopBenchJob(runId)              -> true when such a run was running (it stops after the file it is on)
 *   benchJobs()                      -> [{ kind, runId, running, ... }] for /api/jobs
 */
const jobs = new Map(); // kind -> job
const FINISHED_KEEP_MS = 30 * 60 * 1000;

export const BENCH_TITLES = { ocr: 'OCR benchmark', model: 'Roster benchmark', acars: 'ACARS benchmark' };

export function benchJob(kind) {
  const j = jobs.get(kind);
  if (!j) return null;
  if (!j.running && Date.now() - Date.parse(j.finishedAt) > FINISHED_KEEP_MS) { jobs.delete(kind); return null; }
  return j;
}

export function startBenchJob(kind, params, run, nonce = null) {
  if (jobs.get(kind)?.running) throw Object.assign(new Error('This benchmark is already running: follow it or stop it first.'), { status: 409 });
  const job = {
    kind, params, nonce, runId: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    running: true, stopRequested: false, startedAt: new Date().toISOString(), finishedAt: null, ok: null,
    total: null, current: 0, events: [], followers: new Set(),
  };
  jobs.set(kind, job);
  const emit = (event) => {
    if (event.type === 'start') job.total = event.total;
    if (event.type === 'file') job.current = event.progress?.current ?? job.current + 1;
    job.events.push(event);
    for (const send of job.followers) send(event);
  };
  // the run itself: not tied to any request
  Promise.resolve()
    .then(() => run({ onEvent: emit, shouldStop: () => job.stopRequested }))
    .then(() => { job.ok = true; })
    .catch((e) => { job.ok = false; emit({ type: 'error', error: String(e?.message || e) }); })
    .finally(() => {
      Object.assign(job, { running: false, finishedAt: new Date().toISOString() });
      for (const send of job.followers) send({ type: 'end' });
      job.followers.clear();
    });
  return job;
}

export function follow(job, send) {
  for (const e of job.events) send(e);
  if (!job.running) { send({ type: 'end' }); return () => {}; }
  job.followers.add(send);
  return () => job.followers.delete(send);
}

export function stopBenchJob(runId) {
  for (const j of jobs.values()) {
    if (j.runId === runId && j.running) { j.stopRequested = true; return true; }
  }
  return false;
}

export function benchJobs() {
  return [...jobs.keys()].map(benchJob).filter(Boolean).map(j => ({
    kind: j.kind, runId: j.runId, running: j.running, ok: j.ok, stopping: j.running && j.stopRequested, stopped: !j.running && j.stopRequested,
    startedAt: j.startedAt, finishedAt: j.finishedAt, current: j.current, total: j.total,
  }));
}

/** Tests: forget every run. */
export function _resetBenchJobs() { jobs.clear(); }
