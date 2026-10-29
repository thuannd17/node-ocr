import test from 'node:test';
import assert from 'node:assert/strict';

// services/cache.js without Redis (memory), and with a Redis that is not there (falls back to memory at once).
// Never the real Redis: the tests must not write into the cache the app uses.
delete process.env.REDIS_URL;
process.env.REDIS_RETRY_MS = '60000';
const cache = await import('../src/services/cache.js');
test.afterEach(() => cache._reset());

test('cache without Redis: values kept in memory until their time is up', async () => {
  delete process.env.REDIS_URL;
  await cache.set('a', { n: 1 }, 30);
  assert.deepEqual(await cache.get('a'), { n: 1 });
  assert.equal(await cache.get('missing'), null);
  await cache.set('short', 'x', 0.05); // at least 1 s in Redis; in memory as given
  await new Promise(r => setTimeout(r, 80));
  assert.equal(await cache.get('short'), null);
  await cache.del('a');
  assert.equal(await cache.get('a'), null);
  const h = await cache.health();
  assert.deepEqual([h.ok, h.backend], [false, 'memory']);
});

test('cache.wrap: the function runs once, its value is reused; null is not kept', async () => {
  delete process.env.REDIS_URL;
  let calls = 0;
  const f = async () => { calls += 1; return { calls }; };
  assert.deepEqual(await cache.wrap('w', 30, f), { calls: 1 });
  assert.deepEqual(await cache.wrap('w', 30, f), { calls: 1 });
  assert.equal(calls, 1);
  let nulls = 0;
  await cache.wrap('n', 30, async () => { nulls += 1; return null; });
  await cache.wrap('n', 30, async () => { nulls += 1; return null; });
  assert.equal(nulls, 2);
});

test('cache with Redis down: no error, memory instead, quickly; health says why', async () => {
  process.env.REDIS_URL = 'redis://127.0.0.1:1'; // nothing listens there
  const t0 = Date.now();
  await cache.set('k', 42, 30);
  assert.equal(await cache.get('k'), 42);
  assert.ok(Date.now() - t0 < 3000, `took ${Date.now() - t0} ms`);
  const h = await cache.health();
  assert.equal(h.ok, false);
  assert.equal(h.backend, 'memory');
  assert.ok(h.error);
  delete process.env.REDIS_URL;
});
