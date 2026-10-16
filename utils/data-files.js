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
