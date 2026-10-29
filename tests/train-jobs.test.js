import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { startJob, stopJob, jobState } = await import('../src/services/train-jobs.js');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'train-jobs-test-'));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

// alive and not a zombie (in a container without an init, an ended grandchild stays one until PID 1 reaps it)
const alive = (pid) => {
  try { process.kill(pid, 0); } catch { return false; }
  try { return fs.readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1]?.[0] !== 'Z'; } catch { return true; }
};
const waitFor = async (fn, ms = 10000) => { const t0 = Date.now(); while (!fn()) { if (Date.now() - t0 > ms) return false; await new Promise(r => setTimeout(r, 100)); } return true; };

test('stopJob ends a training run and the processes it started (as the scripts start Python)', async () => {
  // a "training script" that starts a child of its own (like model-train.mjs starts Python), then waits
  const pids = path.join(tmp, 'pids.json');
  const script = path.join(tmp, 'fake-train.mjs');
  fs.writeFileSync(script, `
    import { spawn } from 'node:child_process';
    import fs from 'node:fs';
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    fs.writeFileSync(${JSON.stringify(pids)}, JSON.stringify({ parent: process.pid, child: child.pid }));
    console.log('1/3 Training words from the labels');
    setInterval(() => {}, 1000);
  `);
  startJob('test-family', [script]);
  assert.ok(await waitFor(() => fs.existsSync(pids)), 'the fake run did not start');
  const { parent, child } = JSON.parse(fs.readFileSync(pids, 'utf8'));
  assert.ok(alive(parent) && alive(child));
  assert.equal(jobState('test-family').running, true);

  assert.equal(stopJob('test-family'), true);
  assert.equal(jobState('test-family').stopping, true);
  assert.ok(await waitFor(() => !jobState('test-family').running), 'the run did not end');
  const s = jobState('test-family');
  assert.deepEqual([s.stopped, s.ok], [true, false]);
  assert.ok(await waitFor(() => !alive(parent) && !alive(child)), 'a process of the run is still alive');
  assert.equal(stopJob('test-family'), false); // nothing running any more
});

test('a run that stops with "Nothing new to learn" says so in its state', async () => {
  const script = path.join(tmp, 'nothing-new.mjs');
  fs.writeFileSync(script, `console.log('Nothing new to learn: the labels (3 files), their files and the training code are those X was trained on. No version made.');`);
  startJob('nothing-family', [script]);
  assert.ok(await waitFor(() => !jobState('nothing-family').running));
  const s = jobState('nothing-family');
  assert.equal(s.ok, true);
  assert.equal(s.nothingNew, true);
});
