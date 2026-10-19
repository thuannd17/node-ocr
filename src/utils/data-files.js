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
