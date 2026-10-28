// Accounts of the API: plan and limits, API keys, calls counted per day. In MongoDB (MONGODB_URI; the sign-in itself,
// roles and disabled accounts are Firebase Authentication's: services/auth.js). Collections, _id = the id:
//   accounts   {uid}            { email, name, plan, limits?: { requests, reads }, disabled?, createdAt }
//   apiKeys    {sha256 of key}  { uid, name, hint: "rp_Ab12…xY9z", createdAt, lastUsedAt }   (the key itself is never kept)
//   usage      {uid}_{day}      { uid, day, requests, reads }                                 (day: UTC, plans.js)
// Lookups are cached for a minute, so a key used every second costs a read a minute. Calls are counted in memory and
// written every 15 s (one instance: deploy.mjs), and at the end (flushUsage on SIGTERM).
// createAccounts(memoryStore()) is the same without a database (tests, ACCOUNTS_STORE=memory).
import crypto from 'node:crypto';
import { DEFAULT_PLAN, dayOf } from './plans.js';

const CACHE_MS = 60_000;
const FLUSH_MS = 15_000;
export const KEY_PREFIX = 'rp_';

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
export const looksLikeKey = (s) => typeof s === 'string' && s.startsWith(KEY_PREFIX) && /^rp_[A-Za-z0-9_-]{32}$/.test(s);

/** A MongoDB store: the same documents, `_id` = their id; `limits` and other fields replaced whole ($set). */
export function mongoStore(db) {
  const plain = ({ _id, ...d }) => ({ id: _id, ...d });
  const strip = (d) => { if (!d) return null; const { _id, ...rest } = d; return rest; };
  const c = (col) => db.collection(col);
  return {
    async get(col, id) { return strip(await c(col).findOne({ _id: id })); },
    async set(col, id, data) { await c(col).updateOne({ _id: id }, { $set: data }, { upsert: true }); },
    async del(col, id) { await c(col).deleteOne({ _id: id }); },
    async where(col, field, value) { return (await c(col).find({ [field]: value }).toArray()).map(plain); },
    async all(col) { return (await c(col).find({}).toArray()).map(plain); },
    async add(col, id, base, counts) { await c(col).updateOne({ _id: id }, { $set: base, $inc: counts }, { upsert: true }); },
    /** The next number of a counter (1, 2, ...), atomic: invoice numbers. */
    async next(counter) {
      const d = await c('counters').findOneAndUpdate({ _id: counter }, { $inc: { n: 1 } }, { upsert: true, returnDocument: 'after' });
      return (d?.value ?? d).n; // driver 6 returns the document itself
    },
  };
}

export function memoryStore() {
  const cols = new Map();
  const col = (c) => (cols.has(c) ? cols.get(c) : cols.set(c, new Map()).get(c));
  return {
    async get(c, id) { const v = col(c).get(id); return v ? structuredClone(v) : null; },
    async set(c, id, data) { col(c).set(id, { ...(col(c).get(id) || {}), ...structuredClone(data) }); },
    async del(c, id) { col(c).delete(id); },
    async where(c, field, value) { return [...col(c)].filter(([, v]) => v[field] === value).map(([id, v]) => ({ id, ...structuredClone(v) })); },
    async all(c) { return [...col(c)].map(([id, v]) => ({ id, ...structuredClone(v) })); },
    async add(c, id, base, counts) {
      const v = { ...(col(c).get(id) || {}), ...base };
      for (const [k, n] of Object.entries(counts)) v[k] = (v[k] || 0) + n;
      col(c).set(id, v);
    },
    async next(counter) {
      const v = { n: (col('counters').get(counter)?.n || 0) + 1 };
      col('counters').set(counter, v);
      return v.n;
    },
  };
}

export function createAccounts(store, { now = () => Date.now() } = {}) {
  const accounts = new Map(); // uid -> { value, until }
  const keys = new Map(); // sha -> { value, until } (value null: no such key)
  const usage = new Map(); // `${uid}|${day}` -> { saved: { requests, reads }, pending: { requests, reads }, loading? }
  const touched = new Map(); // sha -> last used (ms), written with the next flush
  const cached = (map, id) => { const c = map.get(id); return c && c.until > now() ? c : null; };

  async function getAccount(uid) {
    const c = cached(accounts, uid);
    if (c) return c.value;
    const value = await store.get('accounts', uid);
    accounts.set(uid, { value, until: now() + CACHE_MS });
    return value;
  }

  /** The account of a signed-in user, made on its first sign-in (Free plan). */
  async function ensureAccount(uid, { email = '', name = '' } = {}) {
    const a = await getAccount(uid);
    if (a) {
      if ((email && a.email !== email) || (name && a.name !== name)) await updateAccount(uid, { email, name });
      return { ...a, email: email || a.email, name: name || a.name };
    }
    const value = { email, name, plan: DEFAULT_PLAN, createdAt: new Date(now()).toISOString() };
    await store.set('accounts', uid, value);
    accounts.set(uid, { value, until: now() + CACHE_MS });
    return value;
  }

  async function updateAccount(uid, patch) {
    await store.set('accounts', uid, patch);
    accounts.delete(uid);
  }

  async function createKey(uid, name) {
    const key = KEY_PREFIX + crypto.randomBytes(24).toString('base64url');
    const doc = { uid, name: String(name || '').trim().slice(0, 60) || 'API key', hint: `${key.slice(0, 7)}…${key.slice(-4)}`, createdAt: new Date(now()).toISOString(), lastUsedAt: null };
    await store.set('apiKeys', sha256(key), doc);
    return { key, id: sha256(key), ...doc };
  }

  async function listKeys(uid) {
    const list = await store.where('apiKeys', 'uid', uid);
    return list.map(k => ({ ...k, lastUsedAt: touched.has(k.id) ? new Date(touched.get(k.id)).toISOString() : k.lastUsedAt }))
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  }

  /** Revoke one key of this account (false: no such key of it). */
  async function revokeKey(uid, id) {
    const k = await store.get('apiKeys', id);
    if (!k || k.uid !== uid) return false;
    await store.del('apiKeys', id);
    keys.set(id, { value: null, until: now() + CACHE_MS });
    touched.delete(id);
    return true;
  }

  async function revokeAllKeys(uid) {
    const list = await store.where('apiKeys', 'uid', uid);
    for (const k of list) await revokeKey(uid, k.id);
    return list.length;
  }

  /** { uid, id, name } of a key, or null (also for a revoked or made-up one). */
  async function findKey(key) {
    if (!looksLikeKey(key)) return null;
    const id = sha256(key);
    const c = cached(keys, id);
    if (c) return c.value;
    const k = await store.get('apiKeys', id);
    const value = k ? { uid: k.uid, id, name: k.name } : null;
    keys.set(id, { value, until: now() + CACHE_MS });
    return value;
  }

  const touchKey = (id) => touched.set(id, now());

  async function counter(uid, day) {
    const id = `${uid}|${day}`;
    let c = usage.get(id);
    if (!c) {
      c = { saved: null, pending: { requests: 0, reads: 0 } };
      usage.set(id, c);
    }
    if (!c.saved) {
      c.loading ||= store.get('usage', `${uid}_${day}`).then((d) => { c.saved = { requests: d?.requests || 0, reads: d?.reads || 0 }; }).finally(() => { c.loading = null; });
      await c.loading;
    }
    return c;
  }

  /** The calls of today (or `day`) so far: { requests, reads }. */
  async function usageOf(uid, day = dayOf(now())) {
    const c = await counter(uid, day);
    return { requests: c.saved.requests + c.pending.requests, reads: c.saved.reads + c.pending.reads };
  }

  /**
   * Count a call if the limits allow it: { ok, used, limits } (used: after this call when ok). Synchronous after the
   * day's numbers are loaded, so calls at the same moment cannot pass the limit together.
   */
  async function spend(uid, limits, { read = false } = {}) {
    const day = dayOf(now());
    const c = await counter(uid, day);
    const used = { requests: c.saved.requests + c.pending.requests, reads: c.saved.reads + c.pending.reads };
    if (used.requests >= limits.requests || (read && used.reads >= limits.reads)) return { ok: false, used, limits, day };
    c.pending.requests += 1;
    if (read) c.pending.reads += 1;
    return { ok: true, used: { requests: used.requests + 1, reads: used.reads + (read ? 1 : 0) }, limits, day };
  }

  async function flushUsage() {
    const writes = [];
    for (const [id, c] of usage) {
      const [uid, day] = id.split('|');
      const counts = Object.fromEntries(Object.entries(c.pending).filter(([, n]) => n));
      if (Object.keys(counts).length) {
        c.pending = { requests: 0, reads: 0 };
        if (c.saved) for (const [k, n] of Object.entries(counts)) c.saved[k] += n;
        writes.push(store.add('usage', `${uid}_${day}`, { uid, day }, counts).catch((e) => {
          // not written: counted again next time
          for (const [k, n] of Object.entries(counts)) { c.pending[k] += n; if (c.saved) c.saved[k] -= n; }
          console.warn(`[accounts] usage not saved: ${e.message}`);
        }));
      }
      if (day !== dayOf(now()) && !c.pending.requests) usage.delete(id);
    }
    for (const [id, t] of touched) {
      writes.push(store.set('apiKeys', id, { lastUsedAt: new Date(t).toISOString() }).catch(() => {}));
      touched.delete(id);
    }
    await Promise.all(writes);
  }

  /** Delete an account's API data: its keys, its account (its usage stays, for the totals). */
  async function deleteAccount(uid) {
    await revokeAllKeys(uid);
    await store.del('accounts', uid);
    accounts.delete(uid);
  }

  // its PayPal subscriptions (services/billing.js keeps them): an account that still pays is not deleted
  const subscriptionsOf = async (uid) => store.where('subscriptions', 'uid', uid);
  const listAccounts = async () => new Map((await store.all('accounts')).map(({ id, ...a }) => [id, a]));
  const countKeys = async () => {
    const n = new Map();
    for (const k of await store.all('apiKeys')) n.set(k.uid, (n.get(k.uid) || 0) + 1);
    return n;
  };
  const usageOfDay = async (day = dayOf(now())) => {
    const list = await store.where('usage', 'day', day);
    const out = new Map(list.map(u => [u.uid, { requests: u.requests || 0, reads: u.reads || 0 }]));
    for (const [id, c] of usage) {
      const [uid, d] = id.split('|');
      if (d !== day) continue;
      const u = out.get(uid) || { requests: 0, reads: 0 };
      out.set(uid, { requests: u.requests + c.pending.requests, reads: u.reads + c.pending.reads });
    }
    return out;
  };

  return { getAccount, ensureAccount, updateAccount, createKey, listKeys, revokeKey, revokeAllKeys, findKey, touchKey, spend, usageOf, usageOfDay, flushUsage, deleteAccount, listAccounts, countKeys, subscriptionsOf };
}

// The app's accounts: MongoDB of MONGODB_URI (database MONGODB_DB, default "rosterparser"), connected on first use;
// calls written every 15 s. ACCOUNTS_STORE=memory: in memory instead, gone at restart (trying the pages without it).
let app = null;
let starting = null;
let failed = null; // { error, until }: not tried again for 30 s, so a request does not wait 5 s each time
const RETRY_MS = 30_000;

/** MONGODB_DB, else the database in the URI ("mongodb://host:27017/rosterparser"), else "rosterparser". */
export function dbNameOf(uri, env = process.env) {
  if (env.MONGODB_DB) return env.MONGODB_DB;
  const m = /^mongodb(?:\+srv)?:\/\/[^/]+\/([^?/]+)/.exec(uri || '');
  return m ? decodeURIComponent(m[1]) : 'rosterparser';
}

/** The app's database (MongoDB, or memory with ACCOUNTS_STORE=memory), shared by the accounts and billing.js. */
export function appStore() {
  if (failed && failed.until > Date.now()) return Promise.reject(failed.error);
  starting ||= (async () => {
    if (process.env.ACCOUNTS_STORE === 'memory') return memoryStore();
    const uri = process.env.MONGODB_URI;
    if (!uri) throw new Error('MONGODB_URI is not set: the accounts of the API need MongoDB');
    const { MongoClient } = await import('mongodb');
    const client = new MongoClient(uri, { serverSelectionTimeoutMS: 5000, appName: 'rosterparser' });
    await client.connect();
    const db = client.db(dbNameOf(uri));
    await Promise.all([
      db.collection('apiKeys').createIndex({ uid: 1 }), db.collection('usage').createIndex({ day: 1 }),
      db.collection('subscriptions').createIndex({ uid: 1 }), db.collection('invoices').createIndex({ uid: 1 }),
    ]);
    return mongoStore(db);
  })().then(
    (s) => { failed = null; return s; },
    (error) => { starting = null; failed = { error, until: Date.now() + RETRY_MS }; throw error; },
  );
  return starting;
}

export async function accounts() {
  if (app) return app;
  const store = await appStore();
  if (!app) {
    app = createAccounts(store);
    setInterval(() => app.flushUsage().catch(() => {}), FLUSH_MS).unref();
  }
  return app;
}
export const flushUsage = async () => { if (app) await app.flushUsage(); };
