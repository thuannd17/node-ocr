import { test } from 'node:test';
import assert from 'node:assert/strict';
import { alignLabel } from '../services/pdf-label-align.js';
import { assembleRows, learnConventions, mergeConventions } from '../services/pdf-row-assembler.js';

// A small made-up roster in a layout the parser has no code for:
//   Date     Duty   From  STD   To   STA   Blk Hrs
//   03Mar25  XY101 AAA   0800  BBB  0930  1:30
//            XY102 BBB   1015  AAA  1145  1:30
//   04Mar25  OFF   AAA
const word = (t, x, y) => ({ t, x, y, w: t.length * 5, h: 8 });
const page = () => ({
  width: 600,
  height: 800,
  tokens: [
    ...['Date', 'Duty', 'From', 'STD', 'To', 'STA', 'Blk', 'Hrs'].map((t, i) => word(t, [40, 100, 160, 200, 250, 290, 340, 358][i], 50)),
    word('03Mar25', 40, 70), word('XY101', 100, 70), word('AAA', 160, 70), word('0800', 200, 70), word('BBB', 250, 70), word('0930', 290, 70), word('1:30', 340, 70),
    word('XY102', 100, 82), word('BBB', 160, 82), word('1015', 200, 82), word('AAA', 250, 82), word('1145', 290, 82), word('1:30', 340, 82),
    word('04Mar25', 40, 94), word('OFF', 100, 94), word('AAA', 160, 94),
    word('Printed', 40, 700), word('by', 80, 700), word('crew', 95, 700), word('system', 120, 700),
  ],
});
const row = (r) => ({ date: '', day: '', hotel: '', dc: '', duty: '', registration: '', dep: '', begin: '', end: '', arr: '', ac: '', crew: '', info: '', ...r });
const label = {
  published: [
    row({ date: '3 Mar 25', day: 'Mon', duty: 'XY101', dep: 'AAA', begin: '08:00 Z', end: '09:30 Z', arr: 'BBB', info: '[Blk Hrs 1:30]' }),
    row({ date: '3 Mar 25', day: 'Mon', duty: 'XY102', dep: 'BBB', begin: '10:15 Z', end: '11:45 Z', arr: 'AAA', info: '[Blk Hrs 1:30]' }),
    row({ date: '4 Mar 25', day: 'Tue', duty: 'OFF', dep: 'AAA' }),
  ],
  planned: [],
};

test('alignLabel tags the words of a label in a layout the parser does not know', () => {
  const pages = [page()];
  const stats = alignLabel(pages, label);
  assert.equal(stats.anchored, 3);
  assert.deepEqual(stats.missing, {});
  const f = Object.fromEntries(pages[0].tokens.map(t => [`${t.t}@${t.y}`, `${t.field}${t.row ?? ''}`]));
  assert.equal(f['03Mar25@70'], 'date0');
  assert.equal(f['XY102@82'], 'duty1');
  assert.equal(f['1015@82'], 'begin1');
  assert.equal(f['AAA@82'], 'arr1');
  assert.equal(f['1:30@82'], 'info1');
  assert.equal(f['04Mar25@94'], 'date2');
  assert.equal(f['Date@50'], 'O'); // header: above the rows, not a field
  assert.equal(f['Printed@700'], 'O'); // footer: no row has it
});

test('assembleRows rebuilds the label from tagged words, with the "[Blk Hrs x]" way learned from the label', () => {
  const pages = [page()];
  alignLabel(pages, label);
  const conventions = mergeConventions([learnConventions(pages, label)]);
  assert.equal(conventions.duration['blk hrs'], '[Blk Hrs {}]');
  const out = assembleRows(pages, [], conventions);
  assert.deepEqual(out.published, label.published);
  assert.deepEqual(out.planned, []);
});

test('a page without dates after the days (statistics, overtime) adds no rows', () => {
  const pages = [page()];
  alignLabel(pages, label);
  // NetLine's last page: "ALLOWABLE VOLUNTARY OVERTIME / AO / M 0:00", which a tagger
  // that never saw the layout may tag as duty "/" and registration "M".
  const tag = (t, x, y, field) => ({ ...word(t, x, y), field });
  pages.push({
    width: 600,
    height: 800,
    tokens: [
      tag('ALLOWABLE', 40, 60, 'info'), tag('VOLUNTARY', 90, 60, 'O'), tag('OVERTIME', 140, 60, 'O'),
      tag('AO', 40, 74, 'info'), tag('/', 55, 74, 'duty'), tag('M', 65, 74, 'registration'), tag('0:00', 350, 74, 'info'),
      tag('AO', 40, 82, 'info'), tag('/', 55, 82, 'duty'), tag('Y', 65, 82, 'registration'), tag('14:12', 350, 82, 'end'),
    ],
  });
  const out = assembleRows(pages, [], mergeConventions([learnConventions([pages[0]], label)]));
  assert.deepEqual(out.published, label.published);
});
