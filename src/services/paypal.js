// PayPal REST API (subscriptions): the calls services/billing.js needs. The card numbers never reach this app: the
// buyer types them into PayPal's own window (the "Debit or Credit Card" button of PayPal's JS SDK on /pricing).
// .env: PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET (a REST app of developer.paypal.com), PAYPAL_ENV=sandbox|live
// (default sandbox), PAYPAL_WEBHOOK_ID (the webhook of that app that points at /api/billing/webhook).

const BASE = { sandbox: 'https://api-m.sandbox.paypal.com', live: 'https://api-m.paypal.com' };

export function paypalConfig(env = process.env) {
  const mode = env.PAYPAL_ENV === 'live' ? 'live' : 'sandbox';
  return { enabled: !!(env.PAYPAL_CLIENT_ID && env.PAYPAL_CLIENT_SECRET), mode, clientId: env.PAYPAL_CLIENT_ID || '', webhookId: env.PAYPAL_WEBHOOK_ID || '' };
}

export function createPaypal({ clientId = process.env.PAYPAL_CLIENT_ID, secret = process.env.PAYPAL_CLIENT_SECRET, mode = paypalConfig().mode, fetchImpl = fetch } = {}) {
  const base = BASE[mode];
  let token = null; // { value, until }

  async function accessToken() {
    if (token && token.until > Date.now()) return token.value;
    const r = await fetchImpl(`${base}/v1/oauth2/token`, {
      method: 'POST',
      headers: { authorization: `Basic ${Buffer.from(`${clientId}:${secret}`).toString('base64')}`, 'content-type': 'application/x-www-form-urlencoded' },
      body: 'grant_type=client_credentials',
      signal: AbortSignal.timeout(15000),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw Object.assign(new Error(`PayPal sign-in failed: ${d.error_description || r.status} (PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET, PAYPAL_ENV)`), { status: 502 });
    token = { value: d.access_token, until: Date.now() + (d.expires_in - 60) * 1000 };
    return token.value;
  }

  async function call(method, path, body, { prefer = 'return=representation', idempotencyKey } = {}) {
    const headers = { authorization: `Bearer ${await accessToken()}`, 'content-type': 'application/json', prefer };
    if (idempotencyKey) headers['paypal-request-id'] = idempotencyKey;
    const r = await fetchImpl(`${base}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(20000) });
    if (r.status === 204) return null;
    const d = await r.json().catch(() => ({}));
    if (!r.ok) {
      const detail = d.details?.map(x => x.description || x.issue).join('; ') || d.message || d.error_description || `HTTP ${r.status}`;
      throw Object.assign(new Error(`PayPal: ${detail}`), { status: r.status === 404 ? 404 : 502, paypal: d });
    }
    return d;
  }

  return {
    mode,
    getProduct: (id) => call('GET', `/v1/catalogs/products/${encodeURIComponent(id)}`).catch((e) => { if (e.status === 404) return null; throw e; }),
    createProduct: (p) => call('POST', '/v1/catalogs/products', p),
    listPlans: async (productId) => {
      const out = [];
      for (let page = 1; page <= 10; page++) {
        const d = await call('GET', `/v1/billing/plans?product_id=${encodeURIComponent(productId)}&page_size=20&page=${page}&total_required=true`);
        out.push(...(d.plans || []));
        if (page >= (d.total_pages || 1)) break;
      }
      return out;
    },
    getPlan: (id) => call('GET', `/v1/billing/plans/${encodeURIComponent(id)}`),
    createPlan: (p) => call('POST', '/v1/billing/plans', p),
    createSubscription: (s, idempotencyKey) => call('POST', '/v1/billing/subscriptions', s, { idempotencyKey }),
    getSubscription: (id) => call('GET', `/v1/billing/subscriptions/${encodeURIComponent(id)}`),
    cancelSubscription: (id, reason) => call('POST', `/v1/billing/subscriptions/${encodeURIComponent(id)}/cancel`, { reason: String(reason || 'Cancelled').slice(0, 127) }),
    listTransactions: (id, from, to) => call('GET', `/v1/billing/subscriptions/${encodeURIComponent(id)}/transactions?start_time=${encodeURIComponent(from)}&end_time=${encodeURIComponent(to)}`),
    refundSale: (saleId, idempotencyKey) => call('POST', `/v1/payments/sale/${encodeURIComponent(saleId)}/refund`, {}, { idempotencyKey }),
    /** true when PayPal signed this webhook event (its headers + the event as received). */
    async verifyWebhook(headers, event, webhookId) {
      const h = (k) => headers[k] || headers[k.toLowerCase()];
      const d = await call('POST', '/v1/notifications/verify-webhook-signature', {
        auth_algo: h('paypal-auth-algo'), cert_url: h('paypal-cert-url'), transmission_id: h('paypal-transmission-id'),
        transmission_sig: h('paypal-transmission-sig'), transmission_time: h('paypal-transmission-time'), webhook_id: webhookId, webhook_event: event,
      });
      return d?.verification_status === 'SUCCESS';
    },
  };
}
