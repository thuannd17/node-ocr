// The API plans: how many calls a day an account may make with its API keys (or signed in on the site).
//   requests: every call of the public API (docs/openapi.json); reads: the calls that read a file with the AI model
//   (a roster, an ACARS picture: the OCR server's GPU), counted in requests too.
//   prices: what a paid plan costs a month / a year (PayPal subscriptions: services/billing.js); a plan without
//   prices is not sold (Free; or given by an admin on /users).
// A paid plan holds until account.planUntil (the end of the period paid for); an admin's choice has no end.
// API_PLANS in .env (JSON) replaces these, e.g. {"free":{"label":"Free","requests":500,"reads":20},...}.
// Visitors of the site who are not signed in have the per-IP limits of ANONYMOUS, per hour.

const DEFAULT_PLANS = {
  free: { label: 'Free', requests: 1000, reads: 50 },
  pro: { label: 'Pro', requests: 20000, reads: 2000, prices: { currency: 'USD', month: 9, year: 90 } },
};
export const ANONYMOUS = { label: 'Not signed in', requests: 300, reads: 20, per: 'hour' };
export const DEFAULT_PLAN = 'free';

function loadPlans(env = process.env) {
  if (!env.API_PLANS) return DEFAULT_PLANS;
  try {
    const plans = JSON.parse(env.API_PLANS);
    if (plans && typeof plans === 'object' && plans[DEFAULT_PLAN]) return plans;
    console.warn(`[plans] API_PLANS has no "${DEFAULT_PLAN}" plan: using the default plans`);
  } catch (e) {
    console.warn(`[plans] API_PLANS is not JSON (${e.message}): using the default plans`);
  }
  return DEFAULT_PLANS;
}

export const PLANS = loadPlans();

/** The plan an account has now: its plan until planUntil (a paid period), then Free. */
export function planOf(account, now = Date.now()) {
  if (!PLANS[account?.plan]) return DEFAULT_PLAN;
  if (account.planUntil && Date.parse(account.planUntil) < now) return DEFAULT_PLAN;
  return account.plan;
}

/** The limits of an account: its plan's, with the ones an admin set for it on top. */
export function limitsOf(account, now = Date.now()) {
  const plan = planOf(account, now);
  const base = PLANS[plan];
  const own = account?.limits || {};
  const num = (v, d) => (Number.isFinite(v) && v >= 0 ? v : d);
  return { plan, label: base.label, requests: num(own.requests, base.requests), reads: num(own.reads, base.reads), per: 'day' };
}

/** "2026-10-25": a day of usage, in UTC (the limits start again at 00:00 UTC). */
export const dayOf = (t = Date.now()) => new Date(t).toISOString().slice(0, 10);
