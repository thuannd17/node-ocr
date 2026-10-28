/**
 * Public data the site shows (not code, not personal data): kept in its own bucket, SITE_BUCKET
 * (default site-data; with MEDIA_BACKEND=fs a folder _<bucket> in MEDIA_FS_DIR), and mirrored to
 * SITE_MIRROR (<ROSTER_WORK_DIR>/site) so the app reads it from disk.
 *
 *   airports.json   the airports (/airport, /api/airports, night time, route map); npm run airports:update builds and publishes it
 *
 *   siteFile(name)            -> local path of the file, downloaded when the bucket has another version
 *                                (asked at most every CHECK_MS; the copy on disk is used while MinIO is down)
 *   publishSiteFile(name, buf)   writes it to the bucket and the mirror
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { storeFromEnv } from './storage/index.js';
import { SITE_MIRROR } from '../utils/paths.js';

export const SITE_FILES = ['airports.json'];
const CHECK_MS = 10 * 60 * 1000;
const md5 = (buf) => crypto.createHash('md5').update(buf).digest('hex');

let store = null;
const site = () => (store ||= storeFromEnv(process.env, { bucket: process.env.SITE_BUCKET || 'site-data' }));
const checked = new Map(); // name -> { at, md5 } of the last look at the bucket

const checkName = (name) => {
  if (!SITE_FILES.includes(name)) throw Object.assign(new Error(`Not a site data file: ${name}`), { status: 400 });
  return path.join(SITE_MIRROR, name);
};

export async function siteFile(name) {
  const local = checkName(name);
  const last = checked.get(name);
  if (last && Date.now() - last.at < CHECK_MS && fs.existsSync(local)) return local;
  let remote;
  try {
    remote = await site().stat(name);
    const have = fs.existsSync(local) ? (last?.md5 ?? md5(fs.readFileSync(local))) : null;
    if (remote && have !== remote.etag) {
      const buf = await site().get(name);
      fs.mkdirSync(SITE_MIRROR, { recursive: true });
      fs.writeFileSync(`${local}.${process.pid}.part`, buf);
      fs.renameSync(`${local}.${process.pid}.part`, local);
      console.log(`[site] ${name} downloaded (${(buf.length / 1e6).toFixed(1)} MB) -> ${local}`);
    }
  } catch (e) {
    if (!fs.existsSync(local)) throw Object.assign(new Error(`Cannot get ${name} from the site data bucket: ${e.message}`), { status: 503 });
    console.warn(`[site] ${name}: ${e.message}; using the copy on disk`);
    remote = { etag: last?.md5 ?? null };
  }
  // not in the bucket: the last copy on disk if there is one
  if (!remote && !fs.existsSync(local)) throw Object.assign(new Error(`${name} is not in the site data bucket yet: run \`npm run airports:update\``), { status: 503 });
  checked.set(name, { at: Date.now(), md5: remote?.etag ?? null });
  return local;
}

export async function publishSiteFile(name, buf) {
  const local = checkName(name);
  await site().put(name, buf, name.endsWith('.json') ? 'application/json' : 'application/octet-stream');
  fs.mkdirSync(SITE_MIRROR, { recursive: true });
  fs.writeFileSync(local, buf);
  checked.set(name, { at: Date.now(), md5: md5(buf) });
  return { name, size: buf.length, where: site().describe() };
}
