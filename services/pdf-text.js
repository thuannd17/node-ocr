/**
 * Text of a PDF that has a text layer (e.g. NetLine/Crew duty plans), with
 * positions: no OCR involved. Uses pdfjs-dist.
 *
 * Returns [{ page, width, height, items: [{ text, x, y, w, h }] }] in the page
 * as read: its /Rotate applied, and when the text itself runs sideways (a
 * landscape plan printed onto a portrait page, e.g. via "Microsoft Print to
 * PDF") the page is turned so the text reads left to right. x/y is the top-left
 * corner in points, y growing downwards like image pixels.
 */
import fs from 'node:fs';
import { getDocument, Util } from 'pdfjs-dist/legacy/build/pdf.mjs';

/** Text direction of an item in display space, snapped to 0/90/180/270 degrees. */
const directionOf = (a, b) => ((Math.round(Math.atan2(b, a) / (Math.PI / 2)) * 90) + 360) % 360;

export async function readPdfText(filePath) {
  const data = new Uint8Array(fs.readFileSync(filePath));
  const doc = await getDocument({ data, isEvalSupported: false, useSystemFonts: false, verbosity: 0 }).promise;
  const pages = [];
  try {
    for (let p = 1; p <= doc.numPages; p += 1) {
      const page = await doc.getPage(p);
      const viewport = page.getViewport({ scale: 1 }); // applies the page's /Rotate
      const content = await page.getTextContent();
      const raw = [];
      for (const it of content.items) {
        const text = (it.str || '').trim();
        if (!text) continue;
        // Text matrix in display space: [a b c d e f], (e, f) = baseline start.
        const [a, b, , , e, f] = Util.transform(viewport.transform, it.transform);
        raw.push({ text, e, f, h: Math.hypot(a, b) || it.height || 0, w: it.width, dir: directionOf(a, b) });
      }
      // Most text runs this way; turn the page by the opposite angle.
      const votes = {};
      for (const r of raw) votes[r.dir] = (votes[r.dir] || 0) + 1;
      const dir = Number(Object.entries(votes).sort((x, y) => y[1] - x[1])[0]?.[0] || 0);
      const { width: W, height: H } = viewport;
      const turn = {
        0: (x, y) => [x, y],
        90: (x, y) => [y, W - x], // text running down the page
        180: (x, y) => [W - x, H - y],
        270: (x, y) => [H - y, x], // text running up the page
      }[dir];
      const items = raw.map(r => {
        const [x, y] = turn(r.e, r.f);
        return { text: r.text, x, y: y - r.h, w: r.w, h: r.h };
      });
      const sideways = dir === 90 || dir === 270;
      pages.push({ page: p, width: sideways ? H : W, height: sideways ? W : H, items });
      page.cleanup();
    }
  } finally {
    await doc.destroy();
  }
  return dayFirstDates(superscriptDays(pages));
}

// "02:12⁺¹": the day offset printed in superscript -> "02:12+1", like the other layouts write it.
const SUPERSCRIPT = { '⁺': '+', '⁻': '-', '⁰': '0', '¹': '1', '²': '2', '³': '3', '⁴': '4', '⁵': '5', '⁶': '6', '⁷': '7', '⁸': '8', '⁹': '9' };
function superscriptDays(pages) {
  for (const p of pages) for (const i of p.items) i.text = i.text.replace(/[⁺⁻][⁰¹²³⁴⁵⁶⁷⁸⁹]+/g, (m) => [...m].map(c => SUPERSCRIPT[c]).join(''));
  return pages;
}

/**
 * Whether the pages have a real text layer. Some PDFs are a picture of the roster
 * with a few stray characters as text ("=", "-"), or with only the header and footer
 * a browser prints (the page's URL with the date beside it, "Page 1 of 3"): those
 * need OCR like an image-only PDF.
 */
export function hasTextLayer(pages) {
  const chars = pages.reduce((n, p) => {
    const urlYs = p.items.filter(i => /^https?:\/\//i.test(i.text.trim())).map(i => i.y);
    const browser = (i) => /^Page \d+ of \d+$/i.test(i.text.trim()) || urlYs.some(y => Math.abs(y - i.y) <= 2);
    return n + p.items.filter(i => !browser(i)).reduce((m, i) => m + (i.text.match(/[A-Za-z0-9]/g) || []).length, 0);
  }, 0);
  return chars >= 20;
}

// "07/31", "07/31/2024": two numbers of a date written with slashes (not part of a longer number).
const SLASH_DATE_RE = /(?<![\d/])(\d{2})\/(\d{2})(?=\/\d{4}(?!\d)|(?![\d/]))/g;

/**
 * Slash dates as day/month. Most rosters print "31/07/2024", but some (US
 * "Personal Crew Schedule Report") print month first: "07/31/2024", "07/01".
 * A file is month-first when one of its dates has a second number over 12 and
 * none has a first number over 12; its dates are then turned round ("07/31" ->
 * "31/07"), so the parsers and the model only ever see day/month.
 */
export function dayFirstDates(pages) {
  let dayFirst = 0, monthFirst = 0;
  for (const p of pages) for (const i of p.items) {
    for (const [, a, b] of i.text.matchAll(SLASH_DATE_RE)) {
      if (+a > 12 && +b >= 1 && +b <= 12) dayFirst++;
      else if (+b > 12 && +b <= 31 && +a >= 1 && +a <= 12) monthFirst++;
    }
  }
  if (!monthFirst || dayFirst) return pages;
  for (const p of pages) for (const i of p.items) i.text = i.text.replace(SLASH_DATE_RE, '$2/$1');
  return pages;
}
