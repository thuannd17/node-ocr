// A small cache shared by the app's instances: Redis (REDIS_URL, e.g. redis://localhost:6379), keys under
// REDIS_PREFIX (default "rosterparser:", the database may hold other apps' keys: never FLUSHDB, only our prefix).
// Without REDIS_URL, or while Redis is down, it keeps the values in this process's memory instead, so a page
// never fails because of the cache; Redis is tried again REDIS_RETRY_MS (30 s) after a failure.
// Values are JSON. Uses: the /dashboard summary (routes/dashboard-api.js), the airports' weather (routes/airports-api.js).
//   await cache.get(key)                 -> value | null
//   await cache.set(key, value, ttlSec)
//   await cache.del(key)
//   await cache.wrap(key, ttlSec, fn)    -> the cached value, else fn()'s (stored when it is not null)
//   await cache.health()                 -> { ok, backend: 'redis'|'memory', detail, version?, memory?, keys?, error? }
const PREFIX = process.env.REDIS_PREFIX ?? 'rosterparser:';
const RETRY_MS = Number(process.env.REDIS_RETRY_MS) || 30_000;
const TIMEOUT_MS = 1500; // a cache that answers slower than this is no help

let client = null;
let connecting = null;
let downUntil = 0;
let lastError = null;

const memory = new Map(); // key -> { value, until }
const MEMORY_MAX = 500;

/** The URL with its password hidden (for the dashboard). */
const why = (e) => e?.message || e?.code || e?.errors?.[0]?.code || String(e);
const safeUrl = (u) => String(u || '').replace(/\/\/([^@/]*):[^@/]*@/, '//$1:***@');

async function redis() {
  const url = process.env.REDIS_URL;
  if (!url || Date.now() < downUntil) return null;
  if (client?.isReady) return client;
  connecting ||= (async () => {
    const { createClient } = await import('redis');
    const c = createClient({ url, socket: { connectTimeout: TIMEOUT_MS, reconnectStrategy: false } });
    c.on('error', (e) => { lastError = why(e); }); // a dropped connection: the next call finds it not ready
    await c.connect();
    client = c;
    lastError = null;
    return c;
  })().catch((e) => {
    lastError = why(e);
    downUntil = Date.now() + RETRY_MS;
    console.warn(`[cache] Redis not reachable (${lastError}): using memory for ${RETRY_MS / 1000} s`);
    return null;
  }).finally(() => { connecting = null; });
  return connecting;
}

/** A Redis call that gives up after TIMEOUT_MS; null (and memory for a while) when it fails. */
async function call(fn) {
  const c = await redis();
  if (!c) return { ok: false };
  let timer;
  try {
    const value = await Promise.race([fn(c), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Redis did not answer in time')), TIMEOUT_MS); })]);
    return { ok: true, value };
  } catch (e) {
    lastError = why(e);
    downUntil = Date.now() + RETRY_MS;
    console.warn(`[cache] ${lastError}: using memory for ${RETRY_MS / 1000} s`);
    client?.destroy?.();
    client = null;
    return { ok: false };
  } finally {
    clearTimeout(timer);
  }
}

function memGet(key) {
  const hit = memory.get(key);
  if (!hit) return null;
  if (hit.until < Date.now()) { memory.delete(key); return null; }
  return hit.value;
}
function memSet(key, value, ttlSec) {
  if (memory.size >= MEMORY_MAX) memory.delete(memory.keys().next().value);
  memory.set(key, { value, until: Date.now() + ttlSec * 1000 });
}

export async function get(key) {
  const r = await call(c => c.get(PREFIX + key));
  if (!r.ok) return memGet(key);
  try { return r.value == null ? null : JSON.parse(r.value); } catch { return null; }
}

export async function set(key, value, ttlSec) {
  const r = await call(c => c.set(PREFIX + key, JSON.stringify(value), { expiration: { type: 'EX', value: Math.max(1, Math.round(ttlSec)) } }));
  if (!r.ok) memSet(key, value, ttlSec);
}

export async function del(key) {
  memory.delete(key);
  await call(c => c.del(PREFIX + key));
}

export async function wrap(key, ttlSec, fn) {
  const hit = await get(key);
  if (hit != null) return hit;
  const value = await fn();
  if (value != null) await set(key, value, ttlSec);
  return value;
}

/** For /dashboard: is Redis answering, how fast, what it holds of ours. Never throws. */
export async function health() {
  const url = process.env.REDIS_URL;
  if (!url) return { ok: false, backend: 'memory', detail: 'REDIS_URL is not set', error: 'Not set up: the cache is kept in memory' };
  const r = await call(async (c) => {
    const [pong, info, mem] = await Promise.all([c.ping(), c.info('server'), c.info('memory')]);
    let keys = 0;
    for await (const batch of c.scanIterator({ MATCH: `${PREFIX}*`, COUNT: 200 })) keys += Array.isArray(batch) ? batch.length : 1;
    return { pong, version: /redis_version:(\S+)/.exec(info)?.[1] || null, memory: /used_memory_human:(\S+)/.exec(mem)?.[1] || null, keys };
  });
  if (!r.ok) return { ok: false, backend: 'memory', detail: safeUrl(url), error: lastError || 'not reachable' };
  return { ok: r.value.pong === 'PONG', backend: 'redis', detail: safeUrl(url), version: r.value.version, memory: r.value.memory, keys: r.value.keys };
}

/** Tests: forget the connection and the memory. */
export async function _reset() {
  memory.clear();
  downUntil = 0;
  lastError = null;
  try { await client?.quit(); } catch { /* already closed */ }
  client = null;
}
