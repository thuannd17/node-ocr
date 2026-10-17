#!/usr/bin/env node
/**
 * List recognition model versions, or switch the deployed one.
 *
 *   npm run ocr:use-model            # list models/rec/* with status and last comparison
 *   npm run ocr:use-model -- v5      # point .env OCR_CUSTOM_REC at models/rec/v5/infer
 *
 * Switching only edits .env (the previous line is kept as a comment for
 * rollback) and the status fields in model.json; restart `npm run ocr:server`
 * (and `npm start`) afterwards to load it.
 */
import fs from 'node:fs';
import path from 'node:path';
import { activateRec } from '../services/rec-models.js';

const ROOT = process.cwd();
const REC_DIR = path.join(ROOT, 'models', 'rec');
const ENV = path.join(ROOT, '.env');
const readJson = (p) => (fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : {});

const envText = fs.readFileSync(ENV, 'utf8');
const activeLine = /^OCR_CUSTOM_REC=(.*)$/m.exec(envText);
const active = /models\/rec\/(v\d+|stock)\/infer/.exec(activeLine?.[1] || '')?.[1] || null;
const versions = fs.readdirSync(REC_DIR, { withFileTypes: true })
	.filter(d => d.isDirectory() && /^(v\d+|stock)$/.test(d.name) && fs.existsSync(path.join(REC_DIR, d.name, 'infer', 'inference.pdiparams')))
	.map(d => d.name)
	.sort((a, b) => (a === 'stock') - (b === 'stock') || Number(a.slice(1)) - Number(b.slice(1)));

const target = process.argv[2];
if (!target) {
	console.log('Recognition models (models/rec/):');
	for (const v of versions) {
		const m = readJson(path.join(REC_DIR, v, 'model.json'));
		const c = m.comparison;
		const cmp = c ? ` | vs ${c.against} on ${c.rosters} new rosters: ${c[c.against].rowsCorrect} -> ${c[v].rowsCorrect}/${c[v].rows} rows (${c.verdict})` : '';
		console.log(`${v === active ? '*' : ' '} ${v.padEnd(6)} ${String(m.status || '?').padEnd(9)} ${String(m.createdAt || '').padEnd(10)} ${m.name || ''}${cmp}`);
	}
	console.log(`\n* = in use (.env OCR_CUSTOM_REC=${activeLine?.[1] || 'unset'})`);
	process.exit(0);
}

if (!versions.includes(target)) {
	console.error(`Unknown version "${target}". Available: ${versions.join(', ')}`);
	process.exit(1);
}
if (target === active) {
	console.log(`${target} is already in use.`);
	process.exit(0);
}
const meta = readJson(path.join(REC_DIR, target, 'model.json'));
if (meta.comparison && meta.comparison.verdict !== 'better') {
	console.log(`Note: ${target} was ${meta.comparison.verdict.toUpperCase()} than ${meta.comparison.against} in its ocr:train.`);
}

activateRec(target); // .env + statuses, as the /models page does (services/rec-models.js)

console.log(`.env now uses ${target} (was ${active || activeLine?.[1] || 'unset'}).`);
console.log('Restart the OCR server (npm run ocr:server) and the app (npm start) to load it.');
