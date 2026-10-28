import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { gate, _resetAnonymous } from '../src/routes/auth-api.js';
import { accountRouter } from '../src/routes/account-api.js';
import { isAdmin, isLocal, authConfig } from '../src/services/auth.js';
import { createAccounts, memoryStore, dbNameOf } from '../src/services/accounts.js';
import { ANONYMOUS } from '../src/services/plans.js';

const ON = { enabled: true, providers: ['google'] };
const OFF = { enabled: false, providers: [] };
const CLAIMS = {
  admin: { uid: 'a1', email: 'boss@example.com', email_verified: true, admin: true },
  user: { uid: 'u1', email: 'dev@example.com', email_verified: true, name: 'Dev' },
};
const verify = async (cookie) => CLAIMS[cookie] || null;

// An app behind the gate: every path answers 200 "ok" once let through; /api/account* by the account router.
async function serve({ config = ON, store = createAccounts(memoryStore()), auth } = {}) {
  _resetAnonymous();
  const app = express();
  app.set('trust proxy', 'loopback');
  app.use(express.json());
  app.use(gate({ config, verify, accounts: async () => store }));
  app.use('/api', accountRouter({ accounts: async () => store, auth: auth || fakeAuth() }));
  app.use((req, res) => res.send('ok'));
  const server = app.listen(0);
  await new Promise(r => server.once('listening', r));
  const base = `http://localhost:${server.address().port}`;
  const call = (path, { method = 'GET', headers = {}, session, key, body } = {}) => fetch(base + path, {
    method, redirect: 'manual', body: body && JSON.stringify(body),
    headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(session ? { cookie: `__session=${session}` } : {}), ...(key ? { authorization: `Bearer ${key}` } : {}), ...headers },
  });
  return { call, store, close: () => server.close() };
}

function fakeAuth() {
  const users = [
    { uid: 'a1', email: 'boss@example.com', role: 'admin', roleFixed: true, disabled: false, created: '2026-10-01T00:00:00Z', providers: ['google.com'] },
    { uid: 'u1', email: 'dev@example.com', role: 'user', roleFixed: false, disabled: false, created: '2026-10-20T00:00:00Z', providers: ['password'] },
  ];
  return {
    SESSION_COOKIE: '__session', users,
    listUsers: async () => users.map(u => ({ ...u })),
    setAdmin: async (uid, on) => { users.find(u => u.uid === uid).role = on ? 'admin' : 'user'; },
    setDisabled: async (uid, d) => { users.find(u => u.uid === uid).disabled = d; },
    setDisplayName: async () => {},
    deleteUser: async (uid) => { users.splice(users.findIndex(u => u.uid === uid), 1); },
  };
}

const site = { 'sec-fetch-site': 'same-origin' };

test('admin pages and APIs need an admin; /account and /api/account a signed-in account; pages stay open', async () => {
  const s = await serve();
  try {
    for (const p of ['/', '/roster', '/acars', '/api-docs', '/assets/app.css', '/login', '/signup', '/api/openapi.json', '/api/auth/me']) assert.equal((await s.call(p)).status, 200, p);
    const page = await s.call('/label?name=x.pdf');
    assert.equal(page.status, 302);
    assert.equal(page.headers.get('location'), '/login?next=%2Flabel%3Fname%3Dx.pdf');
    for (const [m, p] of [['GET', '/api/files'], ['POST', '/api/labels'], ['GET', '/api/models'], ['DELETE', '/api/media/file'], ['GET', '/api/roster/upload'],
      ['GET', '/api/users'], ['GET', '/api/something-new'], ['GET', '/API/files'], ['GET', '/api/Files/']]) {
      assert.equal((await s.call(p, { method: m, session: 'user' })).status, 401, `${m} ${p} as a user`);
      assert.equal((await s.call(p, { method: m })).status, 401, `${m} ${p}`);
    }
    for (const p of ['/LABEL', '/models/', '/users']) assert.equal((await s.call(p, { session: 'user' })).status, 302, p);
    assert.equal((await s.call('/label', { session: 'admin' })).status, 200);
    assert.equal((await s.call('/api/files', { session: 'admin' })).status, 200);
    assert.equal((await s.call('/api/files', { session: 'forged' })).status, 401);
    // an API key opens the public API only, not the admin side
    const { key } = await s.store.createKey('a1', 'admin key');
    assert.equal((await s.call('/api/files', { key })).status, 401);
    // the account's own page and API
    assert.equal((await s.call('/account')).status, 302);
    assert.equal((await s.call('/account', { session: 'user' })).status, 200);
    assert.equal((await s.call('/api/account')).status, 401);
    assert.equal((await s.call('/api/account', { session: 'user' })).status, 200);
  } finally { s.close(); }
});

test('the public API: a key, an account or a page of this site; else 401; counted, 429 past the limits', async () => {
  const s = await serve();
  try {
    // from elsewhere without a key
    const r = await s.call('/api/airports');
    assert.equal(r.status, 401);
    assert.equal((await r.json()).signup, '/signup');
    assert.equal((await s.call('/api/roster/upload', { method: 'POST', headers: { origin: 'https://other.example' } })).status, 401);
    // a page of this site (the browser's Sec-Fetch-Site, or Origin = host for older browsers)
    const anon = await s.call('/api/airports', { headers: site });
    assert.equal(anon.status, 200);
    assert.equal(anon.headers.get('x-ratelimit-limit'), String(ANONYMOUS.requests));
    assert.equal(anon.headers.get('x-ratelimit-remaining'), String(ANONYMOUS.requests - 1));
    assert.equal(anon.headers.get('access-control-allow-origin'), '*');
    assert.equal((await s.call('/api/airports', { headers: { 'sec-fetch-site': 'cross-site' } })).status, 401);
    // a key: counted against its account's plan, requests and reads apart
    await s.store.ensureAccount('u1', { email: 'dev@example.com' });
    await s.store.updateAccount('u1', { limits: { requests: 3, reads: 1 } });
    const { key, id } = await s.store.createKey('u1', 'my app');
    const ok = await s.call('/api/roster/upload', { method: 'POST', key });
    assert.equal(ok.status, 200);
    assert.equal(ok.headers.get('x-ratelimit-remaining'), '2');
    assert.equal(ok.headers.get('x-ratelimit-reads-remaining'), '0');
    const noRead = await s.call('/api/acars/read', { method: 'POST', key });
    assert.equal(noRead.status, 429);
    assert.equal((await noRead.json()).kind, 'reads');
    assert.ok(Number(noRead.headers.get('retry-after')) > 0);
    assert.equal((await s.call('/api/airports/VIE', { headers: { 'x-api-key': key } })).status, 200);
    assert.equal((await s.call('/api/airports', { key })).status, 200); // the 3rd request (the 429 above is not counted)
    assert.equal((await s.call('/api/airports', { key })).status, 429); // the 4th is over
    assert.deepEqual(await s.store.usageOf('u1'), { requests: 3, reads: 1 });
    // the same account signed in on the site shares its limits
    assert.equal((await s.call('/api/airports', { session: 'user', headers: site })).status, 429);
    // an admin signed in: no limit
    const admin = await s.call('/api/roster/upload', { method: 'POST', session: 'admin' });
    assert.equal(admin.status, 200);
    assert.equal(admin.headers.get('x-ratelimit-limit'), 'unlimited');
    // a made-up key, a revoked key, the key of a disabled account; a wrong key does not fall back to the page's use
    assert.equal((await s.call('/api/airports', { key: 'rp_' + 'x'.repeat(32) })).status, 401);
    assert.equal((await s.call('/api/airports', { key: 'nonsense', headers: site })).status, 401);
    const other = await s.store.createKey('u1', 'second');
    await s.store.updateAccount('u1', { limits: null });
    assert.equal((await s.call('/api/airports', { key: other.key })).status, 200);
    await s.store.updateAccount('u1', { disabled: true });
    assert.equal((await s.call('/api/airports', { key: other.key })).status, 403);
    await s.store.updateAccount('u1', { disabled: false });
    assert.ok(await s.store.revokeKey('u1', id));
    assert.equal((await s.call('/api/airports', { key })).status, 401);
    // CORS preflight of another site's page
    const pre = await s.call('/api/roster/upload', { method: 'OPTIONS', headers: { origin: 'https://other.example', 'access-control-request-method': 'POST', 'access-control-request-headers': 'authorization' } });
    assert.equal(pre.status, 204);
    assert.match(pre.headers.get('access-control-allow-headers'), /Authorization/);
  } finally { s.close(); }
});

test('visitors without an account: per IP and hour', async () => {
  const s = await serve();
  try {
    let last;
    for (let i = 0; i <= ANONYMOUS.reads; i++) last = await s.call('/api/acars/read', { method: 'POST', headers: site });
    assert.equal(last.status, 429);
    assert.match((await last.json()).error, /sign up/);
    // another address (through a proxy this app believes: loopback) has its own count
    assert.equal((await s.call('/api/acars/read', { method: 'POST', headers: { ...site, 'x-forwarded-for': '203.0.113.9' } })).status, 200);
  } finally { s.close(); }
});

test('the accounts store down: keys get 503, a signed-in visitor is counted as one without an account', async () => {
  const broken = { ...createAccounts(memoryStore()), findKey: async () => { throw new Error('down'); }, ensureAccount: async () => { throw new Error('down'); } };
  const s = await serve({ store: broken });
  try {
    assert.equal((await s.call('/api/airports', { key: 'rp_' + 'y'.repeat(32) })).status, 503);
    const r = await s.call('/api/airports', { session: 'user' });
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('x-ratelimit-limit'), String(ANONYMOUS.requests));
  } finally { s.close(); }
});

test('login off: the API is open and not counted; the admin side only on this machine', async () => {
  const s = await serve({ config: OFF });
  try {
    assert.equal((await s.call('/api/airports')).status, 200);
    assert.equal((await s.call('/label')).status, 200);
    assert.equal((await s.call('/api/files')).status, 200);
    for (const h of [{ 'x-forwarded-for': '1.2.3.4' }, { 'cf-connecting-ip': '1.2.3.4' }, { forwarded: 'for=1.2.3.4' }]) {
      assert.equal((await s.call('/api/files', { headers: h })).status, 403, JSON.stringify(h));
      assert.equal((await s.call('/label', { headers: h })).status, 302);
    }
    assert.equal((await s.call('/api/account')).status, 403);
  } finally { s.close(); }
});

test('/api/account: keys made, listed (never the key), at most 10, revoked; usage and limits', async () => {
  const s = await serve();
  try {
    const made = await (await s.call('/api/account/keys', { method: 'POST', session: 'user', body: { name: 'Crew app' } })).json();
    assert.match(made.key, /^rp_[A-Za-z0-9_-]{32}$/);
    assert.equal(made.hint, `${made.key.slice(0, 7)}…${made.key.slice(-4)}`);
    const list = await (await s.call('/api/account/keys', { session: 'user' })).json();
    assert.equal(list.keys.length, 1);
    assert.equal(list.keys[0].name, 'Crew app');
    assert.ok(!JSON.stringify(list).includes(made.key));
    assert.equal((await s.call('/api/airports', { key: made.key })).status, 200);
    const me = await (await s.call('/api/account', { session: 'user' })).json();
    assert.equal(me.limits.plan, 'free');
    assert.deepEqual(me.usage, { requests: 1, reads: 0 });
    for (let i = 1; i < 10; i++) await s.call('/api/account/keys', { method: 'POST', session: 'user', body: {} });
    assert.equal((await s.call('/api/account/keys', { method: 'POST', session: 'user', body: {} })).status, 400);
    // another account cannot revoke it
    const [{ key: adminKey }] = [await s.store.createKey('a1', 'x')];
    assert.ok(adminKey);
    assert.equal((await s.call(`/api/account/keys/${made.id}`, { method: 'DELETE', session: 'admin' })).status, 404);
    assert.equal((await s.call(`/api/account/keys/${made.id}`, { method: 'DELETE', session: 'user' })).status, 200);
    assert.equal((await s.call('/api/airports', { key: made.key })).status, 401);
    // an admin cannot delete its own account here; a user can
    assert.equal((await s.call('/api/account', { method: 'DELETE', session: 'admin' })).status, 400);
  } finally { s.close(); }
});

test('/api/users (admin): list with plan, keys and usage; role, plan, limits, disabled; not on oneself', async () => {
  const auth = fakeAuth();
  const s = await serve({ auth });
  try {
    await s.store.ensureAccount('u1', {});
    await s.store.createKey('u1', 'k');
    await s.store.spend('u1', { requests: 9, reads: 9 }, { read: true });
    const list = await (await s.call('/api/users', { session: 'admin' })).json();
    assert.deepEqual(list.users.map(u => [u.uid, u.role, u.plan, u.keys, u.usage.requests]), [['u1', 'user', 'free', 1, 1], ['a1', 'admin', 'free', 0, 0]]);
    const patch = (uid, body) => s.call(`/api/users/${uid}`, { method: 'PATCH', session: 'admin', body });
    assert.equal((await patch('u1', { plan: 'pro', limits: { requests: 5, reads: '' } })).status, 200);
    let a = await s.store.getAccount('u1');
    assert.equal(a.plan, 'pro');
    assert.deepEqual(a.limits, { requests: 5 });
    assert.equal((await patch('u1', { limits: null })).status, 200);
    a = await s.store.getAccount('u1');
    assert.equal(a.limits, null);
    assert.equal((await patch('u1', { plan: 'gold' })).status, 400);
    assert.equal((await patch('u1', { limits: { requests: -1 } })).status, 400);
    assert.equal((await patch('u1', { role: 'admin' })).status, 200);
    assert.equal(auth.users[1].role, 'admin');
    assert.equal((await patch('u1', { disabled: true })).status, 200);
    assert.equal(auth.users[1].disabled, true);
    assert.equal((await s.store.getAccount('u1')).disabled, true);
    // the ADMIN_EMAILS admin, oneself
    assert.equal((await patch('a1', { role: 'user' })).status, 400);
    assert.equal((await patch('a1', { disabled: true })).status, 400);
    assert.equal((await s.call('/api/users/a1', { method: 'DELETE', session: 'admin' })).status, 400);
    assert.equal((await (await s.call('/api/users/u1/keys', { method: 'DELETE', session: 'admin' })).json()).revoked, 1);
    assert.equal((await s.call('/api/users/u1', { method: 'DELETE', session: 'admin' })).status, 200);
    assert.equal(auth.users.length, 1);
  } finally { s.close(); }
});

test('accounts: calls written on flush and read back; a day starts at 0; a key looked up once a minute', async () => {
  let t = Date.parse('2026-10-25T10:00:00Z');
  const store = memoryStore();
  let gets = 0;
  const counting = { ...store, get: (c, id) => { if (c === 'apiKeys') gets++; return store.get(c, id); } };
  const a = createAccounts(counting, { now: () => t });
  const { key } = await a.createKey('u1', 'k');
  for (let i = 0; i < 3; i++) assert.ok(await a.findKey(key));
  assert.equal(gets, 1);
  await a.spend('u1', { requests: 10, reads: 10 }, { read: true });
  await a.spend('u1', { requests: 10, reads: 10 });
  await a.flushUsage();
  assert.deepEqual(await store.get('usage', 'u1_2026-10-25'), { uid: 'u1', day: '2026-10-25', requests: 2, reads: 1 });
  // a new instance reads the day back
  const b = createAccounts(store, { now: () => t });
  assert.deepEqual(await b.usageOf('u1'), { requests: 2, reads: 1 });
  t += 86400_000;
  assert.deepEqual(await b.usageOf('u1'), { requests: 0, reads: 0 });
});

test('isAdmin, isLocal, authConfig', () => {
  const emails = new Set(['boss@example.com']);
  assert.equal(isAdmin({ admin: true }, emails), true);
  assert.equal(isAdmin({ email: 'Boss@Example.com', email_verified: true }, emails), true);
  assert.equal(isAdmin({ email: 'boss@example.com', email_verified: false }, emails), false); // anyone can sign up with an email they do not own
  assert.equal(isAdmin({ email: 'other@example.com', email_verified: true }, emails), false);
  assert.equal(isAdmin(null, emails), false);
  assert.equal(isLocal({ socket: { remoteAddress: '::1' }, headers: {} }), true);
  assert.equal(isLocal({ socket: { remoteAddress: '10.0.0.5' }, headers: {} }), false);
  assert.equal(isLocal({ socket: { remoteAddress: '127.0.0.1' }, headers: { 'x-forwarded-for': '8.8.8.8' } }), false);
  assert.deepEqual(authConfig({}), { enabled: false, firebase: null, providers: ['google', 'github', 'password'] });
  const c = authConfig({ FIREBASE_API_KEY: 'k', FIREBASE_PROJECT_ID: 'p', AUTH_PROVIDERS: 'google, password, nope' });
  assert.deepEqual(c, { enabled: true, firebase: { apiKey: 'k', authDomain: 'p.firebaseapp.com', projectId: 'p' }, providers: ['google', 'password'] });
});

test('dbNameOf: MONGODB_DB, else the database of the URI, else "rosterparser"', () => {
  assert.equal(dbNameOf('mongodb://localhost:27017/rosterparser', {}), 'rosterparser');
  assert.equal(dbNameOf('mongodb://u:p@h1:1,h2:2/abc?replicaSet=x', {}), 'abc');
  assert.equal(dbNameOf('mongodb://localhost:27017', {}), 'rosterparser');
  assert.equal(dbNameOf('mongodb+srv://x.example.net/?retryWrites=true', {}), 'rosterparser');
  assert.equal(dbNameOf('mongodb://localhost/abc', { MONGODB_DB: 'other' }), 'other');
});
