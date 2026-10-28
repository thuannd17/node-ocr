// /routes/account-api.js — an account's own API data (/account) and the accounts of everyone (/users, admin).
// The gate (routes/auth-api.js) lets /api/account/* through for a signed-in account (req.user), /api/users/* for admins.
//   GET    /api/account               the account: user, plan, limits, today's calls
//   PATCH  /api/account               { name }
//   DELETE /api/account               delete the account, its keys and its sign-in (not for admins)
//   GET    /api/account/keys          its API keys (hint, name, created, last used; never the key)
//   POST   /api/account/keys          { name } -> { key } shown once
//   DELETE /api/account/keys/:id
//   GET    /api/users                 every account (Firebase Authentication + plan, keys, today's calls)
//   PATCH  /api/users/:uid            { role: user|admin, plan, limits: { requests, reads } | null, disabled }
//   DELETE /api/users/:uid/keys       revoke all its keys
//   DELETE /api/users/:uid            delete the account
import { Router } from 'express';
import { accounts as appAccounts } from '../services/accounts.js';
import { PLANS, ANONYMOUS, limitsOf, dayOf } from '../services/plans.js';
import * as authService from '../services/auth.js';

export const MAX_KEYS = 10;
const fail = (status, message) => Object.assign(new Error(message), { status });

export function accountRouter({ accounts = appAccounts, auth = authService } = {}) {
  const router = Router();
  const wrap = (fn) => async (req, res) => {
    try {
      res.json(await fn(req, res));
    } catch (e) {
      // MongoDB not reachable or not set up (MongoServerSelectionError, MongoNetworkError, no MONGODB_URI)
      const store = /^Mongo/.test(e.name || '') || /MONGODB_URI/.test(e.message || '');
      if (!e.status) console.error('[account]', store ? e.message : e);
      if (store) return res.status(503).json({ error: 'The accounts database cannot be reached right now, please try again later' });
      res.status(e.status || 500).json({ error: e.status ? e.message : 'Something went wrong, please try again' });
    }
  };
  // an account with a running PayPal subscription is not deleted (PayPal would go on charging it)
  const stillPaying = async (uid, message) => {
    const subs = (await (await accounts()).subscriptionsOf?.(uid)) || [];
    if (subs.some(s => ['ACTIVE', 'SUSPENDED'].includes(s.status))) throw fail(409, message);
  };
  const plans = () => Object.entries(PLANS).map(([id, p]) => ({ id, label: p.label, requests: p.requests, reads: p.reads }));

  router.get('/account', wrap(async (req) => {
    const store = await accounts();
    const account = await store.ensureAccount(req.user.uid, req.user);
    const limits = req.user.role === 'admin' ? { ...limitsOf(account), requests: null, reads: null } : limitsOf(account);
    return { user: req.user, account: { plan: limits.plan, createdAt: account.createdAt }, limits, usage: await store.usageOf(req.user.uid), day: dayOf(), plans: plans(), anonymous: ANONYMOUS, maxKeys: MAX_KEYS };
  }));

  router.patch('/account', wrap(async (req) => {
    const name = String(req.body?.name ?? '').trim().slice(0, 80);
    await auth.setDisplayName(req.user.uid, name);
    await (await accounts()).updateAccount(req.user.uid, { name });
    return { ok: true, name };
  }));

  router.delete('/account', wrap(async (req, res) => {
    if (req.user.role === 'admin') throw fail(400, 'An admin account cannot be deleted here: ask another admin, or remove it from ADMIN_EMAILS first');
    await stillPaying(req.user.uid, 'Cancel your subscription first (Subscription, above): PayPal would go on charging it');
    await (await accounts()).deleteAccount(req.user.uid);
    await auth.deleteUser(req.user.uid);
    res.clearCookie(auth.SESSION_COOKIE, { path: '/' });
    return { ok: true };
  }));

  router.get('/account/keys', wrap(async (req) => ({ keys: await (await accounts()).listKeys(req.user.uid), maxKeys: MAX_KEYS })));

  router.post('/account/keys', wrap(async (req) => {
    const store = await accounts();
    await store.ensureAccount(req.user.uid, req.user);
    if ((await store.listKeys(req.user.uid)).length >= MAX_KEYS) throw fail(400, `An account can have ${MAX_KEYS} API keys: revoke one first`);
    const created = await store.createKey(req.user.uid, req.body?.name);
    return { key: created.key, id: created.id, name: created.name, hint: created.hint, createdAt: created.createdAt };
  }));

  router.delete('/account/keys/:id', wrap(async (req) => {
    if (!(await (await accounts()).revokeKey(req.user.uid, req.params.id))) throw fail(404, 'No such API key');
    return { ok: true };
  }));

  // ---- admin ----
  router.get('/users', wrap(async () => {
    const store = await accounts();
    const [users, list, keys, usage] = await Promise.all([auth.listUsers(), store.listAccounts(), store.countKeys(), store.usageOfDay()]);
    // an account disabled (or enabled) in the Firebase console: its keys follow (the gate reads the account's copy)
    for (const u of users) {
      const a = list.get(u.uid);
      if (a && !!a.disabled !== u.disabled) await store.updateAccount(u.uid, { disabled: u.disabled });
      else if (!a && u.disabled) await store.updateAccount(u.uid, { disabled: true });
    }
    return {
      day: dayOf(), plans: plans(),
      users: users.map((u) => {
        const a = list.get(u.uid) || {};
        return { ...u, plan: limitsOf(a).plan, planSource: a.planSource || null, planUntil: a.planUntil || null, limits: a.limits || null, effective: limitsOf(a), keys: keys.get(u.uid) || 0, usage: usage.get(u.uid) || { requests: 0, reads: 0 } };
      }).sort((a, b) => Date.parse(b.created) - Date.parse(a.created)),
    };
  }));

  router.patch('/users/:uid', wrap(async (req) => {
    const { uid } = req.params;
    const self = req.admin?.user?.uid === uid;
    const body = req.body || {};
    const store = await accounts();
    const users = await auth.listUsers();
    const u = users.find(x => x.uid === uid);
    if (!u) throw fail(404, 'No such account');
    if ('role' in body) {
      if (!['user', 'admin'].includes(body.role)) throw fail(400, 'role is user or admin');
      if (u.roleFixed && body.role !== 'admin') throw fail(400, 'This account is an admin by ADMIN_EMAILS: remove it there to change its role');
      if (self && body.role !== 'admin') throw fail(400, 'You cannot take away your own admin role');
      if (body.role !== u.role) await auth.setAdmin(uid, body.role === 'admin');
    }
    if ('plan' in body) {
      // an admin's plan has no end and payments leave it alone; "auto": the plan follows the payments again
      if (body.plan === 'auto') await store.updateAccount(uid, { planSource: null });
      else if (!PLANS[body.plan]) throw fail(400, 'No such plan');
      else await store.updateAccount(uid, { plan: body.plan, planUntil: null, planSource: 'admin' });
    }
    if ('limits' in body) {
      const l = body.limits;
      const num = (v) => (v === '' || v == null ? undefined : Number(v));
      const limits = l ? { requests: num(l.requests), reads: num(l.reads) } : null;
      if (limits && Object.values(limits).some(v => v !== undefined && !(Number.isInteger(v) && v >= 0))) throw fail(400, 'Limits are whole numbers from 0');
      // null first: a merge would keep an old limit the new ones leave out
      await store.updateAccount(uid, { limits: null });
      const own = limits && Object.fromEntries(Object.entries(limits).filter(([, v]) => v !== undefined));
      if (own && Object.keys(own).length) await store.updateAccount(uid, { limits: own });
    }
    if ('disabled' in body) {
      if (self) throw fail(400, 'You cannot disable your own account');
      await auth.setDisabled(uid, !!body.disabled);
      await store.updateAccount(uid, { disabled: !!body.disabled });
    }
    return { ok: true };
  }));

  router.delete('/users/:uid/keys', wrap(async (req) => ({ revoked: await (await accounts()).revokeAllKeys(req.params.uid) })));

  router.delete('/users/:uid', wrap(async (req) => {
    if (req.admin?.user?.uid === req.params.uid) throw fail(400, 'You cannot delete your own account here');
    await stillPaying(req.params.uid, 'This account has a subscription that is still running: cancel it on /billing first');
    await (await accounts()).deleteAccount(req.params.uid);
    await auth.deleteUser(req.params.uid);
    return { ok: true };
  }));

  return router;
}

export default accountRouter();
