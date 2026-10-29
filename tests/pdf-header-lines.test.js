import { test } from 'node:test';
import assert from 'node:assert/strict';
import { headerLines, toLines, assembleRows } from '../src/services/pdf-row-assembler.js';

const word = (t, x, y, field = 'O') => ({ t, x, y, w: t.length * 5, h: 8, field });
const line = (text, y, field) => text.split(' ').map((t, i) => word(t, 20 + i * 18, y, typeof field === 'function' ? field(t, i) : field));
const WEEK = ['Sat', 'Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri'];
const month = Array.from({ length: 31 }, (_, i) => WEEK[i % 7]).join(' ');
// header words a model may learn from other layouts: weekdays, day codes
const words = new Set(['date', 'duty', 'from', 'to', 'std', 'sta', 'tijd', 'rust', 'dp', 'fdp', 'code', 'descr.', 'flight', 'crew', 'off', 'vac', 'sim', ...WEEK.map(d => d.toLowerCase())]);
const headersOf = (tokens) => headerLines(toLines(tokens), words).map(h => h.tokens.map(t => t.t).join(' '));

test('a strip of weekdays over a month (NetLine plan) is not a column header', () => {
  const tokens = [...line(`CRM ${month}`, 36), ...line(Array.from({ length: 31 }, (_, i) => String(i + 1).padStart(2, '0')).join(' '), 39)];
  assert.deepEqual(headersOf(tokens), []);
});

test('a month calendar whose dates are right under the weekdays keeps them as its header', () => {
  const tokens = [...line(month, 114), ...line(Array.from({ length: 31 }, (_, i) => String(i + 1)).join(' '), 124, (t, i) => (i ? 'O' : 'date'))];
  assert.deepEqual(headersOf(tokens), [month]);
});

test('a strip of day codes is not a column header; a header naming column pairs or repeated blocks is', () => {
  assert.deepEqual(headersOf(line('Sby FlD FlD Off Off Vac Vac Vac Vac Off Off Off FlD Off Off Sim Sim', 50)), []);
  assert.deepEqual(headersOf(line('DG TIJD TIJD VST AST TIJD TIJD RUST DP FDP', 50)), ['DG TIJD TIJD VST AST TIJD TIJD RUST DP FDP']);
  const blocks = 'Code Descr. Flight Crew Code Descr. Flight Crew Code Descr. Flight Crew Code Descr. Flight Crew';
  assert.deepEqual(headersOf(line(blocks, 50)), [blocks]);
});

test('a lone number tagged date where dates are written with letters does not move the rows after it', () => {
  // Date   Duty   From  STD   To   STA
  // Mon03  XY100  AAA   0800  BBB  0930
  // Tue04 ...
  // Wed05  XY102  AAA   0800  BBB  0930   Session 2   <- "2" tagged date by the model
  // ... Fri14
  const days = ['Mon03', 'Tue04', 'Wed05', 'Thu06', 'Fri07', 'Sat08', 'Sun09', 'Mon10', 'Tue11', 'Wed12', 'Thu13', 'Fri14'];
  const page = { width: 600, height: 800, tokens: [
    ...['Date', 'Duty', 'From', 'STD', 'To', 'STA'].map((t, i) => word(t, [40, 100, 160, 200, 250, 290][i], 50)),
    ...days.flatMap((d, k) => [
      word(d, 40, 70 + k * 12, 'date'), word(`XY1${String(k).padStart(2, '0')}`, 100, 70 + k * 12, 'duty'), word('AAA', 160, 70 + k * 12, 'dep'),
      word('0800', 200, 70 + k * 12, 'begin'), word('BBB', 250, 70 + k * 12, 'arr'), word('0930', 290, 70 + k * 12, 'end'),
    ]),
    word('Session', 340, 94, 'info'), word('2', 380, 94, 'date'),
  ] };
  const rows = assembleRows([page], [], {}).published;
  assert.equal(rows.length, days.length);
  assert.equal(new Set(rows.map(r => r.date)).size, days.length);
  assert.equal(rows[2].info, 'Session 2');
});
