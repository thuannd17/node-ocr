#!/usr/bin/env node
/**
 * One-time import of the old local folders into MinIO (media/):
 *   fake-data/<ext>/<name>        -> files/<ext>/<name>        (same names: the labels refer to them)
 *   labels/<ext>/<name>.json      -> labels/<ext>/<name>.json  (byte for byte)
 *   suggestions/<id>/meta.json    -> suggestions/<id>/...      (with file.<ext> when it is still there)
 * What MinIO already has with the same content is skipped, so it can be run again.
 * At the end every local file, label and suggestion is checked against MinIO.
 * Nothing local is deleted: once the check passes, the folders can be removed by hand.
 *
 *   npm run media:import [-- --from <folder with fake-data/ labels/ suggestions/>] [--dry]
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { listData, listLabels, dataFile, labelFile } from '../utils/data-files.js';
import { mediaIndex, importFile, importLabel, listSuggestions, putSuggestion } from '../services/media-client.js';

const argv = process.argv.slice(2);
const from = path.resolve(argv.includes('--from') ? argv[argv.indexOf('--from') + 1] : '.');
const dry = argv.includes('--dry');
const md5 = (buf) => crypto.createHash('md5').update(buf).digest('hex');

const DATA = path.join(from, 'fake-data'), LABELS = path.join(from, 'labels'), SUGG = path.join(from, 'suggestions');
const files = listData(DATA), labels = listLabels(LABELS);
const suggestionIds = fs.existsSync(SUGG) ? fs.readdirSync(SUGG).filter(id => fs.existsSync(path.join(SUGG, id, 'meta.json'))) : [];
console.log(`From ${from}: ${files.length} files, ${labels.length} labels, ${suggestionIds.length} suggestions${dry ? ' (dry run)' : ''}`);

let index = await mediaIndex(true);
const remoteFiles = new Map(index.files.map(f => [f.name, f.md5]));
const remoteLabels = new Map(index.labels.map(l => [l.name, l.md5]));
const stats = { files: 0, labels: 0, suggestions: 0, skipped: 0, failed: [] };

async function each(list, size, fn) {
  let i = 0, done = 0;
  await Promise.all(Array.from({ length: Math.min(size, list.length) }, async () => {
    while (i < list.length) {
      const item = list[i++];
      try { await fn(item); } catch (e) { stats.failed.push(`${item}: ${e.message}`); }
      if (++done % 50 === 0) console.log(`  ${done}/${list.length}`);
    }
  }));
}

console.log('Files…');
await each(files, 6, async (name) => {
  const buf = fs.readFileSync(dataFile(DATA, name));
  if (remoteFiles.get(name) === md5(buf)) { stats.skipped++; return; }
  if (!dry) await importFile(name, buf);
  stats.files++;
});

console.log('Labels…');
await each(labels, 6, async (name) => {
  if (!fs.existsSync(dataFile(DATA, name)) && !remoteFiles.has(name)) throw new Error('label without its file');
  const buf = fs.readFileSync(labelFile(LABELS, name));
  JSON.parse(buf.toString('utf8')); // a broken label is reported, not imported
  if (remoteLabels.get(name) === md5(buf)) { stats.skipped++; return; }
  if (!dry) await importLabel(name, buf);
  stats.labels++;
});

console.log('Suggestions…');
const remoteSugg = new Map((await listSuggestions()).map(m => [m.id, m]));
await each(suggestionIds, 3, async (id) => {
  const meta = JSON.parse(fs.readFileSync(path.join(SUGG, id, 'meta.json'), 'utf8'));
  const fileOnDisk = path.join(SUGG, id, `file.${meta.fileType}`);
  const file = fs.existsSync(fileOnDisk) ? fs.readFileSync(fileOnDisk) : null;
  const had = remoteSugg.get(id);
  if (had && JSON.stringify({ ...had, hasFile: undefined }) === JSON.stringify({ ...meta, hasFile: undefined }) && had.hasFile === !!file) { stats.skipped++; return; }
  if (!dry) await putSuggestion(meta, file);
  stats.suggestions++;
});

console.log(`\nImported: ${stats.files} files, ${stats.labels} labels, ${stats.suggestions} suggestions; ${stats.skipped} already there.`);
for (const f of stats.failed) console.log(`  FAILED ${f}`);
if (dry) process.exit(0);

// ---- check: everything local is in MinIO with the same bytes ----
index = await mediaIndex(true);
const rf = new Map(index.files.map(f => [f.name, f.md5])), rl = new Map(index.labels.map(l => [l.name, l.md5]));
const missing = [
  ...files.filter(n => rf.get(n) !== md5(fs.readFileSync(dataFile(DATA, n)))).map(n => `file ${n}`),
  ...labels.filter(n => rl.get(n) !== md5(fs.readFileSync(labelFile(LABELS, n)))).map(n => `label ${n}`),
];
const rs = new Set((await listSuggestions()).map(m => m.id));
missing.push(...suggestionIds.filter(id => !rs.has(id)).map(id => `suggestion ${id}`));
if (missing.length) {
  console.log(`\nCHECK FAILED: ${missing.length} not in MinIO (or different):`);
  for (const m of missing.slice(0, 30)) console.log(`  ${m}`);
  process.exit(1);
}
console.log(`\nCheck passed: all ${files.length} files, ${labels.length} labels and ${suggestionIds.length} suggestions are in MinIO (${index.files.length} files, ${index.labels.length} labels there).`);
console.log(`The local folders are no longer used and can be deleted: ${['fake-data', 'labels', 'suggestions'].map(d => path.join(from, d)).join(', ')}`);
