/**
 * Where roster files and their labels live (since 2026-10-13).
 *
 *   fake-data/<ext>/<guid>.<ext>        e.g. fake-data/jpg/1b9d6bcd-....jpg, fake-data/pdf/....pdf
 *   labels/<ext>/<guid>.<ext>.json      the verified label of that file
 *
 * A file is named by a GUID plus its extension, so a name is unique across all
 * folders and the folder follows from the extension: code passes names around
 * (APIs, caches, model metadata) and resolves paths only through here.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { WORK_DIR } from './paths.js';

/**
 * Since 2026-10-19 the roster data lives in MinIO (media/), not in this project.
 * Code that needs real files (OCR server, Python, training, benchmarks) reads a local mirror of it,
 * kept up to date by services/media-client.js (syncMedia): MEDIA_CACHE_DIR (default: <ROSTER_WORK_DIR>/media,
 * utils/paths.js), with the same layout as before:
 *   <cache>/files/<ext>/<name>          (was fake-data/<ext>/<name>)
 *   <cache>/labels/<ext>/<name>.json    (was labels/<ext>/<name>.json)
 * Write through media-client (storeFile, saveLabel, deleteFile), never to these folders directly.
 */
export const MEDIA_CACHE_DIR = path.resolve(process.env.MEDIA_CACHE_DIR || path.join(WORK_DIR, 'media'));
export const DATA_ROOT = path.join(MEDIA_CACHE_DIR, 'files');
export const LABELS_ROOT = path.join(MEDIA_CACHE_DIR, 'labels');
/** The ACARS pictures' mirror (services/media-client.js `acars`): <cache>/files/<ext>/<name>, <cache>/labels/<ext>/<name>.json */
export const ACARS_CACHE_DIR = path.resolve(process.env.ACARS_CACHE_DIR || path.join(WORK_DIR, 'acars'));
export const ACARS_DATA_ROOT = path.join(ACARS_CACHE_DIR, 'files');
export const ACARS_LABELS_ROOT = path.join(ACARS_CACHE_DIR, 'labels');

export const IMAGE_EXTS = ['jpg', 'jpeg', 'png', 'jfif', 'bmp'];
// Kind 'pdf' = a file read from its text, not by OCR: PDFs and rosters exported as
// CSV / Excel / plain text (services/table-text.js lays those out like a PDF page).
export const PDF_EXTS = ['pdf', 'csv', 'xls', 'xlsx', 'txt'];

/** 'jpg' for 'x.JPG' */
export const extOf = (name) => path.extname(String(name)).slice(1).toLowerCase();

export const kindOf = (name) => (PDF_EXTS.includes(extOf(name)) ? 'pdf' : IMAGE_EXTS.includes(extOf(name)) ? 'image' : null);

/** A plain file name of a known type (no folders, no '..'); guards every ?name= from a request. */
export const isDataName = (name) => !!name && path.basename(String(name)) === name && !!kindOf(name);

export const dataFile = (root, name) => path.join(root, extOf(name), name);

export const labelFile = (root, name) => path.join(root, extOf(name), `${name}.json`);

export const hasLabel = (root, name) => fs.existsSync(labelFile(root, name));

/** Name for a new file: '<guid>.<ext>' (ext lowercased, 'x.JPG' -> '....jpg'). */
export const newDataName = (originalName) => `${crypto.randomUUID()}.${extOf(originalName)}`;

/**
 * File names under root/<ext>/, sorted. kind: 'image' | 'pdf' | 'all'.
 * Only files whose extension matches their folder count, so dataFile() finds them again.
 */
export function listData(root, kind = 'all') {
	const exts = kind === 'image' ? IMAGE_EXTS : kind === 'pdf' ? PDF_EXTS : [...IMAGE_EXTS, ...PDF_EXTS];
	const names = [];
	for (const ext of exts) {
		const dir = path.join(root, ext);
		if (!fs.existsSync(dir)) continue;
		for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
			if (d.isFile() && extOf(d.name) === ext) names.push(d.name);
		}
	}
	return names.sort();
}

/** Names of root/<ext>/<name>.json labels, sorted. */
export function listLabels(root, kind = 'all') {
	const exts = kind === 'image' ? IMAGE_EXTS : kind === 'pdf' ? PDF_EXTS : [...IMAGE_EXTS, ...PDF_EXTS];
	const names = [];
	for (const ext of exts) {
		const dir = path.join(root, ext);
		if (!fs.existsSync(dir)) continue;
		for (const f of fs.readdirSync(dir)) {
			if (f.endsWith('.json') && extOf(f.slice(0, -5)) === ext) names.push(f.slice(0, -5));
		}
	}
	return names.sort();
}

/**
 * A label still waiting for a person's review: `_review: { by: 'user' | 'claude', at, ... }` (a correction a user
 * submitted on /roster or /acars, a change made by a script). Saving it on /label writes it without `_review`.
 * Such labels are left out of training, benchmarks and checks until then (listReviewedLabels).
 */
export function reviewOf(root, name, version) {
	try {
		// file lists ask this for every label: parse a label again only once it changed
		// (version: its md5 from the media index, which saves a stat per label)
		const file = labelFile(root, name);
		let key = version;
		if (!key) { const st = fs.statSync(file); key = `${st.mtimeMs}:${st.size}`; }
		const c = reviewCache.get(file);
		if (c && c.key === key) return c.review;
		const review = JSON.parse(fs.readFileSync(file, 'utf8'))._review || null;
		reviewCache.set(file, { key, review });
		return review;
	} catch { return null; }
}
const reviewCache = new Map(); // label path -> { key: md5 or mtime:size, review }

/** What a file list shows of a label waiting for review: { by, at, suggestion?, note? } (not the proposed rows), or null. */
export function reviewState(root, name, version) {
	const r = reviewOf(root, name, version);
	return r ? { by: r.by || 'user', at: r.at || null, ...(r.suggestion ? { suggestion: r.suggestion } : {}), ...(r.note ? { note: r.note } : {}), proposed: !!r.proposed } : null;
}

/** listLabels without the labels still waiting for review (reviewOf). */
export function listReviewedLabels(root, kind = 'all') {
	return listLabels(root, kind).filter(n => !reviewOf(root, n));
}
