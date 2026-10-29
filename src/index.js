// /index.js — Entry point: setup express + mount routers
import express from 'express';

import viewsRouter from './routes/views.js';
import apiRouter from './routes/api.js';
import pdfApiRouter from './routes/pdf-api.js';
import modelsApiRouter from './routes/models-api.js';
import airportsApiRouter from './routes/airports-api.js';
import toolsApiRouter from './routes/tools-api.js';
import rosterApiRouter from './routes/roster-api.js';
import suggestionsApiRouter from './routes/suggestions-api.js';
import mediaApiRouter from './routes/media-api.js';
import dashboardApiRouter from './routes/dashboard-api.js';
import jobsApiRouter from './routes/jobs-api.js';
import acarsApiRouter from './routes/acars-api.js';
import authApiRouter, { gate } from './routes/auth-api.js';
import accountApiRouter from './routes/account-api.js';
import billingApiRouter from './routes/billing-api.js';
import { flushUsage } from './services/accounts.js';
import { syncMedia, acars } from './services/media-client.js';
import { syncModels } from './services/ai-models.js';
import { WORK_DIR } from './utils/paths.js';
import i18n from './utils/i18n.js';

const app = express();
// PayPal's webhook events are checked with PayPal as they came: their body is kept as received (routes/billing-api.js)
app.use(express.json({ limit: '2mb', verify: (req, res, buf) => { if (req.originalUrl.startsWith('/api/billing/webhook')) req.rawBody = buf.toString('utf8'); } }));
app.use(i18n); // UI language from the 'lang' cookie: req.__(), JSON errors translated
// The proxies in front whose X-Forwarded-* are believed (req.ip for the per-IP limits, req.protocol): by default the
// ones on this machine or its private network (cloudflared, Docker); TRUST_PROXY=1 / 2 = that many hops (Cloud Run).
const trust = process.env.TRUST_PROXY || 'loopback, linklocal, uniquelocal';
app.set('trust proxy', /^\d+$/.test(trust) ? Number(trust) : trust === 'true' ? true : trust === 'false' ? false : trust);
// The public API needs an API key, an account or a page of this site; the admin side an admin (routes/auth-api.js)
app.use(gate());

// Views (HTML) — /, /roster, /label, /benchmark
app.use('/', viewsRouter);

// API (JSON) — /api/roster/upload (public), /api/ocr/upload (deprecated), /api/files, /api/raw, /api/labels, /api/predict, /api/benchmark
app.use('/api', authApiRouter); // sign-in: /api/auth/config, me, session, logout
app.use('/api', accountApiRouter); // /api/account (keys, usage), /api/users (admin)
app.use('/api', billingApiRouter); // /api/billing: PayPal subscriptions, invoices (/pricing, /account, /billing)
app.use('/api/pdf', pdfApiRouter); // NetLine duty-plan PDFs (before /api)
app.use('/api/models', modelsApiRouter); // every model of the pipeline: versions, activate, delete, train (/models)
app.use('/api/airports', airportsApiRouter); // airport search + details + 7-day weather (/airport)
app.use('/api', rosterApiRouter); // public: POST /api/roster/upload (any roster file type), /api/roster/suggestions
app.use('/api', suggestionsApiRouter); // admin: correction suggestions, handled on /label
app.use('/api', mediaApiRouter); // admin: the files + labels in MinIO: upload, delete (/label)
app.use('/api', jobsApiRouter); // admin: /api/jobs, the training / benchmark runs going on (the status bar of nav.js)
app.use('/api', dashboardApiRouter); // admin: /api/dashboard, the servers' health, counts, active models (/dashboard)
app.use('/api', acarsApiRouter); // ACARS pictures: POST /api/acars/read (public, /acars); the dataset (admin, /label)
app.use('/api', toolsApiRouter); // public tools: /api/night-time/calc, /api/calendar/export
app.use('/api', apiRouter);

const port = Number(process.env.PORT) || 3000;
const host = process.env.HOST || '0.0.0.0';

const server = app.listen(port, host, () => {
	console.log(`RosterParser app listening on http://${host}:${port}`);
});

// The roster data and the trained models live in MinIO (media/): mirror them locally in the background
// (into WORK_DIR, outside the project: utils/paths.js).
syncMedia({ force: true }).then(
	(r) => console.log(`[media] mirror ready: ${r.index.files.length} files, ${r.index.labels.length} labels`),
	(e) => console.warn(`[media] ${e.message}`),
);
acars.syncMedia({ force: true }).then(
	(r) => console.log(`[acars] mirror ready: ${r.index.files.length} pictures, ${r.index.labels.length} labels`),
	(e) => console.warn(`[acars] ${e.message}`),
);
syncModels({ force: true }).then(
	() => console.log(`[media] models ready (work folder ${WORK_DIR})`),
	(e) => console.warn(`[media] models: ${e.message}`),
);

server.on('error', (err) => {
	console.error('Server listen error:', err);
});

// Cloud Run / docker stop: write the API calls counted since the last write (services/accounts.js), then stop
for (const sig of ['SIGTERM', 'SIGINT']) {
	process.once(sig, () => {
		flushUsage().catch(() => {}).finally(() => process.exit(0));
		setTimeout(() => process.exit(0), 5000).unref();
	});
}
