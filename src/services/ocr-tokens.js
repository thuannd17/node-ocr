/**
 * OCR lines of a roster image -> words with positions, in the same form as a
 * PDF's words (services/pdf-tokens.js), so the learned extractor reads images
 * and PDFs alike.
 *
 *   ocrWordPages(lines, width, height, { unglue = true }) -> [{ width, height, tokens: [{ t, x, y, w, h }] }]

 *     keepBox: each token also gets box = the index of its OCR line (scripts/ocr-acars-crops.mjs)
 *     unglue: false keeps each word as given (ACARS pictures undo OCR glue their own way, services/acars.js)
 *
 * - Pixels are scaled so text is about as tall as in a PDF (8 units), which the
 *   tagger's distance features expect.
 * - Boxes of one table row are put on one y (OCR boxes of a row differ by a few px).
 * - A box holds several words ("00:00 Z 21:00 Z"); OCR also glues some
 *   ("07:00Z10:20ZAGP"): split at spaces and after a time's "Z".
 */
const TEXT_HEIGHT = 8;

const MONTH = '(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)';
/**
 * Words OCR printed without the space between them:
 *   "07:0Z10:20ZAGP" -> "07:0Z 10:20Z AGP"   (a time's Z ends it)
 *   "19Mar24OFF"     -> "19 Mar 24 OFF"      (day | month | year | duty)
 *   "24A/L(Z)", "4OFF" -> "24 A/L(Z)", "4 OFF" (a number, then a code of capitals)
 * A code that starts with letters ("FR3975", "SBY0400-Z") is left whole.
 */
const unglue = s => s
  .replace(/(\d{1,2}[:.]\d{1,2}\s?Z)(?=[A-Z0-9(])/g, '$1 ')
  .replace(new RegExp(`(\\d)(${MONTH})`, 'g'), '$1 $2')
  .replace(new RegExp(`(${MONTH})(\\d)`, 'g'), '$1 $2')
  .replace(/(^|\s)(\d{1,4})(?=[A-Z]{2,}|A\/L)/g, '$1$2 ');

export function ocrWordPages(lines, width, height, { unglue: split = true, keepBox = false } = {}) {
  const boxes = lines.map((l, i) => {
    const xs = l.box.map(p => p[0]), ys = l.box.map(p => p[1]);
    const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
    return { i, text: (split ? unglue : (t) => t)(String(l.text || '').trim()), x: x0, w: x1 - x0, y: y0, h: y1 - y0 };
  }).filter(b => b.text && b.h > 0);
  const hs = boxes.map(b => b.h).sort((a, b) => a - b);
  const medianH = hs[Math.floor(hs.length / 2)] || TEXT_HEIGHT;
  const s = TEXT_HEIGHT / medianH;

  // Rows: boxes whose vertical centres are within half a text height of the row's first box.
  boxes.sort((a, b) => (a.y + a.h / 2) - (b.y + b.h / 2));
  const rows = [];
  for (const b of boxes) {
    const c = b.y + b.h / 2;
    const row = rows[rows.length - 1];
    if (row && Math.abs(c - row.c) <= medianH * 0.5) row.boxes.push(b);
    else rows.push({ c, boxes: [b] });
  }
  const tokens = [];
  for (const row of rows) {
    const y = Math.min(...row.boxes.map(b => b.y)) * s;
    for (const b of row.boxes) {
      const charW = b.w / Math.max(b.text.length, 1);
      for (const m of b.text.matchAll(/\S+/g)) {
        tokens.push({
          t: m[0],
          x: +((b.x + m.index * charW) * s).toFixed(1),
          y: +y.toFixed(1),
          w: +(m[0].length * charW * s).toFixed(1),
          h: +(b.h * s).toFixed(1),
          ...(keepBox ? { box: b.i } : {}),
        });
      }
    }
  }
  return [{ width: +(width * s).toFixed(1), height: +(height * s).toFixed(1), tokens }];
}
