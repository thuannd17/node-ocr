// /services/cache.js
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const CACHE_DIR = path.resolve(__dirname, '..', 'cache', 'vlm');

function ensureCacheDir() {
	if (!fs.existsSync(CACHE_DIR)) {
		fs.mkdirSync(CACHE_DIR, { recursive: true });
	}
}

/**
 * Tạo cache key SHA1 dựa trên nội dung ảnh + model + few-shot picks.
 * fewShot picks được đưa vào key để thay đổi examples tự invalidate cache.
 */
function makeKey(filePath, model, extra = '') {
	const abs = path.resolve(filePath);
	const hash = crypto.createHash('sha1');
	hash.update(abs);
	// Đưa thêm mtime để invalidated khi file thay đổi
	try {
		const stat = fs.statSync(abs);
		hash.update(String(stat.mtimeMs));
	} catch {
		// ignore
	}
	hash.update(model || '');
	hash.update(extra || '');
	return hash.digest('hex');
}

export function readCache(filePath, model, extra = '') {
	if (process.env.VLM_CACHE_ENABLED !== 'true') return null;
	try {
		ensureCacheDir();
		const key = makeKey(filePath, model, extra);
		const file = path.join(CACHE_DIR, `${key}.json`);
		if (!fs.existsSync(file)) return null;
		const raw = fs.readFileSync(file, 'utf8');
		return JSON.parse(raw);
	} catch {
		return null;
	}
}

export function writeCache(filePath, model, value, extra = '') {
	if (process.env.VLM_CACHE_ENABLED !== 'true') return;
	try {
		ensureCacheDir();
		const key = makeKey(filePath, model, extra);
		const file = path.join(CACHE_DIR, `${key}.json`);
		fs.writeFileSync(file, JSON.stringify(value, null, 2), 'utf8');
	} catch {
		// cache failure should never break extraction
	}
}
