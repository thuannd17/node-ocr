/**
 * Image-only duty-plan PDFs (e.g. printed from a browser, no text layer): each
 * page is rendered and read by the PaddleOCR server (scripts/ocr_server.py,
 * {"path": "x.pdf", "page": n}), then turned into the same items as
 * services/pdf-text.js so services/pdf-roster-parser.js can read them.
 *
 * NetLine plans are printed in a monospace font, so a box holding several words
 * is split by character position. Typical OCR slips are repaired here: header
 * words merged or missed ("RDep", no "date"), day names ("Sa227" = Sat27),
 * "Peri0d:", and "8325" for 0325.
 */
import fs from 'node:fs';
import path from 'node:path';
import { dayFirstDates } from './pdf-text.js';
import { OCR_SERVER_URL, ocrRequest } from './paddle-ocr.js';

const DPI = 200;
const DAYS = { Mo: 'Mon', Tu: 'Tue', We: 'Wed', Th: 'Thu', Fr: 'Fri', Sa: 'Sat', Su: 'Sun' };
// Column offsets from the "duty" header in a NetLine block, in units of the
// duty -> arr distance (date -54, H -29, R dep +41, arr +114, AC +134, info +161 pt).
const HEADER_FROM_DUTY = { date: -54 / 114, H: -29 / 114, 'R dep': 41 / 114, arr: 1, AC: 134 / 114, info: 161 / 114 };

// OCR answers of the last pages read (a file is read as a duty plan and then as a roster picture):
// key path|mtime|page, a few files' worth.
const pageCache = new Map();

async function ocrPage(filePath, page, rotate = 0) {
  let key = null;
  try { key = `${path.resolve(filePath)}|${fs.statSync(filePath).mtimeMs}|${page}|${rotate}`; } catch { /* read it anyway */ }
  if (key && pageCache.has(key)) return pageCache.get(key);
  const data = await ocrPageNow(filePath, page, rotate);
  if (key) {
    pageCache.set(key, data);
    if (pageCache.size > 20) pageCache.delete(pageCache.keys().next().value);
  }
  return data;
}

async function ocrPageNow(filePath, page, rotate = 0) {
  const res = await fetch(`${OCR_SERVER_URL}/ocr`, {
    ...ocrRequest(filePath, { page, dpi: DPI, ...(rotate ? { rotate } : {}) }),
    signal: AbortSignal.timeout(Number(process.env.OCR_TIMEOUT_MS || 300000)),
  }).catch((e) => { throw new Error(`The OCR server is not responding (${OCR_SERVER_URL}): ${e.cause?.code || e.message}. This PDF has no text layer, so it needs OCR: npm run ocr:server`); });
  const data = await res.json().catch(() => null);
  if (!res.ok || !data?.ok) throw new Error(`PDF OCR failed: ${data?.error || `HTTP ${res.status}`}`);
  return data;
}

function fixToken(text) {
  let t = text;
  if (/^Peri[o0]d:?$/i.test(t)) return 'Period:';
  const day = /^(Mo|Tu|We|Th|Fr|Sa|Su).(\d{2})$/.exec(t); // "Sa227" -> Sat27
  if (day) return DAYS[day[1]] + day[2];
  const time = /^(!?)8(\d)(\d{2})$/.exec(t); // "8325" -> 0325 (hour > 23 cannot be)
  if (time && Number(`8${time[2]}`) > 23) t = `${time[1]}0${time[2]}${time[3]}`;
  return t;
}

/** OCR lines -> items in points; multi-word boxes split by character position. */
function toItems(data) {
  const items = [];
  for (const line of data.lines || []) {
    const xs = line.box.map(p => p[0] / data.scale);
    const ys = line.box.map(p => p[1] / data.scale);
    const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
    const text = String(line.text || '').replace(/(\d{2}[A-Z][a-z]{2}\d{2})-$/, '$1 -'); // "27Jun26-"
    const charW = (x1 - x0) / Math.max(1, text.length);
    for (const m of text.matchAll(/\S+/g)) {
      items.push({ text: fixToken(m[0]), x: x0 + m.index * charW, y: y0, w: m[0].length * charW, h: y1 - y0 });
    }
  }
  return items;
}

// Duty statistics keys as printed; OCR drops brackets and case ("FDT", "XFDP", "12:41Z").
const STAT_KEYS = Object.fromEntries(['DT', 'FDT', 'DP', 'FDP', 'aRT', 'RT', 'mFDP', 'xFDP', 'FT', 'DTR', 'SDT', 'TT', 'ABLZ', 'BRK', 'max', 'DTwSB']
  .map(k => [k.toLowerCase(), k]));

/** Rebuild "[KEY hh:mm]" from a key word and the time right of it on the same line. */
function pairStats(items) {
  const used = new Set();
  const out = [];
  for (const key of items) {
    const name = STAT_KEYS[(/^[[(]?([A-Za-z]{2,5})$/.exec(key.text)?.[1] || '').toLowerCase()];
    if (!name) continue;
    const value = items.find(v => !used.has(v) && Math.abs(v.y - key.y) <= 4 && v.x > key.x
      && v.x - (key.x + key.w) < 30 && /^\d{1,3}:\d{2}[\])Z]?$/.test(v.text));
    if (!value) continue;
    used.add(key).add(value);
    out.push({ ...key, text: `[${name} ${value.text.replace(/[\])Z]$/, '')}]`, w: value.x + value.w - key.x });
  }
  return [...items.filter(i => !used.has(i)), ...out];
}

/**
 * The header row ("date H duty R dep arr AC info", once per block) is often
 * read incompletely. Rebuild it from the "duty"/"arr" words found on it, so the
 * parser sees the same header as in a text PDF.
 */
function repairHeader(items) {
  // "duty" of the header row (not "Individual duty plan"): an "arr" on the same line.
  const duties = items.filter(i => i.text === 'duty' && items.some(a => a.text === 'arr' && Math.abs(a.y - i.y) <= 4 && a.x > i.x && a.x < i.x + 160));
  if (!duties.length) return items;
  const headerY = Math.min(...duties.map(d => d.y));
  const row = items.filter(i => Math.abs(i.y - headerY) <= 4);
  const blocks = row.filter(i => i.text === 'duty').sort((a, b) => a.x - b.x);
  const rebuilt = [];
  for (const duty of blocks) {
    const arr = row.find(i => i.text === 'arr' && i.x > duty.x && i.x < duty.x + 160);
    const span = arr ? arr.x - duty.x : 114;
    rebuilt.push({ ...duty, y: headerY });
    for (const [name, k] of Object.entries(HEADER_FROM_DUTY)) {
      rebuilt.push({ text: name, x: duty.x + k * span, y: headerY, w: 10, h: duty.h });
    }
  }
  return [...items.filter(i => !row.includes(i)), ...rebuilt];
}

/**
 * OCR of a "Personal Crew Schedule Report" grid (a picture of it, e.g. easyJet):
 * the title as printed ("PersonaCrewSchedueRepot"), the period line as one item
 * ("01/09/2024 - 30/09/2024 (All times in Local Base)"), cells read together
 * split again ("06/0907/09", "EJU4101EJU4273": neighbouring columns), "[320)" -> "[320]".
 */
function repairGrid(items) {
  const title = items.find(i => /^Persona\w*Crew\w*Sch/i.test(i.text.replace(/\s+/g, '')));
  if (!title) return items;
  title.text = 'Personal Crew Schedule Report';
  const out = [];
  for (const it of items) {
    const parts = [...it.text.matchAll(/\d{2}\/\d{2}(?!\/)|[A-Z]{2,3}\d{3,4}/g)];
    if (parts.length > 1 && parts.map(m => m[0]).join('') === it.text) {
      const charW = it.w / it.text.length;
      for (const m of parts) out.push({ ...it, text: m[0], x: it.x + m.index * charW, w: m[0].length * charW });
    } else {
      const ac = /^[[(]([A-Z0-9]{3,4})[\])]$/.exec(it.text);
      out.push(ac && /\d/.test(ac[1]) ? { ...it, text: `[${ac[1]}]` } : it);
    }
  }
  const from = out.find(i => /^\d{2}\/\d{2}\/\d{4}$/.test(i.text));
  if (from) {
    const line = out.filter(i => Math.abs(i.y - from.y) <= 4 && i.x >= from.x).sort((a, b) => a.x - b.x);
    const text = line.map(i => i.text).join(' ');
    const m = /^(\d{2}\/\d{2}\/\d{4})\s*-\s*(\d{2}\/\d{2}\/\d{4})\s*(.*)$/.exec(text);
    if (m) {
      const note = m[3].replace(/^\(|\)$/g, '').replace(/^A\w*\s+times/i, 'All times').trim();
      const last = line.at(-1);
      return [...out.filter(i => !line.includes(i)),
        { ...from, text: `${m[1]} - ${m[2]}${note ? ` (${note})` : ''}`, w: last.x + last.w - from.x }];
    }
  }
  return out;
}

// Words a page read the right way up is full of: times, words, airport codes.
const READABLE_RE = /^(\d{1,2}:\d{2}|[A-Z][a-z]{2,}|[a-z]{3,}|[A-Z]{3})$/;

/**
 * A page OCR'd the right way up. A scan lying on its side reads as standing boxes of
 * nonsense ("ZE/WBS"): when most boxes stand, the page is read again turned a quarter
 * each way (the OCR server's "rotate"), keeping the reading with more readable words.
 */
async function ocrUpright(filePath, page) {
  const data = await ocrPage(filePath, page);
  const boxes = (data.lines || []).filter(l => String(l.text).length >= 3).map((l) => {
    const xs = l.box.map(q => q[0]), ys = l.box.map(q => q[1]);
    return Math.max(...ys) - Math.min(...ys) > Math.max(...xs) - Math.min(...xs);
  });
  if (boxes.length < 10 || boxes.filter(Boolean).length < boxes.length * 0.6) return data;
  const readable = (d) => (d.lines || []).reduce((n, l) => n + String(l.text).split(/\s+/).filter(w => READABLE_RE.test(w)).length, 0);
  let best = data;
  for (const rotate of [90, 270]) {
    const turned = await ocrPage(filePath, page, rotate);
    if (turned.rotate === rotate && readable(turned) > readable(best)) best = turned;
  }
  return best;
}

export async function ocrPdfPages(filePath) {
  const first = await ocrUpright(filePath, 1);
  const results = [first];
  for (let p = 2; p <= (first.pageCount || 1); p += 1) results.push(await ocrUpright(filePath, p));
  return dayFirstDates(results.map((data, i) => ocrDataToPage(data, i + 1)));
}

// A page without text drawing at least this many paths has its text drawn as outlines (Crew Access prints: 839-1366);
// blank pages, logos and footers draw far fewer (0-387 seen).
const DRAWN_TEXT_PATHS = 600;

/**
 * A PDF with a text layer on some pages only (a print whose other pages have their text drawn as outlines): those
 * pages read by OCR, the others kept (blank pages too). Pages of a text file (CSV, Excel) are never empty this way.
 */
export async function ocrEmptyPages(filePath, pages) {
  const drawn = (p) => !p.items.length && !p.fromTextFile && (p.drawnPaths || 0) >= DRAWN_TEXT_PATHS;
  if (!pages.some(p => p.items.length) || !pages.some(drawn)) return pages;
  const out = [];
  for (const [k, p] of pages.entries()) {
    out.push(drawn(p) ? dayFirstDates([ocrDataToPage(await ocrUpright(filePath, k + 1), k + 1)])[0] : p);
  }
  return out;
}

/**
 * An image-only PDF as one tall picture (a roster screen printed to PDF, e.g.
 * Ryanair eCrew): every page's OCR lines, each page under the one before, in
 * pixels, as PaddleOCR gives them for a roster image. -> { lines, width, height }
 */
export async function ocrPdfAsImage(filePath) {
  const first = await ocrUpright(filePath, 1);
  const pages = [first];
  for (let p = 2; p <= (first.pageCount || 1); p += 1) pages.push(await ocrUpright(filePath, p));
  const lines = [];
  let top = 0;
  for (const p of pages) {
    for (const l of p.lines || []) lines.push({ ...l, box: l.box.map(([x, y]) => [x, y + top]) });
    top += p.height;
  }
  return { lines, width: Math.max(...pages.map(p => p.width)), height: top };
}

/** One OCR server answer (lines in pixels, `scale` px per pt) -> a page of items. */
export function ocrDataToPage(data, page = 1) {
  return {
    page,
    width: data.width / data.scale,
    height: data.height / data.scale,
    items: repairGrid(repairHeader(pairStats(toItems(data)))),
    ocr: true,
  };
}
