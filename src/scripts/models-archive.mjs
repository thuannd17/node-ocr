#!/usr/bin/env node
/**
 * Model files kept in MinIO under models/ (services/media-client.js), for what the app does not
 * download by itself: OCR training checkpoints (models/rec/<ver>/checkpoint/, ~750 MB, only needed
 * to resume a training run) or a model folder to archive. The AI roster model versions
 * (models/ai/) are synced by the app itself.
 *
 *   npm run models:archive -- list [models/<prefix>/]
 *   npm run models:archive -- push <local folder> models/<prefix>/     upload every file (same MD5: skipped)
 *   npm run models:archive -- pull models/<prefix>/ <local folder>     download them
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { listModelObjects, getModelObject, putModelObject } from '../services/media-client.js';

const [cmd, a, b] = process.argv.slice(2);
const md5 = (buf) => crypto.createHash('md5').update(buf).digest('hex');
const asPrefix = (p) => (String(p || '').replace(/\\/g, '/').replace(/\/?$/, '/'));
const mb = (n) => `${(n / 1048576).toFixed(1)} MB`;
const usage = () => { console.log('usage: models:archive -- list [models/<prefix>/] | push <folder> models/<prefix>/ | pull models/<prefix>/ <folder>'); process.exit(1); };

function walk(dir, out = []) {
  for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, d.name);
    if (d.isDirectory()) walk(p, out); else out.push(p);
  }
  return out;
}

if (cmd === 'list') {
  const objects = await listModelObjects(asPrefix(a || 'models'));
  for (const o of objects) console.log(`${mb(o.size).padStart(10)}  ${o.key}`);
  console.log(`${objects.length} objects, ${mb(objects.reduce((n, o) => n + o.size, 0))}`);
} else if (cmd === 'push') {
  if (!a || !b || !fs.existsSync(a)) usage();
  const prefix = asPrefix(b);
  const remote = new Map((await listModelObjects(prefix)).map(o => [o.key, o]));
  let sent = 0, skipped = 0, bytes = 0;
  for (const file of walk(path.resolve(a))) {
    const key = prefix + path.relative(path.resolve(a), file).split(path.sep).join('/');
    const buf = fs.readFileSync(file);
    // a large object is uploaded in parts: its ETag is not an MD5, so compare the size then
    const same = remote.get(key) && (remote.get(key).md5 === md5(buf) || (remote.get(key).md5.includes('-') && remote.get(key).size === buf.length));
    if (same) { skipped++; continue; }
    await putModelObject(key, buf);
    sent++; bytes += buf.length;
    console.log(`  ${mb(buf.length).padStart(10)}  ${key}`);
  }
  // check: every local file is there with its size
  const after = new Map((await listModelObjects(prefix)).map(o => [o.key, o]));
  const missing = walk(path.resolve(a)).filter(f => after.get(prefix + path.relative(path.resolve(a), f).split(path.sep).join('/'))?.size !== fs.statSync(f).size);
  console.log(`Uploaded ${sent} (${mb(bytes)}), ${skipped} already there.`);
  if (missing.length) { console.log(`CHECK FAILED: ${missing.length} not in MinIO:\n  ${missing.join('\n  ')}`); process.exit(1); }
  console.log(`Check passed: all files of ${a} are in MinIO under ${prefix}`);
} else if (cmd === 'pull') {
  if (!a || !b) usage();
  const prefix = asPrefix(a);
  const objects = await listModelObjects(prefix);
  if (!objects.length) { console.log(`Nothing under ${prefix}`); process.exit(1); }
  for (const o of objects) {
    const target = path.join(path.resolve(b), ...o.key.slice(prefix.length).split('/'));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, await getModelObject(o.key));
    console.log(`  ${mb(o.size).padStart(10)}  ${target}`);
  }
  console.log(`Downloaded ${objects.length} files into ${b}`);
} else usage();
