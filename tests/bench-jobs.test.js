import test from 'node:test';
import assert from 'node:assert/strict';

const jobs = await import('../src/services/bench-jobs.js');
test.afterEach(() => jobs._resetBenchJobs());

const tick = (ms = 5) => new Promise(r => setTimeout(r, ms));

/** A fake benchmark: start, `files` file events one tick apart, done; stops early when asked. */
const fakeRun = (files) => async ({ onEvent, shouldStop }) => {
  onEvent({ type: 'start', total: files });
  let done = 0;
  for (; done < files && !shouldStop(); done++) {
    await tick();
    onEvent({ type: 'file', file: { file: `f${done}` }, progress: { current: done + 1, total: files } });
  }
  onEvent({ type: 'done', result: { files: done, stopped: done < files } });
};

test('a benchmark run goes on when its follower leaves; a new follower gets the events so far, then the rest', async () => {
  const job = jobs.startBenchJob('model', { types: ['pdf'] }, fakeRun(6), 'nonce-1');
  const first = [];
  const leave = jobs.follow(job, e => first.push(e.type));
  await tick(12);
  leave(); // the page is left
  const seenWhenLeft = first.length;
  await tick(60);
  assert.equal(first.length, seenWhenLeft); // nothing more for the one that left
  assert.equal(job.running, false);
  assert.equal(job.ok, true);
  const again = [];
  jobs.follow(job, e => again.push(e.type)); // the page comes back
  assert.deepEqual(again, ['start', 'file', 'file', 'file', 'file', 'file', 'file', 'done', 'end']);
  assert.equal(jobs.benchJob('model'), job); // kept a while after it ended
  assert.equal(job.nonce, 'nonce-1');
});

test('one run per kind at a time; another kind may run alongside; stop ends it after the current file', async () => {
  const job = jobs.startBenchJob('ocr', {}, fakeRun(50));
  assert.throws(() => jobs.startBenchJob('ocr', {}, fakeRun(1)), { status: 409 });
  const other = jobs.startBenchJob('acars', {}, fakeRun(1));
  await tick(10);
  assert.equal(jobs.stopBenchJob(job.runId), true);
  assert.equal(jobs.stopBenchJob('no-such-run'), false);
  await tick(30);
  assert.equal(job.running, false);
  const done = job.events.find(e => e.type === 'done');
  assert.equal(done.result.stopped, true);
  assert.ok(done.result.files < 50);
  assert.equal(other.running, false);
  const list = jobs.benchJobs();
  assert.deepEqual(list.map(j => j.kind).sort(), ['acars', 'ocr']);
});

test('a run that throws ends with an error event, not ok', async () => {
  const job = jobs.startBenchJob('model', {}, async ({ onEvent }) => { onEvent({ type: 'start', total: 1 }); throw new Error('MinIO down'); });
  await tick(10);
  assert.equal(job.ok, false);
  assert.deepEqual(job.events.map(e => e.type), ['start', 'error']);
  assert.equal(job.events[1].error, 'MinIO down');
});

test('/api/jobs: the running benchmark with its progress and the page to see it', async () => {
  const { default: express } = await import('express');
  const { default: jobsApi } = await import('../src/routes/jobs-api.js');
  const server = express().use('/api', jobsApi).listen(0);
  try {
    jobs.startBenchJob('model', {}, fakeRun(40));
    await tick(30);
    const { jobs: list } = await (await fetch(`http://localhost:${server.address().port}/api/jobs`)).json();
    const b = list.find(j => j.id === 'benchmark:model');
    assert.equal(b.type, 'benchmark');
    assert.equal(b.running, true);
    assert.ok(b.fraction > 0 && b.fraction < 1);
    assert.equal(b.href, '/benchmark#bench-model');
    assert.match(b.detail, /^\d+\/40 files$/);
  } finally {
    server.close();
    for (const j of jobs.benchJobs()) jobs.stopBenchJob(j.runId);
    await tick(20);
  }
});
