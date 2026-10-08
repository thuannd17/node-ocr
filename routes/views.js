// /routes/views.js
// Serve các trang HTML từ views/ (chỉ view, không có logic API)
import express, { Router } from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const viewsDir = path.resolve(__dirname, '..', 'views');

const router = Router();

// Shared stylesheet + nav used by every page.
router.use('/assets', express.static(path.join(viewsDir, 'assets')));

router.get('/', (req, res) => {
	res.sendFile(path.join(viewsDir, 'home.html'));
});

router.get('/upload', (req, res) => {
	res.sendFile(path.join(viewsDir, 'upload.html'));
});

router.get('/label', (req, res) => {
	res.sendFile(path.join(viewsDir, 'label.html'));
});

router.get('/benchmark', (req, res) => {
	res.sendFile(path.join(viewsDir, 'benchmark.html'));
});

// /ops and /crop-label were archived to archive/views/ (2026-10-06): they drove
// the learned-correction replay and the old dataset export, both retired.

export default router;
