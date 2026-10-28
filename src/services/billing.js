// Paid plans with PayPal subscriptions (services/paypal.js), and their invoices. In the app's database
// (services/accounts.js appStore), _id = the id:
//   subscriptions  {PayPal subscription id}  { uid, email, plan, interval, paypalPlanId, status, startedAt, nextBillingAt, cancelledAt, ... }
//   invoices       pp_{PayPal transaction id} { number: "RP-2026-0001", uid, email, name, plan, interval, amount, fee, net,
//                                              currency, status: paid | refunded | partially refunded, paidAt, periodStart, periodEnd, ... }
//   billingPlans   {sandbox|live}             { [offer key]: PayPal plan id }   (made once by ensurePlans)
//   webhookEvents  {PayPal event id}          { type, at }                       (each event handled once)
// A paid period (an invoice, or an ACTIVE subscription up to its next billing) moves the account to its plan until the
// period ends (+ GRACE_DAYS); a cancelled subscription keeps it until then. An admin's choice on /users (planSource
// "admin") is left alone. PayPal tells of payments by webhook (POST /api/billing/webhook); sync() asks it instead
// (activation, /account, the Sync button of /billing), so it also works without a public URL.
import { PLANS } from './plans.js';

export const PRODUCT_ID = 'ROSTERPARSER-API';
const GRACE_DAYS = 3;
const DAY = 86400_000;
const PAID = ['COMPLETED', 'PARTIALLY_REFUNDED', 'REFUNDED'];

/** The plans sold: [{ key: "pro-month", plan, label, interval, price, currency, requests, reads }]. */
export function catalog(plans = PLANS) {
  const out = [];
  for (const [plan, p] of Object.entries(plans)) {
    if (!p.prices) continue;
    for (const interval of ['month', 'year']) {
      if (Number(p.prices[interval]) > 0) out.push({ key: `${plan}-${interval}`, plan, label: p.label, interval, price: Number(p.prices[interval]), currency: p.prices.currency || 'USD', requests: p.requests, reads: p.reads });
    }
  }
  return out;
}

const money = (v) => Number(Number(v || 0).toFixed(2));
const addInterval = (iso, interval) => {
  const d = new Date(iso);
  if (interval === 'year') d.setUTCFullYear(d.getUTCFullYear() + 1); else d.setUTCMonth(d.getUTCMonth() + 1);
  return d.toISOString();
};
const fail = (status, message) => Object.assign(new Error(message), { status });

export function seller(env = process.env) {
  return { name: env.BILLING_SELLER_NAME || 'RosterParser', address: env.BILLING_SELLER_ADDRESS || '', email: env.BILLING_SELLER_EMAIL || '', taxId: env.BILLING_SELLER_TAX_ID || '' };
}

export function createBilling({ store, paypal, accounts, mode = paypal?.mode || 'sandbox', webhookId = '', now = () => Date.now(), plans = PLANS, sellerInfo = seller() }) {
  const offers = catalog(plans);
  let planIds = null; // offer key -> PayPal plan id
  const locks = new Map(); // one recordPayment / sync at a time per id

  async function locked(id, fn) {
    while (locks.has(id)) await locks.get(id).catch(() => {});
    const p = fn();
    locks.set(id, p);
    try { return await p; } finally { locks.delete(id); }
  }

  /** The PayPal product and one plan per offer, made the first time (and when a price changes: a new plan). */
  async function ensurePlans() {
    if (planIds) return planIds;
    const saved = (await store.get('billingPlans', mode)) || {};
    const nameOf = (o) => `RosterParser ${o.label} ${o.interval}ly ${o.price.toFixed(2)} ${o.currency}`;
    if (offers.every(o => saved[o.key]?.name === nameOf(o))) {
      planIds = Object.fromEntries(offers.map(o => [o.key, saved[o.key].id]));
      return planIds;
    }
    if (!(await paypal.getProduct(PRODUCT_ID))) {
      await paypal.createProduct({ id: PRODUCT_ID, name: 'RosterParser API', description: 'Roster reading API (rosters, ACARS, calendars)', type: 'SERVICE', category: 'SOFTWARE' });
    }
    const existing = (await paypal.listPlans(PRODUCT_ID)).filter(p => p.status === 'ACTIVE');
    const out = {};
    for (const o of offers) {
      const name = nameOf(o);
      let p = existing.find(x => x.name === name);
      if (!p) {
        p = await paypal.createPlan({
          product_id: PRODUCT_ID, name, status: 'ACTIVE', description: `${o.label}: ${o.requests} requests and ${o.reads} files a day`,
          billing_cycles: [{ frequency: { interval_unit: o.interval.toUpperCase(), interval_count: 1 }, tenure_type: 'REGULAR', sequence: 1, total_cycles: 0,
            pricing_scheme: { fixed_price: { value: o.price.toFixed(2), currency_code: o.currency } } }],
          payment_preferences: { auto_bill_outstanding: true, setup_fee_failure_action: 'CANCEL', payment_failure_threshold: 2 },
        });
      }
      out[o.key] = { id: p.id, name };
    }
    await store.set('billingPlans', mode, out);
    planIds = Object.fromEntries(Object.entries(out).map(([k, v]) => [k, v.id]));
    return planIds;
  }

  const offerOfPaypalPlan = async (paypalPlanId) => {
    const ids = await ensurePlans();
    return offers.find(o => ids[o.key] === paypalPlanId) || null;
  };

  /** A subscription for the account, waiting for the buyer's approval in PayPal's window: { id }. */
  async function start(user, { plan, interval }, { returnUrl, cancelUrl } = {}) {
    const offer = offers.find(o => o.plan === plan && o.interval === interval);
    if (!offer) throw fail(400, 'No such plan to buy');
    const mine = await store.where('subscriptions', 'uid', user.uid);
    if (mine.some(s => ['ACTIVE', 'SUSPENDED'].includes(s.status))) throw fail(409, 'You already have a subscription: change or cancel it on /account first');
    const ids = await ensurePlans();
    const s = await paypal.createSubscription({
      plan_id: ids[offer.key], custom_id: user.uid,
      subscriber: user.email ? { email_address: user.email } : undefined,
      application_context: { brand_name: sellerInfo.name.slice(0, 127), shipping_preference: 'NO_SHIPPING', user_action: 'SUBSCRIBE_NOW', return_url: returnUrl, cancel_url: cancelUrl },
    }, `sub-${user.uid}-${offer.key}-${Math.floor(now() / 60_000)}`);
    await store.set('subscriptions', s.id, { uid: user.uid, email: user.email || '', plan: offer.plan, interval: offer.interval, paypalPlanId: ids[offer.key], price: offer.price, currency: offer.currency, status: s.status || 'APPROVAL_PENDING', createdAt: new Date(now()).toISOString() });
    return { id: s.id };
  }

  /** The buyer approved it in PayPal's window: check it is theirs and active, then move the account to its plan. */
  async function activate(user, id) {
    const s = await store.get('subscriptions', id);
    if (!s || s.uid !== user.uid) throw fail(404, 'No such subscription');
    return sync(id);
  }

  /** Ask PayPal for a subscription and its payments; update it, its invoices and its account's plan. */
  function sync(id) {
    return locked(`sub:${id}`, async () => {
      const remote = await paypal.getSubscription(id);
      const uid = remote.custom_id;
      if (!uid) throw fail(400, 'This PayPal subscription is not one of this site');
      const local = (await store.get('subscriptions', id)) || {};
      if (local.uid && local.uid !== uid) throw fail(409, 'This subscription belongs to another account');
      const offer = await offerOfPaypalPlan(remote.plan_id);
      const account = (await accounts.getAccount(uid)) || {};
      const doc = {
        uid, email: local.email || remote.subscriber?.email_address || account.email || '', plan: offer?.plan || local.plan, interval: offer?.interval || local.interval,
        paypalPlanId: remote.plan_id, price: offer?.price ?? local.price, currency: offer?.currency || local.currency, status: remote.status,
        startedAt: remote.start_time || local.startedAt || null, nextBillingAt: remote.billing_info?.next_billing_time || null,
        failedPayments: remote.billing_info?.failed_payments_count || 0, payer: remote.subscriber?.email_address || '',
        cancelledAt: ['CANCELLED', 'EXPIRED'].includes(remote.status) ? (local.cancelledAt || remote.status_update_time || new Date(now()).toISOString()) : null,
        createdAt: local.createdAt || remote.create_time || new Date(now()).toISOString(), syncedAt: new Date(now()).toISOString(),
      };
      await store.set('subscriptions', id, doc);
      if (remote.start_time) {
        const from = new Date(Date.parse(remote.start_time) - DAY).toISOString();
        const list = await paypal.listTransactions(id, from, new Date(now()).toISOString()).catch((e) => { if (e.status === 404) return { transactions: [] }; throw e; });
        for (const tx of list.transactions || []) if (PAID.includes(tx.status)) await recordPayment(id, doc, tx);
      }
      await updatePlan(uid);
      return { id, ...doc };
    });
  }

  /** An invoice for a payment (once: its id is the PayPal transaction's), or its new state (refunded). */
  function recordPayment(subscriptionId, sub, tx) {
    const id = `pp_${tx.id}`;
    return locked(id, async () => {
      const status = tx.status === 'REFUNDED' ? 'refunded' : tx.status === 'PARTIALLY_REFUNDED' ? 'partially refunded' : 'paid';
      const old = await store.get('invoices', id);
      if (old) {
        if (old.status !== status && !(old.status === 'refunded' && status !== 'refunded')) await store.set('invoices', id, { status, ...(status !== 'paid' ? { refundedAt: old.refundedAt || new Date(now()).toISOString() } : {}) });
        return old.number;
      }
      const b = tx.amount_with_breakdown || {};
      const paidAt = tx.time || new Date(now()).toISOString();
      const year = new Date(paidAt).getUTCFullYear();
      const number = `RP-${year}-${String(await store.next(`invoice-${year}`)).padStart(4, '0')}`;
      const account = (await accounts.getAccount(sub.uid)) || {};
      const offerPlan = plans[sub.plan] || {};
      await store.set('invoices', id, {
        number, uid: sub.uid, email: account.email || sub.email || '', name: account.name || tx.payer_name?.given_name || '', payer: tx.payer_email || sub.payer || '',
        plan: sub.plan, label: offerPlan.label || sub.plan, interval: sub.interval,
        amount: money(b.gross_amount?.value), fee: money(b.fee_amount?.value), net: money(b.net_amount?.value ?? b.gross_amount?.value), currency: b.gross_amount?.currency_code || sub.currency || 'USD',
        status, paidAt, periodStart: paidAt, periodEnd: addInterval(paidAt, sub.interval), subscriptionId, transactionId: tx.id,
        seller: sellerInfo, createdAt: new Date(now()).toISOString(),
      });
      return number;
    });
  }

  /** The account's plan from what it paid: until the end of its last paid period (or its active subscription's next billing). */
  async function updatePlan(uid) {
    const account = (await accounts.getAccount(uid)) || {};
    if (account.planSource === 'admin') return;
    const subs = await store.where('subscriptions', 'uid', uid);
    const invoices = (await store.where('invoices', 'uid', uid)).filter(i => i.status === 'paid' || i.status === 'partially refunded');
    let until = 0;
    let plan = null;
    for (const i of invoices) if (Date.parse(i.periodEnd) > until) { until = Date.parse(i.periodEnd); plan = i.plan; }
    for (const s of subs) if (s.status === 'ACTIVE' && s.nextBillingAt && Date.parse(s.nextBillingAt) > until) { until = Date.parse(s.nextBillingAt); plan = s.plan; }
    if (!plan) {
      if (account.planSource === 'billing') await accounts.updateAccount(uid, { plan: 'free', planUntil: null, planSource: 'billing' });
      return;
    }
    await accounts.updateAccount(uid, { plan, planUntil: new Date(until + GRACE_DAYS * DAY).toISOString(), planSource: 'billing' });
  }

  async function cancel(id, reason, { uid } = {}) {
    const s = await store.get('subscriptions', id);
    if (!s || (uid && s.uid !== uid)) throw fail(404, 'No such subscription');
    if (['CANCELLED', 'EXPIRED'].includes(s.status)) return sync(id);
    if (s.status !== 'APPROVAL_PENDING') await paypal.cancelSubscription(id, reason);
    else await store.set('subscriptions', id, { status: 'CANCELLED', cancelledAt: new Date(now()).toISOString() });
    return s.status === 'APPROVAL_PENDING' ? { id, ...(await store.get('subscriptions', id)) } : sync(id);
  }

  /** Give back a payment in full (PayPal refunds the sale); the account keeps no paid period for it. */
  async function refund(invoiceId) {
    const inv = await store.get('invoices', invoiceId);
    if (!inv) throw fail(404, 'No such invoice');
    if (inv.status === 'refunded') throw fail(400, 'This invoice is refunded already');
    await paypal.refundSale(inv.transactionId, `refund-${invoiceId}`);
    await store.set('invoices', invoiceId, { status: 'refunded', refundedAt: new Date(now()).toISOString() });
    await updatePlan(inv.uid);
    return { id: invoiceId, ...(await store.get('invoices', invoiceId)) };
  }

  /** A webhook event of PayPal: checked with PayPal (its signature), handled once. */
  async function webhook(headers, event) {
    if (!webhookId) throw fail(400, 'PAYPAL_WEBHOOK_ID is not set');
    if (!event?.id || !(await paypal.verifyWebhook(headers, event, webhookId))) throw fail(400, 'Not a PayPal event of this site');
    if (await store.get('webhookEvents', event.id)) return { duplicate: true };
    const r = event.resource || {};
    let subscriptionId = null;
    if (event.resource_type === 'subscription') subscriptionId = r.id;
    else if (event.resource_type === 'sale') subscriptionId = r.billing_agreement_id;
    else if (event.resource_type === 'refund' && r.sale_id) subscriptionId = (await store.get('invoices', `pp_${r.sale_id}`))?.subscriptionId;
    if (subscriptionId) await sync(subscriptionId).catch((e) => { if (e.status !== 400) throw e; }); // not one of this site: ignored
    await store.set('webhookEvents', event.id, { type: event.event_type, at: new Date(now()).toISOString() });
    return { handled: !!subscriptionId };
  }

  const byNewest = (a, b, f) => String(b[f] || '').localeCompare(String(a[f] || ''));

  /** An account's own: its subscriptions and invoices, newest first (the open ones synced with PayPal first). */
  async function mine(uid, { refresh = false } = {}) {
    let subs = await store.where('subscriptions', 'uid', uid);
    if (refresh) {
      for (const s of subs.filter(x => !['CANCELLED', 'EXPIRED'].includes(x.status))) await sync(s.id).catch(() => {});
      subs = await store.where('subscriptions', 'uid', uid);
    }
    const invoices = await store.where('invoices', 'uid', uid);
    return { subscriptions: subs.sort((a, b) => byNewest(a, b, 'createdAt')), invoices: invoices.sort((a, b) => byNewest(a, b, 'paidAt')) };
  }

  async function invoice(numberOrId) {
    const byId = await store.get('invoices', numberOrId);
    if (byId) return { id: numberOrId, ...byId };
    return (await store.where('invoices', 'number', numberOrId))[0] || null;
  }

  /** Everything, for /billing: subscriptions, invoices and their sums. */
  async function overview() {
    const [subs, invoices] = await Promise.all([store.all('subscriptions'), store.all('invoices')]);
    const monthly = (s) => (s.interval === 'year' ? s.price / 12 : s.price) || 0;
    const active = subs.filter(s => s.status === 'ACTIVE');
    const byMonth = {};
    for (const i of invoices) {
      const m = String(i.paidAt).slice(0, 7);
      const t = (byMonth[`${m}|${i.currency}`] ||= { month: m, currency: i.currency, paid: 0, refunded: 0, net: 0, count: 0 });
      t.count += 1;
      if (i.status === 'refunded') t.refunded = money(t.refunded + i.amount);
      else { t.paid = money(t.paid + i.amount); t.net = money(t.net + i.net); }
    }
    return {
      mode, offers,
      subscriptions: subs.sort((a, b) => byNewest(a, b, 'createdAt')),
      invoices: invoices.sort((a, b) => byNewest(a, b, 'paidAt')),
      summary: {
        active: active.length, mrr: money(active.reduce((n, s) => n + monthly(s), 0)), currency: offers[0]?.currency || 'USD',
        months: Object.values(byMonth).sort((a, b) => b.month.localeCompare(a.month)),
      },
    };
  }

  return { offers, ensurePlans, start, activate, sync, cancel, refund, webhook, mine, invoice, overview, updatePlan };
}
