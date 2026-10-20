import test from 'node:test';
import assert from 'node:assert/strict';
import { toHHMM, parseAcarsDate, formatAcarsDate, fixAcarsText, acarsLineTruths, acarsWordPages, parseAcars, alignAcars, assembleAcars, compareAcars, labelKey } from '../src/services/acars.js';

// Made-up OCR lines of an ACARS screen (boxes as PaddleOCR gives them: 4 corners).
const box = (text, x, y, w = text.length * 14) => ({ text, box: [[x, y], [x + w, y], [x + w, y + 20], [x, y + 20]] });

test('times and durations as HH:MM, with the usual OCR slips', () => {
  assert.equal(toHHMM('0958Z'), '09:58');
  assert.equal(toHHMM('09:58'), '09:58');
  assert.equal(toHHMM('1Z11'), '12:11'); // Z read for 2
  assert.equal(toHHMM('15:32:25'), '15:32');
  assert.equal(toHHMM('141228'), '14:12'); // HHMMSS
  assert.equal(toHHMM('01+16'), '01:16'); // a duration
  assert.equal(toHHMM('EDDL'), '');
  assert.equal(toHHMM('DE4800'), '');
  assert.equal(toHHMM('1275'), ''); // not a time
});

test('dates: as much as the screen prints, also with OCR slips', () => {
  const d = (t, o) => formatAcarsDate(parseAcarsDate(t, o));
  assert.equal(d('02SEP22'), '2 Sep 22');
  assert.equal(d('07N0V2Z'), '7 Nov 22'); // 0 read for O, Z for 2
  assert.equal(d('27OCT'), '27 Oct');
  assert.equal(d('27/11/22'), '27 Nov 22'); // day first
  assert.equal(d('Z8/MAY'), '28 May');
  assert.equal(d('14'), ''); // a bare number is a day only where a day stands
  assert.equal(d('14', { dayOnly: true }), '14');
  assert.equal(d('/21', { dayOnly: true }), '21'); // BAW43 /21
  assert.equal(d('1101'), '');
  assert.equal(d('DE4800'), '');
  assert.equal(fixAcarsText('22 Jan 26'), '22JAN26');
  assert.equal(fixAcarsText('AFR86N270CT'), 'AFR86N 270CT');
  assert.equal(fixAcarsText('1 4JULZ5'), '14JULZ5');
});

test('OCR glue is undone before tagging', () => {
  assert.equal(fixAcarsText('0UT23:30'), '0UT 23:30');
  assert.equal(fixAcarsText('EDDH/LSZH'), 'EDDH / LSZH');
  assert.equal(fixAcarsText('1 5 1 2'), '1512');
  assert.equal(fixAcarsText('EBLG-UACC'), 'EBLG - UACC');
  assert.equal(fixAcarsText('EDDLEDDF'), 'EDDL EDDF');
});

test('label words, also read with OCR slips', () => {
  assert.equal(labelKey(['FLIGHT', 'NO']), 'flt');
  assert.equal(labelKey(['ORIG', '/', 'DEST']), 'route');
  assert.equal(labelKey(['0UT']), 'out');
  assert.equal(labelKey(['OUT', '/', 'OFF']), 'outoff');
  assert.equal(labelKey(['BLK']), 'block');
  assert.equal(labelKey(['AIRBORNE']), 'off');
  assert.equal(labelKey(['DATE']), 'date');
  assert.equal(labelKey(['UTC']), 'other');
});

// "AOC OOOI STATUS": labels over their values, the right column right-aligned
const STATUS = [
  box('AOC OOOI STATUS', 100, 10),
  box('FLIGHT ID', 10, 50), box('DATE', 230, 50), box('ORIG/DEST', 380, 50),
  box('DE4800', 10, 80), box('11NOV25', 216, 80), box('EDDL/EDDF', 380, 80),
  box('OUT', 10, 120), box('OFF', 470, 120),
  box('0958Z', 10, 150), box('1014Z', 440, 150),
  box('IN', 10, 190), box('ON', 484, 190),
  box('1055Z', 10, 220), box('1045Z', 440, 220),
  box('BLOCK', 10, 260), box('FLIGHT', 428, 260),
  box('0057', 10, 290), box('0031', 456, 290),
];
const LABEL = { flt: 'DE4800', date: '11 Nov 25', dept: 'EDDL', dest: 'EDDF', out: '09:58', off: '10:14', on: '10:45', in: '10:55', info: '[Flight: 00:31] [Block: 00:57]' };

test('the parser reads a status page: values under their labels', () => {
  const r = parseAcars(acarsWordPages(STATUS, 560, 320));
  assert.deepEqual(r, LABEL);
});

test('a flight log page: values right of their labels, "-" between', () => {
  const lines = [
    box('FLT NO', 10, 10), box('DEPT/DEST', 300, 10),
    box('SV1563/04', 10, 40), box('OEJN/OETB', 300, 40),
    box('OUT', 40, 80), box('-', 120, 80), box('02:05', 160, 80),
    box('OFF', 40, 110), box('-', 120, 110), box('02:20', 160, 110),
    box('ON', 54, 140), box('-', 120, 140), box('03:32', 160, 140),
    box('IN', 54, 170), box('-', 120, 170), box('03:36', 160, 170),
    box('FLIGHT', 10, 200), box('01:12', 160, 200),
    box('BLOCK', 24, 230), box('01:31', 160, 230),
  ];
  assert.deepEqual(parseAcars(acarsWordPages(lines, 460, 260)), {
    flt: 'SV1563', date: '4', dept: 'OEJN', dest: 'OETB', out: '02:05', off: '02:20', on: '03:32', in: '03:36', info: '[Flight: 01:12] [Block: 01:31]',
  });
});

test('training tags from a label, and the fields back from tags', () => {
  const pages = acarsWordPages(STATUS, 560, 320);
  const st = alignAcars(pages, LABEL);
  assert.deepEqual(st.missing, []);
  const tagged = pages[0].tokens.filter(t => t.field !== 'O').map(t => `${t.t}=${t.field}`);
  assert.deepEqual(tagged.sort(), ['0031=flight', '0057=block', '0958Z=out', '1014Z=off', '1045Z=on', '1055Z=in', 'DE4800=flt', '11NOV25=adate', 'EDDF=dest', 'EDDL=dept'].sort());
  assert.deepEqual(assembleAcars(pages), LABEL); // the model's tags read back the same way
});

test('a value OCR misread is left out of training ("?"), not taught as O', () => {
  const lines = STATUS.map(b => (b.text === '1045Z' ? { ...b, text: '045Z' } : b));
  const pages = acarsWordPages(lines, 560, 320);
  const st = alignAcars(pages, LABEL);
  assert.deepEqual(st.missing, ['on']);
  assert.equal(pages[0].tokens.find(t => t.t === '045Z').field, '?');
});

test('scores per field: times as HH:MM, info as its two times', () => {
  const c = compareAcars({ ...LABEL, out: '0958', info: '[Block: 00:57] [Flight: 00:31]', dest: '' }, LABEL);
  assert.equal(c.perField.out.matches, 1);
  assert.equal(c.perField.info.matches, 1);
  assert.equal(c.perField.dest.matches, 0);
  assert.equal(c.allRight, false);
  assert.deepEqual(c.diffs, [{ kind: 'field', field: 'dest', pred: '', exp: 'EDDF' }]);
});

test('OCR training crops: the true text of each OCR line, misreads where the value belongs fixed', () => {
  const lines = STATUS.map(b => (b.text === '1045Z' ? { ...b, text: '1O45Z' } : b.text === 'OUT' ? { ...b, text: '0UT' } : b));
  const truths = acarsLineTruths(lines, 560, 320, LABEL);
  const byOcr = Object.fromEntries(truths.map(t => [t.ocr, t.truth]));
  assert.equal(byOcr['0UT'], 'OUT'); // a screen word, the OCR slip undone
  assert.equal(byOcr['1O45Z'], '1045Z'); // the value in its place, read wrong
  assert.equal(byOcr['0958Z'], '0958Z');
  assert.equal(byOcr['EDDL/EDDF'], 'EDDL/EDDF'); // printed with its "/"
  assert.equal(byOcr['11NOV25'], '11NOV25');
});
