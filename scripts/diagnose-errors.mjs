/**
 * Error-source diagnosis: for every wrong field in the benchmark, decide WHICH
 * pipeline stage most likely caused it, so we know where extra training data /
 * effort would actually pay off.
 *
 * For each labeled image:
 *   1. get raw OCR lines from the running OCR server (cached under --lines-dir,
 *      so the run is resumable if the machine OOM-kills the server midway),
 *   2. run the same parseRoster + cleanExtractionResult as the real pipeline,
 *   3. align predicted rows to labeled rows (same alignRows as the benchmark),
 *   4. for every mismatching field, look at the OCR lines physically located at
 *      the labeled row (found via that row's date line) and ask: did the OCR
 *      engine actually produce the right text there?
 *
 * Buckets per wrong field:
 *   PARSER_LOSS  the right text IS in that row's OCR lines -> parser/column
 *                assignment/normalization/learned-correction dropped or moved it
 *   REC_NEAR     a line in that row is within a couple of characters of the
 *                right text -> recognition error (what fine-tuning can fix)
 *   NO_EVIDENCE  nothing close in that row -> detection missed it / text garbled
 *   MERGED_CELLS the right text is inside a bigger OCR box that swallowed
 *                neighbouring cells (detection granularity, not recognition)
 *   ANCHOR_LOST  the row's date line was not found, so the row can't be located
 *   SPURIOUS     label is empty but the pipeline emitted a value
 * Separately, `learning` counts how often the learned-correction stages
 * (applyTokenConfusionCorrections / applyLearningCorrections) overwrote a value
 * that was already right (harm) vs fixed a wrong one (help).
 * Row-level: ROW_MISSING (no predicted row aligned to a labeled row) and
 * ROW_EXTRA (predicted row with no labeled row).
 *
 * Usage:
 *   node --env-file=.env scripts/diagnose-errors.mjs [--limit=N] [--json=out.json]
 *        [--lines-dir=tmp/diag-lines] [--examples=3]
 * Needs `npm run ocr-server` running (only for images not already cached).
 * Side-effect free: does not write labels, review queues, or call the VLM.
 */
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { parseRoster, cleanExtractionResult } from '../services/roster-parser.js';
import { alignRows, normalizeField, levenshtein } from '../services/benchmark.js';
import { groupByContent, pickCanonicalLabels } from '../utils/content-groups.js';

const FIELDS = ['date', 'day', 'duty', 'dep', 'begin', 'end', 'arr'];
const OCR_SERVER_URL = (process.env.OCR_SERVER_URL || 'http://127.0.0.1:8501').replace(/\/+$/, '');
// Mirrors services/paddle-ocr.js so the lines match what the pipeline sees.
const MAX_OCR_WIDTH = Number(process.env.OCR_MAX_WIDTH || (process.env.OCR_FAST_MODE ? Number(process.env.OCR_FAST_OCR_MAX_WIDTH || 1600) : 2000));

function arg(name, fallback = null) {
	const hit = process.argv.slice(2).find(a => a.startsWith(`--${name}=`));
	return hit ? hit.slice(name.length + 3) : fallback;
}
const opts = {
	folder: path.resolve(arg('folder', 'fake-data')),
	labels: path.resolve(arg('labels', 'labels')),
	linesDir: path.resolve(arg('lines-dir', 'tmp/diag-lines')),
	limit: Number(arg('limit', 0)) || 0,
	json: arg('json'),
	examples: Number(arg('examples', 3)),
	listMissing: process.argv.includes('--list-missing'),
};

async function fetchLines(filePath) {
	let processing = filePath;
	let scale = 1;
	let tmp = null;
	const meta = await sharp(filePath).metadata();
	if (meta.width > MAX_OCR_WIDTH) {
		scale = MAX_OCR_WIDTH / meta.width;
		tmp = path.join(opts.linesDir, `_resize_${Date.now()}.jpg`);
		await sharp(filePath).resize(MAX_OCR_WIDTH).jpeg({ quality: 85 }).toFile(tmp);
		processing = tmp;
	}
	try {
		const res = await fetch(`${OCR_SERVER_URL}/ocr`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ path: path.resolve(processing) }),
			signal: AbortSignal.timeout(300000),
		});
		const data = await res.json().catch(() => null);
		if (!res.ok || !data?.ok) throw new Error(data?.error || `HTTP ${res.status}`);
		let lines = Array.isArray(data.lines) ? data.lines : [];
		if (scale !== 1) lines = lines.map(l => ({ ...l, box: l.box.map(p => [p[0] / scale, p[1] / scale]) }));
		return lines;
	} finally {
		if (tmp) try { fs.unlinkSync(tmp); } catch { /* ignore */ }
	}
}

async function getLines(name) {
	const cacheFile = path.join(opts.linesDir, `${name}.lines.json`);
	if (fs.existsSync(cacheFile)) return JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
	const lines = await fetchLines(path.join(opts.folder, name));
	fs.writeFileSync(cacheFile, JSON.stringify(lines), 'utf8');
	return lines;
}

// ── geometry / matching helpers ─────────────────────────────────────────────
function withGeom(l) {
	const ys = l.box.map(p => p[1]);
	const y0 = Math.min(...ys), y1 = Math.max(...ys);
	return { ...l, y0, y1, yc: (y0 + y1) / 2, h: y1 - y0 };
}
const median = a => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : 0; };

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const WEEKDAY_PREFIX_RE = /^(mon|tue|wed|thu|fri|sat|sun)[a-z]*[.,\s]+/i;
const DATE_RE = /(\d{1,2})\s*([A-Za-z]{3})[A-Za-z]*\.?\s*(\d{2,4})/;

/** Parse "12 Jun 20" style text into a comparable key, or null. */
function dateKey(text) {
	const m = String(text || '').match(DATE_RE);
	if (!m) return null;
	return `${Number(m[1])}|${m[2].toLowerCase()}|${m[3].slice(-2)}`;
}

/** Find OCR lines that show the labeled date. exact = same d/mon/yy, fuzzy = within 1-2 edits. */
function findAnchors(lines, expDate) {
	const want = dateKey(expDate);
	const wantStr = String(expDate || '').replace(/\s+/g, '').toLowerCase();
	const exact = [], fuzzy = [];
	for (const l of lines) {
		const got = dateKey(l.text);
		if (want && got === want) { exact.push(l); continue; }
		const stripped = l.text.replace(WEEKDAY_PREFIX_RE, '').replace(/\s+/g, '').toLowerCase();
		if (!stripped) continue;
		const tail = stripped.slice(-wantStr.length);
		if (levenshtein(tail, wantStr) <= 2 && stripped.length <= wantStr.length + 4) fuzzy.push(l);
	}
	// Header lines ("Generated: 17 Jun 20", "published until 21 Jun 20") repeat a date
	// without the weekday the table rows carry; prefer weekday-bearing lines.
	const hasWeekday = l => /\b(mon|tue|wed|thu|fri|sat|sun)/i.test(l.text);
	const byWeekday = (a, b) => Number(hasWeekday(b)) - Number(hasWeekday(a));
	exact.sort(byWeekday);
	fuzzy.sort(byWeekday);
	return { exact, fuzzy };
}

function candidatesOf(bandLines, nTokens) {
	const out = [];
	for (const l of bandLines) {
		out.push(l.text);
		const toks = l.text.split(/\s+/).filter(Boolean);
		for (let n = 1; n <= Math.max(1, nTokens); n++) {
			for (let i = 0; i + n <= toks.length; i++) out.push(toks.slice(i, i + n).join(' '));
		}
	}
	return out;
}

/** Best evidence that `expected` (normalized) is present in the band: 'exact' | 'near' | 'none'. */
function evidenceIn(field, expected, bandLines) {
	if (!expected) return { kind: 'none', best: null };
	const nTok = expected.split(/\s+/).length;
	let bestLev = Infinity, best = null;
	for (const c of candidatesOf(bandLines, nTok)) {
		if (field === 'day') {
			const cn = c.trim().slice(0, 3).toUpperCase();
			if (cn === expected) return { kind: 'exact', best: c };
			continue;
		}
		const cn = normalizeField(field, c);
		if (cn === expected) return { kind: 'exact', best: c };
		const d = levenshtein(cn.toUpperCase(), expected.toUpperCase());
		if (d < bestLev) { bestLev = d; best = c; }
	}
	const tol = Math.max(1, Math.floor(expected.length * 0.34));
	if (field === 'day') {
		// weekday tokens inside date lines: compare first-3-letter prefixes with 1 edit
		for (const l of bandLines) {
			const m = l.text.match(/^([A-Za-z]{3})/);
			if (m && levenshtein(m[1].toUpperCase(), expected) <= 1) return { kind: 'near', best: l.text };
		}
		return { kind: 'none', best };
	}
	return bestLev <= tol ? { kind: 'near', best } : { kind: 'none', best };
}

// ── main ────────────────────────────────────────────────────────────────────
const BUCKETS = ['PARSER_LOSS', 'REC_NEAR', 'MERGED_CELLS', 'NO_EVIDENCE', 'ANCHOR_LOST', 'SPURIOUS'];
const stats = {
	images: 0, failed: [],
	rows: { total: 0, ok: 0, missing: 0, missingAnchorFound: 0, extra: 0 },
	missingKinds: { firstOfDayWithEvidence: 0, firstOfDayNoEvidence: 0, extraSectorWithEvidence: 0, extraSectorNoEvidence: 0, noAnchor: 0 },
	countAgree: 0, countTotal: 0,
	perField: Object.fromEntries(FIELDS.map(f => [f, { total: 0, ok: 0, buckets: Object.fromEntries(BUCKETS.map(b => [b, 0])) }])),
	learning: { applied: 0, harm: 0, help: 0, neutral: 0, byField: {} },
	rowFix: { alreadyOk: 0, recOnly: 0, parserOnly: 0, recOrParser: 0, other: 0 },
	examples: Object.fromEntries(BUCKETS.map(b => [b, []])),
};

const compact = t => String(t || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

function classifyField(field, expRaw, predRaw, band, anchors, multiRow) {
	const ev = normalizeField(field, expRaw);
	const pv = normalizeField(field, predRaw);
	if (!ev && pv) return { bucket: 'SPURIOUS' };
	if (field === 'date') {
		if (anchors.exact.length) return { bucket: 'PARSER_LOSS', note: 'date line read correctly' };
		if (anchors.fuzzy.length) return { bucket: 'REC_NEAR', note: anchors.fuzzy[0].text };
		return { bucket: 'ANCHOR_LOST' };
	}
	if (!band) return { bucket: 'ANCHOR_LOST' };
	const e = evidenceIn(field, ev, band);
	if (e.kind === 'exact') return { bucket: 'PARSER_LOSS', note: e.best };
	const want = compact(ev);
	if (want.length >= 3) {
		const merged = band.find(l => compact(l.text).length >= want.length + 3 && compact(l.text).includes(want));
		if (merged) return { bucket: 'MERGED_CELLS', note: merged.text };
	}
	if (e.kind === 'near') return { bucket: 'REC_NEAR', note: e.best };
	return { bucket: 'NO_EVIDENCE', note: e.best };
}

function diagnoseSection(name, predRows, expRows, lines, medH, rawByClean) {
	const aligned = alignRows(predRows, expRows);
	// how many times each expected date repeats (multi-sector days share one date line)
	const dateCount = {};
	for (const r of expRows) dateCount[r.date] = (dateCount[r.date] || 0) + 1;
	const seenDate = {};

	for (const { pred, exp } of aligned) {
		if (!exp) { stats.rows.extra += 1; continue; }
		stats.rows.total += 1;
		const anchors = findAnchors(lines, exp.date);
		const anchor = anchors.exact[0] || anchors.fuzzy[0] || null;
		const multiRow = dateCount[exp.date] > 1;
		let band = null;
		if (anchor) {
			// A row's other cells sit at the date line's height; multi-sector days
			// share the date line, so use a taller window and accept looser evidence.
			const tol = medH * (multiRow ? 3.5 : 0.7);
			band = lines.filter(l => Math.abs(l.yc - anchor.yc) <= tol);
		}
		const firstOfDay = !seenDate[exp.date];
		seenDate[exp.date] = true;
		if (!pred) {
			stats.rows.missing += 1;
			if (anchor) stats.rows.missingAnchorFound += 1;
			// Is the row's own content (duty/times/airport) visible in the OCR lines at its
			// height? If so a better parser could recover it; if not, detection lost it.
			const mk = stats.missingKinds;
			if (!band) mk.noAnchor += 1;
			else {
				const probes = ['duty', 'begin', 'end', 'dep'].map(f => ({ f, v: normalizeField(f, exp[f]) })).filter(x => x.v);
				const seen = probes.filter(x => evidenceIn(x.f, x.v, band).kind !== 'none').length;
				const ok = probes.length > 0 && seen >= Math.ceil(probes.length / 2);
				if (firstOfDay) { mk[ok ? 'firstOfDayWithEvidence' : 'firstOfDayNoEvidence'] += 1; if (ok && opts.listMissing) console.log(`MISSING	${name}	${exp.date}	${anchor.text}	${Math.round(anchor.yc)}`); }
				else mk[ok ? 'extraSectorWithEvidence' : 'extraSectorNoEvidence'] += 1;
			}
			continue;
		}
		const rowBuckets = new Set();
		const raw = rawByClean.get(pred);
		const applied = [...(raw?._tokenConfusionsApplied || []), ...(raw?._learningApplied || [])];
		for (const a of applied) {
			stats.learning.applied += 1;
			const bf = (stats.learning.byField[a.field] ||= { harm: 0, help: 0, neutral: 0 });
			const wantV = normalizeField(a.field, exp[a.field]);
			const kind = normalizeField(a.field, a.from) === wantV && normalizeField(a.field, a.to) !== wantV ? 'harm'
				: normalizeField(a.field, a.to) === wantV && normalizeField(a.field, a.from) !== wantV ? 'help' : 'neutral';
			stats.learning[kind] += 1;
			bf[kind] += 1;
		}
		for (const f of FIELDS) {
			const pf = stats.perField[f];
			pf.total += 1;
			const ev = normalizeField(f, exp[f]);
			const pv = normalizeField(f, pred[f]);
			if (ev === pv) { pf.ok += 1; continue; }
			const c = classifyField(f, exp[f], pred[f], band, anchors, multiRow);
			pf.buckets[c.bucket] += 1;
			rowBuckets.add(c.bucket);
			const ex = stats.examples[c.bucket];
			if (ex.length < opts.examples * FIELDS.length) {
				ex.push({ file: name, field: f, expected: ev, predicted: pv, evidence: c.note || null, multiRowDay: multiRow });
			}
		}
		if (rowBuckets.size === 0) { stats.rows.ok += 1; stats.rowFix.alreadyOk += 1; continue; }
		const onlyRec = [...rowBuckets].every(b => b === 'REC_NEAR');
		const onlyParser = [...rowBuckets].every(b => b === 'PARSER_LOSS');
		const recOrParser = [...rowBuckets].every(b => b === 'REC_NEAR' || b === 'PARSER_LOSS');
		if (onlyRec) stats.rowFix.recOnly += 1;
		else if (onlyParser) stats.rowFix.parserOnly += 1;
		else if (recOrParser) stats.rowFix.recOrParser += 1;
		else stats.rowFix.other += 1;
	}
}

async function main() {
	fs.mkdirSync(opts.linesDir, { recursive: true });
	let names = fs.readdirSync(opts.folder)
		.filter(n => /\.(jpe?g|png|jfif)$/i.test(n) && fs.existsSync(path.join(opts.labels, `${n}.json`)));
	if (!process.argv.includes('--no-dedupe')) {
		// score each byte-identical image once, using its most plausible label copy
		const { canonical } = pickCanonicalLabels(groupByContent(opts.folder, names), opts.labels);
		const keep = new Set(canonical.values());
		names = names.filter(n => keep.has(n));
	}
	if (opts.limit) names = names.slice(0, opts.limit);

	for (const name of names) {
		let lines;
		try {
			lines = await getLines(name);
		} catch (err) {
			console.error(`\nOCR failed on "${name}": ${err.message}`);
			console.error(`Lines cached so far are kept in ${opts.linesDir}. Restart the OCR server and re-run: it resumes.`);
			process.exit(2);
		}
		const exp = JSON.parse(fs.readFileSync(path.join(opts.labels, `${name}.json`), 'utf8'));
		const parsedLines = lines
			.filter(l => l.text && Array.isArray(l.box) && l.box.length >= 4 && (l.confidence == null || l.confidence >= 0.3))
			.map(l => withGeom({ ...l, text: String(l.text).trim() }));
		const medH = median(parsedLines.map(l => l.h)) || 12;
		let pred, rawPred;
		try {
			rawPred = parseRoster(lines);
			pred = cleanExtractionResult(rawPred);
		} catch (err) {
			stats.failed.push({ file: name, error: err.message });
			continue;
		}
		stats.images += 1;
		for (const sec of ['published', 'planned']) {
			const p = pred[sec] || [], e = exp[sec] || [];
			stats.countTotal += 1;
			if (p.length === e.length) stats.countAgree += 1;
			const rawByClean = new Map((rawPred[sec] || []).map((rr, i) => [p[i], rr]));
			diagnoseSection(name, p, e, parsedLines, medH, rawByClean);
		}
		process.stdout.write(`\r${stats.images}/${names.length}`);
	}
	process.stdout.write('\n');
	report();
}

const pct = (n, d) => (d ? `${(100 * n / d).toFixed(1)}%` : 'n/a');

function report() {
	const r = stats.rows;
	console.log('\n== Row level (labeled rows) ==');
	console.log(`images: ${stats.images}, parser failures: ${stats.failed.length}`);
	console.log(`section row-count agrees with label: ${stats.countAgree}/${stats.countTotal} (${pct(stats.countAgree, stats.countTotal)})`);
	console.log(`labeled rows: ${r.total}`);
	console.log(`  exact match:            ${r.ok} (${pct(r.ok, r.total)})`);
	console.log(`  no predicted row:       ${r.missing} (${pct(r.missing, r.total)})  [date line found in OCR for ${r.missingAnchorFound}]`);
	console.log(`  extra predicted rows:   ${r.extra}`);
	const mk = stats.missingKinds;
	console.log(`  missing rows: first-of-day, content visible in OCR ${mk.firstOfDayWithEvidence} | first-of-day, content NOT visible ${mk.firstOfDayNoEvidence} | extra sector of a day, content visible ${mk.extraSectorWithEvidence} | extra sector, content NOT visible ${mk.extraSectorNoEvidence} | no date line ${mk.noAnchor}`);

	console.log('\n== Per field: where do the wrong values come from? ==');
	const head = ['field', 'acc', ...BUCKETS];
	console.log(head.map((h, i) => (i ? h.padStart(12) : h.padEnd(7))).join(' '));
	for (const f of FIELDS) {
		const pf = stats.perField[f];
		const wrong = pf.total - pf.ok;
		const cells = BUCKETS.map(b => `${pf.buckets[b]}`.padStart(12));
		console.log(`${f.padEnd(7)} ${pct(pf.ok, pf.total).padStart(12)} ${cells.join(' ')}   (wrong=${wrong})`);
	}

	const rf = stats.rowFix;
	const aligned = r.total - r.missing;
	console.log('\n== What would fixing each stage buy? (rows that have a predicted row) ==');
	console.log(`already exact:                 ${rf.alreadyOk}/${aligned} (${pct(rf.alreadyOk, aligned)})`);
	console.log(`fixable by RECOGNITION only:   +${rf.recOnly} rows -> ${pct(rf.alreadyOk + rf.recOnly, aligned)}`);
	console.log(`fixable by PARSER only:        +${rf.parserOnly} rows -> ${pct(rf.alreadyOk + rf.parserOnly, aligned)}`);
	console.log(`fixable only by rec + parser:  +${rf.recOrParser} rows`);
	console.log(`has detection/anchor/spurious: ${rf.other} rows (neither stage alone helps)`);

	const L = stats.learning;
	console.log('\n== Learned-correction stages ==');
	console.log(`corrections applied on matched rows: ${L.applied}`);
	console.log(`  overwrote an already-correct value (harm): ${L.harm}`);
	console.log(`  turned a wrong value into the right one (help): ${L.help}`);
	console.log(`  neither (still wrong / unrelated): ${L.neutral}`);
	for (const [f, v] of Object.entries(L.byField)) console.log(`  ${f.padEnd(6)} harm=${v.harm} help=${v.help} neutral=${v.neutral}`);

	for (const b of BUCKETS) {
		const ex = stats.examples[b];
		if (!ex.length) continue;
		console.log(`\n-- ${b} examples --`);
		const perField = {};
		for (const e of ex) {
			perField[e.field] = (perField[e.field] || 0) + 1;
			if (perField[e.field] > opts.examples) continue;
			console.log(`  ${e.file} [${e.field}${e.multiRowDay ? ', multi-row day' : ''}] expected="${e.expected}" predicted="${e.predicted}"${e.evidence ? ` ocr-near="${e.evidence}"` : ''}`);
		}
	}

	if (opts.json) {
		fs.writeFileSync(opts.json, JSON.stringify(stats, null, 2), 'utf8');
		console.log(`\nJSON written to ${opts.json}`);
	}
}

main().catch(err => { console.error(err); process.exit(1); });
