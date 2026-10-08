// /index.js — Entry point: setup express + mount routers
import express from 'express';

import viewsRouter from './routes/views.js';
import apiRouter from './routes/api.js';

const app = express();
app.use(express.json({ limit: '2mb' }));

// Views (HTML) — /, /upload, /label, /benchmark
app.use('/', viewsRouter);

// API (JSON) — /api/ocr/upload, /api/files, /api/raw, /api/labels, /api/predict, /api/benchmark
app.use('/api', apiRouter);

const port = Number(process.env.PORT) || 3000;
const host = process.env.HOST || '0.0.0.0';

const server = app.listen(port, host, () => {
	console.log(`Roster OCR app listening on http://${host}:${port}`);
	console.log(`  → http://localhost:${port}/          (dashboard)`);
	console.log(`  → http://localhost:${port}/upload    (upload & OCR)`);
	console.log(`  → http://localhost:${port}/label     (label tool)`);
	console.log(`  → http://localhost:${port}/benchmark (accuracy)`);
});

server.on('error', (err) => {
	console.error('Server listen error:', err);
});
