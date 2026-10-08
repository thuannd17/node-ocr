#!/usr/bin/env node
/**
 * Build Recognition Ground-Truth Dataset
 * ---------------------------------------
 * Unlike scripts/export-dataset.mjs (whose recognition/*.tsv labels crops with
 * whatever text the OCR engine itself predicted — useful for domain/font
 * adaptation, but useless for *correcting* systematic errors), this script
 * labels crops with the human-verified ground truth from labels/*.json.
 *
 * Strategy: for each labeled image, detect the table header row + column
 * x-boundaries from that image's own OCR lines (same geometry logic as
 * the former services/parser-learner.js (removed 2026-10-06)), detect table rows by y-clustering, and pair
 * rows 1:1 (in top-to-bottom order) with label.published[] / label.planned[]
 * entries. The 5 columns with unambiguous x-boundaries — duty, dep, begin,
 * end, arr — are exported per-field. date+day share one visual cell in this
 * template ("17 Jan 20 Fri") with a fuzzier left boundary, so they're
 * exported as one combined `${date} ${day}` crop over the whole
 * tableLeft..dutyLeft band instead of two precise per-field ones. They were
 * excluded entirely at first, which turned out to be the wrong call — see
 * the dateDayText block below for why.
 *
 * Safety-first: a wrong crop-to-label pairing is worse than no pair at all.
 * Rows are paired by verified date anchors plus equal-count gaps between them
 * (see pairRowsByDateAnchor); stretches that can't be paired with certainty
 * are skipped. The old all-or-nothing rule (section row counts must be equal)
 * is still available as --legacy-match, but it discarded ~all planned rows.
 *
 * Output: PaddleOCR SimpleDataSet format, ready for tools/train.py
 *   exports/recognition-groundtruth/<id>/images/{train,val}/*.jpg
 *   exports/recognition-groundtruth/<id>/train_list.txt
 *   exports/recognition-groundtruth/<id>/val_list.txt
 *   exports/recognition-groundtruth/<id>/manifest.json
 */
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { groupByContent, pickCanonicalLabels, splitByGroup, rosterClusters, assignFolds } from '../utils/content-groups.js';

const ROOT = process.cwd();
const FAKE_DATA_DIR = path.join(ROOT, 'fake-data');
const LABELS_DIR = path.join(ROOT, 'labels');
const OCR_CACHE_DIR = path.join(ROOT, 'cache', 'ocr');
const OCR_SERVER_URL = (process.env.OCR_SERVER_URL || 'http://127.0.0.1:8501').replace(/\/+$/, '');
const OCR_TIMEOUT_MS = Number(process.env.OCR_TIMEOUT_MS || 180000);

function parseArgs(argv) {
	const args = { id: 'current', trainRatio: 0.9, pad: 2, generalMinConfidence: 0.85, generalMaxPerImage: 20 };
	for (const a of argv) {
		const m = /^--([^=]+)=(.*)$/.exec(a);
		if (!m) continue;
		if (m[1] === 'id') args.id = m[2];
		else if (m[1] === 'train-ratio') args.trainRatio = Number(m[2]);
		else if (m[1] === 'pad') args.pad = Number(m[2]);
		else if (m[1] === 'max-images') args.maxImages = Number(m[2]);
		else if (m[1] === 'general-min-confidence') args.generalMinConfidence = Number(m[2]);
		else if (m[1] === 'general-max-per-image') args.generalMaxPerImage = Number(m[2]);
		else if (m[1] === 'general') args.general = m[2];
		else if (m[1] === 'folds') args.folds = Number(m[2]);
		else if (m[1] === 'lines-dir') args.linesDir = m[2];
		else if (m[1] === 'fold') args.fold = Number(m[2]);
		// JSON { "<image name>": foldIndex } written by kfold-recognition.mjs: the
		// one split shared with the scoring benchmark (runBenchmark's foldMap)
		else if (m[1] === 'fold-map') args.foldMap = m[2];
	}
	// --general=all   : any high-confidence text on the page (old behaviour)
	// --general=table : only text inside the two roster tables + their titles
	//                   and column header (see isTableGeneralLine)
	// --general=none  : no replay crops (same as --no-general)
	if (argv.includes('--no-general')) args.general = 'none';
	if (!args.general) args.general = 'all';
	if (!['all', 'table', 'none'].includes(args.general)) throw new Error(`--general must be all|table|none, got ${args.general}`);
	args.noGeneral = args.general === 'none';
	args.legacyMatch = argv.includes('--legacy-match');
	args.tightCrops = argv.includes('--tight-crops');
	return args;
}

// ---------------------------------------------------------------------------
// Geometry + row/column detection — mirrored from the former services/parser-learner.js (removed 2026-10-06)
// (kept as a local copy on purpose: this script must stay correct even if
// the live parser's heuristics evolve for other reasons).
// ---------------------------------------------------------------------------

function geom(box) {
	const xs = box.map(p => p[0]), ys = box.map(p => p[1]);
	const x0 = Math.min(...xs), x1 = Math.max(...xs);
	const y0 = Math.min(...ys), y1 = Math.max(...ys);
	return { x0, x1, y0, y1, yc: (y0 + y1) / 2, h: y1 - y0 };
}

function groupRows(lines) {
	const sorted = [...lines].sort((a, b) => a.yc - b.yc);
	const rows = [];
	for (const line of sorted) {
		const prev = rows[rows.length - 1];
		if (prev) {
			const overlap = Math.min(prev.y1, line.y1) - Math.max(prev.y0, line.y0);
			if (overlap >= 0.5 * Math.min(prev.h, line.h)) {
				prev.lines.push(line);
				prev.y0 = Math.min(prev.y0, line.y0);
				prev.y1 = Math.max(prev.y1, line.y1);
				prev.yc = (prev.y0 + prev.y1) / 2;
				prev.h = prev.y1 - prev.y0;
				continue;
			}
		}
		rows.push({ lines: [line], y0: line.y0, y1: line.y1, yc: line.yc, h: line.h });
	}
	return rows;
}

function isHeaderRow(row) {
	const text = row.lines.map(l => l.text).join(' ');
	let count = 0;
	if (/\bdate\b/i.test(text)) count++;
	if (/\bduty\b/i.test(text)) count++;
	if (/\bdep\b/i.test(text)) count++;
	if (/\bbegin\b/i.test(text)) count++;
	if (/\bend\b/i.test(text)) count++;
	if (/\barr\b/i.test(text)) count++;
	return count >= 3 && (/\bdate\b/i.test(text) || /\bduty\b/i.test(text));
}

const PLANNED_MARKER_RE = /(rest of this roster is planned|roster is planned)/i;

/** Boilerplate help/disclaimer text that this roster template prints in a
 * side column running alongside the table. Its lines often fall inside the
 * same y-band as a real table row, which would otherwise throw off anchor
 * detection or leak into a crop. Content-based filtering (rather than an
 * x-coordinate margin) is used because the sidebar sits only ~10px right of
 * the Arr column in some layouts — too close to separate by position alone. */
const NOISE_LINE_RE = /(ecrew|printable roster|published every friday|local irish time|duty changes notified|generate change notifications|change notifications in idp)/i;

function computeColumnRanges(headerRow) {
	const frags = headerRow.lines.map(l => ({ text: l.text, x0: l.x0, x1: l.x1 }));
	const find = (re) => frags.find(f => re.test(f.text));
	const dutyF = find(/\bduty\b/i), depF = find(/\bdep\b/i), beginF = find(/\bbegin\b/i);
	const endF = find(/\bend\b/i), arrF = find(/\barr\b/i), dateF = find(/\bdate\b/i);
	if (!dutyF || !depF || !beginF || !endF || !arrF) return null;
	return {
		dutyLeft: dutyF.x0 - 25,
		dutyRight: depF.x0 - 5,
		depLeft: depF.x0,
		depRight: beginF.x0,
		beginLeft: beginF.x0,
		beginRight: endF.x0,
		endLeft: endF.x0,
		endRight: arrF.x0,
		arrLeft: arrF.x0,
		arrRight: arrF.x1 + 60,
		tableLeft: dateF ? dateF.x0 - 10 : Math.min(...frags.map(f => f.x0)) - 10,
	};
}

// ---------------------------------------------------------------------------
// OCR cache (same key scheme as the former services/parser-learner.js (removed 2026-10-06) so entries are
// shared with `npm run calibrate`)
// ---------------------------------------------------------------------------

function getOcrCacheKey(filePath) {
	const stats = fs.statSync(filePath);
	return `${path.basename(filePath)}_${stats.size}_${stats.mtimeMs}`;
}

function findCachedLines(filePath) {
	const exact = path.join(OCR_CACHE_DIR, `${getOcrCacheKey(filePath)}.json`);
	if (fs.existsSync(exact)) {
		try { return JSON.parse(fs.readFileSync(exact, 'utf8')); } catch { /* fall through */ }
	}
	// Fall back to the newest cache entry for this filename (mtime may have
	// drifted since the cache was written, e.g. after a git checkout).
	if (!fs.existsSync(OCR_CACHE_DIR)) return null;
	const prefix = `${path.basename(filePath)}_`;
	const candidates = fs.readdirSync(OCR_CACHE_DIR)
		.filter(n => n.startsWith(prefix) && n.endsWith('.json'))
		.map(n => ({ abs: path.join(OCR_CACHE_DIR, n), mtimeMs: fs.statSync(path.join(OCR_CACHE_DIR, n)).mtimeMs }))
		.sort((a, b) => b.mtimeMs - a.mtimeMs);
	if (!candidates.length) return null;
	try { return JSON.parse(fs.readFileSync(candidates[0].abs, 'utf8')); } catch { return null; }
}

async function callOcrServer(filePath) {
	const res = await fetch(`${OCR_SERVER_URL}/ocr`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ path: path.resolve(filePath) }),
		signal: AbortSignal.timeout(OCR_TIMEOUT_MS),
	});
	const data = await res.json();
	if (!res.ok || !data?.ok) throw new Error(`OCR failed: ${data?.error || res.status}`);
	return Array.isArray(data.lines) ? data.lines : [];
}

/** --lines-dir=<dir>: read OCR lines from <dir>/<image name>.json (a dump
 * made at a specific det limit / model) instead of the cache/ocr lookup. */
let LINES_DIR = null;

async function getLines(filePath) {
	let raw = LINES_DIR ? readDumpedLines(filePath) : findCachedLines(filePath);
	if (!raw) {
		raw = await callOcrServer(filePath);
		fs.mkdirSync(OCR_CACHE_DIR, { recursive: true });
		fs.writeFileSync(path.join(OCR_CACHE_DIR, `${getOcrCacheKey(filePath)}.json`), JSON.stringify(raw), 'utf8');
	}
	return raw
		.map(l => ({ text: String(l.text || '').trim(), confidence: l.confidence, box: Array.isArray(l.box) && l.box.length >= 4 ? l.box : null }))
		.filter(l => l.text && l.box && !NOISE_LINE_RE.test(l.text))
		.map(l => ({ ...l, ...geom(l.box) }));
}

// image name -> names of its byte-identical copies (filled in main). The dump
// holds lines for whichever copy was canonical when it was made; a label fix
// can make another copy canonical, and its lines are the same.
const SAME_CONTENT = new Map();

function readDumpedLines(filePath) {
	const base = path.basename(filePath);
	for (const name of [base, ...(SAME_CONTENT.get(base) || [])]) {
		const f = path.join(LINES_DIR, `${name}.json`);
		if (fs.existsSync(f)) return JSON.parse(fs.readFileSync(f, 'utf8'));
	}
	throw new Error(`no dumped OCR lines at ${path.join(LINES_DIR, `${base}.json`)} (or any identical copy)`);
}

function sanitizeSegment(s) {
	return String(s || '').replace(/[^A-Za-z0-9_.-]/g, '_');
}

/** Drop rows that are clearly not table-data rows: rows whose text sits
 * entirely outside the table's horizontal span (stray annotations, page
 * furniture, a decorative reference calendar some layouts print below the
 * table). This keeps the header-to-marker slice aligned with the *visible*
 * table rows a human would have transcribed, without ever inventing values.
 *
 * Note on approach: a date-anchor-based row splitter (using the one column
 * guaranteed to appear exactly once per row) was tried to fix dense layouts
 * where y-overlap grouping glues two real rows together, but it scored
 * *worse* in practice — real images have missed OCR detections and stray
 * decorative content that break a strict one-anchor-per-row assumption more
 * often than y-overlap grouping merges rows. The plain y-overlap grouping
 * (mirrored from the former services/parser-learner.js (removed 2026-10-06)) plus the strict row-count
 * safety net below already discards the merged-row cases as mismatches, so
 * it errs on the side of skipping rather than mislabeling. Keeping it simple
 * here on purpose — revisit only with a larger before/after sample. */
function isNoiseRow(row, columns) {
	const margin = 40;
	const inSpan = row.lines.some(l => l.x1 >= columns.tableLeft - margin && l.x0 <= columns.arrRight + margin);
	return !inSpan;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const FIELD_COLUMNS = ['duty', 'dep', 'begin', 'end', 'arr'];

// ---------------------------------------------------------------------------
// Pairing detected table rows with label rows.
//
// The original rule — use a section only when detected-row-count equals
// label-row-count — threw away almost every planned section (1/130 matched;
// planned rows are ~2/3 of all labeled rows): the small planned table loses
// or fuses a few rows to OCR, so counts almost never agree exactly.
//
// Anchor + gap pairing keeps the same "never guess" guarantee but works per
// stretch of the table instead of per section:
//   1. A detected row whose OCR text contains a date equal to a label row's
//      date (first occurrence of that date in the labels) is an ANCHOR: the
//      date is verified by two independent sources, so that pair is trusted.
//   2. Between two consecutive anchors, the rows in between are paired
//      positionally ONLY if the detected count equals the label count for
//      that stretch (multi-sector days have several label rows under one
//      date). Otherwise that stretch is skipped.
//   3. Rows far taller than a normal row are fused rows (two real rows glued
//      by y-overlap) and are never used: their crop would show two rows.
// Rows are never matched by how similar their text is to the label, which
// would bias training towards cells the stock OCR already reads correctly.
// ---------------------------------------------------------------------------

const MONTH_KEYS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

function dateKeyFromText(text) {
	const m = String(text || '').match(/(\d{1,2})\s*([A-Za-z]{3})[A-Za-z]*\.?\s*['’]?(\d{2,4})(?!\d)/);
	if (!m) return null;
	const mon = m[2].toLowerCase();
	if (!MONTH_KEYS.includes(mon)) return null;
	return `${Number(m[1])}|${mon}|${m[3].slice(-2)}`;
}

function rowDateKey(row) {
	for (const l of row.lines) {
		const k = dateKeyFromText(l.text);
		if (k) return k;
	}
	return null;
}

/**
 * @param {Array} detectedRows table rows in reading order (headers/marker/noise already removed)
 * @param {Array<{labelRow:object, sectionName:string, r:number}>} labelSeq published then planned label rows
 * @returns {{ paired: Array<{row, labelRow, sectionName, r}>, anchors: number }}
 */
function pairRowsByDateAnchor(detectedRows, labelSeq) {
	const heights = detectedRows.map(r => r.h).sort((a, b) => a - b);
	const medH = heights.length ? heights[Math.floor(heights.length / 2)] : 0;
	const fused = (row) => medH > 0 && row.h > medH * 1.8;

	const detKeys = detectedRows.map(rowDateKey);
	const labelKeys = labelSeq.map(l => dateKeyFromText(String(l.labelRow.date || '')));
	const firstLabelForKey = new Map();
	labelKeys.forEach((k, j) => { if (k && !firstLabelForKey.has(k)) firstLabelForKey.set(k, j); });

	// Anchors: label rows that start a date, matched to the first detected row (after the previous anchor) with that date.
	const anchors = [];
	let lastI = -1;
	for (let j = 0; j < labelSeq.length; j += 1) {
		const k = labelKeys[j];
		if (!k || firstLabelForKey.get(k) !== j) continue;
		let found = -1;
		for (let i = lastI + 1; i < detectedRows.length; i += 1) {
			if (detKeys[i] === k) { found = i; break; }
		}
		if (found === -1) continue;
		anchors.push({ i: found, j });
		lastI = found;
	}

	const paired = [];
	const push = (i, j) => {
		const row = detectedRows[i];
		if (!row || fused(row)) return;
		paired.push({ row, labelRow: labelSeq[j].labelRow, sectionName: labelSeq[j].sectionName, r: labelSeq[j].r });
	};
	for (const a of anchors) push(a.i, a.j);

	const bounds = [{ i: -1, j: -1 }, ...anchors, { i: detectedRows.length, j: labelSeq.length }];
	for (let n = 0; n + 1 < bounds.length; n += 1) {
		const di = bounds[n + 1].i - bounds[n].i - 1;
		const dj = bounds[n + 1].j - bounds[n].j - 1;
		if (di !== dj || di <= 0) continue;
		for (let t = 1; t <= di; t += 1) push(bounds[n].i + t, bounds[n].j + t);
	}
	return { paired, anchors: anchors.length };
}

// ---------------------------------------------------------------------------
// The date/day cell as it is actually printed in this row.
//
// Two facts found by checking anchor-paired crops against the recognizer
// (2026-09-24), both of which made the old date/day and duty crops wrong on
// planned rows:
//   * Planned rows print "Mon 3 Feb 20" (weekday FIRST, year further right)
//     while published rows print "3 Feb 20 Mon". The old crop always ended at
//     the duty column boundary (cutting the year off planned dates, and that
//     year then bled into the duty crop as a stray "20") and always labeled
//     the crop "date day", so planned dateday labels never matched the pixels.
//   * Second and later sectors of a day have no date printed at all, yet were
//     labeled with the carried-forward date, teaching the model to invent text.
// So: the dateday crop is emitted only for rows whose date is really visible,
// ends where the printed date ends, and its label follows the printed order.
// The duty crop starts after the date text; a row whose date line is glued to
// other cells ("23 Feb 20OFF(Z)") gets no duty/dateday crop — the boundary
// isn't known, so it isn't guessed.
// ---------------------------------------------------------------------------

const WD = 'mon|tue|wed|thu|fri|sat|sun';
const DATE_TEXT = String.raw`\d{1,2}\s*[a-z]{3}[a-z]*\.?\s*['’]?\d{2,4}`;
const DATE_CELL_RE = new RegExp(String.raw`^(?:(?:${WD})[a-z]*[.,\s]*)?${DATE_TEXT}(?:[.,\s]*(?:${WD})[a-z]*)?$`, 'i');
const BARE_WEEKDAY_RE = new RegExp(String.raw`^(?:${WD})[a-z]*\.?$`, 'i');
const WEEKDAY_START_RE = new RegExp(String.raw`^(?:${WD})`, 'i');

/** @returns {null | {glued: true} | {glued: false, x1: number, weekdayFirst: boolean, hasWeekday: boolean}} null = no date printed on this row */
function visibleDateCell(row, columns) {
	let dateLine = null;
	for (const l of row.lines) {
		if (l.x0 > columns.dutyRight) continue;
		if (dateKeyFromText(l.text)) { dateLine = l; break; }
	}
	if (!dateLine) return null;
	const text = dateLine.text.trim();
	if (!DATE_CELL_RE.test(text)) return { glued: true };

	let x1 = dateLine.x1;
	let hasWeekday = new RegExp(String.raw`(?:${WD})`, 'i').test(text);
	let weekdayFirst = WEEKDAY_START_RE.test(text);
	if (!hasWeekday) {
		// weekday may be its own OCR box next to the date
		const wd = row.lines.find(l => l !== dateLine && l.x0 <= columns.dutyRight && BARE_WEEKDAY_RE.test(l.text.trim()));
		if (wd) {
			hasWeekday = true;
			weekdayFirst = wd.x0 < dateLine.x0;
			x1 = Math.max(x1, wd.x1);
		}
	}
	return { glued: false, x1, weekdayFirst, hasWeekday };
}

function titleCase(s) {
	const t = String(s || '').trim();
	return t ? t[0].toUpperCase() + t.slice(1).toLowerCase() : '';
}

/** Fraction of `line`'s area that falls inside `box` — used to decide
 * whether a candidate "general text" line is really just one of the field
 * cells we already cropped (skip it) or genuinely different content (keep
 * it, so the model doesn't forget how to read it). */
function overlapFraction(line, box) {
	const ix0 = Math.max(line.x0, box.left), ix1 = Math.min(line.x1, box.left + box.width);
	const iy0 = Math.max(line.y0, box.top), iy1 = Math.min(line.y1, box.top + box.height);
	const iw = Math.max(0, ix1 - ix0), ih = Math.max(0, iy1 - iy0);
	const lineArea = Math.max(1, (line.x1 - line.x0) * (line.y1 - line.y0));
	return (iw * ih) / lineArea;
}

const GENERAL_TEXT_RE = /[A-Za-z0-9]{2,}/;

/** Date-like text ("17Jun20", "3Mar20") is excluded from general-text replay.
 * Found 2026-09-21: most cached OCR for these short digit-letter-digit runs
 * had already dropped the spaces (stale cache from much older OCR runs, or
 * just a pattern this model type merges more readily than prose) — 42/44
 * date-like samples in one build had no spaces at all. Training on that
 * silently taught the model dates don't need spaces, which then broke
 * roster-parser.js's date regex (needs "17 Jun 20") and zeroed out row
 * extraction on nearly every image. There's no verified ground truth for
 * dates here anyway (date/day were already excluded from the 5 trained
 * field columns for the same fuzzy-boundary reason), so just leave this
 * pattern out of replay entirely rather than risk more bad pseudo-labels. */
const DATE_LIKE_RE = /\d{1,2}\s*[A-Za-z]{2,9}\s*['’]?\d{2,4}\b/;

/** The two table titles, with the single-character slips the stock OCR makes
 * on them ("IHE", "OE"). A slip-only match is relabeled with the true title —
 * the pixels show the full title, only the stock reading was off. Anything
 * looser ("E REST OF…", "RESTOF THISROSTER") is dropped: the detected box may
 * really be missing characters or spaces, so the canonical text can't be
 * assumed to match it. */
const TABLE_TITLES = [
	{ re: /^[TI1]HE REST O[FE] THIS ROSTER IS PLANNED$/i, text: 'THE REST OF THIS ROSTER IS PLANNED' },
	{ re: /^PUBLISHED ROSTER$/i, text: 'PUBLISHED ROSTER' },
];

function canonicalTitle(text) {
	const t = String(text || '').trim().replace(/\s+/g, ' ');
	const hit = TABLE_TITLES.find(x => x.re.test(t));
	return hit ? hit.text : null;
}

/** Scope of --general=table: the user only extracts row events from the
 * "PUBLISHED ROSTER" and "THE REST OF THIS ROSTER IS PLANNED" tables, so
 * replay only needs text the parser actually reads there — the two titles
 * (section markers), the column header row (column boundaries) and cells
 * inside the table band that weren't already covered by a verified field
 * crop. The sidebar help text and the expiry/checks table are left out. */
function tableRegion(rows, headerIdx, columns) {
	const header = rows[headerIdx];
	// The expiry/checks table below the roster is dated too ("25 Jul 19") but
	// never carries a weekday, and starts with an "Expiry Date"/"Code" header.
	let after = rows.slice(headerIdx + 1).filter(r => !isNoiseRow(r, columns));
	const stop = after.findIndex(r => r.lines.some(l => /^(checks?|expiry date|issue date|code)$/i.test(l.text.trim())));
	if (stop !== -1) after = after.slice(0, stop);
	const hasWeekday = (r) => r.lines.some(l => new RegExp(String.raw`\b(?:${WD})`, 'i').test(l.text));
	const dated = after.filter(r => rowDateKey(r) && hasWeekday(r));
	const heights = after.map(r => r.h).sort((a, b) => a - b);
	const medH = heights.length ? heights[Math.floor(heights.length / 2)] : header.h;
	const lastDated = dated.length ? dated[dated.length - 1].y1 : header.y1;
	return {
		x0: columns.tableLeft - 20,
		x1: columns.arrRight + 20,
		y0: header.y0 - 2,
		// trailing sectors of the last day carry no date — allow a few rows
		y1: stop !== -1 ? Math.min(lastDated + medH * 4, after.length ? after[after.length - 1].y1 : lastDated) : lastDated + medH * 4,
	};
}

function isInsideRegion(line, region) {
	const xc = (line.x0 + line.x1) / 2;
	return xc >= region.x0 && xc <= region.x1 && line.yc >= region.y0 && line.yc <= region.y1;
}

async function main() {
	const args = parseArgs(process.argv.slice(2));
	if (args.linesDir) LINES_DIR = path.resolve(ROOT, args.linesDir);
	const outDir = path.join(ROOT, 'exports', 'recognition-groundtruth', args.id);
	for (const split of ['train', 'val']) fs.mkdirSync(path.join(outDir, 'images', split), { recursive: true });

	let images = fs.readdirSync(FAKE_DATA_DIR, { withFileTypes: true })
		.filter(d => d.isFile() && /\.(jpe?g|png|jfif)$/i.test(d.name))
		.map(d => d.name)
		.filter(name => fs.existsSync(path.join(LABELS_DIR, `${name}.json`)));

	// fake-data/ contains many byte-identical copies of the same screenshot,
	// labeled separately (and not always identically). Keep ONE copy per image
	// (see utils/content-groups.js) and split train/val by content group so a
	// copy can never sit in train while its twin is scored in val.
	const groups = groupByContent(FAKE_DATA_DIR, images);
	const { canonical, conflicts } = pickCanonicalLabels(groups, LABELS_DIR);
	const groupOf = new Map();
	for (const [id, members] of groups) for (const m of members) groupOf.set(m, id);
	for (const members of groups.values()) for (const m of members) SAME_CONTENT.set(m, members.filter(x => x !== m));
	const keep = new Set(canonical.values());
	// --folds=K --fold=i: val = fold i of a K-fold split by near-duplicate
	// roster cluster (utils/content-groups.js rosterClusters) instead of the
	// content-hash --train-ratio split, which leaks overlapping weekly rosters.
	let foldOfGroup = null;
	if (args.folds) {
		if (!(args.fold >= 0 && args.fold < args.folds)) throw new Error(`--fold must be 0..${args.folds - 1}`);
		foldOfGroup = assignFolds(rosterClusters(canonical, LABELS_DIR), args.folds);
	}
	const foldMap = args.foldMap ? JSON.parse(fs.readFileSync(path.resolve(ROOT, args.foldMap), 'utf8')) : null;
	if (foldMap && !args.folds) throw new Error('--fold-map needs --folds/--fold');
	const splitOf = (fileName) => foldMap
		? (foldMap[fileName] === args.fold ? 'val' : 'train')
		: foldOfGroup
			? (foldOfGroup.get(groupOf.get(fileName)) === args.fold ? 'val' : 'train')
			: splitByGroup(groupOf.get(fileName), args.trainRatio);
	const duplicatesDropped = images.length - keep.size;
	images = images.filter(name => keep.has(name));
	console.log(`Deduplicated by content: ${duplicatesDropped} duplicate copies dropped -> ${images.length} unique images` +
		(conflicts.length ? `; ${conflicts.length} groups had disagreeing labels (see manifest.json labelConflicts)` : ''));
	if (args.maxImages) images = images.slice(0, args.maxImages);

	// Snapshot of every label file this build actually read, keyed by image
	// name -> label mtime. scripts/check-retrain-status.mjs diffs this
	// against the live labels/ directory later to answer "is there enough
	// new/changed data to be worth a retrain yet?" — mirrors the pattern
	// the former services/parser-learner.js (removed 2026-10-06) already uses (processedFiles/fileModTimes)
	// for parser calibration, just for the recognition dataset instead.
	const labelSnapshot = {};
	for (const name of images) {
		try { labelSnapshot[name] = fs.statSync(path.join(LABELS_DIR, `${name}.json`)).mtime.toISOString(); } catch { /* skip */ }
	}

	console.log(`Building recognition ground-truth from ${images.length} labeled images...`);

	const listLines = { train: [], val: [] };
	const stats = { images: images.length, noHeader: 0, noColumns: 0, publishedMatched: 0, publishedSkippedCountMismatch: 0, plannedMatched: 0, plannedSkippedCountMismatch: 0, cropsWritten: 0, cropsEmptyValue: 0, perField: Object.fromEntries(FIELD_COLUMNS.map(f => [f, 0])), anchorRows: 0, cropsSkippedGlued: 0, datedaySkippedNoDate: 0, labelRowsTotal: { published: 0, planned: 0 }, labelRowsPaired: { published: 0, planned: 0 }, generalCrops: 0, generalTrain: 0, generalVal: 0, tightCrops: 0, tightPerField: {} };

	for (const fileName of images) {
		const imagePath = path.join(FAKE_DATA_DIR, fileName);
		let label;
		try { label = JSON.parse(fs.readFileSync(path.join(LABELS_DIR, `${fileName}.json`), 'utf8')); } catch { continue; }
		const published = Array.isArray(label.published) ? label.published : [];
		const planned = Array.isArray(label.planned) ? label.planned : [];

		let lines;
		try { lines = await getLines(imagePath); } catch (err) {
			console.log(`  [skip] ${fileName}: OCR failed (${err.message})`);
			continue;
		}
		if (!lines.length) continue;

		const rows = groupRows(lines);
		const headerIdx = rows.findIndex(isHeaderRow);
		if (headerIdx === -1) { stats.noHeader += 1; continue; }
		const columns = computeColumnRanges(rows[headerIdx]);
		if (!columns) { stats.noColumns += 1; continue; }
		let plannedMarkerIdx = rows.findIndex((r, i) => i > headerIdx && r.lines.some(l => PLANNED_MARKER_RE.test(l.text)));
		if (plannedMarkerIdx === -1) plannedMarkerIdx = rows.length;

		const publishedRows = rows.slice(headerIdx + 1, plannedMarkerIdx).filter(r => !isNoiseRow(r, columns));
		const plannedRows = (plannedMarkerIdx < rows.length ? rows.slice(plannedMarkerIdx + 1) : []).filter(r => !isNoiseRow(r, columns));

		const meta = await sharp(imagePath).metadata();
		const imgW = meta.width || 0, imgH = meta.height || 0;
		const split = splitOf(fileName);
		const fieldBoxes = [];

		async function emitPairs(pairs) {
			for (const { row, labelRow, sectionName, r } of pairs) {
				const top = Math.max(0, Math.floor(row.y0) - args.pad);
				const bottom = Math.min(imgH, Math.ceil(row.y1) + args.pad);
				const height = bottom - top;
				if (height <= 0) continue;

				const dateCell = visibleDateCell(row, columns);
				let dutyLeft = columns.dutyLeft;
				if (dateCell && !dateCell.glued) dutyLeft = Math.max(dutyLeft, Math.ceil(dateCell.x1) + 2);

				for (const field of FIELD_COLUMNS) {
					const text = String(labelRow[field] || '').trim();
					if (!text) { stats.cropsEmptyValue += 1; continue; }
					if (field === 'duty' && dateCell?.glued) { stats.cropsSkippedGlued += 1; continue; }
					const left = Math.max(0, Math.floor(field === 'duty' ? dutyLeft : columns[`${field}Left`]));
					const right = Math.min(imgW, Math.ceil(columns[`${field}Right`]));
					const width = right - left;
					if (width <= 0) continue;
					fieldBoxes.push({ left, top, width, height });

					const cropRel = path.join('images', split, `${sanitizeSegment(fileName)}_${sectionName}${r}_${field}.jpg`).replace(/\\/g, '/');
					const cropAbs = path.join(outDir, cropRel);
					try {
						await sharp(imagePath).extract({ left, top, width, height }).jpeg({ quality: 95 }).toFile(cropAbs);
						listLines[split].push(`${cropRel}\t${text}`);
						stats.cropsWritten += 1;
						stats.perField[field] += 1;
					} catch {
						// Skip malformed boxes quietly; one bad row shouldn't abort the run.
					}
				}

				// date+day share one visual cell in this template ("17 Jan 20 Fri"),
				// with a fuzzy left boundary (shares space with row furniture in some
				// layouts) — that's why they were left out of FIELD_COLUMNS entirely
				// at first. Excluding them from training altogether turned out to be
				// the wrong call: it let the fine-tuned model's date/day accuracy
				// regress well below the stock model's (measured via a real benchmark
				// run 2026-09-21: date 60.6%→26.0%, day 61.4%→31.0%), because it no
				// longer got any *verified* date/day supervision — only the
				// (correctly excluded, since unverifiable) general-text replay saw
				// date-like text at all. Cropping the whole tableLeft..dutyLeft band
				// and labeling it with the row's real `${date} ${day}` is fuzzier
				// than the other 5 columns but still genuine ground truth, unlike
				// leaving the model with no signal for this region at all.
				// Only rows whose date is really printed (and not glued to the duty
				// cell) get a crop; the label follows the printed order/casing —
				// see visibleDateCell above.
				const dateStr = String(labelRow.date || '').trim();
				const dayStr = titleCase(labelRow.day);
				let dateDayText = '';
				if (dateStr && dateCell && !dateCell.glued) {
					dateDayText = !dateCell.hasWeekday || !dayStr ? dateStr
						: dateCell.weekdayFirst ? `${dayStr} ${dateStr}` : `${dateStr} ${dayStr}`;
				} else if (dateStr && dateCell?.glued) {
					stats.cropsSkippedGlued += 1;
				} else if (dateStr) {
					stats.datedaySkippedNoDate += 1;
				}
				if (dateDayText) {
					const left = Math.max(0, Math.floor(columns.tableLeft));
					const right = Math.min(imgW, Math.ceil(dateCell.x1) + 2);
					const width = right - left;
					if (width > 0) {
						fieldBoxes.push({ left, top, width, height });
						const cropRel = path.join('images', split, `${sanitizeSegment(fileName)}_${sectionName}${r}_dateday.jpg`).replace(/\\/g, '/');
						const cropAbs = path.join(outDir, cropRel);
						try {
							await sharp(imagePath).extract({ left, top, width, height }).jpeg({ quality: 95 }).toFile(cropAbs);
							listLines[split].push(`${cropRel}\t${dateDayText}`);
							stats.cropsWritten += 1;
							stats.perField.dateday = (stats.perField.dateday || 0) + 1;
						} catch {
							// Skip malformed boxes quietly.
						}
					}
				} else {
					stats.cropsEmptyValue += 1;
				}

				if (args.tightCrops) await emitTightCrops({ row, labelRow, sectionName, r, dateCell, dateDayText, dutyLeft });
			}
		}

		// --tight-crops: at inference the recognizer sees the DETECTOR's tight
		// box around a cell, not the padded column band above. Training only on
		// column bands left the model unsure about box edges — the table-only
		// model dropped the closing ")" of OFF(Z) on ~480 tight boxes
		// (2026-09-29). So also crop each detected box that sits alone inside one
		// column of a paired row and label it with that column's ground truth.
		// Two boxes in one column (split cell) or a box straddling columns is
		// skipped, except the frequent begin+end merged box, labeled
		// "<begin> <end>" (the parser splits it via canonicalizeTimes).
		async function emitTightCrops({ row, labelRow, sectionName, r, dateCell, dateDayText, dutyLeft }) {
			const cols = [
				['duty', dutyLeft, columns.dutyRight],
				['dep', columns.depLeft, columns.depRight],
				['begin', columns.beginLeft, columns.beginRight],
				['end', columns.endLeft, columns.endRight],
				['arr', columns.arrLeft, columns.arrRight],
			];
			const SLACK = 6;
			const inside = (l, a, b) => l.x0 >= a - SLACK && l.x1 <= b + SLACK;
			const centerIn = (l, a, b) => { const xc = (l.x0 + l.x1) / 2; return xc >= a && xc < b; };
			const targets = [];
			for (const [field, a, b] of cols) {
				const text = String(labelRow[field] || '').trim();
				if (!text) continue;
				const hits = row.lines.filter(l => centerIn(l, a, b));
				if (hits.length === 1 && inside(hits[0], a, b)) targets.push({ field, line: hits[0], text });
			}
			const begin = String(labelRow.begin || '').trim(), end = String(labelRow.end || '').trim();
			if (begin && end) {
				const merged = row.lines.filter(l => l.x0 >= columns.beginLeft - SLACK && l.x0 < columns.beginRight && l.x1 > columns.endLeft && l.x1 <= columns.endRight + SLACK);
				const others = row.lines.filter(l => !merged.includes(l) && centerIn(l, columns.beginLeft, columns.endRight));
				if (merged.length === 1 && !others.length) targets.push({ field: 'beginend', line: merged[0], text: `${begin} ${end}` });
			}
			if (dateDayText && dateCell && !dateCell.glued) {
				// only when the whole printed date cell is one box
				const dl = row.lines.filter(l => l.x0 <= columns.dutyRight && dateKeyFromText(l.text));
				if (dl.length === 1 && DATE_CELL_RE.test(dl[0].text.trim()) && (!dateCell.hasWeekday || new RegExp(WD, 'i').test(dl[0].text))) {
					targets.push({ field: 'dateday', line: dl[0], text: dateDayText });
				}
			}
			for (const { field, line, text } of targets) {
				const left = Math.max(0, Math.floor(line.x0) - args.pad);
				const top = Math.max(0, Math.floor(line.y0) - args.pad);
				const width = Math.min(imgW - left, Math.ceil(line.x1 - line.x0) + args.pad * 2);
				const height = Math.min(imgH - top, Math.ceil(line.y1 - line.y0) + args.pad * 2);
				if (width <= 0 || height <= 0) continue;
				const cropRel = path.join('images', split, `${sanitizeSegment(fileName)}_${sectionName}${r}_${field}_tight.jpg`).replace(/\\/g, '/');
				try {
					await sharp(imagePath).extract({ left, top, width, height }).jpeg({ quality: 95 }).toFile(path.join(outDir, cropRel));
					listLines[split].push(`${cropRel}\t${text}`);
					stats.tightCrops += 1;
					stats.tightPerField[field] = (stats.tightPerField[field] || 0) + 1;
				} catch {
					// Skip malformed boxes quietly.
				}
			}
		}

		let pairs;
		if (args.legacyMatch) {
			// Old behaviour: a section is used only if its detected row count equals
			// its label row count exactly.
			pairs = [];
			for (const [sectionName, sectionRows, labelRows] of [['published', publishedRows, published], ['planned', plannedRows, planned]]) {
				if (sectionRows.length !== labelRows.length) {
					if (sectionName === 'published') stats.publishedSkippedCountMismatch += 1; else stats.plannedSkippedCountMismatch += 1;
					continue;
				}
				if (sectionName === 'published') stats.publishedMatched += 1; else stats.plannedMatched += 1;
				sectionRows.forEach((row, r) => pairs.push({ row, labelRow: labelRows[r], sectionName, r }));
			}
		} else {
			const tableRows = rows.slice(headerIdx + 1)
				.filter(r => !isNoiseRow(r, columns) && !isHeaderRow(r) && !r.lines.some(l => PLANNED_MARKER_RE.test(l.text)));
			const labelSeq = [
				...published.map((labelRow, r) => ({ labelRow, sectionName: 'published', r })),
				...planned.map((labelRow, r) => ({ labelRow, sectionName: 'planned', r })),
			];
			const { paired, anchors } = pairRowsByDateAnchor(tableRows, labelSeq);
			pairs = paired;
			stats.anchorRows += anchors;
			for (const sec of ['published', 'planned']) {
				const total = labelSeq.filter(l => l.sectionName === sec).length;
				const got = paired.filter(p => p.sectionName === sec).length;
				stats.labelRowsTotal[sec] += total;
				stats.labelRowsPaired[sec] += got;
			}
		}
		await emitPairs(pairs);

		// General-text replay: without this, fine-tuning only ever shows the
		// model duty/dep/begin/end/arr crops, and it drifts away from reading
		// everything else in the document (titles, dates, names) — verified
		// empirically across three fine-tuning runs on 2026-09-21 (narrow-val
		// accuracy went up while real full-page OCR quality on non-table text
		// visibly degraded). Labeling these crops with the *stock* model's own
		// high-confidence predictions (not a fine-tuned one — cache/ocr/*.json
		// predates any fine-tuning in this project) anchors the model back to
		// its original general-text behavior while it adapts to duty codes.
		if (!args.noGeneral) {
			const region = args.general === 'table' ? tableRegion(rows, headerIdx, columns) : null;
			const candidates = lines
				.map(l => {
					if (!region) return l;
					const title = canonicalTitle(l.text);
					if (title) return { ...l, text: title, isTitle: true };
					// a title-like line that isn't a clean match is ambiguous — drop it
					if (/roster|planned/i.test(l.text)) return null;
					return isInsideRegion(l, region) ? l : null;
				})
				.filter(Boolean)
				.filter(l => (l.isTitle || l.confidence >= args.generalMinConfidence) && l.text.length >= 2 && l.text.length <= 60 && GENERAL_TEXT_RE.test(l.text))
				.filter(l => !DATE_LIKE_RE.test(l.text))
				.filter(l => !fieldBoxes.some(box => overlapFraction(l, box) > 0.3))
				.sort((a, b) => (b.isTitle ? 1 : 0) - (a.isTitle ? 1 : 0) || b.confidence - a.confidence)
				.slice(0, args.generalMaxPerImage);

			for (let gi = 0; gi < candidates.length; gi += 1) {
				const l = candidates[gi];
				const left = Math.max(0, Math.floor(l.x0) - args.pad);
				const top = Math.max(0, Math.floor(l.y0) - args.pad);
				const width = Math.min(imgW - left, Math.ceil(l.x1 - l.x0) + args.pad * 2);
				const height = Math.min(imgH - top, Math.ceil(l.y1 - l.y0) + args.pad * 2);
				if (width <= 0 || height <= 0) continue;

				const cropRel = path.join('images', split, `${sanitizeSegment(fileName)}_general${gi}.jpg`).replace(/\\/g, '/');
				const cropAbs = path.join(outDir, cropRel);
				try {
					await sharp(imagePath).extract({ left, top, width, height }).jpeg({ quality: 95 }).toFile(cropAbs);
					listLines[split].push(`${cropRel}\t${l.text}`);
					stats.generalCrops += 1;
					if (split === 'train') stats.generalTrain += 1; else stats.generalVal += 1;
				} catch {
					// Skip malformed boxes quietly.
				}
			}
		}
	}

	fs.writeFileSync(path.join(outDir, 'train_list.txt'), listLines.train.join('\n') + (listLines.train.length ? '\n' : ''), 'utf8');
	fs.writeFileSync(path.join(outDir, 'val_list.txt'), listLines.val.join('\n') + (listLines.val.length ? '\n' : ''), 'utf8');
	fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify({ createdAt: new Date().toISOString(), args, stats, dedupe: { duplicatesDropped, uniqueImages: images.length }, labelConflicts: conflicts, train: listLines.train.length, val: listLines.val.length, labelSnapshot }, null, 2), 'utf8');

	console.log('\nGround-truth build complete');
	console.log(`  Output dir: ${outDir}`);
	console.log(`  Images scanned: ${stats.images}  |  no header detected: ${stats.noHeader}  |  no column boundaries: ${stats.noColumns}`);
	console.log(`  Published sections matched/skipped(count-mismatch): ${stats.publishedMatched}/${stats.publishedSkippedCountMismatch}`);
	console.log(`  Planned   sections matched/skipped(count-mismatch): ${stats.plannedMatched}/${stats.plannedSkippedCountMismatch}`);
	if (!args.legacyMatch) {
		const L = stats.labelRowsTotal, P = stats.labelRowsPaired;
		console.log(`  Anchor+gap pairing: ${stats.anchorRows} date anchors; label rows paired published ${P.published}/${L.published}, planned ${P.planned}/${L.planned}`);
	}
	console.log(`  Field crops: ${stats.cropsWritten}, empty-value skips: ${stats.cropsEmptyValue}`);
	console.log(`  Skipped (date glued to duty cell): ${stats.cropsSkippedGlued}, dateday skipped (no date printed on row): ${stats.datedaySkippedNoDate}`);
	console.log(`  Per field: ${FIELD_COLUMNS.map(f => `${f}=${stats.perField[f]}`).join(', ')}, dateday=${stats.perField.dateday || 0}`);
	console.log(`  General-text crops (replay, labeled with stock OCR's own text): ${stats.generalCrops}`);
	if (args.tightCrops) console.log(`  Tight detector-box crops (ground-truth labels): ${stats.tightCrops} ${JSON.stringify(stats.tightPerField)}`);
	console.log(`  Total crops: ${stats.cropsWritten + stats.generalCrops + stats.tightCrops} (train ${listLines.train.length} / val ${listLines.val.length})`);
}

main().catch(err => { console.error(err); process.exit(1); });
