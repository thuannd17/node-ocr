import test from 'node:test';
import assert from 'node:assert/strict';
import { ocrDataToPage } from '../services/pdf-ocr.js';
import { parseNetlinePdf } from '../services/pdf-roster-parser.js';

// OCR answer in pixels at scale 2 (px per pt), with the slips seen on a real
// image-only plan: header words missing/merged, "Sa227", "Peri0d:", "8325",
// statistics without brackets ("FDT", "12:41Z", "XFDP").
const box = (x, y, w, h = 8) => [[x * 2, y * 2], [(x + w) * 2, y * 2], [(x + w) * 2, (y + h) * 2], [x * 2, (y + h) * 2]];
const line = (text, x, y, w) => ({ text, confidence: 0.9, box: box(x, y, w) });

test('an OCR page is repaired and parsed like a text PDF', () => {
  const page = ocrDataToPage({
    scale: 2, width: 1684, height: 1190,
    lines: [
      line('Individual', 48, 51, 63), line('duty plan', 109, 51, 54),
      line('Peri0d:', 48, 59, 40), line('27Jun26-', 111, 59, 52), line('27Jun26', 173, 59, 41),
      line('duty', 98, 106, 19), line('RDep', 137, 106, 21), line('arr', 209, 108, 14), line('AC', 226, 108, 11), line('info', 253, 108, 17),
      line('Sa227', 48, 136, 18), line('Pick Up', 87, 136, 26), line('8325', 166, 135, 17),
      line('EW', 86, 146, 10), line('762', 101, 145, 12), line('CGN', 147, 146, 11), line('0515', 167, 145, 15), line('0615', 187, 146, 15), line('ZRH', 208, 146, 12), line('320', 226, 145, 12),
      line('Landing', 143, 151, 27),
      line('[DT', 253, 160, 12), line('12:41Z', 277, 160, 20),
      line('FDT', 255, 166, 13), line('11:13', 277, 166, 20),
      line('XFDP', 255, 172, 16), line('00:00)', 277, 172, 20),
    ],
  });
  const r = parseNetlinePdf([page]);
  assert.equal(r.period, '27Jun26 - 27Jun26');
  assert.deepEqual(r.published.map(x => [x.date, x.day, x.duty, x.dep, x.begin, x.end, x.arr, x.ac, x.info]), [
    ['27 Jun 26', 'Sat', 'Pick Up', '', '03:25 Z', '', '', '', ''],
    ['27 Jun 26', 'Sat', 'EW 762', 'CGN', '05:15 Z', '06:15 Z', 'ZRH', '320', 'Landing [DT 12:41] [FDT 11:13] [xFDP 00:00]'],
  ]);
});
