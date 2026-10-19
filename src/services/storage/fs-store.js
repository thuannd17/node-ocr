// Folder-backed object store with the same interface as minio-store.js: keys are paths under root.
// For tests and for running without MinIO (MEDIA_BACKEND=fs, MEDIA_FS_DIR=<folder>).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const notFound = (key) => Object.assign(new Error(`Not found: ${key}`), { code: 'NotFound' });

export function createFsStore(root) {
  root = path.resolve(root);
  const md5Cache = new Map(); // abs path -> { key: mtime:size, md5 }
  const abs = (key) => {
    const p = path.resolve(root, key);
    if (!p.startsWith(root + path.sep)) throw new Error(`Bad key: ${key}`);
    return p;
  };
  const info = (key, p) => {
    const st = fs.statSync(p);
    const k = `${st.mtimeMs}:${st.size}`;
    let c = md5Cache.get(p);
    if (!c || c.key !== k) md5Cache.set(p, c = { key: k, md5: crypto.createHash('md5').update(fs.readFileSync(p)).digest('hex') });
    return { key, size: st.size, etag: c.md5, lastModified: st.mtime };
  };
  function walk(dir, out) {
    if (!fs.existsSync(dir)) return out;
    for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, d.name);
      if (d.isDirectory()) walk(p, out);
      else out.push(p);
    }
    return out;
  }
  return {
    describe: () => ({ backend: 'fs', dir: root }),
    check: async () => { fs.mkdirSync(root, { recursive: true }); },
    async list(prefix) {
      return walk(root, []).map(p => path.relative(root, p).split(path.sep).join('/'))
        .filter(k => k.startsWith(prefix)).sort().map(k => info(k, abs(k)));
    },
    async stat(key) {
      const p = abs(key);
      return fs.existsSync(p) ? info(key, p) : null;
    },
    async get(key) {
      const p = abs(key);
      if (!fs.existsSync(p)) throw notFound(key);
      return fs.readFileSync(p);
    },
    async put(key, buf) {
      const p = abs(key);
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, buf);
    },
    async remove(key) {
      fs.rmSync(abs(key), { force: true });
    },
  };
}
