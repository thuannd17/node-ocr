import test from 'node:test';
import assert from 'node:assert/strict';
import { suspectGrowth, compareRuns } from '../src/services/model-gate.js';

test('suspectGrowth: a file with many more words not in their value stops; new files do not count', () => {
  assert.equal(suspectGrowth({ a: 10, b: 5 }, { a: 12, c: 900 }).ok, true);
  const g = suspectGrowth({ a: 10, b: 5 }, { a: 1300, b: 5 });
  assert.equal(g.ok, false);
  assert.deepEqual(g.grown, [{ file: 'a', before: 10, after: 1300 }]);
  // many files a little worse each
  const before = Object.fromEntries([...Array(20)].map((_, i) => [`f${i}`, 0]));
  const after = Object.fromEntries([...Array(20)].map((_, i) => [`f${i}`, 60]));
  assert.equal(suspectGrowth(before, after).ok, false);
});

const file = (name, layout, rowMatches, rowTotal, extra = {}) => ({ file: name, layout, rowMatches, rowTotal, ...extra });

test('compareRuns: same files about as good is used; new files only reported', () => {
  const before = { a: [90, 100], b: [50, 100] };
  const c = compareRuns(before, [file('a', 'x', 91, 100), file('b', 'y', 50, 100), file('n', 'z', 0, 400)]);
  assert.equal(c.ok, true);
  assert.deepEqual(c.same, { files: 2, before: 140, after: 141, rows: 200 });
  assert.deepEqual(c.added, { files: 1, after: 0, rows: 400 });
});

test('compareRuns: fewer rows right overall, or a layout losing many, keeps the old version', () => {
  const before = { a: [900, 1000], b: [900, 1000], c: [500, 1000] };
  const overall = compareRuns(before, [file('a', 'x', 890, 1000), file('b', 'y', 890, 1000), file('c', 'z', 500, 1000)]);
  assert.equal(overall.ok, false);
  assert.match(overall.reasons[0], /same 3 files 2300 -> 2280/);
  // overall better, but one layout down by more than 10% of its rows
  const layout = compareRuns(before, [file('a', 'x', 1000, 1000), file('b', 'y', 1000, 1000), file('c', 'z', 380, 1000)]);
  assert.equal(layout.ok, false);
  assert.deepEqual(layout.reasons, ['layout z (1 files) 500 -> 380 of 1000 rows']);
  // a file the new version fails on reads no row right
  const failed = compareRuns(before, [file('a', 'x', 900, 1000), file('b', 'y', 900, 1000), file('c', 'z', 0, 0, { error: 'boom' })]);
  assert.equal(failed.ok, false);
  assert.equal(failed.same.rows, 3000);
});
