// /routes/auth-api.js — sign-in (services/auth.js) and the gate in front of the app.
//   GET  /api/auth/config   the Firebase web config and the sign-in ways (/login, /signup)
//   GET  /api/auth/me       who is signed in ({ user: { uid, email, name, role, ... } } or { user: null })
//   POST /api/auth/session  { idToken } of a fresh Firebase sign-in -> the "__session" cookie (any account)
//   POST /api/auth/logout   drops the cookie
// The gate sorts every request:
//   open      the pages but the ones below, /assets, /api/auth/*, /api/openapi.json
//   API       the public API of docs/openapi.json (PUBLIC_API): an API key ("Authorization: Bearer rp_..." or "X-API-Key"),
//             a signed-in account, or a page of this site in a browser (same origin) without an account. Counted against
//             the account's plan (services/plans.js) or, without an account, per IP and hour; 429 past it. Any origin
//             may call it (CORS), cookies are not sent then.
//   account   /account, /invoice, /api/account/*, an account's own /api/billing/* (ACCOUNT_API): a signed-in account
//   admin     the admin pages and every other API (/api/billing/admin/* too): an admin (a new API is admin until it
//             is listed here)
//   (open also: GET /api/billing/config, POST /api/billing/webhook: PayPal's events, checked with PayPal)
// Login off (no Firebase settings): the API is open and not counted, the admin side opens only on this machine.
import { Router } from 'express';
import { authConfig, isAdmin, isLocal, sessionCookieOf, verifySession, forgetSession, createSession, userOf, SESSION_COOKIE, SESSION_DAYS } from '../services/auth.js';
import { accounts as appAccounts, looksLikeKey } from '../services/accounts.js';
import { limitsOf, ANONYMOUS } from '../services/plans.js';

export const ADMIN_PAGES = ['/label', '/benchmark', '/models', '/media', '/helpdesk', '/users', '/billing'];
export const ACCOUNT_PAGES = ['/account', '/invoice'];
// an account's own API: its keys and usage (account-api.js), its plan, subscriptions and invoices (billing-api.js);
// /api/billing/admin/* is admin
const ACCOUNT_API = [/^\/api\/account(\/.*)?$/, /^\/api\/billing\/(me|subscriptions(\/[^/]+\/(activate|cancel))?|invoices\/[^/]+)$/];

// [method, path, read?]: the public API (docs/openapi.json) and the old /api/ocr/upload; read = it reads a file with
// the AI model (a roster, an ACARS picture: the OCR server), which plans count apart
export const PUBLIC_API = [
  ['POST', /^\/api\/roster\/upload$/, true],
  ['POST', /^\/api\/roster\/(suggestions|corrections)$/, false],
  ['POST', /^\/api\/acars\/read$/, true],
  ['POST', /^\/api\/acars\/(suggestions|corrections)$/, false],
  ['GET', /^\/api\/airports(\/[^/]+(\/weather)?)?$/, false],
  ['POST', /^\/api\/(night-time\/calc|calendar\/export|route-map)$/, false],
  ['POST', /^\/api\/ocr\/upload$/, true],
];
const OPEN_API = [['GET', /^\/api\/openapi\.json$/], ['GET', /^\/api\/auth\/(config|me)$/], ['POST', /^\/api\/auth\/(session|logout)$/],
  ['GET', /^\/api\/billing\/config$/], ['POST', /^\/api\/billing\/webhook$/]];

// lower case: Express routes ignore case, so "/API/files" and "/Label" reach the admin handlers too
const pathOf = (req) => (req.path.toLowerCase().replace(/\/+$/, '') || '/');
const methodIs = (req, m) => req.method === m || (m === 'GET' && req.method === 'HEAD');
export const isAdminPage = (req) => ADMIN_PAGES.includes(pathOf(req));
export const publicApiOf = (req, method = req.method) => PUBLIC_API.find(([m, re]) => (method === m || (m === 'GET' && method === 'HEAD')) && re.test(pathOf(req)));
export const isPublicApi = (req) => !!publicApiOf(req);
const isOpenApi = (req) => OPEN_API.some(([m, re]) => methodIs(req, m) && re.test(pathOf(req)));

/** The key of a request: "Authorization: Bearer rp_..." or "X-API-Key: rp_...". */
export function apiKeyOf(req) {
  const bearer = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization || '');
  return (bearer && looksLikeKey(bearer[1]) ? bearer[1] : null) || (looksLikeKey(req.headers['x-api-key']) ? req.headers['x-api-key'] : null);
}
/** A key was sent, valid or not (then it must be a valid one: no falling back to the page's anonymous use). */
const sentKey = (req) => !!(req.headers['x-api-key'] || /^Bearer\s/i.test(req.headers.authorization || ''));

/** A request of one of this site's pages in a browser (the browser sets Sec-Fetch-Site; else Origin / Referer). */
export function fromThisSite(req) {
  const site = req.headers['sec-fetch-site'];
  if (site) return site === 'same-origin';
  const from = req.headers.origin || req.headers.referer;
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  try { return !!from && !!host && new URL(from).host === host; } catch { return false; }
}

/** The signed-in account of a request: { claims, user } or null. */
async function sessionOf(req, verify) {
  const claims = await verify(sessionCookieOf(req));
  return claims ? { claims, user: userOf(claims) } : null;
}

// visitors without an account: per IP and hour, in memory (one instance)
const anonymous = new Map();
function spendAnonymous(ip, read, t = Date.now()) {
  const hour = Math.floor(t / 3600_000);
  let c = anonymous.get(ip);
  if (!c || c.hour !== hour) {
    if (anonymous.size > 20_000) anonymous.clear();
    c = { hour, requests: 0, reads: 0 };
    anonymous.set(ip, c);
  }
  const limits = { requests: ANONYMOUS.requests, reads: ANONYMOUS.reads };
  if (c.requests >= limits.requests || (read && c.reads >= limits.reads)) return { ok: false, used: { ...c }, limits, resetAt: (hour + 1) * 3600_000 };
  c.requests += 1;
  if (read) c.reads += 1;
  return { ok: true, used: { requests: c.requests, reads: c.reads }, limits, resetAt: (hour + 1) * 3600_000 };
}
export const _resetAnonymous = () => anonymous.clear();

const nextUtcMidnight = (t = Date.now()) => (Math.floor(t / 86400_000) + 1) * 86400_000;
function rateHeaders(res, s) {
  const finite = (n) => (Number.isFinite(n) ? String(n) : 'unlimited');
  res.set('X-RateLimit-Limit', finite(s.limits.requests));
  res.set('X-RateLimit-Remaining', finite(Math.max(0, s.limits.requests - s.used.requests)));
  res.set('X-RateLimit-Reads-Limit', finite(s.limits.reads));
  res.set('X-RateLimit-Reads-Remaining', finite(Math.max(0, s.limits.reads - s.used.reads)));
  res.set('X-RateLimit-Reset', String(Math.ceil(s.resetAt / 1000)));
}
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, X-API-Key, Content-Type, X-UI-Lang',
  'Access-Control-Expose-Headers': 'X-RateLimit-Limit, X-RateLimit-Remaining, X-RateLimit-Reads-Limit, X-RateLimit-Reads-Remaining, X-RateLimit-Reset, Retry-After',
  'Access-Control-Max-Age': '600',
};

const warned = new Map();
const warnOnce = (msg) => {
  if ((warned.get(msg) || 0) > Date.now()) return;
  warned.set(msg, Date.now() + 10 * 60_000);
  console.warn(msg);
};
const unavailable = (res) => { res.status(503).json({ error: 'API keys cannot be checked right now, please try again in a minute' }); return null; };

/**
 * Count a call of the public API against its caller's limits: the spend ({ ok, used, limits }), or null once answered.
 * A key: its account's plan. A signed-in account: its plan (an admin: no limit). A page of this site without an
 * account: per IP. The accounts store down (MongoDB): keys cannot be checked (503), a signed-in visitor is counted
 * as one without an account.
 */
async function spendFor(req, res, { read, verify, accounts }) {
  let store = null;
  try { store = await accounts(); } catch (e) { warnOnce(`[auth] accounts store not reachable: ${e.message}`); }
  if (apiKeyOf(req) || sentKey(req)) {
    if (!store) return unavailable(res);
    try {
      const k = await store.findKey(apiKeyOf(req));
      if (!k) { res.status(401).json({ error: 'This API key is not valid (it may have been revoked): make one on /account' }); return null; }
      const account = await store.getAccount(k.uid);
      if (account?.disabled) { res.status(403).json({ error: 'The account of this API key is disabled' }); return null; }
      const spent = await store.spend(k.uid, limitsOf(account), { read });
      store.touchKey(k.id);
      req.caller = { kind: 'key', uid: k.uid, keyId: k.id };
      return spent;
    } catch (e) {
      warnOnce(`[auth] accounts store not reachable: ${e.message}`);
      return unavailable(res);
    }
  }
  const s = await sessionOf(req, verify);
  if (s && store) {
    try {
      if (isAdmin(s.claims)) {
        req.caller = { kind: 'admin', uid: s.user.uid };
        return await store.spend(s.user.uid, { requests: Infinity, reads: Infinity }, { read });
      }
      const account = await store.ensureAccount(s.user.uid, s.user);
      if (account.disabled) { res.status(403).json({ error: 'This account is disabled' }); return null; }
      req.caller = { kind: 'user', uid: s.user.uid };
      return await store.spend(s.user.uid, limitsOf(account), { read });
    } catch (e) {
      warnOnce(`[auth] accounts store not reachable: ${e.message}`);
    }
  }
  if (s || fromThisSite(req)) {
    req.caller = { kind: 'anonymous', uid: s?.user.uid };
    return spendAnonymous(req.ip || req.socket.remoteAddress || '?', read);
  }
  res.status(401).json({ error: 'An API key is needed: sign up on /signup, then make a key on /account', signup: '/signup' });
  return null;
}

/**
 * Who may use the admin side: { user } for an admin's session, { local: true } with login off on this machine, else null.
 */
export async function adminOf(req, { config = authConfig(), verify = verifySession } = {}) {
  if (!config.enabled) return isLocal(req) ? { local: true } : null;
  const s = await sessionOf(req, verify);
  return s && isAdmin(s.claims) ? { user: s.user } : null;
}

export function gate({ config, verify = verifySession, accounts = appAccounts } = {}) {
  return async (req, res, next) => {
    const cfg = config || authConfig();
    const p = pathOf(req);
    try {
      // ---- the public API ----
      const api = publicApiOf(req) || (req.method === 'OPTIONS' && publicApiOf(req, req.headers['access-control-request-method'] || 'POST'));
      if (api) {
        res.set(CORS_HEADERS);
        if (req.method === 'OPTIONS') return res.sendStatus(204);
        if (!cfg.enabled) return next();
        const spent = await spendFor(req, res, { read: api[2], verify, accounts });
        if (!spent) return; // answered: 401 / 403 / 503
        spent.resetAt ||= nextUtcMidnight();
        rateHeaders(res, spent);
        if (!spent.ok) {
          const reads = api[2] && spent.used.reads >= spent.limits.reads;
          res.set('Retry-After', String(Math.max(1, Math.ceil((spent.resetAt - Date.now()) / 1000))));
          return res.status(429).json({
            error: req.caller?.kind === 'anonymous'
              ? (reads ? 'Too many files read from this address this hour: sign up for an account to read more' : 'Too many requests from this address this hour: sign up for an account to make more')
              : (reads ? 'The files this account may read today are used up (its plan\'s limit): it starts again at 00:00 UTC' : 'The requests this account may make today are used up (its plan\'s limit): it starts again at 00:00 UTC'),
            limit: reads ? spent.limits.reads : spent.limits.requests, kind: reads ? 'reads' : 'requests', resetAt: new Date(spent.resetAt).toISOString(),
          });
        }
        return next();
      }

      // ---- open: pages, assets, sign-in ----
      const isPage = methodIs(req, 'GET');
      const adminPage = isPage && isAdminPage(req);
      const accountPage = isPage && ACCOUNT_PAGES.includes(p);
      const accountApi = ACCOUNT_API.some(re => re.test(p));
      if (!adminPage && !accountPage && (!p.startsWith('/api/') || isOpenApi(req))) return next();

      // ---- an account's own pages and API ----
      if (accountPage || accountApi) {
        const s = cfg.enabled ? await sessionOf(req, verify) : null;
        if (s) { req.user = s.user; return next(); }
        if (accountPage) return res.redirect(302, `/login?next=${encodeURIComponent(req.originalUrl)}`);
        return res.status(cfg.enabled ? 401 : 403).json({ error: cfg.enabled ? 'Please sign in' : 'Login is not set up on this server', login: '/login' });
      }

      // ---- admin ----
      const who = await adminOf(req, { config: cfg, verify });
      if (who) { req.admin = who; return next(); }
      if (adminPage) return res.redirect(302, `/login?next=${encodeURIComponent(req.originalUrl)}`);
      return res.status(cfg.enabled ? 401 : 403).json({ error: cfg.enabled ? 'Please sign in as an admin' : 'Login is not set up on this server: the admin side only opens on its own machine', login: '/login' });
    } catch (e) {
      return next(e);
    }
  };
}

const router = Router();

router.get('/auth/config', (req, res) => res.json(authConfig()));

router.get('/auth/me', async (req, res, next) => {
  try {
    const cfg = authConfig();
    const s = cfg.enabled ? await sessionOf(req, verifySession) : null;
    res.json({ enabled: cfg.enabled, local: !cfg.enabled && isLocal(req), user: s?.user || null });
  } catch (e) { next(e); }
});

// a cookie readable only by the server, sent to this site only; Secure unless on this machine over http
const cookieOptions = (req) => ({ httpOnly: true, sameSite: 'lax', secure: !isLocal(req), path: '/' });

router.post('/auth/session', async (req, res) => {
  if (!authConfig().enabled) return res.status(400).json({ error: 'Login is not set up on this server' });
  const idToken = req.body?.idToken;
  if (typeof idToken !== 'string' || !idToken) return res.status(400).json({ error: 'idToken is missing' });
  try {
    const { cookie, user } = await createSession(idToken);
    // the account of the API (plan, keys) on its first sign-in; not reachable now: made on its first use instead
    await (await appAccounts()).ensureAccount(user.uid, user).catch((e) => console.warn(`[auth] account of ${user.email}: ${e.message}`));
    res.cookie(SESSION_COOKIE, cookie, { ...cookieOptions(req), maxAge: SESSION_DAYS * 86400_000 });
    res.json({ user });
  } catch (e) {
    if (!e.status) console.error('[auth]', e);
    res.status(e.status || 500).json({ error: e.status ? e.message : 'The sign-in did not work, please try again', code: e.code });
  }
});

router.post('/auth/logout', (req, res) => {
  forgetSession(sessionCookieOf(req));
  res.clearCookie(SESSION_COOKIE, cookieOptions(req));
  res.json({ ok: true });
});

export default router;
