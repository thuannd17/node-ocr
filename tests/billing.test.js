import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createBilling, catalog } from '../src/services/billing.js';
import { createAccounts, memoryStore } from '../src/services/accounts.js';
import { limitsOf, planOf } from '../src/services/plans.js';
import { gate } from '../src/routes/auth-api.js';
import { billingRouter } from '../src/routes/billing-api.js';

// A PayPal with the calls billing.js makes; `remote` holds its subscriptions, `tx` their transactions.
function fakePaypal() {
  const p = { mode: 'sandbox', products: new Map(), plans: [], remote: new Map(), tx: new Map(), cancelled: [], refunded: [], calls: { createPlan: 0 }, verify: true };
  Object.assign(p, {
    getProduct: async (id) => p.products.get(id) || null,
    createProduct: async (x) => { p.products.set(x.id, x); return x; },
    listPlans: async () => p.plans,
    createPlan: async (x) => { p.calls.createPlan++; const plan = { ...x, id: `P-${p.plans.length + 1}` }; p.plans.push(plan); return plan; },
    createSubscription: async (s) => {
      const id = `I-${p.remote.size + 1}`;
      p.remote.set(id, { id, status: 'APPROVAL_PENDING', plan_id: s.plan_id, custom_id: s.custom_id, subscriber: s.subscriber });
      return { id, status: 'APPROVAL_PENDING' };
    },
    getSubscription: async (id) => { const s = p.remote.get(id); if (!s) throw Object.assign(new Error('not found'), { status: 404 }); return structuredClone(s); },
    cancelSubscription: async (id) => { p.cancelled.push(id); p.remote.get(id).status = 'CANCELLED'; },
    listTransactions: async (id) => ({ transactions: structuredClone(p.tx.get(id) || []) }),
    refundSale: async (id) => { p.refunded.push(id); },
    verifyWebhook: async () => p.verify,
  });
  return p;
}
const sale = (id, time, value = '9.00') => ({ id, status: 'COMPLETED', time, amount_with_breakdown: { gross_amount: { currency_code: 'USD', value }, fee_amount: { currency_code: 'USD', value: '0.61' }, net_amount: { currency_code: 'USD', value: String(Number(value) - 0.61) } } });

function setup() {
  let t = Date.parse('2026-10-26T08:00:00Z');
  const now = () => t;
  const store = memoryStore();
  const accounts = createAccounts(store, { now });
  const paypal = fakePaypal();
  const billing = createBilling({ store, paypal, accounts, webhookId: 'WH-1', now, sellerInfo: { name: 'RosterParser', address: '', email: '', taxId: '' } });
  return { store, accounts, paypal, billing, now, tick: (ms) => { t += ms; }, at: (iso) => { t = Date.parse(iso); } };
}
const user = { uid: 'u1', email: 'dev@example.com', name: 'Dev' };

test('the plans sold: Pro a month and a year', () => {
  assert.deepEqual(catalog().map(o => [o.key, o.price, o.currency]), [['pro-month', 9, 'USD'], ['pro-year', 90, 'USD']]);
});

test('PayPal plans are made once, then reused', async () => {
  const s = setup();
  const ids = await s.billing.ensurePlans();
  assert.deepEqual(Object.keys(ids), ['pro-month', 'pro-year']);
  assert.equal(s.paypal.calls.createPlan, 2);
  assert.equal(s.paypal.plans[0].billing_cycles[0].pricing_scheme.fixed_price.value, '9.00');
  assert.equal(s.paypal.plans[1].billing_cycles[0].frequency.interval_unit, 'YEAR');
  const again = createBilling({ store: s.store, paypal: s.paypal, accounts: s.accounts });
  assert.deepEqual(await again.ensurePlans(), ids);
  assert.equal(s.paypal.calls.createPlan, 2);
});

test('subscribe, pay, renew, cancel: the account is Pro until the paid period ends; one invoice per payment', async () => {
  const s = setup();
  await s.accounts.ensureAccount('u1', user);
  const { id } = await s.billing.start(user, { plan: 'pro', interval: 'month' });
  assert.equal(s.paypal.remote.get(id).custom_id, 'u1');
  await assert.rejects(s.billing.start(user, { plan: 'gold', interval: 'month' }), /No such plan/);
  // approved in PayPal's window and paid
  Object.assign(s.paypal.remote.get(id), { status: 'ACTIVE', start_time: '2026-10-26T08:00:00Z', billing_info: { next_billing_time: '2026-11-26T10:00:00Z' } });
  s.paypal.tx.set(id, [sale('S-1', '2026-10-26T08:01:00Z')]);
  await assert.rejects(s.billing.activate({ uid: 'other' }, id), /No such subscription/);
  const sub = await s.billing.activate(user, id);
  assert.equal(sub.status, 'ACTIVE');
  let a = await s.accounts.getAccount('u1');
  assert.equal(a.plan, 'pro');
  assert.equal(a.planUntil, '2026-11-29T10:00:00.000Z'); // the next billing + 3 days
  assert.equal(limitsOf(a, s.now()).requests, 20000);
  await assert.rejects(s.billing.start(user, { plan: 'pro', interval: 'year' }), /already have a subscription/);
  // synced again: no second invoice
  await s.billing.sync(id);
  let mine = await s.billing.mine('u1');
  assert.deepEqual(mine.invoices.map(i => [i.number, i.amount, i.fee, i.status, i.periodEnd]), [['RP-2026-0001', 9, 0.61, 'paid', '2026-11-26T08:01:00.000Z']]);
  // renewed a month later
  s.at('2026-11-26T10:05:00Z');
  s.paypal.remote.get(id).billing_info.next_billing_time = '2026-12-26T10:00:00Z';
  s.paypal.tx.get(id).push(sale('S-2', '2026-11-26T10:00:00Z'));
  await s.billing.sync(id);
  mine = await s.billing.mine('u1');
  assert.deepEqual(mine.invoices.map(i => i.number), ['RP-2026-0002', 'RP-2026-0001']);
  // cancelled: Pro until the last paid period ends (+3 days), then Free
  await s.billing.cancel(id, 'too expensive', { uid: 'u1' });
  assert.deepEqual(s.paypal.cancelled, [id]);
  a = await s.accounts.getAccount('u1');
  assert.equal(a.planUntil, '2026-12-29T10:00:00.000Z');
  assert.equal(planOf(a, Date.parse('2026-12-20T00:00:00Z')), 'pro');
  assert.equal(planOf(a, Date.parse('2026-12-30T00:00:00Z')), 'free');
  assert.equal((await s.billing.mine('u1')).subscriptions[0].status, 'CANCELLED');
});

test('a refund: the invoice is refunded and its period no longer counts', async () => {
  const s = setup();
  const { id } = await s.billing.start(user, { plan: 'pro', interval: 'year' });
  Object.assign(s.paypal.remote.get(id), { status: 'CANCELLED', start_time: '2026-10-26T08:00:00Z', billing_info: {} });
  s.paypal.tx.set(id, [sale('S-9', '2026-10-26T08:01:00Z', '90.00')]);
  await s.billing.sync(id);
  assert.equal((await s.accounts.getAccount('u1')).plan, 'pro');
  const [inv] = (await s.billing.mine('u1')).invoices;
  assert.equal(inv.periodEnd, '2027-10-26T08:01:00.000Z');
  const r = await s.billing.refund(inv.id);
  assert.deepEqual(s.paypal.refunded, ['S-9']);
  assert.equal(r.status, 'refunded');
  assert.equal((await s.accounts.getAccount('u1')).plan, 'free');
  await assert.rejects(s.billing.refund(inv.id), /refunded already/);
  // PayPal still says COMPLETED for a while: the refund stays
  await s.billing.sync(id);
  assert.equal((await s.billing.invoice(inv.number)).status, 'refunded');
});

test('an admin\'s plan on /users is left alone by the payments', async () => {
  const s = setup();
  await s.accounts.updateAccount('u1', { plan: 'free', planSource: 'admin' });
  const { id } = await s.billing.start(user, { plan: 'pro', interval: 'month' });
  Object.assign(s.paypal.remote.get(id), { status: 'ACTIVE', start_time: '2026-10-26T08:00:00Z', billing_info: { next_billing_time: '2026-11-26T08:00:00Z' } });
  await s.billing.sync(id);
  assert.equal((await s.accounts.getAccount('u1')).plan, 'free');
});

test('webhooks: checked with PayPal, a sale syncs its subscription, each event once', async () => {
  const s = setup();
  const { id } = await s.billing.start(user, { plan: 'pro', interval: 'month' });
  Object.assign(s.paypal.remote.get(id), { status: 'ACTIVE', start_time: '2026-10-26T08:00:00Z', billing_info: { next_billing_time: '2026-11-26T08:00:00Z' } });
  s.paypal.tx.set(id, [sale('S-5', '2026-10-26T08:01:00Z')]);
  const event = { id: 'WH-EV-1', event_type: 'PAYMENT.SALE.COMPLETED', resource_type: 'sale', resource: { id: 'S-5', billing_agreement_id: id } };
  s.paypal.verify = false;
  await assert.rejects(s.billing.webhook({}, event), /Not a PayPal event/);
  s.paypal.verify = true;
  assert.deepEqual(await s.billing.webhook({}, event), { handled: true });
  assert.equal((await s.billing.mine('u1')).invoices.length, 1);
  assert.deepEqual(await s.billing.webhook({}, event), { duplicate: true });
  // a subscription of another site (no custom_id): ignored, not an error
  s.paypal.remote.set('I-X', { id: 'I-X', status: 'ACTIVE' });
  assert.deepEqual(await s.billing.webhook({}, { id: 'WH-EV-2', resource_type: 'subscription', resource: { id: 'I-X' } }), { handled: true });
});

test('routes: config and webhook open, the own billing needs a sign-in, admin billing an admin; invoices only the own', async () => {
  const s = setup();
  const CLAIMS = { admin: { uid: 'a1', email: 'boss@example.com', email_verified: true, admin: true }, user: { uid: 'u1', email: 'dev@example.com', email_verified: true }, other: { uid: 'u2', email: 'x@example.com', email_verified: true } };
  const app = express();
  app.use(express.json());
  app.use(gate({ config: { enabled: true }, verify: async (c) => CLAIMS[c] || null, accounts: async () => s.accounts }));
  app.use('/api', billingRouter({ billing: async () => s.billing, accounts: async () => s.accounts, config: () => ({ enabled: true, mode: 'sandbox', clientId: 'client' }) }));
  const server = app.listen(0);
  await new Promise(r => server.once('listening', r));
  const base = `http://localhost:${server.address().port}`;
  const call = (path, { method = 'GET', session, body } = {}) => fetch(base + path, { method, headers: { ...(session ? { cookie: `__session=${session}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}) }, body: body && JSON.stringify(body) });
  try {
    const cfg = await (await call('/api/billing/config')).json();
    assert.equal(cfg.clientId, 'client');
    assert.equal(cfg.offers.length, 2);
    assert.equal((await call('/api/billing/me')).status, 401);
    assert.equal((await call('/api/billing/admin/overview', { session: 'user' })).status, 401);
    const { id } = await (await call('/api/billing/subscriptions', { method: 'POST', session: 'user', body: { plan: 'pro', interval: 'month' } })).json();
    Object.assign(s.paypal.remote.get(id), { status: 'ACTIVE', start_time: '2026-10-26T08:00:00Z', billing_info: { next_billing_time: '2026-11-26T08:00:00Z' } });
    s.paypal.tx.set(id, [sale('S-7', '2026-10-26T08:01:00Z')]);
    assert.equal((await call(`/api/billing/subscriptions/${id}/activate`, { method: 'POST', session: 'other' })).status, 404);
    assert.equal((await (await call(`/api/billing/subscriptions/${id}/activate`, { method: 'POST', session: 'user' })).json()).status, 'ACTIVE');
    const me = await (await call('/api/billing/me', { session: 'user' })).json();
    assert.equal(me.plan, 'pro');
    assert.equal(me.invoices[0].number, 'RP-2026-0001');
    assert.equal((await call('/api/billing/invoices/RP-2026-0001', { session: 'user' })).status, 200);
    assert.equal((await call('/api/billing/invoices/RP-2026-0001', { session: 'other' })).status, 404);
    assert.equal((await call('/api/billing/invoices/RP-2026-0001', { session: 'admin' })).status, 200);
    const ov = await (await call('/api/billing/admin/overview', { session: 'admin' })).json();
    assert.deepEqual([ov.summary.active, ov.summary.mrr], [1, 9]);
    assert.deepEqual(ov.summary.months.map(m => [m.month, m.paid, m.count]), [['2026-10', 9, 1]]);
    const csv = await (await call('/api/billing/admin/invoices.csv?month=2026-10', { session: 'admin' })).text();
    assert.match(csv, /^\uFEFF?number,paidAt,email/); // fetch's text() drops the BOM the server sends for Excel
    assert.match(csv, /RP-2026-0001,2026-10-26T08:01:00Z,dev@example.com/);
    s.paypal.verify = false; // not signed by PayPal
    assert.equal((await call('/api/billing/webhook', { method: 'POST', body: { id: 'E' } })).status, 400);
  } finally { server.close(); }
});
