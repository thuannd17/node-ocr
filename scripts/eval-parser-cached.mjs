#!/usr/bin/env node
/**
 * Fast parser-only benchmark: re-parses OCR lines cached by
 * scripts/diagnose-errors.mjs (--lines-dir) and scores them exactly like the
 * benchmark (deduped, same compareSection). No OCR server needed, so parser
 * changes can be checked in seconds instead of re-running OCR on every image.
 *
 * Usage:
 *   node scripts/eval-parser-cached.mjs [--lines-dir=cache/rec-lines/<version>]
 *        [--section=published] [--errors=40] [--file=NAME] [--json=out.json]
 */
import fs from 'node:fs';
import path from 'node:path';
import { parseRoster, cleanExtractionResult } from '../services/roster-parser.js';
import { compareSection } from '../services/benchmark.js';
import { groupByContent, pickCanonicalLabels } from '../utils/content-groups.js';

const arg = (name, fallback = null) => {
	const hit = process.argv.slice(2).find(a => a.startsWith(`--${name}=`));
	return hit ? hit.slice(name.length + 3) : fallback;
};
const folder = path.resolve('fake-data');
const labelsDir = path.resolve('labels');
const linesDir = path.resolve(arg('lines-dir', 'cache/rec-lines/v4'));
const section = arg('section', 'published');
const showErrors = Number(arg('errors', 30));
const onlyFile = arg('file');

const cached = fs.readdirSync(linesDir).filter(f => f.endsWith('.lines.json')).map(f => f.slice(0, -'.lines.json'.length));
const labeled = cached.filter(n => fs.existsSync(path.join(labelsDir, `${n}.json`)));
const { canonical } = pickCanonicalLabels(groupByContent(folder, labeled), labelsDir);
let names = [...new Set(canonical.values())].sort();
if (onlyFile) names = names.filter(n => n === onlyFile);

const pct = (m, t) => (t ? (100 * m / t).toFixed(1) : '0.0');
const tot = {};
const pairs = new Map();
const perFile = [];
for (const name of names) {
	const lines = JSON.parse(fs.readFileSync(path.join(linesDir, `${name}.lines.json`), 'utf8'));
	const label = JSON.parse(fs.readFileSync(path.join(labelsDir, `${name}.json`), 'utf8'));
	const pred = cleanExtractionResult(parseRoster(lines));
	for (const sec of ['published', 'planned']) {
		const r = compareSection(pred[sec] || [], label[sec] || []);
		const t = (tot[sec] ??= { rowMatches: 0, rowTotal: 0, fields: {} });
		t.rowMatches += r.rowMatches; t.rowTotal += r.rowTotal;
		for (const [f, v] of Object.entries(r.perField)) {
			t.fields[f] ??= { m: 0, t: 0 };
			t.fields[f].m += v.matches; t.fields[f].t += v.total;
		}
		if (sec === section) {
			perFile.push({ name, ok: r.rowMatches, total: r.rowTotal, pred: r.predCount, exp: r.expCount });
			for (const e of r.rowErrors) {
				const k = `${e.field} | ${e.expected} -> ${e.actual}`;
				const p = pairs.get(k) || { n: 0, files: new Set() };
				p.n++; p.files.add(name); pairs.set(k, p);
			}
			if (onlyFile) {
				const rows = pred[sec] || [];
				console.log(`--- ${name} ${sec}: pred ${rows.length} / exp ${(label[sec] || []).length}`);
				for (let i = 0; i < Math.max(rows.length, (label[sec] || []).length); i++) {
					const fmt = (o) => (o ? ['date', 'day', 'duty', 'dep', 'begin', 'end', 'arr'].map(f => o[f] ?? '').join(' | ') : '-');
					console.log(`P ${fmt(rows[i])}\nE ${fmt((label[sec] || [])[i])}`);
				}
			}
		}
	}
}
const allM = tot.published.rowMatches + tot.planned.rowMatches, allT = tot.published.rowTotal + tot.planned.rowTotal;
console.log(`images ${names.length}  rowExact ${pct(allM, allT)}% (${allM}/${allT})`);
for (const [sec, t] of Object.entries(tot)) {
	console.log(`  ${sec.padEnd(10)} ${pct(t.rowMatches, t.rowTotal)}% (${t.rowMatches}/${t.rowTotal})  ` +
		Object.entries(t.fields).map(([f, v]) => `${f} ${pct(v.m, v.t)}`).join(', '));
}
if (showErrors && !onlyFile) {
	perFile.sort((a, b) => (a.ok - a.total) - (b.ok - b.total));
	console.log(`\nworst ${section} files:`);
	for (const f of perFile.slice(0, 15)) console.log(`  ${f.name}  ${f.ok}/${f.total}  pred ${f.pred} exp ${f.exp}`);
	console.log(`\ntop ${section} error pairs (field | expected -> actual):`);
	for (const [k, v] of [...pairs].sort((a, b) => b[1].n - a[1].n).slice(0, showErrors)) {
		console.log(`  ${String(v.n).padStart(3)} ${k}   [${[...v.files].slice(0, 3).join(', ')}${v.files.size > 3 ? ', …' : ''}]`);
	}
}
const out = arg('json');
if (out) fs.writeFileSync(out, JSON.stringify({ tot, perFile }, null, 2));
