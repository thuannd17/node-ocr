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
import { syncMedia } from './services/media-client.js';
import { syncModels } from './services/ai-models.js';
import { WORK_DIR } from './utils/paths.js';
import i18n from './utils/i18n.js';

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(i18n); // UI language from the 'lang' cookie: req.__(), JSON errors translated

// Views (HTML) — /, /upload, /label, /benchmark
app.use('/', viewsRouter);

// API (JSON) — /api/roster/upload (public), /api/ocr/upload (deprecated), /api/files, /api/raw, /api/labels, /api/predict, /api/benchmark
app.use('/api/pdf', pdfApiRouter); // NetLine duty-plan PDFs (before /api)
app.use('/api/models', modelsApiRouter); // every model of the pipeline: versions, activate, delete, train (/models)
app.use('/api/airports', airportsApiRouter); // airport search + details + 7-day weather (/airport)
app.use('/api', rosterApiRouter); // public: POST /api/roster/upload (any roster file type), /api/roster/suggestions
app.use('/api', suggestionsApiRouter); // admin: correction suggestions, handled on /label
app.use('/api', mediaApiRouter); // admin: the files + labels in MinIO, the local mirror (/media)
app.use('/api', toolsApiRouter); // public tools: /api/night-time/calc, /api/calendar/export
app.use('/api', apiRouter);

const port = Number(process.env.PORT) || 3000;
const host = process.env.HOST || '0.0.0.0';

const server = app.listen(port, host, () => {
	console.log(`Roster OCR app listening on http://${host}:${port}`);
});

// The roster data and the trained models live in MinIO (media/): mirror them locally in the background
// (into WORK_DIR, outside the project: utils/paths.js).
syncMedia({ force: true }).then(
	(r) => console.log(`[media] mirror ready: ${r.index.files.length} files, ${r.index.labels.length} labels`),
	(e) => console.warn(`[media] ${e.message}`),
);
syncModels({ force: true }).then(
	() => console.log(`[media] models ready (work folder ${WORK_DIR})`),
	(e) => console.warn(`[media] models: ${e.message}`),
);

server.on('error', (err) => {
	console.error('Server listen error:', err);
});
