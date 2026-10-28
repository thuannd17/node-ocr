import test from 'node:test';
import assert from 'node:assert/strict';
import { eachInPool } from '../src/utils/pool.js';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

test('eachInPool: at most n at once, results in the list order, onDone counts', async () => {
  let running = 0, most = 0;
  const seen = [];
  const out = await eachInPool([30, 5, 20, 1, 10], 2, async (ms, i) => {
    most = Math.max(most, ++running);
    await sleep(ms);
    running -= 1;
    return `#${i}`;
  }, { onDone: (r, done) => seen.push(done) });
  assert.deepEqual(out, ['#0', '#1', '#2', '#3', '#4']);
  assert.equal(most, 2);
  assert.deepEqual(seen, [1, 2, 3, 4, 5]);
});

test('eachInPool: once shouldStop() is true no new item starts; the running ones finish', async () => {
  let stop = false;
  const started = [];
  const out = await eachInPool([1, 2, 3, 4, 5, 6], 2, async (x) => {
    started.push(x);
    await sleep(5);
    if (x === 2) stop = true;
    return x;
  }, { shouldStop: () => stop });
  assert.ok(started.length < 6);
  assert.deepEqual(out, started.slice().sort((a, b) => a - b));
});

test('eachInPool: an empty list', async () => {
  assert.deepEqual(await eachInPool([], 3, async () => 1), []);
});
