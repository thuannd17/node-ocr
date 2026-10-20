/**
 * Parser for NetLine/Crew "Individual duty plan" PDFs (text layer, no OCR).
 *
 * Page layout (as displayed, see services/pdf-text.js): a calendar strip, then a
 * header row repeated 3 times across the page,
 *     date  H  duty  R dep  arr  AC  info
 * and the days below it, newspaper style: block 1 top-down, then block 2,
 * block 3, then the next page. A day is a `Sat01` line followed by one line per
 * item (C/I, each flight leg, C/O, STBY, OFF, ...). The R column holds the
 * registration, on the item's own line (`DBF R VIE`) or on its own line right
 * under a flight leg (`A321`). The duty statistics ("[DT 12:30] [FDT ...]") sit
 * either in the info column starting level with the day's last item, or on
 * their own lines under it ("[FT 03:10][DT 05:35]...").
 *
 * The H column holds a hotel code (H1, H1*) on its own layover line ("H1* BOG")
 * after a day's last item: it becomes a row of its own (hotel, dep = layover
 * airport, info = name and phone from the "Hotels" table further on). It takes
 * no statistics: those stay with the day's last item. An item whose duty is a
 * code of the "Absence/Ground Activity Legend" (STBY, OFF, DBF, --, ...) gets
 * its description after its statistics ("[STBY: Standby]").
 *
 * After the last day come other sections (crew lists per leg, legends,
 * training expiry dates, hotels) under the same header row: parsing stops at
 * the first of their titles, in reading order.
 *
 * A compact variant prints only "date duty dep arr AC" (no H, R or info column),
 * its crew below the days as crew ids per flight number ("992 Cockpit:01736 03912"
 * / "Cabin:06366 ..."): see findCrewIdLists.
 *
 * Output: { published: [rows], planned: [rows] }. Rows: { date: '1 Mar 25',
 * day: 'Sat', hotel, duty, registration, dep, begin, end, arr, ac, info } — one
 * per item or hotel, every row carries its day's date. Days after "The
 * following is only for information ..." are `planned`, like the image rosters'
 * second table. Times are kept as printed, "!1300" included.
 */

import { parseTableRoster } from './table-roster-parser.js';

const HEADER_COLS = ['date', 'H', 'duty', 'R dep', 'arr', 'AC', 'info'];
// A day: "Sat01" (3-block plans) or "01. Sat" (single-column RYR plans).
const DAY_RE = /^(?:(Mon|Tue|Wed|Thu|Fri|Sat|Sun)(\d{2})|(\d{2})\.\s*(Mon|Tue|Wed|Thu|Fri|Sat|Sun))$/;
const parseDay = (text) => { const m = DAY_RE.exec(text); return m && { name: m[1] || m[4], num: Number(m[2] || m[3]) }; };
// "!1300": local time outside the homebase timezone, kept as printed; "!0054+1": the next day
const TIME_RE = /^!?\d{4}([+-]\d)?$/;
const AIRPORT_RE = /^[A-Z]{3}$/;
const DUTY_RE = /^([A-Z0-9]|--)/;
// [BRK 012:15] has 3 digits; [RT 11/0614] (I345) is a count/time pair
const STAT_RE = /([[(])\s*([A-Za-z]+)\s*(\d{1,3}:\d{2}|\d{1,3}\/\d{4})\s*([\])])/g;
const STAT_START_RE = /^[[(][A-Za-z]+(\s|$)/; // "[DT", "(ABLZ 0:00)"; not "(Konzert-Tickets)"
// Titles of the sections after the last day (crew lists, legends, totals, hotels,
// contacts) and the note before days outside the printed period.
const SECTION_END_RE = /^(Crew Information on|Absence\/Ground Activity Legend|Recurrent Training|Additional Summary|expiry date|Flight time|Messages|Hotels|Who to call|Local\s+times?\s+at\s+homebase)/;
// Compact plans: the crew ids of a flight under the days ("992 Cockpit:01736 03912", "Cabin:06366 06377").
const CREW_ID_LINE_RE = /^(?:(\d{1,5}[A-Z]?)\s+)?(Cockpit|Cabin):\s*((?:\d+\s*)+)$/;
// The compact plans' note on times: "Local time at homebase or (!) outside homebase".
const HOMEBASE_NOTE_RE = /^Local\s+times?\s+at\s+homebase\b/i;
// Days after this note are not published yet (or end outside the printed period):
// they go to `planned`, like the "Rest of this roster is planned" table of the image rosters.
const PLANNED_RE = /^The following is only for information/;
const HOTEL_CODE_RE = /^H(\d+\*?|\?)$/; // "H1", "H1*", "H?" (hotel not known yet)
// Duty of a hotel night whose file prints no hotel code (Schedule Details' "Hotel Information", a Crew Roster Report's AC/Hotel).
export const HOTEL_DUTY = 'HT';

/**
 * Rows as they are given out (labels since 2026-10-16): a hotel night is an event
 * of its own, its duty the printed code ("H1*") or HT; there is no hotel field.
 * The parsers and the AI model's assembler work with the hotel field (row.hotel,
 * duty "H") inside; this turns one such row into the given-out one.
 */
export function hotelAsEvent(row) {
  const { hotel, ...out } = row;
  if (hotel && !out.duty) out.duty = hotel;
  else if (out.duty === 'H') out.duty = HOTEL_DUTY;
  return out;
}

/** The other way, for code that learns from labels (the hotel field and duty "H" inside). */
export function hotelFromEvent(row) {
  if (row.duty === HOTEL_DUTY) return { ...row, hotel: '', duty: 'H' };
  // a hotel night has no times nor arrival ("H2624" SCL-GIG 15:00-19:10 is a flight)
  if (HOTEL_CODE_RE.test(row.duty || '') && !row.begin && !row.end && !row.arr) return { ...row, hotel: row.duty, duty: '' };
  return { hotel: '', ...row };
}
// Aircraft registration or type in the R column ("A321", "B738", "D-AIZA").
const REG_RE = /^([A-Z]\d{3}[A-Z]?|[A-Z0-9]{1,2}-[A-Z0-9]{3,5})$/;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "01Mar25" -> { day: 1, month: 2, year: 25 } */
function parseDdMonYy(s) {
  const m = /^(\d{2})([A-Z][a-z]{2})(\d{2})$/.exec(s || '');
  if (!m || !MONTHS.includes(m[2])) return null;
  return { day: Number(m[1]), month: MONTHS.indexOf(m[2]), year: Number(m[3]) };
}

/** Group items into lines (same y within `tol`), each sorted left to right. */
function toLines(items, tol = 1.5) {
  const sorted = [...items].sort((a, b) => a.y - b.y || a.x - b.x);
  const lines = [];
  for (const it of sorted) {
    const last = lines[lines.length - 1];
    if (last && Math.abs(it.y - last.y) <= tol) last.items.push(it);
    else lines.push({ y: it.y, items: [it] });
  }
  for (const l of lines) l.items.sort((a, b) => a.x - b.x);
  return lines;
}

/** Period "01Mar25 - 31Mar25" from the page header (tokens may be split), or "01/07/2024 - 31/07/2024 (...)" (Crew Schedule Reports). */
function findPeriod(pages) {
  for (const p of pages) {
    // "Period: 01Mar25 - 31Mar25", or after the name on one line: "Individual duty plan for ... Period: 31Aug26 -- 06Sep26"
    const line = toLines(p.items).map(l => l.items.map(i => i.text).join(' ')).find(t => /(^|\s)Period:/.test(t));
    const text = line && line.slice(line.indexOf('Period:'));
    const m = text && /^Period:\s*(\d{2}[A-Z][a-z]{2}\d{2})\s*-{1,2}\s*(\d{2}[A-Z][a-z]{2}\d{2})/.exec(text);
    if (m) return { from: parseDdMonYy(m[1]), to: parseDdMonYy(m[2]), text: `${m[1]} - ${m[2]}` };
    // "Period: October 2026": a whole month (rosters whose days print only "01 Thu")
    const mm = text && /^Period:\s*([A-Z][a-z]+)\s+(\d{4})\b/.exec(text);
    const month = mm ? MONTHS.indexOf(mm[1].slice(0, 3)) : -1;
    if (month >= 0) {
      const year = Number(mm[2]) % 100, last = new Date(Number(mm[2]), month + 1, 0).getDate();
      const yy = String(year).padStart(2, '0');
      return { from: { day: 1, month, year }, to: { day: last, month, year }, text: `01${MONTHS[month]}${yy} - ${last}${MONTHS[month]}${yy}` };
    }
  }
  for (const p of pages) {
    const m = p.items.map(i => GRID_PERIOD_RE.exec(i.text)).find(Boolean);
    if (!m) continue;
    const part = (d, mo, y) => ({ day: Number(d), month: Number(mo) - 1, year: Number(y) % 100 });
    const ddMonYy = (d) => `${String(d.day).padStart(2, '0')}${MONTHS[d.month]}${String(d.year).padStart(2, '0')}`;
    const from = part(m[1], m[2], m[3]), to = part(m[4], m[5], m[6]);
    return { from, to, text: `${ddMonYy(from)} - ${ddMonYy(to)}` };
  }
  return null;
}

/**
 * Notes printed on the "Period:" line right of the dates, e.g. "Local times at
 * event airport. (!) if not in homebase timezone" or "All CI/CO times are
 * local": whatever text is there, once per distinct text (it repeats per page).
 */
function findNotices(pages) {
  const notices = [];
  for (const p of pages) {
    const label = p.items.find(i => /^Period:/.test(i.text));
    if (!label) continue;
    const sameLine = p.items.filter(i => Math.abs(i.y - label.y) <= 1.5).sort((a, b) => a.x - b.x);
    const lastDate = sameLine.filter(i => /\d{2}[A-Z][a-z]{2}\d{2}/.test(i.text)).pop();
    if (!lastDate) continue;
    const text = sameLine.filter(i => i.x > lastDate.x + lastDate.w + 5).map(i => i.text).join(' ').replace(/\s+/g, ' ').trim();
    if (text && !notices.includes(text)) notices.push(text);
  }
  // Compact plans: the note on its own line under the days
  for (const p of pages) {
    const note = toLines(p.items).map(l => l.items.map(i => i.text).join(' ')).find(t => HOMEBASE_NOTE_RE.test(t));
    if (note && !notices.includes(note)) notices.push(note);
  }
  // Personal Crew Schedule Report: "01/01/2025 - 31/01/2025 (All times in UTC)"
  for (const p of pages) {
    const note = p.items.filter(i => GRID_PERIOD_RE.test(i.text)).map(i => /\(([^)]+)\)\s*$/.exec(i.text)?.[1].trim()).find(Boolean);
    if (note && !notices.includes(note)) notices.push(note);
  }
  return notices;
}

/** Zone of a Personal Crew Schedule Report's times: "Z" if its period line says "All times in UTC", else local. */
function scheduleReportZone(notices) {
  return notices.some(n => /All times in UTC/i.test(n)) ? 'Z' : 'L';
}

/**
 * "Hotels" tables: code -> "name, Tel phone". Rows are `H1 | name | phone`
 * (phone ~165 pt right of the code); a name may wrap onto the next line.
 */
function findHotels(pages) {
  const hotels = new Map();
  for (const page of pages) {
    for (const title of page.items.filter(i => i.text === 'Hotels')) {
      const x0 = title.x;
      const items = page.items.filter(i => i.x >= x0 - 3 && i.x < x0 + 262 && i.y > title.y + 1);
      let prevY = title.y;
      let entry = null;
      for (const line of toLines(items)) {
        if (line.y - prevY > (entry ? 14 : 25)) break;
        const [first] = line.items;
        if (HOTEL_CODE_RE.test(first.text) && first.x < x0 + 6) {
          entry = { code: first.text.replace('*', ''), name: [], phone: [] };
          hotels.set(entry.code, entry);
        } else if (!entry || first.x < x0 + 15) break; // not a continuation of the table
        for (const it of line.items) {
          if (it === first && HOTEL_CODE_RE.test(it.text)) continue;
          (it.x >= x0 + 160 ? entry.phone : entry.name).push(it.text);
        }
        prevY = line.y;
      }
    }
  }
  // RYR plans list hotels as "H1 | Hotel: | STC, | Phone: | 123456", without a title.
  for (const page of pages) {
    for (const line of toLines(page.items)) {
      const [code, label, ...rest] = line.items;
      if (!code || !HOTEL_CODE_RE.test(code.text) || label?.text !== 'Hotel:' || hotels.has(code.text.replace('*', ''))) continue;
      const at = rest.findIndex(i => i.text === 'Phone:');
      const name = (at < 0 ? rest : rest.slice(0, at)).map(i => i.text);
      const phone = at < 0 ? [] : rest.slice(at + 1).map(i => i.text);
      hotels.set(code.text.replace('*', ''), { code: code.text, name, phone });
    }
  }
  return new Map([...hotels].map(([code, h]) => [code,
    [h.name.join(' ').replace(/,\s*$/, ''), h.phone.length ? `Tel ${h.phone.join(' ')}` : ''].filter(Boolean).join(', ')]));
}

/**
 * "Absence/Ground Activity Legend": code -> description. Rows are
 * `code | description` (description ~64 pt right of the title); the table ends
 * at a gap or the next title ("Additional Summary").
 */
function findLegend(pages) {
  const legend = new Map();
  for (const page of pages) {
    for (const title of page.items.filter(i => /^Absence\/Ground Activity Legend/.test(i.text))) {
      const x0 = title.x;
      const items = page.items.filter(i => i.x >= x0 - 8 && i.x < x0 + 262 && i.y > title.y + 1);
      let prevY = title.y;
      let last = null;
      for (const line of toLines(items)) {
        const text = line.items.map(i => i.text).join(' ');
        if (line.y - prevY > (last ? 14 : 25) || SECTION_END_RE.test(text) || /^Additional Summary/.test(text)) break;
        prevY = line.y;
        const [first, ...rest] = line.items;
        if (first.text === 'code' && rest[0]?.text === 'description') continue; // column header
        if (first.x < x0 + 10) {
          last = { code: first.text, desc: rest.map(i => i.text) };
          legend.set(last.code, last);
        } else if (last && first.x >= x0 + 40) {
          last.desc.push(...line.items.map(i => i.text)); // wrapped description
        } else break;
      }
    }
  }
  // Codes without a description ("REF") stay in: they still make a code a roster item.
  return new Map([...legend].map(([code, l]) => [code, l.desc.join(' ')]));
}

const RYR_COLS = ['date', 'stops', 'duty', 'req', 'dep', 'arr', 'AC', 'rank', 'info'];

/**
 * The repeated column header row of a page -> one column map per block.
 * Two layouts: 2-3 blocks of "date H duty R dep arr AC info" per landscape
 * page, or one column "date stops duty req dep arr AC rank info" per portrait
 * page (RYR plans; days written "01. Thu").
 */
function findBlocks(page) {
  const dates = page.items.filter(i => i.text === 'date');
  if (!dates.length) return null;
  const headerY = Math.min(...dates.map(d => d.y));
  const row = page.items.filter(i => Math.abs(i.y - headerY) <= 1.5);
  if (row.some(i => i.text === 'stops') && row.some(i => i.text === 'req')) {
    const col = { kind: 'ryr' };
    for (const name of RYR_COLS) {
      const hit = row.find(i => i.text === name);
      if (hit) col[name] = hit.x;
    }
    return { headerY, blocks: [{ x0: col.date - 25, x1: Infinity, col }] }; // day numbers sit left of "date"
  }
  const starts = row.filter(i => i.text === 'date').map(i => i.x).sort((a, b) => a - b);
  return {
    headerY,
    blocks: starts.map((x0, k) => {
      const x1 = k + 1 < starts.length ? starts[k + 1] : Infinity;
      const col = {};
      for (const name of HEADER_COLS) {
        const hit = row.find(i => i.text === name && i.x >= x0 - 1 && i.x < x1 - 1);
        if (hit) col[name] = hit.x;
      }
      // Compact "date duty dep arr AC": no H, R or info column. C/I and C/O start
      // between date and duty, as under H in the full layout; times sit nearer dep.
      const dep = row.find(i => i.text === 'dep' && i.x >= x0 - 1 && i.x < x1 - 1);
      if (col['R dep'] == null && dep && col.duty != null && col.arr != null) {
        Object.assign(col, { kind: 'compact', 'R dep': dep.x, H: col.date + 20, info: Infinity });
      }
      return { x0, x1, col };
    }),
  };
}

/** Column of an item in a single-column RYR plan, relative to its header positions. */
function ryrColumnOf(x, col) {
  if (x >= col.info - 4) return 'info';
  if (x >= col.rank - 4) return 'rank';
  if (x >= col.AC - 8) return 'ac';
  if (x >= col.arr - 4) return 'arr';
  const rel = (x - col.dep) / (col.arr - col.dep); // begin ~30%, end ~68% from "dep" to "arr"
  if (rel >= 0.25) return rel < 0.55 ? 'begin' : 'end';
  if (x >= col.req - 4) return 'rdep'; // the req flag ("R") and the dep airport, like "R dep"
  if (x >= col.duty - 20) return 'duty';
  if (x >= col.stops - 10) return 'stops'; // "(-)"
  return 'date';
}

// A trip (pairing) number printed under the C/I that starts it: "M1075/05May", "V2225A/06Apr".
const TRIP_RE = /^[A-Z]\d{3,5}[A-Z]?\/\d{2}[A-Z][a-z]{2}$/;

/** Column of one item inside a block, from the header positions. */
function columnOf(x, col) {
  if (col.kind === 'ryr') return ryrColumnOf(x, col);
  const rdep = col['R dep'];
  const compact = col.kind === 'compact';
  if (x >= col.info - 4) return 'info';
  if (x >= col.AC - (compact ? 8 : 4)) return 'ac';
  if (x >= col.arr - 6) return 'arr';
  // begin/end sit at ~42% / ~70% of the way from "R dep" to "arr" (layouts differ in width);
  // in compact plans at ~31% / ~65% from "dep"
  const rel = (x - rdep) / (col.arr - rdep);
  if (rel >= (compact ? 0.2 : 0.36)) return rel < (compact ? 0.5 : 0.56) ? 'begin' : 'end';
  if (x >= rdep - 3) return 'rdep';
  if (x >= col.H + 5) return 'duty'; // C/I and C/O start a little right of the H header
  if (x >= col.date + 20) return 'h';
  return 'date';
}

function formatDate(dayNum, ctx) {
  // Days run in order; a smaller day number than the previous one means the next month.
  if (ctx.lastDay != null && dayNum < ctx.lastDay) ctx.month += 1;
  if (ctx.month > 11) { ctx.month = 0; ctx.year += 1; }
  ctx.lastDay = dayNum;
  return `${dayNum} ${MONTHS[ctx.month]} ${String(ctx.year).padStart(2, '0')}`;
}

/** "0759 !0842" printed as one item: split into two at their character positions (monospace font). */
// --- Trace (training data for a learned extractor, scripts/build-pdf-token-data.mjs) ---
// While parseNetlinePdf(pages, { trace: true }) runs, every PDF item that ends up
// in a row is recorded as { item, off, len, field, row }. It never changes rows.
let TRACE = null;
const mark = (row, field, items) => {
  if (!TRACE || !row) return;
  for (const it of [].concat(items || [])) {
    if (it) TRACE.push({ item: it._src || it, off: it._off ?? null, len: it.text.length, field, row });
  }
};
const startTrace = () => (TRACE ? (TRACE = []) : null);

function splitTimes(items) {
  // "0759 !0842", "2220 !0054+1 OSL": times (and an airport after them) in one item
  return items.flatMap((it) => {
    const parts = [...it.text.matchAll(/\S+/g)];
    if (parts.length < 2 || !TIME_RE.test(parts[0][0]) || !TIME_RE.test(parts[1][0])
      || !parts.slice(2).every(p => AIRPORT_RE.test(p[0]))) return [it];
    const charW = it.w / it.text.length;
    return parts.map(p => ({ ...it, text: p[0], x: it.x + p.index * charW, w: p[0].length * charW, _src: it._src || it, _off: (it._off || 0) + p.index }));
  });
}

function statsText(text) {
  return [...text.matchAll(STAT_RE)].map(m => `${m[1]}${m[2]} ${m[3]}${m[4]}`);
}

/**
 * Crew message on a line: "To c/m: ..." / "From c/m: ...", possibly after other
 * text in the same item ("(ABLZ | 2:37) To | c/m: Der ..."). Returns the line's
 * items before it (the item holding the start cut) and the message text.
 */
function splitMessage(items) {
  let text = '';
  const spans = [];
  for (const it of items) {
    const start = text ? text.length + 1 : 0;
    text = text ? `${text} ${it.text}` : it.text;
    spans.push([start, text.length]);
  }
  const m = /\b(?:To|From) c\/m\b/.exec(text);
  if (!m) return null;
  const rest = [];
  items.forEach((it, k) => {
    const [s0, s1] = spans[k];
    if (s1 <= m.index) rest.push(it);
    else if (s0 < m.index) {
      const head = it.text.slice(0, m.index - s0).trim();
      if (head) rest.push({ ...it, text: head });
    }
  });
  return { rest, message: text.slice(m.index).trim() };
}

/** A line that only continues a crew message: no day, event, statistics or hotel on it. */
function continuesMessage(items, col) {
  if (items.some(i => DAY_RE.test(i.text)) || STAT_START_RE.test(items[0].text)) return false;
  const cells = {};
  for (const it of splitTimes(items)) (cells[columnOf(it.x, col)] ||= []).push(it.text);
  if ([...(cells.begin || []), ...(cells.end || [])].some(t => TIME_RE.test(t))) return false;
  if (AIRPORT_RE.test((cells.rdep || []).at(-1) || '')) return false;
  if ((cells.h || []).some(t => HOTEL_CODE_RE.test(t))) return false;
  return !/^([A-Z0-9][A-Z0-9_/.-]*|--)( \d+)?$/.test((cells.duty || []).join(' ')); // an event code
}

/**
 * One time format for every layout: "HH:MM Z" (UTC), "HH:MM B" (homebase time),
 * "HH:MM L" (local, printed with "!" as in "!1300"), or "HH:MM Z / HH:MM L" when
 * both are given (already built by the layouts that print both). A day offset
 * ("2200-1") is kept after it, and so is an "A" (actual) / "E" (estimated) prefix
 * ("A12:15 Z"). `plain` is the zone of a time printed without "!",
 * from the plan's note: 'B' (homebase), 'LB' (departure airport), 'L' or 'Z'.
 */
export function formatTime(raw, plain = 'Z') {
  const text = String(raw || '').trim();
  const m = /^([AE]?)(!?)(\d{2}):?(\d{2})([+-]\d)?$/.exec(text);
  if (!m) return text; // "05:00 Z / 00:00 L", or something unexpected: as printed
  return `${m[1]}${m[3]}:${m[4]} ${m[2] ? 'L' : plain}${m[5] ? ` ${m[5]}` : ''}`;
}

/** A row in the output field order; `dc` (duty code) only exists in Crew Roster Reports, `crew` in Schedule Details reports.
 * `hotel` is the inside field: parseNetlinePdf gives it out as the row's duty (hotelAsEvent). */
function outputRow(r, plain = 'Z') {
  return {
    date: r.date, day: r.day, hotel: r.hotel || '', dc: r.dc || '', duty: r.duty, registration: r.registration || '',
    dep: r.dep || '', begin: formatTime(r.begin, plain), end: formatTime(r.end, plain), arr: r.arr || '', ac: r.ac || '', crew: r.crew || '', info: r.info || '',
  };
}

const REPORT_COLS = ['Date', 'DC', 'C/I (Z)', 'C/O (Z)', 'Activity', 'From', 'STD (Z)', 'To', 'STA (Z)', 'AC/Hotel', 'Blk Hrs', 'Duty Hrs'];
const REPORT_DATE_RE = /^(\d{2})([A-Z][a-z]{2})(\d{2})$/;
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** Header row of a "Crew Roster Report" table (Date | DC | C/I (Z) | ... | Duty Hrs). */
function findReportHeader(page) {
  const activity = page.items.find(i => i.text === 'Activity');
  if (!activity) return null;
  const row = page.items.filter(i => Math.abs(i.y - activity.y) <= 1.5);
  if (!row.some(i => i.text === 'AC/Hotel')) return null;
  const cols = REPORT_COLS.map(name => ({ name, x: row.find(i => i.text === name)?.x }))
    .filter(c => c.x != null).sort((a, b) => a.x - b.x);
  return { y: activity.y, cols };
}

/**
 * "Crew Roster Report" (one table row per line):
 *   Date | DC | C/I (Z) | C/O (Z) | Activity | From | STD (Z) | To | STA (Z) | AC/Hotel | Blk Hrs | Duty Hrs
 * A line gives, in order: a C/I row (begin = C/I time) if there is one, the
 * activity (duty = Activity, dep = From, begin = STD, arr = To, end = STA,
 * ac = AC/Hotel up to 3 characters; Blk Hrs goes to its info), a C/O row (end =
 * C/O time; Duty Hrs goes to its info), and for a longer AC/Hotel text a hotel
 * row (duty "H", given out as HT; info = the hotel). `dc` is the DC column of the line, on the
 * activity (and hotel) row only, not on C/I or C/O.
 */
function parseCrewRosterReport(pages) {
  const trace = startTrace();
  const period = findPeriod(pages);
  const rows = [];
  let date = '', day = '';
  let lastEvent = null, lastCO = null;
  for (const page of pages) {
    const header = findReportHeader(page);
    if (!header) continue;
    const colOf = (x) => header.cols.filter(c => x >= c.x - 3).pop()?.name; // each column runs to the next header
    for (const line of toLines(page.items.filter(i => i.y > header.y + 2))) {
      const cell = {};
      for (const it of line.items) { const c = colOf(it.x); if (c) (cell[c] ||= []).push(it); }
      const get = (c) => (cell[c] || []).map(i => i.text).join(' ').trim();
      const d = REPORT_DATE_RE.exec(get('Date'));
      if (d && MONTHS.includes(d[2])) {
        date = `${Number(d[1])} ${d[2]} ${d[3]}`;
        day = WEEKDAYS[new Date(2000 + Number(d[3]), MONTHS.indexOf(d[2]), Number(d[1])).getDay()];
      }
      const activity = get('Activity'), ci = get('C/I (Z)'), co = get('C/O (Z)'), acHotel = get('AC/Hotel');
      const blk = get('Blk Hrs'), dutyHrs = get('Duty Hrs');
      if (!date || !(activity || ci || co || acHotel || blk || dutyHrs)) continue; // page footer, blank line
      const base = { section: 'published', date, day, dc: get('DC'), notes: [] };
      const firstRow = rows.length;
      // The DC belongs to the activity; C/I and C/O rows carry none.
      // C/I, C/O "0210+1": the next day (kept as "02:10 Z +1")
      if (/^\d{4}([+-]\d)?$/.test(ci)) {
        const ciRow = { ...base, dc: '', duty: 'C/I', dep: get('From'), begin: ci, notes: [] };
        rows.push(ciRow);
        mark(ciRow, 'ci', cell['C/I (Z)']); // the time makes the C/I row
      }
      let event = null;
      if (activity) {
        event = {
          ...base, duty: activity, dep: get('From'), begin: get('STD (Z)'), arr: get('To'), end: get('STA (Z)'),
          ac: acHotel.length <= 3 ? acHotel : '', notes: [],
        };
        rows.push(event);
        lastEvent = event;
        mark(event, 'dc', cell.DC);
        mark(event, 'duty', cell.Activity);
        mark(event, 'dep', cell.From);
        mark(event, 'begin', cell['STD (Z)']);
        mark(event, 'arr', cell.To);
        mark(event, 'end', cell['STA (Z)']);
        if (acHotel.length <= 3) mark(event, 'ac', cell['AC/Hotel']);
      }
      if (/^\d+:\d{2}$/.test(blk)) { (event || lastEvent)?.notes.push(`[Block: ${blk}]`); mark(event || lastEvent, 'info', cell['Blk Hrs']); }
      let coRow = null;
      if (/^\d{4}([+-]\d)?$/.test(co)) {
        coRow = { ...base, dc: '', duty: 'C/O', arr: get('To'), end: co, notes: [] };
        rows.push(coRow);
        lastCO = coRow;
        mark(coRow, 'co', cell['C/O (Z)']);
      }
      if (/^\d+:\d{2}$/.test(dutyHrs)) { (coRow || lastCO)?.notes.push(`[Duty: ${dutyHrs}]`); mark(coRow || lastCO, 'info', cell['Duty Hrs']); }
      if (acHotel.length > 3) {
        const hRow = { ...base, duty: 'H', dep: get('To') || get('From'), notes: [acHotel] };
        rows.push(hRow);
        mark(hRow, 'hotel', cell['AC/Hotel']);
      }
      if (d && rows.length > firstRow) mark(rows[firstRow], 'date', cell.Date);
    }
  }
  const out = rows.map(r => outputRow({ ...r, info: r.notes.join(' ') }));
  return { format: 'crew-roster-report', period: period?.text || null, notices: [], recognized: out.length > 0, published: out, planned: [], _trace: trace, _rows: rows };
}

/** Header row of a "Crew member's flight time record" (flight | date | flightno | registr | type | dep | arr ...). */
function findFlightRecordHeader(page) {
  const flightno = page.items.find(i => i.text === 'flightno');
  if (!flightno) return null;
  const row = page.items.filter(i => Math.abs(i.y - flightno.y) <= 1.5).sort((a, b) => a.x - b.x);
  const at = (t) => row.find(i => i.text === t)?.x;
  if (at('registr') == null || at('dep') == null || at('arr') == null) return null;
  return { y: flightno.y, row, x: { date: at('date'), flightno: at('flightno'), registr: at('registr'), type: at('type'), dep: at('dep'), arr: at('arr'), sim: at('SIM') } };
}

/**
 * "Crew member's flight time record": one flown leg per line,
 *   flight | date | flightno | registr | type | dep | off | on | arr | Block Time per Leg (or 1.pilot / 2.pilot) | SIM
 * flightno -> duty, registr -> registration, type -> ac, the two unlabeled times
 * between dep and arr -> begin/end; the time columns after arr go to info
 * ("[Block: 3:12]": block time, as every layout writes it (also [Flight: ..] [Duty: ..] [Layover: ..] [Rest: ..] [Sim: ..]); "[1.pilot 1:54]"). The "flight" counter is skipped.
 * The note on the "Date" line ("All times in UTC! ...") is a notice.
 */
function parseFlightTimeRecord(pages) {
  const trace = startTrace();
  const rows = [];
  const notices = [];
  let month = null;
  for (const page of pages) {
    const header = findFlightRecordHeader(page);
    if (!header) continue;
    const { x } = header;
    // "Date : Aug24" line: the month, and the note right of it.
    for (const line of toLines(page.items.filter(i => i.y < header.y - 2))) {
      const text = line.items.map(i => i.text).join(' ');
      const m = /^Date\s*:\s*([A-Z][a-z]{2})(\d{2})/.exec(text);
      if (!m) continue;
      month = month || { mon: m[1], yy: m[2] };
      const note = /\bAll\s+times\b.*$/.exec(text)?.[0].replace(/\s+/g, ' ').trim();
      if (note && !notices.includes(note)) notices.push(note);
    }
    // Columns after arr ("Block Time" "per Leg", or "1.pilot" "2.pilot") before SIM.
    const timeCols = header.row.filter(i => i.x > x.arr + 10 && (x.sim == null || i.x < x.sim - 3));
    const blockTime = timeCols.some(i => /^Block/.test(i.text));
    const labelAt = (vx) => {
      if (x.sim != null && vx >= x.sim - 3) return 'Sim:';
      if (blockTime) return 'Block:';
      return timeCols.filter(c => vx >= c.x - 3).pop()?.text || timeCols[0]?.text || 'Block:';
    };
    for (const line of toLines(page.items.filter(i => i.y > header.y + 2))) {
      const first = line.items[0].text;
      if (/^(sum|forward)$/.test(first)) break; // totals after the last leg
      const date = line.items.find(i => i.x < x.flightno - 3 && REPORT_DATE_RE.test(i.text));
      if (!date) continue;
      const d = REPORT_DATE_RE.exec(date.text);
      const colItems = (lo, hi) => line.items.filter(i => i.x >= lo && i.x < hi);
      const col = (lo, hi) => colItems(lo, hi).map(i => i.text).join(' ').trim();
      const times = line.items.filter(i => i.x >= x.dep + 25 && i.x < x.arr - 3 && /^!?\d{4}$/.test(i.text));
      const infoItems = line.items.filter(i => i.x >= x.arr + 25 && /^\d+:\d{2}$/.test(i.text));
      const info = infoItems.map(i => `[${labelAt(i.x)} ${i.text}]`);
      const row = outputRow({
        date: `${Number(d[1])} ${d[2]} ${d[3]}`,
        day: WEEKDAYS[new Date(2000 + Number(d[3]), MONTHS.indexOf(d[2]), Number(d[1])).getDay()],
        duty: col(x.flightno - 3, x.registr - 3),
        registration: col(x.registr - 3, x.type - 3),
        ac: col(x.type - 3, x.dep - 3),
        dep: col(x.dep - 3, x.dep + 25),
        begin: times[0]?.text || '',
        end: times[1]?.text || '',
        arr: col(x.arr - 3, x.arr + 25),
        info: info.join(' '),
      });
      rows.push(row);
      mark(row, 'date', date);
      mark(row, 'duty', colItems(x.flightno - 3, x.registr - 3));
      mark(row, 'registration', colItems(x.registr - 3, x.type - 3));
      mark(row, 'ac', colItems(x.type - 3, x.dep - 3));
      mark(row, 'dep', colItems(x.dep - 3, x.dep + 25));
      mark(row, 'begin', times[0]);
      mark(row, 'end', times[1]);
      mark(row, 'arr', colItems(x.arr - 3, x.arr + 25));
      mark(row, 'info', infoItems);
    }
  }
  const last = month && new Date(2000 + Number(month.yy), MONTHS.indexOf(month.mon) + 1, 0).getDate();
  return {
    format: 'flight-time-record',
    period: month ? `01${month.mon}${month.yy} - ${last}${month.mon}${month.yy}` : null,
    notices,
    recognized: rows.length > 0,
    published: rows,
    planned: [],
    _trace: trace,
  };
}

const FLIGHTLOG_COLS = ['Year', 'Month', 'Date', 'Dep', 'Block-Off', 'Arr', 'Block-On', 'Blocktime', 'AcType', 'AcRegId', 'PiC'];

/** Header row of a crew flight log (Year | Month | Date | Dep | Block-Off | Arr | Block-On | Blocktime | AcType | AcRegId | ...). */
function findFlightLogHeader(page) {
  const off = page.items.find(i => i.text === 'Block-Off');
  if (!off) return null;
  const row = page.items.filter(i => Math.abs(i.y - off.y) <= 1.5);
  if (!row.some(i => i.text === 'AcRegId')) return null;
  const cols = FLIGHTLOG_COLS.map(name => ({ name, x: row.find(i => i.text === name)?.x }))
    .filter(c => c.x != null).sort((a, b) => a.x - b.x);
  return { y: off.y, cols };
}

/**
 * Crew flight log (e.g. "Austrian Airlines Crew Flightlog"), one flown leg per line:
 *   Year | Month | Date "14.08." | Dep | Block-Off | Arr | Block-On | Blocktime | AcType | AcRegId | PiC ...
 * Block-Off -> begin, Block-On -> end, Blocktime -> info "[Block: 03:12]",
 * AcType -> ac, AcRegId -> registration. Year is printed on the first line of a
 * page only. The pilot names and function times (PiC, CP, FO, ...) are skipped.
 */
function parseFlightLog(pages) {
  const trace = startTrace();
  const rows = [];
  let year = null;
  for (const page of pages) {
    const header = findFlightLogHeader(page);
    if (!header) continue;
    const regX = header.cols.find(c => c.name === 'AcRegId')?.x ?? Infinity;
    const colOf = (x) => {
      // Pilot names start well left of the "PiC" header: only the registration is right of "AcRegId".
      if (x > regX + 40) return 'PiC';
      return header.cols.filter(c => x >= c.x - 6).pop()?.name;
    };
    for (const line of toLines(page.items.filter(i => i.y > header.y + 2))) {
      if (line.items.some(i => /Summary/.test(i.text))) break; // totals after the last leg
      const cell = {};
      for (const it of line.items) { const c = colOf(it.x); if (c) (cell[c] ||= []).push(it); }
      const get = (c) => (cell[c] || []).map(i => i.text).join(' ').trim();
      if (/^\d{4}$/.test(get('Year'))) year = Number(get('Year'));
      const d = /^(\d{2})\.(\d{2})\.$/.exec(get('Date'));
      if (!d || !year) continue;
      const [day, month] = [Number(d[1]), Number(d[2]) - 1];
      const blockTime = get('Blocktime');
      const row = outputRow({
        date: `${day} ${MONTHS[month]} ${String(year % 100).padStart(2, '0')}`,
        day: WEEKDAYS[new Date(year, month, day).getDay()],
        duty: '',
        dep: get('Dep'),
        begin: get('Block-Off'),
        arr: get('Arr'),
        end: get('Block-On'),
        ac: get('AcType'),
        registration: get('AcRegId'),
        info: blockTime ? `[Block: ${blockTime}]` : '',
      });
      rows.push(row);
      for (const [c, f] of [['Year', 'date'], ['Month', 'date'], ['Date', 'date'], ['Dep', 'dep'], ['Block-Off', 'begin'], ['Arr', 'arr'],
        ['Block-On', 'end'], ['AcType', 'ac'], ['AcRegId', 'registration'], ['Blocktime', 'info']]) mark(row, f, cell[c]);
    }
  }
  // Period from the legs' months (the "reported period" footer can carry another year).
  const months = rows.map(r => r.date.split(' ').slice(1).join(' '));
  const span = (m) => { const [mon, yy] = m.split(' '); return { mon, yy, last: new Date(2000 + Number(yy), MONTHS.indexOf(mon) + 1, 0).getDate() }; };
  const first = months.length && span(months[0]), last = months.length && span(months.at(-1));
  return {
    _trace: trace,
    format: 'flight-log',
    period: first ? `01${first.mon}${first.yy} - ${last.last}${last.mon}${last.yy}` : null,
    notices: [],
    recognized: rows.length > 0,
    published: rows,
    planned: [],
  };
}

/** An item's words with their x (monospace fonts: x from the character position), traced back to the item. */
function wordsIn(it) {
  const charW = it.text.length ? it.w / it.text.length : 0;
  return [...it.text.matchAll(/\S+/g)].map(m => ({ ...it, text: m[0], x: it.x + m.index * charW, w: m[0].length * charW, _src: it._src || it, _off: (it._off || 0) + m.index }));
}

const ACTIVITY_LIST_COLS = ['Activity', 'Checkin', 'Start', 'Dep', 'Arr', 'End', 'Checkout', 'AcVer', 'DD', 'CAT', 'Crew'];
// Month names as these reports print them: English, Portuguese (FEV, ABR, MAI, AGO, SET, OUT, DEZ), Spanish (ENE, DIC)
const MONTH_ALIASES = { FEV: 1, ABR: 3, MAI: 4, AGO: 7, SET: 8, OUT: 9, DEZ: 11, ENE: 0, DIC: 11 };
const monthIndex = (mon) => {
  const m = String(mon).toUpperCase();
  const en = MONTHS.findIndex(x => x.toUpperCase() === m);
  return en >= 0 ? en : (MONTH_ALIASES[m] ?? -1);
};

/** Header line of an activity list: Activity | Checkin | Start | Dep | Arr | End | Checkout | AcVer | DD | CAT | Crew */
function findActivityListHeader(page) {
  for (const line of toLines(page.items)) {
    const at = (t) => line.items.find(i => i.text === t);
    if (!['Activity', 'Checkin', 'Checkout', 'AcVer'].every(at)) continue;
    // a value sits around the middle of its header word (dates start well left of "Start", "End")
    return { y: line.y, cols: ACTIVITY_LIST_COLS.map(name => at(name)).filter(Boolean).map(i => ({ name: i.text, mid: i.x + i.w / 2 })) };
  }
  return null;
}

/**
 * Activity list (an airline's crew activity export, e.g. Azul; one activity per line, "-" for none):
 *   Activity | Checkin | Start | Dep | Arr | End | Checkout | AcVer | DD | CAT | Crew
 *   AD4061 | 30MAR23 21:40 | CNF | CWB | 30MAR23 23:20 | 30MAR23 23:50 | 295 | T | FO
 * Dates "30MAR23" (English or Portuguese months: FEV, ABR, AGO...), a time next to them, sometimes cut
 * into "15 | : | 00". Cells are found by x (a line leaves empty cells out). As in the Crew Roster
 * Report: a Checkin gives a C/I row (dep, begin), the activity a row (duty = Activity, dep, begin =
 * Start, arr, end = End with "+1" when it ends a later day, ac = AcVer, dc = CAT, crew = Crew), a
 * Checkout a C/O row (arr, end). Some exports repeat the duty's Checkin / Checkout on every leg: one
 * C/I before its first leg, one C/O after its last. Times are UTC (no zone printed; the off days of
 * Brazilian crews start at 03:00, i.e. midnight in Brasilia).
 */
function parseActivityList(pages) {
  const trace = startTrace();
  const rows = [];
  const stamp = (text) => {
    const m = /^(\d{2})([A-Z]{3})(\d{2})\s*(\d{1,2}):(\d{2})$/.exec(String(text).replace(/\s*:\s*/g, ':').replace(/\s+/g, ' ').trim());
    if (!m || monthIndex(m[2]) < 0) return null;
    const [day, month, year] = [Number(m[1]), monthIndex(m[2]), 2000 + Number(m[3])];
    return { date: `${day} ${MONTHS[month]} ${m[3]}`, day: WEEKDAYS[new Date(year, month, day).getDay()], time: `${m[4].padStart(2, '0')}${m[5]}`, t: Date.UTC(year, month, day) };
  };
  let lastCI = null;   // the C/I value printed last ("30MAR23 21:40"), so a repeated one makes no new row
  let pendingCO = null; // { key, row }: the C/O waits until its duty's last leg
  const flushCO = () => { if (pendingCO) { rows.push(pendingCO.row); pendingCO = null; } };
  let first = null, last = null;
  let header = null;
  for (const page of pages) {
    // the next pages may go on without the header line: its columns stay
    const own = findActivityListHeader(page);
    header = own || (header && { ...header, y: -Infinity });
    if (!header) continue;
    const colOf = (it) => {
      const mid = it.x + it.w / 2;
      return header.cols.reduce((a, c) => (Math.abs(c.mid - mid) < Math.abs(a.mid - mid) ? c : a)).name;
    };
    for (const line of toLines(page.items.filter(i => i.y > header.y + 2))) {
      // pieces of one value printed apart ("01AGO22 15" ":" "00", "01MAR18" "03:00") make one cell item
      const pieces = [];
      for (const it of line.items) {
        const prev = pieces.at(-1);
        if (prev && it.x - (prev.x + prev.w) < 3) {
          prev.text += (/:$/.test(prev.text) || it.text === ':' ? '' : ' ') + it.text;
          prev.w = it.x + it.w - prev.x;
          prev.parts.push(it);
        } else pieces.push({ ...it, parts: [it] });
      }
      const cell = {};
      for (const pc of pieces) (cell[colOf(pc)] ||= []).push(pc);
      const get = (c) => { const t = (cell[c] || []).map(i => i.text).join(' ').trim(); return t === '-' ? '' : t; };
      const activity = get('Activity');
      const start = stamp(get('Start')), end = stamp(get('End'));
      if (!activity || !start) continue; // the crew member's name line, a page footer
      const ci = stamp(get('Checkin')), co = stamp(get('Checkout'));
      const coKey = get('Checkout');
      if (pendingCO && pendingCO.key !== coKey) flushCO();
      if (ci && get('Checkin') !== lastCI) {
        flushCO();
        const ciRow = { section: 'published', date: ci.date, day: ci.day, duty: 'C/I', dep: get('Dep'), begin: ci.time, notes: [] };
        rows.push(ciRow);
        mark(ciRow, 'ci', cell.Checkin?.flatMap(pc => pc.parts));
        lastCI = get('Checkin');
      }
      const after = (x) => { const d = Math.round((x.t - start.t) / 86400000); return d > 0 ? `${x.time}+${d}` : x.time; };
      const event = {
        section: 'published', date: start.date, day: start.day, duty: activity, dc: get('CAT'), dep: get('Dep'), begin: start.time,
        arr: get('Arr'), end: end ? after(end) : '', ac: get('AcVer'), crew: get('Crew'), notes: [],
      };
      rows.push(event);
      for (const [f, c] of [['duty', 'Activity'], ['date', 'Start'], ['begin', 'Start'], ['dep', 'Dep'], ['arr', 'Arr'], ['end', 'End'], ['ac', 'AcVer'], ['dc', 'CAT'], ['crew', 'Crew']]) mark(event, f, cell[c]?.flatMap(pc => pc.parts));
      first ||= start;
      last = end || start;
      if (co && !pendingCO) {
        const coRow = { section: 'published', date: co.date, day: co.day, duty: 'C/O', arr: get('Arr'), end: co.time, notes: [] };
        mark(coRow, 'co', cell.Checkout?.flatMap(pc => pc.parts));
        pendingCO = { key: coKey, row: coRow };
      } else if (co && pendingCO) {
        pendingCO.row.arr = get('Arr'); // the duty's next leg: its C/O is at this arrival
      }
    }
  }
  flushCO();
  const fmt = (x) => { const [d, mon, yy] = x.date.split(' '); return `${d.padStart(2, '0')}${mon}${yy}`; };
  const out = rows.map(r => outputRow({ ...r, info: r.notes.join(' ') }));
  return { format: 'activity-list', period: first ? `${fmt(first)} - ${fmt(last)}` : null, notices: [], recognized: out.length > 0, published: out, planned: [], _trace: trace, _rows: rows };
}

const LOGBOOK_TITLE_RE = /^Log Book Report by Crew Members on period \[(\d{2})\/(\d{2})\/(\d{4})-(\d{2})\/(\d{2})\/(\d{4})\]/;
const DMY_RE = /^(\d{2})\/(\d{2})\/(\d{4})$/;

/** Column x of a "Log Book Report by Crew Members" page, from its four header lines. */
function findLogBookHeader(page) {
  if (!page.items.some(i => LOGBOOK_TITLE_RE.test(i.text))) return null;
  const lines = toLines(page.items);
  const line = (pred) => lines.find(l => pred(l.items.map(i => i.text)));
  const top = line(t => t.includes('Description') && t.includes('Role'));        // Activity | Begin | End | Description | Role | Before | After
  const bottom = line(t => t.includes('Departure') && t.includes('Arrival'));   // Departure | Arrival | A/C | A/C | Dep | Arr | Rot. | Activity | Block | Flight | Simu
  const mid = line(t => t.includes('Registr.') && t.includes('CheckIn'));       // Date | Date | Type | Registr. | Airport | Airport | No | CheckIn | Time ...
  if (!top || !bottom || !mid) return null;
  const x = (l, t, n = 0) => l.items.filter(i => i.text === t)[n]?.x;
  return {
    y: Math.max(top.y, bottom.y, mid.y) + 4,
    cols: [
      ['dateDep', x(bottom, 'Departure')], ['type', x(top, 'Activity')], ['begin', x(top, 'Begin')], ['end', x(top, 'End')],
      ['dateArr', x(bottom, 'Arrival')], ['desc', x(top, 'Description')], ['acType', x(mid, 'Type')], ['reg', x(mid, 'Registr.')],
      ['dep', x(bottom, 'Dep')], ['arr', x(bottom, 'Arr')], ['rot', x(bottom, 'Rot.')], ['restBefore', x(top, 'Before')],
      ['checkin', x(mid, 'CheckIn')], ['restAfter', x(top, 'After')], ['block', x(bottom, 'Block')], ['flight', x(bottom, 'Flight')],
      ['night', x(top, 'Night')], ['simu', x(bottom, 'Simu')],
    ].filter(([, cx]) => cx != null).map(([name, cx]) => ({ name, x: cx })).sort((a, b) => a.x - b.x),
  };
}

/**
 * "Log Book Report by Crew Members on period [27/03/2024-22/04/2024]" (Schedule in UTC; e.g. Transavia).
 * One activity takes three lines: the dates of its Rest Before | CheckIn | Rest After, then the activity
 *   07/04/2024 | Flight | 05:45 | 08:15 | 07/04/2024 | TO7240 | 73H | FHTVE | ORY | CZL | 1 | 02:30 | 02:15 | 00:05
 * (departure date, type, begin, end, arrival date, description, A/C type, registration, airports, rotation,
 * block, flight, night, simulator time), then the times of Rest Before | CheckIn | Rest After.
 * Activities in a row with the same CheckIn are one duty: a C/I row at the CheckIn, a C/O row at the
 * last one's Rest After. Flight / DHD Flt / Rail / Shuttle -> duty = description (flight number), "DHD Flt"
 * with dc DHD, a Rail or Shuttle tagged "[Rail]" / "[Shuttle]"; block and flight time to info
 * ("[Block: 02:30] [Flight: 02:15]"), simulator time "[Sim: x]". OFF -> duty OFF, HOTAC -> a hotel night
 * (HT) at its airport, both without C/I or C/O.
 */
function parseLogBookReport(pages) {
  const trace = startTrace();
  const rows = [];
  const title = pages.flatMap(p => p.items).map(i => LOGBOOK_TITLE_RE.exec(i.text)).find(Boolean);
  const ddmmyy = (d, m, y) => `${d}${MONTHS[Number(m) - 1]}${y.slice(2)}`;
  const dayOf = (text) => {
    const m = DMY_RE.exec(text);
    if (!m) return null;
    const [day, month, year] = [Number(m[1]), Number(m[2]) - 1, Number(m[3])];
    return { date: `${day} ${MONTHS[month]} ${m[3].slice(2)}`, day: WEEKDAYS[new Date(year, month, day).getDay()], t: Date.UTC(year, month, day) };
  };
  let duty = null; // { key, coRow }: the duty going on; its C/O goes out after its last activity
  const endDuty = () => { if (duty) { rows.push(duty.coRow); duty = null; } };
  let header = null;
  for (const page of pages) {
    header = findLogBookHeader(page) || (header && { ...header, y: 0 });
    if (!header) continue;
    const colOf = (x) => header.cols.filter(c => x >= c.x - 6).pop()?.name;
    const lines = toLines(page.items.filter(i => i.y > header.y));
    for (let k = 0; k < lines.length; k += 1) {
      const line = lines[k];
      const cell = {};
      for (const it of line.items) { const c = colOf(it.x); if (c) (cell[c] ||= []).push(it); }
      const get = (c) => (cell[c] || []).map(i => i.text).join(' ').trim();
      const dep = dayOf(get('dateDep'));
      const type = get('type');
      if (!dep || !type || !/^\d{2}:\d{2}$/.test(get('begin'))) continue; // the date / time lines, totals, footer
      // the CheckIn / Rest After date on the line above, their times on the line below
      const pick = (l, name) => (l ? l.items.filter(i => colOf(i.x) === name) : []);
      const above = lines[k - 1], below = lines[k + 1];
      const ciDate = dayOf(pick(above, 'checkin')[0]?.text || ''), ciTime = pick(below, 'checkin')[0]?.text || '';
      const raDate = dayOf(pick(above, 'restAfter')[0]?.text || ''), raTime = pick(below, 'restAfter')[0]?.text || '';
      const arrDay = dayOf(get('dateArr'));
      const plus = (d, from) => (d && from && d.t > from.t ? `+${Math.round((d.t - from.t) / 86400000)}` : '');
      const base = { section: 'published', date: dep.date, day: dep.day, notes: [] };
      if (/^(OFF|HOTAC)$/i.test(type)) {
        endDuty();
        const row = { ...base, duty: /^OFF$/i.test(type) ? 'OFF' : 'H', dep: get('dep'), begin: get('begin'), end: `${get('end')}${plus(arrDay, dep)}`,
          ...(/^OFF$/i.test(type) ? { arr: get('arr') } : {}) };
        rows.push(row);
        for (const [f, c] of [['date', 'dateDep'], ['duty', 'type'], ['dep', 'dep'], ['begin', 'begin'], ['end', 'end']]) mark(row, f, cell[c]);
        continue;
      }
      const key = `${get('checkin')}|${ciDate?.date} ${ciTime}`;
      if (duty && duty.key !== key) endDuty();
      if (!duty && ciDate && /^\d{2}:\d{2}$/.test(ciTime)) {
        const ciRow = { section: 'published', date: ciDate.date, day: ciDate.day, duty: 'C/I', dep: get('dep'), begin: ciTime, notes: [] };
        rows.push(ciRow);
        mark(ciRow, 'ci', pick(below, 'checkin'));
        duty = { key, coRow: null };
      }
      const event = {
        ...base, duty: get('desc') || type, dc: /^DHD/i.test(type) ? 'DHD' : '', dep: get('dep'), begin: get('begin'),
        arr: get('arr'), end: `${get('end')}${plus(arrDay, dep)}`, ac: get('acType'), registration: get('reg'), notes: [],
      };
      if (/^(Rail|Shuttle|Bus|Taxi)$/i.test(type)) event.notes.push(`[${type}]`);
      const block = get('block'), flight = get('flight'), simu = get('simu');
      if (/^\d{2}:\d{2}$/.test(block) && block !== '00:00') event.notes.push(`[Block: ${block}]`);
      if (/^\d{2}:\d{2}$/.test(flight) && flight !== '00:00') event.notes.push(`[Flight: ${flight}]`);
      if (/^\d{2}:\d{2}$/.test(simu) && simu !== '00:00') event.notes.push(`[Sim: ${simu}]`);
      rows.push(event);
      for (const [f, c] of [['date', 'dateDep'], ['duty', 'desc'], ['dep', 'dep'], ['begin', 'begin'], ['arr', 'arr'], ['end', 'end'],
        ['ac', 'acType'], ['registration', 'reg'], ['info', 'block'], ['info', 'flight']]) mark(event, f, cell[c]);
      if (duty && raDate && /^\d{2}:\d{2}$/.test(raTime)) {
        duty.coRow = { section: 'published', date: raDate.date, day: raDate.day, duty: 'C/O', arr: get('arr'), end: raTime, notes: [] };
        mark(duty.coRow, 'co', pick(below, 'restAfter'));
      }
      if (duty && !duty.coRow) duty = null; // no Rest After: nothing to close
    }
  }
  endDuty();
  const out = rows.map(r => outputRow({ ...r, info: r.notes.join(' ') }));
  return {
    format: 'logbook-report', period: title ? `${ddmmyy(title[1], title[2], title[3])} - ${ddmmyy(title[4], title[5], title[6])}` : null,
    notices: [], recognized: out.length > 0, published: out, planned: [], _trace: trace, _rows: rows,
  };
}

const DAYBLOCK_DATE_RE = /^[a-záéíóú]{2}\.\s+(\d{1,2})\s+([a-z]{3})\.?$/i; // "mi. 01 dic.", "sá. 04 dic."
const DAYBLOCK_PERIOD_RE = /Periodo\s+(\d{2})\/(\d{2})\/(\d{4})\s*-\s*(\d{2})\/(\d{2})\/(\d{4})/;

/** The day-block columns of a page: x of each "Descr. Código" header (Air Nostrum style crew schedule). */
function findDayBlockHeader(page) {
  const heads = page.items.filter(i => /^Descr\.\s*C[oó]digo$/.test(i.text));
  if (!heads.length || !page.items.some(i => i.text === 'Fecha:') || !page.items.some(i => /^Tripulaci[oó]n$/.test(i.text))) return null;
  return { y: Math.min(...heads.map(h => h.y)), starts: heads.map(h => h.x).sort((a, b) => a - b) };
}

/**
 * Crew schedule in day blocks (e.g. Air Nostrum: "Periodo 01/12/2021 - 01/01/2022 - Tiempos UTC"), the days
 * in up to four columns side by side, each column:
 *   Descr. Código | Vuelo | ORI-DES | STD - STA | Tripulación
 *   Fecha: mi. 01 dic.            [Firma: 7:50]
 *   Vacaciones voluntarias | VV | - | 0:00 - 0:00
 *   ATX | IB8290 | MAD-MLN | 10:35 - 12:25 | (d) MUIÑOS(D)
 *   Totales : Blq 5:30:00 / Bar 6:29:00
 * "Firma" (sign-on) -> a C/I row; a flight (the Descr. column holds the aircraft type) -> duty = flight
 * number, dep / arr from ORI-DES, begin / end, ac, crew = Tripulación ("Situación": a positioning flight,
 * dc DHD); anything else -> duty = its code (VV, LCA8, LBR...), with its times unless "0:00 - 0:00" (all
 * day). No C/O: the schedule prints no sign-off time. Times are UTC; the year comes from the period.
 * The column right of the last day is the legend: no "Fecha:" there, so nothing is read from it.
 */
function parseDayBlocks(pages) {
  const trace = startTrace();
  const rows = [];
  const per = pages.flatMap(p => p.items).map(i => DAYBLOCK_PERIOD_RE.exec(i.text)).find(Boolean);
  const from = per ? { m: Number(per[2]) - 1, y: Number(per[3]) } : null;
  const hhmm = (t) => { const m = /^(\d{1,2}):(\d{2})$/.exec(t); return m ? `${m[1].padStart(2, '0')}${m[2]}` : ''; };
  const days = [];
  for (const page of pages) {
    const header = findDayBlockHeader(page);
    if (!header) continue;
    const groupOf = (x) => header.starts.filter(st => x >= st - 6).length - 1;
    const groups = header.starts.map(() => []);
    for (const it of page.items) if (it.y > header.y + 2 && groupOf(it.x) >= 0) groups[groupOf(it.x)].push(it);
    for (const [g, items] of groups.entries()) {
      const x0 = header.starts[g];
      // from the header words (Vuelo +42, ORI-DES +72, STD - STA +101, Tripulación +132); values start up to ~5 pt left of them
      const colOf = (x) => { const dx = x - x0; return dx < 38 ? 'descr' : dx < 67 ? 'code' : dx < 95 ? 'route' : dx < 127 ? 'times' : 'crew'; };
      let day = null;
      for (const line of toLines(items, 3)) {
        const texts = line.items.map(i => i.text);
        const fi = texts.indexOf('Fecha:');
        if (fi >= 0) {
          const d = DAYBLOCK_DATE_RE.exec(texts[fi + 1] || '');
          const mon = d ? monthIndex(d[2]) : -1;
          if (d && mon >= 0 && from) {
            const year = from.y + (mon < from.m ? 1 : 0); // "01 ene." after December: the next year
            const dd = Number(d[1]);
            day = { date: `${dd} ${MONTHS[mon]} ${String(year).slice(2)}`, day: WEEKDAYS[new Date(year, mon, dd).getDay()], items: [line.items[fi], line.items[fi + 1]], ci: null };
            days.push(day);
            const firma = texts.indexOf('Firma:');
            if (firma >= 0 && hhmm(texts[firma + 1] || '')) {
              day.ci = { section: 'published', date: day.date, day: day.day, duty: 'C/I', begin: hhmm(texts[firma + 1]), notes: [] };
              rows.push(day.ci);
              mark(day.ci, 'ci', [line.items[firma + 1]]);
            }
          } else day = null;
          continue;
        }
        if (!day) continue;
        if (texts.some(t => /^Totales/.test(t))) continue;
        const cell = {};
        for (const it of line.items) (cell[colOf(it.x)] ||= []).push(it);
        const get = (c) => (cell[c] || []).map(i => i.text).join(' ').replace(/\s+/g, ' ').trim();
        const code = get('code');
        if (!code) continue;
        const times = /^(\d{1,2}:\d{2})\s*-\s*(\d{1,2}:\d{2})$/.exec(get('times'));
        const [begin, end] = times ? [hhmm(times[1]), hhmm(times[2])] : ['', ''];
        const route = /^([A-Z]{3})-([A-Z]{3})$/.exec(get('route'));
        const crew = get('crew');
        const flight = !!route;
        const allDay = begin === '0000' && end === '0000';
        const row = {
          section: 'published', date: day.date, day: day.day, duty: code, notes: [],
          dep: route ? route[1] : '', arr: route ? route[2] : '',
          begin: allDay ? '' : begin, end: allDay ? '' : `${end}${end && begin && end < begin ? '+1' : ''}`,
          ac: flight && /^[A-Z0-9]{3}$/.test(get('descr')) ? get('descr') : '',
          dc: flight && /^Situaci[oó]n$/i.test(crew) ? 'DHD' : '',
          crew: flight && !/^Situaci[oó]n$/i.test(crew) ? crew : '',
        };
        rows.push(row);
        if (day.ci && !day.ci.dep && row.dep) day.ci.dep = row.dep;
        if (day.items) { mark(row, 'date', day.items); day.items = null; }
        for (const [f, c] of [['duty', 'code'], ['dep', 'route'], ['arr', 'route'], ['begin', 'times'], ['end', 'times'], ['ac', 'descr'], ['crew', 'crew']]) mark(row, f, cell[c]);
      }
    }
  }
  // the columns are read one after the other: put the rows in date order (a day's rows keep their order)
  const t = (r) => { const [d, mon, yy] = r.date.split(' '); return Date.UTC(2000 + Number(yy), MONTHS.indexOf(mon), Number(d)); };
  const ordered = rows.map((r, i) => [r, i]).sort((a, b) => t(a[0]) - t(b[0]) || a[1] - b[1]).map(([r]) => r);
  const out = ordered.map(r => outputRow({ ...r, info: r.notes.join(' ') }));
  const pad = (d, m, y) => `${d}${MONTHS[Number(m) - 1]}${y.slice(2)}`;
  return {
    format: 'day-blocks', period: per ? `${pad(per[1], per[2], per[3])} - ${pad(per[4], per[5], per[6])}` : null,
    notices: [], recognized: out.length > 0, published: out, planned: [], _trace: trace, _rows: ordered,
  };
}

const MONTH_ROSTER_COLS = ['Date', 'Report', 'Release', 'Tags', 'Pos', 'Activity', 'From', 'To', 'Start', 'End', 'A/C', 'Layover', 'Trip', 'Flight', 'Duty', 'Rest'];
const MONTH_ROSTER_DAY_RE = /^(\d{2}) (Mon|Tue|Wed|Thu|Fri|Sat|Sun)$/;

/** Header line of a monthly roster: Date | Report Release Tags | Pos | Activity From To | Start | End | A/C | Layover Trip ID | Flight Duty | Rest */
function findMonthRosterHeader(page) {
  for (const line of toLines(page.items)) {
    const words = line.items.flatMap(wordsIn);
    const at = (t) => words.find(w => w.text === t)?.x;
    if (['Report', 'Release', 'Activity', 'Layover', 'Rest'].every(t => at(t) != null) && at('Trip') != null) {
      return { y: line.y, cols: MONTH_ROSTER_COLS.map(name => ({ name, x: at(name) })).filter(c => c.x != null) };
    }
  }
  return null;
}

/**
 * Monthly roster ("Roster", "Period: October 2026", "All times local"): one line per day,
 *   01 Thu | Report | Release | Tags | Pos | Activity | From | To | Start | End | A/C | Layover | Trip ID | Flight | Duty | Rest
 * The days print only their number and weekday: month and year come from the period.
 * Rows follow the other layouts: the report time is a C/I row, the release time a C/O
 * row; Activity -> duty, Pos -> dc, From/To -> dep/arr, Start/End -> begin/end, A/C -> ac,
 * the rest to info ("[ACM] [Layover: 24:15] [Trip 20261002_64_023] [Flight: 10:25] [Duty: 12:25] [Rest: 14:00]").
 * A flight over midnight is printed on two days (its start on one, its end on the next) and
 * kept so: a row on each day. "Layover: PUJ" is a row with dep only. A trip id wrapping onto
 * the next line ("_023") is joined. Times are local ("All times local") unless the page says UTC.
 */
function parseMonthRoster(pages) {
  const trace = startTrace();
  const period = findPeriod(pages);
  const zone = pages.some(p => p.items.some(i => /All times (in )?UTC/i.test(i.text))) ? 'Z' : 'L';
  const rows = [];
  for (const page of pages) {
    const header = findMonthRosterHeader(page);
    if (!header) continue;
    // values may start a little left of their header word (x from character counts)
    const colOf = (x) => header.cols.filter(c => x >= c.x - 5).pop()?.name;
    let last = null; // the last activity row, for a wrapped trip id
    for (const line of toLines(page.items.filter(i => i.y > header.y + 2))) {
      if (/^Created /.test(line.items[0].text)) break; // the footer
      const words = line.items.flatMap(wordsIn);
      const dayItem = line.items.find(i => MONTH_ROSTER_DAY_RE.test(i.text));
      if (!dayItem) { // "_023": the end of the trip id above
        const trip = words.filter(w => colOf(w.x) === 'Trip' || colOf(w.x) === 'Layover');
        if (last && trip.length && trip.length === words.length) { last.trip += trip.map(w => w.text).join(''); mark(last, 'info', trip); }
        continue;
      }
      const [, dd, wd] = MONTH_ROSTER_DAY_RE.exec(dayItem.text);
      const day = Number(dd);
      if (!period?.from) continue;
      const { month, year } = period.from;
      const date = `${day} ${MONTHS[month]} ${String(year).padStart(2, '0')}`;
      const layoverItem = line.items.find(i => /^Layover:\s*[A-Z]{3}$/.test(i.text));
      const cell = {};
      for (const w of words) { if (w._src === dayItem || w._src === layoverItem) continue; (cell[colOf(w.x)] ||= []).push(w); }
      const get = (c) => (cell[c] || []).map(w => w.text).join(' ').trim();
      const head = { section: 'published', date, day: wd, notes: [] };
      const added = [];
      const add = (r, marks) => { const row = { ...head, ...r }; rows.push(row); added.push(row); for (const [f, its] of marks) if (its?.length) mark(row, f, its); return row; };
      if (get('Report')) add({ duty: 'C/I', begin: get('Report') }, [['ci', cell.Report]]);
      // "Layover: PUJ": one item under the To column
      if (layoverItem) {
        const [label, port] = wordsIn(layoverItem);
        add({ duty: '', dep: port.text, notes: [`[Layover: ${port.text}]`] }, [['dep', [port]], ['info', [label]]]);
      }
      else if (get('Activity') || get('Start') || get('End')) {
        const notes = [];
        if (get('Tags')) notes.push(`[${get('Tags')}]`);
        if (get('Layover')) notes.push(`[Layover: ${get('Layover')}]`);
        const row = add({ duty: get('Activity'), dc: get('Pos'), dep: get('From'), arr: get('To'), begin: get('Start'), end: get('End'), ac: get('A/C'), notes },
          [['duty', cell.Activity], ['dc', cell.Pos], ['dep', cell.From], ['arr', cell.To], ['begin', cell.Start], ['end', cell.End], ['ac', cell['A/C']],
            ['info', cell.Tags], ['info', cell.Layover], ['info', cell.Trip], ['info', cell.Flight], ['info', cell.Duty], ['info', cell.Rest]]);
        row.trip = get('Trip');
        row.stats = [['Flight:', get('Flight')], ['Duty:', get('Duty')], ['Rest:', get('Rest')]]; // "[Flight: 10:25]", as every layout writes them
        last = row;
      }
      if (get('Release')) add({ duty: 'C/O', end: get('Release') }, [['co', cell.Release]]);
      if (!added.length) add({ duty: '' }, []); // a day with nothing on it: keep the day
      mark(added[0], 'date', [dayItem]);
    }
  }
  // A flight over midnight is printed on two days: its start on one ("065 TPA 17:55"), its end on
  // the next ("065 FRA 09:10"). It is one row, on the day it starts: end "09:10 L +1".
  for (let i = 0; i < rows.length; i++) {
    const a = rows[i];
    if (!a.duty || a.duty === 'C/I' || a.duty === 'C/O' || !a.begin || a.end || a.arr) continue;
    const k = rows.findIndex((b, j) => j > i && b.duty === a.duty && b.end && !b.begin && !b.dep && b.date !== a.date);
    if (k < 0 || rows.slice(i + 1, k).some(b => b.duty && b.duty !== 'C/I' && b.duty !== 'C/O')) continue;
    const b = rows[k];
    Object.assign(a, { end: `${b.end}+1`, arr: b.arr, ac: a.ac || b.ac, dc: a.dc || b.dc, trip: a.trip || b.trip, notes: [...new Set([...a.notes, ...b.notes])] });
    if (!(a.stats || []).some(([, v]) => v)) a.stats = b.stats;
    if (trace) for (const e of trace) if (e.row === b) e.row = a; // its words now belong to the merged row
    rows.splice(k, 1);
  }
  const out = rows.map((r) => {
    const notes = [...r.notes];
    if (r.trip) notes.push(`[Trip ${r.trip}]`);
    for (const [k, v] of r.stats || []) if (v) notes.push(`[${k} ${v}]`);
    return outputRow({ ...r, info: notes.join(' ') }, zone);
  });
  return { format: 'month-roster', period: period?.text || null, notices: findNotices(pages), recognized: out.length > 0, published: out, planned: [], _trace: trace, _rows: rows };
}

/**
 * EFB postflight report (e.g. Icelandair "P O S T F L I G H T  R E P O RT"): one flight per file.
 * FLIGHT/CALLSIGN "FI665(ICE665)" -> duty FI665, REGISTRATION -> registration, AIRCRAFT TYPE -> ac,
 * DEPARTURE DATE "22 SEP 2026" -> date, the airports' "BIKF / KEF" -> dep/arr (IATA), the
 * "OOOI timeline" (STD, OFF BLOCK, TAKEOFF, LANDING, ON BLOCK, STA, AIR TIME, BLOCK ACT., UTC):
 * OFF BLOCK -> begin, ON BLOCK -> end, STD / STA / block time -> info. Times in UTC.
 */
const isPostflight = (pages) => pages.some(p => p.items.some(i => i.text === 'FLIGHT/CALLSIGN')) && pages.some(p => p.items.some(i => /P O S T F L I G H T/.test(i.text)));

function parsePostflight(pages) {
  const trace = startTrace();
  const page = pages.find(p => p.items.some(i => i.text === 'FLIGHT/CALLSIGN'));
  const lines = toLines(page.items);
  // the value right of a label on its line: "REGISTRATION | TF-IAE", "AIRCRAFT TYPE | A321LR", "DEPARTURE DATE | 22 SEP 2026"
  const valueAfter = (label) => {
    for (const l of lines) {
      const k = l.items.findIndex(i => i.text === label.split(' ').pop());
      if (k >= 0 && l.items.map(i => i.text).join(' ').startsWith(label) && l.items[k + 1] && l.items[k + 1].x < 290) return l.items[k + 1];
    }
    return null;
  };
  const callsign = valueAfter('FLIGHT/CALLSIGN'), reg = valueAfter('REGISTRATION'), type = valueAfter('AIRCRAFT TYPE'), depDate = valueAfter('DEPARTURE DATE');
  const airports = page.items.filter(i => /^[A-Z]{4} \/ [A-Z]{3}$/.test(i.text)).sort((a, b) => a.x - b.x);
  // the timeline: the line of eight 4-digit times under "S T D ... B L O C K A C T."
  const headerY = page.items.find(i => i.text === 'S T D')?.y;
  const times = headerY == null ? null : lines.find(l => l.y > headerY + 2 && l.items.filter(i => /^\d{4}$/.test(i.text)).length >= 6);
  const t = times ? times.items.filter(i => /^\d{4}$/.test(i.text)) : [];
  const d = depDate && /^(\d{1,2}) ([A-Z]{3}) (\d{4})$/.exec(depDate.text);
  const rows = [];
  if (callsign && d) {
    const month = MONTHS.findIndex(m => m.toUpperCase() === d[2]);
    const [std, off, , , on, sta, , block] = t;
    const iata = (it) => it?.text.split(' / ')[1] || '';
    const fmt = (it) => (it ? `${it.text.slice(0, 2)}:${it.text.slice(2)}` : '');
    const row = {
      section: 'published', date: `${Number(d[1])} ${MONTHS[month]} ${d[3].slice(2)}`, day: WEEKDAYS[new Date(Number(d[3]), month, Number(d[1])).getDay()],
      duty: callsign.text.replace(/\(.*$/, ''), registration: reg?.text || '', ac: type?.text || '',
      dep: iata(airports[0]), arr: iata(airports[1]), begin: off?.text || '', end: on?.text || '',
      notes: [std && `[STD ${fmt(std)} Z]`, sta && `[STA ${fmt(sta)} Z]`, block && `[Block: ${fmt(block)}]`].filter(Boolean),
    };
    rows.push(row);
    mark(row, 'date', [depDate]);
    mark(row, 'duty', [callsign]);
    mark(row, 'registration', [reg]);
    mark(row, 'dep', airports[0] ? [wordsIn(airports[0]).pop()] : []);
    mark(row, 'arr', airports[1] ? [wordsIn(airports[1]).pop()] : []);
    mark(row, 'ac', [type]);
    mark(row, 'begin', [off]);
    mark(row, 'end', [on]);
    mark(row, 'info', [std, sta, block].filter(Boolean));
  }
  const out = rows.map(r => outputRow({ ...r, info: r.notes.join(' ') }, 'Z'));
  return { format: 'postflight-report', period: null, notices: [], recognized: out.length > 0, published: out, planned: [], _trace: trace, _rows: rows };
}

const SPANISH_DATE_RE = /^(Lunes|Martes|Mi[ée]rcoles|Jueves|Viernes|S[áa]bado|Domingo)\s+(\d{2})\/(\d{2})\/(\d{4})$/;

/** Header of a Spanish "Calendario de actividades" (Fecha Asignación | Hora Salida | ... | Nro Vuelo), two lines high. */
function findCalendarHeader(page) {
  const flight = page.items.find(i => i.text === 'Nro Vuelo');
  if (!flight || !page.items.some(i => i.text === 'ORI/DES' && Math.abs(i.y - flight.y) <= 1.5)) return null;
  const near = page.items.filter(i => Math.abs(i.y - flight.y) <= 8);
  const xs = (t) => near.filter(i => i.text === t).map(i => i.x).sort((a, b) => a - b);
  const depTimes = xs('Hora Salida'); // local on the header line, UTC one line up (+ "UTC" below)
  const llegadaUtc = [...xs('Llegada UTC'), ...xs('Horas')].sort((a, b) => a - b);
  const x = {
    depLocal: depTimes[0],
    depUtc: depTimes.length > 1 ? depTimes.at(-1) : depTimes[0] + 54,
    asignacion: near.find(i => i.text === 'Asignación' && Math.abs(i.y - flight.y) <= 1.5)?.x,
    descripcion: xs('Descripción')[0],
    oriDes: xs('ORI/DES')[0],
    arrLocal: xs('Hora Llegada')[0],
    arrUtc: llegadaUtc[0],
    flight: flight.x,
  };
  if (Object.values(x).some(v => v == null)) return null;
  return { y: Math.max(...near.map(i => i.y)), x };
}

/**
 * Spanish "Calendario de actividades reales", one activity per line:
 *   Fecha Asignación "Lunes 01/07/2024" | Hora Salida | Hora Salida UTC | Asignación |
 *   Descripción Asignación | ORI/DES "GYE / JFK" | Hora Llegada | Hora Llegada UTC | Nro Vuelo
 * begin = "05:00 Z / 00:00 L" (UTC, then local departure), end the same for the
 * arrival, duty = Asignación ("L", "SOBREAVIS") or Nro Vuelo, dep/arr = ORI/DES,
 * info = Descripción Asignación as printed.
 */
function parseActivityCalendar(pages) {
  const trace = startTrace();
  const rows = [];
  let period = null;
  for (const page of pages) {
    const header = findCalendarHeader(page);
    if (!header) continue;
    const { x } = header;
    const range = page.items.map(i => i.text).join(' ').match(/Fecha Inicio\s+(\d{2})\/(\d{2})\/(\d{4}).*?Fecha Fin\s+(\d{2})\/(\d{2})\/(\d{4})/);
    if (range && !period) {
      period = `${range[1]}${MONTHS[Number(range[2]) - 1]}${range[3].slice(2)} - ${range[4]}${MONTHS[Number(range[5]) - 1]}${range[6].slice(2)}`;
    }
    const colOf = (ix) => {
      if (ix < x.depLocal - 5) return 'date';
      if (ix < x.depUtc - 5) return 'depLocal';
      if (ix < x.asignacion - 5) return 'depUtc';
      if (ix < x.descripcion - 5) return 'asignacion';
      if (ix < x.oriDes - 6) return 'descripcion';
      if (ix < x.arrLocal - 5) return 'oriDes';
      if (ix < x.arrUtc - 5) return 'arrLocal';
      if (ix < x.flight - 5) return 'arrUtc';
      return 'flight';
    };
    for (const line of toLines(page.items.filter(i => i.y > header.y + 2))) {
      const cell = {};
      for (const it of line.items) (cell[colOf(it.x)] ||= []).push(it);
      const get = (c) => (cell[c] || []).map(i => i.text).join(' ').trim();
      const d = SPANISH_DATE_RE.exec(get('date'));
      if (!d) continue; // page footer ("1/2")
      const [day, month, year] = [Number(d[2]), Number(d[3]) - 1, Number(d[4])];
      const time = (utc, local) => [utc && `${utc} Z`, local && `${local} L`].filter(Boolean).join(' / ');
      const [ori, des] = get('oriDes').split('/').map(t => t.trim());
      const asignacion = get('asignacion'), descripcion = get('descripcion');
      const row = outputRow({
        date: `${day} ${MONTHS[month]} ${String(year % 100).padStart(2, '0')}`,
        day: WEEKDAYS[new Date(year, month, day).getDay()],
        duty: [asignacion, get('flight')].filter(Boolean).join(' '), // "L", "SOBREAVIS" or the flight number
        dep: ori || '',
        arr: des || '',
        begin: time(get('depUtc'), get('depLocal')),
        end: time(get('arrUtc'), get('arrLocal')),
        info: descripcion,
      });
      rows.push(row);
      // "GYE / JFK" is one item: dep and arr ("route").
      for (const [c, f] of [['date', 'date'], ['depLocal', 'begin'], ['depUtc', 'begin'], ['asignacion', 'duty'], ['descripcion', 'info'],
        ['oriDes', 'route'], ['arrLocal', 'end'], ['arrUtc', 'end'], ['flight', 'duty']]) mark(row, f, cell[c]);
    }
  }
  return { format: 'activity-calendar', period, notices: [], recognized: rows.length > 0, published: rows, planned: [], _trace: trace };
}

const GRID_DAY_RE = /^(\d{2})\/(\d{2})$/;
// A cell of the day indicators line under a grid: "D", "D ,R", "*,D ,D", "M,d", "$".
const INDICATORS_RE = /^[A-Za-z*$]{1,2}(\s*,\s*[A-Za-z*$]{1,2})*$/;
// "01/08/2024 - 31/08/2024"; German exports write "01.08.2024 - 25.08.2024"
const GRID_PERIOD_RE = /^(\d{2})[/.](\d{2})[/.](\d{4})\s*-\s*(\d{2})[/.](\d{2})[/.](\d{4})/;

/** Day headers ("01/07" ... "31/07") of a "Personal Crew Schedule Report" grid: one column per day. */
function findScheduleGridHeader(page) {
  if (!page.items.some(i => i.text === 'Personal Crew Schedule Report')) return null;
  const days = page.items.filter(i => GRID_DAY_RE.test(i.text));
  if (!days.length) return null;
  const y = days[0].y;
  const cols = days.filter(i => Math.abs(i.y - y) <= 1.5).sort((a, b) => a.x - b.x);
  if (cols.length < 7) return null;
  return { y, cols: cols.map(i => ({ item: i, cx: i.x + i.w / 2 })) };
}

/**
 * "Descriptions" of a Personal Crew Schedule Report: two lists side by side,
 * "Duty Codes" and "Indicators", one "CODE - description" per entry (code and
 * description may be separate items; a description may wrap onto the next line).
 */
function findGridLegend(pages) {
  const legend = new Map();
  let indX = null; // the lists run on at the top of the next page
  for (const page of pages) {
    let top, ind;
    const duty = page.items.find(i => i.text === 'Duty Codes');
    if (duty) {
      top = duty.y;
      ind = page.items.find(i => i.text === 'Indicators' && Math.abs(i.y - duty.y) <= 1.5);
      indX = ind?.x ?? null;
    } else if (indX !== undefined && legend.size) {
      // continuation: below the page's header (title, period line), above the next table
      const period = page.items.find(i => GRID_PERIOD_RE.test(i.text));
      if (!period) break;
      top = period.y;
      ind = indX == null ? null : { x: indX };
      indX = undefined; // only the page right after
    } else continue;
    const end = Math.min(sectionEnd(page, top), page.items.find(i => /^Generated on/.test(i.text) && i.y > top)?.y ?? page.height);
    const below = page.items.filter(i => i.y > top + 2 && i.y < end - 1);
    const lists = ind
      ? [below.filter(i => i.x < ind.x - 5), below.filter(i => i.x >= ind.x - 5)]
      : [below];
    for (const list of lists) {
      let last = null, lastY = null;
      for (const line of toLines(list)) {
        const text = line.items.map(i => i.text).join(' ').replace(/\s+/g, ' ').trim();
        const m = /^(\S+)\s+-\s+(.+)$/.exec(text);
        if (m) { last = { code: m[1], desc: m[2] }; legend.set(last.code, last); }
        else if (last && line.y - lastY < 15) last.desc += ` ${text}`; // wrapped description (not a "Comments" block further down)
        else last = null;
        lastY = line.y;
      }
    }
  }
  return new Map([...legend].map(([code, l]) => [code, l.desc.trim()]));
}

/**
 * "Personal Crew Schedule Report" (AirAsia): a grid with one column per day,
 * "01/07" and the weekday on top, and the day's events stacked under them,
 * one item per line:
 *   C/I time, then per flight: number, dep time, dep, arr, arr time, [AC];
 *   the C/O time after the last flight;
 *   or a duty code ("KU4", "OFF", "REST") with its begin and end time if any.
 * A flight landing after midnight shows "→" in place of its arrival, and the
 * next day's column starts with "↓", the arrival, its time and [AC]: one row on
 * the departure day, end "00:05 L +1". Times are local ("All times in Local
 * Station", or "All times in UTC": Z). A code listed under "Descriptions"
 * (Duty Codes, Indicators) gets its description in info: "[KU4: KUL Home Standby]".
 * Wizz Air prints the same grid with: flight numbers wrapped over two lines
 * ("WAZ701" + "5", "WMT28" + "25"), actual times "A02:00" (the "A" is kept: "A02:00 Z"), an indicator
 * "(L)" after a flight, "Delay" + "00:50" after an arrival (both to info), a
 * duty code with a "→" (ends the next day after "↓"), and under the grid a line
 * of day indicators (S, L, D: to the day's first row) then F / D lines of daily
 * totals, which are not read. Each night of the "Hotel Information" table is a
 * row "H" after that day's events (dep = port, info = address and phone). The "Other Crew" table
 * gives the crew of one flight of a duty; every flight of that duty (C/I to C/O)
 * gets it: "[CP - 1014526 - REKHRAJ, SUNEEL SINGH][FO - ...]". The statistics
 * are not read.
 */
function parseScheduleGrid(pages) {
  const trace = startTrace();
  const rows = [];
  let period = null, startMonth = 0, startYear = 0;
  for (const page of pages) {
    const m = page.items.map(i => GRID_PERIOD_RE.exec(i.text)).find(Boolean);
    if (m && !period) {
      period = `${m[1]}${MONTHS[Number(m[2]) - 1]}${m[3].slice(2)} - ${m[4]}${MONTHS[Number(m[5]) - 1]}${m[6].slice(2)}`;
      startMonth = Number(m[2]) - 1;
      startYear = Number(m[3]);
    }
  }
  let pending = null; // a flight waiting for its arrival on the next day ("→" ... "↓")
  let onDuty = false; // a C/I without its C/O yet: the next lone time may be that C/O
  let lastEnd = null; // minutes of the day the last event ended
  const minutesOf = (t) => { const m = /(\d{2}):(\d{2})/.exec(t || ''); return m ? Number(m[1]) * 60 + Number(m[2]) : null; };
  const legend = findGridLegend(pages);
  for (const page of pages) {
    const header = findScheduleGridHeader(page);
    if (!header) continue;
    const pitch = (header.cols.at(-1).cx - header.cols[0].cx) / Math.max(1, header.cols.length - 1);
    let stop = page.items.find(i => i.text === 'Total Hours and Statistics' && i.y > header.y)?.y ?? page.height;
    // Lines labelled in the left margin ("F", "D": daily totals) end the grid; the
    // line right above them holds the day indicators ("S", "L", "D").
    const margin = header.cols[0].item.x - 3;
    const labelY = Math.min(stop, ...page.items.filter(i => i.y > header.y + 2 && i.y < stop && i.x + i.w < margin).map(i => i.y));
    let dayIndicators = [];
    if (labelY < stop) {
      stop = labelY;
      const above = page.items.filter(i => i.y > header.y + 2 && i.y < labelY - 2);
      const lastY = Math.max(...above.map(i => i.y));
      const line = above.filter(i => Math.abs(i.y - lastY) <= 1.5);
      if (line.every(i => INDICATORS_RE.test(i.text))) { dayIndicators = line; stop = lastY - 1; } // "S", "D ,R", "*,D ,D"
    } else {
      // Without margin labels, a last line of lone letters set apart from the events
      // ("D", "R", "M" under some days) is indicators as well, not duties.
      const above = page.items.filter(i => i.y > header.y + 2 && i.y < stop);
      const lastY = Math.max(...above.map(i => i.y));
      const line = above.filter(i => Math.abs(i.y - lastY) <= 1.5);
      const prevY = Math.max(...above.filter(i => i.y < lastY - 1.5).map(i => i.y));
      if (line.length && line.every(i => INDICATORS_RE.test(i.text)) && lastY - prevY > 15) { dayIndicators = line; stop = lastY - 1; }
    }
    const below = page.items.filter(i => i.y > header.y + 2 && i.y < stop);
    for (const col of header.cols) {
      const [, dd, mm] = GRID_DAY_RE.exec(col.item.text);
      const month = Number(mm) - 1;
      const year = startYear ? startYear + (month < startMonth ? 1 : 0) : new Date().getFullYear();
      const date = `${Number(dd)} ${MONTHS[month]} ${String(year % 100).padStart(2, '0')}`;
      const day = WEEKDAYS[new Date(year, month, Number(dd)).getDay()];
      const items = below.filter(i => Math.abs(i.x + i.w / 2 - col.cx) < pitch / 2).sort((a, b) => a.y - b.y);
      const weekday = items[0] && WEEKDAYS.includes(items[0].text) ? items.shift() : null;
      const isTime = (i) => /^[AE]?\d{2}:\d{2}$/.test(i?.text || '');
      const timeOf = (i) => (i ? i.text : ''); // "A02:00" keeps its "A" (actual)
      // "856", "C85911" (airline C8), or "WAZ701" with the end of its number on the next line ("5"; "WMT28" + "25")
      const isPiece = (i) => /^[A-Z0-9]{1,2}$/.test(i?.text || '') && !AIRPORT_RE.test(i.text);
      const isFlight = (i, j = items.indexOf(i)) => /^\d{1,4}$/.test(i?.text || '')
        || (/^(?:[A-Z]{2,3}|[A-Z]\d|\d[A-Z])\d{2,4}$/.test(i?.text || '') && (isTime(items[j + 1]) || (/^\d{1,3}$/.test(items[j + 1]?.text || '') && isTime(items[j + 2]))));
      const isStation = (i) => /^\*?[A-Z]{3}$/.test(i?.text || ''); // "*VIE": the "*" stays on the airport
      const acOf = (i) => /^\[([A-Z0-9]+)]$/.exec(i?.text || '')?.[1];
      const isDutyCode = (i) => /^(?=[^a-z]*[A-Z])[A-Z0-9][A-Z0-9/]{0,7}$/.test(i?.text || ''); // a letter somewhere: digits alone are a flight
      const ymd = year * 10000 + (month + 1) * 100 + Number(dd);
      const add = (r, marks) => {
        const row = { section: 'published', date, day, ymd, ...r };
        rows.push(row);
        if (r.duty === 'C/I') onDuty = true;
        else if (r.duty === 'C/O' || (!r.begin && !r.dep)) onDuty = false; // an all-day duty ("OFF", "F") ends it too
        if (minutesOf(r.end) != null) lastEnd = minutesOf(r.end);
        for (const [f, it] of marks) if (it) mark(row, f, [].concat(it)); // one item, or a wrapped number's two
        if (rows.filter(x => x.date === date).length === 1) mark(row, 'date', [col.item, weekday].filter(Boolean));
        return row;
      };
      let k = 0, lastFlight = null;
      const next = () => items[k++];
      const first = rows.length;
      while (k < items.length) {
        const it = items[k];
        if (it.text === '↓') { // the arrival of yesterday's last flight
          k += 1;
          const arr = isStation(items[k]) ? next() : null;
          const end = isTime(items[k]) ? next() : null;
          const ac = acOf(items[k]) ? next() : null;
          if (pending) {
            Object.assign(pending.row, { arr: arr?.text || pending.row.arr || '', end: end ? `${timeOf(end)}+1` : '', ac: ac ? acOf(ac) : pending.row.ac });
            if (end) lastEnd = minutesOf(end.text);
            for (const [f, x] of [['arr', arr], ['end', end], ['ac', ac]]) if (x) mark(pending.row, f, [x]);
            pending = null;
          } else if (!arr && end && !ac) {
            add({ duty: 'C/O', end: timeOf(end) }, [['co', end]]); // "→" alone after yesterday's last flight: its C/O, after midnight
          }
        } else if (isFlight(it, k)) {
          k += 1;
          const piece = /^\d{1,3}$/.test(items[k]?.text || '') && !/^\d+$/.test(it.text) ? next() : null;
          const begin = isTime(items[k]) ? next() : null;
          const dep = isStation(items[k]) ? next() : null;
          let arr = null, end = null, ac = null, overnight = false;
          if (items[k]?.text === '→') { k += 1; overnight = true; } else {
            arr = isStation(items[k]) ? next() : null;
            end = isTime(items[k]) ? next() : null;
          }
          const notes = [];
          const ind = /^\(([A-Za-z]{1,2})\)$/.exec(items[k]?.text || ''); // "(L)", "(l)"
          const indItem = ind ? next() : null;
          if (ind) notes.push(legend.has(ind[1]) ? `[${ind[1]}: ${legend.get(ind[1])}]` : `[${ind[1]}]`);
          if (acOf(items[k])) ac = next();
          const row = add({ duty: it.text + (piece?.text || ''), dep: dep?.text || '', begin: timeOf(begin), arr: arr?.text || '', end: timeOf(end), ac: ac ? acOf(ac) : '', notes },
            [['duty', piece ? [it, piece] : it], ['begin', begin], ['dep', dep], ['arr', arr], ['end', end], ['ac', ac], ['info', indItem]]);
          lastFlight = row;
          if (overnight) pending = { row };
        } else if (it.text === 'Delay' && isTime(items[k + 1])) { // "Delay" "00:50" after an arrival
          k += 2;
          (lastFlight || rows.at(-1))?.notes?.push(`[Delay ${timeOf(items[k - 1])}]`);
          if (lastFlight || rows.at(-1)) mark(lastFlight || rows.at(-1), 'info', [it, items[k - 1]]);
        } else if (isTime(it)) { // C/I before a flight or a timed duty ("20:05" "ST" "21:35"), C/O after the last one (even with a duty next: "07:07" "R2" "19:00")
          k += 1;
          const timedDuty = isDutyCode(items[k]) && !isFlight(items[k], k) && isTime(items[k + 1]);
          // on duty, a time soon after the last event is its C/O even with a flight or duty next ("07:07" "R2");
          // much later it is the next C/I (the duty's C/O was not printed)
          const closes = onDuty && lastEnd != null && (minutesOf(it.text) - lastEnd + 1440) % 1440 <= 180;
          // The C/I of a flight sorted above the timed duty before it: "17:55" "LSBY" "15:15" "17:55" "2705"
          // is LSBY 15:15-17:55, then C/I 17:55, then 2705 (the C/I is later than the duty's begin).
          if (!closes && timedDuty && isTime(items[k + 2]) && isFlight(items[k + 3], k + 3)
            && minutesOf(it.text) > minutesOf(items[k + 1].text)) {
            const [code, begin, end] = [next(), next(), next()];
            add({ duty: code.text, begin: timeOf(begin), end: timeOf(end), notes: [] }, [['duty', code], ['begin', begin], ['end', end]]);
            add({ duty: 'C/I', begin: timeOf(it) }, [['ci', it]]);
            continue;
          }
          // A C/I inside the next timed duty ("17:55" "ADTY" "13:30" "19:30") checks in to nothing: skipped.
          if (!closes && timedDuty && isTime(items[k + 2])) {
            const [t, b, e] = [it, items[k + 1], items[k + 2]].map(i => minutesOf(i.text));
            if ((t - b + 1440) % 1440 <= (e - b + 1440) % 1440) continue;
          }
          if (!closes && (isFlight(items[k], k) || timedDuty)) add({ duty: 'C/I', begin: timeOf(it) }, [['ci', it]]);
          else add({ duty: 'C/O', end: timeOf(it) }, [['co', it]]);
        } else if (isDutyCode(it)) { // duty code ("KU4", "D/O", "F", "2CHY"), with its begin and end if timed
          k += 1;
          const piece = isPiece(items[k]) && items[k].y - it.y < 9 ? next() : null; // "EBT" + "O"
          const begin = isTime(items[k]) && !isFlight(items[k + 1], k + 1) ? next() : null;
          // a duty with a route ("PCAR55" 15:30 "*VIE" "BUD" 18:30)
          const dep = begin && isStation(items[k]) && isStation(items[k + 1]) ? next() : null;
          const arr = dep ? next() : null;
          let end = null, overnight = false;
          if (begin && items[k]?.text === '→') { k += 1; overnight = true; } // ends on the next day, after "↓"
          else end = begin && isTime(items[k]) && !isFlight(items[k + 1], k + 1) ? next() : null;
          const row = add({ duty: it.text + (piece?.text || ''), dep: dep?.text || '', arr: arr?.text || '', begin: timeOf(begin), end: timeOf(end), notes: [] },
            [['duty', piece ? [it, piece] : it], ['begin', begin], ['dep', dep], ['arr', arr], ['end', end]]);
          if (overnight) pending = { row };
        } else {
          k += 1; // "→" without a flight, or something unexpected
        }
      }
      // the day's indicators under the grid ("S", "M,l"): each one listed in the legend, on every event of the day but C/I and C/O
      const codeItems = dayIndicators.filter(i => Math.abs(i.x + i.w / 2 - col.cx) < pitch / 2);
      const codes = codeItems.flatMap(i => i.text.split(',').map(c => c.trim())).filter((c, n, all) => legend.has(c) && all.indexOf(c) === n);
      const dayEvents = rows.slice(first).filter(r => r.date === date && r.duty !== 'C/I' && r.duty !== 'C/O');
      if (codes.length && dayEvents.length) mark(dayEvents[0], 'info', codeItems); // trace: the day's indicators (training data)
      for (const r of dayEvents) {
        r.notes ||= [];
        for (const c of codes) { const note = `[${c}: ${legend.get(c)}]`; if (!r.notes.includes(note)) r.notes.push(note); }
      }
    }
  }
  // A row per hotel night ("Hotel Information"), after that day's events.
  for (const stay of findHotelStays(pages)) {
    for (const d of stay.dates) {
      const [dd, mm, yyyy] = d.split('/').map(Number);
      const ymd = yyyy * 10000 + mm * 100 + dd;
      const at = rows.findIndex(r => r.ymd > ymd);
      const row = { section: 'published', date: `${dd} ${MONTHS[mm - 1]} ${String(yyyy).slice(2)}`, day: WEEKDAYS[new Date(yyyy, mm - 1, dd).getDay()], ymd,
        duty: 'H', dep: stay.port, notes: [[stay.address, stay.phone && `Tel ${stay.phone}`].filter(Boolean).join(', ')] };
      rows.splice(at < 0 ? rows.length : at, 0, row);
    }
  }
  for (const r of rows) {
    r.info = [legend.has(r.duty) ? `[${r.duty}: ${legend.get(r.duty)}]` : '', ...(r.notes || [])].filter(Boolean).join(' ');
  }
  if (pages.some(p => p.ocr)) repairOcrAirports(rows);
  setDutyCrews(rows, findOtherCrew(pages));
  // "Memos": on every event of its day but C/I and C/O; "Training Details": its crew on the event of its duty column
  const ddmmyyyy = (ymd) => `${String(ymd % 100).padStart(2, '0')}/${String(Math.floor(ymd / 100) % 100).padStart(2, '0')}/${Math.floor(ymd / 10000)}`;
  const memos = findMemos(pages);
  for (const r of rows) if (!['H', 'C/I', 'C/O'].includes(r.duty)) for (const memo of memos.get(ddmmyyyy(r.ymd)) || []) r.info += `${r.info ? ' ' : ''}[Memo: ${memo}]`;
  for (const t of findTrainings(pages)) {
    const r = rows.find(x => isTrainingOf(t, ddmmyyyy(x.ymd), x));
    if (r) r.crew = (r.crew || '') + t.crew.map(c => `[${c}]`).join('');
  }
  const notices = findNotices(pages);
  const out = rows.map(r => outputRow(r, scheduleReportZone(notices)));
  return { format: 'schedule-grid', period, notices, recognized: out.length > 0, published: out, planned: [], _trace: trace, _rows: rows };
}

/**
 * An airport misread by OCR in a picture of a grid ("OUB" for "OLB"): a flight
 * lands where the next one of the day takes off, so when the two differ by one
 * letter the code seen more often in the roster is the one printed.
 */
function repairOcrAirports(rows) {
  const seen = {};
  for (const r of rows) for (const a of [r.dep, r.arr]) if (a) seen[a.replace('*', '')] = (seen[a.replace('*', '')] || 0) + 1;
  const oneOff = (a, b) => a.length === b.length && [...a].filter((c, i) => c !== b[i]).length === 1;
  for (let i = 0; i + 1 < rows.length; i++) {
    const [r, n] = [rows[i], rows[i + 1]];
    if (r.date !== n.date || !r.arr || !n.dep) continue;
    const [a, d] = [r.arr.replace('*', ''), n.dep.replace('*', '')];
    if (a === d || !oneOff(a, d)) continue;
    if (seen[d] > seen[a]) r.arr = r.arr.replace(a, d);
    else if (seen[a] > seen[d]) n.dep = n.dep.replace(d, a);
  }
}

/**
 * "Other Crew" table of a Personal Crew Schedule Report: Date | Duty | Details,
 * one entry per flight ("01/07/2024", "A0856"), its crew "CP - 1014526 - NAME |
 * FO - ..." wrapped over lines centred on the entry, the table running on over
 * the next page. Returns [{ date: '1 Jul 24', flight: '856', crew: '[CP - ...][FO - ...]' }].
 */
function findOtherCrew(pages) {
  const start = pages.findIndex(p => p.items.some(i => i.text === 'Other Crew'));
  if (start < 0) return [];
  const title = pages[start].items.find(i => i.text === 'Other Crew');
  const date = pages[start].items.filter(i => i.text === 'Date' && i.y > title.y).sort((a, b) => a.y - b.y)[0];
  const head = date ? pages[start].items.filter(i => Math.abs(i.y - date.y) <= 1.5) : [];
  const xOf = (t) => head.find(i => i.text === t)?.x;
  const [dateX, dutyX, detailsX] = [xOf('Date'), xOf('Duty'), xOf('Details')];
  if (dateX == null || dutyX == null || detailsX == null) return [];
  const out = [];
  for (let p = start; p < pages.length; p++) {
    const page = pages[p];
    const top = p === start ? date.y + 2 : 0;
    const end = sectionEnd(page, top);
    const items = page.items.filter(i => i.y > top && i.y < end).sort((a, b) => a.y - b.y || a.x - b.x);
    const dates = items.filter(i => Math.abs(i.x - dateX) < 5 && /^\d{2}\/\d{2}\/\d{4}$/.test(i.text));
    if (!dates.length) break; // the table ended on the page before
    // details lines: from just above the first entry (below the page's own header) down
    const details = items.filter(i => i.x >= detailsX - 3 && i.y > dates[0].y - 25 && i.y < dates.at(-1).y + 25);
    const groups = groupCentred(details, dates.map(d => d.y));
    dates.forEach((d, k) => {
      const duty = items.find(i => Math.abs(i.x - dutyX) < 5 && Math.abs(i.y - d.y) <= 1.5);
      const m = /^[A-Z]*0*(\d+[A-Z]?)$/.exec(duty?.text || ''); // "A0856" -> 856, "LIMO523C" -> 523C
      if (!m || !groups[k].length) return;
      const crew = groups[k].map(i => i.text).join(' ').split('|').map(t => t.replace(/\s+/g, ' ').trim()).filter(Boolean);
      const [dd, mm, yyyy] = d.text.split('/');
      out.push({ date: new Date(Number(yyyy), Number(mm) - 1, Number(dd)), flight: m[1], crew: crew.map(c => `[${c}]`).join('') });
    });
  }
  return out;
}

/**
 * Crew ids per flight of a compact plan, printed under the days: a flight number
 * with its cockpit ids, its cabin ids on the next line(s):
 *     992  Cockpit:01736 03912
 *          Cabin:06366 06377 06580 06785
 * Returns [{ flight: '992', crew: '[Cockpit - 01736][Cockpit - 03912][Cabin - 06366]...' }], in print order.
 */
function findCrewIdLists(pages) {
  const out = [];
  for (const p of pages) {
    for (const l of toLines(p.items)) {
      const m = CREW_ID_LINE_RE.exec(l.items.map(i => i.text).join(' ').replace(/\s+/g, ' ').trim());
      if (!m) continue;
      if (m[1]) out.push({ flight: m[1], crew: '' });
      const last = out[out.length - 1];
      if (last) last.crew += m[3].trim().split(/\s+/).map(id => `[${m[2]} - ${id}]`).join('');
    }
  }
  return out;
}

/**
 * Gives the crew of findCrewIdLists to the flights it names: the duty's number
 * without its airline prefix ("NX992" for "992"). A number listed again (the
 * flight flown on another day) goes to its next row, in order.
 */
function setFlightCrews(rows, lists) {
  const used = new Set();
  for (const { flight, crew } of lists) {
    const k = rows.findIndex((r, j) => !used.has(j) && r.dep && r.arr && (r.duty || '').replace(/\s+/g, '').replace(/^[A-Z]*?0*(?=\d)/, '') === flight.replace(/^0+/, ''));
    if (k < 0) continue;
    used.add(k);
    rows[k].crew = crew;
  }
}

/**
 * Gives each flight of a duty (the rows from its C/I to its C/O) the crew listed
 * for a flight of it: the one listed for it or the last one before it, else the
 * first one after. An entry's date may be a day off the row's (UTC date), so
 * the flight is looked for on that day, then the next, then the one before.
 */
function setDutyCrews(rows, entries) {
  const dateText = (d) => `${d.getDate()} ${MONTHS[d.getMonth()]} ${String(d.getFullYear() % 100).padStart(2, '0')}`;
  const isFlight = (r) => /^[A-Z]{0,3}\d{1,5}$/.test(r.duty || '') && r.dep && r.arr;
  const listed = new Map(); // row index -> crew
  for (const e of entries) {
    for (const shift of [0, 1, -1]) {
      const day = dateText(new Date(e.date.getFullYear(), e.date.getMonth(), e.date.getDate() + shift));
      const k = rows.findIndex((r, j) => r.date === day && (r.duty || '').replace(/^[A-Z]*0*/, '') === e.flight && !listed.has(j));
      if (k >= 0) { listed.set(k, e.crew); break; }
    }
  }
  for (const k of listed.keys()) {
    let a = k, b = k;
    while (a > 0 && rows[a].duty !== 'C/I') a--;
    while (b < rows.length - 1 && rows[b].duty !== 'C/O') b++;
    let crew = null;
    for (let j = a; j <= b; j++) {
      if (listed.has(j)) crew = listed.get(j);
      else if (isFlight(rows[j]) && !rows[j].crew) rows[j].crew = crew ?? listed.get([...listed.keys()].filter(x => x > j && x <= b).sort((x, y) => x - y)[0]);
      if (listed.has(j)) rows[j].crew = crew;
    }
  }
}

const DETAILS_COLS = { 'Date': 'date', 'Duties': 'duty', 'Details': 'details', 'Report times': 'report', 'Actual times/Delays': 'times', 'Debrief times': 'debrief', 'Block hours': 'block', 'Duty hours': 'dutyHours', 'Credits': 'credits', 'Indicators': 'indicators', 'Crew': 'crew' };
const DETAILS_DATE_RE = /^(\d{2})[/.](\d{2})[/.](\d{4})\s+(Mon|Tue|Wed|Thu|Fri|Sat|Sun)$/; // \"01.08.2024 Thu\" too
const ROUTE_RE = /^(\*?[A-Z]{3})\s*-\s*(\*?[A-Z]{3})$/; // "*BCN - BIO": the "*" stays on the airport
const TIMES_RE = /^([AE]?\d{2}:\d{2}(?:[+-]\d)?)\s*-\s*([AE]?\d{2}:\d{2}(?:[+-]\d(?!\d))?)(?:-\d{3,})?(?:\/(\d{2}:\d{2}))?$/; // "A11:00 - E13:00", "A17:03 - A19:32/01:41", "A21:13 - A01:52+1": the A/E stays; "17:00-15891": a number after the end, not a day
// Titles of the tables of a Personal Crew Schedule Report; each ends the one before it.
const REPORT_SECTION_RE = /^(Schedule Details|Total Hours and Statistics|Expiry Dates|Training Details|Hotel Information|Memos|Descriptions|Generated on)/;

/** A flight of a Schedule Details day: a flight number ("250", or with its airline "QY1446", "U21234") with a route. */
const isDetailsFlight = (r) => /^(?:[A-Z][A-Z0-9]|[0-9][A-Z])?\d{1,5}$/.test(r.duty || '') && r.dep && r.arr;

/** Header row of the "Schedule Details" table (Date | Duties | Details | Report times | ... | Crew). */
function findScheduleDetailsHeader(page) {
  const report = page.items.find(i => i.text === 'Report times');
  if (!report) return null;
  const row = page.items.filter(i => Math.abs(i.y - report.y) <= 1.5 && DETAILS_COLS[i.text]);
  if (!row.some(i => i.text === 'Debrief times') || !row.some(i => i.text === 'Duties')) return null;
  return { y: report.y, cols: row.map(i => ({ name: DETAILS_COLS[i.text], x: i.x })).sort((a, b) => a.x - b.x) };
}

/** y where the table that starts below `y` ends: the next table title, or the page footer. */
function sectionEnd(page, y) {
  return Math.min(page.height, ...page.items.filter(i => i.y > y + 2 && REPORT_SECTION_RE.test(i.text)).map(i => i.y));
}

/**
 * Cells of these tables are centred vertically in their row: a day's date sits
 * level with the middle of its stack of flights, its crew list is a stack of its
 * own centred on the same line. Splits `items` (sorted top-down) into one run per
 * centre, each run centred on it (a run is empty when none fits).
 */
function groupCentred(items, centres, tol = 3) {
  const groups = centres.map(() => []);
  let i = 0;
  centres.forEach((c, k) => {
    let best = -1, bestD = Infinity;
    for (let j = i; j < items.length; j++) {
      const mid = (items[i].y + items[j].y) / 2;
      if (Math.abs(mid - c) < bestD) { bestD = Math.abs(mid - c); best = j; }
      if (mid > c + tol) break;
    }
    if (best >= 0 && bestD <= tol) { groups[k] = items.slice(i, best + 1); i = best + 1; }
  });
  return groups;
}

/**
 * "Training Details" table: Date | Time | Duty | Crew | Course Name | ..., one
 * entry per training duty ("252 - Line Check - P", "(l)"), its crew one per line
 * ("-- UNASSIGNED --", "15015 -- HENNES, JOHN, ROBERT -- Trainee"), centred on the date.
 * Returns [{ date: '16/06/2024', time: '1130 - 1630', duty: '252', crew: ['UNASSIGNED', '15015 - HENNES, JOHN, ROBERT - Trainee'] }];
 * duty is null when the cell is a name ("FTD 1", "Fatigue Awareness").
 */
function findTrainings(pages) {
  const out = [];
  for (const page of pages) {
    const title = page.items.find(i => i.text === 'Training Details');
    const head = title && page.items.find(i => i.text === 'Crew' && i.y > title.y && i.y < title.y + 40);
    if (!head) continue;
    const xOf = (t) => page.items.find(i => i.text === t && Math.abs(i.y - head.y) <= 1.5)?.x;
    const [timeX, dutyX, crewX] = [xOf('Time'), xOf('Duty'), head.x];
    const courseX = xOf('Course Name') ?? page.width;
    if (dutyX == null) continue;
    const items = page.items.filter(i => i.y > head.y + 2 && i.y < sectionEnd(page, head.y)).sort((a, b) => a.y - b.y);
    const dates = items.filter(i => i.x < dutyX - 30 && /^\d{2}\/\d{2}\/\d{4}$/.test(i.text));
    const cells = (x0, x1) => groupCentred(items.filter(i => i.x >= x0 - 3 && i.x < x1 - 3), dates.map(d => d.y), 12);
    const [duties, crews] = [cells(dutyX, crewX), cells(crewX, courseX)];
    const times = timeX == null ? [] : cells(timeX, dutyX);
    dates.forEach((d, k) => {
      const m = /^([A-Z0-9]+)\s+-/.exec(duties[k][0]?.text || '');
      const crew = crews[k].map(i => i.text.replace(/\s*--\s*/g, ' - ').replace(/^\s*-\s*|\s*-\s*$/g, '').trim()).filter(Boolean);
      if ((m || duties[k].length) && crew.length) out.push({ date: d.text, time: times[k]?.map(i => i.text).join(' ') || '', duty: m?.[1] || null, crew });
    });
  }
  return out;
}

/**
 * Is `row` (on `date`, "dd/mm/yyyy") the duty of training `t` (findTrainings)?
 * By its duty number ("252" for "252 - Line Check - P"); a training named in
 * words ("FTD 1" for duty FTDI, "Fatigue Awareness" for FAW) by its time instead:
 * the ground duty whose start falls in the training's "1130 - 1630" on its date
 * (a start "07:00+1" on the day before counts too).
 */
function isTrainingOf(t, date, row) {
  if (t.duty) return t.date === date && !!row.duty && row.duty.replace(/^[A-Z]*0*/, '') === t.duty.replace(/^[A-Z]*0*/, '');
  const w = /^(\d{2}):?(\d{2})\s*-\s*(\d{2}):?(\d{2})$/.exec(t.time || '');
  const b = /^[AE]?(\d{2}):?(\d{2})(?:\s*[ZL])?\s*(\+1)?$/.exec(String(row.begin || '').trim());
  if (!w || !b || ['C/I', 'C/O', 'H'].includes(row.duty) || (row.dep && row.arr && row.dep !== row.arr)) return false;
  const [dd, mm, yyyy] = date.split('/').map(Number);
  const on = new Date(Date.UTC(yyyy, mm - 1, dd + (b[3] ? 1 : 0)));
  const onDate = `${String(on.getUTCDate()).padStart(2, '0')}/${String(on.getUTCMonth() + 1).padStart(2, '0')}/${on.getUTCFullYear()}`;
  const start = +b[1] * 60 + +b[2];
  return onDate === t.date && start >= +w[1] * 60 + +w[2] && start <= +w[3] * 60 + +w[4];
}

/** "Memos" table: date -> memo texts ("hotel BED4U cin 03/09 cout 06/09 ..."). */
function findMemos(pages) {
  const memos = new Map();
  for (const page of pages) {
    const title = page.items.find(i => i.text === 'Memos');
    const head = title && page.items.find(i => i.text === 'Memo' && i.y > title.y);
    if (!head) continue;
    let last = null;
    for (const line of toLines(page.items.filter(i => i.y > head.y + 2 && i.y < sectionEnd(page, head.y)))) {
      const d = line.items.find(i => i.x < head.x - 5 && /^\d{2}\/\d{2}\/\d{4}$/.test(i.text));
      const text = line.items.filter(i => i.x >= head.x - 5).map(i => i.text).join(' ').trim();
      if (d) { last = { date: d.text, text }; if (!memos.has(d.text)) memos.set(d.text, []); memos.get(d.text).push(last); }
      else if (last && text) last.text += ` ${text}`; // a memo running onto the next line
    }
  }
  return new Map([...memos].map(([d, list]) => [d, list.map(m => m.text).filter(Boolean)]));
}

/**
 * "Hotel Information" table: Port | Phone | Address | Locators, one entry per
 * hotel stay, its address on several lines and one locator date per night, all
 * centred on the port. It can run onto the next page without a header.
 * Returns [{ port, phone, address, dates: ['04/09/2024', ...] }].
 */
function findHotelStays(pages) {
  const stays = [];
  let cols = null;
  for (const page of pages) {
    const title = page.items.find(i => i.text === 'Hotel Information');
    let top;
    if (title) {
      const head = page.items.filter(i => i.y > title.y && i.y < title.y + 30 && ['Port', 'Phone', 'Address', 'Locators'].includes(i.text));
      if (head.length < 4) continue;
      cols = Object.fromEntries(head.map(i => [i.text, i.x]));
      top = Math.max(...head.map(i => i.y)) + 2;
    } else if (cols) {
      // continued from the previous page: from under the page title down to the next table
      const first = page.items.filter(i => REPORT_SECTION_RE.test(i.text) && !/^Generated on/.test(i.text)).sort((a, b) => a.y - b.y)[0];
      const period = page.items.find(i => GRID_PERIOD_RE.test(i.text));
      top = (period ? period.y + period.h : 0) + 2;
      if (first && first.y <= top) { cols = null; continue; }
    } else continue;
    const items = page.items.filter(i => i.y > top && i.y < sectionEnd(page, top) && i.text.replace(/\u0000/g, '').trim())
      .sort((a, b) => a.y - b.y);
    const colOf = (i) => ['Locators', 'Address', 'Phone', 'Port'].find(c => i.x >= cols[c] - 3);
    const byCol = (c) => items.filter(i => colOf(i) === c);
    const ports = byCol('Port');
    const centres = ports.map(p => p.y);
    const [phones, addresses, dates] = ['Phone', 'Address', 'Locators'].map(c => groupCentred(byCol(c), centres));
    ports.forEach((p, k) => stays.push({
      port: p.text,
      phone: phones[k].map(i => i.text).join(' '),
      address: addresses[k].map(i => i.text.replace(/,\s*$/, '')).join(', '),
      dates: dates[k].map(i => /^(\d{2}\/\d{2}\/\d{4})(?:\s*-\s*\w+)?$/.exec(i.text)?.[1]).filter(Boolean), // "15/06/2024 - CONFIRMED"
    }));
    if (page.items.some(i => i.text === 'Memos' || i.text === 'Descriptions')) cols = null; // the table ended on this page
  }
  return stays;
}

/**
 * "Personal Crew Schedule Report" with a "Schedule Details" table (Vueling style):
 *   Date "03/09/2024 Tue" | Duties | Details | Report times | Actual times/Delays |
 *   Debrief times | Indicators | Crew
 * A day is one table row: one line per duty (flight number, duty code), the
 * date, report and debrief times centred on them, the crew a centred stack of
 * its own. Per day: a C/I row (begin = report time), one row per duty, a C/O
 * row (end = debrief time). Details "*BCN - BIO" give dep and arr ("*" kept);
 * other details go to info as "[OFF: Day off]". The actual times give begin
 * and end, A/E kept ("A07:12 L") (a delay "/01:41" goes to info as "[Delay 01:41]"). Every flight of the day
 * (a flight number with a route) carries its crew ("[CP - DHC - 1096 - CASANOVAS][FO - 2151 -
 * EREZUMA]"); every event of the day but C/I and C/O carries its indicators with their description ("[M: Day Memo]") and its memos
 * ("[Memo: ...]"). Each night of the "Hotel Information" table is a row of its
 * own after that day: duty "H" (given out as HT), dep = port, info = address and phone.
 * Times are local ("All times in Local Station").
 */
function parseScheduleDetails(pages) {
  const trace = startTrace();
  const legend = findGridLegend(pages);
  const memos = findMemos(pages);
  const days = new Map(); // 'YYYY-MM-DD' -> rows
  const crewOf = new Map(); // 'YYYY-MM-DD' -> "[CP - ...][FO - ...]"
  const dayOf = (dd, mm, yyyy) => {
    const key = `${yyyy}-${mm}-${dd}`;
    if (!days.has(key)) days.set(key, []);
    return { key, rows: days.get(key), date: `${Number(dd)} ${MONTHS[Number(mm) - 1]} ${String(yyyy).slice(2)}`, day: WEEKDAYS[new Date(Number(yyyy), Number(mm) - 1, Number(dd)).getDay()] };
  };
  for (const page of pages) {
    const header = findScheduleDetailsHeader(page);
    if (!header) continue;
    const colOf = (i) => header.cols.filter(c => i.x >= c.x - 3).pop()?.name;
    const items = page.items.filter(i => i.y > header.y + 2 && i.y < sectionEnd(page, header.y)).sort((a, b) => a.y - b.y || a.x - b.x);
    const col = (name) => items.filter(i => colOf(i) === name);
    // "02/12/2024 Mon" on one line, or "02/12/2024" with "Mon" on the line below: the day's centre is between them
    const dates = col('date').map((i) => {
      const m = DETAILS_DATE_RE.exec(i.text) || /^(\d{2})[/.](\d{2})[/.](\d{4})$/.exec(i.text);
      const wd = m && !m[4] && col('date').find(w => /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun)$/.test(w.text) && w.y > i.y && w.y - i.y < 15);
      return m && { item: i, m, y: wd ? (i.y + wd.y) / 2 : i.y };
    }).filter(Boolean);
    const centres = dates.map(d => d.y);
    const duties = groupCentred(col('duty'), centres);
    const crews = groupCentred(col('crew'), centres);
    const anchors = col('duty');
    // details (which may wrap onto two lines) and actual times belong to the nearest duty line;
    // of two as near, the one whose description ("AAI - Actividad aeroportuaria internacional") goes on with the words
    const describes = (d, i) => (legend.get(d.text)?.includes(i.text) ? 0 : 1);
    const nearestDuty = (i) => anchors.reduce((a, b) => {
      const da = Math.abs(a.y - i.y), db = Math.abs(b.y - i.y);
      return db < da - 1 || (Math.abs(db - da) <= 1 && describes(b, i) < describes(a, i)) ? b : a;
    }, anchors[0]);
    const cellsOf = (name) => {
      const m = new Map();
      for (const i of col(name)) { const a = nearestDuty(i); if (!a) continue; if (!m.has(a)) m.set(a, []); m.get(a).push(i); }
      return m;
    };
    const details = cellsOf('details'), times = cellsOf('times');
    const atDay = (name, c) => col(name).filter(i => Math.abs(i.y - c) <= 3);
    dates.forEach(({ item, m, y: centre }, k) => {
      const { key, rows, date, day } = dayOf(m[1], m[2], m[3]);
      const first = rows.length;
      const add = (r, marks) => {
        const row = { section: 'published', date, day, notes: [], ...r };
        rows.push(row);
        for (const [f, its] of marks) if (its?.length) mark(row, f, its);
        return row;
      };
      const report = atDay('report', centre), debrief = atDay('debrief', centre);
      if (report.length) add({ duty: 'C/I', begin: report.map(i => i.text).join(' ') }, [['ci', report]]);
      for (const d of duties[k]) {
        const det = details.get(d) || [], tm = times.get(d) || [];
        const text = det.map(i => i.text).join(' ').replace(/\s+/g, ' ').trim();
        const route = ROUTE_RE.exec(text);
        const t = TIMES_RE.exec(tm.map(i => i.text).join(' ').trim());
        const notes = [];
        if (text && !route) notes.push(`[${d.text}: ${text}]`);
        if (t?.[3]) notes.push(`[Delay ${t[3]}]`);
        const [, duty, ac] = /^(.*?)(?:\s*\[([A-Z0-9]{2,4})])?$/.exec(d.text); // "250 [32N]": the aircraft type to ac
        add({ duty, dep: route?.[1] || '', arr: route?.[2] || '', begin: t?.[1] || '', end: t?.[2] || '', ac: ac || '', notes },
          [['duty', [d]], [route ? 'route' : 'info', det], ['times', tm]]);
      }
      if (debrief.length) add({ duty: 'C/O', end: debrief.map(i => i.text).join(' ') }, [['co', debrief]]);
      if (rows.length === first) add({ duty: '' }, []); // a date with nothing else: keep the day
      const head = rows[first];
      mark(head, 'date', [item]);
      // the day's indicators ("[M: Day Memo]") and memos on each of its events but C/I and C/O
      const indicators = atDay('indicators', centre);
      const events = rows.slice(first).filter(r => r.duty !== 'C/I' && r.duty !== 'C/O');
      for (const code of indicators.map(i => i.text).join(',').split(',').map(s => s.trim()).filter(Boolean)) {
        for (const r of events) r.notes.push(legend.has(code) ? `[${code}: ${legend.get(code)}]` : `[${code}]`);
      }
      if (indicators.length) mark(events[0] || head, 'info', indicators);
      for (const memo of memos.get(`${m[1]}/${m[2]}/${m[3]}`) || []) for (const r of events) r.notes.push(`[Memo: ${memo}]`);
      // one crew member per "CP - ..." line; a name running onto the next line ("PVL", "Nikolaos - ENC") joins it
      const members = [];
      for (const i of crews[k]) {
        if (/^[A-Z]{2,3} - /.test(i.text) || !members.length) members.push(i.text);
        else members[members.length - 1] = `${members.at(-1).replace(/\s*-$/, ' -')} ${i.text}`;
      }
      if (members.length) {
        const crew = members.map(t => `[${t}]`).join('');
        for (const r of rows.slice(first)) if (isDetailsFlight(r)) r.crew = crew;
        if (!crewOf.has(key)) crewOf.set(key, crew);
      }
      // trace: the crew stack is the crew of the day's flights (training data: field 'crew', on the first one)
      const firstFlight = rows.slice(first).find(isDetailsFlight);
      if (firstFlight) mark(firstFlight, 'crew', crews[k]);
    });
  }
  // A row per hotel night, after that day's events.
  for (const stay of findHotelStays(pages)) {
    for (const d of stay.dates) {
      const [dd, mm, yyyy] = d.split('/');
      const { rows, date, day } = dayOf(dd, mm, yyyy);
      rows.push({ section: 'published', date, day, duty: 'H', dep: stay.port, notes: [[stay.address, stay.phone && `Tel ${stay.phone}`].filter(Boolean).join(', ')] });
    }
  }
  // the day's crew goes on each of its flights (a flight number with a route), not on duties, C/I, C/O or hotels;
  // a flight whose table row has no crew stack (a day split over two pages) takes the day's
  for (const [key, crew] of crewOf) for (const r of days.get(key)) if (isDetailsFlight(r) && !r.crew) r.crew = crew;
  // "Training Details": its crew on the ground duty it is (a flight's crew is its own Crew column)
  for (const t of findTrainings(pages)) {
    const hit = [...days].flatMap(([key, rs]) => rs.map(r => [key.split('-').reverse().join('/'), r])).find(([d, r]) => !isDetailsFlight(r) && isTrainingOf(t, d, r));
    if (hit) hit[1].crew = (hit[1].crew || '') + t.crew.map(c => `[${c}]`).join('');
  }
  const rows = [...days.keys()].sort().flatMap(k => days.get(k));
  const period = (() => {
    const m = pages.flatMap(p => p.items).map(i => GRID_PERIOD_RE.exec(i.text)).find(Boolean);
    return m ? `${m[1]}${MONTHS[Number(m[2]) - 1]}${m[3].slice(2)} - ${m[4]}${MONTHS[Number(m[5]) - 1]}${m[6].slice(2)}` : null;
  })();
  const notices = findNotices(pages);
  const out = rows.map(r => outputRow({ ...r, info: r.notes.join(' ') }, scheduleReportZone(notices)));
  return { format: 'schedule-details', period, notices, recognized: out.length > 0, published: out, planned: [], _trace: trace, _rows: rows };
}

/** Rows whose date does not fall on their printed weekday. */
function weekdayMismatches(result) {
  const names = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  return [...result.published, ...result.planned].filter((r) => {
    const m = /^(\d{1,2}) ([A-Z][a-z]{2}) (\d{2})$/.exec(r.date);
    return m && names[new Date(2000 + Number(m[3]), MONTHS.indexOf(m[2]), Number(m[1])).getDay()] !== r.day;
  }).length;
}

/**
 * Days carry only a day number, so months are counted from the period start.
 * When the PDF holds a later page range (e.g. pages 7-10 of a plan that starts
 * 11Sep19), the weekdays tell which month it starts in: the first month of the
 * period that makes every printed weekday right.
 */
export function parseNetlinePdf(pages, { trace = false } = {}) {
  TRACE = trace ? [] : null;
  try {
    const result = parseAny(pages);
    const { _trace, _rows } = result;
    delete result._trace;
    delete result._rows;
    if (trace) {
      // Rows of the result as { section, index }; a row dropped later has none.
      const where = new Map();
      for (const sec of ['published', 'planned']) {
        (_rows ? _rows.filter(r => r.section === sec) : sec === 'published' ? result.published : [])
          .forEach((r, index) => where.set(r, { section: sec, index }));
      }
      result.trace = (_trace || []).map(({ row, ...e }) => ({ ...e, ...(where.get(row) || { section: null, index: -1 }) }));
    }
    // hotel nights given out as events; after the trace (it knows the rows themselves), one row out per row in
    for (const sec of ['published', 'planned']) if (result[sec]) result[sec] = result[sec].map(hotelAsEvent);
    return result;
  } finally {
    TRACE = null;
  }
}

function parseAny(pages) {
  if (pages.some(findMonthRosterHeader)) return parseMonthRoster(pages);
  if (isPostflight(pages)) return parsePostflight(pages);
  // CSV / Excel: read by their column headers (services/table-roster-parser.js)
  const table = parseTableRoster(pages, { mark, startTrace });
  if (table) return table;
  if (pages.some(findActivityListHeader)) return parseActivityList(pages);
  if (pages.some(findLogBookHeader)) return parseLogBookReport(pages);
  if (pages.some(findDayBlockHeader)) return parseDayBlocks(pages);
  if (pages.some(findReportHeader)) return parseCrewRosterReport(pages);
  if (pages.some(findFlightRecordHeader)) return parseFlightTimeRecord(pages);
  if (pages.some(findFlightLogHeader)) return parseFlightLog(pages);
  if (pages.some(findCalendarHeader)) return parseActivityCalendar(pages);
  if (pages.some(findScheduleDetailsHeader)) return parseScheduleDetails(pages);
  if (pages.some(findScheduleGridHeader)) return parseScheduleGrid(pages);
  const period = findPeriod(pages);
  const result = parseFrom(pages, period, period?.from);
  if (!period?.from || !period?.to || !weekdayMismatches(result)) return result;
  for (let y = period.from.year, m = period.from.month; y < period.to.year || (y === period.to.year && m <= period.to.month); m += 1) {
    if (m > 11) { m = 0; y += 1; }
    const candidate = parseFrom(pages, period, { month: m, year: y });
    if (!weekdayMismatches(candidate)) return candidate;
  }
  return result;
}

function parseFrom(pages, period, start) {
  const trace = startTrace();
  const hotels = findHotels(pages);
  const legend = findLegend(pages);
  const legendFor = (duty) => legend.get(duty) ?? legend.get(duty.replace(/\s+/g, '')); // "CBT-R-S 25" = CBT-R-S25
  // "EBT1-S" is in the legend as "EBT1-S25" (its "25" is on the next line).
  const inLegend = (duty) => {
    const code = duty.replace(/\s+/g, '');
    return legend.has(duty) || legend.has(code)
      || [...legend.keys()].some(k => k.startsWith(code) && /^\d+$/.test(k.slice(code.length)));
  };
  let skippedCode = false;
  let textBlock = null; // { row, block, y }: last text line under an event
  const ctx = { month: start?.month ?? 0, year: start?.year ?? 0, lastDay: null };
  const rows = [];
  let current = { date: '', day: '' };
  let section = 'published';
  let noteEnd = null; // { block, y }: lines of the "only for information" note
  let msg = null; // { row, idx, block, y }: crew message whose wrapped lines are being collected
  let lastRow = null;
  let dateItems = null; // trace: the day cell, given to the day's first row
  const claimDate = (row) => {
    if (dateItems && row.date === current.date) { mark(row, 'date', dateItems); dateItems = null; }
  };
  // A crew message goes to the event on its line, else the day's last event; a
  // day with no event ("Sat23" + "From c/m: ... Req. OFF") gets a row of its own.
  const messageRow = (row) => {
    if (row) return row;
    if (lastRow && lastRow.date === current.date) return lastRow;
    if (!current.date) return lastRow;
    lastRow = { section, date: current.date, day: current.day, hotel: '', duty: '', registration: '', dep: '', begin: '', end: '', arr: '', ac: '', info: '', notes: [] };
    rows.push(lastRow);
    claimDate(lastRow);
    return lastRow;
  };
  const startMessage = (row, text, block, y, items) => {
    row = messageRow(row);
    if (!row) return;
    mark(row, 'info', items);
    row.notes.push(text);
    msg = { row, idx: row.notes.length - 1, block, y };
  };
  let stats = null; // { row, keys: Set, y, block } — statistics group being collected
  let stopped = false;
  let headerSeen = false;
  let ryr = false; // single-column RYR plan

  // Info pieces go to row.notes in reading order (statistics, "Instructor", ...);
  // joined into row.info at the end.
  const flushStats = () => { stats = null; };

  for (const page of pages) {
    const layout = findBlocks(page);
    if (!layout) continue;
    headerSeen = true;
    // Compact plans: nothing under their time note (the indicator legend) is a day's.
    const noteY = page.items.find(i => HOMEBASE_NOTE_RE.test(i.text))?.y ?? Infinity;
    if (layout.blocks.some(b => b.col.kind === 'ryr')) ryr = true;
    for (const block of layout.blocks) {
      const items = page.items.filter(i => i.x >= block.x0 - 3 && i.x < block.x1 - 3 && i.y > layout.headerY + 2 && i.y < noteY - 2);
      for (const line of toLines(items)) {
        const lineText = line.items.map(i => i.text).join(' ');
        if (SECTION_END_RE.test(lineText) || line.items.some(i => SECTION_END_RE.test(i.text))
          || line.items.some(i => i.text === 'date')) { stopped = true; break; }
        if (CREW_ID_LINE_RE.test(lineText)) continue; // crew ids per flight: findCrewIdLists
        if (PLANNED_RE.test(lineText)) { section = 'planned'; flushStats(); noteEnd = { block, y: line.y + 12 }; continue; }
        // The note wraps ("... ending outside the" / "printed period"): skip its other lines.
        if (noteEnd && noteEnd.block === block && line.y <= noteEnd.y && !line.items.some(i => DAY_RE.test(i.text) || TIME_RE.test(i.text))) continue;

        // Crew messages ("To c/m: ...", "From c/m: ...") and their wrapped lines go
        // to the info of the event on that line, or else of the event before.
        let lineItems = line.items;
        let msgText = '';
        if (msg && (msg.block !== block || line.y - msg.y > 10.5)) msg = null;
        const split = splitMessage(lineItems);
        if (split) {
          msg = null;
          lineItems = split.rest;
          msgText = split.message;
          if (!lineItems.length) { startMessage(null, msgText, block, line.y, line.items); continue; }
        } else if (msg && continuesMessage(lineItems, block.col)) {
          // Statistics printed level with the message (info column) stay statistics.
          // ("[DT" / "02:10]"; a lone ")" closes the message: "Ref: CNX )").
          // ("(Konzert-Tickets)" is message text, not a statistic.)
          const statItems = lineItems.filter(i => columnOf(i.x, block.col) === 'info'
            && (/^[[(][A-Za-z]+(\s+\d{1,3}[:/]\d{2,4}[\])])?$/.test(i.text) || /^\d{1,3}[:/]\d{2,4}[\])]$/.test(i.text)));
          msg.row.notes[msg.idx] += ` ${lineItems.filter(i => !statItems.includes(i)).map(i => i.text).join(' ')}`;
          mark(msg.row, 'info', lineItems.filter(i => !statItems.includes(i)));
          msg.y = line.y;
          lineItems = statItems;
          if (!lineItems.length) continue;
        }

        // Split the line: statistics (info column, or a line made of [..] only) vs item cells.
        const cells = {};
        let statPart = '';
        const infoItems = [];
        const lineIsStats = STAT_START_RE.test(lineItems[0].text);
        for (const it of splitTimes(lineItems)) {
          // A time of the day before/after ("2220-1") is right-aligned like "2220": place it by its four digits.
          const dayShift = /^!?\d{4}[+-]\d$/.test(it.text) ? (it.w / it.text.length) * 2 : 0;
          let c = lineIsStats ? 'info' : columnOf(it.x + dayShift, block.col);
          // RYR has no H column: a hotel code ("H1 STC") is printed where "(-)" goes.
          if (c === 'stops' && HOTEL_CODE_RE.test(it.text)) c = 'h';
          // RYR: only "(-)" is a stops value; "DH/FR" printed that far left starts the duty.
          else if (c === 'stops' && !/^\(.*\)$/.test(it.text)) c = 'duty';
          if (c === 'info') { statPart += ` ${it.text}`; infoItems.push(it); } else (cells[c] ||= []).push(it);
        }

        // Item cells first: a statistics block starting on this line belongs to it.
        const has = (c) => cells[c]?.length;
        const dayTok = cells.date?.map(i => parseDay(i.text)).find(Boolean);
        if (dayTok) { current = { date: formatDate(dayTok.num, ctx), day: dayTok.name }; dateItems = cells.date; }

        const rdep = (cells.rdep || []).map(i => i.text);
        const duty = (cells.duty || []).map(i => i.text).join(' ').trim();
        // A roster item has a code-like duty (C/I, STBY, EW 7526, Briefing, --) or a time.
        // Other lines are text under an event, the layover airport under a day,
        // or the period totals at the end ("29:30").
        const time = (c) => (cells[c] || []).map(i => i.text).find(t => TIME_RE.test(t)) || '';
        // Text under an event: no duty, time, airport, hotel code, day or duration on the line.
        const textCells = Object.entries(cells).filter(([c]) => c !== 'info' && c !== 'stops').flatMap(([, v]) => v)
          .sort((a, b) => a.x - b.x).map(i => i.text);
        // A word like "LTA" looks like an airport; with real text on the line
        // ("RECENCY TRAINING, INST" / "LTA") it is text all the same.
        // So are several such words in one column ("DEM CAE" printed as two items).
        const textCols = Object.keys(cells).filter(c => c !== 'info' && c !== 'stops');
        // And a lone word ("BRA", "SCP") right under a text line of the same event.
        const inTextBlock = textBlock && textBlock.block === block && textBlock.row === lastRow
          && line.y - textBlock.y <= 10.5;
        const realText = textCells.some(t => /\s|[a-z]/.test(t) && !TIME_RE.test(t))
          || (textCells.length > 1 && textCols.length === 1) || (inTextBlock && !has('h'));
        const textLine = !duty && !dayTok && !time('begin') && !time('end') && textCells.length > 0
          && !textCells.some(t => (AIRPORT_RE.test(t) && !realText) || HOTEL_CODE_RE.test(t) || /^\d{1,3}:\d{2}$/.test(t));
        const isItem = (DUTY_RE.test(duty) || time('begin') || time('end')) && !/\d:\d{2}/.test(duty);
        const onlyDuty = duty && Object.keys(cells).every(c => c === 'duty' || c === 'h');
        // A code alone under an event of the same day, with no airport or time:
        // a row of its own only when the Absence/Ground Activity Legend has it
        // (IPC, LPC, FDP_EXT, "EBT1-S" + "25"); others ("KOMBI") and a repeat of
        // the event above (a second "URLAUB") are skipped.
        const floatingCode = onlyDuty && !dayTok && !has('h') && !/^\d+$/.test(duty)
          && lastRow && lastRow.date === current.date
          && (!inLegend(duty) || duty === lastRow.duty);
        let rowThisLine = null;
        if (onlyDuty && /^\d+$/.test(duty) && lastRow) {
          // A bare number under a code is its continuation ("EBT1-S" / "25").
          if (!skippedCode) { lastRow.duty = `${lastRow.duty} ${duty}`; mark(lastRow, 'duty', cells.duty); }
        } else if (onlyDuty && TRIP_RE.test(duty) && lastRow && !dayTok) {
          // a trip/pairing number under its C/I ("M1075/05May"): info of that event
          lastRow.notes.push(duty);
          mark(lastRow, 'info', cells.duty);
        } else if (floatingCode) {
          skippedCode = true; // its "25" goes too; info/messages on the line go to the event above
        } else if (textLine && lastRow) {
          skippedCode = false;
          // A line of text under an event: an aircraft code ("A321", "D-AIZA")
          // is its registration; anything else ("Instructor, LC", "EATC Rzeszow",
          // "**", "BGR CAE", "JIL LT gem. LP372a Flug 2") is info, line by line.
          const text = textCells.join(' ');
          const textItems = Object.entries(cells).filter(([c]) => c !== 'info' && c !== 'stops').flatMap(([, v]) => v);
          if (REG_RE.test(text) && !lastRow.registration) { lastRow.registration = text; mark(lastRow, 'registration', textItems); }
          else { lastRow.notes.push(text); mark(lastRow, 'info', textItems); }
          textBlock = { row: lastRow, block, y: line.y };
        } else if (isItem) {
          skippedCode = false;
          const dep = rdep.length && AIRPORT_RE.test(rdep[rdep.length - 1]) ? rdep.pop() : '';
          const row = {
            section,
            date: current.date,
            day: current.day,
            hotel: '',
            duty,
            registration: rdep.join(' '),
            dep,
            begin: time('begin'),
            end: time('end'),
            arr: (cells.arr || []).map(i => i.text).find(t => AIRPORT_RE.test(t)) || '',
            ac: (cells.ac || []).map(i => i.text).join(' '),
            info: '',
            notes: [],
          };
          rows.push(row);
          lastRow = row;
          rowThisLine = row;
          claimDate(row);
          const depItem = dep ? cells.rdep.filter(i => i.text === dep).pop() : null;
          mark(row, 'duty', cells.duty);
          mark(row, 'dep', depItem);
          mark(row, 'registration', (cells.rdep || []).filter(i => i !== depItem));
          mark(row, 'begin', (cells.begin || []).find(i => TIME_RE.test(i.text)));
          mark(row, 'end', (cells.end || []).find(i => TIME_RE.test(i.text)));
          mark(row, 'arr', (cells.arr || []).find(i => AIRPORT_RE.test(i.text)));
          mark(row, 'ac', cells.ac);
        }

        // Hotel code in the H column ("H1* BOG", the layover line): a row of its
        // own. It is not `lastRow`, so statistics printed under it ([ABLZ ...])
        // still go to the day's last item.
        const hotelCode = (cells.h || []).map(i => i.text).find(t => HOTEL_CODE_RE.test(t));
        const hotelItem = (cells.h || []).find(i => i.text === hotelCode);
        // (also on an event's own line: the night after it, at its arrival)
        if (hotelCode) {
          const hRow = {
            section,
            date: current.date,
            day: current.day,
            hotel: hotelCode,
            duty: '',
            registration: '',
            dep: rowThisLine ? rowThisLine.arr || rowThisLine.dep || '' : rdep.filter(t => AIRPORT_RE.test(t)).pop() || '',
            begin: '',
            end: '',
            arr: '',
            ac: '',
            info: '',
            notes: [hotels.get(hotelCode.replace('*', '')) || ''],
          };
          rows.push(hRow);
          claimDate(hRow);
          mark(hRow, 'hotel', hotelItem);
          if (!rowThisLine) mark(hRow, 'dep', (cells.rdep || []).filter(i => AIRPORT_RE.test(i.text)).pop());
        }

        // Other text in the info column belongs to the event on that line
        // ("72049 ALTC"), or wraps onto the next line(s) under it ("KURJAKOV" /
        // "OBS", a line with nothing outside the info column): then it goes to
        // the day's last event. Statistics lines and crew messages that run
        // across columns ("From c/m: Z-3", "EAP 13-15 Uhr") are not taken.
        const infoText = statPart.replace(STAT_RE, ' ').replace(/\s+/g, ' ').trim();
        let infoRow = null; // trace: the row this line's info column went to
        if (/[A-Za-z0-9]/.test(infoText)) {
          if (rowThisLine) { rowThisLine.notes.push(infoText); infoRow = rowThisLine; }
          else if (!lineIsStats && !Object.keys(cells).length && lastRow && lastRow.date === current.date) { lastRow.notes.push(infoText); infoRow = lastRow; }
        }

        // Statistics: lines of one group are ~6 pt apart; a repeated key
        // ([DT ...] again) or a larger gap starts the next day's group.
        for (const s of statsText(statPart)) {
          const key = s.slice(1, s.indexOf(' '));
          const sameBlock = stats && stats.block === block;
          const gap = sameBlock ? line.y - stats.y : 0;
          // In a new block (next column/page) a group only continues if no item came in between.
          const movedOn = stats && !sameBlock && stats.row !== lastRow;
          if (!stats || stats.keys.has(key) || gap > 12 || movedOn) {
            flushStats();
            // Only to an item of the current day: a day with no item (just
            // "[ABLZ 0:00]") must not hand its numbers to the day before.
            const row = lastRow && lastRow.date === current.date ? lastRow : null;
            stats = { row, keys: new Set() };
          }
          stats.keys.add(key);
          stats.row?.notes.push(s);
          stats.y = line.y;
          stats.block = block;
          infoRow ||= stats.row;
        }
        mark(infoRow, 'info', infoItems);
        if (msgText) startMessage(rowThisLine, msgText, block, line.y, line.items.filter(i => !split.rest.includes(i)));
      }
      if (stopped) break;
    }
    if (stopped) break;
  }
  flushStats();
  // A code on the day line with no airport or time, above the day's event
  // ("Mon03 INFO_FELD" / "FVD9 CGN 0700 1630", "Sun11 AFA" / "3S 630"), is no
  // event either: skipped unless the legend has it; its info goes to that event.
  // Not in RYR plans: a code there ("IWOFF" above "FR 8612") is an all-day event of its own.
  for (let i = ryr ? -1 : rows.length - 2; i >= 0; i--) {
    const r = rows[i], next = rows[i + 1];
    const bare = r.duty && !r.hotel && !r.dep && !r.begin && !r.end && !r.arr;
    const nextEvent = next.duty && next.date === r.date && next.section === r.section && (next.dep || next.begin || next.end);
    if (bare && nextEvent && !inLegend(r.duty)) {
      next.notes.unshift(...r.notes);
      rows.splice(i, 1);
      // trace: its info and day go to that event; its code is no field.
      for (const e of trace || []) if (e.row === r && e.field !== 'duty') e.row = next;
    }
  }
  for (const row of rows) {
    const desc = row.duty ? legendFor(row.duty) : null;
    row.info = [...row.notes, desc ? `[${row.duty}: ${desc}]` : ''].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim(); // legend last
    delete row.notes;
  }
  // Zone of the times printed without "!", from the plan's note ("!" ones are local, L):
  //   "... (!) if not in homebase timezone"          -> "07:00 B"  (homebase)
  //   "... (!) if not in departure airport timezone" -> "07:00 LB" (local, departure airport)
  //   "All CI/CO times are local"                    -> "07:00 L"
  //   no note                                        -> "07:00 Z"
  const notices = findNotices(pages);
  const has = (re) => notices.some(n => re.test(n));
  //   "Local time at homebase or (!) outside homebase" -> "07:00 LB" (as labeled)
  const plain = has(/homebase timezone/i) ? 'B'
    : has(/departure airport timezone/i) || has(HOMEBASE_NOTE_RE) ? 'LB'
      : has(/times are local/i) ? 'L' : 'Z';
  setFlightCrews(rows, findCrewIdLists(pages));
  const take = (sec) => rows.filter(r => r.section === sec).map(r => outputRow(r, plain));

  return {
    format: 'netline-duty-plan',
    period: period?.text || null,
    notices,
    recognized: headerSeen,
    published: take('published'),
    planned: take('planned'),
    _trace: trace,
    _rows: rows,
  };
}

// Document-level helpers, shared with the learned extractor (services/pdf-row-assembler.js).
export { findPeriod, findNotices, findHotels, findLegend, findGridLegend, findOtherCrew, setDutyCrews, findCrewIdLists, setFlightCrews, findTrainings, isTrainingOf, findMemos, findHotelStays, toLines, PLANNED_RE, MONTHS };
