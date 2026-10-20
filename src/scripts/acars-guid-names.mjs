// Rename every ACARS picture not yet named <uuid>.<ext> to one (and its label), in MinIO bucket acars-ocr.
// The old objects go to trash/<day>/<key>; the map old -> new is kept at trash/<day>/acars-rename-map.json
// and in <work>/acars-rename-map-<day>.json. Local caches keyed by the name are renamed too.
//   npm run acars:guid-names            # dry run: what would be renamed
//   npm run acars:guid-names -- --apply # do it (then the app's ACARS mirror catches up on its next sync)
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { storeFromEnv } from '../services/storage/index.js';
import { WORK_DIR } from '../utils/paths.js';
const apply = process.argv.includes('--apply');
const st = storeFromEnv(process.env, { bucket: process.env.ACARS_BUCKET || 'acars-ocr' });
const day = new Date().toISOString().slice(0, 10);
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.[a-z]+$/;
const TYPES = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', bmp: 'image/bmp', jfif: 'image/jpeg' };

const files = (await st.list('files/')).map(o => o.key.slice('files/'.length)).filter(n => !n.includes('/'));
const labels = new Set((await st.list('labels/')).map(o => o.key.slice('labels/'.length, -'.json'.length)));
const map = {};
for (const name of files.sort()) {
  if (GUID.test(name)) continue;
  const ext = path.extname(name).slice(1).toLowerCase();
  map[name] = `${crypto.randomUUID()}.${ext}`;
}
console.log(`${Object.keys(map).length} of ${files.length} pictures to rename (${files.length - Object.keys(map).length} already GUID)`);
if (!apply) { console.log(Object.entries(map).slice(0, 5)); process.exit(0); }

for (const [from, to] of Object.entries(map)) {
  const ext = path.extname(to).slice(1);
  const buf = await st.get(`files/${from}`);
  await st.put(`files/${to}`, buf, TYPES[ext] || 'application/octet-stream');
  if (labels.has(from)) {
    const lab = await st.get(`labels/${from}.json`);
    await st.put(`labels/${to}.json`, lab, 'application/json');
    await st.put(`trash/${day}/labels/${from}.json`, lab, 'application/json');
    await st.remove(`labels/${from}.json`);
  }
  await st.put(`trash/${day}/files/${from}`, buf, TYPES[ext] || 'application/octet-stream');
  await st.remove(`files/${from}`);
  console.log(`${from} -> ${to}${labels.has(from) ? ' (+label)' : ''}`);
}
const mapJson = Buffer.from(JSON.stringify(map, null, 2));
await st.put(`trash/${day}/acars-rename-map.json`, mapJson, 'application/json');
fs.writeFileSync(path.join(WORK_DIR, `acars-rename-map-${day}.json`), mapJson);

// local caches named after the picture: <name>.json, <name>.acars.lines.json, ...
let renamed = 0;
const walk = (dir) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (!['acars', 'recognition-groundtruth'].includes(e.name)) walk(p); continue; }
    const from = Object.keys(map).find(n => e.name.startsWith(n + '.'));
    if (from) { fs.renameSync(p, path.join(dir, map[from] + e.name.slice(from.length))); renamed++; }
  }
};
for (const d of ['cache', 'exports']) if (fs.existsSync(path.join(WORK_DIR, d))) walk(path.join(WORK_DIR, d));
console.log(`done; ${renamed} cache files renamed; map at trash/${day}/acars-rename-map.json`);
