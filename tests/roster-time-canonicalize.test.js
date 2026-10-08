import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'node-ocr-times-'));
process.env.PARSER_PATTERNS_FILE = path.join(tmpRoot, 'models', 'parser-patterns.json');

const { canonicalizeTimes, normalizeRowText } = await import('../services/roster-parser.js');

// Spellings of the same merged begin+end box seen from different recognizer
// models/training runs (75-image benchmark, 2026-09-25).
test('merged begin/end pair is normalized whatever the recognizer spacing', () => {
  const expected = '00:00 Z 21:00 Z';
  for (const raw of [
    '00:00 Z 21:00 Z',
    '00:00 Z21:00 Z',
    '00:00Z21:00Z',
    '0000Z21:00Z',
    '0000Z2100Z',
    '00 00 Z 21 00 Z', // colons read as spaces
  ]) {
    assert.equal(canonicalizeTimes(raw), expected, raw);
  }
  // separating Z read as "2" is repaired by the legacy steps in normalizeRowText
  assert.equal(normalizeRowText('00:00221:00Z'), expected);
});

test('uncoloned time pair whose separating Z was read as 2', () => {
  assert.equal(canonicalizeTimes('000022359Z'), '00:00 Z 23:59 Z');
});

test('uncoloned time before a coloned one', () => {
  assert.equal(canonicalizeTimes('2100 Z 00:00 Z'), '21:00 Z 00:00 Z');
});

test('airport code glued after the Z stays a separate token', () => {
  assert.equal(canonicalizeTimes('07:00Z1020ZAGP'), '07:00 Z 10:20 Z AGP');
});

test('times surrounded by other cells are rewritten in place', () => {
  assert.equal(canonicalizeTimes('FR 4007 MAN 0640Z0930Z ALC'), 'FR 4007 MAN 06:40 Z 09:30 Z ALC');
});

test('duty codes, flight numbers and dates are not turned into times', () => {
  for (const raw of [
    'SBY1030-Z',
    'SBY0900-Z',
    'SBY0400Z',
    'FR 8075',
    'FR 8075 17:45 Z',
    'Sat 7 Mar 20 2105',
    '12 Jun 20 Fri',
  ]) {
    assert.equal(canonicalizeTimes(raw), raw, raw);
  }
});

test('impossible times are left untouched', () => {
  assert.equal(canonicalizeTimes('9959Z'), '9959Z');
  assert.equal(canonicalizeTimes('24:00 Z'), '24:00 Z');
});

test('normalizeRowText applies the canonicalization after the legacy fixes', () => {
  assert.equal(normalizeRowText('OFF(2) 0000Z2100Z'), 'OFF(Z) 00:00 Z 21:00 Z');
});

test('a 0 read as a bracket inside a time is repaired; bracketed duty codes are not', () => {
  assert.equal(canonicalizeTimes('00:(() Z'), '00:00 Z');
  assert.equal(canonicalizeTimes('(00:(0) Z 21:00 Z'), '00:00 Z 21:00 Z');
  assert.equal(canonicalizeTimes('03:0() Z'), '03:00 Z');
  for (const raw of ['OFF(Z)', 'A/L(Z)', 'A/L(T)']) assert.equal(canonicalizeTimes(raw), raw, raw);
});

// ── parseRoster on a synthetic published table (column x positions as in the
// 700px-wide eCrew print layout; 2026-10-01 regressions) ─────────────────────
const { parseRoster } = await import('../services/roster-parser.js');
const box = (x0, y, x1, h = 12) => [[x0, y], [x1, y], [x1, y + h], [x0, y + h]];
const ln = (text, x0, y, x1) => ({ text, confidence: 0.99, box: box(x0, y, x1) });
function table(rows) {
  const lines = [
    ln('PUBLISHED ROSTER', 160, 60, 270),
    ln('Date', 30, 80, 56), ln('Duty', 125, 80, 155), ln('Dep', 198, 80, 226),
    ln('Begin', 249, 80, 281), ln('End', 298, 80, 323), ln('Arr', 346, 80, 370),
    ln('Roster Responsibility', 470, 80, 600),
  ];
  rows.forEach(([date, duty, dep, begin, end, arr], i) => {
    const y = 100 + i * 16;
    if (date) lines.push(ln(date, 30, y, 100));
    if (duty) lines.push(ln(duty, 128, y, 128 + 7 * duty.length));
    if (dep) lines.push(ln(dep, 203, y, 229));
    if (begin) lines.push(ln(begin, 250, y, 290));
    if (end) lines.push(ln(end, 300, y, 338));
    if (arr) lines.push(ln(arr, 350, y, 375));
  });
  return parseRoster(lines).published;
}

test('A/L(Z) stays in Duty and the airport after it stays in Dep', () => {
  const [r] = table([['21 Jan 20 Tue', 'A/L(Z)', 'CRL', '00:00 Z', '21:00 Z', '']]);
  assert.equal(r.duty, 'A/L(Z)');
  assert.equal(r.dep, 'CRL');
  assert.equal(r.arr, '');
});

test('a three-letter duty code in the Duty column is not taken as an airport', () => {
  const [r] = table([['28 Mar 20 Sat', 'CTO', 'PRG', '01:00 Z', '22:00 Z', '']]);
  assert.equal(r.duty, 'CTO');
  assert.equal(r.dep, 'PRG');
  assert.equal(r.arr, '');
});

test('standby codes keep the -Z form, RST2 is not turned into RSTZ, CI9 reads C19', () => {
  const rows = table([
    ['13 Feb 20 Thu', 'SBY0300 Z', 'MLA', '03:00 Z', '15:00 Z', ''],
    ['14 Feb 20 Fri', 'SBY103() Z', 'MLA', '10:30 Z', '22:30 Z', ''],
    ['15 Feb 20 Sat', 'RST2', 'MLA', '00:00 Z', '21:00 Z', ''],
    ['16 Feb 20 Sun', 'CI9', 'MLA', '00:00 Z', '23:59 Z', ''],
  ]);
  assert.deepEqual(rows.map(r => r.duty), ['SBY0300-Z', 'SBY1030-Z', 'RST2', 'C19']);
});

test('later sectors of a day keep that day; CHECK-OUT time goes to End', () => {
  const rows = table([
    ['19 Jan 25Sun', 'CHECK-IN', '', '05:05 Z', '', ''],
    ['', 'FR4852', 'FCO', '05:50 Z', '07:10 Z', 'CTA'],
    ['', 'FR4851', 'CTA', '07:35 Z', '09:05 Z', 'FCO'],
    ['', 'CHECK-OUT', '', '', '09:35 Z', ''],
    ['20 Jan 25 Mon', 'OFF', '', '', '', ''],
  ]);
  assert.deepEqual(rows.map(r => r.date), ['19 Jan 25', '19 Jan 25', '19 Jan 25', '19 Jan 25', '20 Jan 25']);
  assert.equal(rows[3].begin, '');
  assert.equal(rows[3].end, '09:35 Z');
});

// ── 2026-10-07 parser fixes (eval-parser-cached on v4 lines: 4483 -> 4535 rows) ──
test('colon read as 1, letter for a digit, leading 2 read as Z', () => {
  assert.equal(canonicalizeTimes('00100 Z 23:59 Z'), '00:00 Z 23:59 Z');
  assert.equal(canonicalizeTimes('09110Z 1130Z'), '09:10 Z 11:30 Z');
  assert.equal(canonicalizeTimes('1940 Z 22:0S ZMAN'), '19:40 Z 22:05 Z MAN');
  assert.equal(canonicalizeTimes('Z1:05 Z 23:05Z'), '21:05 Z 23:05 Z');
  // flight numbers and duty codes are not times
  for (const raw of ['FR 8075', 'SBY0900-Z', 'OFF(Z)']) assert.equal(canonicalizeTimes(raw), raw, raw);
});

test('OFF(Z) / C19 get their fixed hours when OCR lost one time', () => {
  const rows = table([
    ['29 Apr 20 Wed', 'OFF(Z)', 'BRU', '00:00 Z', '2::00 Z', ''],
    ['1 May 20 Fri', 'C19', 'BRU', '', '23:59 Z', ''],
    ['2 May 20 Sat', 'OFF(Z)', 'BRU', '01:00 Z', '22:00 Z', ''], // other hours: left alone
  ]);
  assert.deepEqual(rows.map(r => [r.begin, r.end]), [
    ['00:00 Z', '21:00 Z'], ['00:00 Z', '23:59 Z'], ['01:00 Z', '22:00 Z'],
  ]);
});

test('a garbled time pair is not an airport', () => {
  const [r] = table([['1 Apr 20 Wed', 'OFF(Z)', 'PRG', '00:00Z21Z00Z', '', '']]);
  assert.equal(r.arr, '');
});

test('duty glued to the date box is kept; the day number is not a duty', () => {
  const rows = [
    ln('PUBLISHED ROSTER', 160, 60, 270),
    ln('Date', 30, 80, 56), ln('Duty', 125, 80, 155), ln('Dep', 198, 80, 226),
    ln('Begin', 249, 80, 281), ln('End', 298, 80, 323), ln('Arr', 346, 80, 370),
    ln('Mon,', 10, 100, 28), ln('30 Mar2OFF(Z)', 30, 100, 180), ln('PRG', 203, 100, 229),
    ln('00:00 Z 21:00 Z', 250, 100, 338),
    ln('Tue,', 10, 116, 28), ln('31 MarOFF(Z)', 30, 116, 180), ln('PRG', 203, 116, 229),
    ln('00:00 Z 21:00 Z', 250, 116, 338),
  ];
  assert.deepEqual(parseRoster(rows).published.map(r => r.duty), ['OFF(Z)', 'OFF(Z)']);
});

test('a date box holding the day\'s only duty is a row, and keeps the date for later sectors', () => {
  const rows = [
    ln('PUBLISHED ROSTER', 160, 60, 270),
    ln('Date', 30, 80, 56), ln('Duty', 125, 80, 155), ln('Dep', 198, 80, 226),
    ln('Begin', 249, 80, 281), ln('End', 298, 80, 323), ln('Arr', 346, 80, 370),
    ln('Tue 25 Feb 20', 30, 100, 100), ln('700', 128, 100, 150), ln('MAN', 203, 100, 229),
    ln('14:50 Z 18:35 Z MMM', 250, 100, 375),
    ln('Wed 26 Feb 20 TSIM', 30, 120, 160),
    ln('GT', 128, 134, 142), ln('MAN', 203, 134, 229), ln('16:30 Z18:30 Z EMT', 250, 134, 375),
    ln('Thu 27 Feb20 RS72', 30, 154, 160),
    ln('SIM', 128, 168, 150), ln('EMT', 203, 168, 229), ln('16:30 Z 21:30 Z', 250, 168, 338),
  ];
  const out = parseRoster(rows).published;
  assert.deepEqual(out.map(r => `${r.date} ${r.duty}`),
    ['25 Feb 20 700', '26 Feb 20 TSIM', '26 Feb 20 GT', '27 Feb 20 RST2', '27 Feb 20 SIM']);
});
