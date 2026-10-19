#!/usr/bin/env node
/**
 * List recognition model versions, or switch the one in use.
 *
 *   npm run ocr:use-model            # list the versions in MinIO (models/rec/) with status and last comparison
 *   npm run ocr:use-model -- v5      # make v5 the one in use (models/rec/active.json in MinIO)
 *
 * Switching writes active.json and the status fields in model.json (services/rec-models.js, as the
 * /models page does); restart `npm run ocr:server` afterwards: it downloads and loads the new one.
 */
import fs from 'node:fs';
import path from 'node:path';
import { activateRec, activeRecId, listRecModels, syncRecModels, REC_DIR } from '../services/rec-models.js';

const readJson = (p) => (fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : {});

await syncRecModels({ force: true });
const active = activeRecId();
const versions = listRecModels().map(m => m.id)
	.sort((a, b) => (a === 'stock') - (b === 'stock') || Number(a.slice(1)) - Number(b.slice(1)));

const target = process.argv[2];
if (!target) {
	console.log('Recognition models (MinIO models/rec/):');
	for (const v of versions) {
		const m = readJson(path.join(REC_DIR, v, 'model.json'));
		const c = m.comparison;
		const cmp = c ? ` | vs ${c.against} on ${c.rosters} new rosters: ${c[c.against].rowsCorrect} -> ${c[v].rowsCorrect}/${c[v].rows} rows (${c.verdict})` : '';
		console.log(`${v === active ? '*' : ' '} ${v.padEnd(6)} ${String(m.status || '?').padEnd(9)} ${String(m.createdAt || '').padEnd(10)} ${m.name || ''}${cmp}`);
	}
	console.log(`\n* = in use (${process.env.OCR_REC_VERSION ? `pinned by OCR_REC_VERSION=${process.env.OCR_REC_VERSION} in .env` : 'models/rec/active.json'})`);
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

await activateRec(target);

console.log(`${target} is now the OCR model in use (was ${active || 'unset'}).`);
console.log('Restart the OCR server (npm run ocr:server) to load it.');
