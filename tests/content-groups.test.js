import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { groupByContent, pickCanonicalLabels, splitByGroup, rosterClusters, assignFolds } from '../utils/content-groups.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'node-ocr-groups-'));
const imgDir = path.join(root, 'img');
const labelDir = path.join(root, 'labels');
fs.mkdirSync(imgDir);
fs.mkdirSync(labelDir);

const row = (duty, dep = 'PIK') => ({ date: '12 Jun 20', day: 'Fri', duty, dep, begin: '00:00 Z', end: '21:00 Z', arr: '' });
function addImage(name, bytes, rows) {
  fs.writeFileSync(path.join(imgDir, name), bytes);
  if (rows) fs.writeFileSync(path.join(labelDir, `${name}.json`), JSON.stringify({ published: rows, planned: [] }));
}

// "a.jpg" and "b.jpeg" are byte-identical copies, labeled differently; "c.jpg" is a different image.
// C19 appears on several images so it is the "common" spelling; CI9 is an OCR slip seen once.
addImage('a.jpg', 'same-bytes', [row('CI9')]);
addImage('b.jpeg', 'same-bytes', [row('C19')]);
addImage('c.jpg', 'other-bytes', [row('C19'), row('C19'), row('OFF(Z)')]);

test('identical files share one group, different files do not', () => {
  const names = ['a.jpg', 'b.jpeg', 'c.jpg'];
  const groups = groupByContent(imgDir, names);
  assert.equal(groups.size, 2);
  const sizes = [...groups.values()].map(m => m.length).sort();
  assert.deepEqual(sizes, [1, 2]);
});

test('copies always land on the same train/val side', () => {
  const [[id]] = [...groupByContent(imgDir, ['a.jpg', 'b.jpeg']).entries()];
  const side = splitByGroup(id, 0.5);
  for (let i = 0; i < 5; i += 1) assert.equal(splitByGroup(id, 0.5), side);
  assert.equal(splitByGroup(id, 1), 'train');
  assert.equal(splitByGroup(id, 0), 'val');
});

test('canonical label copy is the one with the more common values, conflicts are reported', () => {
  const groups = groupByContent(imgDir, ['a.jpg', 'b.jpeg', 'c.jpg']);
  const { canonical, conflicts } = pickCanonicalLabels(groups, labelDir);
  const dupGroup = [...groups.entries()].find(([, m]) => m.length === 2)[0];
  assert.equal(canonical.get(dupGroup), 'b.jpeg');
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0].chosen, 'b.jpeg');
  assert.deepEqual(conflicts[0].members.sort(), ['a.jpg', 'b.jpeg']);
});

test('overlapping weekly rosters cluster together and share a fold', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'node-ocr-clusters-'));
  const day = (d, duty) => ({ date: `${d} Jun 20`, day: 'Fri', duty, dep: 'PIK', begin: '05:00 Z', end: '09:00 Z', arr: 'STN' });
  const write = (name, rows) => fs.writeFileSync(path.join(dir, `${name}.json`), JSON.stringify({ published: rows, planned: [] }));
  // wk1 and wk2 share 3 of 4 rows (next week's screenshot); other shares none.
  write('wk1.jpg', [day(1, 'FR1'), day(2, 'FR2'), day(3, 'FR3'), day(4, 'FR4')]);
  write('wk2.jpg', [day(2, 'FR2'), day(3, 'FR3'), day(4, 'FR4'), day(5, 'FR5')]);
  write('other.jpg', [day(20, 'OFF(Z)'), day(21, 'SBY')]);
  const canonical = new Map([['g1', 'wk1.jpg'], ['g2', 'wk2.jpg'], ['g3', 'other.jpg']]);
  const clusterOf = rosterClusters(canonical, dir);
  assert.equal(clusterOf.get('g1'), clusterOf.get('g2'));
  assert.notEqual(clusterOf.get('g1'), clusterOf.get('g3'));
  const foldOf = assignFolds(clusterOf, 2);
  assert.equal(foldOf.get('g1'), foldOf.get('g2'));
  assert.notEqual(foldOf.get('g1'), foldOf.get('g3'));
});
