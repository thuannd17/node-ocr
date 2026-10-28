// /routes/billing-api.js — paid plans with PayPal (services/billing.js). The gate (routes/auth-api.js) lets through:
//   open      GET  /api/billing/config                    the plans sold, PayPal's client id (/pricing)
//             POST /api/billing/webhook                   PayPal's events (checked with PayPal)
//   account   GET  /api/billing/me[?refresh=1]            its plan, subscriptions, invoices (refresh: asked to PayPal first)
//             POST /api/billing/subscriptions             { plan, interval } -> { id } for PayPal's button
//             POST /api/billing/subscriptions/:id/activate   after the buyer approved it
//             POST /api/billing/subscriptions/:id/cancel     { reason }
//             GET  /api/billing/invoices/:id              one invoice (its account's, or any for an admin)
//   admin     GET  /api/billing/admin/overview            every subscription and invoice, sums
//             GET  /api/billing/admin/invoices.csv
//             POST /api/billing/admin/subscriptions/:id/sync | /cancel
//             POST /api/billing/admin/invoices/:id/refund
import { Router } from 'express';
import { appStore, accounts as appAccounts } from '../services/accounts.js';
import { createBilling, catalog } from '../services/billing.js';
import { createPaypal, paypalConfig } from '../services/paypal.js';
import { planOf, PLANS } from '../services/plans.js';

// Without PayPal's keys the invoices and subscriptions kept stay readable; only the calls to PayPal answer 503
const noPaypal = new Proxy({ mode: paypalConfig().mode }, {
  get: (target, k) => (k in target ? target[k] : async () => { throw Object.assign(new Error('Payments are not set up on this server yet'), { status: 503 }); }),
});

let shared = null;
async function appBilling() {
  if (!shared) {
    const cfg = paypalConfig();
    const [store, accounts] = await Promise.all([appStore(), appAccounts()]);
    shared ||= createBilling({ store, accounts, paypal: cfg.enabled ? createPaypal() : noPaypal, webhookId: cfg.webhookId });
  }
  return shared;
}

const csvCell = (v) => { const s = String(v ?? ''); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };

export function billingRouter({ billing = appBilling, accounts = appAccounts, config = paypalConfig } = {}) {
  const router = Router();
  const wrap = (fn) => async (req, res) => {
    try {
      const out = await fn(req, res);
      if (out !== undefined) res.json(out);
    } catch (e) {
      const store = /^Mongo/.test(e.name || '') || /MONGODB_URI/.test(e.message || '');
      if (!e.status && !store) console.error('[billing]', e);
      if (store) return res.status(503).json({ error: 'The accounts database cannot be reached right now, please try again later' });
      res.status(e.status || 500).json({ error: e.status ? e.message : 'Something went wrong, please try again' });
    }
  };
  const origin = (req) => `${req.protocol}://${req.get('host')}`;

  router.get('/billing/config', (req, res) => {
    const c = config();
    res.json({ enabled: c.enabled, mode: c.mode, clientId: c.clientId, offers: catalog(), free: { label: PLANS.free.label, requests: PLANS.free.requests, reads: PLANS.free.reads } });
  });

  router.post('/billing/webhook', wrap(async (req) => {
    const event = req.rawBody ? JSON.parse(req.rawBody) : req.body;
    return (await billing()).webhook(req.headers, event);
  }));

  // ---- an account's own ----
  router.get('/billing/me', wrap(async (req) => {
    const account = (await (await accounts()).ensureAccount(req.user.uid, req.user)) || {};
    const own = await (await billing()).mine(req.user.uid, { refresh: config().enabled && req.query.refresh === '1' });
    const fresh = req.query.refresh === '1' ? ((await (await accounts()).getAccount(req.user.uid)) || account) : account;
    return { enabled: config().enabled, plan: planOf(fresh), planUntil: fresh.planUntil || null, planSource: fresh.planSource || null, ...own };
  }));

  router.post('/billing/subscriptions', wrap(async (req) => {
    const { plan, interval } = req.body || {};
    return (await billing()).start(req.user, { plan, interval }, { returnUrl: `${origin(req)}/account?subscribed=1`, cancelUrl: `${origin(req)}/pricing` });
  }));

  router.post('/billing/subscriptions/:id/activate', wrap(async (req) => (await billing()).activate(req.user, req.params.id)));

  router.post('/billing/subscriptions/:id/cancel', wrap(async (req) => (await billing()).cancel(req.params.id, req.body?.reason || 'Cancelled by the customer', { uid: req.user.uid })));

  router.get('/billing/invoices/:id', wrap(async (req) => {
    const inv = await (await billing()).invoice(req.params.id);
    if (!inv || (inv.uid !== req.user.uid && req.user.role !== 'admin')) throw Object.assign(new Error('No such invoice'), { status: 404 });
    return inv;
  }));

  // ---- admin ----
  router.get('/billing/admin/overview', wrap(async () => (await billing()).overview()));

  router.get('/billing/admin/invoices.csv', wrap(async (req, res) => {
    const { invoices } = await (await billing()).overview();
    const month = String(req.query.month || '');
    const cols = ['number', 'paidAt', 'email', 'name', 'plan', 'interval', 'amount', 'fee', 'net', 'currency', 'status', 'periodStart', 'periodEnd', 'subscriptionId', 'transactionId'];
    const rows = invoices.filter(i => !month || String(i.paidAt).startsWith(month));
    res.set('Content-Type', 'text/csv; charset=utf-8').set('Content-Disposition', `attachment; filename="invoices${month ? `-${month}` : ''}.csv"`);
    res.send(`﻿${[cols.join(','), ...rows.map(i => cols.map(c => csvCell(i[c])).join(','))].join('\r\n')}\r\n`);
  }));

  router.post('/billing/admin/subscriptions/:id/sync', wrap(async (req) => (await billing()).sync(req.params.id)));
  router.post('/billing/admin/subscriptions/:id/cancel', wrap(async (req) => (await billing()).cancel(req.params.id, req.body?.reason || 'Cancelled by an admin')));
  router.post('/billing/admin/invoices/:id/refund', wrap(async (req) => (await billing()).refund(req.params.id)));

  return router;
}

export default billingRouter();
