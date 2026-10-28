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
 * duty "H") inside; this turns one such row into the given-out one (and its printed
 * take-off / landing remark into counts, takeoffLandingTags).
 */
export function hotelAsEvent(row) {
  const { hotel, ...out } = row;
  if (hotel && !out.duty) out.duty = hotel;
  else if (out.duty === 'H') out.duty = HOTEL_DUTY;
  if (out.info) out.info = takeoffLandingTags(out.info);
  return out;
}

/**
 * A take-off / landing remark printed under a flight, with no day or night: "1Take-off, 1Landing",
 * "Take-off, Landing", "Landing" -> "[Takeoff Day/Night: 1] [Landing Day/Night: 1]". Only a remark of
 * its own (at the start of info or after a "[...]" stat), not a word inside other text.
 */
export function takeoffLandingTags(info) {
  return String(info || '')
    .replace(/(^|\]\s+)(\d*)Take-off,?(?:\s+(\d*)Landing)?(?=\s|$)/g, (_, at, t, l) => `${at}[Takeoff Day/Night: ${t || 1}]${l === undefined ? '' : ` [Landing Day/Night: ${l || 1}]`}`)
    .replace(/(^|\]\s+)(\d*)Landing(?=\s|$)/g, (_, at, l) => `${at}[Landing Day/Night: ${l || 1}]`);
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
  // the header line's words are not all level: one "date" sat 1.5 pt above the rest (451bf660…, Dec 2024),
  // and with a 1.5 pt tolerance its plan lost the first two of its three columns; lines are ~9 pt apart
  const row = page.items.filter(i => Math.abs(i.y - headerY) <= 3);
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
        // C/I sits 24-26 pt right of "date" (24.2 in 451bf660…'s first column); a day ("Sun01") is ~19 pt wide:
        // duty from date + 20 (columnOf: H + 5)
        Object.assign(col, { kind: 'compact', 'R dep': dep.x, H: col.date + 15, info: Infinity });
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
    dep: r.dep || '', begin: formatTime(r.begin, plain), takeoff: formatTime(r.takeoff, plain), landing: formatTime(r.landing, plain), end: formatTime(r.end, plain),
    arr: r.arr || '', ac: r.ac || '', crew: r.crew || '', info: r.info || '',
  };
}

/** An event C/I and C/O rows go around: a flight (an aircraft, a flight number, another arrival station), a simulator
 * (SIM, LPC, OPC ..), a taxi / deadhead / positioning (DC "DH"); not a day off, a standby or a ground course. */
function inFlightDuty(r) {
  return !!r.ac || (!!r.dep && !!r.arr && r.dep !== r.arr) || /^[A-Z0-9]{2}\d{1,4}[A-Z]?$/.test(r.duty) || /^DH/.test(r.dc || '')
    || /SIM|FFS|FBS|FTD|^U?[LO]PC|TAXI|LIMO|BUS|TRAIN|^POS|^DH|^PAX/i.test(r.duty);
}

/** The C/I and C/O rows of a duty with no such event in it (OFF, SBY, SEP printed with check-in / check-out times) left out */
function dropGroundCiCo(rows) {
  const drop = new Set();
  for (let i = 0; i < rows.length; i++) {
    if (rows[i].duty !== 'C/I') continue;
    const j = rows.findIndex((r, k) => k > i && (r.duty === 'C/O' || r.duty === 'C/I'));
    if (j < 0 || rows[j].duty !== 'C/O') continue;
    if (!rows.slice(i + 1, j).some(inFlightDuty)) { drop.add(rows[i]); drop.add(rows[j]); }
    i = j;
  }
  return rows.filter(r => !drop.has(r));
}

const REPORT_COLS = ['Date', 'DC', 'C/I (L)', 'C/I (Z)', 'C/O (L)', 'C/O (Z)', 'Activity', 'From', 'STD (L)', 'STD (Z)', 'To', 'STA (L)', 'STA (Z)', 'AC/Hotel', 'Blk Hrs', 'Duty Hrs'];
const REPORT_DATE_RE = /^(\d{2})([A-Z][a-z]{2})(\d{2})$/;
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** Header row of a "Crew Roster Report" table (Date | DC | C/I (Z) | ... | Duty Hrs). */
function findReportHeader(page) {
  // (the header's "Activity", not a title's: "Activity Details")
  const activities = page.items.filter(i => i.text === 'Activity');
  const activity = activities.find(a => page.items.some(j => j.text === 'From' && Math.abs(j.y - a.y) <= 1.5)) || activities[0];
  if (!activity) return null;
  // (headers printed as one text, "STD (L) STD (Z) To": each at its place in it)
  const row = page.items.filter(i => Math.abs(i.y - activity.y) <= 1.5).flatMap((i) => {
    const names = i.text.match(/STD \([LZ]\)|STA \([LZ]\)|C\/[IO] \([LZ]\)|AC\/Hotel|Blk Hrs|Duty Hrs|To|From/g);
    if (!names || names.length < 2 || names.join(' ') !== i.text) return [i];
    const cw = i.w ? i.w / i.text.length : 3;
    return names.map((n, k) => ({ ...i, text: n, x: i.x + cw * names.slice(0, k).reduce((s, m) => s + m.length + 1, 0) }));
  });
  if (!row.some(i => i.text === 'AC/Hotel')) return findDetailsHeader(page, activity, row);
  const cols = REPORT_COLS.map(name => ({ name, x: row.find(i => i.text === name)?.x }))
    .filter(c => c.x != null).sort((a, b) => a.x - b.x);
  return { y: activity.y, cols };
}

/**
 * The same table as "Activity Details" / "Flight Details", other column names: "C/" next to or over "I(L)" | From | Start(Z) |
 * Start(L) | To | Finish(Z) | Finish(L) | AC (Type) | BH | DHrs | FDP | Max (FDP) | EXT | Hotel. Named as the report's columns.
 */
function findDetailsHeader(page, activity, row) {
  if (!row.some(i => /^Start\([LZ]\)$/.test(i.text)) || !row.some(i => i.text === 'From')) return null;
  const alias = { 'Start(Z)': 'STD (Z)', 'Start(L)': 'STD (L)', 'Finish(Z)': 'STA (Z)', 'Finish(L)': 'STA (L)', AC: 'AC/Hotel', BH: 'Blk Hrs', DHrs: 'Duty Hrs' };
  const under = page.items.filter(i => i.y > activity.y + 1.5 && i.y - activity.y < 25 && /^([IO]\([LZ]\)|Type|FDP)$/.test(i.text));
  const sub = (it) => row.find(j => j.x > it.x && j.x - it.x < 15 && /^[IO]\([LZ]\)$/.test(j.text)) || under.find(j => Math.abs(j.x - it.x) < 4 && /^[IO]\(/.test(j.text));
  const cols = [];
  for (const it of [...row].sort((a, b) => a.x - b.x)) {
    if (/^[IO]\([LZ]\)$/.test(it.text)) continue;
    const s = it.text === 'C/' && sub(it);
    if (it.text === 'C/' && !s) continue;
    cols.push({ name: s ? `C/${s.text[0]} (${s.text[2]})` : alias[it.text] || it.text, x: it.x });
  }
  return { y: Math.max(activity.y, ...under.map(i => i.y)), cols };
}

/**
 * "Crew Roster Report" (one table row per line):
 *   Date | DC | C/I (Z) | C/O (Z) | Activity | From | STD (Z) | To | STA (Z) | AC/Hotel | Blk Hrs | Duty Hrs
 * A line gives, in order: a C/I row (begin = C/I time) if there is one, the
 * activity (duty = Activity, dep = From, begin = STD, arr = To, end = STA,
 * ac = AC/Hotel up to 3 characters; Blk Hrs goes to its info), a C/O row (end =
 * C/O time; Duty Hrs goes to its info), and for a longer AC/Hotel text a hotel
 * row (duty "H", given out as HT; info = the hotel). `dc` is the DC column of the line, on the
 * activity (and hotel) row only, not on C/I or C/O. C/I and C/O only go around a flight, a simulator or a deadhead
 * (inFlightDuty): an OFF, SEP or SBY printed with check-in / check-out times is its row alone.
 * Some reports print the local times too, each before its UTC one (C/I (L) | C/I (Z) | C/O (L) | C/O (Z) |
 * ... STD (L) | STD (Z) | ... STA (L) | STA (Z)): times then "11:15 Z / 13:15 L" (UTC, then local).
 */
function parseCrewRosterReport(pages) {
  const trace = startTrace();
  const period = findPeriod(pages);
  const rows = [];
  let date = '', day = '';
  let lastEvent = null, lastCO = null, lastH = null;
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
      const activity = get('Activity'), ci = get('C/I (Z)') || get('C/I (L)'), co = get('C/O (Z)') || get('C/O (L)'), acHotel = get('AC/Hotel');
      // a UTC time with its local one when the report prints both: "2200-1" + "0000" -> "22:00 Z -1 / 00:00 L"
      // (local times only: "!0555", given out as "05:55 L")
      const both = (z, l) => (/^\d{4}([+-]\d)?$/.test(get(l)) && /^\d{4}([+-]\d)?$/.test(get(z)) ? `${formatTime(get(z), 'Z')} / ${formatTime(get(l), 'L')}`
        : !get(z) && /^\d{4}([+-]\d)?$/.test(get(l)) ? `!${get(l)}` : get(z));
      const marks = (row, field, ...cols) => { for (const c of cols) mark(row, field, cell[c]); };
      const blk = get('Blk Hrs'), dutyHrs = get('Duty Hrs');
      // a Hotel column (Activity / Flight Details): its name may go on on the next line
      const hotelCol = get('Hotel');
      if (hotelCol && !activity && !ci && !co && !blk && !dutyHrs && lastH) { lastH.notes[0] += ` ${hotelCol}`; mark(lastH, 'hotel', cell.Hotel); continue; }
      const hotelText = hotelCol || (acHotel.length > 3 ? acHotel : '');
      if (!date || !(activity || ci || co || acHotel || blk || dutyHrs)) continue; // page footer, blank line
      const base = { section: 'published', date, day, dc: get('DC'), notes: [] };
      const firstRow = rows.length;
      // The DC belongs to the activity; C/I and C/O rows carry none.
      // C/I, C/O "0210+1": the next day (kept as "02:10 Z +1")
      if (/^\d{4}([+-]\d)?$/.test(ci)) {
        const ciRow = { ...base, dc: '', duty: 'C/I', dep: get('From'), begin: both('C/I (Z)', 'C/I (L)'), notes: [] };
        rows.push(ciRow);
        marks(ciRow, 'ci', 'C/I (Z)', 'C/I (L)'); // the time makes the C/I row
      }
      let event = null;
      if (activity) {
        event = {
          ...base, duty: activity, dep: get('From'), begin: both('STD (Z)', 'STD (L)'), arr: get('To'), end: both('STA (Z)', 'STA (L)'),
          ac: acHotel.length <= 3 ? acHotel : '', notes: [],
        };
        // a "Hotel" activity: the stay, its hotel in info
        if (activity === 'Hotel') { Object.assign(event, { duty: 'H', notes: [hotelText].filter(Boolean) }); lastH = event; mark(event, 'hotel', cell.Hotel); }
        rows.push(event);
        lastEvent = event;
        mark(event, 'dc', cell.DC);
        mark(event, 'duty', cell.Activity);
        mark(event, 'dep', cell.From);
        marks(event, 'begin', 'STD (Z)', 'STD (L)');
        mark(event, 'arr', cell.To);
        marks(event, 'end', 'STA (Z)', 'STA (L)');
        if (acHotel.length <= 3) mark(event, 'ac', cell['AC/Hotel']);
      }
      if (/^\d+:\d{2}$/.test(blk)) { (event || lastEvent)?.notes.push(`[Block: ${blk}]`); mark(event || lastEvent, 'info', cell['Blk Hrs']); }
      let coRow = null;
      if (/^\d{4}([+-]\d)?$/.test(co)) {
        coRow = { ...base, dc: '', duty: 'C/O', arr: get('To'), end: both('C/O (Z)', 'C/O (L)'), notes: [] };
        rows.push(coRow);
        lastCO = coRow;
        marks(coRow, 'co', 'C/O (Z)', 'C/O (L)');
      }
      if (/^\d+:\d{2}$/.test(dutyHrs)) { (coRow || lastCO)?.notes.push(`[Duty: ${dutyHrs}]`); mark(coRow || lastCO, 'info', cell['Duty Hrs']); }
      if (hotelText && activity !== 'Hotel') {
        const hRow = { ...base, duty: 'H', dep: get('To') || get('From'), notes: [hotelText] };
        rows.push(hRow);
        lastH = hRow;
        mark(hRow, 'hotel', cell[hotelCol ? 'Hotel' : 'AC/Hotel']);
      }
      if (d && rows.length > firstRow) mark(rows[firstRow], 'date', cell.Date);
    }
  }
  const out = dropGroundCiCo(rows).map(r => outputRow({ ...r, info: r.notes.join(' ') }));
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

const ACTIVITY_LIST_COLS = ['Activity', 'Checkin', 'Start', 'Dep', 'Arr', 'End', 'Checkout', 'Daytime', 'Night', 'Total', 'AcVer', 'Prefix', 'DD', 'CAT', 'Crew', 'System'];
// Month names as these reports print them: English, Portuguese (FEV, ABR, MAI, AGO, SET, OUT, DEZ), Spanish (ENE, DIC)
const MONTH_ALIASES = { FEV: 1, ABR: 3, MAI: 4, AGO: 7, SET: 8, OUT: 9, DEZ: 11, ENE: 0, DIC: 11 };
const monthIndex = (mon) => {
  const m = String(mon).toUpperCase();
  const en = MONTHS.findIndex(x => x.toUpperCase() === m);
  return en >= 0 ? en : (MONTH_ALIASES[m] ?? -1);
};

/** Header line of an activity list: Activity | Checkin | Start | Dep | Arr | End | Checkout | AcVer | DD | CAT | Crew */
// (the header line: Code, CI, Dep, STD on one line)
const sleipnerHeader = (page) => page.items.find(i => i.text === 'Code' && ['CI', 'Dep', 'STD'].every(t => page.items.some(j => j.text === t && Math.abs(j.y - i.y) < 3)));
const isPerformedActivities = (page) => page.items.some(i => /^(Performed Activities|Roster)$/.test(i.text)) && page.items.some(i => /^TimeMode /.test(i.text)) && Boolean(sleipnerHeader(page));

/**
 * Sleipner "Performed Activities" / "Roster" ("(24NOV24 - 24NOV24)", "TimeMode UTC" or "Local time"), a line per activity;
 * the columns vary (names from the header line):
 *   Date | Des. | Code | LE | Type | Registration | Dep | Arr | CI | STD | ATD | STA | ATA | CO | BLH | (BlockOff | BlockOn | Duty)
 *   24Nov24 |  | LM161 |  | ATR | GLMRE | INV | BHD | 0840 | 0940 | 0937 | 1045 | 1042 |  | 01:05
 *   Crew: CAP: LEE, Graeme, FO(X): MACGREGOR, Kieren          (the line's crew, maybe going on the next line)
 *   HTL | VNO | VNO | 0000 | 1200 | 1000+                     ("+": the next day; CI 0000: none)
 *   Date | Des. | Code | Req | LE | CI | Dep | STD | Arr | STA | CO | AC | WA | Func | Rank (| BLH)      ("Roster", dates "01 Thu")
 * Rows: CI a C/I row, the activity a row (begin / end the actual times, else the scheduled ones; ac, registration,
 * "[Block: 01:05]", crew "[CAP - LEE, Graeme][FO(X) - MACGREGOR, Kieren]"), CO a C/O row ("[Duty: 04:55]").
 */
function parsePerformedActivities(pages) {
  const trace = startTrace();
  const rows = [];
  const all = pages.flatMap(p => p.items.map(i => i.text)).join(' ');
  const per = /\((\d{2})([A-Z]{3})(\d{2}) - (\d{2})([A-Z]{3})(\d{2})\)/.exec(all);
  const zone = /TimeMode UTC/.test(all) ? 'Z' : 'L';
  const dayRow = (t) => { const d = new Date(t); return { date: `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${String(d.getUTCFullYear() % 100).padStart(2, '0')}`, day: WEEKDAYS[d.getUTCDay()] }; };
  const tm = (t) => { const m = /^(\d{2})(\d{2})(\+?)$/.exec(t || ''); return m ? { t: `${m[1]}:${m[2]}`, plus: m[3] ? 1 : 0 } : null; };
  const fmt = (x, extra = 0) => (x ? `${x.t}${x.plus + extra ? `+${x.plus + extra}` : ''}` : '');
  let day = null, last = null, crewLine = null;
  const cal = per ? { y: 2000 + +per[3], m: monthIndex(per[2]), last: 0 } : null;
  const crewOf = (t) => t.split(/,\s*(?=[A-Z][A-Za-z]*(?:\([^)]*\))?:)/).map(c => { const m = /^([^:]+):\s*(.+)$/.exec(c.trim()); return m ? `[${m[1]} - ${m[2].trim()}]` : ''; }).join('');
  for (const page of pages) {
    const reg = sleipnerHeader(page);
    if (!reg) continue;
    // (BlockOff / BlockOn over their 'time (UTC)')
    const head = page.items.filter(i => Math.abs(i.y - reg.y) < 3 || (/^Block(Off|On)$/.test(i.text) && Math.abs(i.y - reg.y) < 9));
    const cols = head.map(i => ({ name: i.text, x: i.x })).sort((a, b) => a.x - b.x);
    // (a value starts up to 11 points left of its header; values well right of the last header have no column)
    const colOf = (x) => { const c = [...cols].reverse().find(k => x >= k.x - 11) || cols[0]; return c === cols.at(-1) && x > c.x + 18 ? null : c.name; };
    // "WAW 1400": two cells in one item
    const words = page.items.filter(i => i.y > reg.y + 8).flatMap(i => {
      const parts = i.text.split(/(\s+)/);
      if (parts.length === 1 || /^Crew:/.test(i.text)) return [i];
      const cw = (i.w || i.text.length * 4.5) / i.text.length;
      let at = 0;
      return parts.map(p => { const it = { ...i, text: p, x: i.x + at * cw, w: p.length * cw }; at += p.length; return it; }).filter(p => p.text.trim());
    });
    for (const line of toLines(words, 3)) {
      const text = line.items.map(i => i.text).join(' ');
      const crew = /^Crew:\s*(.+)$/.exec(text);
      if (crew && last) {
        crewLine = { row: last, text: crew[1], x: line.items[0].x, items: [...line.items] };
        last.crew = crewOf(crew[1]);
        mark(last, 'crew', line.items);
        continue;
      }
      // the crew going on ("CC: Perez Luna, Alvaro, CC:" / "De Almeida Mariano, Didiana")
      if (crewLine && /,$|:$/.test(crewLine.text.trim()) && Math.abs(line.items[0].x - crewLine.x) < 120 && !/^\d/.test(text)) {
        crewLine.text += ` ${text}`;
        crewLine.row.crew = crewOf(crewLine.text);
        mark(crewLine.row, 'crew', line.items);
        crewLine = null;
        continue;
      }
      crewLine = null;
      const cell = {};
      for (const it of line.items) { const c = colOf(it.x); if (c) (cell[c] ||= []).push(it); }
      const get = (c) => (cell[c] || []).map(i => i.text).join(' ').trim();
      const d = /^(\d{2})([A-Z][a-z]{2})(\d{2})$/.exec(get('Date'));
      if (d && MONTHS.includes(d[2])) day = Date.UTC(2000 + +d[3], MONTHS.indexOf(d[2]), +d[1]);
      const dn = !d && cal && /^(\d{2}) [A-Z][a-z]{2}$/.exec(get('Date')); // "01 Thu" in the period's month
      if (dn) {
        if (+dn[1] < cal.last) { cal.m += 1; if (cal.m > 11) { cal.m = 0; cal.y += 1; } }
        cal.last = +dn[1];
        day = Date.UTC(cal.y, cal.m, +dn[1]);
      }
      const code = get('Code');
      if (day == null || !code || !/^[A-Z0-9][\w&/-]*$/.test(code) || !get('Dep')) continue;
      const ci = tm(get('CI')), co = tm(get('CO'));
      if (ci && ci.t !== '00:00') {
        const r = { section: 'published', ...dayRow(day), duty: 'C/I', dep: get('Dep'), begin: fmt(ci), notes: [] };
        rows.push(r);
        mark(r, 'ci', cell.CI);
      }
      const start = tm(get('ATD')) || tm(get('STD')), end = tm(get('ATA')) || tm(get('STA'));
      const later = (a, b) => (a && b && !b.plus && b.t < a.t ? 1 : 0); // an end before the start: the next day
      const blh = /^\d+:\d{2}$/.test(get('BLH')) && /[1-9]/.test(get('BLH')) ? get('BLH') : '';
      const r = {
        section: 'published', ...dayRow(day), duty: code, dep: get('Dep'), arr: get('Arr'), begin: fmt(start), end: fmt(end, later(start, end)),
        ac: get('Type') || get('AC'), registration: get('Registration'), crew: '', notes: [blh && `[Block: ${blh}]`].filter(Boolean),
      };
      rows.push(r);
      for (const [f, c] of [['date', 'Date'], ['duty', 'Code'], ['dep', 'Dep'], ['arr', 'Arr'], ['begin', get('ATD') ? 'ATD' : 'STD'], ['end', get('ATA') ? 'ATA' : 'STA'], ['ac', get('Type') ? 'Type' : 'AC'], ['registration', 'Registration'], ['info', 'BLH']]) mark(r, f, cell[c]);
      last = r;
      if (co) {
        const duty = /^\d+:\d{2}$/.test(get('Duty')) && /[1-9]/.test(get('Duty')) ? get('Duty') : '';
        // (after an end the next day: the next day too)
        const endDays = end ? end.plus + later(start, end) : 0;
        const coDays = Math.max(co.plus, endDays + (end && co.t < end.t ? 1 : 0));
        const c = { section: 'published', ...dayRow(day), duty: 'C/O', arr: get('Arr'), end: `${co.t}${coDays ? `+${coDays}` : ''}`, notes: [duty && `[Duty: ${duty}]`].filter(Boolean) };
        rows.push(c);
        mark(c, 'co', cell.CO);
      }
    }
  }
  const p = per && `${per[1]}${MONTHS[monthIndex(per[2])]}${per[3]} - ${per[4]}${MONTHS[monthIndex(per[5])]}${per[6]}`;
  const out = rows.map(r => outputRow({ ...r, info: r.notes.join(' ') }, zone));
  return { format: 'performed-activities', period: p || null, notices: [], recognized: out.length > 0, published: out, planned: [], _trace: trace, _rows: rows };
}

const isUtcPilotRoster = (page) => page.items.some(i => i.text === 'All times in UTC') && page.items.some(i => i.text === 'Pilot note') && page.items.some(i => i.text === 'Description');

/**
 * "All times in UTC" pilot roster (NAME | LICENCE NO. | MONTH OCTOBER | YEAR 2025), a block of lines per day:
 *   Day | Aircraft Type | Check In | Description | Function | Crew | Block | (Home Base |) Pilot note
 *                    TIH-ALK /
 *   A320 D-   09:35  SR134  10:45  BER  BEY  14:40    CPT   SWI-AMM-   03:55   BER
 *   ANNA                                                    SJB-NIO
 * The day ("15 Oct" over "Wed", or "17 Oct Fri") sits in the middle of its activities; the aircraft and the crew wrap above
 * and below their line (an aircraft in the middle of a day is the day's). Description: the activity, its start, airports,
 * end; a time left of it is the check in, one after the end the check out. A flight over midnight goes on in the next day
 * ("BER 03:40 04:10": its arrival and check out). Rows: C/I, the activity (ac, registration, crew as printed, "[Block: ..]",
 * a simulator "[Sim: ..]", the pilot note), C/O; OFF / REST / Free day / STANDBY a row of their own.
 */
function parseUtcPilotRoster(pages) {
  const trace = startTrace();
  const rows = [];
  const all = pages.flatMap(p => p.items.map(i => i.text));
  const yi = all.indexOf('YEAR');
  const year = yi >= 0 ? +(all.slice(yi + 1, yi + 3).find(t => /^\d{4}$/.test(t)) || 0) : 0;
  if (!year) return { format: 'utc-pilot-roster', period: null, notices: [], recognized: false, published: [], planned: [], _trace: trace, _rows: [] };
  const dayRow = (t) => { const d = new Date(t); return { date: `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${String(d.getUTCFullYear() % 100).padStart(2, '0')}`, day: WEEKDAYS[d.getUTCDay()] }; };
  const isTime = (t) => /^\d{2}:\d{2}$/.test(t);
  const isAirport = (t) => /^[A-Z]{3}$/.test(t);
  const mins = (t) => +t.slice(0, 2) * 60 + +t.slice(3);
  let yr = year, lastMonth = null, first = null, last = null;
  let open = null; // a flight not landed yet (over midnight)
  // the columns from the first page's header; the next pages go on below their "Date of Issue" (one long page)
  let X = null;
  const body = [];
  for (const [pi, page] of pages.entries()) {
    const hx = (t) => page.items.filter(i => i.text === t).sort((a, b) => a.x - b.x)[0]?.x;
    const head = page.items.find(i => i.text === 'Pilot note');
    if (head && !X) {
      X = {
        day: hx('Day'), ac: hx('Aircraft') ?? hx('Aircraft Type'), ci: hx('Check'), desc: hx('Description'), fn: hx('Function'),
        block: hx('Block'), home: hx('Home'), note: head.x,
      };
      if ([X.day, X.ac, X.ci, X.desc, X.fn, X.block].some(v => v == null)) X = null;
    }
    const top = head?.y ?? page.items.find(i => /^\d{2}-\d{2}-\d{4}$/.test(i.text))?.y;
    if (X && top != null) body.push(...page.items.filter(i => i.y > top + 10).map(i => ({ ...i, y: i.y + pi * 1000 })));
  }
  if (X) {
    const zone = (i) => {
      if (i.x < X.ac - 8) return 'day';
      if (i.x < X.ci - 8) return 'ac';
      if (i.x < X.fn - 5) return 'desc';
      if (i.x < X.fn + 40) return 'fn';
      if (i.x < X.block - 10) return 'crew';
      if (i.x < (X.home ?? X.note) - 5) return 'block';
      if (X.home != null && i.x < X.note - 5) return 'home';
      return 'note';
    };
    // the activities: lines with a description
    const recs = toLines(body.filter(i => ['desc', 'fn', 'block', 'home', 'note'].includes(zone(i))))
      .filter(l => l.items.some(i => zone(i) === 'desc'))
      .map(l => ({ y: l.y, items: l.items, ac: [], crew: [] }));
    const nearest = (y) => recs.reduce((a, c) => (Math.abs(c.y - y) < Math.abs(a.y - y) ? c : a));
    for (const it of recs.length ? body.filter(i => zone(i) === 'crew') : []) nearest(it.y).crew.push(it);
    // an aircraft on (or just over and under) its line, or in the middle of the day's lines ("A320 9A-" over "SHO")
    const dayAc = [];
    for (const it of recs.length ? body.filter(i => zone(i) === 'ac').sort((a, b) => a.y - b.y) : []) {
      const r = nearest(it.y);
      if (Math.abs(r.y - it.y) <= 6) r.ac.push(it);
      else if (dayAc.length && it.y - dayAc.at(-1).y < 10) dayAc.at(-1).items.push(it);
      else dayAc.push({ y: it.y, items: [it] });
    }
    // the days: "15 Oct" (+ "Wed" under it) or "17 Oct Fri", in the middle of their activities
    const labels = [];
    for (const it of body.filter(i => zone(i) === 'day').sort((a, b) => a.y - b.y)) {
      const m = /^(\d{2}) ([A-Z][a-z]{2})(?: [A-Z][a-z]{2})?$/.exec(it.text);
      if (m) labels.push({ y: it.y, d: +m[1], m: MONTHS.indexOf(m[2]), items: [it] });
      else if (/^[A-Z][a-z]{2}$/.test(it.text) && labels.length && it.y - labels.at(-1).y < 12) { labels.at(-1).y = (labels.at(-1).y + it.y) / 2; labels.at(-1).items.push(it); }
    }
    let k = 0;
    const groups = [];
    for (const [li, L] of labels.entries()) {
      if (L.m < 0) continue;
      if (lastMonth != null && L.m < lastMonth) yr += 1;
      lastMonth = L.m;
      const t = Date.UTC(yr, L.m, L.d);
      first ??= t;
      last = t;
      const nextY = labels[li + 1]?.y ?? Infinity;
      // the fewest activities from here whose middle is the label's
      let n = 0, sum = 0;
      for (let j = k; j < recs.length && recs[j].y < nextY; j++) {
        sum += recs[j].y;
        if (Math.abs(sum / (j - k + 1) - L.y) <= 4) { n = j - k + 1; break; }
      }
      if (!n) continue;
      groups.push({ t, L, recs: recs.slice(k, k + n) });
      k += n;
    }
    for (const g of groups) {
      const acs = dayAc.filter(a => a.y > g.recs[0].y - 15 && a.y < g.recs.at(-1).y + 15);
      for (const rec of g.recs) if (!rec.ac.length && acs.length) rec.ac = acs.reduce((a, c) => (Math.abs(c.y - rec.y) < Math.abs(a.y - rec.y) ? c : a)).items;
    }
    for (const g of groups) {
      for (const rec of g.recs) {
        const desc = rec.items.filter(i => zone(i) === 'desc' && i.text !== '…').sort((a, b) => a.x - b.x);
        const nameIts = desc.filter(i => !isTime(i.text) && i.x < X.desc + 5);
        const name = nameIts.map(i => i.text).join(' ');
        const aps = desc.filter(i => isAirport(i.text) && i.x >= X.desc + 5);
        const nameX = nameIts[0]?.x ?? (aps[0]?.x ?? Infinity);
        const times = desc.filter(i => isTime(i.text));
        const ciIt = times.find(i => i.x < nameX && name);
        const depT = times.find(i => i.x > nameX && aps[0] && i.x < aps[0].x);
        const after = aps.length ? times.filter(i => i.x > aps.at(-1).x) : times.filter(i => i !== ciIt && i !== depT);
        const [endIt, coIt] = after;
        const get = (z) => rec.items.filter(i => zone(i) === z).map(i => i.text).join(' ');
        const block = get('block');
        const note = get('note');
        // a flight's arrival after midnight
        if (!name && open && aps.length === 1 && endIt) {
          const days = Math.round((g.t - open.t) / 86400000);
          Object.assign(open.row, { arr: aps[0].text, end: `${endIt.text}${days > 0 ? `+${days}` : ''}` });
          if (/[1-9]/.test(block)) open.row.notes.unshift(`[Block: ${block}]`);
          mark(open.row, 'end', [endIt]);
          if (coIt) {
            const co = { section: 'published', ...dayRow(g.t), duty: 'C/O', arr: aps[0].text, end: coIt.text, notes: [] };
            rows.push(co);
            mark(co, 'co', [coIt]);
          }
          open = null;
          continue;
        }
        if (!name) continue;
        open = null;
        const flight = /^[A-Z0-9]{2,3}\d{1,4}[A-Z]?$/.test(name) && !/^SIM/.test(name);
        const duty = flight || /^SIM/.test(name); // a standby's check in / out are its own times
        if (ciIt && duty) {
          const ci = { section: 'published', ...dayRow(g.t), duty: 'C/I', dep: aps[0]?.text || '', begin: ciIt.text, notes: [] };
          rows.push(ci);
          mark(ci, 'ci', [ciIt]);
        }
        const acText = rec.ac.sort((a, b) => a.y - b.y).map(i => i.text).join(' ');
        const acM = /^(\S+)(?:\s+(.+))?$/.exec(acText) || [];
        const crew = rec.crew.sort((a, b) => a.y - b.y || a.x - b.x).map(i => i.text).reduce((s, t) => (!s ? t : /-$/.test(s) ? s + t : `${s} ${t}`), '');
        const begin = depT?.text || '';
        const end = endIt ? `${endIt.text}${begin && mins(endIt.text) < mins(begin) ? '+1' : ''}` : '';
        const r = {
          section: 'published', ...dayRow(g.t), duty: name, dep: aps[0]?.text || '', arr: aps[1]?.text || '', begin, end,
          ac: flight || /^SIM/.test(name) ? acM[1] || '' : '', registration: flight ? (acM[2] || '').replace(/\s+/g, '') : '', crew: flight ? crew : '',
          notes: [/[1-9]/.test(block) && (flight ? `[Block: ${block}]` : `[Sim: ${block}]`), note].filter(Boolean),
        };
        rows.push(r);
        mark(r, 'duty', nameIts);
        mark(r, 'date', g.L.items);
        mark(r, 'dep', aps.slice(0, 1));
        mark(r, 'arr', aps.slice(1, 2));
        mark(r, 'begin', depT ? [depT] : []);
        mark(r, 'end', endIt ? [endIt] : []);
        mark(r, 'crew', rec.crew);
        if (flight && aps.length === 1 && !endIt) { open = { row: r, t: g.t }; continue; }
        if (coIt && duty) {
          const co = {
            section: 'published', ...dayRow(g.t), duty: 'C/O', arr: aps.at(-1)?.text || '',
            end: `${coIt.text}${endIt && mins(coIt.text) < mins(endIt.text) ? '+1' : ''}`, notes: [],
          };
          rows.push(co);
          mark(co, 'co', [coIt]);
        }
      }
    }
  }
  const fmt = (t) => { const d = new Date(t); return `${String(d.getUTCDate()).padStart(2, '0')}${MONTHS[d.getUTCMonth()]}${String(d.getUTCFullYear() % 100).padStart(2, '0')}`; };
  const out = rows.map(r => outputRow({ ...r, info: r.notes.join(' ') }, 'Z'));
  return {
    format: 'utc-pilot-roster', period: first != null ? `${fmt(first)} - ${fmt(last)}` : null, notices: [], recognized: out.length > 0,
    published: out, planned: [], _trace: trace, _rows: rows,
  };
}

const isNzPublishedRoster = (page) => page.items.some(i => /Published Roster: \d{2}\/\d{4}/.test(i.text)) && page.items.some(i => /REP\/FIN/.test(i.text));

/**
 * Air New Zealand "Published Roster: 08/2024" (a monospaced table drawn with box characters, a cell per "│"):
 *   NZ DATE | LOCAL DATE | DUTY | ACTIVITY | ROLE | SECTOR | HOTEL PICKUP | REP/FIN | ETD | ETA | FLIGHT TIME | DUTY TIME |
 *   (TOD TIME |) O/N CITY | (UTC DEV | DEA |) NOTES/TRAINING
 *   │Tue-16Jul │Tue-16Jul │MEL5194 │ NZ253  │ F/O │WLG MEL│       │0500/    │0600│0805│ 4:05 │     │    │ ...
 *   │          │          │        │ NZ264  │ F/O │MEL ZQN│       │    /1500│0915│1430│ 3:15 │10:00│ZQN │+12 │ 2 │HTL:SOFITEL ...
 * A duty runs from its report ("0500/") to its finish ("/1500"), maybe over days ("0000/" .. "/2359"). Local times.
 * Rows: a duty with flights a C/I row (report, "[Trip: MEL5194]", "[Pickup: 05:40]"), its flights ("TV" before the flight: a
 * deadhead, the role then the aircraft; "[Block: 04:05]", the training note; crew from "Additional Crew On Flight:"), its timed
 * activities (SIM ..), a C/O row (finish, "[Duty: 10:00] [TOD: ..]") and the hotel an H row (the O/N city, the hotel's name);
 * a duty without flights (MOF, C1, WOF ..) one row from its report to its finish. IFSR (the sign-on) and M (a meal) are left out.
 */
function parseNzPublishedRoster(pages) {
  const trace = startTrace();
  const rows = [];
  const all = pages.flatMap(p => p.items.map(i => i.text)).join(' ');
  const pub = /Published Roster: (\d{2})\/(\d{4})/.exec(all);
  if (!pub) return { format: 'nz-published-roster', period: null, notices: [], recognized: false, published: [], planned: [], _trace: trace, _rows: [] };
  const pm = +pub[1] - 1, py = +pub[2];
  const dayRow = (t) => { const d = new Date(t); return { date: `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${String(d.getUTCFullYear() % 100).padStart(2, '0')}`, day: WEEKDAYS[d.getUTCDay()] }; };
  const dateOf = (t) => {
    const m = /^[A-Z][a-z]{2}-(\d{2})([A-Z][a-z]{2})$/.exec(t || '');
    if (!m) return null;
    const mo = MONTHS.indexOf(m[2]);
    return Date.UTC(py + (mo - pm > 6 ? -1 : pm - mo > 6 ? 1 : 0), mo, +m[1]);
  };
  const hm = (t) => (/^\d{4}$/.test(t) ? `${t.slice(0, 2)}:${t.slice(2)}` : '');
  const mins = (t) => +t.slice(0, 2) * 60 + +t.slice(3, 5);
  const dur = (t) => { const m = /^(\d{1,3}):(\d{2})$/.exec(t || ''); return m && +m[1] + +m[2] ? `${m[1].padStart(2, '0')}:${m[2]}` : ''; };
  // a page's lines as text, each item at its character column (the font is monospaced)
  const charLines = (page) => {
    const byY = [];
    for (const it of [...page.items].sort((a, b) => a.y - b.y)) {
      const l = byY.find(x => Math.abs(x.y - it.y) <= 2);
      if (l) l.items.push(it); else byY.push({ y: it.y, items: [it] });
    }
    const head = byY.find(l => l.items.some(i => /REP\/FIN/.test(i.text)));
    const dates = head ? head.items.filter(i => /^│DATE/.test(i.text)).sort((a, b) => a.x - b.x) : [];
    const cw = dates.length > 1 ? (dates[1].x - dates[0].x) / 11 : 3.6;
    const x0 = head ? Math.min(...head.items.map(i => i.x)) : Math.min(...page.items.map(i => i.x));
    return byY.map(l => {
      let s = '';
      const at = [];
      for (const it of l.items.sort((a, b) => a.x - b.x)) {
        const c = Math.max(0, Math.round((it.x - x0) / cw));
        s = s.padEnd(c);
        s = s.slice(0, c) + it.text + s.slice(c + it.text.length);
        at.push({ c, it });
      }
      const bars = [...s].map((ch, i) => (ch === '│' ? i : -1)).filter(i => i >= 0);
      const cells = bars.slice(0, -1).map((b, k) => ({ text: s.slice(b + 1, bars[k + 1]).trim(), c0: b + 1, c1: bars[k + 1] }));
      const itemsOf = (k) => { const cell = cells[k]; return cell ? at.filter(a => a.c < cell.c1 && a.c + a.it.text.length > cell.c0).map(a => a.it) : []; };
      return { y: l.y, text: s, cells, itemsOf, isHead: l === head };
    });
  };
  // the other crew: "16-JUL  NZ-0253       JOHN DORE (41855)", "... (T) SHANE MCLEAN (96890), LEEANN YARE (48942)"
  const crew = new Map();
  const pageLines = pages.map(charLines);
  for (const lines of pageLines) {
    let on = false;
    for (const l of lines) {
      if (/^Additional Crew On Flight:/.test(l.text.trim())) { on = true; continue; }
      const m = on && /^(\d{2})-([A-Z]{3})\s+([A-Z0-9]{2})-0*(\d+[A-Z]?)\s+(.+\(\d+\))\s*$/.exec(l.text.trim());
      if (!m) continue;
      const key = `${+m[1]}${m[2]}|${m[3]}${m[4]}`;
      const names = [...m[5].matchAll(/(?:\(([A-Z])\)\s*)?([^,(]+?)\s*\((\d+)\)/g)].map(n => `[${n[1] ? `${n[1]} - ` : ''}${n[3]} - ${n[2].trim()}]`);
      crew.set(key, `${crew.get(key) || ''}${names.join('')}`);
    }
  }
  const crewKey = (t, flight) => { const d = new Date(t); return `${d.getUTCDate()}${MONTHS[d.getUTCMonth()].toUpperCase()}|${flight}`; };
  let duty = null, date = null, nzDate = null, first = null, last = null;
  const emit = (d) => {
    const acts = d.acts.filter(a => a.dep || a.etd);
    const flights = acts.filter(a => a.dep);
    if (!acts.length) {
      const a = d.acts.find(x => !/^(IFSR|M)$/.test(x.act)) || d.acts[0];
      if (!a) return;
      const days = Math.round((d.finDate - d.date) / 86400000);
      const r = {
        section: 'published', ...dayRow(d.date), duty: a.act, begin: d.rep, end: d.fin ? `${d.fin}${days > 0 ? `+${days}` : ''}` : '',
        notes: [dur(d.dutyTime) && `[Duty: ${dur(d.dutyTime)}]`, ...a.notes].filter(Boolean),
      };
      rows.push(r);
      mark(r, 'duty', a.items.act);
      mark(r, 'begin', d.repItems);
      return;
    }
    const ci = {
      section: 'published', ...dayRow(d.date), duty: 'C/I', dep: flights[0]?.dep || '', begin: d.rep,
      notes: [d.trip && `[Trip: ${d.trip}]`, d.pickup && `[Pickup: ${d.pickup}]`].filter(Boolean),
    };
    if (d.rep) { rows.push(ci); mark(ci, 'ci', d.repItems); }
    let prev = d.rep ? mins(d.rep) : null, prevDate = d.date, lastArr = '';
    const time = (t, at) => {
      if (!t) return '';
      if (at !== prevDate) { prev = null; prevDate = at; }
      const plus = prev != null && mins(t) < prev ? 1 : 0;
      if (!plus) prev = mins(t);
      return `${t}${plus ? '+1' : ''}`;
    };
    for (const a of acts) {
      const tv = /^TV([A-Z0-9]{2}\d+[A-Z]?)$/.exec(a.act);
      const flight = tv ? tv[1] : a.act;
      const { dep, arr } = a;
      const begin = time(a.etd, a.date);
      // a long flight lands on a later line (its own day)
      const days = a.etaDate != null ? Math.round((a.etaDate - a.date) / 86400000) : 0;
      let end;
      if (days > 0 && a.eta) { end = `${a.eta}+${days}`; prevDate = a.etaDate; prev = mins(a.eta); } else end = time(a.eta, a.date);
      const r = {
        section: 'published', ...dayRow(a.date), dc: tv ? 'DH' : '', duty: flight, dep, arr, ac: tv ? a.role : '',
        begin, end, crew: dep ? crew.get(crewKey(a.nz, flight)) || '' : '',
        notes: [dur(a.block) && `[Block: ${dur(a.block)}]`, ...a.notes].filter(Boolean),
      };
      rows.push(r);
      mark(r, 'duty', a.items.act);
      mark(r, 'route', a.items.sector);
      mark(r, 'begin', a.items.etd);
      mark(r, 'end', a.items.eta);
      if (arr) lastArr = arr;
    }
    if (d.fin) {
      const co = {
        section: 'published', ...dayRow(d.finDate), duty: 'C/O', arr: lastArr, end: time(d.fin, d.finDate),
        notes: [dur(d.dutyTime) && `[Duty: ${dur(d.dutyTime)}]`, dur(d.tod) && `[TOD: ${dur(d.tod)}]`].filter(Boolean),
      };
      rows.push(co);
      mark(co, 'co', d.finItems);
    }
    if (d.hotel) {
      const h = { section: 'published', ...dayRow(d.finDate), duty: 'H', dep: d.city || lastArr, notes: [d.hotel] };
      rows.push(h);
      mark(h, 'hotel', d.hotelItems);
    }
  };
  for (const lines of pageLines) {
    const hi = lines.findIndex(l => l.isHead);
    if (hi < 1) continue;
    const top = lines[hi - 1].cells, bottom = lines[hi].cells;
    const labels = bottom.map((c, k) => `${top[k]?.text || ''} ${c.text}`.trim());
    const col = (re) => labels.findIndex(l => re.test(l));
    const C = {
      nz: col(/^NZ DATE$/), local: col(/^LOCAL DATE$/), duty: col(/^DUTY$/), act: col(/^ACTIVITY$/), role: col(/^ROLE$/), sector: col(/^SECTOR$/),
      pickup: col(/PICKUP$/), repfin: col(/^REP\/FIN$/), etd: col(/^ETD$/), eta: col(/^ETA$/), block: col(/^FLIGHT TIME$/), dutyTime: col(/^DUTY TIME$/),
      tod: col(/^TOD TIME$/), city: col(/^O\/N CITY$/), notes: col(/^NOTES/),
    };
    for (const l of lines.slice(hi + 1)) {
      if (!l.cells.length || l.cells.length < labels.length) continue;
      const get = (k) => (k >= 0 ? l.cells[k]?.text || '' : '');
      if (get(C.nz)) {
        nzDate = dateOf(get(C.nz));
        date = dateOf(get(C.local)) ?? nzDate;
        if (date != null) { first ??= date; last = date; }
      }
      if (date == null) continue;
      const rf = /^(\d{4})?\s*\/\s*(\d{4})?$/.exec(get(C.repfin));
      const act = get(C.act);
      const note = get(C.notes);
      if (rf?.[1]) {
        duty = { date, rep: hm(rf[1]), repItems: l.itemsOf(C.repfin), trip: get(C.duty), pickup: hm(get(C.pickup)), acts: [] };
      }
      const sector = get(C.sector).split(/\s+/).filter(t => /^[A-Z]{3}$/.test(t));
      const isAct = act && !/^[/-]+$/.test(act);
      const open = duty?.acts.at(-1);
      if (!isAct && sector.length === 1 && open?.dep && !open.arr && get(C.eta)) {
        Object.assign(open, { arr: sector[0], eta: hm(get(C.eta)), etaDate: date, block: get(C.block) });
        open.items.sector.push(...l.itemsOf(C.sector));
        open.items.eta = l.itemsOf(C.eta);
      }
      if (isAct) {
        duty ??= { date, rep: '', repItems: [], trip: get(C.duty), pickup: '', acts: [] };
        duty.acts.push({
          date, nz: nzDate, act, role: get(C.role), dep: sector[0] || '', arr: sector[1] || '',
          etd: hm(get(C.etd)), eta: hm(get(C.eta)), block: get(C.block), notes: [],
          items: { act: l.itemsOf(C.act), sector: l.itemsOf(C.sector), etd: l.itemsOf(C.etd), eta: l.itemsOf(C.eta) },
        });
      }
      if (note && duty) {
        if (/^HTL:/.test(note)) { duty.hotel = note.slice(4).trim(); duty.hotelItems = l.itemsOf(C.notes); }
        else if (duty.acts.length) {
          const a = duty.acts.at(-1);
          // ". Crw MCLEAN (96890)" goes on with the note above, another line is a note of its own
          if (!isAct && a.notes.length && /^\./.test(note)) a.notes[a.notes.length - 1] += note; else a.notes.push(note);
        }
      }
      if (get(C.city) && duty) duty.city = get(C.city);
      if (rf?.[2] && duty) {
        Object.assign(duty, { fin: hm(rf[2]), finDate: date, finItems: l.itemsOf(C.repfin), dutyTime: get(C.dutyTime), tod: get(C.tod) });
        emit(duty);
        duty = null;
      }
    }
  }
  if (duty) { duty.finDate = date; emit(duty); }
  const fmt = (t) => { const d = new Date(t); return `${String(d.getUTCDate()).padStart(2, '0')}${MONTHS[d.getUTCMonth()]}${String(d.getUTCFullYear() % 100).padStart(2, '0')}`; };
  const out = rows.map(r => outputRow({ ...r, info: r.notes.join(' ') }, 'L'));
  return {
    format: 'nz-published-roster', period: first != null ? `${fmt(first)} - ${fmt(last)}` : null, notices: [], recognized: out.length > 0,
    published: out, planned: [], _trace: trace, _rows: rows,
  };
}

const isAllegiantRoster = (page) => page.items.some(i => /^merlot\.aero-/.test(i.text)) && page.items.some(i => /^Sector\(s\)/.test(i.text));

/**
 * merlot.aero "Employee Roster Report" / "Initial Publish Roster" (Allegiant Air; "1/Oct/2024 to 31/Oct/2024"), a block of lines per day:
 *   Day | Date | Duty | Property | From | Report | To | Release | Scheduled Flight | Flight Time | Duty Time | TAFB Time | Rest Time |
 *   Sector(s)/Event(s) | Allowances
 *   Thu | 03-Oct | G30084P-1 | | PGD | 13:24 L | | 20:18 L | 4.82 | 4.82 | 6.90 | 6.90 | 17.80 | 951 PGD 14:24 L DAY 16:49 L
 *                                                                                    2502 DAY 17:39 L PGD 20:03 L
 * (the sectors start a little above the date: a line goes to the day whose date is nearest). Local times, hours as decimals
 * ("4.82" = 4:49). Rows: a duty a C/I row (Report, From, "[Trip: G30084P-1]"), its sectors (flight, dep / arr with their times,
 * "+1" when one lands after midnight), a C/O row (Release, "[Block: 04:49] [Duty: 06:54] [TAFB: 06:54] [Rest: 17:48]");
 * a day off ("X-1") a row of its own.
 */
function parseAllegiantRoster(pages) {
  const trace = startTrace();
  const rows = [];
  const all = pages.flatMap(p => p.items.map(i => i.text)).join(' ');
  const per = /(\d{1,2})\/([A-Z][a-z]{2})\/(\d{4}) to (\d{1,2})\/([A-Z][a-z]{2})\/(\d{4})/.exec(all);
  const mon = (t) => MONTHS.indexOf(t);
  if (!per) return { format: 'allegiant-roster', period: null, notices: [], recognized: false, published: [], planned: [], _trace: trace, _rows: [] };
  const dayRow = (t) => { const d = new Date(t); return { date: `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${String(d.getUTCFullYear() % 100).padStart(2, '0')}`, day: WEEKDAYS[d.getUTCDay()] }; };
  // hours as decimals ("4.82") or as "4:00" (Eastern Airways)
  const hrs = (t) => {
    const hmm = /^(\d+):(\d{2})$/.exec(t || '');
    if (hmm) return /[1-9]/.test(t) ? `${hmm[1].padStart(2, '0')}:${hmm[2]}` : '';
    if (!/^\d+\.\d{2}$/.test(t || '')) return '';
    const m = Math.round(+t * 60);
    return m ? `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}` : '';
  };
  const hm = (t) => { const m = /^(\d{1,2}:\d{2})(?: L)?$/.exec(t || ''); return m ? m[1].padStart(5, '0') : ''; };
  let yr = +per[3], lastM = mon(per[2]);
  let X = null, hours = null; // the columns, kept for a page printed without the header
  for (const page of pages) {
    const head = page.items.find(i => i.text === 'Report');
    const sect = page.items.find(i => /^Sector\(s\)/.test(i.text));
    if (head && sect) {
      const hx = (t) => page.items.find(i => i.text === t && Math.abs(i.y - head.y) < 3)?.x;
      X = { duty: hx('Duty'), prop: hx('Property'), from: hx('From'), report: hx('Report'), release: hx('Release'), sect: sect.x - 16 };
      // the hours' columns by their headers when all are printed (Flight / Rest over their "Time")
      const hy = (t) => page.items.find(i => i.text === t && Math.abs(i.y - head.y) < 8)?.x;
      hours = ['Flight', 'Duty Time', 'TAFB Time', 'Rest'].map(t => hy(t));
    }
    if (!X) continue;
    const top = head && sect ? head.y : -Infinity;
    // (the month's totals and the print line end the days)
    const bottom = Math.min(...page.items.filter(i => i.text === 'Totals:').map(i => i.y - 4), Infinity);
    // "01-" over "Aug L" (Eastern Airways): one date
    const split = page.items.filter(i => /^\d{2}-$/.test(i.text) && i.y > top && i.y < bottom).map(i => {
      const m = page.items.find(j => /^[A-Z][a-z]{2}( L)?$/.test(j.text) && Math.abs(j.x - i.x) < 6 && j.y > i.y && j.y - i.y < 12);
      return m && { ...i, text: i.text + m.text.slice(0, 3) };
    }).filter(Boolean);
    const dates = [...page.items.filter(i => /^\d{2}-[A-Z][a-z]{2}$/.test(i.text) && i.y > top && i.y < bottom), ...split].sort((a, b) => a.y - b.y);
    const blocks = dates.map(d => ({ d, items: [] }));
    // a day's lines: from a little above its date; its comments are left out
    const comment = (i) => i.text === 'Comment:' || /^\[[A-Za-z ]+\]/.test(i.text);
    const body = page.items.filter(i => i.y > top + 6 && i.y < bottom && !comment(i));
    for (const it of body.filter(i => i.x < X.sect - 8)) {
      const b = [...blocks].reverse().find(c => it.y >= c.d.y - 12);
      if (b && it.y < b.d.y + 30) b.items.push(it);
    }
    // the sectors, printed around their day's line: a sector's lines (wrapped until its two times) go to the day near it
    // whose Report - Release holds its start, else to the nearest
    const groups = [];
    for (const it of body.filter(i => i.x >= X.sect - 8).sort((a, b) => a.y - b.y || a.x - b.x)) {
      const g = groups.at(-1);
      const done = (t) => (t.match(/\d{1,2}:\d{2} L/g) || []).length >= 2;
      // (a time's "L" may be printed a line lower)
      if (g && !done(g.text) && (it.y - g.y < 12 || (it.text === 'L' && it.y - g.y < 18))) { g.items.push(it); g.text += ` ${it.text}`; g.y = it.y; } else groups.push({ y0: it.y, y: it.y, text: it.text, items: [it] });
    }
    const toMin = (t) => (t ? +t.slice(0, 2) * 60 + +t.slice(3) : null);
    const timeIn = (b, x0, x1) => toMin(hm(b.items.filter(i => i.x >= x0 - 8 && i.x < x1 - 4).map(i => i.text).find(t => /:\d{2}( L)?$/.test(t)) || ''));
    for (const b of blocks) {
      b.rep = timeIn(b, X.report, X.report + 30); b.rel = timeIn(b, X.release, X.release + 18);
      b.from = b.items.filter(i => i.x >= X.from - 8 && i.x < X.report - 4).map(i => i.text).find(t => /^[A-Z]{3}$/.test(t));
    }
    const holds = (b, t) => b.rep != null && b.rel != null && (b.rep <= b.rel ? t >= b.rep && t <= b.rel : t >= b.rep || t <= b.rel);
    // A duty's sectors are printed in its order, the days' one after another: a sector goes on the duty being
    // read when it goes on from it (leaves where the last one landed, or from the duty's From, after its report /
    // the last landing, before its release); the duty is done when one lands less than half an hour before its release.
    const duties = blocks.filter(b => b.rep != null);
    let current = 0;
    const after = (b, t) => (t < b.rep - 120 ? t + 1440 : t); // minutes from the report's day
    const goesOn = (b, leg) => {
      if (b.done || leg.dep !== (b.lastArr ?? b.from)) return false;
      const start = after(b, leg.start);
      return start >= (b.lastEnd ?? b.rep) && (b.rel == null || start <= after(b, b.rel));
    };
    for (const g of groups) {
      const t = toMin(hm(/(\d{1,2}:\d{2}) L/.exec(g.text)?.[1] || ''));
      const lm = /([A-Z]{3}) (\d{1,2}:\d{2}) L ([A-Z]{3}) (\d{1,2}:\d{2}) L$/.exec(g.text);
      const leg = lm && { dep: lm[1], start: toMin(hm(lm[2])), arr: lm[3], end: toMin(hm(lm[4])) };
      // (the duty being read when it goes on from it, else the one whose date is nearest)
      const fit = leg ? duties.map((c, j) => j).filter(j => j >= current && Math.abs(duties[j].d.y - g.y0) < 80 && goesOn(duties[j], leg)) : [];
      const k = fit.includes(current) && duties[current].lastArr ? current
        : fit.length ? fit.reduce((a, j) => (Math.abs(duties[j].d.y - g.y0) < Math.abs(duties[a].d.y - g.y0) ? j : a)) : -1;
      if (k >= 0) {
        const c = duties[current = k];
        c.items.push(...g.items);
        c.lastArr = leg.arr;
        const start = after(c, leg.start);
        c.lastEnd = after(c, leg.end) < start ? after(c, leg.end) + 1440 : after(c, leg.end);
        if (c.rel != null && c.lastEnd >= after(c, c.rel) - 30) c.done = true;
        continue;
      }
      const near = blocks.filter(c => Math.abs(c.d.y - g.y0) < 60);
      const nearest = (list) => list.reduce((a, c) => (Math.abs(c.d.y - g.y0) < Math.abs(a.d.y - g.y0) ? c : a));
      const inside = t != null ? near.filter(c => holds(c, t)) : [];
      // (two days holding it: the one whose last sector lands where it leaves)
      const dep = /^\S+ ([A-Z]{3}) \d/.exec(g.text)?.[1];
      const onward = inside.filter(c => dep && c.lastArr === dep);
      const b = onward.length ? nearest(onward) : inside.length ? nearest(inside) : near.length ? nearest(near) : null;
      if (b && (inside.length || Math.abs(b.d.y - g.y0) < 40)) { b.items.push(...g.items); b.lastArr = /([A-Z]{3}) \d{1,2}:\d{2} L$/.exec(g.text)?.[1] || b.lastArr; }
    }
    for (const { d, items } of blocks) {
      const [dd, mm] = d.text.split('-');
      const m = mon(mm);
      if (m < lastM) yr += 1;
      lastM = m;
      const day = Date.UTC(yr, m, +dd);
      const col = (x0, x1) => items.filter(i => i.x >= x0 - 8 && i.x < x1 - 4).sort((a, b) => a.y - b.y || a.x - b.x);
      // ("G30084P-" + "1", "SMS" + "COMPANY")
      const dutyCol = items.filter(i => i.x >= X.duty - 12 && i.x < (X.prop ?? X.from + 4) - 4).sort((a, b) => a.y - b.y || a.x - b.x); // (a code starts left of its header)
      const duty = dutyCol.map(i => i.text).reduce((s, t) => (!s ? t : /-$/.test(s) || /^\d+$/.test(t) ? s + t : `${s} ${t}`), '').replace(/\s+/g, ' ');
      const from = col(X.from, X.report).map(i => i.text).join(' ');
      const report = hm(col(X.report, X.report + 30).map(i => i.text).find(t => /:\d{2}( L)?$/.test(t)) || '');
      const release = hm(col(X.release, X.release + 18).map(i => i.text).find(t => /:\d{2}( L)?$/.test(t)) || '');
      const numItems = items.filter(i => i.x > X.release + 20 && i.x < X.sect && /^\d+(\.|:)\d{2}$/.test(i.text)).sort((a, b) => a.x - b.x);
      // scheduled flight, flight, duty, TAFB, rest (in order, or by their headers)
      let [, flightTime, dutyTime, tafb, rest] = numItems.map(i => i.text);
      if (hours.every(x => x != null)) {
        const at = (k) => numItems.find(i => hours.reduce((a, x, j) => (Math.abs(x - i.x) < Math.abs(hours[a] - i.x) ? j : a), 0) === k)?.text;
        [flightTime, dutyTime, tafb, rest] = [0, 1, 2, 3].map(at);
      }
      const sectors = col(X.sect, 10000).map(i => i.text).join(' ');
      const legs = [...sectors.matchAll(/(\S+) ([A-Z]{3}) (\d{1,2}:\d{2}) L ([A-Z]{3}) (\d{1,2}:\d{2}) L/g)];
      // a ground event ("Security Course NQY 9:00 L NQY 13:00 L"): its name, not a flight number
      const event = !legs.some(l => /^([A-Z0-9]{2,3}\d{1,4}[A-Z]?|\d{1,5})$/.test(l[1])) && /^(.+?) ([A-Z]{3}) (\d{1,2}:\d{2}) L ([A-Z]{3}) (\d{1,2}:\d{2}) L/.exec(sectors);
      if (event) legs.splice(0, legs.length, [event[0], duty, event[2], event[3], event[4], event[5], event[1]]);
      if (!report && !legs.length) {
        if (!duty) continue;
        const r = { section: 'published', ...dayRow(day), duty, dep: from, notes: [] };
        rows.push(r);
        mark(r, 'date', [d]);
        mark(r, 'duty', dutyCol);
        continue;
      }
      if (report) {
        const ci = { section: 'published', ...dayRow(day), duty: 'C/I', dep: from, begin: report, notes: [duty && `[Trip: ${duty}]`].filter(Boolean) };
        rows.push(ci);
        mark(ci, 'ci', col(X.report, X.report + 30));
        mark(ci, 'date', [d]);
      }
      let prevMin = report ? +report.slice(0, 2) * 60 + +report.slice(3) : 0, plus = 0;
      let lastArr = from;
      for (const [, flight, dep, t1, arr, t2, name] of legs) {
        const a = hm(t1), b = hm(t2);
        const am = +a.slice(0, 2) * 60 + +a.slice(3), bm = +b.slice(0, 2) * 60 + +b.slice(3);
        if (am < prevMin) plus += 1;
        const begin = `${a}${plus ? `+${plus}` : ''}`;
        if (bm < am) plus += 1;
        const r = { section: 'published', ...dayRow(day), duty: flight, dep, arr, begin, end: `${b}${plus ? `+${plus}` : ''}`, notes: [name].filter(Boolean) };
        rows.push(r);
        mark(r, 'info', col(X.sect, 10000).filter(i => i.text.includes(flight)));
        prevMin = bm;
        lastArr = arr;
      }
      if (release) {
        const rm = +release.slice(0, 2) * 60 + +release.slice(3);
        const p2 = plus + (rm < prevMin ? 1 : 0);
        const co = {
          section: 'published', ...dayRow(day), duty: 'C/O', arr: lastArr, end: `${release}${p2 ? `+${p2}` : ''}`,
          notes: [hrs(flightTime) && `[Block: ${hrs(flightTime)}]`, hrs(dutyTime) && `[Duty: ${hrs(dutyTime)}]`, hrs(tafb) && `[TAFB: ${hrs(tafb)}]`, hrs(rest) && `[Rest: ${hrs(rest)}]`].filter(Boolean),
        };
        rows.push(co);
        mark(co, 'co', col(X.release, X.release + 18));
      }
    }
  }
  const p = `${per[1].padStart(2, '0')}${per[2]}${per[3].slice(2)} - ${per[4].padStart(2, '0')}${per[5]}${per[6].slice(2)}`;
  const out = rows.map(r => outputRow({ ...r, info: r.notes.join(' ') }, 'L'));
  return { format: 'allegiant-roster', period: p, notices: [], recognized: out.length > 0, published: out, planned: [], _trace: trace, _rows: rows };
}

const isMonthlyOverview = (page) => page.items.some(i => i.text === 'MONTHLY OVERVIEW') && page.items.some(i => i.text === 'Duty Description');

/**
 * "MONTHLY OVERVIEW" (KLM Cityhopper cockpit; "Period: From 01-12-2024 to 31-12-2024"), lines of a day in any order:
 *   Day | Duty | C/I or Dep | Dep Stat | Arr Stat | AC Reg | C/O or Arr | Flight hrs | FLD Time | Cor FLDT | Daily Allow | Duty Description
 *   6 | C/I - C/O | 04:45 |     |     |     | 11:15 |       | 06:30 | 06:30
 *   6 | HV6143    | 05:45 | AMS | ALC |     | 09:25
 *   6 | KL9936    | 09:48 | ALC | CDT | EZC | 10:45 | 00:57 |       |       | € 93,77 | Stop at CDT for 22:25h.
 *   12 | OT       |                                                               | Office Duty Training
 * No time zone is printed (times taken as local: office days 08:00 - 16:00). Rows of a day: its C/I, its activities (a flight:
 * dep / arr, registration, "[Block: 00:57]", "[EUR: 93,77]", the description; a code "[OT: Office Duty Training]"), its C/O
 * ("[Duty: 06:30]").
 */
function parseMonthlyOverview(pages) {
  const trace = startTrace();
  const rows = [];
  const all = pages.flatMap(p => p.items.map(i => i.text)).join(' ');
  const per = /Period: From (\d{2})-(\d{2})-(\d{4}) to (\d{2})-(\d{2})-(\d{4})/.exec(all);
  if (!per) return { format: 'monthly-overview', period: null, notices: [], recognized: false, published: [], planned: [], _trace: trace, _rows: [] };
  const dayRow = (t) => { const d = new Date(t); return { date: `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${String(d.getUTCFullYear() % 100).padStart(2, '0')}`, day: WEEKDAYS[d.getUTCDay()] }; };
  const TIME = /^\d{1,2}:\d{2}$/;
  const cal = { y: +per[3], m: +per[2] - 1, last: 0 };
  let day = null, group = null;
  const flush = () => {
    if (!group) return;
    rows.push(...group.ci, ...group.acts, ...group.co);
    group = null;
  };
  for (const page of pages) {
    const desc = page.items.find(i => i.text === 'Duty Description');
    if (!desc) continue;
    const near = page.items.filter(i => Math.abs(i.y - desc.y) <= 8);
    const hx = (t) => near.filter(i => i.text === t).sort((a, b) => a.x - b.x)[0]?.x;
    const cols = [['day', hx('Day')], ['duty', hx('Duty')], ['ci', hx('C/I or')], ['dep', hx('Dep') > (hx('C/I or') ?? 0) + 10 ? hx('Dep') : near.find(i => i.text === 'Dep' && i.x > hx('C/I or') + 10)?.x],
      ['arr', near.find(i => i.text === 'Arr' && i.x < (hx('AC') ?? 0))?.x], ['reg', hx('AC')], ['co', hx('C/O or')], ['block', hx('Flight')], ['fld', hx('FLD')],
      ['cor', hx('Cor')], ['allow', hx('Daily')], ['desc', desc.x]].filter(([, x]) => x != null).map(([name, x]) => ({ name, x })).sort((a, b) => a.x - b.x);
    // (the day, right aligned, ends a few points left of Duty)
    const colOf = (x) => [...cols].reverse().find(c => x >= c.x - 4)?.name || cols[0].name;
    for (const line of toLines(page.items.filter(i => i.y > desc.y + 6))) {
      const cell = {};
      for (const it of line.items) (cell[colOf(it.x)] ||= []).push(it);
      const get = (c) => (cell[c] || []).map(i => i.text).join(' ').trim();
      if (/^TOTALS:/.test(line.items.map(i => i.text).join(' '))) { flush(); break; }
      if (!/^\d{1,2}$/.test(get('day'))) continue;
      const n = +get('day');
      if (n !== cal.last) {
        flush();
        if (n < cal.last) { cal.m += 1; if (cal.m > 11) { cal.m = 0; cal.y += 1; } }
        cal.last = n;
        day = Date.UTC(cal.y, cal.m, n);
      }
      group ??= { ci: [], acts: [], co: [] };
      const duty = get('duty');
      const eur = /€\s*([\d.,]+)/.exec(get('allow'))?.[1];
      if (duty === 'C/I - C/O') {
        if (TIME.test(get('ci'))) { const r = { section: 'published', ...dayRow(day), duty: 'C/I', begin: get('ci'), notes: [] }; group.ci.push(r); mark(r, 'ci', cell.ci); }
        if (TIME.test(get('co'))) {
          const r = { section: 'published', ...dayRow(day), duty: 'C/O', end: `${get('co')}${TIME.test(get('ci')) && get('co') < get('ci') ? '+1' : ''}`, notes: [TIME.test(get('fld')) && /[1-9]/.test(get('fld')) && `[Duty: ${get('fld')}]`].filter(Boolean) };
          group.co.push(r);
          mark(r, 'co', cell.co);
        }
        continue;
      }
      if (!duty) continue;
      const flight = Boolean(get('dep'));
      const begin = TIME.test(get('ci')) ? get('ci') : '', end = TIME.test(get('co')) ? get('co') : '';
      const r = {
        section: 'published', ...dayRow(day), duty, dep: get('dep'), arr: get('arr'), registration: get('reg'), begin, end: end && `${end}${begin && end < begin ? '+1' : ''}`,
        notes: [TIME.test(get('block')) && /[1-9]/.test(get('block')) && `[Block: ${get('block')}]`, eur && `[EUR: ${eur}]`,
          get('desc') && (flight ? get('desc') : `[${duty}: ${get('desc')}]`)].filter(Boolean),
      };
      group.acts.push(r);
      for (const [f, c] of [['date', 'day'], ['duty', 'duty'], ['dep', 'dep'], ['arr', 'arr'], ['registration', 'reg'], ['begin', 'ci'], ['end', 'co'], ['info', 'block'], ['info', 'allow'], ['info', 'desc']]) mark(r, f, cell[c]);
    }
  }
  flush();
  // a C/I at its day's first departure station, a C/O at the last arrival
  let ciRow = null;
  for (const r of rows) {
    if (r.duty === 'C/I') ciRow = r;
    else if (r.duty === 'C/O') { const legs = rows.slice(rows.indexOf(ciRow) + 1, rows.indexOf(r)).filter(x => x.dep); if (ciRow && legs.length) ciRow.dep = legs[0].dep; if (legs.length) r.arr = legs.at(-1).arr; ciRow = null; }
  }
  const fmt = (d, m, y) => `${d}${MONTHS[+m - 1]}${y.slice(2)}`;
  const out = rows.map(r => outputRow({ ...r, info: r.notes.join(' ') }, 'L'));
  return { format: 'monthly-overview', period: `${fmt(per[1], per[2], per[3])} - ${fmt(per[4], per[5], per[6])}`, notices: [], recognized: out.length > 0, published: out, planned: [], _trace: trace, _rows: rows };
}

const isFlightDatesTable = (page) => ['Flt Dates', 'Dep LC', 'Arr LC', 'Flt No'].every(t => page.items.some(i => i.text === t));

/**
 * A flight list "Flt Dates | Dep LC | Arr LC | Flt No | From | To | Tail | Block | Prg No" (the date on a day's first line,
 * latest first): a row per flight as printed (local times, "+1" when it lands the next day; registration = Tail,
 * "[Block: 02:49]").
 */
function parseFlightDatesTable(pages) {
  const trace = startTrace();
  const rows = [];
  const dayRow = (t) => { const d = new Date(t); return { date: `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${String(d.getUTCFullYear() % 100).padStart(2, '0')}`, day: WEEKDAYS[d.getUTCDay()] }; };
  const TIME = /^\d{2}:\d{2}$/;
  let day = null, first = null, last = null, cols = null;
  for (const page of pages) {
    // (the next pages go on without the header)
    const head = page.items.find(i => i.text === 'Flt Dates');
    if (head) cols = page.items.filter(i => Math.abs(i.y - head.y) < 3).map(i => ({ name: i.text, x: i.x })).sort((a, b) => a.x - b.x);
    if (!cols) continue;
    const colOf = (x) => cols.reduce((a, c) => (Math.abs(c.x - x) < Math.abs(a.x - x) ? c : a)).name;
    for (const line of toLines(page.items.filter(i => i.y > (head ? head.y + 4 : 0)))) {
      if (/^TOTAL/.test(line.items[0]?.text || '')) break;
      const cell = {};
      for (const it of line.items) (cell[colOf(it.x)] ||= []).push(it);
      const get = (c) => (cell[c] || []).map(i => i.text).join(' ').trim();
      const d = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(get('Flt Dates'));
      if (d) day = Date.UTC(+d[3], +d[2] - 1, +d[1]);
      if (day == null || !get('Flt No') || !TIME.test(get('Dep LC'))) continue;
      first = first == null ? day : Math.min(first, day);
      last = last == null ? day : Math.max(last, day);
      const dep = get('Dep LC'), arr = get('Arr LC');
      const r = {
        section: 'published', ...dayRow(day), duty: get('Flt No'), dep: get('From'), arr: get('To'), begin: dep, end: TIME.test(arr) ? `${arr}${arr < dep ? '+1' : ''}` : '',
        registration: get('Tail'), notes: [TIME.test(get('Block')) && /[1-9]/.test(get('Block')) && `[Block: ${get('Block')}]`].filter(Boolean),
      };
      rows.push(r);
      for (const [f, c] of [['date', 'Flt Dates'], ['duty', 'Flt No'], ['dep', 'From'], ['arr', 'To'], ['begin', 'Dep LC'], ['end', 'Arr LC'], ['registration', 'Tail'], ['info', 'Block']]) mark(r, f, cell[c]);
    }
  }
  const fmt = (t) => { const x = new Date(t); return `${String(x.getUTCDate()).padStart(2, '0')}${MONTHS[x.getUTCMonth()]}${String(x.getUTCFullYear() % 100).padStart(2, '0')}`; };
  const out = rows.map(r => outputRow({ ...r, info: r.notes.join(' ') }, 'L'));
  return { format: 'flight-dates', period: first != null ? `${fmt(first)} - ${fmt(last)}` : null, notices: [], recognized: out.length > 0, published: out, planned: [], _trace: trace, _rows: rows };
}

const isAirsideExport = (page) => page.items.some(i => i.text === 'Airside') && page.items.some(i => i.text === 'Export') && page.items.some(i => i.text === 'Activity') && page.items.some(i => i.text === 'STD');

/**
 * "Airside Roster Export" (SAS), a line per activity:
 *   Day | Date | Duty | Meal | Activity | C/I | From | STD | STA | To | C/O | Stop time
 *   Wed | 05FEB25 |   |    | checkin   |     | 17:40 | 17:40
 *   Wed | 05FEB25 | P |    | SK1516    | LHR | 18:40 | 21:35 | CPH | 10:55
 *   Wed | 05FEB25 |   |    | checkout / NightStop 21:47 - 08:30 / F 00:00 - 23:59 / R7 13:00 - 17:00
 * Local times (LHR 18:40 -> CPH 21:35 is 1:55 only so). Rows: checkin a C/I row, checkout a C/O row (at the last arrival),
 * NightStop a hotel row (H, the station, "+1" when it ends the next day), a flight a row (dc = Duty "P", "[Meal: VO]",
 * "[Stop: 10:55]"), another code a row with its times.
 */
function parseAirsideExport(pages) {
  const trace = startTrace();
  const rows = [];
  const dayRow = (t) => { const d = new Date(t); return { date: `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${String(d.getUTCFullYear() % 100).padStart(2, '0')}`, day: WEEKDAYS[d.getUTCDay()] }; };
  const TIME = /^\d{2}:\d{2}$/;
  let cols = null, lastArr = '', first = null, last = null;
  for (const page of pages) {
    const act = page.items.find(i => i.text === 'Activity');
    if (act) {
      const head = page.items.filter(i => Math.abs(i.y - act.y) < 3).sort((a, b) => a.x - b.x);
      // "C/" "I", "C/" "O", "Stop" "time": one header each
      cols = [];
      for (const it of head) {
        if (/^(I|O|time)$/.test(it.text) && cols.length) { cols.at(-1).name += it.text === 'time' ? ' time' : it.text; continue; }
        cols.push({ name: it.text, x: it.x });
      }
    }
    if (!cols) continue;
    const colOf = (x) => [...cols].reverse().find(c => x >= c.x - 6)?.name || cols[0].name;
    for (const line of toLines(page.items.filter(i => i.y > (act ? act.y + 4 : 0)))) {
      const cell = {};
      for (const it of line.items) (cell[colOf(it.x)] ||= []).push(it);
      const get = (c) => (cell[c] || []).map(i => i.text).join(' ').trim();
      const d = /^(\d{2})([A-Z]{3})(\d{2})$/.exec(get('Date'));
      if (!d || monthIndex(d[2]) < 0 || !get('Activity')) continue;
      const day = Date.UTC(2000 + +d[3], monthIndex(d[2]), +d[1]);
      first ??= day; last = day;
      const a = get('Activity'), std = get('STD'), sta = get('STA');
      const end = TIME.test(sta) ? `${sta}${TIME.test(std) && sta < std ? '+1' : ''}` : '';
      const base = { section: 'published', ...dayRow(day), notes: [] };
      let r;
      if (a === 'checkin') r = { ...base, duty: 'C/I', begin: std };
      else if (a === 'checkout') r = { ...base, duty: 'C/O', arr: lastArr, end: std };
      else if (a === 'NightStop') r = { ...base, duty: 'H', dep: lastArr, begin: std, end };
      else {
        const flight = Boolean(get('From'));
        const stop = get('Stop time');
        r = {
          ...base, dc: get('Duty'), duty: a, dep: get('From'), arr: get('To'), begin: TIME.test(std) ? std : '', end,
          notes: [get('Meal') && `[Meal: ${get('Meal')}]`, flight && TIME.test(stop) && /[1-9]/.test(stop) && `[Stop: ${stop}]`].filter(Boolean),
        };
        if (flight) lastArr = get('To');
      }
      rows.push(r);
      for (const [f, c] of [['date', 'Date'], ['dc', 'Duty'], ['duty', 'Activity'], ['dep', 'From'], ['arr', 'To'], ['begin', 'STD'], ['end', 'STA'], ['info', 'Meal']]) mark(r, f, cell[c]);
    }
  }
  // a C/I at its duty's first departure
  rows.forEach((r, k) => { if (r.duty === 'C/I') r.dep = rows.slice(k + 1).find(x => x.dep && x.duty !== 'H')?.dep || ''; });
  const fmt = (t) => { const x = new Date(t); return `${String(x.getUTCDate()).padStart(2, '0')}${MONTHS[x.getUTCMonth()]}${String(x.getUTCFullYear() % 100).padStart(2, '0')}`; };
  const out = rows.map(r => outputRow({ ...r, info: r.notes.join(' ') }, 'L'));
  return { format: 'airside-export', period: first != null ? `${fmt(first)} - ${fmt(last)}` : null, notices: [], recognized: out.length > 0, published: out, planned: [], _trace: trace, _rows: rows };
}

const isCrewMemberRoster = (page) => page.items.some(i => i.text === 'Crew Member Roster') && page.items.some(i => i.text === 'Flight No') && page.items.some(i => i.text === 'Daily Lim.');

/**
 * "Crew Member Roster" ("From: 2024-01-01 Until: 2024-02-29"), lines of a day under
 *   Date | Flight No | STD | DEP | ARR | STA | Type | DP | FDP | Block TM | Daily Lim.
 *   2024-02-13 Tu | C/I | 09:00 | EMA                                 (a code, C/I, C/O printed left of Flight No)
 *                 |     | 09:00 | EMA | EMA | 17:00 | TRN | 08:00     (an activity: its Type when it has no flight)
 *                 | C/O | 17:00 | EMA
 *   2024-01-01 Mo | OFF(3)
 * Rows: C/I, the activity (dep / arr, begin / end, "[Duty: 08:00] [FDP: ..] [Block: ..]"), C/O; a code a row of its own.
 * No time zone is printed (taken as local).
 */
function parseCrewMemberRoster(pages) {
  const trace = startTrace();
  const rows = [];
  const all = pages.flatMap(p => p.items.map(i => i.text)).join(' ');
  const per = /From: (\d{4})-(\d{2})-(\d{2}) Until: (\d{4})-(\d{2})-(\d{2})/.exec(all);
  const dayRow = (t) => { const d = new Date(t); return { date: `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${String(d.getUTCFullYear() % 100).padStart(2, '0')}`, day: WEEKDAYS[d.getUTCDay()] }; };
  const TIME = /^\d{2}:\d{2}$/;
  const hrs = (t) => (/^\d{1,3}:\d{2}$/.test(t) && /[1-9]/.test(t) ? t.padStart(5, '0') : '');
  let day = null, lastArr = '';
  for (const page of pages) {
    const head = page.items.find(i => i.text === 'Flight No');
    if (!head) continue;
    const cols = page.items.filter(i => Math.abs(i.y - head.y) < 3).map(i => ({ name: i.text, x: i.x })).sort((a, b) => a.x - b.x);
    const fx = cols.find(c => c.name === 'Flight No').x;
    // (a date, a code, C/I and C/O stand left of Flight No)
    const colOf = (x) => (x < fx - 8 ? 'Date' : [...cols].reverse().find(c => x >= c.x - 6)?.name || 'Date');
    for (const line of toLines(page.items.filter(i => i.y > head.y + 4))) {
      const cell = {};
      for (const it of line.items) (cell[colOf(it.x)] ||= []).push(it);
      const get = (c) => (cell[c] || []).map(i => i.text).join(' ').trim();
      const d = /^(\d{4})-(\d{2})-(\d{2}) [A-Z][a-z]\s*(.*)$/.exec(get('Date'));
      if (d) day = Date.UTC(+d[1], +d[2] - 1, +d[3]);
      if (day == null) continue;
      const code = (d ? d[4] : get('Date')).trim();
      const base = { section: 'published', ...dayRow(day), notes: [] };
      if (code === 'C/I' || code === 'C/O') {
        const r = code === 'C/I' ? { ...base, duty: 'C/I', dep: get('DEP'), begin: get('STD') } : { ...base, duty: 'C/O', arr: lastArr || get('DEP'), end: get('STD') };
        rows.push(r);
        mark(r, code === 'C/I' ? 'ci' : 'co', cell.STD);
        continue;
      }
      const name = get('Flight No') || code || get('Type');
      if (!name) continue;
      const std = get('STD'), sta = get('STA');
      const r = {
        ...base, duty: name, dep: get('DEP'), arr: get('ARR'), begin: TIME.test(std) ? std : '', end: TIME.test(sta) ? `${sta}${TIME.test(std) && sta < std ? '+1' : ''}` : '',
        ac: get('Flight No') ? get('Type') : '',
        notes: [['Duty', 'DP'], ['FDP', 'FDP'], ['Block', 'Block TM']].map(([k, c]) => hrs(get(c)) && `[${k}: ${hrs(get(c))}]`).filter(Boolean),
      };
      rows.push(r);
      for (const [f, c] of [['date', 'Date'], ['duty', get('Flight No') ? 'Flight No' : code ? 'Date' : 'Type'], ['dep', 'DEP'], ['arr', 'ARR'], ['begin', 'STD'], ['end', 'STA'], ['info', 'DP']]) mark(r, f, cell[c]);
      if (r.arr) lastArr = r.arr;
    }
  }
  const p = per && `${per[3]}${MONTHS[+per[2] - 1]}${per[1].slice(2)} - ${per[6]}${MONTHS[+per[5] - 1]}${per[4].slice(2)}`;
  const out = rows.map(r => outputRow({ ...r, info: r.notes.join(' ') }, 'L'));
  return { format: 'crew-member-roster', period: p || null, notices: [], recognized: out.length > 0, published: out, planned: [], _trace: trace, _rows: rows };
}

const isDutyTimesSchedule = (page) => page.items.some(i => /^Schedule : \d{2}[A-Z]{3}\d{4}$/.test(i.text)) && page.items.some(i => i.text === 'Duty Times') && page.items.some(i => i.text === 'Description');

/**
 * "Schedule : 01MAR2024 - 31MAR2024" (Sky Express), a duty's lines under Duty Times (Report | Release) | Description | Block Hrs:
 *   FRI 01MAR 14:05 - 01MAR 16:39 (Z) | F/O GQ344 ATH (01MAR 15:15) Z - ATH (01MAR 16:24) Z | 1.09 B
 *   FRI 01MAR 16:05 - 01MAR 18:39 (L) | (SX-TNO)                                   (the registration)
 *                                      | (P)(CPT)Andreas KOUMERTAS (SCM)Eirini ...    (the crew, going on the next line)
 *   SAT 02MAR 10:00 - 02MAR 19:00 (Z) | F/O R/S (STBY A) at ATH  /  F/O Day Off (OFF)
 * A duty's release may come lines later (with its last flight). Rows: a duty with flights a C/I row (report, "14:05 Z / 16:05 L"),
 * a row per flight (UTC, registration, crew "[CPT - Andreas KOUMERTAS][SCM - Eirini VITALI]", "[Block: 01:09]"), a C/O row
 * (release); a standby (R/S, "[STBY A]", at its station) or a day off (OFF) one row from report to release.
 */
function parseDutyTimesSchedule(pages) {
  const trace = startTrace();
  const rows = [];
  // the period: "Schedule : 01MAR2024" | "-" | "31MAR2024"
  const start = pages.flatMap(p => p.items).find(i => /^Schedule : \d{2}[A-Z]{3}\d{4}$/.test(i.text));
  const endItem = start && pages.flatMap(p => p.items).find(i => Math.abs(i.y - start.y) < 3 && i.x > start.x && /^\d{2}[A-Z]{3}\d{4}$/.test(i.text));
  const per = start && /(\d{2})([A-Z]{3})(\d{4}) - (\d{2})([A-Z]{3})(\d{4})/.exec(`${start.text.slice(11)} - ${endItem?.text || start.text.slice(11)}`);
  if (!per) return { format: 'duty-times-schedule', period: null, notices: [], recognized: false, published: [], planned: [], _trace: trace, _rows: [] };
  const dayRow = (t) => { const d = new Date(t); return { date: `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${String(d.getUTCFullYear() % 100).padStart(2, '0')}`, day: WEEKDAYS[d.getUTCDay()] }; };
  const year = +per[3], m0 = monthIndex(per[2]);
  const dateOf = (dd, mon) => { const m = monthIndex(mon); return Date.UTC(year + (m < m0 - 6 ? 1 : 0), m, +dd); };
  const zl = (z, l) => (z ? `${formatTime(z, 'Z')}${l ? ` / ${formatTime(l, 'L')}` : ''}` : '');
  const days = (a, b) => Math.round((b - a) / 86400000);
  const plus = (t, n) => (t && n > 0 ? t.replace(/ Z/, ` Z +${n}`).replace(/ L$/, ` L +${n}`) : t);
  const FLIGHT = /^([A-Z0-9]{2}\d{1,4}[A-Z]?) ([A-Z]{3}) \((\d{2})([A-Z]{3}) (\d{2}:\d{2})\) Z - ([A-Z]{3}) \((\d{2})([A-Z]{3}) (\d{2}:\d{2})\) Z$/;
  let duty = null, lastLeg = null, crewOpen = false;
  const emit = () => {
    if (!duty) return;
    const d = duty;
    duty = null;
    const relDays = d.relDate != null ? days(d.date, d.relDate) : 0;
    if (!d.legs.length) {
      if (!d.act) return;
      const r = { section: 'published', ...dayRow(d.date), ...d.act, begin: zl(d.repZ, d.repL), end: plus(zl(d.relZ, d.relL), relDays) };
      rows.push(r);
      mark(r, 'begin', d.repItems);
      return;
    }
    const ci = { section: 'published', ...dayRow(d.date), duty: 'C/I', dep: d.legs[0].dep, begin: zl(d.repZ, d.repL), notes: [] };
    rows.push(ci);
    mark(ci, 'ci', d.repItems);
    rows.push(...d.legs);
    if (d.relZ) {
      const co = { section: 'published', ...dayRow(d.date), duty: 'C/O', arr: d.legs.at(-1).arr, end: plus(zl(d.relZ, d.relL), relDays), notes: [] };
      rows.push(co);
      mark(co, 'co', d.relItems);
    }
  };
  for (const page of pages) {
    for (const line of toLines(page.items, 2)) {
      const L = [...line.items].sort((a, b) => a.x - b.x);
      const txt = (f) => L.filter(f).map(i => i.text).join(' ').trim();
      const zone = L.find(i => /^\((Z|L)\)$/.test(i.text))?.text[1];
      const rep = /^[A-Z]{3} (\d{2})([A-Z]{3}) (\d{2}:\d{2})$/.exec(txt(i => i.x < 100));
      const rel = /(\d{2})([A-Z]{3}) (\d{2}:\d{2})$/.exec(txt(i => i.x >= 100 && i.x < 165));
      const desc = txt(i => i.x >= 210 && i.x < 550);
      const blk = L.find(i => i.x >= 550 && /^\d*\.\d{2}$/.test(i.text))?.text;
      if (rep && zone === 'Z') { emit(); duty = { date: dateOf(rep[1], rep[2]), repZ: rep[3], repItems: L.filter(i => i.x < 100), legs: [], act: null }; }
      else if (rep && zone === 'L' && duty) duty.repL = rep[3];
      if (rel && duty && zone === 'Z') { duty.relZ = rel[3]; duty.relDate = dateOf(rel[1], rel[2]); duty.relItems = L.filter(i => i.x >= 100 && i.x < 165); }
      else if (rel && duty && zone === 'L') duty.relL = rel[3];
      const f = FLIGHT.exec(desc);
      if (f && duty) {
        const [, flight, dep, d1, m1, t1, arr, d2, m2, t2] = f;
        const a = dateOf(d1, m1), b = dateOf(d2, m2);
        const bl = blk && /^(\d*)\.(\d{2})$/.exec(blk);
        lastLeg = {
          section: 'published', ...dayRow(a), duty: flight, dep, arr, begin: formatTime(t1, 'Z'), end: plus(formatTime(t2, 'Z'), days(a, b)), registration: '', crew: '',
          notes: [bl && /[1-9]/.test(blk) && `[Block: ${(bl[1] || '0').padStart(2, '0')}:${bl[2]}]`].filter(Boolean),
        };
        duty.legs.push(lastLeg);
        mark(lastLeg, 'duty', L.filter(i => i.text === flight));
        crewOpen = false;
        continue;
      }
      const reg = /^\(([A-Z0-9]{1,2}-[A-Z0-9]{2,})\)$/.exec(desc);
      if (reg && lastLeg) { lastLeg.registration = reg[1]; mark(lastLeg, 'registration', L.filter(i => i.x >= 210)); continue; }
      const crew = [...desc.matchAll(/(?:\(P\))?\(([A-Z]{2,4})\)([^(]+)/g)];
      if (crew.length && lastLeg && /^\(/.test(desc)) {
        lastLeg.crewList = crew.map(c => [c[1], c[2].trim()]);
        lastLeg.crew = lastLeg.crewList.map(([r, n]) => `[${r} - ${n}]`).join('');
        mark(lastLeg, 'crew', L.filter(i => i.x >= 210));
        crewOpen = true;
        continue;
      }
      if (crewOpen && lastLeg?.crewList && /^[A-Z][A-Za-z' .-]+$/.test(desc) && !zone) {
        lastLeg.crewList.at(-1)[1] += ` ${desc}`;
        lastLeg.crew = lastLeg.crewList.map(([r, n]) => `[${r} - ${n}]`).join('');
        mark(lastLeg, 'crew', L.filter(i => i.x >= 210));
        continue;
      }
      crewOpen = false;
      const sby = /^(\S+) \((.+?)\) at ([A-Z]{3})$/.exec(desc);
      const off = /^(.+?) \((\w+)\)$/.exec(desc);
      if (duty && zone === 'Z' && sby) duty.act = { duty: sby[1], dep: sby[3], notes: [`[${sby[2]}]`] };
      else if (duty && zone === 'Z' && off && !f) duty.act = { duty: off[2], notes: [`[${off[2]}: ${off[1]}]`] };
    }
  }
  emit();
  const p = `${per[1]}${MONTHS[monthIndex(per[2])]}${per[3].slice(2)} - ${per[4]}${MONTHS[monthIndex(per[5])]}${per[6].slice(2)}`;
  const out = rows.map(({ crewList, ...r }) => outputRow({ ...r, info: r.notes.join(' ') }, 'Z'));
  return { format: 'duty-times-schedule', period: p, notices: [], recognized: out.length > 0, published: out, planned: [], _trace: trace, _rows: rows };
}

const isFlightsByCrewMember = (page) => page.items.some(i => i.text === 'Flights by Crew Member') && page.items.some(i => i.text === 'ADEP') && page.items.some(i => i.text === 'ADES');

/**
 * "Flights by Crew Member" (a period's flights, "01-01-2024 - 31-12-2024"; totals by position above the list), a line per flight:
 *   Date | Aircraft Type | Reg. | Flight No. | Trip number | OFF | ADEP | ADES | ON | Block | Flight time | Night | LND | Function | COM | Distance [NM]
 *   07-02-2024 | PC12 | 9H-OTI | 9HOTI | A20508 | 09:15 | ZRH | MLA | 13:00 | 03:45 | 03:24 | 00:00 | 1 | <CPT> | Trifyllis | 744
 * Times taken as UTC (no zone printed). A row per flight (ac, registration, crew the commander "[COM - Trifyllis]", info
 * "[Trip: A20508] [Block: 03:45] [Flight: 03:24] [Night: ..] [Landing Day/Night: 1] [Function: CPT] [NM: 744]").
 */
function parseFlightsByCrewMember(pages) {
  const trace = startTrace();
  const rows = [];
  const dayRow = (t) => { const d = new Date(t); return { date: `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${String(d.getUTCFullYear() % 100).padStart(2, '0')}`, day: WEEKDAYS[d.getUTCDay()] }; };
  const TIME = /^\d{2}:\d{2}$/;
  const dur = (t) => (TIME.test(t) && /[1-9]/.test(t) ? t : '');
  const all = pages.flatMap(p => p.items.map(i => i.text)).join(' ');
  const per = /(\d{2})-(\d{2})-(\d{4}) - (\d{2})-(\d{2})-(\d{4})/.exec(all);
  let cols = null;
  for (const page of pages) {
    const adep = page.items.find(i => i.text === 'ADEP');
    if (adep) {
      // the header's words over three lines ("Aircraft" / "Type", "Trip" / "number", "Flight" / "time"), named by the middle line's
      const line = page.items.filter(i => Math.abs(i.y - adep.y) < 3);
      const near = (t, dy) => page.items.find(i => i.text === t && i.y - adep.y > -10 && i.y - adep.y < 10 && (dy == null || Math.sign(i.y - adep.y) === dy));
      cols = [...line.map(i => ({ name: i.text, x: i.x })), ...['Type', 'number', 'Flight', '[NM]'].map(t => near(t)).filter(Boolean).map(i => ({ name: i.text === 'Flight' ? 'Flight time' : i.text, x: i.x }))]
        .filter(c => c.name !== 'Aircraft' && c.name !== 'Trip').sort((a, b) => a.x - b.x);
    }
    if (!cols) continue;
    const colOf = (x) => cols.reduce((a, c) => (Math.abs(c.x - x) < Math.abs(a.x - x) ? c : a)).name;
    for (const line of toLines(page.items.filter(i => i.y > (adep ? adep.y + 8 : 0)))) {
      const cell = {};
      for (const it of line.items) (cell[colOf(it.x)] ||= []).push(it);
      const get = (c) => (cell[c] || []).map(i => i.text).join(' ').trim();
      const d = /^(\d{2})-(\d{2})-(\d{4})$/.exec(get('Date'));
      if (!d || !TIME.test(get('OFF'))) continue;
      const day = Date.UTC(+d[3], +d[2] - 1, +d[1]);
      const off = get('OFF'), on = get('ON');
      const fn = get('LND Function').replace(/^\d+\s*/, '').replace(/[<>]/g, '');
      const lnd = /^(\d+)/.exec(get('LND Function'))?.[1];
      const r = {
        section: 'published', ...dayRow(day), duty: get('Flight No.'), dep: get('ADEP'), arr: get('ADES'), begin: off, end: TIME.test(on) ? `${on}${on < off ? '+1' : ''}` : '',
        ac: get('Type'), registration: get('Reg.'), crew: get('COM') && `[COM - ${get('COM')}]`,
        notes: [get('number') && `[Trip: ${get('number')}]`, dur(get('Block')) && `[Block: ${get('Block')}]`, dur(get('Flight time')) && `[Flight: ${get('Flight time')}]`,
          dur(get('Night')) && `[Night: ${get('Night')}]`, lnd && +lnd && `[Landing Day/Night: ${+lnd}]`, fn && `[Function: ${fn}]`, /^[1-9]\d*$/.test(get('[NM]')) && `[NM: ${get('[NM]')}]`].filter(Boolean),
      };
      rows.push(r);
      for (const [f, c] of [['date', 'Date'], ['duty', 'Flight No.'], ['dep', 'ADEP'], ['arr', 'ADES'], ['begin', 'OFF'], ['end', 'ON'], ['ac', 'Type'], ['registration', 'Reg.'], ['crew', 'COM'], ['info', 'Block']]) mark(r, f, cell[c]);
    }
  }
  const p = per && `${per[1]}${MONTHS[+per[2] - 1]}${per[3].slice(2)} - ${per[4]}${MONTHS[+per[5] - 1]}${per[6].slice(2)}`;
  const out = rows.map(r => outputRow({ ...r, info: r.notes.join(' ') }, 'Z'));
  return { format: 'flights-by-crew-member', period: p || null, notices: [], recognized: out.length > 0, published: out, planned: [], _trace: trace, _rows: rows };
}

const isCockpitBriefing = (page) => page.items.some(i => /^Cockpit Briefing for /.test(i.text)) && page.items.some(i => i.text === 'Flight Info') && page.items.some(i => i.text === 'Daily Summary');

/**
 * KLM Cityhopper "Cockpit Briefing for NAME" ("printed at 05Jan25-1727", "All times UTC"):
 *   Flight Info:   Date | Flt | Callsign | Dep "AMS 1830" | Arr "LCY 1935" | Blk | Grd | Pax | Payload | Eq "E90/PHEZF" | Prev | Next ...
 *   Daily Summary: Date | C/I | C/O | L/O | Blk | Grd | Hotel | Phone | Pickup
 *   Crew Info:     Date | Flight | CP | FO | SE | ST  ("59847 WETERINGS, STEFAN")
 * Rows: a day's C/I, its flights (ac / registration from Eq, "[Block: 01:05]", crew "[CP - 59847 - WETERINGS, STEFAN]"), a standby
 * ("SBY_C" 0900 - 1725) a row, the day's C/O.
 */
function parseCockpitBriefing(pages) {
  const trace = startTrace();
  const rows = [];
  const items = pages.flatMap(p => p.items);
  const printed = /printed at (\d{2})([A-Z][a-z]{2})(\d{2})-/.exec(items.map(i => i.text).join(' '));
  const year = printed ? 2000 + +printed[3] : new Date().getUTCFullYear();
  const dayRow = (t) => { const d = new Date(t); return { date: `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${String(d.getUTCFullYear() % 100).padStart(2, '0')}`, day: WEEKDAYS[d.getUTCDay()] }; };
  const dateOf = (t) => { const m = /^(\d{2})([A-Z][a-z]{2})$/.exec(t || ''); return m && MONTHS.includes(m[2]) ? Date.UTC(year, MONTHS.indexOf(m[2]), +m[1]) : null; };
  const section = (title, until) => {
    const t = items.find(i => i.text === title);
    const end = until.map(u => items.find(i => i.text === u)?.y).filter(y => y != null && y > (t?.y ?? 0));
    return t ? toLines(items.filter(i => i.y > t.y + 4 && i.y < Math.min(Infinity, ...end))) : [];
  };
  const table = (lines) => {
    const head = lines[0]?.items.map(i => ({ name: i.text, x: i.x })).sort((a, b) => a.x - b.x) || [];
    const colOf = (x) => [...head].reverse().find(c => x >= c.x - 6)?.name || head[0]?.name;
    return lines.slice(1).map(l => { const cell = {}; for (const it of l.items) (cell[colOf(it.x)] ||= []).push(it); return { cell, get: (c) => (cell[c] || []).map(i => i.text).join(' ').trim() }; });
  };
  const flights = table(section('Flight Info', ['Daily Summary']));
  const days = table(section('Daily Summary', ['Crew Info', 'ADDITIONAL INFORMATION']));
  const crew = table(section('Crew Info', ['ADDITIONAL INFORMATION']));
  const crewOf = (flt) => {
    const c = crew.find(r => r.get('Flight') === flt);
    const list = c ? ['CP', 'FO', 'SE', 'ST'].map(k => { const m = /^(\d+) (.+)$/.exec(c.get(k)); return m && `[${k} - ${m[1]} - ${m[2]}]`; }).filter(Boolean).join('') : '';
    // (a flight's line without names: the crew of the flight above)
    if (c && !list) return lastCrew;
    lastCrew = list || lastCrew;
    return list;
  };
  let lastCrew = '';
  const TIME = /^\d{4}$/;
  for (const d of days) {
    const t = dateOf(d.get('Date'));
    if (t == null || !TIME.test(d.get('C/I'))) continue;
    const ci = { section: 'published', ...dayRow(t), duty: 'C/I', begin: d.get('C/I'), notes: [] };
    const legs = [];
    for (const f of flights.filter(x => dateOf(x.get('Date')) === t)) {
      const dep = /^([A-Z]{3}) (\d{4})$/.exec(f.get('Dep')), arr = /^([A-Z]{3}) (\d{4})$/.exec(f.get('Arr'));
      const eq = /^(\w+)\/(\w+)$/.exec(f.get('Eq'));
      const blk = /^\d{2}:\d{2}$/.test(f.get('Blk')) && /[1-9]/.test(f.get('Blk')) ? f.get('Blk') : '';
      const r = dep
        ? { section: 'published', ...dayRow(t), duty: f.get('Flt'), dep: dep[1], arr: arr?.[1] || '', begin: dep[2], end: arr ? `${arr[2]}${arr[2] < dep[2] ? '+1' : ''}` : '', ac: eq?.[1] || '', registration: eq?.[2] || '', crew: crewOf(f.get('Flt')), notes: [blk && `[Block: ${blk}]`].filter(Boolean) }
        : { section: 'published', ...dayRow(t), duty: f.get('Flt'), begin: TIME.test(f.get('Dep')) ? f.get('Dep') : '', end: TIME.test(f.get('Arr')) ? f.get('Arr') : '', notes: [] };
      legs.push(r);
      mark(r, 'duty', f.cell.Flt);
    }
    // the C/I belongs to the flights after it (a standby before it is a row of its own)
    const k = legs.findIndex(l => l.dep && l.begin >= d.get('C/I'));
    const before = k < 0 ? legs : legs.slice(0, k), after = k < 0 ? [] : legs.slice(k);
    rows.push(...before);
    if (after.length) { ci.dep = after[0].dep; rows.push(ci, ...after); mark(ci, 'ci', d.cell['C/I']); }
    if (TIME.test(d.get('C/O')) && after.length) {
      const co = { section: 'published', ...dayRow(t), duty: 'C/O', arr: after.at(-1).arr, end: d.get('C/O'), notes: [] };
      rows.push(co);
      mark(co, 'co', d.cell['C/O']);
    }
  }
  const all = rows.map(r => r.date);
  const out = rows.map(r => outputRow({ ...r, info: r.notes.join(' ') }, 'Z'));
  const fmt = (s) => { const [d, m, y] = s.split(' '); return `${d.padStart(2, '0')}${m}${y}`; };
  return { format: 'cockpit-briefing', period: all.length ? `${fmt(all[0])} - ${fmt(all.at(-1))}` : null, notices: [], recognized: out.length > 0, published: out, planned: [], _trace: trace, _rows: rows };
}

const isArmsRoster = (page) => page.items.some(i => /^ARMS \(csRoster\)$/.test(i.text)) && page.items.some(i => i.text === 'Rept') && page.items.some(i => i.text === 'Credit');

/**
 * Qantas ARMS "Operations Roster for Bid Period" (printed "25 Jul 2024 17:24"), three columns of days side by side:
 *   Date | Duty | Detail | Rept | End | Credit   (x3)
 *   04/08 S | JX24 | AW01 | 2100 |      | 35:40        (a pattern's first day: its report)
 *   08/08 T | JX24 |      |      | 0530 |              (its last day: its end)
 *   15/07 M | AL   |      |      |      | 41:30        (leave, X off, A available ...)
 * A row per day (its code, the report / end printed that day, "[Detail: AW01] [Credit: 35:40]"), in date order. No zone is
 * printed (taken as local).
 */
function parseArmsRoster(pages) {
  const trace = startTrace();
  const rows = [];
  const items = pages.flatMap(p => p.items);
  const printed = items.map(i => /^(\d{1,2}) ([A-Z][a-z]{2}) (\d{4}) \d{2}:\d{2}$/.exec(i.text)).find(Boolean);
  const py = printed ? +printed[3] : new Date().getUTCFullYear(), pm = printed ? MONTHS.indexOf(printed[2]) : 0;
  const dayRow = (t) => { const d = new Date(t); return { date: `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${String(d.getUTCFullYear() % 100).padStart(2, '0')}`, day: WEEKDAYS[d.getUTCDay()] }; };
  const days = [];
  for (const page of pages) {
    const heads = page.items.filter(i => i.text === 'Rept');
    if (!heads.length) continue;
    const hy = heads[0].y;
    const head = page.items.filter(i => Math.abs(i.y - hy) < 3).sort((a, b) => a.x - b.x);
    // the three groups: from each "Date" to the next
    const starts = head.filter(i => i.text === 'Date').map(i => i.x);
    const groups = starts.map((x0, k) => {
      const x1 = starts[k + 1] ?? Infinity;
      return { x0, x1, cols: head.filter(i => i.x >= x0 && i.x < x1).map(i => ({ name: i.text, x: i.x })) };
    });
    for (const line of toLines(page.items.filter(i => i.y > hy + 4))) {
      for (const g of groups) {
        const its = line.items.filter(i => i.x >= g.x0 - 8 && i.x < g.x1 - 8);
        if (!its.length) continue;
        const colOf = (x) => g.cols.reduce((a, c) => (Math.abs(c.x - x) < Math.abs(a.x - x) ? c : a)).name;
        const cell = {};
        for (const it of its) (cell[colOf(it.x)] ||= []).push(it);
        const get = (c) => (cell[c] || []).map(i => i.text).join(' ').trim();
        const d = /^(\d{2})\/(\d{2})(?: [A-Z])?$/.exec(get('Date'));
        if (!d || !get('Duty')) continue;
        const m = +d[2] - 1;
        const t = Date.UTC(py + (m - pm > 6 ? -1 : pm - m > 6 ? 1 : 0), m, +d[1]);
        days.push({ t, cell, get });
      }
    }
  }
  const hm = (v) => (/^\d{4}$/.test(v) ? v : '');
  for (const { t, cell, get } of days.sort((a, b) => a.t - b.t)) {
    const credit = /^\d+:\d{2}$/.test(get('Credit')) && /[1-9]/.test(get('Credit')) ? get('Credit') : '';
    const r = {
      section: 'published', ...dayRow(t), duty: get('Duty'), begin: hm(get('Rept')), end: hm(get('End')),
      notes: [get('Detail') && `[Detail: ${get('Detail')}]`, credit && `[Credit: ${credit}]`].filter(Boolean),
    };
    rows.push(r);
    for (const [f, c] of [['date', 'Date'], ['duty', 'Duty'], ['begin', 'Rept'], ['end', 'End'], ['info', 'Detail'], ['info', 'Credit']]) mark(r, f, cell[c]);
  }
  const fmt = (t) => { const x = new Date(t); return `${String(x.getUTCDate()).padStart(2, '0')}${MONTHS[x.getUTCMonth()]}${String(x.getUTCFullYear() % 100).padStart(2, '0')}`; };
  const out = rows.map(r => outputRow({ ...r, info: r.notes.join(' ') }, 'L'));
  return { format: 'arms-roster', period: days.length ? `${fmt(days[0].t)} - ${fmt(days.at(-1).t)}` : null, notices: [], recognized: out.length > 0, published: out, planned: [], _trace: trace, _rows: rows };
}

const isBrHoursReport = (page) => page.items.some(i => /^Relatório de (Registro Individual de Horas de Vôo|Pagamento de Tripulantes)/.test(i.text));

/**
 * Brazilian crew hours reports (decimal hours "1,43" = 01:26):
 * - "Relatório de Pagamento de Tripulantes (Horas)": Data "17/11/2019 [DOM]" (a day's first line) | Prog | Função | Etapa "SSA PNZ" |
 *   Partida | Cheg. | Diário Bordo | Tipo Atividade | Horas de Voo Diu. Not. E.D. E.N. | Horas de Atividade ... | Total.
 *   A flight (Prog a number, two stations) a row (begin / end, "[Block: 01:26] [Night: 00:10]"); another activity (TREIN2, FR)
 *   a row with its times and "[Type: TREIN]".
 * - "Relatório de Registro Individual de Horas de Vôo - Mensal": a page per month ("Mês 10 Ano 2019"), Data "24/10" | Função |
 *   Frota | Aeronave | Vôo | Hotran | Diário Bordo | Simulador | Noturna | Diurna | VFR | IFR | Total: a row per flight (ac, registration,
 *   "[Flight: 01:36] [Night: ..] [IFR: ..] [VFR: ..] [Sim: ..]", the function in info); no times.
 * Times local (none printed for the zone).
 */
function parseBrHoursReport(pages) {
  const trace = startTrace();
  const rows = [];
  const dayRow = (t) => { const d = new Date(t); return { date: `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${String(d.getUTCFullYear() % 100).padStart(2, '0')}`, day: WEEKDAYS[d.getUTCDay()] }; };
  const dec = (t) => { const m = /^(\d+),(\d+)$/.exec(t || ''); if (!m) return ''; const min = Math.round(+`${m[1]}.${m[2]}` * 60); return min ? `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}` : ''; };
  const TIME = /^\d{2}:\d{2}$/;
  let day = null, first = null, last = null, cols = null;
  for (const page of pages) {
    const data = page.items.find(i => i.text === 'Data' && page.items.some(j => Math.abs(j.y - i.y) < 3 && /^(Prog|Função)$/.test(j.text)));
    if (data) {
      const line = page.items.filter(i => Math.abs(i.y - data.y) < 3);
      // the pay report's two "Diu." / "Not." ...: the first are the flight hours
      const seen = {};
      cols = line.map(i => { seen[i.text] = (seen[i.text] || 0) + 1; return { name: seen[i.text] > 1 ? `${i.text}#${seen[i.text]}` : i.text, x: i.x }; }).sort((a, b) => a.x - b.x);
    }
    if (!cols) continue;
    const mon = (() => { const h = page.items.find(i => i.text === 'Mês'); if (!h) return null; const v = page.items.filter(i => i.y > h.y + 4 && i.y < h.y + 22); const m = v.find(i => Math.abs(i.x - h.x) < 10)?.text, y = v.find(i => /^\d{4}$/.test(i.text))?.text; return m && y ? { m: +m - 1, y: +y } : null; })();
    // (the monthly report's hours stand right aligned under left aligned headers: each in the column left of it)
    const pay = cols.some(c => c.name === 'Prog');
    const colOf = (x) => (pay ? cols.reduce((a, c) => (Math.abs(c.x - x) < Math.abs(a.x - x) ? c : a)) : [...cols].reverse().find(c => x >= c.x - 6) || cols[0]).name;
    for (const l of toLines(page.items.filter(i => i.y > (data ? data.y + 4 : 0)))) {
      const cell = {};
      for (const it of l.items) (cell[colOf(it.x)] ||= []).push(it);
      const get = (c) => (cell[c] || []).map(i => i.text).join(' ').trim();
      const full = /^(\d{2})\/(\d{2})\/(\d{4})/.exec(get('Data')), short = !full && mon && /^(\d{2})\/(\d{2})$/.exec(get('Data'));
      if (full) day = Date.UTC(+full[3], +full[2] - 1, +full[1]);
      else if (short) day = Date.UTC(mon.y + (+short[2] - 1 < mon.m - 6 ? 1 : 0), +short[2] - 1, +short[1]);
      if (day == null) continue;
      const base = { section: 'published', ...dayRow(day), notes: [] };
      let r = null;
      if (cols.some(c => c.name === 'Prog')) {
        const prog = get('Prog'), etapa = get('Etapa').split(/\s+/).filter(t => /^[A-Z]{3,4}$/.test(t));
        if (!prog) continue;
        const p = get('Partida'), c = get('Cheg.');
        r = { ...base, duty: prog, dep: etapa[0] || '', arr: etapa[1] || '', begin: TIME.test(p) ? p : '', end: TIME.test(c) ? `${c}${TIME.test(p) && c < p ? '+1' : ''}` : '' };
        if (etapa.length === 2) r.notes.push(...[dec(get('Total')) && `[Block: ${dec(get('Total'))}]`, dec(get('Not.')) && `[Night: ${dec(get('Not.'))}]`].filter(Boolean));
        else if (get('Tipo Atividade')) r.notes.push(`[Type: ${get('Tipo Atividade')}]`);
      } else {
        if (!get('Vôo')) continue;
        r = {
          ...base, duty: get('Vôo'), ac: get('Frota'), registration: get('Aeronave'),
          notes: [['Flight', 'Total'], ['Night', 'Noturna'], ['IFR', 'IFR'], ['VFR', 'VFR'], ['Sim', 'Simulador']].map(([k, c]) => dec(get(c)) && `[${k}: ${dec(get(c))}]`).filter(Boolean),
        };
        if (get('Função')) r.notes.push(`[Function: ${get('Função')}]`);
      }
      rows.push(r);
      first = first == null ? day : Math.min(first, day);
      last = last == null ? day : Math.max(last, day);
      for (const [f, c] of [['date', 'Data'], ['duty', cols.some(k => k.name === 'Prog') ? 'Prog' : 'Vôo'], ['begin', 'Partida'], ['end', 'Cheg.'], ['ac', 'Frota'], ['registration', 'Aeronave']]) mark(r, f, cell[c]);
      // "RAO GRU" as one item (its words dep and arr) or two
      const etapa = cell.Etapa || [];
      if (etapa.length === 2) { mark(r, 'dep', etapa[0]); mark(r, 'arr', etapa[1]); } else mark(r, 'route', etapa);
      // the cells its info is made of (a flight's hours, another activity's type)
      const flight = pay && r.dep && r.arr;
      for (const c of !pay ? ['Total', 'Noturna', 'IFR', 'VFR', 'Simulador', 'Função'] : flight ? ['Total', 'Not.'] : ['Tipo Atividade']) mark(r, 'info', cell[c]);
    }
  }
  const fmt = (t) => { const x = new Date(t); return `${String(x.getUTCDate()).padStart(2, '0')}${MONTHS[x.getUTCMonth()]}${String(x.getUTCFullYear() % 100).padStart(2, '0')}`; };
  const out = rows.map(r => outputRow({ ...r, info: r.notes.join(' ') }, 'L'));
  return { format: 'br-hours-report', period: first != null ? `${fmt(first)} - ${fmt(last)}` : null, notices: [], recognized: out.length > 0, published: out, planned: [], _trace: trace, _rows: rows };
}

const isLhCasPlan = (page) => page.items.some(i => /^Achtung! Nur zur Info! CAS ist der Master!/.test(i.text)) && page.items.some(i => i.text === 'Persönlicher Einsatzplan');

/**
 * Lufthansa CAS "Persönlicher Einsatzplan" print ("Achtung! Nur zur Info! CAS ist der Master!", "01OCT24 - 31OCT24"), a block
 * of lines per day ("04OCT" over "Friday"), UTC times with the local ones in brackets:
 *   1  154302/18  A350  CP:1 SF:1 FO:1  BZW:19:54 ...           (a pairing: its number)
 *   Briefing  MUC  11:55 [13:55]                                (the report)
 *   LH476                                                       (a flight, its line under it:)
 *   A350  MUC  14:16 [16:16]  00:32+1 [17:32]  YVR  10:16        (aircraft, dep, off, on, arr, block)
 *   X / S4 MUC / Hotel YVR                                      (a day's code, a hotel night)
 *   TTC OT RE 359 /O  MUC  21:20 [23:20]   ...   01:20 [03:20]   (an activity: its start, its end the next day)
 * Rows: Briefing a C/I row ("[Trip: 154302/18]"), a flight a row ("14:16 Z / 16:16 L", ac, "[Block: 10:16]"), a hotel an H row,
 * a code a row, an activity one row from its start to its end. There is no release time.
 */
function parseLhCasPlan(pages) {
  const trace = startTrace();
  const rows = [];
  const all = pages.flatMap(p => p.items.map(i => i.text)).join(' ');
  const per = /(\d{2})([A-Z]{3})(\d{2}) - (\d{2})([A-Z]{3})(\d{2})/.exec(all);
  if (!per) return { format: 'lh-cas-plan', period: null, notices: [], recognized: false, published: [], planned: [], _trace: trace, _rows: [] };
  const dayRow = (t) => { const d = new Date(t); return { date: `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${String(d.getUTCFullYear() % 100).padStart(2, '0')}`, day: WEEKDAYS[d.getUTCDay()] }; };
  const zl = (z, l) => `${formatTime(z, 'Z')}${l ? ` / ${formatTime(l, 'L')}` : ''}`;
  const T = String.raw`(\d{2}:\d{2}(?:[+-]\d)?)`;
  const LEG = new RegExp(String.raw`^(\S+) ([A-Z]{3}) ${T} \[${T}\] ${T} \[${T}\] ([A-Z]{3})(?: (\d{1,3}:\d{2}))?$`);
  let yr = 2000 + +per[3], lastM = monthIndex(per[2]);
  let open = null; // an activity begun, its end on a later day
  for (const page of pages) {
    // (icons: a plane, a bed .. in a symbol font's private use characters)
    const items = page.items.filter(i => i.text.replace(/[-]/g, '').trim());
    const dates = items.filter(i => i.x < 60 && /^\d{2}[A-Z]{3}$/.test(i.text)).sort((a, b) => a.y - b.y);
    for (const [k, d] of dates.entries()) {
      const m = monthIndex(d.text.slice(2));
      if (m < 0) continue;
      if (m < lastM) yr += 1;
      lastM = m;
      const t = Date.UTC(yr, m, +d.text.slice(0, 2));
      // the day's lines: from just above its date to just above the next one
      const y1 = dates[k + 1] ? dates[k + 1].y - 6 : Infinity;
      const lines = toLines(items.filter(i => i.x >= 60 && i.y >= d.y - 6 && i.y < y1), 4);
      let trip = '';
      for (const [n, line] of lines.entries()) {
        const text = line.items.map(i => i.text).join(' ').replace(/\s+/g, ' ').trim();
        const pairing = /^\d+ (\d{5,}\/\d+) /.exec(text);
        if (pairing) { trip = pairing[1]; continue; }
        const brief = /^Briefing ([A-Z]{3}) (\d{2}:\d{2})(?: \[(\d{2}:\d{2}(?:[+-]\d)?)\])?$/.exec(text);
        if (brief) {
          const r = { section: 'published', ...dayRow(t), duty: 'C/I', dep: brief[1], begin: zl(brief[2], brief[3]), notes: [trip && `[Trip: ${trip}]`].filter(Boolean) };
          rows.push(r);
          mark(r, 'ci', line.items.filter(i => /\d{2}:\d{2}/.test(i.text)));
          continue;
        }
        const leg = /^[A-Z0-9]{2}\d{1,4}[A-Z]?$/.test(text) && lines[n + 1] && LEG.exec(lines[n + 1].items.map(i => i.text).join(' ').replace(/\s+/g, ' ').trim());
        if (leg) {
          const [, ac, dep, off, offL, on, onL, arr, blk] = leg;
          const r = {
            section: 'published', ...dayRow(t), duty: text, ac, dep, arr, begin: zl(off, offL), end: zl(on, onL),
            notes: [blk && /[1-9]/.test(blk) && `[Block: ${blk}]`].filter(Boolean),
          };
          rows.push(r);
          mark(r, 'duty', line.items);
          mark(r, 'begin', lines[n + 1].items.filter(i => /\d{2}:\d{2}/.test(i.text)));
          lines[n + 1].done = true;
          continue;
        }
        if (line.done || LEG.test(text)) continue;
        const hotel = /^Hotel ([A-Z]{3})$/.exec(text);
        if (hotel) {
          const r = { section: 'published', ...dayRow(t), duty: 'H', dep: hotel[1], notes: [] };
          rows.push(r);
          mark(r, 'hotel', line.items);
          continue;
        }
        if (/^[A-Z0-9]{1,6}$/.test(text)) { const r = { section: 'published', ...dayRow(t), duty: text, notes: [] }; rows.push(r); mark(r, 'duty', line.items); continue; } // a day's code: X
        // an activity: its name, its station, a start and / or an end (start left of the end's column)
        const act = /^(.+?) ([A-Z]{3})((?: \d{2}:\d{2}(?:[+-]\d)? \[[^\]]+\])*)$/.exec(text);
        if (!act) continue;
        const name = act[1].replace(/\s*\/O$/, '');
        const times = line.items.filter(i => /^\d{2}:\d{2}/.test(i.text));
        const local = (it) => line.items.find(j => j.x > it.x && /^\[/.test(j.text))?.text.slice(1, -1);
        const start = times.find(i => i.x < 400), end = times.find(i => i.x >= 400);
        if (open && end && !start && open.name === name) {
          const days = Math.round((t - open.t) / 86400000);
          open.row.end = `${formatTime(end.text, 'Z')}${days ? ` +${days}` : ''}${local(end) ? ` / ${formatTime(local(end), 'L')}${days ? ` +${days}` : ''}` : ''}`;
          mark(open.row, 'end', [end]);
          open = null;
          continue;
        }
        const r = {
          section: 'published', ...dayRow(t), duty: name, dep: act[2], begin: start ? zl(start.text, local(start)) : '', end: end ? zl(end.text, local(end)) : '', notes: [],
        };
        rows.push(r);
        mark(r, 'duty', line.items.filter(i => i.x < 210));
        open = start && !end ? { row: r, name, t } : null;
      }
    }
  }
  const p = `${per[1]}${MONTHS[monthIndex(per[2])]}${per[3]} - ${per[4]}${MONTHS[monthIndex(per[5])]}${per[6]}`;
  const out = rows.map(r => outputRow({ ...r, info: r.notes.join(' ') }, 'Z'));
  return { format: 'lh-cas-plan', period: p, notices: [], recognized: out.length > 0, published: out, planned: [], _trace: trace, _rows: rows };
}

const isLhCas = (page) => page.items.some(i => /^Crew Assignment System v/.test(i.text)) && page.items.some(i => /^Datum Umlauf/.test(i.text));

/**
 * Lufthansa "Crew Assignment System" Persönlicher Einsatzplan (a month: "Monat : FEB 2011"), after the month's calendar and
 * counters the days in detail ("UTC Kalender/Homebase FRA - UTC"):
 *   Di 01 101307  CP 7 7 12  1CP 0SF 1FO ...                      (the day; its pairing)
 *   Briefingzeit(LT MUC): 01/02/11 10:00                           (the report, local time)
 *   YNJ1  LH2528-1 A320 MUC 10:10-13:15 DME 03:05 03:06 +02:00      (a leg, UTC; "DH" before the flight: deadhead)
 *   Fr 04 MO  08:00-17:00 / Di 08 U 23:00- / Mi 09 U -              (a day's activity)
 *   Mo 21 OTX/OR  LH103-P  06:00-07:10                            (an activity with a reference: "[LH103-P]")
 *   So 16 SIM EBTF5A  LSW BZW RZ / A320 OT1EB320 FRA 04:55-08:55     (a simulator on the day's line: a SIM row)
 *   Fr 10 423 LH423-1 A330 BOS 22:00- / Sa 11 X -05:20 FRA 07:20   (a leg over midnight: its end, arrival, block on the next day)
 * Rows: a leg a row (duty = the flight without its "-1", dc DH, ac, dep / arr, "+1" when it lands the next day, "[Block: 03:05]"),
 * an activity a row (its code, its station, its times; a simulator's times, aircraft and session from its "SIM" lines under it,
 * or a SIM row of its own when the activity has times of its own).
 * The briefing (report) time is no row (the user's rule); there is no release time. The details may start in the month before.
 */
function parseLhCas(pages) {
  const trace = startTrace();
  const rows = [];
  const MON = { JAN: 0, FEB: 1, MAR: 2, MRZ: 2, APR: 3, MAY: 4, MAI: 4, JUN: 5, JUL: 6, AUG: 7, SEP: 8, OCT: 9, OKT: 9, NOV: 10, DEC: 11, DEZ: 11 };
  // the month: the words right of "Monat :" (on the line above it)
  let y0 = null, m0 = null;
  for (const page of pages) {
    const lab = page.items.find(i => /^Monat :/.test(i.text));
    if (!lab) continue;
    const near = page.items.filter(i => Math.abs(i.y - lab.y) < 6 && i.x > lab.x && i.x < lab.x + 90).map(i => i.text);
    const mm = near.find(t => MON[t] != null), yy = near.find(t => /^\d{4}$/.test(t));
    if (mm && yy) { m0 = MON[mm]; y0 = +yy; break; }
  }
  if (m0 == null) return { format: 'lh-cas', period: null, notices: [], recognized: false, published: [], planned: [], _trace: trace, _rows: [] };
  const dayRow = (t) => { const d = new Date(t); return { date: `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${String(d.getUTCFullYear() % 100).padStart(2, '0')}`, day: WEEKDAYS[d.getUTCDay()] }; };
  const LEG = /(?:^|\s)(DH\s+)?([A-Z0-9]{2}\d{1,4}[A-Z]?)(?:-\d+)?\s+(?:([A-Z0-9]{3,5})\s+)?([A-Z]{3})\s+(\d{2}:\d{2})-(\d{2}:\d{2})\s+([A-Z]{3})(?:\s+(\d{2}:\d{2}))?/;
  // a leg over midnight: "423 LH423-1 A330 BOS 22:00-" (its arrival on the next day's line)
  const OPEN_LEG = /(?:^|\s)(DH\s+)?([A-Z0-9]{2}\d{1,4}[A-Z]?)(?:-\d+)?\s+(?:([A-Z0-9]{3,5})\s+)?([A-Z]{3})\s+(\d{2}:\d{2})-(?=\s|$)/;
  let day = null, last = 0, mo = m0, yr = y0, started = false, lastAct = null, sim = false, simName = '';
  let open = null; // { row, t, leg }: a leg or a simulator whose end is on the next day's line
  for (const page of pages) {
    for (const line of toLines(page.items, 2)) {
      const text = line.items.map(i => i.text).join(' ').replace(/\s+/g, ' ').trim();
      if (/^Datum Umlauf/.test(text)) { started = true; continue; }
      if (!started) continue;
      const d = /^(Mo|Di|Mi|Do|Fr|Sa|So) (\d{2})\b\s*(.*)$/.exec(text);
      let rest = text;
      if (d) {
        // the details may start in the month before ("So 28" .. "Do 01")
        if (day == null && +d[2] >= 20) { mo -= 1; if (mo < 0) { mo = 11; yr -= 1; } }
        else if (+d[2] < last) { mo += 1; if (mo > 11) { mo = 0; yr += 1; } }
        last = +d[2];
        day = Date.UTC(yr, mo, +d[2]);
        rest = d[3];
      }
      if (day == null) continue;
      // the briefing (report) is no row of its own
      if (/Briefingzeit/.test(text)) continue;
      // a leg or a simulator begun the day before: its end on this day's line ("Sa 11 X -05:20 FRA 07:20 00:00",
      // "So 13 -01:20 4 4 12 TTC"); a code before it ("X") is this day's activity, at the arrival station
      const cont = d && open && /^(?:([A-Z][A-Z0-9_/]{0,6}) )?-(\d{2}:\d{2})(?: ([A-Z]{3}))?(?: (\d{2}:\d{2}))?(?:\s|$)/.exec(rest);
      if (d) {
        const was = open;
        open = null;
        if (cont) {
          const [, code, to, arr = '', blk] = cont;
          const days = Math.round((day - was.t) / 86400000);
          was.row.end = `${to}${days > 0 ? `+${days}` : ''}`;
          if (was.leg) {
            if (arr) was.row.arr = arr;
            if (blk && /[1-9]/.test(blk)) was.row.notes.push(`[Block: ${blk}]`);
          }
          mark(was.row, 'end', line.items.filter(i => i.text.includes(`-${to}`)));
          if (code) {
            const r = { section: 'published', ...dayRow(day), duty: code, dep: arr, begin: '', end: '', notes: [] };
            rows.push(r);
            lastAct = r;
            mark(r, 'duty', [line.items.find(i => i.text.includes(code)) || line.items[0]]);
          }
          continue;
        }
      }
      // a simulator's details under its day ("SIM LSW BZW RZ" / "A320 OT1FC822 MUC 05:00-09:00 4 4 12 CHFCL"): its activity's
      // times; a SIM row of its own when it is on the day's line ("So 16 SIM EBTF5A LSW ..": its session in the info) or
      // the activity has times of its own ("OTX/OR XX103-P 06:00-07:10")
      const simHead = /^SIM(?: (\S+))? LSW\b/.exec(rest);
      if (simHead) {
        if (d || !lastAct || lastAct.begin || lastAct.date !== dayRow(day).date) {
          const r = { section: 'published', ...dayRow(day), duty: 'SIM', notes: [] };
          rows.push(r);
          lastAct = r;
          mark(r, 'duty', [line.items.find(i => /SIM/.test(i.text)) || line.items[0]]);
        }
        simName = simHead[1] || '';
        sim = true;
        continue;
      }
      if (sim && /^Bemerkung:/.test(rest)) continue; // a remark between a simulator's lines
      const simLine = sim && /^([A-Z0-9]{3,5}) (\S+) ([A-Z]{3}) (\d{2}:\d{2})-(\d{2}:\d{2})?(?:.*?\s([A-Z]{3,}))?$/.exec(rest);
      sim = false;
      if (simLine && lastAct) {
        const [, ac, session, dep, from, to = '', kind] = simLine;
        Object.assign(lastAct, { ac, dep, begin: from, end: to ? `${to}${to < from ? '+1' : ''}` : '' });
        lastAct.notes.push(`[Sim: ${[...new Set([simName, session, kind])].filter(Boolean).join(' ')}]`);
        mark(lastAct, 'begin', line.items.filter(i => /\d{2}:\d{2}-/.test(i.text)));
        if (!to) open = { row: lastAct, t: day, leg: false };
        continue;
      }
      const leg = LEG.exec(rest);
      if (leg) {
        const [, dh, flight, ac = '', dep, from, to, arr, blk] = leg;
        const r = {
          section: 'published', ...dayRow(day), dc: dh ? 'DH' : '', duty: flight, ac, dep, arr, begin: from, end: `${to}${to < from ? '+1' : ''}`,
          notes: [blk && /[1-9]/.test(blk) && `[Block: ${blk}]`].filter(Boolean),
        };
        rows.push(r);
        mark(r, 'duty', line.items.filter(i => i.text.includes(flight)));
        mark(r, 'ac', line.items.filter(i => ac && i.text === ac));
        mark(r, 'begin', line.items.filter(i => /\d{2}:\d{2}-\d{2}:\d{2}/.test(i.text)));
        continue;
      }
      const openLeg = OPEN_LEG.exec(rest);
      if (openLeg) {
        const [, dh, flight, ac = '', dep, from] = openLeg;
        const r = { section: 'published', ...dayRow(day), dc: dh ? 'DH' : '', duty: flight, ac, dep, arr: '', begin: from, end: '', notes: [] };
        rows.push(r);
        open = { row: r, t: day, leg: true };
        mark(r, 'duty', line.items.filter(i => i.text.includes(flight)));
        mark(r, 'ac', line.items.filter(i => ac && i.text === ac));
        mark(r, 'begin', line.items.filter(i => /\d{2}:\d{2}-/.test(i.text)));
        continue;
      }
      // a day's activity: "MO 08:00-17:00", "MO BRE 07:00-16:00", "EMCRM 1 MUC 06:30-14:30", "U 23:00-", "U -", "X TLL",
      // "OTX/OR LH103-P 06:00-07:10", "OTX/O LH103 FRA 09:00-10:00" (its reference in the info), also on a line of its own
      // under the day ("OFF 22:00-": begun that evening)
      const act = /^([A-Z][A-Z0-9_/]{0,6})(?: \d{1,2})?(?: ([A-Z0-9]{2}\d{1,4}(?:-[A-Z])?))?(?: ([A-Z]{3}))?(?: (\d{2}:\d{2})?-(\d{2}:\d{2})?)?$/.exec(rest);
      if (act && (d || line.items[0].x > 30)) {
        const [, code, ref = '', station = '', from = '', to = ''] = act;
        const r = { section: 'published', ...dayRow(day), duty: code, dep: station, begin: from, end: to ? `${to}${from && to < from ? '+1' : ''}` : '', notes: ref ? [`[${ref}]`] : [] };
        rows.push(r);
        lastAct = r;
        mark(r, 'duty', [line.items.find(i => i.text.includes(code)) || line.items[0]]);
        if (from || to) mark(r, 'begin', line.items.filter(i => /\d{2}:\d{2}/.test(i.text)));
      }
    }
  }
  const lastDay = new Date(Date.UTC(y0, m0 + 1, 0)).getUTCDate();
  const yy = String(y0 % 100).padStart(2, '0');
  const out = rows.map(r => outputRow({ ...r, info: r.notes.join(' ') }, 'Z'));
  return { format: 'lh-cas', period: `01${MONTHS[m0]}${yy} - ${lastDay}${MONTHS[m0]}${yy}`, notices: [], recognized: out.length > 0, published: out, planned: [], _trace: trace, _rows: rows };
}

const isAimsIndividual = (page) => page.items.some(i => /^(Individual (Roster|Report)|Current Roster Report|Published Report)$/.test(i.text)) && page.items.some(i => i.text === 'Orig') && page.items.some(i => i.text === 'Dest');

/**
 * AIMS "Individual Roster" / "Individual Report" (period "07AUG24 - 01SEP24"), a line per activity, the date ("22THU") on a
 * day's first line; its columns vary by airline (names from its header line):
 *   Date | DD (Du) | Activity | C/I (P/U) | Orig | STD (ATD) | Dest | STA (ATA) | C/O | AC | BLH | DUTY | FDP | ...
 *   22THU |  | AF1562 | 11:30 | CDG | 12:30 | PMI | 14:25 |       | E90
 *         |  | AF1186 |       | CDG | 19:40 | LJU | 21:30 | 21:45 | E90
 *         |  | HTL    |       | LJU | 21:45                      (a hotel / an activity going on ...)
 *   23FRI |  | HTL    |       |     |       | LJU | 05:40          (... ending the next day: one row)
 * Rows: C/I (P/U) a C/I row (Orig), the activity a row (dc = DD, dep / arr, begin / end, "+1" when it ends a later day, ac,
 * "[Block: 2:05]" from BLH), C/O a C/O row on the duty's date ("[Duty: ..] [FDP: ..]"). Times UTC when the report says so,
 * else local.
 * Jeppesen's "Current Roster Report" ("Planning Period: 28JUN2024-11SEP2024") is alike: dates "JUL 24WED", a hotel's values
 * a column right of their headers, then "Crew Onboard" ("Jul 24Wed Y41820 FA: P.YAZMIN CP: J.DOE" -> the flight's crew
 * "[FA - P.YAZMIN][CP - J.DOE]") and "Hotel information" (arrival, departure, name -> the hotel row's info).
 * Sabre's "Individual Roster" (d7d2281f…) has, after the days: "Crew onboard" ("2021-02-02 XK776 CDB:GYE CC:GDI" -> crew
 * "[CDB - GYE][CC - GDI]"), "Day notes" ("2021-02-15 cel" -> "[Memo: cel]" on the day's events but C/I and C/O), "Hotel
 * information" ("11FEB21 - 12FEB21 A MADONETTA FSC") and "Information" ("RS7 = RESERVE" -> "[RS7: RESERVE]" on the rows of
 * that duty or DD). A hotel printed again on the next day's line, times and all ("HOT FSC 20:15 FSC 10:50"), is the same night.
 */
function parseAimsIndividual(pages) {
  const trace = startTrace();
  const rows = [];
  const all = pages.flatMap(p => p.items.map(i => i.text)).join(' ');
  // ("01OCT24 00:00 - 31OCT24 23:59", "28JUN2024-11SEP2024")
  const per = /(\d{2})([A-Z]{3})(?:\d{2})?(\d{2})(?: \d{2}:\d{2})?\s*-\s*(\d{2})([A-Z]{3})(?:\d{2})?(\d{2})\b/.exec(all);
  const mon = (t) => MONTHS.findIndex(m => m.toUpperCase() === t);
  if (!per || mon(per[2]) < 0) return { format: 'aims-individual', period: null, notices: [], recognized: false, published: [], planned: [], _trace: trace, _rows: [] };
  const zone = /\bUTC\b/.test(all) ? 'Z' : 'L';
  const cal = { y: 2000 + +per[3], m: mon(per[2]), last: +per[1] - 1 };
  const dayRow = (t) => { const d = new Date(t); return { date: `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${String(d.getUTCFullYear() % 100).padStart(2, '0')}`, day: WEEKDAYS[d.getUTCDay()] }; };
  const TIME = /^\d{2}:\d{2}$/;
  const min = (t) => (TIME.test(t) ? +t.slice(0, 2) * 60 + +t.slice(3) : null);
  // the crew of each flight, the hotels (Current Roster Report), the day notes and the legend (Sabre)
  const crewOf = new Map(), hotels = [], memos = new Map(), legend = new Map();
  const SECTION = /^(crew onboard|day notes|hotel information|document expire|information)$/i;
  const titleMon = (t) => t[0] + t.slice(1).toLowerCase();
  let part = '';
  for (const page of pages) {
    for (const line of toLines(page.items, 3)) {
      const text = line.items.map(i => i.text).join(' ').trim();
      if (SECTION.test(text)) { part = text.toLowerCase(); continue; }
      // "Jul 26Fri XX202 FA: P.ANN CP: J.DOE", "2021-02-02 XK776 CDB:GYE CC:GDI" (a flight twice a day: its crews in turn)
      const c = part === 'crew onboard' && (/^([A-Z][a-z]{2}) (\d{2})[A-Z][a-z]{2} (\S+) (.+)$/.exec(text)
        || ((m) => m && [m[0], MONTHS[+m[2] - 1], m[3], m[4], m[5]])(/^(\d{4})-(\d{2})-(\d{2}) (\S+) (.+)$/.exec(text)));
      if (c) {
        const key = `${+c[2]} ${c[1]}|${c[3]}`;
        crewOf.set(key, [...(crewOf.get(key) || []), [...c[4].matchAll(/([A-Z]{2,3}): ?(.+?)(?= [A-Z]{2,3}:|$)/g)].map(m => `[${m[1]} - ${m[2]}]`).join('')]);
      }
      const h = part === 'hotel information' && /^(\d{2})([A-Za-z]{3})(\d{2})(?: - | )\d{2}[A-Za-z]{3}\d{2} (.+)$/.exec(text);
      if (h) hotels.push({ date: `${+h[1]} ${titleMon(h[2])} ${h[3]}`, name: h[4] });
      const n = part === 'day notes' && /^(\d{4})-(\d{2})-(\d{2}) (.+)$/.exec(text);
      if (n) { const k = `${+n[3]} ${MONTHS[+n[2] - 1]} ${n[1].slice(2)}`; memos.set(k, [...(memos.get(k) || []), n[4]]); }
      const l = part === 'information' && /^(\S+) = (.+)$/.exec(text);
      if (l) legend.set(l[1], l[2]);
    }
  }
  let day = null, dutyDay = null;
  for (const page of pages) {
    const act = page.items.find(i => i.text === 'Activity');
    if (!act) continue;
    const head = page.items.filter(i => Math.abs(i.y - act.y) < 3);
    const alias = { 'Du,,': 'DD', 'P/U': 'C/I', ATD: 'STD', ATA: 'STA', Duty: 'DUTY' };
    const cols = head.map(i => ({ name: alias[i.text] || i.text, x: i.x })).sort((a, b) => a.x - b.x);
    // a value sits from just left of its header to the next one
    const colOf = (x) => [...cols].reverse().find(c => x >= c.x - 6)?.name || cols[0].name;
    for (const line of toLines(page.items.filter(i => i.y > act.y + 4), 3)) {
      if (SECTION.test(line.items.map(i => i.text).join(' ').trim())) break;
      const cell = {};
      for (const it of line.items) (cell[colOf(it.x)] ||= []).push(it);
      const get = (c) => (cell[c] || []).map(i => i.text).join(' ').trim();
      // a hotel's values a column right of their headers ("HTL | | ORD | 01:35" under Orig | STD | Dest)
      const shift = ['Orig', 'STD', 'Dest', 'STA', 'C/O'];
      if (/^[A-Z]{3}$/.test(get('STD')) || /^[A-Z]{3}$/.test(get('STA'))) shift.forEach((c, k) => { cell[c] = cell[shift[k + 1]]; });
      const md = /^([A-Z]{3}) (\d{2})[A-Z]{3}$/.exec(get('Date')); // "JUL 24WED"
      if (md && mon(md[1]) >= 0) {
        if (mon(md[1]) < cal.m) cal.y += 1;
        cal.m = mon(md[1]);
        cal.last = +md[2];
        day = Date.UTC(cal.y, cal.m, +md[2]);
      }
      const d = !md && /^(\d{2})([A-Za-zéû]{2,4}\.?)$/.exec(get('Date')); // "22THU", "01mar." (French), "26ma" (Dutch)
      if (d) {
        if (+d[1] < cal.last) { cal.m += 1; if (cal.m > 11) { cal.m = 0; cal.y += 1; } }
        cal.last = +d[1];
        day = Date.UTC(cal.y, cal.m, +d[1]);
      }
      const activity = get('Activity');
      const std = get('STD'), sta = get('STA');
      // the rest of an activity begun the day before (its name printed again, or not): it ends here
      const prev = [...rows].reverse().find(x => x.t != null);
      if (day != null && !TIME.test(std) && TIME.test(sta) && prev && !prev.end && (!activity || prev.duty === activity)) {
        const days = Math.round((day - prev.t) / 86400000);
        prev.end = `${sta}${days ? `+${days}` : ''}`;
        prev.arr ||= get('Dest');
        if (/^\d+:\d{2}$/.test(get('BLH')) && /[1-9]/.test(get('BLH')) && !prev.notes.some(n => /^\[Block:/.test(n))) prev.notes.unshift(`[Block: ${get('BLH')}]`);
        mark(prev, 'end', cell.STA);
        if (TIME.test(get('C/O'))) {
          const base = dutyDay ?? prev.t;
          const cd = Math.round((day - base) / 86400000) + (min(get('C/O')) < min(sta) ? 1 : 0);
          const co = { section: 'published', ...dayRow(base), duty: 'C/O', arr: get('Dest'), end: `${get('C/O')}${cd ? `+${cd}` : ''}`,
            notes: [['Duty', 'DUTY'], ['FDP', 'FDP']].map(([k, c]) => /^\d+:\d{2}$/.test(get(c)) && /[1-9]/.test(get(c)) && `[${k}: ${get(c)}]`).filter(Boolean) };
          rows.push(co);
          mark(co, 'co', cell['C/O']);
          dutyDay = null;
        }
        continue;
      }
      if (day == null || !activity || !/^[A-Z0-9][\w/-]*$/.test(activity)) continue;
      // the night printed again on the next day's line
      const last = rows.at(-1);
      if (last && last.duty === activity && last.t != null && last.t < day && last.dep === get('Orig') && last.begin === std && last.end === `${sta}+1`) continue;
      if (TIME.test(get('C/I'))) {
        dutyDay = day;
        const ci = { section: 'published', ...dayRow(day), duty: 'C/I', dep: get('Orig'), begin: get('C/I'), notes: [] };
        rows.push(ci);
        mark(ci, 'ci', cell['C/I']);
        mark(ci, 'date', cell.Date);
      }
      const r = {
        section: 'published', ...dayRow(day), t: day, dc: get('DD'), duty: activity, dep: get('Orig'), arr: get('Dest'), begin: TIME.test(std) ? std : '',
        end: TIME.test(sta) ? `${sta}${TIME.test(std) && min(sta) < min(std) ? '+1' : ''}` : '', ac: get('AC'),
        notes: [/^\d+:\d{2}$/.test(get('BLH')) && /[1-9]/.test(get('BLH')) && `[Block: ${get('BLH')}]`].filter(Boolean),
      };
      const [dd, mm, yy] = r.date.split(' ');
      r.crew = crewOf.get(`${dd} ${mm}|${activity}`)?.shift() || '';
      const hotel = (activity === 'HTL' || /h[oô]tel/i.test(legend.get(activity) || '')) && hotels.find(x => x.date === `${dd} ${mm} ${yy}`);
      if (hotel) r.notes.push(hotel.name);
      rows.push(r);
      for (const [f, c] of [['date', TIME.test(get('C/I')) ? null : 'Date'], ['dc', 'DD'], ['duty', 'Activity'], ['dep', 'Orig'], ['arr', 'Dest'], ['begin', 'STD'], ['end', 'STA'], ['ac', 'AC'], ['info', 'BLH']]) if (c) mark(r, f, cell[c]);
      if (TIME.test(get('C/O'))) {
        const base = dutyDay ?? day;
        const days = Math.round((day - base) / 86400000) + (TIME.test(sta) && min(get('C/O')) < min(sta) ? 1 : 0);
        const co = {
          section: 'published', ...dayRow(base), duty: 'C/O', arr: get('Dest'), end: `${get('C/O')}${days ? `+${days}` : ''}`,
          notes: [['Duty', 'DUTY'], ['FDP', 'FDP']].map(([k, c]) => /^\d+:\d{2}$/.test(get(c)) && /[1-9]/.test(get(c)) && `[${k}: ${get(c)}]`).filter(Boolean),
        };
        rows.push(co);
        mark(co, 'co', cell['C/O']);
        mark(co, 'co_info', [...(cell.DUTY || []), ...(cell.FDP || [])]);
        dutyDay = null;
      }
    }
  }
  const p = `${per[1]}${MONTHS[mon(per[2])]}${per[3]} - ${per[4]}${MONTHS[mon(per[5])]}${per[6]}`;
  for (const r of rows) {
    if (r.duty === 'C/I' || r.duty === 'C/O') continue;
    for (const code of [r.duty, r.dc]) if (code && legend.has(code)) r.notes.push(`[${code}: ${legend.get(code)}]`);
    for (const memo of memos.get(r.date) || []) r.notes.push(`[Memo: ${memo}]`);
  }
  const out = rows.map(({ t, ...r }) => outputRow({ ...r, info: r.notes.join(' ') }, zone));
  return { format: 'aims-individual', period: p, notices: [], recognized: out.length > 0, published: out, planned: [], _trace: trace, _rows: rows };
}

const isSnRoster = (page) => page.items.some(i => /^Roster :/.test(i.text)) && page.items.some(i => i.text === 'Sched. times') && page.items.some(i => /^Rest until/.test(i.text));

/**
 * Brussels Airlines roster ("Roster : 13JUL2024 - 31AUG2024"), a day ("SUN 14") with its entries, one per line:
 *   function | Sched. times | Description                                  |   | Rest until (real)
 *   TRI      | 08:30-11:05  | SN3811 BRU-OPO (FO)X.VERSAVEL (PU)K.SCHEVERNELS | B | *15JUL 05:45
 *            |              | (CCM)A.CHAHARDIVAR ...   (more crew; a remark: "LT 3-6 with safety pilot")
 *   TRI      | 11:55-14:15  | SN3812 OPO-BRU "          (" : the crew above)
 *   CPT      | 22:00 --.--  |                          (an activity going on the next day ...)
 *   CPT      | --.-- 21:59  | WR/ - Weekly Rest WR     (... with its description there)
 *   FO       | 21:20 --.--  | Stop over at HAM (Novotel City Alster)
 * Times UTC (BRU 08:30 -> OPO 11:05 is the flight's 2:35 only so). Rows: a flight (duty, dep / arr, "+1" when it lands
 * the next day, crew "[FO - X.VERSAVEL][PU - ...]", the remarks under it in info; the day's last flight "[Rest until: 15JUL 05:45]"),
 * a stop over a hotel row (HT, its station, the hotel, from the stop's start to its end the next morning, "[Layover: 10:55]"), another activity a row (its code: "WR", "JDAY", else its first word;
 * "[WR: Weekly Rest WR]"; begun the evening before: "22:00 Z -1"); a simulator / course "at BRU-All" its dep, its training code
 * on the line under it ("S-LPC (A319/320/32N),...", "W-RECFC - CBT") its duty.
 */
function parseSnRoster(pages) {
  const trace = startTrace();
  const rows = [];
  const all = pages.flatMap(p => p.items.map(i => i.text)).join(' ');
  const per = /Roster :\s*(\d{2})([A-Z]{3})(\d{4})[\s-]+(\d{2})([A-Z]{3})(\d{4})/.exec(all); // ("-" may come after the end date in the text)
  const mon = (t) => MONTHS.findIndex(m => m.toUpperCase() === t);
  if (!per) return { format: 'sn-roster', period: null, notices: [], recognized: false, published: [], planned: [], _trace: trace, _rows: [] };
  const cal = { y: +per[3], m: mon(per[2]), last: 0 };
  const dayRow = (t) => { const d = new Date(t); return { date: `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${String(d.getUTCFullYear() % 100).padStart(2, '0')}`, day: WEEKDAYS[d.getUTCDay()] }; };
  let day = null, entry = null, lastCrew = '', pendingStart = null, lastStop = null;
  const dayFlights = new Map(); // day -> its flight rows (the day's last gets "Rest until")
  const crewOf = (items) => {
    const out = [];
    for (const it of items) {
      const m = /^\(([A-Z][A-Z0-9]{1,3})\)(.*)$/.exec(it.text);
      if (m) out.push([m[1], m[2]]); else if (out.length) out.at(-1)[1] += ` ${it.text}`;
    }
    return out.map(([r, n]) => `[${r} - ${n.trim()}]`).join('');
  };
  const CREW_RE = /^\(([A-Z][A-Z0-9]{1,3})\)\S/; // ("(TC2)Z.BONNEZ")
  // a remark as printed; on a simulator / course its first training code ("S-LPC (A319/320/32N),S-EVAL-M5 ...", "W-RECFC - CBT")
  // is the row's duty (the type rating in brackets is no aircraft)
  const TRAINING_RE = /^([SW]-[A-Z0-9][A-Z0-9-]*)/;
  const noteOf = (row, items) => {
    const text = items.map(i => i.text).join(' ');
    row.notes.push(text);
    mark(row, 'info', items);
    const code = row.training && TRAINING_RE.exec(text);
    if (code) { row.duty = code[1]; row.training = false; mark(row, 'duty', [items[0]]); }
  };
  for (const page of pages) {
    const head = page.items.find(i => i.text === 'Sched. times');
    if (!head) continue;
    // (a line's cells stand up to 1.7 points apart: "SUN 14" over "08:30-11:05")
    for (const line of toLines(page.items.filter(i => i.y > head.y + 4), 3)) {
      const items = line.items;
      const dow = items.find(i => i.x < 40 && /^(MON|TUE|WED|THU|FRI|SAT|SUN)$/.test(i.text));
      const dnum = items.find(i => i.x >= 40 && i.x < 60 && /^\d{1,2}$/.test(i.text));
      if (dow && dnum) {
        if (+dnum.text < cal.last) { cal.m += 1; if (cal.m > 11) { cal.m = 0; cal.y += 1; } }
        cal.last = +dnum.text;
        day = Date.UTC(cal.y, cal.m, +dnum.text);
      }
      if (day == null) continue;
      const timeIt = items.find(i => i.x >= 78 && i.x < 140 && /(\d{2}:\d{2}|--\.--)/.test(i.text));
      const desc = items.filter(i => i.x >= 140 && i.x < 470);
      const rest = items.find(i => i.x >= 480 && /\d{2}[A-Z]{3} \d{2}:\d{2}$/.test(i.text));
      if (!timeIt) {
        // more crew, or a remark, of the entry above
        if (!entry || !desc.length) continue;
        // crew: "(CPT)P.CORTEN", a name going on ("L.DE" "PAUW"); an aircraft type "(A319/320/32N)" is no crew member
        const crewStart = desc.findIndex(i => CREW_RE.test(i.text));
        // (a name cut at the line's end goes on before the next one: "(CPT)G.DE" / "WAELE (FO)G.ANTONIOLI")
        const goesOn = crewStart > 0 && entry.crewItems?.length && desc.slice(0, crewStart).every(i => /^[A-Z][A-Z'.-]*$/.test(i.text));
        if ((crewStart === 0 || goesOn) && entry.row) {
          if (entry.crewItems) { entry.crewItems.push(...desc); entry.crewList = crewOf(entry.crewItems); } else entry.crewList += crewOf(desc);
          entry.row.crew = entry.crewList;
          lastCrew = entry.crewList;
          mark(entry.row, 'crew', desc);
        } else if (entry.row) {
          noteOf(entry.row, desc);
        }
        continue;
      }
      const t = /^(\d{2}:\d{2}|--\.--)[- ](\d{2}:\d{2}|--\.--)$/.exec(timeIt.text.replace(/\s+/g, ' ')) || [];
      const [, from = '', to = ''] = t;
      const text = desc.map(i => i.text).join(' ');
      // (a flight has its route: "T80 - Day OFF in 80% con" is no flight T8 0)
      const flight = /^([A-Z0-9]{2}\d{1,4}[A-Z]?)$/.test(desc[0]?.text || '') && /^[A-Z]{3}-[A-Z]{3}$/.test(desc[1]?.text || '') ? desc[0].text : '';
      entry = { crewList: '', row: null };
      if (from !== '--.--' && to === '--.--' && !flight && !/^Stop over/.test(text)) { pendingStart = { day, time: from, items: [timeIt] }; continue; }
      if (flight) {
        const route = /^([A-Z]{3})-([A-Z]{3})$/.exec(desc[1]?.text || '') || [];
        const crewItems = desc.filter(i => i.x >= 240);
        const same = crewItems.length === 1 && crewItems[0].text === '"';
        entry.crewList = same ? lastCrew : crewOf(crewItems);
        entry.crewItems = same ? null : [...crewItems];
        lastCrew = entry.crewList;
        const r = {
          section: 'published', ...dayRow(day), duty: flight, dep: route[1] || '', arr: route[2] || '', begin: from.replace('--.--', ''),
          end: to === '--.--' ? '' : `${to}${from !== '--.--' && to < from ? '+1' : ''}`, crew: entry.crewList, notes: [], rest: rest?.text.replace(/^\*/, ''),
        };
        rows.push(r);
        entry.row = r;
        lastStop = to === '--.--' ? { row: r, day } : null; // (landing the next day: "20:50 --.--", then "--.-- 01:45")
        if (!dayFlights.has(day)) dayFlights.set(day, []);
        dayFlights.get(day).push(r);
        mark(r, 'date', dnum && dow ? [dow, dnum] : null);
        for (const [f, its] of [['duty', [desc[0]]], ['route', desc[1] ? [desc[1]] : []], ['begin', [timeIt]], ['end', [timeIt]], ['crew', crewItems.filter(i => i.text !== '"')]]) mark(r, f, its);
        continue;
      }
      const stop = /^Stop over at ([A-Z]{3})\s*\((.*)\)$/.exec(text);
      if (stop) {
        const r = { section: 'published', ...dayRow(day), duty: 'H', dep: stop[1], begin: from.replace('--.--', ''), notes: [stop[2]] };
        rows.push(r);
        entry.row = r;
        lastStop = { row: r, day };
        mark(r, 'hotel', desc);
        mark(r, 'begin', [timeIt]);
        continue;
      }
      if (text === '"') {
        // the stay going on: its end ("--.-- 03:50" the next morning) and "[Layover: 10:55]"; a flight's landing
        if (lastStop && /^\d{2}:\d{2}$/.test(to)) {
          const r = lastStop.row, days = Math.round((day - lastStop.day) / 86400000);
          r.end = `${to}${days ? `+${days}` : ''}`;
          if (r.begin && r.duty === 'H') {
            const min = days * 1440 + (+to.slice(0, 2) * 60 + +to.slice(3)) - (+r.begin.slice(0, 2) * 60 + +r.begin.slice(3));
            if (min > 0) r.notes.push(`[Layover: ${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}]`);
          }
          mark(r, 'end', [timeIt]);
          lastStop = null;
        }
        continue;
      }
      if (!text) continue;
      // a simulator's / course's crew on its line ("Simulator at BRU-All trainings-Brussels Airlines (CPT)K.PROOT")
      const crewAt = desc.findIndex((i, k) => k > 0 && CREW_RE.test(i.text));
      const own = crewAt > 0 ? desc.slice(0, crewAt) : desc;
      const ownText = own.map(i => i.text).join(' ');
      const code = /^(\w*)\/(\w*)/.exec(desc[0]?.text || '');
      const duty = code ? (code[1] || code[2]) : desc[0].text;
      const what = (/ - (.+)$/.exec(ownText) || [])[1];
      let begin = from === '--.--' ? '' : from;
      if (from === '--.--' && pendingStart) {
        const back = Math.round((day - pendingStart.day) / 86400000);
        begin = `${pendingStart.time}${back ? `-${back}` : ''}`;
      }
      // "Simulator at BRU-All trainings-...": held at BRU, its training code on the line under it
      // (a standby "R/S (SBMA_AM) at BRU" too)
      const after = ownText.slice(desc[0].text.length).trim();
      const at = /(?:^|\s)at ([A-Z]{3})(?:-|$)/.exec(after);
      const r = {
        section: 'published', ...dayRow(day), duty, begin, end: to === '--.--' ? '' : `${to}${from !== '--.--' && to < from ? '+1' : ''}`,
        notes: [what ? `[${duty}: ${what}]` : after].filter(Boolean),
        crew: crewAt > 0 ? crewOf(desc.slice(crewAt)) : '', dep: at ? at[1] : '', training: /^(Simulator|Course)$/.test(duty),
      };
      if (at) mark(r, 'dep', own.filter(i => i.text === at[1] || i.text.startsWith(`${at[1]}-`)));
      rows.push(r);
      entry.row = r;
      entry.crewList = r.crew;
      entry.crewItems = crewAt > 0 ? desc.slice(crewAt) : [];
      if (crewAt > 0) mark(r, 'crew', desc.slice(crewAt));
      mark(r, 'duty', [desc[0]]);
      mark(r, 'begin', from === '--.--' && pendingStart ? pendingStart.items : [timeIt]);
      mark(r, 'end', [timeIt]);
      mark(r, 'info', own.slice(1));
      pendingStart = null;
    }
  }
  for (const list of dayFlights.values()) { const lastLeg = list.at(-1); if (lastLeg.rest) lastLeg.notes.push(`[Rest until: ${lastLeg.rest}]`); }
  const p = `${per[1]}${MONTHS[mon(per[2])]}${per[3].slice(2)} - ${per[4]}${MONTHS[mon(per[5])]}${per[6].slice(2)}`;
  // (a simulator with no training code printed: SIM)
  const out = rows.map(({ rest, training, ...r }) => outputRow({ ...r, duty: training && r.duty === 'Simulator' ? 'SIM' : r.duty, info: r.notes.join(' ') }, 'Z'));
  return { format: 'sn-roster', period: p, notices: [], recognized: out.length > 0, published: out, planned: [], _trace: trace, _rows: rows };
}

const isJaaLogbook = (page) => page.items.some(i => /^(JAA )?PILOT LOGBOOK$/.test(i.text)) && page.items.some(i => i.text === 'Name PIC') && page.items.some(i => i.text === 'Make, Model, Var.');

/**
 * "(JAA) PILOT LOGBOOK" (a period's flights, "Period 01/05/2009 - 31/05/2009"), a line per flight under two header lines:
 *   Date | Departure Place, Time | Arrival Place, Time | Aircraft Make, Model, Var. | Reg. | Multi-Pilot Time | Name PIC |
 *   Landings Day, Ngt | Operational C. T. Night, IFR | Pilot Function Time PIC, (Co-pilot,) Instructor |
 *   Synthetic Training Dev. Ses. Date, Type, Total | Remarks and endorsements | LVIS
 *   01/05/09 | BRU 04:40 | TXL 06:05 | 734 | OOVEP | 1:25 | DIERICK, KRISTOF | 0 | 0 | 0:00 | 1:25 | 1:25 | | (CPT) + (FO)PEERSMAN,
 * Times UTC. A row per flight (ac, registration, crew "[PIC - DIERICK, KRISTOF]", info "[Flight: 1:25] [Landing Day: 1]
 * [Night: ..] [IFR: 1:25] [PIC: 1:25] [CoPilot: ..] [Instructor: ..]", the remark as printed); a simulator session a row
 * (duty SIM, its type the ac, "[Sim: 4:00]"). Times of 0:00, counts of 0, "NOT DEFINED" and the subtotals are left out.
 */
function parseJaaLogbook(pages) {
  const trace = startTrace();
  const rows = [];
  const all = pages.flatMap(p => p.items.map(i => i.text)).join(' ');
  const dateOf = (t) => {
    let m = /^(\d{2})\/(\d{2})\/(\d{2}|\d{4})$/.exec(t);
    if (m) return Date.UTC(m[3].length === 2 ? 2000 + +m[3] : +m[3], +m[2] - 1, +m[1]);
    m = /^(\d{2})([A-Z]{3})(\d{4})$/.exec(t);
    const mo = m && MONTHS.findIndex(x => x.toUpperCase() === m[2]);
    return m && mo >= 0 ? Date.UTC(+m[3], mo, +m[1]) : null;
  };
  const dayRow = (t) => { const d = new Date(t); return { date: `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${String(d.getUTCFullYear() % 100).padStart(2, '0')}`, day: WEEKDAYS[d.getUTCDay()] }; };
  const DUR = /^\d{1,3}:\d{2}$/;
  const dur = (t) => (DUR.test(t) && /[1-9]/.test(t) ? t : '');
  let first = null, last = null;
  for (const page of pages) {
    const lines = toLines(page.items);
    const k = lines.findIndex(l => l.items.some(i => i.text === 'Place') && l.items.some(i => i.text === 'Reg.'));
    if (k < 0) continue;
    // the upper header line (Date, Name PIC, Remarks ...): just above
    const top = page.items.filter(i => i.y < lines[k].y - 3 && i.y > lines[k].y - 16);
    const order = { Place: ['depPlace', 'arrPlace'], Time: ['depTime', 'arrTime'], Date: ['simDate'], Type: ['simType'], Total: ['simTotal'] };
    const seen = {};
    const cols = [
      // (its words may stand a point or two apart: "Pilot Time")
      ...page.items.filter(i => Math.abs(i.y - lines[k].y) <= 3).sort((a, b) => a.x - b.x)
        .map(i => { const n = seen[i.text] = (seen[i.text] || 0) + 1; return { name: order[i.text]?.[n - 1] || i.text, x: i.x }; }),
      ...top.filter(i => ['Date', 'Name PIC', 'Remarks and endorsements', 'LVIS'].includes(i.text)).map(i => ({ name: i.text === 'Date' ? 'date' : i.text, x: i.x })),
    ];
    const nearest = (x) => cols.reduce((a, c) => (Math.abs(c.x - x) < Math.abs(a.x - x) ? c : a)).name;
    for (const line of lines.filter(l => l.y > lines[k].y + 3)) {
      const cell = {};
      for (const it of line.items) {
        const name = it.x >= (cols.find(c => c.name === 'Remarks and endorsements')?.x ?? 650) - 15 && it.x < (cols.find(c => c.name === 'LVIS')?.x ?? 760) - 4 ? 'remark' : nearest(it.x);
        (cell[name] ||= []).push(it);
      }
      const get = (c) => (cell[c] || []).map(i => i.text).join(' ').trim();
      const d = dateOf(get('date'));
      const simDay = dateOf(get('simDate'));
      if (d != null && /^[A-Z]{3,4}$/.test(get('depPlace'))) {
        const tag = (k, c) => { const v = dur(get(c)); return v && `[${k}: ${v}]`; };
        const plus = get('arrTime') < get('depTime') ? '+1' : '';
        const pic = get('Name PIC');
        const r = {
          section: 'published', ...dayRow(d), duty: '', dep: get('depPlace'), arr: get('arrPlace'), begin: get('depTime'), end: get('arrTime') ? `${get('arrTime')}${plus}` : '',
          ac: get('Make, Model, Var.'), registration: get('Reg.'), crew: pic && pic !== 'NOT DEFINED' ? `[PIC - ${pic}]` : '',
          notes: [tag('Flight', 'Pilot Time'), ...[['Landing Day', 'Day'], ['Landing Night', 'Ngt']].filter(([, c]) => /^[1-9]\d*$/.test(get(c))).map(([k2, c]) => `[${k2}: ${get(c)}]`),
            tag('Night', 'Night'), tag('IFR', 'IFR'), tag('PIC', 'PIC'), tag('CoPilot', 'Co-pilot'), tag('Instructor', 'Instructor'), get('remark')].filter(Boolean),
        };
        rows.push(r);
        for (const [f, c] of [['date', 'date'], ['dep', 'depPlace'], ['begin', 'depTime'], ['arr', 'arrPlace'], ['end', 'arrTime'], ['ac', 'Make, Model, Var.'], ['registration', 'Reg.'], ['crew', 'Name PIC'],
          ['info', 'Pilot Time'], ['info', 'Night'], ['info', 'IFR'], ['info', 'PIC'], ['info', 'Instructor'], ['info', 'remark']]) mark(r, f, cell[c]);
        first ??= d; last = d;
      }
      if (simDay != null && get('simType')) {
        const r = { section: 'published', ...dayRow(simDay), duty: 'SIM', ac: get('simType'), notes: [dur(get('simTotal')) && `[Sim: ${dur(get('simTotal'))}]`].filter(Boolean) };
        rows.push(r);
        for (const [f, c] of [['date', 'simDate'], ['ac', 'simType'], ['info', 'simTotal']]) mark(r, f, cell[c]);
        first ??= simDay; last = simDay;
      }
    }
  }
  const per = /Period\s+(\S+)\s+-\s+(\S+)/.exec(all);
  const fmt = (t) => { const x = new Date(t); return `${String(x.getUTCDate()).padStart(2, '0')}${MONTHS[x.getUTCMonth()]}${String(x.getUTCFullYear() % 100).padStart(2, '0')}`; };
  const pa = per && dateOf(per[1]), pb = per && dateOf(per[2]);
  const period = pa != null && pb != null ? `${fmt(pa)} - ${fmt(pb)}` : first != null ? `${fmt(first)} - ${fmt(last)}` : null;
  const out = rows.map(r => outputRow({ ...r, info: r.notes.join(' ') }, 'Z'));
  return { format: 'jaa-logbook', period, notices: [], recognized: out.length > 0, published: out, planned: [], _trace: trace, _rows: rows };
}

const isKlmCrewRoster = (page) => page.items.some(i => /^CREW ROSTER FROM \d{2}[A-Z]{3}\d{4} UPTO \d{2}[A-Z]{3}\d{4}$/.test(i.text)) && page.items.some(i => i.text === 'Activity');

/**
 * KLM "CREW ROSTER FROM 17FEB2025 UPTO 17MAR2025" ("All Times In : Local"), a line per day (two for a day with two legs):
 *   Date | Activity | RPT TIME | DBRF TIME | Departure | Arrival | A/C Type | OP RNK | Comp | Status/SDC | Fly Hrs | Duty Hrs | Totals ...
 *   Sat 22-Feb | KL879 | 09:35 |       | AMS 10:50 |
 *   Sun 23-Feb | -->   |       |       |           | BLR 00:40 | 781 | ... | 09:20 | 11:05      (the arrival a day later)
 *   Thu 09-Jan | Standby thuis | 07:00 | 19:00 | ... | 03:00
 * Rows: RPT a C/I row (dep), a leg a row (dep / arr with their times, "+1" when it lands a later day, ac, info "[Block: 09:20]",
 * "[SDC: LT+]", "[Comp: UV+1]", "[Duty: 11:05]" when no DBRF closes the duty), DBRF a C/O row on the duty's date ("[Duty: 12:30]").
 * Another activity a row (its text as duty, RPT - DBRF, "[Duty: 03:00]"); "---" days and the totals, counters and messages are left out.
 */
function parseKlmCrewRoster(pages) {
  const trace = startTrace();
  const rows = [];
  const all = pages.flatMap(p => p.items.map(i => i.text)).join(' ');
  const per = /CREW ROSTER FROM (\d{2})([A-Z]{3})(\d{4}) UPTO (\d{2})([A-Z]{3})(\d{4})/.exec(all);
  const mon = (t) => MONTHS.findIndex(m => m.toUpperCase() === t.toUpperCase());
  if (!per) return { format: 'klm-crew-roster', period: null, notices: [], recognized: false, published: [], planned: [], _trace: trace, _rows: [] };
  const zone = /All Times In :\s*(UTC|GMT)/i.test(all) ? 'Z' : 'L';
  const cal = { y: +per[3], m: mon(per[2]), last: 0 };
  const dayRow = (t) => { const d = new Date(t); return { date: `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${String(d.getUTCFullYear() % 100).padStart(2, '0')}`, day: WEEKDAYS[d.getUTCDay()] }; };
  const TIME = /^\d{2}:\d{2}$/, ST = /^[A-Z]{3}$/;
  let dutyDay = null, leg = null; // the duty's date (its RPT); a leg waiting for its arrival on a "-->" line
  for (const page of pages) {
    const lines = toLines(page.items);
    const hk = lines.findIndex(l => l.items.some(i => i.text === 'Activity') && l.items.some(i => i.text === 'RPT'));
    if (hk < 0) continue;
    const hx = (t) => lines[hk].items.find(i => i.text === t)?.x;
    const bounds = [['date', 0], ['act', hx('Activity')], ['rpt', hx('RPT')], ['dbrf', hx('DBRF')], ['dep', hx('Departure')], ['arr', hx('Arrival')], ['ac', hx('A/C')],
      ['op', hx('OP')], ['comp', hx('Comp')], ['status', hx('Status')], ['fly', hx('Fly')], ['duty', hx('Duty')], ['totals', hx('Total Flying')]].filter(([, x]) => x != null);
    const colOf = (x) => [...bounds].reverse().find(([, bx]) => x >= bx - 4)?.[0] || 'date';
    for (const line of lines.slice(hk + 2)) {
      if (line.items.some(i => /^(TOTAL :|Message|Flying)$/.test(i.text))) break;
      const cell = {};
      for (const it of line.items) (cell[colOf(it.x)] ||= []).push(it);
      const get = (c) => (cell[c] || []).map(i => i.text).join(' ').trim();
      const d = /^[A-Z][a-z]{2} (\d{2})-([A-Z][a-z]{2})$/.exec(get('date'));
      if (!d) continue;
      if (mon(d[2]) !== cal.m || +d[1] < cal.last) { const nm = mon(d[2]); if (nm < cal.m) cal.y += 1; cal.m = nm; }
      cal.last = +d[1];
      const day = Date.UTC(cal.y, cal.m, +d[1]);
      const part = (c) => { const items = cell[c] || []; return { st: items.find(i => ST.test(i.text))?.text || '', time: items.find(i => TIME.test(i.text))?.text || '', items }; };
      const act = get('act'), dep = part('dep'), arr = part('arr');
      const tags = [get('status') && `[SDC: ${get('status')}]`, get('comp') && `[Comp: ${get('comp')}]`].filter(Boolean);
      const dutyHrs = TIME.test(get('duty')) ? get('duty') : '';
      if (TIME.test(get('rpt'))) {
        dutyDay = day;
        if (dep.st || act === '-->') {
          const ci = { section: 'published', ...dayRow(day), duty: 'C/I', dep: dep.st, begin: get('rpt'), notes: [] };
          rows.push(ci);
          mark(ci, 'ci', cell.rpt);
        }
      }
      if (act === '-->' && leg) {
        // the arrival of the leg begun the day before
        leg.arr = arr.st;
        leg.end = arr.time ? `${arr.time}+${Math.round((day - leg.t) / 86400000)}` : '';
        leg.ac ||= get('ac');
        mark(leg, 'arr', arr.items.filter(i => ST.test(i.text)));
        mark(leg, 'end', arr.items.filter(i => TIME.test(i.text)));
        if (TIME.test(get('fly'))) { leg.notes.unshift(`[Block: ${get('fly')}]`); mark(leg, 'info', cell.fly); }
      } else if (dep.st && /^[A-Z0-9]{2}\d{1,4}[A-Z]?$/.test(act)) {
        const plus = dep.time && arr.time && arr.time < dep.time ? '+1' : '';
        leg = {
          section: 'published', ...dayRow(day), t: day, duty: act, dep: dep.st, arr: arr.st, begin: dep.time, end: arr.time ? `${arr.time}${plus}` : '', ac: get('ac'),
          notes: [TIME.test(get('fly')) && `[Block: ${get('fly')}]`, ...tags].filter(Boolean),
        };
        rows.push(leg);
        for (const [f, c] of [['date', 'date'], ['duty', 'act'], ['ac', 'ac'], ['info', 'fly'], ['info', 'status'], ['info', 'comp']]) mark(leg, f, cell[c]);
        mark(leg, 'dep', dep.items.filter(i => ST.test(i.text)));
        mark(leg, 'begin', dep.items.filter(i => TIME.test(i.text)));
        mark(leg, 'arr', arr.items.filter(i => ST.test(i.text)));
        mark(leg, 'end', arr.items.filter(i => TIME.test(i.text)));
      } else if (act && act !== '---' && act !== '-->') {
        const r = {
          section: 'published', ...dayRow(day), duty: act, begin: TIME.test(get('rpt')) ? get('rpt') : '', end: TIME.test(get('dbrf')) ? get('dbrf') : '',
          notes: [dutyHrs && `[Duty: ${dutyHrs}]`, ...tags].filter(Boolean),
        };
        rows.push(r);
        for (const [f, c] of [['date', 'date'], ['duty', 'act'], ['begin', 'rpt'], ['end', 'dbrf'], ['info', 'duty']]) mark(r, f, cell[c]);
        dutyDay = null;
        leg = null;
        continue;
      }
      if (leg && (dep.st || act === '-->')) {
        if (TIME.test(get('dbrf'))) {
          const base = dutyDay ?? leg.t;
          const days = Math.round((day - base) / 86400000);
          const co = { section: 'published', ...dayRow(base), duty: 'C/O', arr: leg.arr, end: `${get('dbrf')}${days ? `+${days}` : ''}`, notes: [dutyHrs && `[Duty: ${dutyHrs}]`].filter(Boolean) };
          rows.push(co);
          mark(co, 'co', cell.dbrf);
          mark(co, 'co_info', cell.duty);
          dutyDay = null;
        } else if (dutyHrs) {
          leg.notes.push(`[Duty: ${dutyHrs}]`); // the duty's end, with no DBRF printed
          mark(leg, 'info', cell.duty);
          dutyDay = null;
        }
      }
    }
  }
  const p = `${per[1]}${MONTHS[mon(per[2])]}${per[3].slice(2)} - ${per[4]}${MONTHS[mon(per[5])]}${per[6].slice(2)}`;
  const out = rows.map(({ t, ...r }) => outputRow({ ...r, info: r.notes.join(' ') }, zone));
  return { format: 'klm-crew-roster', period: p, notices: [], recognized: out.length > 0, published: out, planned: [], _trace: trace, _rows: rows };
}

const isCrewRosterByPeriod = (page) => page.items.some(i => /^Crew Roster by Period \[/.test(i.text)) && page.items.some(i => i.text === 'Activity');

/**
 * "Crew Roster by Period [01/04/2024-30/04/2024]" (Transavia, Freebird; "Schedule in UTC", some "(LT of Arr & Dep: Times in
 * Brackets)" with the local times on the line under them), day by day ("Sun 07/04/2024"), an entry per line:
 *   Type | From | To | Activity | Fct | Routing / Description | A/C | Blk | Training | Crew Member | Remark
 *   Begin Duty  06:30 >>>              Standard Duty                     Check In (UTC) : 07/04/2024 06:30
 *   Duty Flight 07:46 10:31 TO7672 CC  ORY-FAO (FGZHP)  73H  02:45  Pilot: ©SCHMIDT Daniel (SCH) ...
 *   End Duty    >>> 16:25                                             TOTAL BLK=6:22 FDP=9:25[12:30] DUTY=9:55
 *   HOTAC       16:25 >>>          Oceania Le Metropole Montpelli
 *   Ground Act. 22:00 >>>   OFF        JOUR OFF
 * The Routing / Description column is sometimes printed a line lower than its entry: a route ("MPL-HER (FHTVB)") goes to
 * the last flight without one, a description to the last other entry without one. Rows: Begin Duty a C/I row, a flight
 * ("DHD Flt": dc DH) or a transfer (Train, Rail, Shuttle, Transfert) a row (begin From, end To, "+1" when earlier; dep / arr,
 * registration in brackets, ac, info "[Block: 02:45]"), End Duty a C/O row on the duty's date ("[Block: 6:22] [FDP: 9:25]
 * [Max FDP: 12:30] [Duty: 9:55]"), a hotel (HOTAC, Hotel) a row (HT, at the last arrival, its name), a ground activity a row
 * (duty = Activity, "[OFF: JOUR OFF]", "[Duty: 7:00]" from "VCT DUTY=7:00"); "End Rest" and the hotel and legend pages after the
 * days are left out. Crew from the "Pilot:" / "Cabin:" lists: "[Pilot - SCH - SCHMIDT Daniel]", on the duty's flights from there on.
 * Times UTC ("07:46 Z"), with the local time when printed ("07:46 Z / 08:46 L").
 */
function parseCrewRosterByPeriod(pages) {
  const trace = startTrace();
  const all = pages.flatMap(p => p.items.map(i => i.text)).join(' ');
  const per = /Crew Roster by Period \[(\d{2})[./](\d{2})[./](\d{4})-(\d{2})[./](\d{2})[./](\d{4})\]/.exec(all);
  // month first ("05/01/2024-05/31/2024") when a day part only fits so
  const monthFirst = per && (+per[5] > 12 || +per[2] > 12) && !(+per[4] > 12);
  const dmy = (a, b, y) => (monthFirst ? Date.UTC(+y, +a - 1, +b) : Date.UTC(+y, +b - 1, +a));
  const dayRow = (t) => { const d = new Date(t); return { date: `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${String(d.getUTCFullYear() % 100).padStart(2, '0')}`, day: WEEKDAYS[d.getUTCDay()] }; };
  const TIME = /^\d{1,2}:\d{2}$/;
  const TYPES = ['Ground Act.', 'Duty Flight', 'DHD Flt', 'Begin Duty', 'End Duty', 'End Rest', 'HOTAC', 'Hotel', 'Transfert', 'Train', 'Rail', 'Shuttle'];
  const entries = [];
  let date = null, dateItem = null, stop = false;
  for (const page of pages) {
    const head = toLines(page.items).find(l => l.items.some(i => i.text === 'Activity') && l.items.some(i => i.text === 'Type'));
    if (!head || stop) continue;
    const hx = (t) => head.items.find(i => i.text === t || i.text.startsWith(t))?.x;
    const X = { from: hx('From'), to: hx('To'), act: hx('Activity'), fct: hx('Fct'), ac: hx('A/C'), blk: hx('Blk'), training: hx('Training'), crew: hx('Crew Member'), remark: hx('Remark') };
    const colOf = (x) => {
      if (x < X.from - 8) return 'type';
      if (x < (X.from + X.to) / 2) return 'from';
      if (x < X.act - 4) return 'to';
      if (x < X.fct - 4) return 'act';
      if (x < X.fct + 14) return 'fct';
      if (x < X.ac - 4) return 'routing';
      if (x < X.blk - 6) return 'ac';
      if (x < X.training - 4) return 'blk';
      if (x < X.crew - 4) return 'training';
      if (x < X.remark - 4) return 'crew';
      return 'remark';
    };
    for (const line of toLines(page.items.filter(i => i.y > head.y + 2))) {
      const texts = line.items.map(i => i.text);
      if (texts.some(t => /^(Hotel Details|Details|Remarks|Applicability)$/.test(t)) && line.items[0].x < 95) { stop = true; break; }
      // "Sun 07/04/2024", "lun. 01/04/2019" (French)
      const d = /^([A-Za-zéû]{2,4}\.?) (\d{2})[./](\d{2})[./](\d{4})$/.exec(texts[0] || '');
      if (d) {
        date = dmy(d[2], d[3], d[4]);
        dateItem = line.items[0];
        const rest = line.items.slice(1);
        if (rest.length) entries.push({ type: 'Day', date, dateItem, act: rest.map(i => i.text).join(' '), items: { act: rest } });
        continue;
      }
      if (date == null) continue;
      const cell = {};
      for (const it of line.items) (cell[colOf(it.x)] ||= []).push(it);
      const get = (c) => (cell[c] || []).map(i => i.text).join(' ').trim();
      let entry = null;
      if (TYPES.includes(get('type'))) {
        entry = { type: get('type'), date, dateItem, from: get('from'), to: get('to'), act: get('act'), fct: get('fct'), ac: get('ac'), blk: get('blk'), training: get('training'),
          routing: [], remark: [], crew: [], items: { ...cell } };
        entries.push(entry);
      }
      const cur = entries.at(-1);
      if (!cur) continue;
      // local times "[08:31]" under their UTC ones
      for (const [k, c] of [['ltFrom', 'from'], ['ltTo', 'to']]) {
        const m = /^\[(\d{1,2}:\d{2})\]$/.exec(get(c));
        if (m && !entry) { const e = [...entries].reverse().find(x => TIME.test(x[c]) && !x[k]); if (e) { e[k] = m[1]; (e.items[c] ||= []).push(...cell[c]); } }
      }
      // the routing / description column, maybe a line lower than its entry
      const routing = get('routing');
      if (routing) {
        const flights = ['Duty Flight', 'DHD Flt'];
        const isRoute = /^[A-Z]{3}-[A-Z]{3}\b/.test(routing);
        const target = [...entries].reverse().find(e => (isRoute ? flights.includes(e.type) : !flights.includes(e.type) && e.type !== 'End Duty' && e.type !== 'End Rest') && (isRoute ? !e.route : true));
        if (isRoute && target) {
          const m = /^([A-Z]{3})-([A-Z]{3})(?:\s+\(([A-Z0-9-]+)\))?/.exec(routing);
          target.route = [m[1], m[2]];
          target.reg = m[3] || '';
          (target.items.route ||= []).push(...cell.routing);
        } else if (!isRoute && target) {
          target.routing.push(routing);
          (target.items.routing ||= []).push(...cell.routing);
        }
      }
      // the crew lists of a flight: "Pilot:" / "Cabin:", then a name and its code per line
      const flight = [...entries].reverse().find(e => ['Duty Flight', 'DHD Flt'].includes(e.type));
      if (get('crew') && flight) {
        const t = get('crew');
        const role = /^(Pilot|Cabin):\s*(.*)$/.exec(t);
        if (role) { flight.role = role[1]; if (role[2]) flight.crew.push([role[1], role[2]]); } else flight.crew.push([flight.role || 'Crew', t]);
        (flight.items.crew ||= []).push(...cell.crew);
      }
      if (get('remark')) {
        const r = get('remark');
        const owner = /^\d{1,2}:\d{2}$/.test(r) ? [...entries].reverse().find(e => /=$/.test(e.remark.at(-1) || '')) : cur;
        if (owner) { owner.remark.push(r); (owner.items.remark ||= []).push(...cell.remark); }
      }
    }
  }
  // rows
  const rows = [];
  const fmt = (utc, lt, plus = 0) => (TIME.test(utc) ? `${utc.padStart(5, '0')} Z${plus ? ` +${plus}` : ''}${lt ? ` / ${lt.padStart(5, '0')} L` : ''}` : '');
  const min = (t) => (TIME.test(t) ? +t.split(':')[0] * 60 + +t.split(':')[1] : null);
  let dutyDate = null, lastArr = '', crew = '', pendingCI = null;
  const crewText = (list) => list.map(([role, t]) => { const m = /^©?(.*?)\s*\(([A-Z]{2,4})\)$/.exec(t.replace(/^©/, '')); return m ? `[${role} - ${m[2]} - ${m[1].trim()}]` : `[${role} - ${t.replace(/^©/, '')}]`; }).join('');
  const starts = []; // [first row index, entry]: which rows an entry made
  for (const e of entries) {
    starts.push([rows.length, e]);
    const base = { section: 'published', ...dayRow(e.date), notes: [] };
    if (e.type === 'Day') { const r = { ...base, duty: e.act }; rows.push(r); mark(r, 'duty', e.items.act); continue; }
    if (e.type === 'Begin Duty') {
      dutyDate = e.date; crew = '';
      pendingCI = { ...base, duty: 'C/I', begin: fmt(e.from, e.ltFrom), notes: [] };
      rows.push(pendingCI);
      mark(pendingCI, 'ci', e.items.from);
      continue;
    }
    if (['Duty Flight', 'DHD Flt', 'Transfert', 'Train', 'Rail', 'Shuttle'].includes(e.type)) {
      const plus = min(e.to) != null && min(e.from) != null && min(e.to) < min(e.from) ? 1 : 0;
      if (e.crew.length) crew = crewText(e.crew);
      const flight = ['Duty Flight', 'DHD Flt'].includes(e.type);
      const [dep = '', arr = ''] = e.route || (/^([A-Z]{3})\s*-\s*([A-Z]{3})/.exec(e.routing.join(' ')) || []).slice(1);
      const r = {
        ...base, dc: e.type === 'DHD Flt' ? 'DH' : '', duty: e.act || e.type, dep, arr, registration: e.reg || '', ac: e.ac,
        begin: fmt(e.from, e.ltFrom), end: fmt(e.to, e.ltTo, plus), crew: flight ? crew : '',
        notes: [/^\d{1,2}:\d{2}$/.test(e.blk) && `[Block: ${e.blk}]`, e.training && `[Training: ${e.training}]`, !flight && e.routing.length && e.routing.join(' ')].filter(Boolean),
      };
      rows.push(r);
      for (const [f, c] of [['duty', 'act'], ['begin', 'from'], ['end', 'to'], ['ac', 'ac'], ['info', 'blk'], ['info', 'training'], ['crew', 'crew']]) mark(r, f, e.items[c]);
      mark(r, 'route', e.items.route);
      if (pendingCI && !pendingCI.dep) pendingCI.dep = dep;
      pendingCI = null;
      if (arr) lastArr = arr;
      continue;
    }
    if (e.type === 'End Duty') {
      const days = dutyDate != null ? Math.round((e.date - dutyDate) / 86400000) : 0;
      const tot = e.remark.join(' ');
      const tag = (k, re) => { const m = re.exec(tot); return m && /[1-9]/.test(m[1]) && `[${k}: ${m[1]}]`; }; // 0:00 (a deadhead or ground duty): none
      const r = {
        ...base, ...(dutyDate != null ? dayRow(dutyDate) : {}), duty: 'C/O', arr: lastArr, end: fmt(e.to, e.ltTo, days),
        notes: [tag('Block', /BLK=(\d+:\d{2})/), tag('FDP', /FDP=(\d+:\d{2})/), tag('Max FDP', /FDP=\d+:\d{2}\[(\d+:\d{2})\]/), tag('Duty', /DUTY=\s*(\d+:\d{2})/)].filter(Boolean),
      };
      rows.push(r);
      mark(r, 'co', e.items.to);
      mark(r, 'co_info', e.items.remark);
      dutyDate = null;
      continue;
    }
    if (e.type === 'HOTAC' || e.type === 'Hotel') {
      if (!TIME.test(e.from)) continue; // the stay going on the next day
      const r = { ...base, duty: 'H', dep: lastArr, notes: [e.routing.join(' ')].filter(Boolean) };
      rows.push(r);
      mark(r, 'hotel', e.items.routing);
      continue;
    }
    if (e.type === 'Ground Act.') {
      const desc = e.routing.join(' ');
      const vct = /DUTY=(\d+:\d{2})/.exec(e.remark.join(' '));
      const r = {
        ...base, duty: e.act, begin: fmt(e.from, e.ltFrom), end: fmt(e.to, e.ltTo, min(e.to) != null && min(e.from) != null && min(e.to) < min(e.from) ? 1 : 0),
        notes: [desc && e.act && `[${e.act}: ${desc}]`, vct && `[Duty: ${vct[1]}]`].filter(Boolean),
      };
      rows.push(r);
      for (const [f, c] of [['duty', 'act'], ['begin', 'from'], ['end', 'to'], ['info', 'routing']]) mark(r, f, e.items[c]);
      if (vct) mark(r, 'info', (e.items.remark || []).filter(i => /DUTY=/.test(i.text)));
    }
  }
  // the day line ("Sun 07/04/2024"): the date of the first row on that day (not a C/O of the day before)
  const dated = new Set();
  starts.forEach(([i, e], k) => {
    const day = e.dateItem && dayRow(e.date).date;
    const r = day && !dated.has(e.dateItem) && rows.slice(i, starts[k + 1]?.[0] ?? rows.length).find(x => x.date === day);
    if (r) { dated.add(e.dateItem); mark(r, 'date', e.dateItem); }
  });
  const p = per && `${String(new Date(dmy(per[1], per[2], per[3])).getUTCDate()).padStart(2, '0')}${MONTHS[new Date(dmy(per[1], per[2], per[3])).getUTCMonth()]}${per[3].slice(2)} - ${String(new Date(dmy(per[4], per[5], per[6])).getUTCDate()).padStart(2, '0')}${MONTHS[new Date(dmy(per[4], per[5], per[6])).getUTCMonth()]}${per[6].slice(2)}`;
  const out = rows.map(r => outputRow({ ...r, info: r.notes.join(' ') }, 'Z'));
  return { format: 'crew-roster-by-period', period: p || null, notices: [], recognized: out.length > 0, published: out, planned: [], _trace: trace, _rows: rows };
}

const isKlmFlightHours = (page) => page.items.some(i => /Chronologisch overzicht/.test(i.text)) && page.items.some(i => i.text === 'LIJNNR');

/**
 * KLM "Chronologisch overzicht Vlieguren" (flight hours of a month; "Periode: 01-08-2016 t/m 31-08-2016"), a line per day
 * or leg under the two header lines
 *   AANM  VERT  ...  CMC  ...  AANK  AFML  WC   NW   ...
 *   DG | LIJNNR | ACREG | TIJD | TIJD | VST | TIJDV | F | AST | SDC | TIJDV | TIJD | TIJD | VLGU | VLGU | VDT | (GVDT | WRD |) RUST | DP | FDP | ...
 *   05 | KL 887 | PHBFS | 14:05 | 15:34 | AMS | +2 | CP | HKG | V+ | +8 | 02:30 (+1) | 03:00 (+1) | 10:56 | | 12:55 | ... | 12:55 | 12:25
 *   03 | RV - Reisverlof (a description may go on on the next line: "RVF - Reisverlof" / "Inneembaar")
 * Times UTC (15:34 -> 02:30 is the WC VLGU 10:56 only so; TIJDV is the station's offset). A duty: a C/I row (AANM, VST),
 * a row per leg (LIJNNR, ACREG, VST - AST, VERT - AANK; info "[Block: 10:56]", "[Night: ..]" (NW VLGU), "[SDC: V+]"),
 * a C/O row on the duty's date at the line with AFML (info "[Duty: 12:55] [DP: 12:55] [FDP: 12:25]"); RUST, the rest before
 * the duty, on its C/I ("[Rest: 72:15]").
 * A day code a row of its own ("[RV: Reisverlof]", "RT-B"; AANM - AFML as its times when printed, a simulator day "VA OPS check").
 * A page may go on without the header lines: the page before's columns.
 * The "daggelden" (daily allowances) overview is the same table without the hours, its EUR column as "[EUR: 94.64]".
 * Lines of a layover station only, totals and notes are left out. An older print ("Chronologisch overzicht 01-11-12 T/M
 * 30-11-12") is the same table.
 */
function parseKlmFlightHours(pages) {
  const trace = startTrace();
  const rows = [];
  const all = pages.flatMap(p => p.items.map(i => i.text)).join(' ');
  const per = (/Periode:\s*(\d{2})-(\d{2})-(\d{4})\s*t\/m\s*(\d{2})-(\d{2})-(\d{4})/.exec(all)
    || /(\d{2})-(\d{2})-(\d{2}) T\/M (\d{2})-(\d{2})-(\d{2})\b/.exec(all))?.map((v, k) => (k === 3 || k === 6) && v.length === 2 ? `20${v}` : v);
  if (!per) return { format: 'klm-flight-hours', period: null, notices: [], recognized: false, published: [], planned: [], _trace: trace, _rows: [] };
  const cal = { y: +per[3], m: +per[2] - 1, last: 0 };
  const dayRow = (t) => { const d = new Date(t); return { date: `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${String(d.getUTCFullYear() % 100).padStart(2, '0')}`, day: WEEKDAYS[d.getUTCDay()] }; };
  const TIME = /^\d{1,2}:\d{2}$/, OFF = /^[+-]\d{1,2}$/;
  const hm = (t) => (TIME.test(t) ? t.padStart(5, '0') : '');
  let day = null, duty = null, lastAct = null, cols = null;
  for (const page of pages) {
    const lines = toLines(page.items);
    const hk = lines.findIndex(l => l.items.some(i => i.text === 'LIJNNR'));
    // (a page going on without the header: the columns of the page before)
    if (hk < 0 && !cols) continue;
    lastAct = null;
    if (hk >= 0) {
      // the second header line's words, named by their order ("TIJD" four times: AANM, VERT, AANK, AFML)
      const order = { TIJD: ['report', 'dep', 'arr', 'release'], TIJDV: ['depTz', 'arrTz'], V: ['depTz', 'arrTz'], VLGU: ['block', 'night'], WRD: ['wrd', 'cum'] };
      const seen = {};
      // (an older print joins a word of the line above: "AANK TIJD" is the TIJD column)
      const heads = lines[hk].items.map(i => (/ /.test(i.text) ? { text: i.text.split(' ').at(-1), x: i.x + (i.w || i.text.length * 4.5) * (i.text.lastIndexOf(' ') + 1) / i.text.length } : i));
      cols = heads.map(i => { const k = seen[i.text] = (seen[i.text] || 0) + 1; return { name: order[i.text]?.[k - 1] || i.text, x: i.x }; });
    }
    const xOf = (n) => cols.find(c => c.name === n)?.x;
    // "+1" printed after the arrival / release time: their day offsets
    const offCols = [{ name: 'depDay', x: (xOf('dep') ?? 0) + 26 }, { name: 'depTz', x: xOf('depTz') }, { name: 'arrTz', x: xOf('arrTz') },
      { name: 'arrDay', x: (xOf('arr') ?? 0) + 30 }, { name: 'relDay', x: (xOf('release') ?? 0) + 25 }].filter(c => c.x != null);
    const nearest = (list, x) => list.reduce((a, c) => (Math.abs(c.x - x) < Math.abs(a.x - x) ? c : a)).name;
    for (const line of lines.slice(hk + 1)) {
      const cell = {};
      for (const it of line.items) {
        const name = OFF.test(it.text) ? nearest(offCols, it.x) : it.x < (xOf('DG') ?? 18) + 10 ? 'DG' : nearest(cols.filter(c => c.name !== 'DG'), it.x + 3);
        (cell[name] ||= []).push(it);
      }
      const get = (c) => (cell[c] || []).map(i => i.text).join(' ').trim();
      // a cell's time (an older print puts more over it: "569-02I/0 09:15")
      const hmc = (c) => hm((cell[c] || []).map(i => i.text).find(t => TIME.test(t)) || '');
      // a station ("0 DAR": the VC column's value next to it)
      const ap = (c) => get(c).split(' ').filter(w => /^[A-Z]{3}$/.test(w)).join(' ') || get(c);
      if (/^\d{2}$/.test(get('DG'))) {
        const n = +get('DG');
        if (n < cal.last) { cal.m += 1; if (cal.m > 11) { cal.m = 0; cal.y += 1; } }
        cal.last = n;
        day = Date.UTC(cal.y, cal.m, n);
      }
      if (day == null) continue;
      // ("2012110505112012/F KL 0569": the line's date printed over its flight)
      const flight = /(?:^|\s)([A-Z0-9]{2} ?\d{1,4}[A-Z]?)$/.exec(get('LIJNNR'))?.[1] || '';
      const text = line.items.filter(i => i.x > (xOf('AST') ?? 250) - 15 && !OFF.test(i.text) && !TIME.test(i.text)).map(i => i.text).join(' ');
      if (!flight) {
        // "RV - Reisverlof", "RT-B - Reserve Thuis", "JV Vakantie" (an older print), "VA OPS check" with its times (not a
        // layover's "HKG V+")
        const act = /^([A-Z0-9+](?:[A-Z0-9+-]{0,4}[A-Z0-9+])?) - (.+)$/.exec(text) || /^([A-Z0-9+]{1,5}) ([A-Z][a-z].*)$/.exec(text)
          || (hmc('report') && hmc('release') && /^([A-Z0-9+]{1,5}) ([A-Z].*)$/.exec(text));
        if (act && get('DG')) {
          lastAct = { section: 'published', ...dayRow(day), duty: act[1], begin: hmc('report'), end: hmc('release'), notes: [`[${act[1]}: ${act[2]}]`] };
          rows.push(lastAct);
          mark(lastAct, 'date', cell.DG);
          mark(lastAct, 'begin', cell.report);
          mark(lastAct, 'end', cell.release);
          mark(lastAct, 'duty', line.items.filter(i => i.x > (xOf('AST') ?? 250) - 15 && !TIME.test(i.text)));
        } else if (lastAct && !get('DG') && /^[A-Za-z][\w ./-]*$/.test(text) && !/TOTALEN/.test(text)) {
          lastAct.notes = [lastAct.notes[0].replace(/]$/, ` ${text}]`)]; // the description going on
          mark(lastAct, 'info', line.items);
        } else if (get('DG')) lastAct = null;
        continue;
      }
      lastAct = null;
      if (hmc('report')) {
        const ci = { section: 'published', ...dayRow(day), duty: 'C/I', dep: ap('VST'), begin: hmc('report'), notes: [] };
        rows.push(ci);
        mark(ci, 'ci', cell.report);
        duty = { day, ci };
      }
      const dep = hmc('dep'), arr = hmc('arr');
      const depDay = /^\+(\d)$/.exec(get('depDay'))?.[1] || '';
      const arrDay = /^\+(\d)$/.exec(get('arrDay'))?.[1] ?? (dep && arr && arr < dep ? String(+depDay + 1) : depDay);
      const eur = /^\d+[.,]\d{2}$/.test(get('EUR')) ? `[EUR: ${get('EUR')}]` : '';
      const leg = {
        section: 'published', ...dayRow(day), duty: flight, registration: get('ACREG'), dep: ap('VST'), arr: ap('AST'),
        begin: dep ? `${dep}${+depDay ? `+${depDay}` : ''}` : '', end: arr ? `${arr}${+arrDay ? `+${arrDay}` : ''}` : '',
        notes: [hmc('block') && `[Block: ${hmc('block')}]`, hmc('night') && `[Night: ${hmc('night')}]`, get('SDC') && `[SDC: ${get('SDC')}]`, eur].filter(Boolean),
      };
      rows.push(leg);
      for (const [f, c] of [['date', 'DG'], ['duty', 'LIJNNR'], ['registration', 'ACREG'], ['dep', 'VST'], ['arr', 'AST'], ['begin', 'dep'], ['begin', 'depDay'], ['end', 'arr'], ['end', 'arrDay'], ['info', 'block'], ['info', 'night'], ['info', 'SDC'], ['info', 'EUR']]) mark(leg, f, cell[c]);
      if (hmc('release')) {
        const base = duty?.day ?? day;
        const relDay = /^\+(\d)$/.exec(get('relDay'))?.[1];
        const plus = Math.round((day - base) / 86400000) + (relDay != null ? +relDay : (arr && hmc('release') < arr ? 1 : +arrDay || 0));
        const co = {
          section: 'published', ...dayRow(base), duty: 'C/O', arr: ap('AST'), end: `${hmc('release')}${plus ? `+${plus}` : ''}`,
          notes: [['Duty', 'VDT'], ['DP', 'DP'], ['FDP', 'FDP']].map(([k, c]) => hmc(c) && `[${k}: ${hmc(c)}]`).filter(Boolean),
        };
        rows.push(co);
        mark(co, 'co', cell.release);
        mark(co, 'co', cell.relDay);
        for (const c of ['VDT', 'DP', 'FDP']) mark(co, 'info', cell[c]);
        // RUST: the rest before this duty (since the last release), on its C/I
        if (hmc('RUST') && duty?.ci) { duty.ci.notes.push(`[Rest: ${hmc('RUST')}]`); mark(duty.ci, 'ci_info', cell.RUST); }
        duty = null;
      }
    }
  }
  const fmt = (d, m, y) => `${d}${MONTHS[+m - 1]}${y.slice(2)}`;
  const out = rows.map(r => outputRow({ ...r, info: r.notes.join(' ') }, 'Z'));
  return { format: 'klm-flight-hours', period: `${fmt(per[1], per[2], per[3])} - ${fmt(per[4], per[5], per[6])}`, notices: [], recognized: out.length > 0, published: out, planned: [], _trace: trace, _rows: rows };
}

/** A text file's line as its characters stand (services/table-text.js puts a TXT's character c at x = 20 + 6c). */
function charLine(line) {
  let s = '';
  for (const it of line.items) {
    const col = Math.max(0, Math.round((it.x - 20) / 6));
    s = s.padEnd(col) + it.text;
  }
  return s;
}

const isLotLogbook = (page) => page.items.some(i => /^CZYNNOSC\.ODKOLOWANIE/.test(i.text) || (i.text === 'CZYNNOSC.ODKOLOWANIE'));

/**
 * LOT pilot's logbook as text (fixed width, Polish; a block per period "Okres:20240501-20240531;id;NAME;"):
 *   CZYNNOSC.ODKOLOWANIE  .WYL.SILNIKOW .NALOT.NOC.SAM  .REJS       .TRASA . IL.LAD.   KM          .(K) - kapitan (P) - II pilot
 *   Lot      20240501 0513 20240501 0632 0119      SPLNA LO 460      CPH WAW 1        832             (P)K.Stolecka
 * Columns from the "--------.-------------..." line. A row per line: "Lot" a flight (duty = REJS, dep / arr = TRASA,
 * begin / end = off block / engines off, registration = SAM), "Pax" one flown as a passenger (dc Pax), "Sym" a simulator
 * session (ac = its type in SAM). Times UTC (WAW 08:55 -> RIX 10:02 is the NALOT 01:07 only so). Info "[Flight: 01:19]"
 * ("[Sim: 04:00]"), the landings "[Landing Day/Night: 1]" (no day or night printed), "[KM: 832]"; crew the other
 * pilots "(K)M.Szostak(P)S.Dunin" -> "[K - M.Szostak][P - S.Dunin]". Totals and notes under the table are left out.
 */
function parseLotLogbook(pages) {
  const trace = startTrace();
  const rows = [];
  const periods = [];
  let cut = null; // column starts, from the "-----.-----" line
  const hhmm = (t) => (/^\d{4}$/.test(t) && +t ? `${t.slice(0, 2)}:${t.slice(2)}` : '');
  const ymd = (t) => { const m = /^(\d{4})(\d{2})(\d{2})$/.exec(t); return m ? Date.UTC(+m[1], +m[2] - 1, +m[3]) : null; };
  const dayRow = (t) => { const d = new Date(t); return { date: `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${String(d.getUTCFullYear() % 100).padStart(2, '0')}`, day: WEEKDAYS[d.getUTCDay()] }; };
  for (const page of pages) {
    for (const line of toLines(page.items)) {
      const s = charLine(line);
      const okres = /^Okres:(\d{8})-(\d{8})/.exec(s);
      if (okres) { periods.push(ymd(okres[1]), ymd(okres[2])); continue; }
      if (/^-{4,}\.-{4,}\./.test(s)) { cut = [0, ...[...s.matchAll(/\./g)].map(m => m.index + 1)]; continue; }
      const act = s.slice(0, 8).trim();
      if (!cut || !/^[A-Z][a-z]{2,}$/.test(act)) continue;
      const col = (k) => s.slice(cut[k], cut[k + 1] != null ? cut[k + 1] - 1 : undefined).trim();
      const [offDate, offTime = ''] = col(1).split(/\s+/), [onDate, onTime = ''] = col(2).split(/\s+/);
      const d = ymd(offDate);
      if (d == null) continue;
      const tail = s.slice(cut[8]); // IL.LAD. | KM | the other pilots
      const t = /^\s*(\d+)?\s+(\d+)?\s*(.*)$/.exec(tail) || [];
      const [, landings, km, others = ''] = t;
      const route = /^([A-Z]{3})\s+([A-Z]{3})$/.exec(col(7)) || [];
      const flight = /[A-Z]/.test(col(6)) ? col(6) : '';
      const on = ymd(onDate);
      const days = on != null ? Math.round((on - d) / 86400000) : 0;
      const sim = act === 'Sym';
      const crew = [...others.matchAll(/\(([A-Z]+)\)([^()]+)/g)].map(m => `[${m[1]} - ${m[2].trim()}]`).join('');
      const row = {
        section: 'published', ...dayRow(d), dc: ['Lot', 'Sym'].includes(act) ? '' : act, duty: sim ? act : flight, dep: route[1] || '', arr: route[2] || '',
        begin: offTime, end: onTime ? `${onTime}${days ? `+${days}` : ''}` : '', registration: sim ? '' : col(5), ac: sim ? col(5) : '', crew,
        notes: [hhmm(col(3)) && `[${sim ? 'Sim' : 'Flight'}: ${hhmm(col(3))}]`, +landings ? `[Landing Day/Night: ${+landings}]` : '', +km ? `[KM: ${+km}]` : ''].filter(Boolean),
      };
      if (!row.duty && !row.dep) continue;
      rows.push(row);
      mark(row, 'date', line.items[1]);
      for (const it of line.items) {
        const c = Math.round((it.x - 20) / 6);
        const field = c < cut[1] ? 'dc' : c < cut[5] ? 'begin' : c < cut[6] ? (sim ? 'ac' : 'registration') : c < cut[7] ? 'duty' : c < cut[8] ? 'route' : /^\(/.test(it.text) ? 'crew' : 'info';
        if (field !== 'dc' || row.dc) mark(row, field, it);
      }
    }
  }
  const ok = periods.filter(x => x != null);
  const fmt = (t) => { const x = new Date(t); return `${String(x.getUTCDate()).padStart(2, '0')}${MONTHS[x.getUTCMonth()]}${String(x.getUTCFullYear() % 100).padStart(2, '0')}`; };
  const out = rows.map(r => outputRow({ ...r, info: r.notes.join(' ') }, 'Z'));
  return { format: 'lot-logbook', period: ok.length ? `${fmt(Math.min(...ok))} - ${fmt(Math.max(...ok))}` : null, notices: [], recognized: out.length > 0, published: out, planned: [], _trace: trace, _rows: rows };
}

const isFlicaSchedule = (page) => page.items.some(i => i.text === 'FLICA' || /^[A-Z][a-z]+ Schedule$/.test(i.text)) && page.items.some(i => i.text.split(' ').includes('DPS-ARS'));

// A leg of a FLICA print whose texts run together ("SU 03 DH" "2017" "YYC-YVR" "0651" "0723" "0046 0112" "AC"):
// DY DD [DH] [C|*] FLTNO DPS-ARS DEPL ARRL BLKT [GRNT] [OA] [TBLK [TDHD] TCRD TDUTY/FDP] [LAYOVER station time]
const FLICA_LEG_RE = /^(MO|TU|WE|TH|FR|SA|SU) (\d{2})(?: (DH))?(?: ([C*]))? (\S+) ([A-Z]{3}-[A-Z]{3}) (\d{4}) (\d{4}) (\d{4})(?: (\d{4}|PAY|DRP))?(?: ([A-Z0-9]{2,3}))?(?: (\d{4})(?: (\d{4}))? (\d{4}) (\d{4}\/\d{4}))?(?: ([A-Z]{3} ?\d{3,4}))?$/;
const FLICA_LEG_COLS = ['DY', 'DD', 'DH', 'C', 'FLTNO', 'DPS-ARS', 'DEPL', 'ARRL', 'BLKT', 'GRNT', 'OA', 'TBLK', 'TDHD', 'TCRD', 'TDUTY/FDP', 'LAYOVER'];

/**
 * A FLICA print whose header and leg values run together in a few texts ("DY DD DH C FLTNO DPS-ARS",
 * "ActivityStart DateStart TimeEnd DateEnd TimeCredit"): its header and legs laid out again as one text
 * per column (a column every 40 points from the header's DY), the legs read by their order (FLICA_LEG_RE).
 */
function flicaSeparate(pages) {
  return pages.map((page) => {
    const head = page.items.find(i => /^DY DD\b/.test(i.text));
    if (!head) return page;
    const x0 = head.x;
    const colX = (k) => x0 + 40 * k;
    const lines = toLines(page.items);
    const items = [];
    for (const [n, line] of lines.entries()) {
      const left = line.items.filter(i => i.x < x0 - 5), right = line.items.filter(i => i.x >= x0 - 5);
      items.push(...left);
      const text = right.map(i => i.text).join(' ');
      const at = (k, t) => ({ text: t, x: colX(k), y: line.y, w: 1, h: right[0]?.h || 0 });
      const leg = FLICA_LEG_RE.exec(text);
      if (/^DY DD\b/.test(text) && text.includes('DPS-ARS')) items.push(...FLICA_LEG_COLS.map((c, k) => at(k, c)));
      else if (leg) items.push(...FLICA_LEG_COLS.map((c, k) => leg[k + 1] && at(k, leg[k + 1])).filter(Boolean));
      else if (text.replace(/\s/g, '') === 'ActivityStartDateStartTimeEndDateEndTimeCredit') {
        // the header over the next line's six values: at their places
        const next = lines[n + 1]?.items.filter(i => i.x >= x0 - 5) || [];
        const names = ['Activity', 'Start Date', 'Start Time', 'End Date', 'End Time', 'Credit'];
        if (next.length === names.length) items.push(...names.map((t, k) => ({ ...at(0, t), x: next[k].x })));
        else items.push(...right);
      } else items.push(...right);
    }
    return { ...page, items };
  });
}

/**
 * A FLICA schedule saved as text ("June Schedule", "Last Updated Jul 15, 2022 ..."): after the month's calendar, each
 * pairing in detail —
 *   B5282C : 08JUN | ONLY ON WED | BSE REPT: 1636L | Operates: Jun 8 Only
 *   DY | DD | DH | C | FLTNO | DPS-ARS | DEPL | ARRL | BLKT | GRNT | OA | | TBLK | TDHD | | TCRD | TDUTY/FDP | LAYOVER
 *   WE | 08 |    |   | 641   | BOS-CLE | 1732 | 1947 | 0215 |      |    | | 0215 |      | | 0215 | 0326/0311 | CLE 1347
 *      | D-END: 2002L REPT: 0949L | Hyatt Regency Cleveland A | (216)575-1234
 *   Crew: CA | 4992 | SMITHLING, BRETT | FO | 45831 | YATES, JARED-CK
 * — and single activities ("HST : 22JUN" / Activity | Start Date | Start Time | End Date | End Time | Credit).
 * Rows: a C/I row (BSE REPT, then each REPT), a row per leg (DH -> dc; begin / end local "17:32 L"; info "[Block: 02:15]",
 * a pay-only or dropped leg "[PAY]" / "[DRP]"), a C/O row at each D-END (info the duty's totals "[Block: 02:15] [Deadhead: ..]
 * [Credit: 02:15] [Duty: 03:26] [FDP: 03:11]", at the trip's end also "[TAFB: 51:25] [Trip rig: 00:23]"), a hotel row after it
 * (the layover station, "Hyatt Regency Cleveland A (216)575-1234 [Layover: 13:47]"). The pairing's crew on its flown legs.
 * The year from "Last Updated"; the calendar and the month's totals are left out.
 * Its PDF print is alike: the calendar left of the pairings (left out), values a few points off their headers ("FLT", "GR"),
 * the layover's station and time two texts, the hotel's phone also as "( tel:... )".
 */
function parseFlicaSchedule(pages) {
  const trace = startTrace();
  pages = flicaSeparate(pages);
  const rows = [];
  const items = pages.flatMap(p => p.items);
  const all = items.map(i => i.text).join(' ');
  // (the PDF's calendar: left of the leg header's "DY")
  const dyX = Math.min(...items.filter(i => i.text === 'DY').map(i => i.x));
  const side = items.filter(i => i.x < dyX - 5).sort((a, b) => a.y - b.y || a.x - b.x).map(i => i.text).join(' ');
  const upd = /Last Updated ([A-Z][a-z]{2}) \d{1,2}, (\d{4})/.exec(all) || /Last Updated ([A-Z][a-z]{2}) \d{1,2}, (\d{4})/.exec(side);
  const sched = /\b([A-Z][a-z]+) Schedule\b/.exec(all);
  const monthOf = (name) => MONTHS.findIndex(m => m.toLowerCase() === String(name || '').slice(0, 3).toLowerCase());
  let year = upd ? +upd[2] : new Date().getUTCFullYear();
  if (upd && sched && monthOf(sched[1]) > monthOf(upd[1])) year -= 1; // a December schedule updated in January
  const hm = (t) => (/^\d{4}$/.test(t) ? `${t.slice(0, 2)}:${t.slice(2)}` : '');
  const dur = (t) => (/^\d{3,4}$/.test(t) && +t ? `${t.slice(0, -2).padStart(2, '0')}:${t.slice(-2)}` : '');
  const dayRow = (t) => { const d = new Date(t); return { date: `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${String(d.getUTCFullYear() % 100).padStart(2, '0')}`, day: WEEKDAYS[d.getUTCDay()] }; };
  const ddMon = (t) => { const m = /^(\d{2})([A-Z]{3})$/.exec(t); return m && monthOf(m[2]) >= 0 ? Date.UTC(year, monthOf(m[2]), +m[1]) : null; };
  let head = null;      // the leg header's columns: name -> x
  let pairing = null;   // { start, legs: [], pending: [] } of the pairing being read
  let lastLeg = null, lastDate = null, nextRept = null, dutyDay = null; // dutyDay: the date of the duty's C/I
  let first = null, last = null;
  const legRows = [];
  const flush = () => { if (pairing) for (const r of pairing.legs) if (pairing.crew && r.flown) r.crew = pairing.crew; pairing = null; };
  const ALIAS = { FLT: 'FLTNO', GR: 'GRNT' };
  for (const page of pages) {
    for (const line of toLines(page.items.filter(i => !(i.x < dyX - 5)))) {
      const texts = line.items.map(i => i.text);
      const near = (name) => {
        if (!head || head[name] == null) return null;
        const close = line.items.filter(i => Math.abs(i.x - head[name]) < 5);
        return close.length ? close.reduce((a, c) => (Math.abs(c.x - head[name]) < Math.abs(a.x - head[name]) ? c : a)) : null;
      };
      const at = (name) => near(name)?.text.trim() || '';
      const itemAt = near;
      // a pairing: "B5282C : 08JUN | ... | BSE REPT: 1636L"
      const ph = /^(\S+) : (\d{2}[A-Z]{3})$/.exec(texts[0] || '');
      if (ph) {
        flush();
        const start = ddMon(ph[2]);
        const rept = /BSE REPT: (\d{4})L/.exec(texts.join(' '));
        pairing = { start, legs: [] };
        nextRept = rept ? { time: rept[1], item: line.items.find(i => /BSE REPT/.test(i.text)) } : null;
        lastDate = start;
        continue;
      }
      if (texts[0] === 'DY' && texts.includes('DPS-ARS')) { head = Object.fromEntries(line.items.map(i => [ALIAS[i.text] || i.text, i.x])); continue; }
      if (texts[0] === 'Activity' && texts.includes('Start Date')) { head = Object.fromEntries(line.items.map(i => [i.text, i.x])); continue; }
      if (/^Crew:/.test(texts[0] || '')) continue;
      // the pairing's crew: "CA | 4992 | SMITHLING, BRETT | FO | 45831 | YATES, JARED-CK"
      if (pairing && /^(CA|FO|FA|FE|SO)$/.test(texts[0] || '')) {
        const crew = [];
        for (let k = 0; k + 2 < texts.length; k += 3) if (/^[A-Z]{2}$/.test(texts[k]) && /^\d+$/.test(texts[k + 1])) crew.push(`[${texts[k]} - ${texts[k + 1]} - ${texts[k + 2]}]`);
        pairing.crew = crew.join('');
        for (const r of pairing.legs) if (r.flown) mark(r, 'crew', line.items);
        continue;
      }
      // a single activity: HST | 22JUN | 09:00 | 22JUN | 17:00 | 0400
      if (head && head['Start Date'] != null && ddMon(at('Start Date')) != null && at('Activity')) {
        flush();
        const s = ddMon(at('Start Date')), e = ddMon(at('End Date'));
        const days = e != null ? Math.round((e - s) / 86400000) : 0;
        const row = {
          section: 'published', ...dayRow(s), duty: at('Activity'), begin: at('Start Time').replace(':', ''),
          end: at('End Time') ? `${at('End Time').replace(':', '')}${days ? `+${days}` : ''}` : '', notes: [dur(at('Credit')) && `[Credit: ${dur(at('Credit'))}]`].filter(Boolean),
        };
        // (an activity over several days may be listed under each of them: "VAC : 04MAY", "VAC : 05MAY" .. the same VAC)
        const prev = rows.at(-1);
        if (prev && ['date', 'duty', 'begin', 'end'].every(k => prev[k] === row[k])) continue;
        rows.push(row);
        for (const [f, n] of [['duty', 'Activity'], ['date', 'Start Date'], ['begin', 'Start Time'], ['end', 'End Time'], ['info', 'Credit']]) mark(row, f, itemAt(n));
        first ??= s; last = s;
        continue;
      }
      // the duty end: " | D-END: 2002L REPT: 0949L | hotel | phone" or "D-END: 2001L    T.A.F.B.: 5125    DHD: 0450    TRIP RIG: 0023"
      const dend = /D-END: (\d{4})L/.exec(texts.join(' '));
      if (pairing && dend && lastLeg) {
        const text = texts.join(' ');
        const legEnd = lastLeg.endMin;
        const endMin = +dend[1].slice(0, 2) * 60 + +dend[1].slice(2);
        // on the duty's date (its C/I), "+1" when it ends a later day
        const base = dutyDay ?? lastLeg.t;
        const plus = Math.round((lastLeg.t - base) / 86400000) + (lastLeg.endDays || 0) + (endMin < legEnd ? 1 : 0);
        const totals = lastLeg.totals || [];
        const co = {
          section: 'published', ...dayRow(base), duty: 'C/O', arr: lastLeg.arr, end: `${dend[1]}${plus ? `+${plus}` : ''}`,
          notes: [...totals, ...[['TAFB', /T\.A\.F\.B\.: (\d{3,5})/], ['Trip rig', /TRIP RIG: (\d{3,4})/]].map(([k, re]) => { const m = re.exec(text); return m && dur(m[1]) && `[${k}: ${dur(m[1])}]`; }).filter(Boolean)],
        };
        rows.push(co);
        mark(co, 'co', line.items.find(i => /D-END/.test(i.text)));
        const rept = /REPT: (\d{4})L/.exec(text.replace(/BSE REPT/g, ''));
        nextRept = rept ? { time: rept[1], item: line.items.find(i => /REPT/.test(i.text)) } : null;
        const hotel = texts.slice(1).filter(t => !/D-END|REPT|T\.A\.F\.B|TRIP RIG/.test(t) && !/^(\(|\)|tel:.*)$/.test(t.trim())).join(' ').trim();
        if (hotel && lastLeg.layover) {
          const h = { section: 'published', ...dayRow(base), duty: 'H', dep: lastLeg.layover.station, notes: [hotel, lastLeg.layover.time && `[Layover: ${lastLeg.layover.time}]`].filter(Boolean) };
          rows.push(h);
          mark(h, 'hotel', line.items.slice(1).filter(i => !/D-END/.test(i.text)));
        }
        lastLeg = null;
        continue;
      }
      // a leg: WE | 08 | DH? | C? | 641 | BOS-CLE | 1732 | 1947 | 0215 | GRNT ...
      const route = /^([A-Z]{3})-([A-Z]{3})$/.exec(at('DPS-ARS'));
      if (!pairing || !route || !/^\d{2}$/.test(at('DD'))) continue;
      let t = Date.UTC(new Date(lastDate).getUTCFullYear(), new Date(lastDate).getUTCMonth(), +at('DD'));
      if (t < lastDate - 15 * 86400000) t = Date.UTC(new Date(lastDate).getUTCFullYear(), new Date(lastDate).getUTCMonth() + 1, +at('DD')); // into the next month
      lastDate = t;
      const dep = at('DEPL'), arr = at('ARRL');
      const depMin = +dep.slice(0, 2) * 60 + +dep.slice(2), arrMin = +arr.slice(0, 2) * 60 + +arr.slice(2);
      const endDays = arrMin < depMin ? 1 : 0;
      if (nextRept) {
        const reptMin = +nextRept.time.slice(0, 2) * 60 + +nextRept.time.slice(2);
        const ct = reptMin > depMin ? t - 86400000 : t; // reported the evening before a leg after midnight
        const ci = { section: 'published', ...dayRow(ct), duty: 'C/I', dep: route[1], begin: nextRept.time, notes: [] };
        rows.push(ci);
        mark(ci, 'ci', nextRept.item);
        nextRept = null;
        dutyDay = ct;
      }
      const flag = /^(PAY|DRP)$/.test(at('GRNT')) ? at('GRNT') : '';
      const blk = at('BLKT').trim();
      const tdf = /^(\d{4})\/(\d{4})$/.exec(at('TDUTY/FDP'));
      // ("CLE 1347", or "ATL" and "1317" as two texts)
      const layItem = near('LAYOVER');
      const layTime = layItem && /^[A-Z]{3}$/.test(layItem.text.trim()) ? line.items.find(i => i.x > layItem.x && i.x - layItem.x < 30 && /^\d{3,4}$/.test(i.text))?.text : '';
      const lay = /^([A-Z]{3})\s+(\d{3,4})$/.exec(`${at('LAYOVER')}${layTime ? ` ${layTime}` : ''}`);
      const row = {
        section: 'published', ...dayRow(t), dc: at('DH') === 'DH' ? 'DH' : '', duty: at('FLTNO'), dep: route[1], arr: route[2], begin: dep, end: `${arr}${endDays ? '+1' : ''}`,
        notes: [dur(blk) && `[Block: ${dur(blk)}]`, flag && `[${flag}]`].filter(Boolean), flown: !flag && at('DH') !== 'DH',
      };
      rows.push(row);
      pairing.legs.push(row);
      for (const [f, n] of [['date', 'DD'], ['dc', 'DH'], ['duty', 'FLTNO'], ['route', 'DPS-ARS'], ['begin', 'DEPL'], ['end', 'ARRL'], ['info', 'BLKT'], ['info', 'GRNT']]) if (f !== 'dc' || row.dc) mark(row, f, itemAt(n));
      lastLeg = {
        t, arr: route[2], endMin: arrMin, endDays,
        totals: [['Block', 'TBLK'], ['Deadhead', 'TDHD'], ['Credit', 'TCRD']].map(([k, n]) => dur(at(n)) && `[${k}: ${dur(at(n))}]`).filter(Boolean)
          .concat(tdf ? [dur(tdf[1]) && `[Duty: ${dur(tdf[1])}]`, dur(tdf[2]) && `[FDP: ${dur(tdf[2])}]`].filter(Boolean) : []),
        layover: lay ? { station: lay[1], time: dur(lay[2]) } : null,
      };
      first ??= t; last = t;
    }
  }
  flush();
  const fmt = (t) => { const x = new Date(t); return `${String(x.getUTCDate()).padStart(2, '0')}${MONTHS[x.getUTCMonth()]}${String(x.getUTCFullYear() % 100).padStart(2, '0')}`; };
  // the month of the schedule
  const m = sched ? monthOf(sched[1]) : -1;
  const period = m >= 0 ? `01${MONTHS[m]}${String(year % 100).padStart(2, '0')} - ${new Date(Date.UTC(year, m + 1, 0)).getUTCDate()}${MONTHS[m]}${String(year % 100).padStart(2, '0')}`
    : first != null ? `${fmt(first)} - ${fmt(last)}` : null;
  const out = rows.map(({ flown, ...r }) => outputRow({ ...r, info: r.notes.join(' ') }, 'L'));
  return { format: 'flica-schedule', period, notices: [], recognized: out.length > 0, published: out, planned: [], _trace: trace, _rows: rows };
}

/** The duty table of a "Trip Information" page: its header line (Day | Flight | Departure-Arrival | Start(LT) | ...). */
function findTripInfoHeader(page) {
  if (!page.items.some(i => i.text === 'Trip Information')) return null;
  const lines = toLines(page.items);
  const k = lines.findIndex(l => ['Day', 'Flight', 'Departure-Arrival', 'Start(LT)', 'End(LT)'].every(t => l.items.some(i => i.text === t)));
  if (k < 0) return null;
  const head = lines[k];
  const x = (t) => head.items.find(i => i.text === t)?.x;
  // "Duty Summary" / "Trip Summary" stand on the line above it, over their own columns
  const above = lines[k - 1]?.items || [];
  return {
    y: head.y,
    cols: ['Day', 'Flight', 'Departure-Arrival', 'Start(LT)', 'End(LT)', 'Start', 'End', 'Block', 'A/C', 'Cnx'].filter(x).map(name => ({ name, x: x(name) })),
    summary: above.find(i => i.text === 'Duty Summary')?.x ?? Infinity,
    trip: above.find(i => i.text === 'Trip Summary')?.x ?? Infinity,
  };
}

/**
 * "Trip Information" (one trip of a cargo / charter airline): its duties top down, each
 *   Duty start | 15:15                                  (UTC)        Duty  | 18:45   (Duty Summary)
 *   Mon | 484 | SUU-YQX | 11:45 | 22:30 | 18:45 | 01:00 | 06:15 | 74Y | 01:42      Block | 13:03
 *   Tue | 484 | YQX-RZE | ...                                                     Rest  | 19:30
 *   17Aug | Duty end | 10:00
 * The date on the "Duty end" line is the (UTC) day the duty starts; a leg's weekday is its UTC start day
 * (the year from "Operates: Only on Sun 16Aug2026"). Rows as in the Crew Roster Report: a C/I row (the duty
 * start, dep), a row per leg (duty = Flight, "DH DL1582" -> dc DH; begin / end "18:45 Z / 11:45 L" UTC then
 * local with their day offsets; ac = A/C; info "[Block: 06:15] [Cnx: 01:42]"), a C/O row on the duty's date
 * (the duty end, arr; info the Duty Summary "[Duty: 18:45] [Block: 13:03] [Rest: 19:30]"). The crew of the
 * trip (page "Crew on trip": Pos | Crew ID | Name) is the crew of every flight with an aircraft type.
 * The Trip Summary column (homebase, totals) is left out.
 */
function parseTripInformation(pages) {
  const trace = startTrace();
  const rows = [];
  const DAY = 86400000;
  const all = pages.flatMap(p => p.items.map(i => i.text)).join(' ');
  let year = Number(/Operates:.*?\d{1,2}[A-Z][a-z]{2}(\d{4})/.exec(all)?.[1] || /Date:\s*\d{1,2}[A-Z][a-z]{2}(\d{4})/.exec(all)?.[1] || new Date().getUTCFullYear());
  let lastMonth = -1;
  const minutes = (t) => { const m = /^(\d{1,2}):(\d{2})$/.exec(t || ''); return m ? +m[1] * 60 + +m[2] : null; };
  const isTime = (t) => minutes(t) != null;
  // the trip's crew (page 2): "CP | 2465 | Peter Schweyher"
  const crew = [];
  for (const page of pages) {
    const lines = toLines(page.items);
    const k = lines.findIndex(l => ['Pos', 'Crew ID', 'Name'].every(t => l.items.some(i => i.text === t)));
    if (k < 0) continue;
    for (const l of lines.slice(k + 1)) {
      const [pos, id, ...name] = l.items.map(i => i.text);
      if (!/^[A-Z]{2,4}$/.test(pos || '') || !/^\d+$/.test(id || '') || !name.length) continue;
      crew.push({ text: `[${pos} - ${id} - ${name.join(' ')}]`, items: l.items });
    }
  }
  const crewText = crew.map(c => c.text).join('');
  const crewItems = crew.flatMap(c => c.items);
  const off = (n) => (n ? ` ${n > 0 ? '+' : ''}${n}` : '');
  // "18:45" UTC with its local "11:45": "18:45 Z / 11:45 L -1", day offsets from `base` (the row's date)
  const zl = (utcDay, z, l, base) => {
    const t = utcDay + minutes(z) * 60000;
    let s = `${z} Z${off(Math.floor((t - base) / DAY))}`;
    if (isTime(l)) {
      const offset = ((minutes(l) - minutes(z) + 720 + 2880) % 1440) - 720; // local - UTC, minutes
      s += ` / ${l} L${off(Math.floor((t + offset * 60000 - base) / DAY))}`;
    }
    return { s, t };
  };
  let first = null, last = null;
  for (const page of pages) {
    const header = findTripInfoHeader(page);
    if (!header) continue;
    const colOf = (it) => {
      if (it.x >= header.trip - 3) return 'trip';
      if (it.x >= header.summary - 3) return it.x >= header.summary + 40 ? 'sumValue' : 'sumLabel';
      return [...header.cols].reverse().find(c => it.x >= c.x - 4)?.name || header.cols[0].name;
    };
    let duty = null;
    for (const line of toLines(page.items.filter(i => i.y > header.y + 2))) {
      const cell = {};
      for (const it of line.items) (cell[colOf(it)] ||= []).push(it);
      const get = (c) => (cell[c] || []).map(i => i.text).join(' ').trim();
      const flight = get('Flight');
      if (flight === 'Duty start') duty = { start: get('Start'), startItems: cell.Start, legs: [], summary: [] };
      if (!duty) continue;
      if (get('sumLabel') && get('sumValue')) duty.summary.push({ text: `[${get('sumLabel')}: ${get('sumValue')}]`, value: get('sumValue'), items: [...cell.sumLabel, ...cell.sumValue] });
      if (WEEKDAYS.includes(get('Day')) && flight !== 'Duty start' && flight !== 'Duty end') duty.legs.push({ day: get('Day'), cell, get: (c) => (cell[c] || []).map(i => i.text).join(' ').trim() });
      if (flight !== 'Duty end') continue;
      // the duty's date, then its rows
      const m = /^(\d{1,2})([A-Z][a-z]{2})$/.exec(get('Day'));
      const month = m ? MONTHS.indexOf(m[2]) : -1;
      if (month < 0) { duty = null; continue; }
      if (lastMonth >= 0 && month < lastMonth) year += 1; // December -> January
      lastMonth = month;
      const D = Date.UTC(year, month, +m[1]);
      const dateOf = (t) => { const d = new Date(t); return { date: `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${String(d.getUTCFullYear() % 100).padStart(2, '0')}`, day: WEEKDAYS[d.getUTCDay()] }; };
      const route = (leg) => /^([A-Z]{3})-([A-Z]{3})$/.exec(leg.get('Departure-Arrival')) || [];
      if (isTime(duty.start)) {
        const ci = { section: 'published', ...dateOf(D), duty: 'C/I', dep: route(duty.legs[0] || { get: () => '' })[1] || '', begin: duty.start, notes: [] };
        rows.push(ci);
        mark(ci, 'ci', duty.startItems);
      }
      let lastEnd = D + (minutes(duty.start) || 0) * 60000;
      for (const leg of duty.legs) {
        const g = leg.get;
        // its UTC start day: the first day from the duty's date with its weekday
        const day = D + ((WEEKDAYS.indexOf(leg.day) - new Date(D).getUTCDay() + 7) % 7) * DAY;
        const begin = isTime(g('Start')) ? zl(day, g('Start'), g('Start(LT)'), day) : null;
        let endDay = day;
        if (begin && isTime(g('End')) && minutes(g('End')) < minutes(g('Start'))) endDay += DAY;
        const end = isTime(g('End')) ? zl(endDay, g('End'), g('End(LT)'), day) : null;
        const [, dep = '', arr = ''] = route(leg);
        const dh = /^DH\s+(.+)$/.exec(g('Flight'));
        const ac = g('A/C') === '-' ? '' : g('A/C');
        const row = {
          section: 'published', ...dateOf(day), dc: dh ? 'DH' : '', duty: dh ? dh[1] : g('Flight'), dep, arr,
          begin: begin?.s || '', end: end?.s || '', ac, crew: ac ? crewText : '',
          notes: [isTime(g('Block')) && `[Block: ${g('Block')}]`, isTime(g('Cnx')) && `[Cnx: ${g('Cnx')}]`].filter(Boolean),
        };
        rows.push(row);
        for (const [f, c] of [['date', 'Day'], ['duty', 'Flight'], ['route', 'Departure-Arrival'], ['begin', 'Start'], ['begin', 'Start(LT)'], ['end', 'End'], ['end', 'End(LT)'], ['ac', 'A/C']]) mark(row, f, leg.cell[c]);
        if (isTime(g('Block'))) mark(row, 'info', leg.cell.Block);
        if (isTime(g('Cnx'))) mark(row, 'info', leg.cell.Cnx);
        if (ac) mark(row, 'crew', crewItems);
        first ??= day;
        last = day;
        if (end) lastEnd = end.t;
      }
      if (isTime(get('End'))) {
        // the duty end: at or after its last leg's arrival
        let t = D + Math.floor((lastEnd - D) / DAY) * DAY + minutes(get('End')) * 60000;
        if (t < lastEnd) t += DAY;
        const lastLeg = duty.legs.at(-1);
        const co = {
          section: 'published', ...dateOf(D), duty: 'C/O', arr: lastLeg ? route(lastLeg)[2] || '' : '',
          end: `${get('End')}${Math.floor((t - D) / DAY) ? `+${Math.floor((t - D) / DAY)}` : ''}`,
          notes: duty.summary.filter(s => s.value !== '-').map(s => s.text),
        };
        rows.push(co);
        mark(co, 'co', cell.End);
        for (const s of duty.summary.filter(x => x.value !== '-')) mark(co, 'info', s.items);
      }
      first ??= D;
      last = Math.max(last ?? D, D);
      duty = null;
    }
  }
  const fmt = (t) => { const d = new Date(t); return `${String(d.getUTCDate()).padStart(2, '0')}${MONTHS[d.getUTCMonth()]}${String(d.getUTCFullYear() % 100).padStart(2, '0')}`; };
  const out = rows.map(r => outputRow({ ...r, info: r.notes.join(' ') }));
  return { format: 'trip-information', period: first != null ? `${fmt(first)} - ${fmt(last)}` : null, notices: [], recognized: out.length > 0, published: out, planned: [], _trace: trace, _rows: rows };
}

/**
 * Pieces of one word printed letter by letter ("A" "c" "t" "i" "v" "i" "ty", "V" "CP", "29" "AGO" "21":
 * a web page printed with letter spacing) joined into one item: pieces on a line that touch (less
 * than half a point apart). Such prints draw ":" as an unmapped glyph (\u0000): "10\u000000" -> "10:00".
 */
function joinTouching(items) {
  const out = [];
  for (const it of [...items].sort((a, b) => a.y - b.y || a.x - b.x)) {
    const prev = out.at(-1);
    const gap = prev ? it.x - (prev.x + prev.w) : Infinity;
    if (prev && Math.abs(prev.y - it.y) < 1 && gap < 0.5 && gap > -1.5) out[out.length - 1] = { ...prev, text: prev.text + it.text, w: it.x + it.w - prev.x };
    else out.push(it);
  }
  for (const it of out) it.text = it.text.replace(/(\d)\u0000(\d)/g, '$1:$2');
  return out;
}

function findActivityListHeader(page) {
  for (const line of toLines(page.items)) {
    const at = (t) => line.items.find(i => i.text === t);
    if (!['Activity', 'Checkin', 'Checkout', 'AcVer'].every(at)) continue;
    // "Night" / "Total" (over "Time") may sit on the line above
    const near = (t) => at(t) || page.items.find(i => i.text === t && Math.abs(i.y - line.y) < 16);
    // a value sits around the middle of its header word (dates start well left of "Start", "End")
    return { y: line.y, cols: ACTIVITY_LIST_COLS.map(name => near(name)).filter(Boolean).map(i => ({ name: i.text, x: i.x, mid: i.x + i.w / 2 })) };
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
 * Checkout a C/O row (arr, end). Some exports repeat the duty's Checkin / Checkout on every leg, others print a Checkout
 * per leg: one C/I before its first leg, one C/O after its last (the last leg's Checkout, before another activity or a
 * new Checkin; an activity printing the duty's Checkin, RES or BUS before the legs, is in it). A day off (FR) prints a
 * Checkout but no Checkin: no C/O. Times are UTC (no zone printed; the off days of
 * Brazilian crews start at 03:00, i.e. midnight in Brasilia).
 * Other exports print an activity on two or three lines: the time under its date ("02JUN23" / "16:20", "31/05/2023," /
 * "18:05:00"), maybe the date above the line ("01NOV11" / "SCH ..." / "02:00"), the crew going on below ("NAME - FA,NAME
 * - CA" -> "[FA - NAME][CA - NAME]"); some add Daytime / Night Time / Total Time ("[Block: ..] [Night: ..]") and Prefix
 * (the registration: "PR-" over "AZD").
 */
function parseActivityList(pages) {
  const trace = startTrace();
  if (!pages.some(findActivityListHeader)) pages = pages.map(p => ({ ...p, items: joinTouching(p.items) }));
  const rows = [];
  const stamp = (text) => {
    const t = String(text).replace(/\s*:\s*/g, ':').replace(/\s+/g, ' ').trim();
    const dmy = /^(\d{2})\/(\d{2})\/\d{2}(\d{2}),?\s*(\d{1,2}):(\d{2})(?::\d{2})?$/.exec(t);
    const m = dmy ? [dmy[0], dmy[1], MONTHS[+dmy[2] - 1]?.toUpperCase(), dmy[3], dmy[4], dmy[5]] : /^(\d{2})([A-Z]{3})(\d{2})\s*(\d{1,2}):(\d{2})(?::\d{2})?$/.exec(t);
    if (!m || !m[2] || monthIndex(m[2]) < 0) return null;
    const [day, month, year] = [Number(m[1]), monthIndex(m[2]), 2000 + Number(m[3])];
    return { date: `${day} ${MONTHS[month]} ${m[3]}`, day: WEEKDAYS[new Date(year, month, day).getDay()], time: `${m[4].padStart(2, '0')}${m[5]}`, t: Date.UTC(year, month, day) };
  };
  let lastCI = null;   // the C/I value printed last ("30MAR23 21:40"), so a repeated one makes no new row
  let pendingCO = null; // { row }: the C/O waits until its duty's last leg
  let onDuty = false;   // a Checkin opened a duty its C/O has not closed yet
  const flushCO = () => { if (pendingCO) { rows.push(pendingCO.row); pendingCO = null; onDuty = false; } };
  let first = null, last = null;
  let header = null;
  let carry = null; // a page's last activity cut by the page end (its times on the next page)
  for (const page of pages) {
    // the next pages may go on without the header line: its columns stay
    const own = findActivityListHeader(page);
    header = own || (header && { ...header, y: -Infinity });
    if (!header) continue;
    const cat = header.cols.find(c => c.name === 'CAT'), system = header.cols.find(c => c.name === 'System');
    const colOf = (it) => {
      const mid = it.x + it.w / 2;
      // the crew's names run from right of CAT to System (its header word is far right of them)
      if (cat && header.cols.some(c => c.name === 'Crew') && it.x >= cat.mid + 12 && (!system || it.x < system.x - 15)) return 'Crew';
      return header.cols.reduce((a, c) => (Math.abs(c.mid - mid) < Math.abs(a.mid - mid) ? c : a)).name;
    };
    // an activity's lines: its own (an Activity value), a date line just above it, the lines below it until the next
    const lines = toLines(page.items.filter(i => i.y > header.y + 2));
    const actX = header.cols.find(c => c.name === 'Activity');
    const isAct = (l) => l.items.some(i => i.x < actX.mid + 20 && colOf(i) === 'Activity' && i.text !== '-');
    // (the cut activity first, its lines above this page's)
    const records = carry ? [{ y: -Infinity, items: carry }] : [];
    carry = null;
    let pre = null;
    for (const [k, l] of lines.entries()) {
      const next = lines.slice(k + 1).find(isAct);
      if (isAct(l)) { records.push({ ...l, items: [...(pre || []), ...l.items] }); pre = null; }
      else if (next && next.y - l.y <= 8 && !pre) pre = l.items;
      else if (records.length) records.at(-1).items.push(...l.items);
    }
    for (const [n, line] of records.entries()) {
      // pieces of one value printed apart ("01AGO22 15" ":" "00", "01MAR18" "03:00") make one cell item
      const pieces = [];
      for (const it of [...line.items].sort((a, b) => a.y - b.y || a.x - b.x)) {
        const prev = pieces.at(-1);
        if (prev && Math.abs(prev.y - it.y) < 2 && it.x - (prev.x + prev.w) < 3) {
          prev.text += (/:$/.test(prev.text) || it.text === ':' ? '' : ' ') + it.text;
          prev.w = it.x + it.w - prev.x;
          prev.parts.push(it);
        } else pieces.push({ ...it, parts: [it] });
      }
      const cell = {};
      for (const pc of pieces) (cell[colOf(pc)] ||= []).push(pc);
      const get = (c) => { const t = (cell[c] || []).map(i => i.text).join(' ').trim(); return t === '-' ? '' : t; };
      const activity = get('Activity').replace(/ -$/, ''); // a "-" of an empty Checkin close to it
      const start = stamp(get('Start')), end = stamp(get('End'));
      if (activity && !start && n === records.length - 1 && /\d/.test(get('Start'))) { carry = line.items.map(i => ({ ...i, y: i.y - 10000 })); continue; }
      if (!activity || !start) continue; // the crew member's name line, a page footer
      const ci = stamp(get('Checkin')), co = stamp(get('Checkout'));
      // a flight (an aircraft, or a flight number) goes on its duty, so does an activity printing the duty's Checkin
      // (RES, BUS before the legs); another activity (FR) ends it
      const flight = !!get('AcVer') || /^[A-Z0-9]{2}\d{3,4}[A-Z]?$/.test(activity);
      if (!flight && !get('Checkin')) flushCO();
      if (ci && get('Checkin') !== lastCI) {
        flushCO();
        const ciRow = { section: 'published', date: ci.date, day: ci.day, duty: 'C/I', dep: get('Dep'), begin: ci.time, notes: [] };
        rows.push(ciRow);
        mark(ciRow, 'ci', cell.Checkin?.flatMap(pc => pc.parts));
        lastCI = get('Checkin');
        onDuty = true;
      }
      const after = (x) => { const d = Math.round((x.t - start.t) / 86400000); return d > 0 ? `${x.time}+${d}` : x.time; };
      const hhmm = (t) => (/^\d{1,2}:\d{2}$/.test(t) && /[1-9]/.test(t) ? t.padStart(5, '0') : '');
      // "NAME - FA,NAME - CA" -> "[FA - NAME][CA - NAME]"
      const crewText = get('Crew').replace(/\s+/g, ' ');
      const crewList = [...crewText.matchAll(/\s*([^,]+?)\s+-\s+([A-Z]{2,3})\s*(?:,|$)/g)];
      const crew = crewList.length && crewList.map(c => c[0]).join('').replace(/\s/g, '') === crewText.replace(/\s/g, '')
        ? crewList.map(c => '[' + c[2] + ' - ' + c[1].trim() + ']').join('') : crewText;
      const event = {
        section: 'published', date: start.date, day: start.day, duty: activity, dc: get('CAT'), dep: get('Dep'), begin: start.time,
        arr: get('Arr'), end: end ? after(end) : '', ac: get('AcVer'), registration: get('Prefix').replace(/\s+/g, ''), crew,
        notes: [hhmm(get('Total')) && '[Block: ' + hhmm(get('Total')) + ']', hhmm(get('Night')) && '[Night: ' + hhmm(get('Night')) + ']'].filter(Boolean),
      };
      rows.push(event);
      for (const [f, c] of [['duty', 'Activity'], ['date', 'Start'], ['begin', 'Start'], ['dep', 'Dep'], ['arr', 'Arr'], ['end', 'End'], ['ac', 'AcVer'], ['dc', 'CAT'], ['crew', 'Crew'], ['registration', 'Prefix'], ['info', 'Total'], ['info', 'Night']]) mark(event, f, cell[c]?.flatMap(pc => pc.parts));
      first ||= start;
      last = end || start;
      // a Checkout printed on every leg: only the duty's last one's (before another activity or a new Checkin) is its C/O
      // (a day off (FR, FP) prints a Checkout too, but outside a duty opened by a Checkin: no C/O)
      if (co && onDuty) {
        const coRow = { section: 'published', date: co.date, day: co.day, duty: 'C/O', arr: get('Arr'), end: co.time, notes: [] };
        mark(coRow, 'co', cell.Checkout?.flatMap(pc => pc.parts));
        pendingCO = { row: coRow };
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
  if (!top || !bottom || !mid) return findLogBookHeader2(page);
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
 * The other print's header, lines a few points apart:
 *   A/C | A/C | Rot. | Act. Rest | Act. | Act. Rest | Block | Flight | Simu
 *   Dep. Date | Act. | Begin | End | Arr. Date | Description | Role | Dep | Arr | (Flight / Simu) Time
 *   Type | Registr. | No | Before | CheckIn | After | Time | Time | Time | (Flight / Simu Time) Night
 */
function findLogBookHeader2(page) {
  const main = page.items.find(i => i.text === 'Dep. Date');
  if (!main) return null;
  const near = page.items.filter(i => Math.abs(i.y - main.y) <= 12);
  const x = (t, sameLine = false) => near.filter(i => i.text === t && (!sameLine || Math.abs(i.y - main.y) < 2)).sort((a, b) => a.x - b.x)[0]?.x;
  if (x('Registr.') == null || x('CheckIn') == null) return null;
  return {
    y: Math.max(...near.map(i => i.y)) + 4,
    cols: [
      ['dateDep', main.x], ['type', x('Act.', true)], ['begin', x('Begin')], ['end', x('End')], ['dateArr', x('Arr. Date')], ['desc', x('Description')],
      ['acType', x('Type')], ['reg', x('Registr.')], ['role', x('Role')], ['dep', x('Dep')], ['arr', x('Arr')], ['rot', x('Rot.')], ['restBefore', x('Before')],
      ['checkin', x('CheckIn')], ['restAfter', x('After')], ['block', x('Block')], ['flight', x('Flight')], ['night', x('Night')], ['simu', x('Simu')],
      // (dates start some points left of their headers)
    ].filter(([, cx]) => cx != null).map(([name, cx]) => ({ name, x: cx - 4 })).sort((a, b) => a.x - b.x),
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

// "mi. 01 dic.", "sá. 04 dic.", "sa., 01 nov."; in English "Wed 01-May-2024"
const DAYBLOCK_DATE_RE = /^(?:[a-záéíóú]{2}\.,?\s+(\d{1,2})\s+([a-z]{3})\.?|[A-Z][a-z]{2}\s+(\d{1,2})-([A-Za-z]{3})-\d{4})$/i;
// "Periodo 01/12/2021 - 01/01/2022", "Period 01/11/2025 - 30/11/2025", "From 2024-05-01 to 2024-05-31"
const DAYBLOCK_PERIOD_RE = /Periodo?\s+(\d{2})\/(\d{2})\/(\d{4})\s*-\s*(\d{2})\/(\d{2})\/(\d{4})|From (\d{4})-(\d{2})-(\d{2}) to (\d{4})-(\d{2})-(\d{2})/;
const DAYBLOCK_HEAD_RE = /^(Descr\.\s*C[oó]digo|Code Descr\.|Fleet)$/;

/** The day-block columns of a page: x of each "Descr. Código" header ("Code Descr.", "Fleet" in English; Air Nostrum style crew schedule). */
function findDayBlockHeader(page) {
  const heads = page.items.filter(i => DAYBLOCK_HEAD_RE.test(i.text));
  if (!heads.length || !page.items.some(i => /^(Fecha|Date):$/.test(i.text)) || !page.items.some(i => /^(Tripulaci[oó]n|(FA )?Crew)$/.test(i.text))) return null;
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
 * The English prints are alike: "From 2024-05-01 to 2024-05-31 - UTC time", Code Descr. | Flight | DEP-ARR | STD - STA | Crew,
 * "Date: Wed 01-May-2024  Signin: 8:40", "Totals : Blq"; or Fleet | Flight "IB 2262" | DEP-ARR | STD - STA | Block T. | FA Crew,
 * "Date: sa., 01 nov.  Sign in Time: 10:45 LT" (a local time), "Pos flt IB" positioning. A flight of the next day starts with
 * that day ("lu. 27 may. ATM IB8383 ..."); a simulator's report and release around its times ("SCOI [04:30] 6:00 - 10:00
 * [11:00]") make C/I and C/O rows.
 */
function parseDayBlocks(pages) {
  const trace = startTrace();
  const rows = [];
  const per = pages.flatMap(p => p.items).map(i => DAYBLOCK_PERIOD_RE.exec(i.text)).find(Boolean);
  // [day, month, year] of the period's first and last day
  const ends = per && (per[1] ? [[per[1], per[2], per[3]], [per[4], per[5], per[6]]] : [[per[9], per[8], per[7]], [per[12], per[11], per[10]]]);
  const from = ends ? { m: Number(ends[0][1]) - 1, y: Number(ends[0][2]) } : null;
  const hhmm = (t) => { const m = /^(\d{1,2}):(\d{2})$/.exec(t); return m ? `${m[1].padStart(2, '0')}${m[2]}` : ''; };
  const dayOf = (dd, monText) => {
    const mon = monthIndex(monText.slice(0, 3));
    if (mon < 0 || !from) return null;
    const year = from.y + (mon < from.m ? 1 : 0); // "01 ene." after December: the next year
    return { date: `${Number(dd)} ${MONTHS[mon]} ${String(year).slice(2)}`, day: WEEKDAYS[new Date(year, mon, Number(dd)).getDay()] };
  };
  const days = [];
  for (const page of pages) {
    const header = findDayBlockHeader(page);
    if (!header) continue;
    // ("Date:" stands up to ~16 pt left of "Fleet")
    const groupOf = (x) => header.starts.filter(st => x >= st - 20).length - 1;
    const groups = header.starts.map(() => []);
    for (const it of page.items) if (it.y > header.y + 2 && groupOf(it.x) >= 0) groups[groupOf(it.x)].push(it);
    for (const [g, items] of groups.entries()) {
      const x0 = header.starts[g];
      // the columns from the header's words (Vuelo / Flight, ORI-DES / DEP-ARR, STD - STA, Block T., Tripulación / Crew); values start up to
      // ~5 pt left of them
      const hx = (re, dx) => page.items.find(i => re.test(i.text) && Math.abs(i.y - header.y) < 3 && i.x > x0 && i.x < x0 + 160)?.x ?? x0 + dx;
      const bounds = [['code', hx(/^(Vuelo|Flight)$/, 42)], ['route', hx(/^(ORI-DES|DEP-ARR)$/, 72)], ['times', hx(/^STD - STA$/, 101)],
        ['block', hx(/^Block T\.$/, Infinity)], ['crew', hx(/^(Tripulaci[oó]n|(FA )?Crew)$/, 132)]].sort((a, b) => a[1] - b[1]);
      const colOf = (x) => bounds.reduce((c, [name, bx]) => (x >= bx - 5 ? name : c), 'descr');
      let day = null;
      for (const line of toLines(items, 3)) {
        const texts = line.items.map(i => i.text);
        const fi = texts.findIndex(t => /^(Fecha|Date):$/.test(t));
        if (fi >= 0) {
          const d = DAYBLOCK_DATE_RE.exec(texts[fi + 1] || '');
          const at = d && dayOf(d[1] || d[3], d[2] || d[4]);
          if (at) {
            day = { ...at, items: [line.items[fi], line.items[fi + 1]], ci: null };
            days.push(day);
            const firma = texts.findIndex(t => /^(Firma|Signin|Sign in Time):$/.test(t));
            if (firma >= 0 && hhmm(texts[firma + 1] || '')) {
              // ("10:45 LT": local, not UTC like the rest)
              day.ci = { section: 'published', date: day.date, day: day.day, duty: 'C/I', begin: `${texts[firma + 2] === 'LT' ? '!' : ''}${hhmm(texts[firma + 1])}`, notes: [] };
              rows.push(day.ci);
              mark(day.ci, 'ci', [line.items[firma + 1]]);
            }
          } else day = null;
          continue;
        }
        if (!day) continue;
        if (texts.some(t => /^Total(es|s)?\b/.test(t))) continue;
        const cell = {};
        for (const it of line.items) (cell[colOf(it.x)] ||= []).push(it);
        const get = (c) => (cell[c] || []).map(i => i.text).join(' ').replace(/\s+/g, ' ').trim();
        const code = get('code').replace(/^([A-Z0-9]{2}) (\d{1,4})$/, '$1$2'); // "IB 2262"
        if (!code || code === '-' || /\s/.test(code)) continue; // (not the legend's sentences beside the last days)
        // a simulator's report and release in brackets: "[04:30] 6:00 - 10:00 [11:00]"
        const brackets = line.items.filter(i => /^\[\d{1,2}:\d{2}\]$/.test(i.text));
        const timeText = (cell.times || []).filter(i => !brackets.includes(i)).map(i => i.text).join(' ');
        const times = /^(\d{1,2}:\d{2})\s*-\s*(\d{1,2}:\d{2})$/.exec(timeText.trim());
        const [begin, end] = times ? [hhmm(times[1]), hhmm(times[2])] : ['', ''];
        const route = /^([A-Z]{3})[A-Z0-9]?-([A-Z]{3})[A-Z0-9]?$/.exec(get('route')); // ("NCE-MAD1", "MADS-CMN": a terminal after the code)
        const crew = get('crew');
        const flight = !!route;
        const allDay = begin === '0000' && end === '0000';
        // a flight of the next day: "lu. 27 may. ATM"
        const next = /^[a-záéíóú]{2}\.,?\s+(\d{1,2})\s+([a-z]{3})\.\s*(.*)$/i.exec(get('descr'));
        const when = (next && dayOf(next[1], next[2])) || day;
        const descr = next ? next[3] : get('descr');
        const dh = /^(Situaci[oó]n|Pos flt\b)/i.test(crew);
        const [rep, rel] = brackets.map(i => hhmm(i.text.slice(1, -1)));
        if (rep) { const c = { section: 'published', date: when.date, day: when.day, duty: 'C/I', begin: rep, notes: [] }; rows.push(c); mark(c, 'ci', brackets[0]); }
        const row = {
          section: 'published', date: when.date, day: when.day, duty: code, notes: [],
          dep: route ? route[1] : '', arr: route ? route[2] : '',
          begin: allDay ? '' : begin, end: allDay ? '' : `${end}${end && begin && end < begin ? '+1' : ''}`,
          ac: flight && /^[A-Z0-9]{3}$/.test(descr) ? descr : '',
          dc: flight && dh ? 'DHD' : '',
          crew: flight && !dh ? crew : '',
        };
        rows.push(row);
        if (rel) { const c = { section: 'published', date: when.date, day: when.day, duty: 'C/O', end: `${rel}${rel < (rep || begin) ? '+1' : ''}`, notes: [] }; rows.push(c); mark(c, 'co', brackets[1]); }
        if (day.ci && !day.ci.dep && row.dep) day.ci.dep = row.dep;
        if (day.items) { mark(row, 'date', day.items); day.items = null; }
        for (const [f, c] of [['duty', 'code'], ['dep', 'route'], ['arr', 'route'], ['begin', 'times'], ['end', 'times'], ['ac', 'descr'], ['crew', 'crew']]) mark(row, f, cell[c]?.filter(i => !brackets.includes(i)));
      }
    }
  }
  // the columns are read one after the other: put the rows in date order (a day's rows keep their order)
  const t = (r) => { const [d, mon, yy] = r.date.split(' '); return Date.UTC(2000 + Number(yy), MONTHS.indexOf(mon), Number(d)); };
  const ordered = rows.map((r, i) => [r, i]).sort((a, b) => t(a[0]) - t(b[0]) || a[1] - b[1]).map(([r]) => r);
  const out = ordered.map(r => outputRow({ ...r, info: r.notes.join(' ') }));
  const pad = ([d, m, y]) => `${d}${MONTHS[Number(m) - 1]}${y.slice(2)}`;
  return {
    format: 'day-blocks', period: ends ? `${pad(ends[0])} - ${pad(ends[1])}` : null,
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
 * Jeppesen "Released Roster" (Lufthansa CityLine, "Month: June 2026", "Created ... (UTC) by Jeppesen"):
 *   30 Sat | 143302 | 13:50 | FO | 1754 | MUC | ATH | 13:10 | 15:45 | 32Y | | +03:00 | LSW | BZW | Tags | 02:35 | FDP LAW | .. | duty time | .. | rest ..
 * Date / Report in local time, Start / End in UTC. A day's first line has its date; its other legs follow
 * without one. Report -> a C/I row (local, Trip ID in its info); the duty's last leg has the duty columns
 * filled (FDP LAW = report to on-block, duty time = report to release): the C/O is its end + duty - FDP,
 * with [Duty: x] [Rest: x]; Blocktime -> [Block: x], Layover -> [Layover: x], Tags -> [ORTSTAG].
 * A leg over local midnight is printed on two days ("1672 MUC 19:50" then "1672 CLJ (07) 21:30", the
 * end's UTC day in brackets): one row on the first day. The month's days are printed with the last
 * days of the month before ("30 Sat", "31 Sun", "01 Mon"): each date's month is the one its weekday fits.
 */
const RELEASED_ROSTER_COLS = [['Date', 'date'], ['Trip ID', 'trip'], ['Report', 'report'], ['Pos', 'pos'], ['Activity', 'act'], ['From', 'from'], ['To', 'to'],
  ['Start', 'start'], ['End', 'end'], ['A/C', 'ac'], ['Layover', 'layover'], ['Timezone', 'tz'], ['LSW', 'lsw'], ['BZW', 'bzw'], ['Tags', 'tags'],
  ['Blocktime', 'block'], ['FDP', 'fdp']];
const lineTexts = (page) => toLines(page.items).map(l => l.items.map(i => i.text).join(' '));
const isReleasedRoster = (page) => lineTexts(page).some(t => /^Released ?Roster$/.test(t)) && lineTexts(page).some(t => /Report ?\(?LT\)?/.test(t) && /Blocktime/.test(t));
// The columns' places (of the text print), from Blocktime's: for an OCR'd page, whose header words run together
// ("Start(UTC)End(UTC)A/CLayoverTimeZone").
const RELEASED_ROSTER_X = { date: 44, trip: 78, report: 106, pos: 146, act: 163, from: 207, to: 229, start: 252, end: 291, ac: 327, layover: 346, tz: 377,
  lsw: 415, bzw: 438, tags: 460, block: 494, fdp: 532, fdpMtv: 554, duty: 599, work: 622, restMin: 644, rest: 669, restEnd: 696 };

function findReleasedRosterHeader(page) {
  for (const line of toLines(page.items, page.ocr ? 4 : 1.5)) {
    const text = line.items.map(i => i.text).join('').toLowerCase();
    const block = line.items.find(i => i.text === 'Blocktime');
    if (!/trip/.test(text) || !text.includes('activity') || !block) continue;
    if (!line.items.some(i => /^Report \(?LT\)?$/.test(i.text))) {
      return { y: line.y, cols: Object.entries(RELEASED_ROSTER_X).map(([key, x]) => ({ key, x: block.x + x - RELEASED_ROSTER_X.block })) };
    }
    const cols = [];
    for (const [name, key] of RELEASED_ROSTER_COLS) {
      const it = line.items.find(i => i.text.replace(/ \(?(LT|UTC)\)?$/, '') === name);
      if (it && !cols.some(c => c.key === key)) cols.push({ key, x: it.x });
    }
    // duty time / work time / rest time ..: the columns right of the FDPs
    const fdps = line.items.filter(i => i.text === 'FDP');
    if (fdps.length) cols.find(c => c.key === 'fdp').x = fdps[0].x;
    const duty = line.items.find(i => i.text === 'duty');
    if (duty) cols.push({ key: 'duty', x: duty.x });
    const work = line.items.find(i => i.text === 'work');
    if (work) cols.push({ key: 'work', x: work.x });
    const rests = line.items.filter(i => i.text === 'rest');
    if (rests[1]) cols.push({ key: 'restMin', x: rests[0].x }, { key: 'rest', x: rests[1].x }, { key: 'restEnd', x: rests[2]?.x ?? Infinity });
    const fdpMtv = fdps[1]; // the FDP LAW column ends where FDP MTV begins
    if (fdpMtv) cols.push({ key: 'fdpMtv', x: fdpMtv.x });
    return { y: line.y, cols: cols.sort((a, b) => a.x - b.x) };
  }
  return null;
}

function parseReleasedRoster(pages) {
  const trace = startTrace();
  const all = pages.flatMap(p => p.items.map(i => i.text)).join(' ');
  const mon = /Month:\s*([A-Z][a-z]+) (\d{4})/.exec(all);
  const month = mon ? MONTHS.findIndex(m => mon[1].startsWith(m)) : -1;
  const year = mon ? Number(mon[2]) : 0;
  const rows = [];
  const hhmm = (t) => { const m = /^(\d{1,3}):(\d{2})$/.exec(t || ''); return m ? Number(m[1]) * 60 + Number(m[2]) : null; };
  const clock = (n) => `${String(Math.floor(((n % 1440) + 1440) % 1440 / 60)).padStart(2, '0')}:${String(((n % 60) + 60) % 60).padStart(2, '0')}`;
  let head = null; // the current day's date and weekday
  let ci = null; // the open duty's C/I row
  for (const page of month < 0 ? [] : pages) {
    const header = findReleasedRosterHeader(page);
    if (!header) continue;
    const colOf = (x) => header.cols.filter(c => x >= c.x - 4).pop()?.key;
    // (OCR: the words of a line a few points apart)
    for (const line of toLines(page.items.filter(i => i.y > header.y + 2), page.ocr ? 4 : 1.5)) {
      if (/^Created\b/.test(line.items[0].text)) break; // the footer
      if (!line.items.some(i => /\d/.test(i.text))) continue; // the header's lower lines
      const cell = {};
      for (const it of line.items) (cell[colOf(it.x)] ||= []).push(it);
      // (OCR: "13:10Z" for 13:10)
      const get = (k) => (cell[k] || []).map(i => i.text).join(' ').trim().replace(/(\d:\d{2})Z(?=\s|$)/g, '$1');
      const dm = /^(\d{2}) ?(Mon|Tue|Wed|Thu|Fri|Sat|Sun)$/.exec(get('date'));
      if (dm) {
        // the month (this one, the one before or after) whose day has this weekday
        const d = [month, month - 1, month + 1].map(m => new Date(Date.UTC(year, m, Number(dm[1])))).find(x => WEEKDAYS[x.getUTCDay()] === dm[2] && x.getUTCDate() === Number(dm[1]));
        if (!d) continue;
        head = { section: 'published', date: `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${String(d.getUTCFullYear() % 100).padStart(2, '0')}`, day: dm[2] };
      }
      if (!head) continue;
      const added = [];
      const add = (r, marks) => { const row = { ...head, notes: [], ...r }; rows.push(row); added.push(row); for (const [f, its] of marks) if (its?.length) mark(row, f, its); return row; };
      if (get('report')) {
        ci = add({ duty: 'C/I', begin: `!${get('report')}`, report: hhmm(get('report')), notes: get('trip') ? [`[Trip ${get('trip')}]`] : [] }, [['begin', cell.report], ['info', cell.trip]]);
      }
      // "Layover: SOF": a day away from base
      const lay = /\bLayover:\s*([A-Z]{3})$/i.exec(line.items.map(i => i.text).join(' '));
      if (lay) {
        const its = line.items.filter(i => !cell.date?.includes(i));
        add({ duty: '', dep: lay[1], notes: [`[Layover: ${lay[1]}]`] }, [['dep', its.slice(-1)], ['info', its.slice(0, -1)]]);
      }
      const act = lay ? '' : get('act');
      const endText = get('end');
      const endDay = /^\(?(\d{2})\)? (\d{2}:\d{2})$/.exec(endText); // "(07) 21:30": the end's UTC day
      // the second half of a leg over local midnight: no From, no Start
      const open = rows.findLast(r => r.duty === act && r.begin && !r.end && !r.arr);
      let row;
      if (act && open && !get('from') && !get('start') && endText) {
        row = open;
        row.arr = get('to');
        row.end = endDay ? endDay[2] : `${endText}+1`;
        if (endDay && Number(endDay[1]) !== Number(row.date.split(' ')[0])) row.end += '+1';
        for (const [f, k] of [['arr', 'to'], ['end', 'end'], ['ac', 'ac'], ['info', 'block'], ['info', 'layover']]) mark(row, f, cell[k]);
        row.ac ||= get('ac');
        row.tz = get('tz');
      } else if (act) {
        row = add({ duty: act, dc: get('pos'), dep: get('from'), arr: get('to'), begin: get('start'), end: endText, ac: get('ac'), tz: get('tz') },
          [['duty', cell.act], ['dc', cell.pos], ['dep', cell.from], ['arr', cell.to], ['begin', cell.start], ['end', cell.end], ['ac', cell.ac], ['info', cell.tags], ['info', cell.block], ['info', cell.layover]]);
        const tags = get('tags');
        if (tags) row.notes.push(`[${tags}]`);
      }
      if (row) {
        const block = get('block');
        if (block && block !== '00:00' && row.ac) row.notes.push(`[Block: ${block}]`);
        if (get('layover')) row.notes.push(`[Layover: ${get('layover')}]`);
      }
      // the duty's last leg: its duty time filled -> the C/O (its time set below, from the report's)
      const duty = hhmm(get('duty'));
      if (ci && row && duty) {
        const notes = [`[Duty: ${get('duty')}]`];
        if (get('rest') && get('rest') !== '00:00') notes.push(`[Rest: ${get('rest')}]`);
        const co = { ...head, date: ci.date, day: ci.day, duty: 'C/O', ci, length: duty, notes };
        rows.push(co);
        mark(co, 'info', [...(cell.duty || []), ...(cell.rest || [])]);
        ci = null;
      }
      if (dm && !added.length && !row) add({ duty: '' }, []); // a day with nothing on it: keep the day
      if (dm && added[0]) mark(added[0], 'date', cell.date);
    }
  }
  // The report is local, the legs UTC: the report in UTC by the offset of its airport (the Timezone
  // Difference printed on the legs arriving there), "11:50 Z / 13:50 L"; the C/O = report + duty time.
  const offset = {};
  for (const r of rows) { const m = /^([+-])(\d{2}):(\d{2})$/.exec(r.tz || ''); if (r.arr && m) offset[r.arr] ??= (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3])); }
  for (const co of rows.filter(r => r.duty === 'C/O' && r.ci)) {
    const ci = co.ci;
    const port = rows.slice(rows.indexOf(ci) + 1).find(r => r.dep)?.dep;
    if (offset[port] == null || ci.report == null) continue;
    const z = ci.report - offset[port];
    const days = (n) => { const d = Math.floor(n / 1440); return d ? `${d > 0 ? '+' : ''}${d}` : ''; };
    ci.begin = `${formatTime(clock(z) + days(z), 'Z')} / ${formatTime(ci.begin)}`;
    co.end = clock(z + co.length) + days(z + co.length);
  }
  const out = rows.map(r => outputRow({ ...r, info: r.notes.join(' ') }, 'Z'));
  const last = month < 0 ? null : new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const yy = String(year).slice(2);
  return {
    format: 'released-roster', period: month < 0 ? null : `01${MONTHS[month]}${yy} - ${last}${MONTHS[month]}${yy}`,
    notices: [], recognized: out.length > 0, published: out, planned: [], _trace: trace, _rows: rows,
  };
}

/**
 * TUI fly crew week sheet ("Cabin - CCM <name> ... - BRU", "CHANGE (confirmed)", "printed at 3. May 2024"):
 * a page per week, a column per day ("Thur 9." over "May 2024"), each column a list of activities:
 *   1753          T37      <- flight number, aircraft (or "DH  TB161": a deadhead, its flight on the right)
 *   BRU           TFS      <- from, to
 *   C/I 08:00 09.05.2024   <- the duty's report: a C/I row on that date
 *   09:00       13:30      <- start, end
 *   ···                    <- then the next activity, or the column's figures
 * A ground activity is its code over its times ("S12", "09:00 15:00"); "HT PUJ" is a hotel. Brackets
 * ("( TX ANR BRU 02:20 03:05 )") are left off. Under the duty's last activity its figures: a line
 * "block  rest" then "duty  FDP": the C/O is the last flight's end + duty - FDP (FDP ends on block).
 * A "CHANGE" page shows the activities as they were in a box over the grid: left out, the grid is the roster.
 * The remarks under the grid ("10.5 Fri -- 'hours TBD within 72h of PRC'. -- --") go to the day's info
 * (a hotel's name to its HT row). Times are home base time (days off 00:00 - 00:00, a Nador arrival in Belgian time).
 */
const TUI_DAY_RE = /^(Mon|Tue|Wed|Thur?|Fri|Sat|Sun) (\d{1,2})\.$/;
const isTuiWeekGrid = (page) => page.items.filter(i => TUI_DAY_RE.test(i.text)).length >= 7 && page.items.some(i => /^printed at /.test(i.text));

function parseTuiWeekGrid(pages) {
  const trace = startTrace();
  const rows = [];
  const H = /^\d{1,3}:\d{2}$/;
  const hm = (t) => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };
  const clock = (n) => `${String(Math.floor((n % 1440) / 60)).padStart(2, '0')}:${String(n % 60).padStart(2, '0')}`;
  const duties = []; // { ci, figures } per C/I, for its C/O
  for (const page of pages.filter(isTuiWeekGrid)) {
    const lines = toLines(page.items);
    const heads = page.items.filter(i => TUI_DAY_RE.test(i.text)).sort((a, b) => a.x - b.x).slice(0, 7);
    const headY = heads[0].y;
    const monthLine = lines.find(l => l.y > headY + 2 && l.items.some(i => /^[A-Z][a-z]{2} \d{4}$/.test(i.text)));
    const centre = (i) => i.x + (i.w || 0) / 2;
    const cols = heads.map((h) => {
      const my = monthLine?.items.reduce((b, i) => (Math.abs(centre(i) - centre(h)) < Math.abs(centre(b) - centre(h)) ? i : b));
      const [mon, yr] = (my?.text || '').split(' ');
      const month = MONTHS.indexOf(mon), day = Number(TUI_DAY_RE.exec(h.text)[2]);
      const d = new Date(Date.UTC(Number(yr), month, day));
      return { x: centre(h), head: h, date: `${day} ${MONTHS[month]} ${String(yr).slice(2)}`, day: WEEKDAYS[d.getUTCDay()], items: [] };
    });
    // the remarks table under the grid: "13.5 Mon | -- Conversion 787: CRM+EWB -- --"
    const remarkLines = lines.filter(l => /^\d{1,2}\.\d{1,2} (Mon|Tue|Wed|Thur?|Fri|Sat|Sun)$/.test(l.items[0].text));
    const bottom = remarkLines[0]?.y ?? Infinity;
    // a CHANGE page: the box of the activities as they were, between the day heads and the grid
    const change = lines.some(l => l.y < headY && l.items.map(i => i.text).join('').replace(/\s/g, '').includes('CHANGE'));
    const top = (monthLine?.y ?? headY) + (change ? 45 : 2);
    for (const it of page.items) {
      if (it.y <= top || it.y >= bottom || it.text === '(' || it.text === ')') continue;
      const c = cols.reduce((b, k) => (Math.abs(k.x - centre(it)) < Math.abs(b.x - centre(it)) ? k : b));
      c.items.push(it);
    }
    for (const col of cols) {
      const head = { section: 'published', date: col.date, day: col.day, notes: [] };
      const added = [];
      let cur = null, figures = false, ci = null;
      const stats = [];
      const add = (r, marks) => { const row = { ...head, notes: [], ...r }; rows.push(row); added.push(row); for (const [f, its] of marks) if (its?.length) mark(row, f, its); return row; };
      for (const line of toLines(col.items)) {
        const its = line.items.map(i => ({ ...i, text: i.text.replace(/^\(\s*|\s*\)$/g, '') })).filter(i => i.text);
        const toks = its.map(i => i.text);
        if (toks.every(t => /^[·.…]+$/.test(t))) { figures = true; continue; }
        if (toks.every(t => H.test(t) || /^\d{1,2}$/.test(t))) {
          if (cur && !cur.timed && !figures) {
            const left = its.filter(i => centre(i) < col.x), right = its.filter(i => centre(i) >= col.x);
            if (left[0]) { cur.begin = left[0].text; mark(cur, 'begin', [left[0]]); }
            if (right.at(-1)) { cur.end = right.at(-1).text; mark(cur, 'end', [right.at(-1)]); }
            if (cur.begin && cur.end && hm(cur.end) < hm(cur.begin)) cur.end += '+1';
            cur.timed = true;
          } else stats.push(toks);
          continue;
        }
        const ciM = /^C\/I (\d{2}:\d{2}) (\d{2})\.(\d{2})\.(\d{4})$/.exec(toks.join(' '));
        if (ciM) {
          const [, t, dd, mm, yyyy] = ciM;
          const d = new Date(Date.UTC(Number(yyyy), Number(mm) - 1, Number(dd)));
          ci = { ...head, date: `${Number(dd)} ${MONTHS[d.getUTCMonth()]} ${yyyy.slice(2)}`, day: WEEKDAYS[d.getUTCDay()], duty: 'C/I', begin: t, notes: [] };
          rows.splice(cur ? rows.indexOf(cur) : rows.length, 0, ci); // before its flight
          mark(ci, 'begin', its);
          duties.push({ ci, stats });
          continue;
        }
        if (cur && !cur.timed && !figures && toks.length === 2 && toks.every(t => /^[A-Z]{3}$/.test(t)) && !cur.dep) {
          Object.assign(cur, { dep: toks[0], arr: toks[1] });
          mark(cur, 'dep', [its[0]]); mark(cur, 'arr', [its[1]]);
          continue;
        }
        // a new activity
        figures = false;
        if (toks.length === 2 && /^\d{3,4}[A-Z]?$/.test(toks[0])) cur = add({ duty: toks[0], ac: toks[1] }, [['duty', [its[0]]], ['ac', [its[1]]]]);
        else if (toks.length === 2 && toks[0] === 'DH') cur = add({ dc: 'DH', duty: toks[1] }, [['dc', [its[0]]], ['duty', [its[1]]]]);
        else if (toks.length === 2 && /^[A-Z]{3}$/.test(toks[1])) cur = add({ duty: toks[0], dep: toks[1] }, [['duty', [its[0]]], ['dep', [its[1]]]]);
        else cur = add({ duty: toks.join(' ') }, [['duty', its]]);
      }
      if (added[0]) mark(added[0], 'date', [col.head]);
      else { const r = add({ duty: '' }, []); mark(r, 'date', [col.head]); }
      col.rows = added;
    }
    // remarks: "-- -- Royalton Punta Cana Resort & Casino --", "1753 : -- -- --"
    for (const l of remarkLines) {
      const [dd, mm] = l.items[0].text.split(' ')[0].split('.').map(Number);
      const col = cols.find(c => c.date.startsWith(`${dd} ${MONTHS[mm - 1]} `));
      const parts = l.items.slice(1);
      const text = parts.map(i => i.text).join(' ').replace(/^\S+ :\s*/, '').split(/\s*--\s*/).map(s => s.trim()).filter(Boolean).join('; ');
      if (!col || !text) continue;
      const row = col.rows.find(r => r.duty === 'HT') || col.rows[0];
      row.notes.push(`[${text}]`);
      mark(row, 'info', parts);
    }
  }
  // C/O: under the duty's flights, "block rest" then "duty FDP" -> the last flight's end + duty - FDP
  for (const { ci, stats } of duties) {
    const k = stats.findIndex((s, j) => s.length === 2 && stats[j + 1]?.length === 2 && s.every(t => H.test(t)) && stats[j + 1].every(t => H.test(t)));
    if (k < 0) continue;
    const [duty, fdp] = stats[k + 1].map(hm);
    let i = rows.indexOf(ci) + 1, lastFlight = null, last = null;
    for (; i < rows.length && (rows[i].ac || rows[i].dc === 'DH' || (rows[i].dep && rows[i].arr && rows[i].dep !== rows[i].arr)); i++) {
      last = rows[i];
      if (rows[i].ac || rows[i].dc === 'DH') lastFlight = rows[i];
    }
    if (!lastFlight?.end || duty < fdp) continue;
    const t = hm(lastFlight.end.replace(/\+\d$/, '')) + (/\+1$/.test(lastFlight.end) ? 1440 : 0) + duty - fdp;
    const co = { section: 'published', date: lastFlight.date, day: lastFlight.day, duty: 'C/O', end: clock(t % 1440) + (t >= 1440 ? '+1' : ''), notes: [`[Duty: ${clock(duty)}]`] };
    rows.splice(rows.indexOf(last) + 1, 0, co);
  }
  const out = rows.map(r => outputRow({ ...r, info: r.notes.join(' ') }, 'B'));
  const first = rows[0], lastRow = rows.at(-1);
  const short = (d) => { const [dd, mm, yy] = d.split(' '); return `${dd.padStart(2, '0')}${mm}${yy}`; };
  return {
    format: 'tui-week-grid', period: first ? `${short(first.date)} - ${short(lastRow.date)}` : null,
    notices: [], recognized: out.length > 0, published: out, planned: [], _trace: trace, _rows: rows,
  };
}

/**
 * Qantas pattern list ("Pattern: JX24 | A/C Type: A330 | Base: BNE | Category: CPT F/O S/O", "Route Code: LAX05 | Weeks: 1 to 8"):
 * trips by weekday, no dates —
 *   Service | T | Pax | Sectors | Report Time | Departure Day Lst Utc | Arrival Day Lst Utc | Free of Duty | Flight Time Total Night | Duty Period | ADP Credit
 *   QFA0015 |   |     | BNE LAX | 2100        | SU 2200 1200            | SU 1830 0130          | 49:15        | 13:30 10:00            | 15:00       | 3:30
 * The rows have a weekday and no date. A report time opens a duty (a C/I row, local), a Duty Period closes it (a C/O row at
 * report + duty, local at the arrival: "[Duty: 15:00] [Rest: 49:15] [Credit: 3:30]"); a leg: duty = Service, "PAX" -> dc,
 * begin / end local with the arrival's day offset, ac = A/C Type, "[Block: 13:30] [Night: 10:00]" (a flight time in
 * brackets, a passenger leg's, left out). The pattern's names on its first C/I ("[Pattern JX24 LAX05]").
 */
const isQantasPatterns = (page) => page.items.some(i => i.text === 'Pattern:') && page.items.some(i => i.text === 'Route Code:') && page.items.some(i => i.text === 'Minimum Pattern Credit:');
const QF_DAYS = { SU: 'Sun', MO: 'Mon', TU: 'Tue', WE: 'Wed', TH: 'Thu', FR: 'Fri', SA: 'Sat' };

function parseQantasPatterns(pages) {
  const trace = startTrace();
  const rows = [];
  const hm = (t) => (/^\d{4}$/.test(t) ? Number(t.slice(0, 2)) * 60 + Number(t.slice(2)) : /^\d{1,3}:\d{2}$/.test(t) ? Number(t.split(':')[0]) * 60 + Number(t.split(':')[1]) : null);
  const clock = (n) => { const m = ((n % 1440) + 1440) % 1440; return `${String(Math.floor(m / 60)).padStart(2, '0')}${String(m % 60).padStart(2, '0')}`; };
  const dayNo = (d) => Object.keys(QF_DAYS).indexOf(d);
  const plus = (n) => (n > 0 ? `+${n}` : '');
  for (const page of pages.filter(isQantasPatterns)) {
    const lines = toLines(page.items);
    let pattern = null, anchors = null, duty = null;
    for (const line of lines) {
      const at = (t) => line.items.find(i => i.text === t);
      const after = (t) => { const k = line.items.findIndex(i => i.text === t); return k >= 0 ? line.items[k + 1] : null; };
      if (at('Pattern:')) { pattern = { name: after('Pattern:')?.text, ac: after('A/C Type:')?.text, first: true }; duty = null; continue; }
      if (at('Route Code:')) { if (pattern) pattern.route = after('Route Code:')?.text; continue; }
      if (at('Service') && at('Sectors')) { anchors = { service: at('Service').x, pax: at('Pax').x, sectors: at('Sectors').x, report: at('Report Time').x + 18, fod: at('Free of Duty').x + 18, period: at('Period').x - 5, credit: at('ADP Credit').x + 12 }; continue; }
      if (anchors && at('Lst') && at('Utc')) {
        const [d1, d2] = line.items.filter(i => i.text === 'Day'), [l1, l2] = line.items.filter(i => i.text === 'Lst'), [u1, u2] = line.items.filter(i => i.text === 'Utc');
        Object.assign(anchors, { depDay: d1.x, depLst: l1.x, depUtc: u1.x, arrDay: d2?.x, arrLst: l2?.x, arrUtc: u2?.x, total: at('Total')?.x, night: at('Night')?.x });
        continue;
      }
      if (!pattern || !anchors?.depDay || !/^[A-Z]{2,3}\d{1,4}[A-Z]?$/.test(line.items[0].text) || line.items[0].x > anchors.pax - 10) continue;
      // each value to the nearest column (the sectors: from left of "Sectors", to right of it)
      const cols = { ...anchors, dep: anchors.sectors - 14, arr: anchors.sectors + 17 };
      delete cols.sectors;
      const cell = {};
      for (const it of line.items) {
        const k = Object.entries(cols).filter(([, x]) => x != null).reduce((a, b) => (Math.abs(b[1] - it.x) < Math.abs(a[1] - it.x) ? b : a))[0];
        (cell[k] ||= []).push(it);
      }
      const get = (k) => (cell[k] || []).map(i => i.text).join(' ').trim();
      const depDay = get('depDay'), arrDay = get('arrDay');
      if (!QF_DAYS[depDay]) continue;
      const depLst = hm(get('depLst')), depUtc = hm(get('depUtc')), arrLst = hm(get('arrLst')), arrUtc = hm(get('arrUtc'));
      if (get('report')) {
        const rep = hm(get('report'));
        const before = rep > depLst ? 1 : 0; // reported the day before a leg after midnight
        const day = Object.keys(QF_DAYS)[(dayNo(depDay) + 7 - before) % 7];
        const ci = { section: 'published', date: '', day: QF_DAYS[day], duty: 'C/I', dep: get('dep'), begin: `!${get('report')}`, notes: pattern.first ? [`[Pattern ${[pattern.name, pattern.route].filter(Boolean).join(' ')}]`] : [] };
        pattern.first = false;
        rows.push(ci);
        mark(ci, 'begin', cell.report);
        // the report in UTC: as far before the departure in UTC as in local time
        duty = { reportUtc: depUtc - (depLst + before * 1440 - rep) };
        duty.t = duty.reportUtc;
      }
      const days = QF_DAYS[arrDay] ? (dayNo(arrDay) - dayNo(depDay) + 7) % 7 : 0;
      // the duty's UTC times one after another (a time before the last is on the next day)
      const unwrap = (t, from) => t + Math.ceil((from - 60 - t) / 1440) * 1440;
      if (duty && depUtc != null && arrUtc != null) { const d = unwrap(depUtc, duty.t); duty.t = unwrap(arrUtc, d); }
      const flight = get('total'), night = get('night');
      const leg = {
        section: 'published', date: '', day: QF_DAYS[depDay], dc: get('pax') === 'PAX' ? 'PAX' : '', duty: get('service'), dep: get('dep'), arr: get('arr'),
        begin: `!${get('depLst')}`, end: `!${get('arrLst')}${plus(days)}`, ac: pattern.ac || '',
        notes: [/^\d/.test(flight) && `[Block: ${flight.padStart(5, '0')}]`, /^\d/.test(night) && hm(night) && `[Night: ${night.padStart(5, '0')}]`].filter(Boolean),
      };
      rows.push(leg);
      for (const [f, k] of [['duty', 'service'], ['dc', 'pax'], ['dep', 'dep'], ['arr', 'arr'], ['day', 'depDay'], ['begin', 'depLst'], ['end', 'arrLst'], ['info', 'total'], ['info', 'night']]) mark(leg, f, cell[k]);
      // the duty's last leg: its Duty Period -> the C/O, local at the arrival
      if (get('period') && duty) {
        const coUtc = duty.reportUtc + hm(get('period'));
        const co = arrLst + (coUtc - duty.t);
        const fod = get('fod');
        const co_ = {
          section: 'published', date: '', day: QF_DAYS[arrDay] || leg.day, duty: 'C/O', arr: get('arr'), end: `!${clock(co)}${plus(Math.floor(co / 1440))}`,
          notes: [`[Duty: ${get('period').padStart(5, '0')}]`, fod && !/\(/.test(fod) && `[Rest: ${fod.padStart(5, '0')}]`, get('credit') && `[Credit: ${get('credit').padStart(5, '0')}]`].filter(Boolean),
        };
        rows.push(co_);
        mark(co_, 'info', [...cell.period, ...(cell.fod || []), ...(cell.credit || [])]);
        duty = null;
      }
    }
  }
  const out = rows.map(r => outputRow({ ...r, info: r.notes.join(' ') }, 'L'));
  return { format: 'qantas-patterns', period: null, notices: [], recognized: out.length > 0, published: out, planned: [], _trace: trace, _rows: rows };
}

/**
 * EFB postflight report (e.g. Icelandair "P O S T F L I G H T  R E P O RT"): one flight per file.
 * FLIGHT/CALLSIGN "FI665(ICE665)" -> duty FI665, REGISTRATION -> registration, AIRCRAFT TYPE -> ac,
 * DEPARTURE DATE "22 SEP 2026" -> date, the airports' "BIKF / KEF" -> dep/arr (IATA), the
 * "OOOI timeline" (STD, OFF BLOCK, TAKEOFF, LANDING, ON BLOCK, STA, AIR TIME, BLOCK ACT., UTC):
 * OFF BLOCK -> begin, TAKEOFF -> takeoff, LANDING -> landing, ON BLOCK -> end, STD / STA / block time -> info. Times in UTC.
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
    const [std, off, takeoff, landing, on, sta, , block] = t;
    const iata = (it) => it?.text.split(' / ')[1] || '';
    const fmt = (it) => (it ? `${it.text.slice(0, 2)}:${it.text.slice(2)}` : '');
    const row = {
      section: 'published', date: `${Number(d[1])} ${MONTHS[month]} ${d[3].slice(2)}`, day: WEEKDAYS[new Date(Number(d[3]), month, Number(d[1])).getDay()],
      duty: callsign.text.replace(/\(.*$/, ''), registration: reg?.text || '', ac: type?.text || '',
      dep: iata(airports[0]), arr: iata(airports[1]), begin: off?.text || '', takeoff: takeoff?.text || '', landing: landing?.text || '', end: on?.text || '',
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
    mark(row, 'takeoff', [takeoff]);
    mark(row, 'landing', [landing]);
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

/** A piece of an item ("RPT:03:40" -> its "03:40"), traced back to the item it was cut from. */
const pieceOf = (it, off, len) => ({ ...it, text: it.text.slice(off, off + len), _src: it._src || it, _off: (it._off || 0) + off });

const QR_DAY_RE = /^(\d{2})([A-Z][a-z]{2})$/;
const isQatarScheduleReport = (page) => page.items.some(i => i.text === 'Crew Schedule Report')
  && page.items.some(i => /^Period: \d{1,2}-[A-Z][a-z]{2}-\d{4} - \d{1,2}-[A-Z][a-z]{2}-\d{4}/.test(i.text))
  && page.items.filter(i => QR_DAY_RE.test(i.text)).length >= 7;

/**
 * "Crew Schedule Report" (Qatar Airways; "Period: 01-Feb-2025 - 28-Feb-2025 | Published"/"Actual",
 * "All times are in UTC except for OFF & Leave"): a column per day ("01Feb" over "Sat"), its events stacked
 * one item a line:
 *   "RPT:03:40" the report (C/I; "24-JAN*" on the next line: reported the day before), then per flight
 *   number, dep, STD, arr, STA ("14:05(+1)"), and in any order the aircraft "(351)" and indicators ("PIC",
 *   "PA,elt", "IR", "DH" = deadheading -> dc DH); a duty with times ("SBY" DOH 04:00 10:00, "77LP", "PSBY");
 *   a day code with its station ("OFF" DOH, "DOFF" "(LGW)", "LVE", "REST").
 * No C/O is printed. The daily "DH:"/"BH:" lines under the grid end it. Codes of the ABBREVIATION list go to
 * info ("[OFF: Day Off]", "[PIC: Pilot in Command]"); HOTEL DETAILS give a hotel row (HT) per stay date.
 */
function parseQatarScheduleReport(pages) {
  const trace = startTrace();
  const rows = [];
  const all = pages.flatMap(p => p.items);
  const per = all.map(i => /^Period: (\d{1,2})-([A-Z][a-z]{2})-(\d{4}) - (\d{1,2})-([A-Z][a-z]{2})-(\d{4})/.exec(i.text)).find(Boolean);
  per[1] = per[1].padStart(2, '0');
  per[4] = per[4].padStart(2, '0');
  const y0 = +per[3], m0 = monthIndex(per[2]);
  const ymdOf = (dd, mon) => { const m = monthIndex(mon); return Date.UTC(y0 + (m < m0 - 6 ? 1 : 0), m, +dd); };
  const dayRow = (t) => { const d = new Date(t); return { date: `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${String(d.getUTCFullYear() % 100).padStart(2, '0')}`, day: WEEKDAYS[d.getUTCDay()], t }; };
  // ABBREVIATION: "CODE" | "Description", under ACTIVITY CODE/INDICATOR
  const legend = new Map();
  for (const page of pages) {
    const head = page.items.find(i => i.text === 'ACTIVITY CODE/INDICATOR');
    const desc = head && page.items.find(i => i.text === 'DESCRIPTION' && Math.abs(i.y - head.y) < 3);
    if (!desc) continue;
    const codes = page.items.filter(i => i.y > head.y + 3 && Math.abs(i.x - head.x) < 6);
    for (const c of codes) {
      const d = page.items.filter(i => Math.abs(i.y - c.y) < 2 && Math.abs(i.x - desc.x) < 6).map(i => i.text).join(' ');
      if (d) legend.set(c.text, d);
    }
  }
  const legendNote = (code) => {
    const d = legend.get(code) ?? legend.get(code.toUpperCase());
    return d ? `[${code}: ${d}]` : `[${code}]`;
  };
  const isTime = (t) => /^\d{2}:\d{2}(\(\+\d\))?$/.test(t || '');
  const isStation = (t) => /^[A-Z]{3}$/.test(t || '');
  const time = (t) => t.replace(/\((\+\d)\)$/, '$1');
  for (const page of pages) {
    const days = page.items.filter(i => QR_DAY_RE.test(i.text) && MONTHS.includes(QR_DAY_RE.exec(i.text)[2]));
    if (days.length < 7) continue;
    const top = days[0].y;
    const cols = days.filter(i => Math.abs(i.y - top) < 3).sort((a, b) => a.x - b.x).map(i => ({ item: i, cx: i.x + (i.w || 0) / 2 }));
    const pitch = (cols.at(-1).cx - cols[0].cx) / Math.max(1, cols.length - 1);
    const stop = page.items.find(i => /^DH:/.test(i.text) && i.y > top)?.y ?? page.height;
    const grid = page.items.filter(i => i.y > top + 5 && i.y < stop - 2 && !WEEKDAYS.includes(i.text));
    for (const col of cols) {
      const [, dd, mon] = QR_DAY_RE.exec(col.item.text);
      const today = ymdOf(dd, mon);
      const items = grid.filter(i => Math.abs(i.x + (i.w || 0) / 2 - col.cx) < pitch / 2).sort((a, b) => a.y - b.y || a.x - b.x);
      let last = null, firstOfDay = true;
      const add = (r, marks, t = today) => {
        const row = { section: 'published', ...dayRow(t), notes: [], ...r };
        rows.push(row);
        for (const [f, it] of marks) if (it) mark(row, f, it);
        if (firstOfDay) { mark(row, 'date', col.item); firstOfDay = false; }
        return row;
      };
      for (let k = 0; k < items.length; k++) {
        const it = items[k], tx = it.text, nx = items[k + 1]?.text;
        // "RPT:03:40", or "RPT:" with its time on the next line
        const rpt = /^RPT:(\d{2}:\d{2})?$/.exec(tx);
        if (rpt && (rpt[1] || isTime(nx))) {
          const timeItem = rpt[1] ? pieceOf(it, 4, 5) : items[++k];
          // "24-JAN*" under it: reported the day before
          const prev = /^(\d{2})-([A-Z]{3})\*$/.exec(items[k + 1]?.text || '');
          const t = prev ? ymdOf(prev[1], prev[2]) : today;
          last = add({ duty: 'C/I', begin: timeItem.text }, [['ci', timeItem]], t);
          last.ci = true;
          if (prev) { mark(last, 'date', items[k + 1]); k += 1; }
          continue;
        }
        // an event: a code with its station
        const codeLike = /^[A-Z0-9]{2,6}$/.test(tx);
        if (codeLike && (isStation(nx) || /^\([A-Z]{3}\)$/.test(nx || ''))) {
          const dep = items[k + 1];
          let j = k + 2;
          const t1 = isTime(items[j]?.text) ? items[j++] : null;
          let arr = null, t2 = null;
          if (t1 && isStation(items[j]?.text) && isTime(items[j + 1]?.text)) { arr = items[j++]; t2 = items[j++]; }
          else if (t1 && isTime(items[j]?.text)) t2 = items[j++];
          const ci = rows.at(-1)?.ci ? rows.at(-1) : null;
          if (ci && !ci.dep) { ci.dep = dep.text; ci.ci = false; }
          last = add({ duty: tx, dep: dep.text.replace(/[()]/g, ''), arr: arr?.text || '', begin: t1 ? time(t1.text) : '', end: t2 ? time(t2.text) : '' },
            [['duty', it], ['dep', dep], ['begin', t1], ['arr', arr], ['end', t2]]);
          if (!t1 && legend.has(tx)) last.notes.push(legendNote(tx));
          else if (t1 && !arr && legend.has(tx)) last.notes.push(legendNote(tx));
          k = j - 1;
          continue;
        }
        if (codeLike && !last) { last = add({ duty: tx }, [['duty', it]]); if (legend.has(tx)) last.notes.push(legendNote(tx)); continue; }
        if (!last || last.duty === 'C/I') continue;
        const ac = /^\(([A-Z0-9]{3,4})\)$/.exec(tx);
        if (ac) { last.ac = ac[1]; mark(last, 'ac', pieceOf(it, 1, ac[1].length)); continue; }
        // indicators: "PIC", "PA,elt", "DH"
        if (/^[A-Za-z]{1,5}(,[A-Za-z]{1,5})*$/.test(tx)) {
          for (const c of tx.split(',')) {
            if (c === 'DH') last.dc = 'DH';
            else last.notes.push(legendNote(c));
          }
          mark(last, 'info', it);
        }
      }
    }
  }
  // HOTEL DETAILS: STAY DATE | LOCATION | HOTEL NAME | HOTEL ADDRESS (may wrap) | CONTACT NAME | TELEPHONE
  for (const page of pages) {
    const head = page.items.find(i => i.text === 'STAY DATE');
    if (!head) continue;
    // cells are centred under their headers: an item goes to the header nearest its centre
    const NAMES = ['STAY DATE', 'LOCATION', 'HOTEL NAME', 'HOTEL ADDRESS', 'CONTACT NAME', 'TELEPHONE'];
    const heads = NAMES.map(t => page.items.find(i => i.text === t && Math.abs(i.y - head.y) < 3));
    if (heads.some(h => !h)) continue;
    const centre = (i) => i.x + (i.w || 0) / 2;
    const abbrX = page.items.find(i => i.text === 'ACTIVITY CODE/INDICATOR' && Math.abs(i.y - head.y) < 3)?.x ?? Infinity;
    const colOf = (i) => heads.reduce((b, h, k) => (Math.abs(centre(h) - centre(i)) < Math.abs(centre(heads[b]) - centre(i)) ? k : b), 0);
    const starts = page.items.filter(i => i.y > head.y + 3 && i.x < abbrX - 5 && /^\d{2}-[A-Z]{3}-\d{4}$/.test(i.text) && colOf(i) === 0).sort((a, b) => a.y - b.y);
    const seen = new Set();
    starts.forEach((s, n) => {
      const yEnd = starts[n + 1]?.y ?? s.y + 30;
      const cellItems = (k) => page.items.filter(i => i.y > s.y - 2 && i.y < yEnd - 2 && i.x < abbrX - 5 && i !== s && colOf(i) === k);
      const cell = (k) => cellItems(k).map(i => i.text).join(' ');
      const loc = cell(1);
      const name = cell(2);
      const addr = cell(3).replace(/[，‚]/g, ',').replace(/(\s*,)+/g, ',').replace(/[\s,]+$/, '');
      const tel = cell(5);
      const key = `${s.text}|${loc}|${name}`;
      if (seen.has(key)) return;
      seen.add(key);
      const [dd, mon, yyyy] = s.text.split('-');
      const t = Date.UTC(+yyyy, monthIndex(mon[0] + mon.slice(1).toLowerCase()), +dd);
      const at = rows.findIndex(r => r.t > t);
      const row = { section: 'published', ...dayRow(t), duty: 'H', dep: loc, notes: [[name, addr, tel && `Tel ${tel}`].filter(Boolean).join(', ')] };
      rows.splice(at < 0 ? rows.length : at, 0, row);
      mark(row, 'date', s);
      mark(row, 'dep', cellItems(1));
      mark(row, 'info', [...cellItems(2), ...cellItems(3), ...cellItems(5)]);
    });
  }
  const p = `${per[1]}${MONTHS[monthIndex(per[2])]}${per[3].slice(2)} - ${per[4]}${MONTHS[monthIndex(per[5])]}${per[6].slice(2)}`;
  const out = rows.map(({ t, ci, ...r }) => outputRow({ ...r, info: r.notes.join(' ') }, 'Z'));
  return { format: 'qatar-schedule-report', period: p, notices: [], recognized: out.length > 0, published: out, planned: [], _trace: trace, _rows: rows };
}

const SWISS_COLS = {
  Date: 'date', Report: 'report', Tags: 'tags', Pos: 'pos', IFF: 'iff', Activity: 'activity', From: 'from', To: 'to', Dep: 'dep', Arr: 'arr', 'A/C': 'ac', A: 'ac',
  Layover: 'layover', 'LN*': 'ln', LN: 'ln', Flt: 'flt', Fit: 'flt', DP: 'dp',
  // Widerøe: Date | Check In | Training | Pos | Activity | From | To | Start | End | Check Out | A/C | Layover | Trip ID
  'Check In': 'report', Training: 'tags', Start: 'dep', End: 'arr', 'Check Out': 'co', 'Trip ID': 'trip',
  // Lufthansa CityLine "Released Roster": Date | Report (UTC) | Tags | Pos | Activity | From | To | Start (UTC) | End (UTC) | A/C | Layover | Trip ID
  'Report (UTC)': 'report', 'Start (UTC)': 'dep', 'End (UTC)': 'arr',
};
const isSwissRoster = (page) => {
  const words = page.items.flatMap(wordsIn).map(w => w.text);
  return words.some(w => /^[Rr]oster$/.test(w)) && words.some(w => /^([Pp]ublished|Released)$/.test(w)) && ['Activity', 'Layover'].every(t => words.includes(t))
    && (words.includes('Report') || page.items.some(i => i.text === 'Check In')) && !page.items.some(i => /Blocktime/.test(i.text));
};

/**
 * Swiss "Published roster" / "Historical published roster" ("Period: September 2024", "All times local"), a line per event:
 *   Date | Report | Tags | Pos | IFF | Activity | From | To | Dep | Arr | A/C | Layover / Rest at HB | LN* | Flt hrs 28d/12m | DP hrs 7d/28d
 *   "03 Tue" 15:30 | CM | LX2032 ZRH MAD 16:35 19:00 223 ... ; following legs of the day without a date
 *   "05 Fri" 16:35 RP V LX180 ZRH 18:00 77W  +  "06 Sat" RP BKK 10:45 49:00 (a flight arriving on a later day: end "+1")
 *   "07 Sun" "Layover: BKK" (a hotel row), "14 Sat" LTFD, "16 Mon" SBY ZRH 05:00 17:00 (day codes, with times or not).
 * Prints come with whole cells, a word per item, or a character run per item ("07" ":" "28", lines a few points apart):
 * cells are rebuilt from the header words' x. Report -> a C/I row; Pos DH -> dc DH; IFF -> "[IFF: V]"; Layover / Rest
 * at HB (time to the next duty) on a duty's last leg -> "[Rest: 16:00]"; LN* -> "[Local nights: 3]". The cumulated
 * flight / duty hours are not read. No C/O is printed. Days run on into the next month.
 * Widerøe prints the same roster as Date | Check In | Training | Pos | Activity | From | To | Start | End | Check Out |
 * A/C | Layover | Trip ID ("Planning period: November 2025"): Check In / Out give the C/I and C/O rows, Layover
 * "[Layover: 16:50]"; the totals under the days ("01Jan-31Jan2026", "Work Days", "Block time") are not read.
 */
function parseSwissRoster(pages) {
  const trace = startTrace();
  const rows = [];
  const all = pages.flatMap(p => p.items.flatMap(wordsIn));
  const periodWord = all.find(w => /^[Pp]eriod:?$/.test(w.text));
  const near = periodWord ? all.filter(w => Math.abs(w.y - periodWord.y) < 8).map(w => w.text) : [];
  const monName = near.find(t => monthIndex(t.slice(0, 3)) >= 0 && /^[A-Za-z]{3,}$/.test(t));
  const yearTxt = near.find(t => /^\d{4}$/.test(t));
  if (!monName || !yearTxt) return { format: 'swiss-roster', period: null, notices: [], recognized: false, published: [], planned: [], _trace: trace, _rows: [] };
  let month = monthIndex(monName.slice(0, 3)), year = +yearTxt, lastDay = null;
  const dayRow = (t) => { const d = new Date(t); return { date: `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${String(d.getUTCFullYear() % 100).padStart(2, '0')}`, day: WEEKDAYS[d.getUTCDay()], t }; };
  let today = null, pendingCi = null, openFlight = null, firstMark = null;
  const add = (r, marks, t = today) => {
    const row = { section: 'published', ...dayRow(t), notes: [], ...r };
    rows.push(row);
    for (const [f, it] of marks) if (it && [].concat(it).length) mark(row, f, it);
    if (firstMark && t === today) { mark(row, 'date', firstMark); firstMark = null; }
    return row;
  };
  for (const page of pages) {
    const words = page.items.flatMap(wordsIn);
    const dateHead = words.find(w => w.text === 'Date' && words.some(o => o.text === 'Activity' && Math.abs(o.y - w.y) < 8));
    if (!dateHead) continue;
    // header words over up to three lines
    const band = (i) => i.y > dateHead.y - 4 && i.y < dateHead.y + 12;
    const heads = [
      ...page.items.filter(i => band(i) && / /.test(i.text) && SWISS_COLS[i.text]).map(i => ({ col: SWISS_COLS[i.text], x: i.x })), // "Check In"
      ...words.filter(w => band(w) && SWISS_COLS[w.text]).map(w => ({ col: SWISS_COLS[w.text], x: w.x - (w._off ? 8 : 0) })), // a word of a run ("Activity From To"): x from an average char width
    ];
    const cols = [...new Map(heads.sort((a, b) => a.x - b.x).map(h => [h.col, h])).values()].sort((a, b) => a.x - b.x);
    const colOf = (w) => cols.reduce((c, h) => (h.x <= w.x + 4 ? h.col : c), 'date');
    // the days start at the first "01" / "01 Mon" under Date (the header runs over one to three lines)
    const firstDay = words.filter(w => w.y > dateHead.y + 3 && Math.abs(w.x - dateHead.x) < 6 && /^\d{2}$/.test(w.text)).sort((a, b) => a.y - b.y)[0];
    if (!firstDay) continue;
    const body = words.filter(w => w.y > firstDay.y - 3).sort((a, b) => a.y - b.y);
    // the notes / totals under the days: "(*): Local nights", Widerøe's "01Jan-31Jan2026" | "Work Days" | "Block time"
    const stopY = body.find(w => /^\(\*\):?$/.test(w.text) || w.text === 'Created' || /^\d{2}[A-Z][a-z]{2}-\d{2}[A-Z][a-z]{2}\d{4}$/.test(w.text)
      || (w.text === 'Work' && Math.abs(w.x - dateHead.x) < 6))?.y ?? Infinity;
    const layoverTag = words.some(w => band(w) && w.text === 'Rest') ? 'Rest' : 'Layover'; // Swiss "Layover / Rest at HB"; Widerøe, CityLine "Layover"
    // lines: items less than 3.5pt below the one before belong to the same line (split prints)
    const lines = [];
    for (const w of body.filter(i => i.y < stopY - 1)) {
      const l = lines.at(-1);
      if (l && w.y - l.yLast <= 3.5) { l.items.push(w); l.yLast = w.y; } else lines.push({ items: [w], yLast: w.y });
    }
    for (const line of lines) {
      const cells = {};
      const its = {};
      const sorted = [...line.items].sort((a, b) => a.x - b.x);
      for (const w of sorted) {
        const c = /^Layover:$/.test(w.text) || its.layoverAt ? 'layoverAt' : colOf(w); // "Layover: BKK" runs over the columns
        (its[c] ||= []).push(w);
      }
      for (const [c, list] of Object.entries(its)) {
        let s = '', end = null;
        for (const w of list) { s += (end != null && w.x - end > 1.5 ? ' ' : '') + w.text; end = w.x + (w.w || 0); }
        cells[c] = s.trim();
      }
      // the date cell: "03 Tue" (weekday may be its own word)
      const dm = /^(\d{2})\s*(Mon|Tue|Wed|Thu|Fri|Sat|Sun)?/.exec(cells.date || '');
      let report = cells.date && /(\d{2}:\d{2})$/.exec(cells.date)?.[1]; // "08 Mon 12:15" printed as one item
      if (dm) {
        const n = +dm[1];
        if (lastDay == null && dm[2]) {
          // the first day may be the month before ("31 Sat" in a September roster)
          const prev = new Date(Date.UTC(year, month - 1, n));
          if (WEEKDAYS[new Date(Date.UTC(year, month, n)).getUTCDay()] !== dm[2] && WEEKDAYS[prev.getUTCDay()] === dm[2]) { month = prev.getUTCMonth(); year = prev.getUTCFullYear(); }
        } else if (lastDay != null && n < lastDay) { month += 1; if (month > 11) { month = 0; year += 1; } }
        lastDay = n;
        today = Date.UTC(year, month, n);
        firstMark = its.date;
      }
      if (today == null) continue;
      report ||= /^\d{2}:\d{2}$/.test(cells.report || '') ? cells.report : null;
      if (report) {
        pendingCi = add({ duty: 'C/I', begin: report }, [['ci', its.report || its.date?.filter(w => /:/.test(w.text))]]);
      }
      const act = cells.activity;
      const time = (s) => (/^\d{2}:\d{2}$/.test(s || '') ? s : '');
      const notes = [];
      if (cells.iff) notes.push(`[IFF: ${cells.iff}]`);
      if (/^\d+:\d{2}$/.test(cells.layover || '')) notes.push(`[${layoverTag}: ${cells.layover.padStart(5, '0')}]`);
      if (/^\d+$/.test(cells.ln || '')) notes.push(`[Local nights: ${cells.ln}]`);
      if (cells.layoverAt) {
        const at = /([A-Z]{3})$/.exec(cells.layoverAt);
        if (at) add({ duty: 'H', dep: at[1] }, [['dep', its.layoverAt.filter(w => w.text.endsWith(at[1]))]]);
        continue;
      }
      // the arrival of yesterday's flight printed with its number again ("1654" "OTP" "23:05", no From)
      const sameOpen = act && openFlight && !cells.from && act.replace(/\s/g, '') === openFlight.duty;
      if (act && !sameOpen) {
        const isFlight = /^[A-Z0-9]{2}\s?\d{1,4}[A-Z]?$/.test(act) && (cells.to || time(cells.arr) || openFlight == null);
        const r = add({
          duty: act.replace(/\s/g, ''), dc: cells.pos === 'DH' ? 'DH' : '', dep: cells.from || '', arr: cells.to || '',
          begin: time(cells.dep), end: time(cells.arr), ac: cells.ac?.replace(/\s/g, '') || '', notes,
        }, [['duty', its.activity], ['dep', its.from], ['arr', its.to], ['begin', its.dep], ['end', its.arr], ['ac', its.ac], ['info', [...(its.iff || []), ...(its.layover || []), ...(its.ln || [])]]]);
        if (pendingCi) { if (!pendingCi.dep) pendingCi.dep = r.dep; pendingCi = null; }
        if (isFlight) openFlight = r.arr && r.end ? null : r;
        if (time(cells.co)) add({ duty: 'C/O', arr: r.arr, end: cells.co }, [['co', its.co]]);
        continue;
      }
      if (openFlight && (cells.to || time(cells.arr))) {
        // the arrival of a flight from an earlier day
        const days = Math.round((today - openFlight.t) / 86400000);
        openFlight.arr = cells.to || openFlight.arr;
        openFlight.end = time(cells.arr) + (days > 0 ? `+${days}` : '');
        openFlight.notes.push(...notes);
        for (const [f, it] of [['arr', its.to], ['end', its.arr], ['info', [...(its.layover || []), ...(its.ln || [])]]]) if (it?.length) mark(openFlight, f, it);
        openFlight = null;
      }
    }
  }
  // "Report (UTC)", "Start (UTC)" (Lufthansa CityLine "Released Roster"): UTC; else local
  const zone = pages.some(p => p.items.some(i => /^(Report|Start|End) \(UTC\)$/.test(i.text))) ? 'Z' : 'L';
  const p = `01${MONTHS[monthIndex(monName.slice(0, 3))]}${yearTxt.slice(2)}`;
  const out = rows.map(({ t, ...r }) => outputRow({ ...r, info: r.notes.join(' ') }, zone));
  return { format: 'swiss-roster', period: `${p} - ${new Date(Date.UTC(+yearTxt, monthIndex(monName.slice(0, 3)) + 1, 0)).getUTCDate()}${p.slice(2)}`, notices: [], recognized: out.length > 0, published: out, planned: [], _trace: trace, _rows: rows };
}

/** French month names, as printed ("nov.", "AOÛT", "févr.") -> 0..11, else -1. */
const frenchMonth = (t) => {
  const s = String(t).toLowerCase().replace(/\.$/, '').normalize('NFD').replace(/[̀-ͯ]/g, '');
  const i = ['janv', 'fevr', 'mars', 'avr', 'mai', 'juin', 'juil', 'aout', 'sept', 'oct', 'nov', 'dec'].findIndex(m => s.startsWith(m));
  return i >= 0 ? i : (s === 'fev' ? 1 : s === 'jan' ? 0 : -1);
};
const PN_COLS = { Date: 'date', Acti: 'acti', Depa: 'dep', Arri: 'arr', CheckIn: 'ci', Hdep: 'begin', Harr: 'end', CheckOut: 'co', BLH: 'blh', HDV: 'blh', TSV: 'tsv', TS: 'ts',
  'TSV Max': 'tsvMax', TpsEqF: 'tpsEqF', StdBy: 'stdBy', 'Rep. avant': 'repAvant', 'Rep. après': 'repApres', Flags: 'flags', Fonc: 'fonc', 'Part.*': 'part' };
const isPlanningNavigant = (page) => page.items.some(i => i.text === 'Planning navigant') && page.items.some(i => i.text === 'Acti') && page.items.some(i => i.text === 'CheckIn');

/**
 * Air Corsica "Planning navigant" ("NOV. 2021", "Horaires en GMT"): a line per activity under
 *   Date | Acti | Depa | Arri | CheckIn | Hdep | Harr | CheckOut | BLH | TSV | TS | TSV Max | TpsEqF | StdBy | Rep. avant | Rep. après | Flags | Fonc | Part.*
 * The day ("lun." over "01 nov.") is centred on its activities; an activity's text wraps over the lines around its
 * own ("TXI - ORY GARE DU" / "NOR"), so do Rep. après ("12:00" above the duty's last line, "02/11 09:10" under it).
 *   "FLT - XK154 - 320" a flight (duty XK154, aircraft 320, "[Block: 00:48]"); "MEP - XK770" positioning (dc MEP);
 *   "TXI - Taxi", "TRAIN - to liverpool", "P-O - PAR ORY VL" ground transport ("[TXI: Taxi]"); "HOT - <name> - HOTEL" with ">"
 *   a hotel row (HT, its name in info; the "<" line of the stay's last day is left out); "JL", "SOP", "BL - BLANC" codes
 *   (the "Liste des codes activités" page gives a code's meaning: "[TXI: Taxi]").
 * CheckIn -> a C/I row before its line, CheckOut -> a C/O row after it with the duty's TSV / TS / TSV Max and Rep. après
 * ("[Duty: 06:50] [TS: 07:10] [TSV Max: 11:00] [Rest: 12:00]"). Lines with only TpsEqF / StdBy (daily totals) are not read.
 * Air Tahiti Nui prints it "Horaires en LOC Escale" ("lun. 01" as the day, HDV for BLH, no CheckOut): local times with the UTC
 * under them ("17:35 Z", "04:55 Z (+1)") -> "17:35 Z / 10:35 L"; a flight number alone ("TN008"); a flight landing the next day
 * is "TN008 LAX >" then "TN008 < CDG" with the arrival: one row, end "+1".
 */
function parsePlanningNavigant(pages) {
  const trace = startTrace();
  const rows = [];
  const all = pages.flatMap(p => p.items);
  const head = all.map(i => /^([A-ZÉÛ]+)\.? (\d{4})$/.exec(i.text)).find(m => m && frenchMonth(m[1]) >= 0);
  if (!head) return { format: 'planning-navigant', period: null, notices: [], recognized: false, published: [], planned: [], _trace: trace, _rows: [] };
  const year0 = +head[2], month0 = frenchMonth(head[1]);
  // "Liste des codes activités": Groupe | Acti | Description
  const legend = new Map();
  for (const page of pages) {
    const t = page.items.find(i => i.text === 'Liste des codes activités');
    const acti = t && page.items.find(i => i.text === 'Acti' && i.y > t.y);
    const desc = acti && page.items.find(i => i.text === 'Description' && Math.abs(i.y - acti.y) < 3);
    if (!desc) continue;
    for (const l of toLines(page.items.filter(i => i.y > acti.y + 3 && !/^Part\.\*:/.test(i.text)))) {
      const code = l.items.find(i => Math.abs(i.x - acti.x) < 8), d = l.items.filter(i => i.x >= desc.x - 5).map(i => i.text).join(' ');
      if (code && d) legend.set(code.text, d);
    }
  }
  const dayRow = (t) => { const d = new Date(t); return { date: `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${String(d.getUTCFullYear() % 100).padStart(2, '0')}`, day: WEEKDAYS[d.getUTCDay()], t }; };
  // "Horaires en GMT": times are UTC; "Horaires en LOC Escale": local, with the UTC one under it ("17:35 Z", "04:55 Z (+1)")
  const local = all.some(i => /^Horaires en LOC/.test(i.text));
  let open = null; // a flight going on into the next day (">" in Arri)
  for (const page of pages) {
    const hdr = page.items.find(i => i.text === 'CheckIn');
    if (!hdr) continue;
    const cols = page.items.filter(i => Math.abs(i.y - hdr.y) < 3 && PN_COLS[i.text]).map(i => ({ col: PN_COLS[i.text], x: i.x })).sort((a, b) => a.x - b.x);
    const colOf = (it) => cols.reduce((c, h) => (h.x <= it.x + 4 ? h.col : c), 'date');
    const actiX = cols.find(c => c.col === 'acti').x, depX = cols.find(c => c.col === 'dep').x;
    const footY = page.items.find(i => /^Part\.\*:/.test(i.text))?.y ?? page.height;
    const body = page.items.filter(i => i.y > hdr.y + 8 && i.y < footY - 3);
    // days: the weekday ("lun.") starts the day, its date ("01 nov.") is a line or two lower
    // ("lun. 01" in one item when the month is the header's)
    const weekdays = body.filter(i => i.x < actiX - 5 && /^(lun|mar|mer|jeu|ven|sam|dim)\.( \d{2})?$/.test(i.text)).sort((a, b) => a.y - b.y);
    const dates = body.filter(i => i.x < actiX - 5 && /^\d{2} \S+$/.test(i.text) && frenchMonth(i.text.split(' ')[1]) >= 0);
    const days = weekdays.map((w, k) => {
      const end = weekdays[k + 1]?.y ?? Infinity;
      const own = /\. (\d{2})$/.exec(w.text);
      if (own) return { y: w.y, end, t: Date.UTC(year0, month0, +own[1]), items: [w] };
      const d = dates.filter(x => x.y > w.y - 3).sort((a, b) => a.y - b.y)[0];
      if (!d) return null;
      const [dd, mon] = d.text.split(' ');
      const m = frenchMonth(mon);
      return { y: w.y, end, t: Date.UTC(year0 + (m < month0 - 6 ? 1 : m > month0 + 6 ? -1 : 0), m, +dd), items: [w, d] };
    }).filter(Boolean);
    const lines = toLines(body.filter(i => i.x >= actiX - 5), 1.5);
    // a data line: something in Depa / Arri (an airport, or the hotel stay's ">" / "<")
    const isData = (l) => l.items.some(i => ['dep', 'arr'].includes(colOf(i)) && /^([A-Z]{3}|[<>])$/.test(i.text));
    const dataLines = lines.filter(isData);
    for (const l of lines) if (!isData(l)) {
      // wrapped activity text / Rep. après / times of the nearest data line within 8pt
      const near = dataLines.filter(d => Math.abs(d.y - l.y) <= 8).sort((a, b) => Math.abs(a.y - l.y) - Math.abs(b.y - l.y))[0];
      if (near) (near.extra ||= []).push(...l.items);
    }
    for (const l of dataLines) {
      const day = days.find(d => l.y >= d.y - 3 && l.y < d.end - 3);
      if (!day) continue;
      const cells = {}, its = {};
      for (const it of [...l.items, ...(l.extra || [])].sort((a, b) => a.y - b.y || a.x - b.x)) {
        let c = / Z/.test(it.text) ? colOf({ x: it.x + 10 }) : colOf(it); // "04:55 Z (+1)" starts left of its column
        if (it.x < depX - 3) c = 'acti';
        (its[c] ||= []).push(it);
      }
      for (const [c, list] of Object.entries(its)) cells[c] = list.map(i => i.text).join(' ').replace(/\s+/g, ' ').trim();
      const add = (r, marks) => {
        const row = { section: 'published', ...dayRow(day.t), notes: [], ...r };
        rows.push(row);
        for (const [f, it] of marks) if (it?.length) mark(row, f, it);
        if (!rows.some(x => x !== row && x.t === day.t)) mark(row, 'date', day.items);
        return row;
      };
      const time = (s) => (/^\d{2}:\d{2}$/.test(s || '') ? s : '');
      // a time column: "14:00" (UTC, or local), with its UTC under it in the local print ("04:55 Z (+1)"); `days` later than the line's day
      const tm = (col, days = 0) => {
        const list = its[col] || [];
        const l = list.find(i => /^\d{2}:\d{2}$/.test(i.text))?.text;
        const z = list.map(i => /^(\d{2}:\d{2}) Z(?: \(\+(\d)\))?$/.exec(i.text)).find(Boolean);
        const plus = (n) => (n > 0 ? ` +${n}` : '');
        if (!local) return l ? `${l}${plus(days)}` : '';
        if (z && l) return `${z[1]} Z${plus(days + +(z[2] || 0))} / ${l} L${plus(days)}`;
        return l ? `${l} L${plus(days)}` : z ? `${z[1]} Z${plus(days + +(z[2] || 0))}` : '';
      };
      const acti = cells.acti || '';
      const actiItems = its.acti || [];
      const dep = /^[A-Z]{3}$/.test(cells.dep || '') ? cells.dep : '', arr = /^[A-Z]{3}$/.test(cells.arr || '') ? cells.arr : '';
      if (tm('ci')) add({ duty: 'C/I', dep, begin: tm('ci') }, [['ci', its.ci]]);
      let m;
      let row;
      if ((m = /^HOT - (.+?)(?: - HOTEL)?$/.exec(acti))) {
        if (cells.arr === '<' || cells.dep === '<') continue; // the stay's last day
        row = add({ duty: 'H', dep: dep || arr, begin: tm('begin'), notes: [m[1]] }, [['dep', its.dep || its.arr], ['begin', its.begin], ['info', actiItems]]);
      } else if (cells.dep === '<' && open) {
        // the arrival of yesterday's flight: "TN008 < CDG" with its Harr
        const n = Math.round((day.t - open.t) / 86400000);
        Object.assign(open, { arr, end: tm('end', n) });
        for (const [f, it] of [['arr', its.arr], ['end', its.end]]) if (it?.length) mark(open, f, it);
        if (time(cells.blh)) { open.notes.push(`[Block: ${cells.blh}]`); mark(open, 'info', its.blh); }
        row = open;
        open = null;
      } else if ((m = /^(FLT|MEP) - ([A-Z0-9]{2}\d{1,4}[A-Z]?)(?: - (\S+))?(?: -)?$/.exec(acti)
        // a flight number alone ("TN008", local print), not a code of the list ("F17", "RM2") nor a duty at one airport
        || (!legend.has(acti) && dep !== arr && /^()([A-Z0-9]{2}\d{1,4}[A-Z]?)()$/.exec(acti)))) {
        row = add({ duty: m[2], dc: m[1] === 'MEP' ? 'MEP' : '', dep, arr, begin: tm('begin'), end: tm('end'), ac: m[3] || '' },
          [['duty', actiItems], ['dep', its.dep], ['arr', its.arr], ['begin', its.begin], ['end', its.end]]);
        if (time(cells.blh)) { row.notes.push(`[Block: ${cells.blh}]`); mark(row, 'info', its.blh); }
        open = cells.arr === '>' ? row : null;
      } else {
        m = /^(\S+?)(?: - (.+))?$/.exec(acti);
        const code = m ? m[1] : acti, desc = m?.[2] || legend.get(code);
        row = add({ duty: code, dep, arr, begin: tm('begin'), end: tm('end'), notes: desc ? [`[${code}: ${desc}]`] : [] },
          [['duty', actiItems], ['dep', its.dep], ['arr', its.arr], ['begin', its.begin], ['end', its.end]]);
      }
      if (tm('co')) {
        const notes = [['Duty', 'tsv'], ['TS', 'ts'], ['TSV Max', 'tsvMax']].filter(([, k]) => time(cells[k])).map(([n, k]) => `[${n}: ${cells[k]}]`);
        const rest = (its.repApres || []).find(i => /^\d{2}:\d{2}$/.test(i.text));
        if (rest) notes.push(`[Rest: ${rest.text}]`);
        add({ duty: 'C/O', arr: row.arr || row.dep, end: tm('co'), notes }, [['co', its.co], ['info', [...(its.tsv || []), ...(its.ts || []), ...(its.tsvMax || []), rest]]]);
      }
    }
  }
  const p = `01${MONTHS[month0]}${String(year0).slice(2)}`;
  const out = rows.map(({ t, ...r }) => outputRow({ ...r, info: r.notes.join(' ') }, local ? 'L' : 'Z'));
  return { format: 'planning-navigant', period: `${p} - ${new Date(Date.UTC(year0, month0 + 1, 0)).getUTCDate()}${p.slice(2)}`, notices: [], recognized: out.length > 0, published: out, planned: [], _trace: trace, _rows: rows };
}

const ES_WEEKDAYS = { Dom: 'Sun', Lun: 'Mon', Mar: 'Tue', Mie: 'Wed', Jue: 'Thu', Vie: 'Fri', Sab: 'Sat' };
const spanishMonth = (t) => ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'].indexOf(String(t).slice(0, 3).toLowerCase());
const isIberiaMonthly = (page) => page.items.some(i => i.text === 'Etapas (Hora UTC)') && lineTexts(page).some(t => /\(Hora local de firma y despedida\)$/.test(t));

/**
 * Iberia's monthly roster letter ("Septiembre 2025 (Hora local de firma y despedida)"): two calendar blocks of days
 * ("Lun" over "01"), each day's column stacked: the pairing ("3311", its first day), marks ("D", "*", "X" day off),
 * the sign-on (firma) "0615", the station the duty ends at "MAD", the release (despedida) "1120" (local times),
 * an indicator ("C3", "U", "E"); "----" / ">>>>" on the days a pairing goes on; a duty code with its times ("1330" "IM" "2359").
 * Then "Etapas (Hora UTC)": a line per day ("6 Sab") with its legs "529 MAD 0515 LIS 0645 530 LIS 0725 MAD 0850", "DH" before
 * a deadhead leg. Rows: per duty a C/I (firma, L, "[Pairing: 3311]"), its legs (UTC; the legs from its day up to the next
 * duty's), a C/O (despedida, L, "+1" when before the firma, arr = the station); a code with times ("[IM: IMAGINARIA]" from
 * "Descripcion de codigos"); a lone mark (X, D, *) a row of its own. The pairings page and the bids page are not read.
 */
function parseIberiaMonthly(pages) {
  const trace = startTrace();
  const page = pages.find(isIberiaMonthly);
  const head = page.items.map(i => /^([A-Z][a-z]+) (\d{4})$/.exec(i.text)).find(m => m && spanishMonth(m[1]) >= 0);
  if (!head) return { format: 'iberia-monthly', period: null, notices: [], recognized: false, published: [], planned: [], _trace: trace, _rows: [] };
  const year0 = +head[2], month0 = spanishMonth(head[1]);
  const dayRow = (t) => { const d = new Date(t); return { date: `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${String(d.getUTCFullYear() % 100).padStart(2, '0')}`, day: WEEKDAYS[d.getUTCDay()], t }; };
  const hhmm = (s) => `${s.slice(0, 2)}:${s.slice(2)}`;
  const etapas = page.items.find(i => i.text === 'Etapas (Hora UTC)');
  const codesTitle = page.items.find(i => i.text === 'Descripcion de codigos');
  const msgTitle = page.items.find(i => i.text === 'Mensajes');
  // "Descripcion de codigos": "6 Mie IM - IMAGINARIA"
  const legend = new Map();
  if (codesTitle) {
    for (const l of toLines(page.items.filter(i => i.y > codesTitle.y + 3 && i.y < (msgTitle?.y ?? page.height) - 3))) {
      const m = /^\d{1,2} \S+ (\S+) - (.+)$/.exec(l.items.map(i => i.text).join(' '));
      if (m) legend.set(m[1], m[2]);
    }
  }
  // calendar blocks: a weekday line, the day numbers under it, the columns down to the next block / Etapas
  const wdLines = toLines(page.items.filter(i => i.y < etapas.y)).filter(l => l.items.filter(i => ES_WEEKDAYS[i.text]).length >= 7);
  const units = []; // { t, rows: [] } in date order
  let month = month0, year = year0, lastDay = null;
  const duties = [];
  wdLines.forEach((wl, b) => {
    const numLine = toLines(page.items.filter(i => i.y > wl.y + 2 && i.y < wl.y + 16)).find(l => l.items.filter(i => /^\d{2}$/.test(i.text)).length >= 7);
    if (!numLine) return;
    const bottom = wdLines[b + 1]?.y ?? etapas.y;
    const cols = numLine.items.filter(i => /^\d{2}$/.test(i.text)).map(i => ({ item: i, cx: i.x + (i.w || 0) / 2 }));
    const pitch = (cols.at(-1).cx - cols[0].cx) / Math.max(1, cols.length - 1);
    const below = page.items.filter(i => i.y > numLine.y + 3 && i.y < bottom - 3);
    for (const col of cols) {
      const n = +col.item.text;
      if (lastDay != null && n < lastDay) { month += 1; if (month > 11) { month = 0; year += 1; } }
      lastDay = n;
      const t = Date.UTC(year, month, n);
      const its = below.filter(i => Math.abs(i.x + (i.w || 0) / 2 - col.cx) < pitch / 2).sort((a, b2) => a.y - b2.y);
      const isNum = (i) => /^\d{4}$/.test(i?.text || '');
      const s = its.findIndex(i => /^[A-Z]{3}$/.test(i.text));
      const dateMarks = [col.item];
      if (s > 0 && isNum(its[s - 1])) {
        const firma = its[s - 1], end = isNum(its[s + 1]) ? its[s + 1] : null;
        const pairing = isNum(its[s - 2]) ? its[s - 2] : its.slice(0, s - 1).find(isNum);
        const ci = { section: 'published', ...dayRow(t), duty: 'C/I', begin: `${hhmm(firma.text)} L`, notes: pairing ? [`[Pairing: ${pairing.text}]`] : [] };
        mark(ci, 'date', dateMarks); mark(ci, 'ci', firma); if (pairing) mark(ci, 'info', pairing);
        const co = end && { section: 'published', ...dayRow(t), duty: 'C/O', arr: its[s].text, end: `${hhmm(end.text)} L${end.text < firma.text ? ' +1' : ''}`, notes: [] };
        if (co) { mark(co, 'co', end); mark(co, 'arr', its[s]); }
        const unit = { t, rows: [ci], co, legs: [] };
        units.push(unit);
        duties.push(unit);
        continue;
      }
      // a duty code between two times ("1330" "IM" "2359"), or marks alone
      const k = its.findIndex((i, j) => /^[A-Z][A-Z0-9]{1,4}$/.test(i.text) && isNum(its[j - 1]) && isNum(its[j + 1]));
      if (k > 0) {
        const code = its[k].text;
        const r = { section: 'published', ...dayRow(t), duty: code, begin: `${hhmm(its[k - 1].text)} L`, end: `${hhmm(its[k + 1].text)} L`, notes: legend.has(code) ? [`[${code}: ${legend.get(code)}]`] : [] };
        mark(r, 'date', dateMarks); mark(r, 'duty', its[k]); mark(r, 'begin', its[k - 1]); mark(r, 'end', its[k + 1]);
        units.push({ t, rows: [r] });
        continue;
      }
      const marks = its.filter(i => /^(X|D|\*|[A-Z]{2,4})$/.test(i.text)); // "VA" (vacaciones) as well
      if (marks.length) {
        const m0 = marks.find(i => i.text === 'X') || marks[0];
        const r = { section: 'published', ...dayRow(t), duty: m0.text, notes: [] };
        mark(r, 'date', dateMarks); mark(r, 'duty', m0);
        units.push({ t, rows: [r] });
      }
    }
  });
  // Etapas: "6 Sab 529 MAD 0515 LIS 0645 ..." (the first line may be the month before: "31 Jue")
  let eMonth = null, eYear = null, eLast = null;
  for (const l of toLines(page.items.filter(i => i.y > etapas.y + 3 && i.y < (codesTitle?.y ?? msgTitle?.y ?? page.height) - 3))) {
    // "6 Sab ...", or with the rank before it: "FO-T 2 Lun ..."; legs may be one item "||1662 MAD 0815 HEL 1225||"
    const words = l.items.flatMap((i) => {
      const m = /^\|\|(.+)\|\|$/.exec(i.text);
      if (!m) return wordsIn(i);
      const cw = i.w / i.text.length;
      return wordsIn({ ...i, text: m[1], x: i.x + 2 * cw, w: m[1].length * cw, _src: i._src || i, _off: (i._off || 0) + 2 });
    });
    const at = words.findIndex((i, k) => /^\d{1,2}$/.test(i.text) && ES_WEEKDAYS[words[k + 1]?.text]);
    if (at < 0) continue;
    const its = words.slice(at);
    const n = +its[0].text;
    if (eMonth == null) {
      eMonth = month0; eYear = year0;
      const wd = ES_WEEKDAYS[its[1].text];
      if (WEEKDAYS[new Date(Date.UTC(eYear, eMonth, n)).getUTCDay()] !== wd) {
        const prev = new Date(Date.UTC(eYear, eMonth - 1, n));
        if (WEEKDAYS[prev.getUTCDay()] === wd) { eMonth = prev.getUTCMonth(); eYear = prev.getUTCFullYear(); }
      }
    } else if (n < eLast) { eMonth += 1; if (eMonth > 11) { eMonth = 0; eYear += 1; } }
    eLast = n;
    const t = Date.UTC(eYear, eMonth, n);
    let dh = false;
    for (let k = 2; k < its.length; k++) {
      if (its[k].text === 'DH') { dh = true; continue; }
      const [f, a, t1, b2, t2] = its.slice(k, k + 5);
      if (!(/^\d{1,4}$/.test(f.text) && /^[A-Z]{3}$/.test(a?.text || '') && /^\d{4}$/.test(t1?.text || '') && /^[A-Z]{3}$/.test(b2?.text || '') && /^\d{4}$/.test(t2?.text || ''))) continue;
      const leg = { section: 'published', ...dayRow(t), dc: dh ? 'DH' : '', duty: f.text, dep: a.text, begin: `${hhmm(t1.text)} Z`, arr: b2.text,
        end: `${hhmm(t2.text)} Z${t2.text < t1.text ? ' +1' : ''}`, notes: [] };
      mark(leg, 'duty', f); mark(leg, 'dep', a); mark(leg, 'begin', t1); mark(leg, 'arr', b2); mark(leg, 'end', t2);
      if (!units.some(u => u.rows.some(r => r.t === t))) mark(leg, 'date', [its[0], its[1]]);
      const duty = [...duties].reverse().find(u => u.t <= t && t - u.t <= 4 * 86400000);
      if (duty) duty.legs.push(leg); else units.push({ t, rows: [leg] });
      dh = false;
      k += 4;
    }
  }
  const rows = [];
  for (const u of units.sort((a, b) => a.t - b.t)) {
    if (u.legs && !u.legs.length && u.co) {
      // no leg: a ground duty whose code sits where the station would ("1301" "MTY" "1500")
      const [ci, co] = [u.rows[0], u.co];
      Object.assign(ci, { duty: co.arr, end: co.end, notes: legend.has(co.arr) ? [`[${co.arr}: ${legend.get(co.arr)}]`] : [] });
      const FIELD = { ci: 'begin', co: 'end', arr: 'duty' };
      for (const e of TRACE || []) if ((e.row === ci || e.row === co) && FIELD[e.field]) Object.assign(e, { row: ci, field: FIELD[e.field] });
      if (TRACE) for (let k = TRACE.length - 1; k >= 0; k--) if (TRACE[k].row === ci && TRACE[k].field === 'info') TRACE.splice(k, 1); // a pairing number: not in this row
      rows.push(ci);
      continue;
    }
    rows.push(...u.rows);
    if (u.legs) {
      if (u.legs[0] && !u.rows[0].dep) u.rows[0].dep = u.legs[0].dep;
      rows.push(...u.legs);
      if (u.co) rows.push(u.co);
    }
  }
  const p = `01${MONTHS[month0]}${String(year0).slice(2)}`;
  const out = rows.map(({ t, ...r }) => outputRow({ ...r, info: r.notes.join(' ') }, 'Z'));
  return { format: 'iberia-monthly', period: `${p} - ${new Date(Date.UTC(year0, month0 + 1, 0)).getUTCDate()}${p.slice(2)}`, notices: [], recognized: out.length > 0, published: out, planned: [], _trace: trace, _rows: rows };
}

const OFP_LOG_HEAD = ['FLIGHT', 'DATE', 'FROM', 'TO', 'REG', 'TYPE', 'COMMANDER'];
const OFP_PLAN_HEAD = ['DATE', 'DEP', 'STD', 'DES', 'STA', 'REG', 'TYPE'];
const sameLine = (page, it) => page.items.filter(i => Math.abs(i.y - it.y) < 3).sort((a, b) => a.x - b.x);
const hasHeadLine = (page, names) => page.items.some(i => i.text === names[0] && names.every(n => sameLine(page, i).some(j => j.text === n)));
const isOfp = (page) => hasHeadLine(page, OFP_LOG_HEAD) || hasHeadLine(page, OFP_PLAN_HEAD);

/**
 * Flight plans / flight logs (OFP packages, TUI/Jetairfly/Corendon/Eurowings style), one or a few flights a file, UTC:
 *   flight log: FLIGHT | DATE | FROM | TO | REG | TYPE | COMMANDER, the values under it ("TB7351 20240307 GMMN LFJL OOJAS B737-700W RHE HEYLEN"),
 *     then "OFF BLOCK 15:11 TAKE OFF 15:24" / "ON BLOCK 18:17 LANDING 18:11" / "BLOCK 03:06 FLIGHT 02:47"
 *     -> begin / takeoff / landing / end, "[Block: 03:06] [Flight: 02:47]" (00:00 = not flown yet: left out); the commander, or the
 *     "Crew Onboard" list ("CP Raf Heylen [RHE], FO ...") -> crew "[CP - RHE - Raf Heylen]".
 *   flight plan: "TB1942" | DATE | DEP | STD | DES | STA | REG | TYPE | OFP REV and the values under it (the first one the ATC callsign)
 *     -> a row per flight with STD / STA.
 */
function parseOfp(pages) {
  const trace = startTrace();
  const rows = [];
  const dateOf = (s) => { const m = /^(\d{4})(\d{2})(\d{2})$/.exec(s); if (!m) return null; const t = Date.UTC(+m[1], +m[2] - 1, +m[3]); const d = new Date(t); return { date: `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${m[1].slice(2)}`, day: WEEKDAYS[d.getUTCDay()], t }; };
  const hhmm = (s) => (/^\d{4}$/.test(s) ? `${s.slice(0, 2)}:${s.slice(2)}` : s);
  const valueUnder = (page, head, name) => {
    // the values line: the first line under the header with a value under DATE (a line of notes may come between)
    const h = sameLine(page, head).find(i => i.text === name);
    const dateHead = sameLine(page, head).find(i => i.text === 'DATE');
    const below = page.items.filter(i => i.y > head.y + 3 && i.y < head.y + 25).sort((a, b) => a.y - b.y);
    const y = below.find(i => Math.abs(i.x - dateHead.x) < 6)?.y;
    return h && y != null ? below.filter(i => Math.abs(i.y - y) < 3).find(i => Math.abs(i.x - h.x) < 6) : null;
  };
  // "Crew Onboard": "CP Raf Heylen [RHE], FO Brecht Van Brussel [BRL], ..." over a few lines
  let crew = '', crewItems = [];
  for (const page of pages) {
    const t = page.items.find(i => i.text === 'Crew Onboard');
    if (!t || crew) continue;
    const next = page.items.filter(i => i.y > t.y + 3 && i.x < t.x + 10 && !/,\s*$/.test(i.text)).sort((a, b) => a.y - b.y).find(i => !/^[A-Z]{2,4} .+\[/.test(i.text));
    crewItems = page.items.filter(i => i.y > t.y + 3 && i.y < (next?.y ?? Infinity) - 2 && Math.abs(i.x - t.x) < 10);
    crew = [...crewItems.map(i => i.text).join(' ').matchAll(/([A-Z]{2,4}) ([^,[]+?) \[([A-Z]+)\]/g)].map(m => `[${m[1]} - ${m[3]} - ${m[2].trim()}]`).join('');
  }
  for (const page of pages) {
    for (const head of page.items.filter(i => i.text === 'FLIGHT' && OFP_LOG_HEAD.every(n => sameLine(page, i).some(j => j.text === n)))) {
      const v = (n) => valueUnder(page, head, n);
      const d = dateOf(v('DATE')?.text || '');
      if (!d) continue;
      const after = page.items.filter(i => i.y > head.y + 15 && i.y < head.y + 60);
      const timeAfter = (...words) => {
        const w = after.find(i => i.text === words.at(-1) && (words.length === 1 || sameLine(page, i).some(j => j.text === words[0] && j.x < i.x)));
        return w && sameLine(page, w).find(j => j.x > w.x && /^\d{2}:\d{2}$/.test(j.text));
      };
      let [off, to, ld, on] = [timeAfter('OFF', 'BLOCK'), timeAfter('TAKE', 'OFF'), timeAfter('LANDING'), timeAfter('ON', 'BLOCK')]; // eslint-disable-line prefer-const
      const blockLine = after.find(i => i.text === 'BLOCK' && i.x < head.x + 5 && !sameLine(page, i).some(j => j.text === 'OFF' || j.text === 'ON'));
      const blk = blockLine && sameLine(page, blockLine).find(j => /^\d{2}:\d{2}$/.test(j.text));
      const flt = blockLine && sameLine(page, blockLine).filter(j => /^\d{2}:\d{2}$/.test(j.text))[1];
      const t = (i) => (i && i.text !== '00:00' ? i.text : '');
      if (blk?.text === '00:00' && off?.text === on?.text) { off = null; on = null; } // not flown yet: off = on block, no block time
      const cmd = sameLine(page, v('COMMANDER') || head).filter(i => i.x >= (v('COMMANDER')?.x ?? Infinity));
      const r = {
        section: 'published', ...d, duty: v('FLIGHT')?.text || '', dep: v('FROM')?.text || '', arr: v('TO')?.text || '', registration: v('REG')?.text || '', ac: v('TYPE')?.text || '',
        begin: off?.text || '', takeoff: t(to), landing: t(ld), end: on?.text || '',
        crew: crew || (cmd.length ? `[COMMANDER - ${cmd.map(i => i.text).join(' ')}]` : ''),
        notes: [t(blk) && `[Block: ${blk.text}]`, t(flt) && `[Flight: ${flt.text}]`].filter(Boolean),
      };
      rows.push(r);
      for (const [f, it] of [['date', v('DATE')], ['duty', v('FLIGHT')], ['dep', v('FROM')], ['arr', v('TO')], ['registration', v('REG')], ['ac', v('TYPE')],
        ['begin', off], ['takeoff', t(to) && to], ['landing', t(ld) && ld], ['end', on], ['info', t(blk) && blk], ['info', t(flt) && flt],
        ['crew', crew ? crewItems : cmd]]) if (it && [].concat(it).length) mark(r, f, it);
    }
    for (const head of page.items.filter(i => i.text === 'DATE' && OFP_PLAN_HEAD.every(n => sameLine(page, i).some(j => j.text === n)))) {
      const flight = sameLine(page, head).find(i => i.x < head.x && /^[A-Z0-9]{2,3}\d{1,4}[A-Z]?$/.test(i.text));
      const v = (n) => valueUnder(page, head, n);
      const d = dateOf(v('DATE')?.text || '');
      if (!d || !flight) continue;
      const r = {
        section: 'published', ...d, duty: flight.text, dep: v('DEP')?.text || '', arr: v('DES')?.text || '', begin: hhmm(v('STD')?.text || ''), end: hhmm(v('STA')?.text || ''),
        registration: v('REG')?.text || '', ac: v('TYPE')?.text || '', notes: [],
      };
      if (r.begin && r.end && r.end < r.begin) r.end += '+1';
      rows.push(r);
      for (const [f, it] of [['date', v('DATE')], ['duty', flight], ['dep', v('DEP')], ['arr', v('DES')], ['begin', v('STD')], ['end', v('STA')], ['registration', v('REG')], ['ac', v('TYPE')]]) if (it) mark(r, f, it);
    }
  }
  rows.sort((a, b) => a.t - b.t || a.begin.localeCompare(b.begin));
  const ts = rows.map(r => r.t);
  const per = ts.length ? [Math.min(...ts), Math.max(...ts)].map(x => new Date(x)).map(d => `${String(d.getUTCDate()).padStart(2, '0')}${MONTHS[d.getUTCMonth()]}${String(d.getUTCFullYear() % 100).padStart(2, '0')}`).join(' - ') : null;
  const out = rows.map(({ t, ...r }) => outputRow({ ...r, info: r.notes.join(' ') }, 'Z'));
  return { format: 'ofp', period: per, notices: [], recognized: out.length > 0, published: out, planned: [], _trace: trace, _rows: rows };
}

const SUMMARY_DAY_RE = /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun), (\d{1,2})$/;
const isScheduleSummary = (page) => page.items.some(i => /^.+ (Schedule|Escala|Roster) Summary, /.test(i.text)) && page.items.some(i => SUMMARY_DAY_RE.test(i.text));

/**
 * "<Name> Schedule Summary, 31 Jan - 29 Feb 2024" ("Escala Summary" in Portuguese; Crew Access): a day header
 * "Thu, 1" "st" "February 2024 (Local time)", then a line per event: name | "14:00 - 15:00" ("+1") | "OOL" or "MCY - CNS" |
 * position | "Trainee" | "Flight Time: 02:20". Report / Apresentação -> C/I (its start), Release -> C/O (its end), a flight
 * ("AB589", "SV123 (Deadheading)" -> dc DH) with "[CPT] [Trainee] [Flight: 02:20]", Hotel -> a hotel row, "Off (RDO)" ->
 * duty RDO "[RDO: Off]" (any "Name (CODE)"), others as named ("Transit"). Local times.
 */
function parseScheduleSummary(pages) {
  const trace = startTrace();
  const rows = [];
  let cur = null, curItems = null, zone = 'L';
  const title = pages.flatMap(p => p.items).map(i => /(?:Schedule|Escala|Roster) Summary, (\d{1,2})(?: ([A-Z][a-z]{2}))?(?: (\d{4}))? - (\d{1,2}) ([A-Z][a-z]{2}) (\d{4})$/.exec(i.text)).find(Boolean);
  for (const page of pages) {
    for (const l of toLines(page.items, 2)) {
      const its = l.items;
      const dm = SUMMARY_DAY_RE.exec(its[0]?.text || '');
      const monthItem = its.find(i => /^[A-Z][a-z]+ \d{4} \((Local time|UTC)\)$/.test(i.text));
      if (monthItem && /\(UTC\)$/.test(monthItem.text)) zone = 'Z';
      if (dm && monthItem) {
        const [mon, yyyy] = monthItem.text.split(' ');
        const t = Date.UTC(+yyyy, monthIndex(mon.slice(0, 3)), +dm[2]);
        const d = new Date(t);
        cur = { date: `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${yyyy.slice(2)}`, day: WEEKDAYS[d.getUTCDay()] };
        curItems = its;
        continue;
      }
      if (!cur) continue;
      const tIdx = its.findIndex(i => /^\d{2}:\d{2} - \d{2}:\d{2}( \+\d)?$/.test(i.text));
      if (tIdx < 1) continue;
      const name = its.slice(0, tIdx).map(i => i.text).join(' ');
      const tm = /^(\d{2}:\d{2}) - (\d{2}:\d{2})(?: \+(\d))?$/.exec(its[tIdx].text);
      const timeItem = its[tIdx];
      const begin = pieceOf(timeItem, 0, 5), end = pieceOf(timeItem, 8, timeItem.text.length - 8);
      const rest = its.slice(tIdx + 1);
      const routeItem = rest.find(i => /^[A-Z]{3}( - [A-Z]{3})?$/.test(i.text));
      const [dep, arr] = routeItem ? routeItem.text.split(' - ') : [];
      const extras = rest.filter(i => i !== routeItem);
      const notes = extras.map(i => {
        const ft = /^Flight Time: (\d{1,2}:\d{2})$/.exec(i.text);
        return ft ? `[Flight: ${ft[1].padStart(5, '0')}]` : `[${i.text}]`;
      });
      const add = (r, marks) => {
        const row = { section: 'published', ...cur, notes: [], ...r };
        rows.push(row);
        for (const [f, it] of marks) if (it && [].concat(it).length) mark(row, f, it);
        if (curItems) { mark(row, 'date', curItems); curItems = null; }
        return row;
      };
      const endTime = `${tm[2]}${tm[3] ? `+${tm[3]}` : ''}`;
      const routeMarks = routeItem ? (arr ? [['dep', pieceOf(routeItem, 0, 3)], ['arr', pieceOf(routeItem, 6, 3)]] : [['dep', routeItem]]) : [];
      let m;
      if (/^(Report|Apresentação|Apresentacao)$/.test(name)) add({ duty: 'C/I', dep: dep || '', begin: tm[1] }, [['ci', begin], ...routeMarks]);
      else if (/^(Release|Liberação|Liberacao|Post Flt Duty)$/.test(name)) add({ duty: 'C/O', arr: dep || '', end: endTime }, [['co', end], ['arr', routeItem]]);
      else if ((m = /^([A-Z0-9]{2}\d{1,4}[A-Z]?)(?: \((Deadheading)\))?$/.exec(name))) {
        add({ duty: m[1], dc: m[2] ? 'DH' : '', dep: dep || '', arr: arr || '', begin: tm[1], end: endTime, notes },
          [['duty', its.slice(0, tIdx)], ['begin', begin], ['end', end], ...routeMarks, ['info', extras]]);
      } else if (name === 'Hotel') add({ duty: 'H', dep: dep || '', begin: tm[1], end: endTime, notes }, [['begin', begin], ['end', end], ...routeMarks, ['info', extras]]);
      else {
        m = /^(.+?) \(([^)]+)\)$/.exec(name);
        add({ duty: m ? m[2] : name, dep: dep || '', arr: arr || '', begin: tm[1], end: endTime, notes: [...(m ? [`[${m[2]}: ${m[1]}]`] : []), ...notes] },
          [['duty', its.slice(0, tIdx)], ['begin', begin], ['end', end], ...routeMarks, ['info', extras]]);
      }
    }
  }
  // ("14 - 31 Jan 2026": one month)
  const p = title && `${title[1].padStart(2, '0')}${title[2] || title[5]}${(title[3] || title[6]).slice(2)} - ${title[4].padStart(2, '0')}${title[5]}${title[6].slice(2)}`;
  const out = rows.map(r => outputRow({ ...r, info: r.notes.join(' ') }, zone));
  return { format: 'schedule-summary', period: p || null, notices: [], recognized: out.length > 0, published: out, planned: [], _trace: trace, _rows: rows };
}

const isPortCrewRosterReport = (page) => page.items.some(i => i.text === 'Crew Roster Report') && page.items.some(i => i.text === '(Times shown are in Port Local times)')
  && ['Sector', 'Rpt', 'STD', 'STA'].every(t => page.items.some(i => i.text === t));

/**
 * "Crew Roster Report (Times shown are in Port Local times)" (Singapore Airlines), a line per event:
 *   Start Date | Day | Flight Number | Sector | A/C | Duty | Pairing Duty | Crew Rank | Rpt | STD | STA | Flight Time | Duty Time | Hotel |
 *   INSTR/PUPIL | Training | Remarks
 *   "05Jul26 Sun SQ656 SIN-FUK 787 TVL PU FO 0020 0120 0828 7:38"; "FUK LO FUKHILSH" (layover: a hotel row a line);
 *   a flight reported late on one day ("07Jul26 SQ810 SIN-PKX ... Rpt 2330 06:05 7:35") and flown the next ("08Jul26 SQ810 SIN-PKX STD 0030
 *   STA 0635"), or landing the next ("01Aug26 HND-SIN STA 0525": end "+1"); ground duties "SIN STBY FO 1700 1700 2000 3:00",
 *   training "SIN BFTD2 ... PUPIL 737CONFP" with "T02" wrapped under it.
 * Rpt of a flight -> a C/I row; TVL -> dc DH; "[Flight: 06:00] [Duty: 07:30]"; a ground duty runs STD-STA; INSTR/PUPIL, Training,
 * Remarks -> "[PUPIL] [Training: 737CONFPT02] [FTD unserviceable]"; "Duty Codes" (Duty | Duty Desc) -> "[STBY: STANDBY DUTY]".
 */
function parsePortCrewRosterReport(pages) {
  const trace = startTrace();
  const rows = [];
  const NAMES = ['date', 'day', 'flight', 'sector', 'ac', 'duty', 'pairing', 'rank', 'rpt', 'std', 'sta', 'ft', 'dt', 'hotel', 'pupil', 'training', 'remarks'];
  const HEADS = ['Start', 'Day', 'Flight', 'Sector', 'A/C', 'Duty', 'Pairing', 'Crew', 'Rpt', 'STD', 'STA', 'Flight', 'Duty', 'Hotel', 'INSTR/', 'Training', 'Remarks'];
  // "Duty Codes": Duty | Duty Desc
  const legend = new Map();
  for (const page of pages) {
    const t = page.items.find(i => i.text === 'Duty Codes');
    const dh = t && page.items.find(i => i.text === 'Duty Desc');
    if (!dh) continue;
    for (const l of toLines(page.items.filter(i => i.y > dh.y + 3))) {
      const [code, ...desc] = l.items;
      if (desc.length) legend.set(code.text, desc.map(i => i.text).join(' '));
    }
  }
  // "From | 04Jul26 | -- | 31Aug26" or "From | 01Apr26 -- 30Apr26"
  const per = pages.flatMap(p => p.items).find(i => i.text === 'From');
  const perItems = per && sameLine(pages.find(p => p.items.includes(per)), per).flatMap(i => i.text.split(/\s+--\s+/).map(text => ({ text }))).filter(i => /^\d{2}[A-Z][a-z]{2}\d{2}$/.test(i.text));
  const dateOf = (s) => { const m = /^(\d{2})([A-Z][a-z]{2})(\d{2})$/.exec(s); if (!m) return null; const t = Date.UTC(2000 + +m[3], monthIndex(m[2]), +m[1]); const d = new Date(t); return { date: `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${m[3]}`, day: WEEKDAYS[d.getUTCDay()], t }; };
  const hhmm = (s) => (/^\d{4}$/.test(s || '') ? `${s.slice(0, 2)}:${s.slice(2)}` : '');
  const dur = (s) => (/^\d{1,2}:\d{2}$/.test(s || '') ? s.padStart(5, '0') : '');
  let cur = null, curItems = null, pendingNotes = null, open = null, lastRow = null;
  for (const page of pages) {
    const head = page.items.find(i => i.text === 'Sector');
    if (!head) continue;
    const stop = page.items.find(i => i.text === 'Duty Codes')?.y ?? page.height;
    // header words left to right; a name's second time is the other column (Flight Time, Duty Time; cabin crew: "Sector Duty")
    const seen = new Set();
    const cols = sameLine(page, head).map((h) => {
      const second = seen.has(h.text);
      seen.add(h.text);
      const col = second ? { Flight: 'ft', Duty: 'dt', Sector: 'pairing' }[h.text]
        : { Start: 'date', Day: 'day', Flight: 'flight', Sector: 'sector', 'A/C': 'ac', Duty: 'duty', Pairing: 'pairing', Crew: 'rank', Acting: 'rank', Rpt: 'rpt',
          STD: 'std', STA: 'sta', FDP: 'fdp', Hotel: 'hotel', 'INSTR/': 'pupil', Training: 'training', Remarks: 'remarks' }[h.text];
      return col && { col, c: h.x + (h.w || 0) / 2 };
    }).filter(Boolean);
    const colOf = (i) => cols.reduce((b, h) => (Math.abs(h.c - (i.x + (i.w || 0) / 2)) < Math.abs(b.c - (i.x + (i.w || 0) / 2)) ? h : b), cols[0]).col;
    const sub = page.items.find(i => i.text === 'Date' && i.y > head.y && i.y < head.y + 20);
    for (const l of toLines(page.items.filter(i => i.y > (sub?.y ?? head.y) + 4 && i.y < stop - 3), 2)) {
      const its = {};
      for (const i of l.items) (its[colOf(i)] ||= []).push(i);
      const cell = (c) => (its[c] || []).map(i => i.text).join(' ');
      const d = dateOf(cell('date'));
      if (d) { cur = d; curItems = [...its.date, ...(its.day || [])]; }
      if (!cur) continue;
      const add = (r, marks) => {
        const row = { section: 'published', ...cur, notes: [], ...r };
        rows.push(row);
        for (const [f, it] of marks) if (it && [].concat(it).length) mark(row, f, it);
        if (curItems) { mark(row, 'date', curItems); curItems = null; }
        lastRow = row;
        return row;
      };
      // a line with only Duty / Training / Remarks text: the wrapped end of the line above ("FMCT" + "RNG", "737CONFP" + "T01")
      if (Object.keys(its).every(c => c === 'duty' || c === 'training' || c === 'remarks')) {
        if (lastRow) {
          if (its.duty && lastRow.duty !== 'H') {
            const was = lastRow.duty;
            lastRow.duty += cell('duty');
            lastRow.notes = lastRow.notes.filter(n => !n.startsWith(`[${was}: `));
            if (legend.has(lastRow.duty)) lastRow.notes.unshift(`[${lastRow.duty}: ${legend.get(lastRow.duty)}]`);
          }
          lastRow.training = (lastRow.training || '') + (its.training ? cell('training') : '');
          if (its.remarks) lastRow.remark = [lastRow.remark, cell('remarks')].filter(Boolean).join(' ');
          mark(lastRow, 'info', l.items);
        }
        continue;
      }
      const sector = /^([A-Z]{3})-([A-Z]{3})$/.exec(cell('sector'));
      const station = /^[A-Z]{3}$/.test(cell('sector')) ? cell('sector') : '';
      const duty = cell('duty');
      const notes = [dur(cell('ft')) && `[Flight: ${dur(cell('ft'))}]`, dur(cell('dt')) && `[Duty: ${dur(cell('dt'))}]`, dur(cell('fdp')) && `[FDP: ${dur(cell('fdp'))}]`].filter(Boolean);
      const noteItems = [...(its.ft || []), ...(its.dt || []), ...(its.fdp || [])];
      const extra = (r) => {
        if (its.pupil) r.pupil = cell('pupil');
        if (its.training) r.training = cell('training');
        if (its.remarks) r.remark = cell('remarks');
        if (its.pupil || its.training || its.remarks) mark(r, 'info', [...(its.pupil || []), ...(its.training || []), ...(its.remarks || [])]);
      };
      if (sector) {
        const [dep, arr] = [sector[1], sector[2]];
        const sectorMarks = [['dep', pieceOf(its.sector[0], 0, 3)], ['arr', pieceOf(its.sector[0], 4, 3)]];
        // Rpt: a C/I, unless the duty's report printed again on a later leg
        const lastCi = [...rows].reverse().find(r => r.duty === 'C/I');
        if (hhmm(cell('rpt')) && !(lastCi && lastCi.t === cur.t && lastCi.begin === hhmm(cell('rpt')))) {
          add({ duty: 'C/I', dep, begin: hhmm(cell('rpt')) }, [['ci', its.rpt], ['dep', sectorMarks[0][1]]]);
        }
        if (hhmm(cell('std')) || (hhmm(cell('sta')) && !open)) { // (a flight without its STD: "SQ9655 FUK-SIN ... 0700 1300")
          const r = add({ duty: cell('flight').replace(/\s+/g, ''), dc: duty === 'TVL' ? 'DH' : '', dep, arr, begin: hhmm(cell('std')), end: hhmm(cell('sta')), ac: cell('ac'), notes: [...(pendingNotes || []), ...notes.filter(n => !(pendingNotes || []).includes(n))] },
            [['duty', its.flight], ...sectorMarks, ['begin', its.std], ['end', its.sta], ['ac', its.ac], ['info', [...(pendingNotes?.items || []), ...noteItems]]]);
          extra(r);
          if (r.end && r.end < r.begin) r.end += '+1';
          open = r.end ? null : r;
          pendingNotes = null;
        } else if (hhmm(cell('sta')) && open) {
          // the arrival of yesterday's flight
          const n = Math.round((cur.t - open.t) / 86400000);
          open.end = `${hhmm(cell('sta'))}${n > 0 ? `+${n}` : ''}`;
          mark(open, 'end', its.sta);
          open = null;
        } else if (!hhmm(cell('std'))) {
          pendingNotes = Object.assign([...notes], { items: noteItems });
        }
        continue;
      }
      if (duty === 'LO') {
        add({ duty: 'H', dep: station, notes: its.hotel ? [cell('hotel')] : [] }, [['dep', its.sector], ['info', its.hotel]]);
        continue;
      }
      if (duty) {
        const r = add({ duty, dep: station, begin: hhmm(cell('std')), end: hhmm(cell('sta')), notes: [legend.has(duty) && `[${duty}: ${legend.get(duty)}]`, ...notes].filter(Boolean) },
          [['duty', its.duty], ['dep', its.sector], ['begin', its.std], ['end', its.sta], ['info', noteItems]]);
        extra(r);
        if (r.end && r.begin && r.end < r.begin) r.end += '+1';
      }
    }
  }
  for (const r of rows) {
    r.notes.push(...[r.pupil && `[${r.pupil}]`, r.training && `[Training: ${r.training}]`, r.remark && `[${r.remark}]`].filter(Boolean));
  }
  const p = perItems?.length === 2 ? `${perItems[0].text} - ${perItems[1].text}` : null;
  const out = rows.map(({ t, pupil, training, remark, ...r }) => outputRow({ ...r, info: r.notes.join(' ') }, 'L'));
  return { format: 'port-crew-roster-report', period: p, notices: [], recognized: out.length > 0, published: out, planned: [], _trace: trace, _rows: rows };
}

const isFlightLogSummary = (page) => page.items.some(i => i.text === 'FLIGHT LOG SUMMARY REPORT') && page.items.some(i => i.text === 'Leg Date') && page.items.some(i => i.text === 'Hobbs');

/**
 * "FLIGHT LOG SUMMARY REPORT" (Jet Linx; base and aircraft "N217EC" above the table), a line per leg:
 *   Leg Date "10-24-19" | Trip # | Reg (the FAR part: 135 / 91) | PIC | SIC | DEP | ARR | Out | Off | On | In | Hobbs | Flight | Block | Night | IMC |
 *   T/O D N | Land D N | Appr P N | Hld | Trk | Pax | GTOW | ...
 * -> registration from above, begin / takeoff / landing / end (Out / Off / On / In, "1112" taken as UTC), crew "[PIC - CHUB][SIC - DFIE]",
 * info "[Trip: 624328] [FAR: 135] [Flight: 1.5] [Block: 1.7] [Night: 0.3] [IMC: 0.1] [Takeoff Day: 1] [Landing Day: 1] [Pax: 2]" (decimal hours as printed).
 */
function parseFlightLogSummary(pages) {
  const trace = startTrace();
  const rows = [];
  for (const page of pages) {
    const head = page.items.find(i => i.text === 'Leg Date');
    if (!head) continue;
    const reg = page.items.filter(i => i.y < head.y - 5 && /^[A-Z]{1,2}-?[A-Z0-9]{3,5}$/.test(i.text) && i.x < 60).sort((a, b) => b.y - a.y)[0];
    const seen = {};
    const cols = sameLine(page, head).map((h) => {
      const n = (seen[h.text] = (seen[h.text] || 0) + 1);
      const col = h.text === 'D' ? ['tkDay', 'ldDay'][n - 1] : h.text === 'N' ? ['tkNight', 'ldNight', 'apprN'][n - 1]
        : { 'Leg Date': 'date', 'Trip #': 'trip', Reg: 'far', PIC: 'pic', SIC: 'sic', DEP: 'dep', ARR: 'arr', Out: 'out', Of: 'off', Off: 'off', On: 'on', In: 'in',
          Flight: 'flight', Block: 'block', Night: 'night', IMC: 'imc', Pax: 'pax' }[h.text];
      return { col: col || `x${h.x}`, x: h.x };
    });
    const colOf = (i) => cols.reduce((b, h) => (Math.abs(h.x - i.x) < Math.abs(b.x - i.x) ? h : b), cols[0]).col;
    for (const l of toLines(page.items.filter(i => i.y > head.y + 4), 2)) {
      const its = {};
      for (const i of l.items) (its[colOf(i)] ||= []).push(i);
      const cell = (c) => (its[c] || []).map(i => i.text).join(' ');
      const dm = /^(\d{1,2})-(\d{1,2})-(\d{2})$/.exec(cell('date')); // "10-24-19", "9-15-19"
      if (!dm) continue;
      const t = Date.UTC(2000 + +dm[3], +dm[1] - 1, +dm[2]);
      const d = new Date(t);
      const tm = (c) => (/^\d{4}$/.test(cell(c)) ? cell(c) : '');
      const num = (c) => (/^\d+(\.\d+)?$/.test(cell(c)) && +cell(c) > 0 ? cell(c) : '');
      const info = [['Trip', 'trip'], ['FAR', 'far'], ['Flight', 'flight'], ['Block', 'block'], ['Night', 'night'], ['IMC', 'imc'],
        ['Takeoff Day', 'tkDay'], ['Takeoff Night', 'tkNight'], ['Landing Day', 'ldDay'], ['Landing Night', 'ldNight'], ['Pax', 'pax']]
        .filter(([, c]) => (c === 'trip' || c === 'far' ? cell(c) : num(c))).map(([k, c]) => [k, c]);
      const r = {
        section: 'published', date: `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${dm[3]}`, day: WEEKDAYS[d.getUTCDay()], duty: '', registration: reg?.text || '',
        dep: cell('dep'), arr: cell('arr'), begin: tm('out'), takeoff: tm('off'), landing: tm('on'), end: tm('in'),
        crew: [['PIC', 'pic'], ['SIC', 'sic']].filter(([, c]) => cell(c)).map(([k, c]) => `[${k} - ${cell(c)}]`).join(''),
        info: info.map(([k, c]) => `[${k}: ${cell(c)}]`).join(' '),
      };
      rows.push(r);
      for (const [f, c] of [['date', 'date'], ['dep', 'dep'], ['arr', 'arr'], ['begin', 'out'], ['takeoff', 'off'], ['landing', 'on'], ['end', 'in'], ['crew', 'pic'], ['crew', 'sic']]) if (its[c]) mark(r, f, its[c]);
      for (const [, c] of info) mark(r, 'info', its[c]);
      if (reg) mark(r, 'registration', reg);
    }
  }
  // "24/10/2019 - 25/10/2019", or month first "9/15/2019 - 9/16/2019"
  const per = pages.flatMap(p => p.items).map(i => /^(\d{1,2})\/(\d{1,2})\/(\d{4}) - (\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(i.text)).find(Boolean);
  if (per && +per[2] > 12) [per[1], per[2], per[4], per[5]] = [per[2], per[1], per[5], per[4]];
  const pd = (dd, mm, yyyy) => `${dd.padStart(2, '0')}${MONTHS[+mm - 1]}${yyyy.slice(2)}`;
  const out = rows.map(r => outputRow(r, 'Z'));
  return { format: 'flight-log-summary', period: per ? `${pd(per[1], per[2], per[3])} - ${pd(per[4], per[5], per[6])}` : null,
    notices: [], recognized: out.length > 0, published: out, planned: [], _trace: trace, _rows: rows };
}

const isQatarLogbook = (page) => page.items.some(i => i.text === 'QATAR AIRWAYS LOGBOOK') && page.items.some(i => i.text === 'NAME(S) PIC') && page.items.some(i => i.text === 'PLACE');

/**
 * "QATAR AIRWAYS LOGBOOK" (EASA layout, "01-Aug-2024 To 09-Sep-2024"), a record per flight, its PIC name and remarks wrapping
 * onto the lines under it:
 *   DATE | DEPARTURE PLACE TIME | ARRIVAL PLACE TIME ("00:39 (+1)") | AIRCRAFT TYPE REG | SINGLE PILOT SE ME | MULTI PILOT TIME |
 *   TOTAL TIME OF FLIGHT | NAME(S) PIC | TAKE OFF DAY NIGHT | LANDINGS DAY NIGHT | OPERATIONAL CONDITION NIGHT IFR |
 *   PILOT FUNCTION TIME PIC CO-PILOT DUAL INSTRUCTOR | FSTD SESSION DATE TYPE TOTAL TIME | REMARKS AND ENDORSEMENTS
 * Times UTC. A flight: ac, registration, crew "[PIC - DE SOUZA HENKIN Felipe]", info "[Flight: 07:07] [Takeoff Day: 1] [Landing Day: 1]
 * [Night: 05:28] [IFR: 07:07] [PIC: 07:07] [CoPilot: ..] [Dual: ..] [Instructor: ..]" and the remarks; an FSTD session a row (duty SIM,
 * its type as ac "B777,EU-A0206", "[Sim: 04:00]"). Times of 00:00 and counts of 0 are left out. Columns by their headers' centres.
 */
function parseQatarLogbook(pages) {
  const trace = startTrace();
  const rows = [];
  const dateOf = (t) => { const m = /^(\d{2})\/(\d{2})\/(\d{2})$/.exec(t || ''); return m && Date.UTC(2000 + +m[3], +m[2] - 1, +m[1]); };
  const dayRow = (t) => { const d = new Date(t); return { date: `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${String(d.getUTCFullYear() % 100).padStart(2, '0')}`, day: WEEKDAYS[d.getUTCDay()] }; };
  const dur = (t) => (/^\d{1,3}:\d{2}$/.test(t || '') && /[1-9]/.test(t) ? t : '');
  const cnt = (t) => (/^[1-9]\d*$/.test(t || '') ? t : '');
  const ORDER = { PLACE: ['depPlace', 'arrPlace'], TIME: ['depTime', 'arrTime'], TYPE: ['type', 'simType'], REG: ['reg'], SE: ['se'], ME: ['me'], FLIGHT: ['total'],
    DAY: ['tkDay', 'ldDay'], NIGHT: ['tkNight', 'ldNight', 'night'], IFR: ['ifr'], PIC: ['pic'], 'CO-PILOT': ['coPilot'], DUAL: ['dual'], INSTRUCTOR: ['instructor'],
    DATE: ['simDate'], TOTAL: ['simTotal'] };
  for (const page of pages) {
    const place = page.items.find(i => i.text === 'PLACE');
    const top = page.items.find(i => i.text === 'NAME(S) PIC');
    if (!place || !top) continue;
    const seen = {};
    const centre = (i) => i.x + (i.w || 0) / 2;
    const cols = [
      ...sameLine(page, place).map((h) => { const n = (seen[h.text] = (seen[h.text] || 0) + 1); const name = ORDER[h.text]?.[n - 1]; return name && { name, c: centre(h) }; }).filter(Boolean),
      ...sameLine(page, top).map(h => ({ DATE: 'date', 'NAME(S) PIC': 'picName', MULTI: 'multi', 'REMARKS AND': 'remark' }[h.text] && { name: { DATE: 'date', 'NAME(S) PIC': 'picName', MULTI: 'multi', 'REMARKS AND': 'remark' }[h.text], c: centre(h) })).filter(Boolean),
    ];
    const remarkX = sameLine(page, top).find(i => i.text === 'REMARKS AND')?.x ?? Infinity;
    const colOf = (i) => (i.x >= remarkX - 20 ? 'remark' : cols.reduce((b, h) => (Math.abs(h.c - centre(i)) < Math.abs(b.c - centre(i)) ? h : b), cols[0]).name);
    const dataTop = Math.max(...page.items.filter(i => /^\(dd\/mm\/yy\)$|^TIME$/.test(i.text) && Math.abs(i.y - place.y) < 25).map(i => i.y));
    let rec = null;
    const records = [];
    for (const l of toLines(page.items.filter(i => i.y > dataTop + 3), 2)) {
      const cells = {};
      for (const i of l.items) (cells[colOf(i)] ||= []).push(i);
      if (dateOf(cells.date?.[0]?.text) != null || dateOf(cells.simDate?.[0]?.text) != null) { rec = { cells }; records.push(rec); continue; }
      if (l.items.some(i => i.text === 'TOTAL')) rec = null; // the page totals ("TOTAL THIS PAGE", "I certify that the entries ...")
      if (rec) for (const [c, list] of Object.entries(cells)) (rec.cells[c] ||= []).push(...list); // wrapped name / sim type / remarks
    }
    for (const { cells } of records) {
      const get = (c) => (cells[c] || []).map(i => i.text).join(' ').trim();
      const d = dateOf(cells.date?.[0]?.text);
      if (d != null && /^[A-Z]{3,4}$/.test(get('depPlace'))) {
        const tag = (k, c) => { const v = dur(get(c)); return v && `[${k}: ${v}]`; };
        const arrTime = get('arrTime').replace(/\s*\((\+\d)\)$/, '$1');
        const r = {
          section: 'published', ...dayRow(d), duty: '', dep: get('depPlace'), arr: get('arrPlace'), begin: get('depTime'), end: arrTime,
          ac: get('type'), registration: get('reg'), crew: get('picName').split(/\s*,\s*/).filter(Boolean).map(n => `[PIC - ${n}]`).join(''), // "A,B": two names
          notes: [tag('Flight', 'total'), ...[['Takeoff Day', 'tkDay'], ['Takeoff Night', 'tkNight'], ['Landing Day', 'ldDay'], ['Landing Night', 'ldNight']].filter(([, c]) => cnt(get(c))).map(([k, c]) => `[${k}: ${get(c)}]`),
            tag('Night', 'night'), tag('IFR', 'ifr'), tag('PIC', 'pic'), tag('CoPilot', 'coPilot'), tag('Dual', 'dual'), tag('Instructor', 'instructor'), get('remark')].filter(Boolean),
        };
        rows.push(r);
        for (const [f, c] of [['date', 'date'], ['dep', 'depPlace'], ['begin', 'depTime'], ['arr', 'arrPlace'], ['end', 'arrTime'], ['ac', 'type'], ['registration', 'reg'], ['crew', 'picName'],
          ['info', 'total'], ['info', 'night'], ['info', 'ifr'], ['info', 'pic'], ['info', 'coPilot'], ['info', 'dual'], ['info', 'instructor'], ['info', 'remark'],
          ...['tkDay', 'tkNight', 'ldDay', 'ldNight'].filter(c => cnt(get(c))).map(c => ['info', c])]) if (cells[c]) mark(r, f, cells[c].filter(i => f !== 'info' || i.text !== '00:00'));
      }
      const s = dateOf(cells.simDate?.[0]?.text);
      if (s != null) {
        const r = { section: 'published', ...dayRow(s), duty: 'SIM', ac: get('simType').replace(/\s+/g, ''), notes: [dur(get('simTotal')) && `[Sim: ${get('simTotal')}]`].filter(Boolean) };
        if (d == null) r.notes.push(...[['PIC', 'pic'], ['CoPilot', 'coPilot'], ['Dual', 'dual'], ['Instructor', 'instructor']].filter(([, c]) => dur(get(c))).map(([k, c]) => `[${k}: ${get(c)}]`));
        rows.push(r);
        for (const [f, c] of [['date', 'simDate'], ['ac', 'simType'], ['info', 'simTotal']]) if (cells[c]) mark(r, f, cells[c]);
      }
    }
  }
  const per = pages.flatMap(p => p.items).map(i => /^(\d{2})-([A-Z][a-z]{2})-(\d{4}) To (\d{2})-([A-Z][a-z]{2})-(\d{4})$/.exec(i.text)).find(Boolean);
  const out = rows.map(r => outputRow({ ...r, info: r.notes.join(' ') }, 'Z'));
  return { format: 'qatar-logbook', period: per ? `${per[1]}${per[2]}${per[3].slice(2)} - ${per[4]}${per[5]}${per[6].slice(2)}` : null, notices: [], recognized: out.length > 0, published: out, planned: [], _trace: trace, _rows: rows };
}

const isRolIndividual = (page) => page.items.some(i => /^ROL INDIVIDUAL DE SERVICIOS [A-Z]+ \d{4}$/.test(i.text)) && page.items.some(i => i.text === 'BLOCK DH');

/**
 * Aeromexico "ROL INDIVIDUAL DE SERVICIOS SEPTIEMBRE 2025" ("Time zone: Base"): a calendar strip, then a line per day under
 * DAY | DUTY | BLOCK DH:
 *   "01 Mon" "R4 MEX" "16:15" "23:59"                                  a code at a station with its times ("[R4: RESERVA]" from the code list)
 *   "09 Tue 25002" "001 MEX" "(T2) 17:45 MAD" "04:35" "10:50 0:00"      pairing, flight, dep, terminal, STD, arr, STA (next day when earlier), block, DH
 *   "12 Fri" "020 MAD" "01:00 MEX" "(T2) 12:45" "11:45 0:00"
 * -> flights "[Pairing: 25002] [Block: 10:50]" (dc DH when the DH hours are not 0:00); times are base times (B).
 */
function parseRolIndividual(pages) {
  const trace = startTrace();
  const rows = [];
  const all = pages.flatMap(p => p.items);
  const title = all.map(i => /^ROL INDIVIDUAL DE SERVICIOS ([A-Z]+) (\d{4})$/.exec(i.text)).find(Boolean);
  const month = spanishMonth(title[1]), year = +title[2];
  // the code list: "R4 : RESERVA", "X" ": DIAS INTOCABLES"
  const legend = new Map();
  for (const page of pages) for (const l of toLines(page.items)) {
    const m = /^([A-Z0-9]{1,5}) ?: (.+)$/.exec(l.items.map(i => i.text).join(' '));
    if (m && !/^(Id|Name|Pos|Group|Equip|Base|Seniority|Time zone|TOTAL|BLK|DH)$/.test(m[1])) legend.set(m[1], m[2].trim());
  }
  let pairing = null;
  for (const page of pages) {
    const head = page.items.find(i => i.text === 'BLOCK DH');
    const blockX = head?.x ?? Infinity;
    for (const l of toLines(page.items.filter(i => head && i.y > head.y + 3))) {
      const words = l.items.flatMap(wordsIn);
      const dm = /^(\d{2})$/.exec(words[0]?.text || '');
      if (!dm || !WEEKDAYS.includes(words[1]?.text)) continue;
      const t = Date.UTC(year, month, +dm[1]);
      const d = new Date(t);
      const base = { section: 'published', date: `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${String(year % 100).padStart(2, '0')}`, day: WEEKDAYS[d.getUTCDay()], notes: [] };
      let k = 2;
      if (/^\d{4,6}$/.test(words[k]?.text || '') && words[k].x < 110) { pairing = words[k]; k += 1; }
      const rest = words.slice(k).filter(w => !/^\(T\d*\)$/.test(w.text));
      const body = rest.filter(w => w.x < blockX - 5), tail = rest.filter(w => w.x >= blockX - 5);
      const times = body.filter(w => /^\d{2}:\d{2}$/.test(w.text));
      const ports = body.filter(w => /^[A-Z]{3}$/.test(w.text));
      const code = body[0];
      if (/^\d{3,4}$/.test(code?.text || '') && ports.length === 2 && times.length === 2) {
        const [blk, dh] = tail.map(w => w.text);
        const r = { ...base, duty: code.text, dc: dh && /[1-9]/.test(dh) ? 'DH' : '', dep: ports[0].text, arr: ports[1].text, begin: times[0].text,
          end: `${times[1].text}${times[1].text < times[0].text ? '+1' : ''}`, notes: [pairing && `[Pairing: ${pairing.text}]`, blk && /[1-9]/.test(blk) && `[Block: ${blk.padStart(5, '0')}]`].filter(Boolean) };
        rows.push(r);
        for (const [f, it] of [['date', words.slice(0, 2)], ['duty', code], ['dep', ports[0]], ['arr', ports[1]], ['begin', times[0]], ['end', times[1]], ['info', [pairing, tail[0]].filter(Boolean)]]) mark(r, f, it);
        pairing = null;
      } else if (code) {
        const r = { ...base, duty: code.text, dep: ports[0]?.text || '', begin: times[0]?.text || '', end: times[1]?.text || '', notes: legend.has(code.text) ? [`[${code.text}: ${legend.get(code.text)}]`] : [] };
        if (r.end && r.end < r.begin) r.end += '+1';
        rows.push(r);
        for (const [f, it] of [['date', words.slice(0, 2)], ['duty', code], ['dep', ports[0]], ['begin', times[0]], ['end', times[1]]]) mark(r, f, it);
      }
    }
  }
  const p = `01${MONTHS[month]}${String(year).slice(2)}`;
  const out = rows.map(r => outputRow({ ...r, info: r.notes.join(' ') }, 'B'));
  return { format: 'rol-individual', period: `${p} - ${new Date(Date.UTC(year, month + 1, 0)).getUTCDate()}${p.slice(2)}`, notices: [], recognized: out.length > 0, published: out, planned: [], _trace: trace, _rows: rows };
}

const isFlightSheet = (page) => page.items.some(i => i.text === 'FlightNumber') && page.items.some(i => i.text === 'City Pair') && page.items.some(i => i.text === 'Off Block');

/**
 * Ryanair flight sheets (an e-mail print: "2020/09/14", then per flight "Key : value" lines): FlightNumber "FR 9141", Registration,
 * City Pair "PMO - CRL", STD / STA, Block / fuel / pax figures, Airborne, Landed, Total flight, Off Block, On Block, Total Block, delays,
 * Pilot Flying (Take Off, Landing), Captain Remarks; at the end "Flight Deck Crew": "RYCKVE : CP : VEERLE DE RYCKE".
 * Times ("18" ":" "12") are UTC. A row per flight: begin / takeoff / landing / end = Off Block / Airborne / Landed / On Block,
 * info "[Block: 02:21] [Flight: 02:08] [Pilot Flying: DHAALE]" and the captain's remark; crew = the flight deck crew, on every flight.
 */
function parseFlightSheet(pages) {
  const trace = startTrace();
  const rows = [];
  let date = null, dateItem = null, rec = null;
  const recs = [];
  const crew = [];
  let inCrew = false;
  for (const page of pages) {
    for (const l of toLines(page.items)) {
      const its = l.items;
      const text = its.map(i => i.text).join(' ');
      const dm = /^(\d{4})\/(\d{2})\/(\d{2})$/.exec(text);
      if (dm) { date = Date.UTC(+dm[1], +dm[2] - 1, +dm[3]); dateItem = its[0]; continue; }
      if (text === 'Flight Deck Crew') { inCrew = true; continue; }
      if (/^E-MAIL DISCLAIMER/.test(text)) inCrew = false;
      const colon = its.findIndex(i => i.text === ':');
      if (colon < 1) continue;
      const key = its.slice(0, colon).map(i => i.text).join(' ');
      const valItems = its.slice(colon + 1);
      if (inCrew) {
        const m = /^(\S+) : (\S+) : (.+)$/.exec(text);
        if (m) crew.push({ text: `[${m[2]} - ${m[1]} - ${m[3]}]`, items: its });
        continue;
      }
      const value = valItems.map(i => i.text).join(/^\d{2}$/.test(valItems[0]?.text || '') ? '' : ' ').trim(); // "18" ":" "12" -> 18:12
      if (key === 'FlightNumber') { rec = { date, dateItem, v: {}, items: {} }; recs.push(rec); dateItem = null; }
      if (rec) { rec.v[key] = value; rec.items[key] = valItems; }
    }
  }
  for (const { date: t, dateItem: di, v, items } of recs) {
    if (t == null) continue;
    const d = new Date(t);
    const [dep, arr] = (v['City Pair'] || '').split(/\s*-\s*/);
    const tm = (k) => (/^\d{2}:\d{2}$/.test(v[k] || '') ? v[k] : '');
    const pf = [...new Set([v['Take Off'], v.Landing].filter(Boolean))];
    const r = {
      section: 'published', date: `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${String(d.getUTCFullYear() % 100).padStart(2, '0')}`, day: WEEKDAYS[d.getUTCDay()],
      duty: (v.FlightNumber || '').replace(/\s+/g, ''), registration: v.Registration || '', dep: dep || '', arr: arr || '',
      begin: tm('Off Block'), takeoff: tm('Airborne'), landing: tm('Landed'), end: tm('On Block') && tm('On Block') < tm('Off Block') ? `${tm('On Block')}+1` : tm('On Block'),
      crew: crew.map(c => c.text).join(''),
      notes: [tm('Total Block') && `[Block: ${tm('Total Block')}]`, tm('Total flight') && `[Flight: ${tm('Total flight')}]`,
        pf.length && `[Pilot Flying: ${pf.join(' / ')}]`, v['Captain Remarks'] && v['Captain Remarks'] !== 'No Data Available' && v['Captain Remarks']].filter(Boolean),
    };
    rows.push(r);
    for (const [f, k] of [['duty', 'FlightNumber'], ['registration', 'Registration'], ['begin', 'Off Block'], ['takeoff', 'Airborne'], ['landing', 'Landed'], ['end', 'On Block'],
      ['info', 'Total Block'], ['info', 'Total flight'], ['info', 'Take Off'], ['info', 'Landing']]) if (items[k]) mark(r, f, items[k].filter(i => i.text !== ':' || f !== 'duty'));
    const cp = items['City Pair']?.[0];
    if (cp && dep && arr) { mark(r, 'dep', pieceOf(cp, 0, dep.length)); mark(r, 'arr', pieceOf(cp, cp.text.length - arr.length, arr.length)); }
    if (di) mark(r, 'date', di);
    for (const c of crew) mark(r, 'crew', c.items);
  }
  const ts = recs.map(x => x.date).filter(x => x != null);
  const fmt = (x) => { const d = new Date(x); return `${String(d.getUTCDate()).padStart(2, '0')}${MONTHS[d.getUTCMonth()]}${String(d.getUTCFullYear() % 100).padStart(2, '0')}`; };
  const out = rows.map(r => outputRow({ ...r, info: r.notes.join(' ') }, 'Z'));
  return { format: 'flight-sheet', period: ts.length ? `${fmt(Math.min(...ts))} - ${fmt(Math.max(...ts))}` : null, notices: [], recognized: out.length > 0, published: out, planned: [], _trace: trace, _rows: rows };
}

const isProgrammeDu = (page) => page.items.some(i => /^Programme du \d{2}\/\d{2}\/\d{4} au \d{2}\/\d{2}\/\d{4}$/.test(i.text)) && page.items.some(i => i.text === 'Activité') && page.items.some(i => i.text === 'Checkin');

/**
 * Air Corsica "Programme du 01/11/2024 au 31/01/2025": a day "Friday 01 November 2024", its header
 * Activité | Dépar Arrivé | Checkin | Début | Fin | Checkout | Durée | TdV | TdS | Vol | Equipe, then per event three lines:
 *   (above) UTC times "14:15" (Checkin) "15:15" (Début) "17:02" (Fin) ["17:22" Checkout], the flight "XK721", crew "CDB:BRY - OPL:CAD -"
 *   (middle) "FLT - XK721 - FHXKE" (activity, registration), dep, arr, Durée, TdV, TdS, crew "C/C:LWS - HST:ATL"
 *   (under) the function "(OPL)", local times "(15:15 LOC)" under their UTC ones, the aircraft "(AT6)".
 * Checkin -> a C/I row, Checkout -> a C/O row ("[TdV: 05:11] [Duty: 05:31]"); times "14:15 Z / 15:15 L"; a flight with registration,
 * ac, "[Block: 01:47]", crew "[CDB - BRY][OPL - CAD][C/C - LWS][HST - ATL]"; codes "BL ()", "VM5 ()" with their times ("[Duty: 04:00]"; in the
 * brackets the crew member's function, left out), "HOT" a hotel row.
 */
function parseProgrammeDu(pages) {
  const trace = startTrace();
  const rows = [];
  let cur = null, curItem = null;
  for (const page of pages) {
    const head = page.items.find(i => i.text === 'Checkin');
    if (!head) continue;
    const H = (t) => page.items.find(i => i.text === t && Math.abs(i.y - head.y) < 3)?.x;
    const X = { ci: H('Checkin'), begin: H('Début'), end: H('Fin'), co: H('Checkout'), dur: H('Durée'), tdv: H('TdV'), tds: H('TdS'), vol: H('Vol'), crew: H('Equipe'), dep: H('Dépar Arrivé') ?? H('Dépar') };
    const near = (it, x, tol = 14) => x != null && Math.abs(it.x - x) <= tol;
    const DAY_HEAD = /^(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday) (\d{2}) ([A-Z][a-z]+) (\d{4})$/;
    // in reading order: the day headers, and the events by their departure airport (the line's items stand up to 2.5pt apart,
    // the activity a little lower or higher than its airports)
    const anchors = page.items.filter(i => DAY_HEAD.test(i.text) || (/^[A-Z]{3}$/.test(i.text) && i.x > X.dep - 10 && i.x < X.dep + 15)).sort((a, b) => a.y - b.y);
    for (const anchor of anchors) {
      const dm = DAY_HEAD.exec(anchor.text);
      if (dm) {
        const t = Date.UTC(+dm[4], monthIndex(dm[3].slice(0, 3)), +dm[2]);
        const d = new Date(t);
        cur = { date: `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${dm[4].slice(2)}`, day: WEEKDAYS[d.getUTCDay()] };
        curItem = anchor;
        continue;
      }
      const band = (lo, hi) => page.items.filter(i => i.y - anchor.y >= lo && i.y - anchor.y < hi);
      const mid = band(-2.6, 3.0), above = band(-8, -2.6), under = band(3.0, 8);
      const act = mid.find(i => i.x < X.dep - 10 && !/^\(/.test(i.text));
      if (!cur || !act) continue;
      const ports = mid.filter(i => i.x > X.dep - 10 && i.x < X.ci - 10 && /^[A-Z]{3}$/.test(i.text)).sort((a, b) => a.x - b.x);
      const l = { y: anchor.y, items: mid };
      const utc = (key) => above.find(i => near(i, X[key], 12) && /^\d{2}:\d{2}$/.test(i.text));
      const loc = (u) => u && under.find(i => /^\(\d{2}:\d{2} LOC\)$/.test(i.text) && Math.abs(i.x - (u.x - 10)) <= 8);
      const zl = (key, days = 0) => {
        const u = utc(key);
        if (!u) return '';
        const l2 = loc(u);
        const plus = days ? ` +${days}` : '';
        return l2 ? `${u.text} Z${plus} / ${l2.text.slice(1, 6)} L` : `${u.text} Z${plus}`;
      };
      const marksZ = (key) => [utc(key), loc(utc(key))].filter(Boolean);
      const val = (key, from = l.items) => from.find(i => near(i, X[key]) && /^\d{2}:\d{2}$/.test(i.text))?.text;
      const add = (r, marks) => {
        const row = { section: 'published', ...cur, notes: [], ...r };
        rows.push(row);
        for (const [f, it] of marks) if (it && [].concat(it).length) mark(row, f, it);
        if (curItem) { mark(row, 'date', curItem); curItem = null; }
        return row;
      };
      const [dep, arr] = [ports[0], ports[1]];
      if (utc('ci')) add({ duty: 'C/I', dep: dep.text, begin: zl('ci') }, [['ci', marksZ('ci')], ['dep', dep]]);
      const crewText = [...above, ...l.items].filter(i => i.x >= X.crew - 25).sort((a, b) => a.y - b.y || a.x - b.x).map(i => i.text).join(' ');
      const crew = [...crewText.matchAll(/([A-Z/]+):([A-Z]+)/g)].map(m => `[${m[1]} - ${m[2]}]`).join('');
      const crewItems = [...above, ...l.items].filter(i => i.x >= X.crew - 25);
      const endDays = utc('end') && utc('begin') && utc('end').text < utc('begin').text ? 1 : 0;
      const flt = /^(FLT|MEP) - ([A-Z0-9]{2}\d{1,4}[A-Z]?)(?: - ([A-Z0-9-]+))?$/.exec(act.text);
      const ac = /^\(([A-Z0-9]{2,4})\)$/.exec(under.find(i => near(i, X.vol))?.text || '')?.[1] || '';
      let row;
      if (flt) {
        const dur = val('dur');
        row = add({ duty: flt[2], dc: flt[1] === 'MEP' ? 'MEP' : '', registration: flt[3] || '', dep: dep.text, arr: arr?.text || '', begin: zl('begin'), end: zl('end', endDays), ac, crew,
          notes: dur ? [`[Block: ${dur}]`] : [] },
        [['duty', pieceOf(act, act.text.indexOf(flt[2]), flt[2].length)], ['registration', flt[3] && pieceOf(act, act.text.lastIndexOf(flt[3]), flt[3].length)], ['dep', dep], ['arr', arr],
          ['begin', marksZ('begin')], ['end', marksZ('end')], ['ac', under.find(i => near(i, X.vol))], ['crew', crewItems], ['info', l.items.find(i => near(i, X.dur))]]);
      } else {
        // "BL ()", "VL (OPL)": the code and the crew member's function (left out); HOT = a hotel night
        const code = /^(\S+)/.exec(act.text)[1];
        const tds = val('tds') || val('dur');
        row = add({ duty: code === 'HOT' ? 'H' : code, dep: dep.text, arr: arr && arr.text !== dep.text ? arr.text : '', begin: zl('begin'), end: zl('end', endDays),
          notes: [tds && `[Duty: ${tds}]`].filter(Boolean) },
        [['duty', pieceOf(act, 0, code.length)], ['dep', dep], ['begin', marksZ('begin')], ['end', marksZ('end')]]);
      }
      if (utc('co')) {
        const notes = [val('tdv') && `[TdV: ${val('tdv')}]`, val('tds') && `[Duty: ${val('tds')}]`].filter(Boolean);
        add({ duty: 'C/O', arr: row.arr || row.dep, end: zl('co'), notes }, [['co', marksZ('co')], ['info', l.items.filter(i => near(i, X.tdv) || near(i, X.tds))]]);
      }
    }
  }
  const per = pages.flatMap(p => p.items).map(i => /^Programme du (\d{2})\/(\d{2})\/(\d{4}) au (\d{2})\/(\d{2})\/(\d{4})$/.exec(i.text)).find(Boolean);
  const out = rows.map(r => outputRow({ ...r, info: r.notes.join(' ') }, 'Z'));
  return { format: 'programme-du', period: per ? `${per[1]}${MONTHS[+per[2] - 1]}${per[3].slice(2)} - ${per[4]}${MONTHS[+per[5] - 1]}${per[6].slice(2)}` : null,
    notices: [], recognized: out.length > 0, published: out, planned: [], _trace: trace, _rows: rows };
}

const CAL_WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const isMonthCalendar = (page) => page.items.some(i => /^[A-Z][a-z]+ \d{4}$/.test(i.text) && monthIndex(i.text.slice(0, 3)) >= 0 && i.y < 30)
  && toLines(page.items).some(l => l.items.filter(i => CAL_WEEKDAYS.includes(i.text)).length === 7) && page.items.some(i => i.text === '~' || /~/.test(i.text));

/**
 * A month calendar print (Crew Access; "April 2025", a week a row under Monday ... Sunday, the days "Mar. 31" "1" ... "May. 1"),
 * each day's events stacked in its cell, a line each (local times):
 *   "Report" "07:00" "NCL" (Apresentação) -> C/I;  "Release" "15:00" "NCL" -> C/O;  "OFF", "LV", "RDO" a code alone;
 *   "LS557" "NCL 06:04" "~ 09:17 AGP" an event (flight or code, "BLS", "Travel (HIR)" -> HIR "[HIR: Travel]");
 *   "LS554" "AYT 20:01 ~ NCL" going on into the next day, and there "LS554" "AYT ~ 00:44 NCL" with its end: one row, end "+1";
 *   "Hotel" "J2S ~ 18:25 J2S" a hotel row.
 */
function parseMonthCalendar(pages) {
  const trace = startTrace();
  const rows = [];
  const title = pages.flatMap(p => p.items).find(i => /^[A-Z][a-z]+ \d{4}$/.test(i.text) && monthIndex(i.text.slice(0, 3)) >= 0);
  const year0 = +title.text.slice(-4), month0 = monthIndex(title.text.slice(0, 3));
  let month = null, year = year0, lastN = null;
  const open = new Map(); // duty -> row going on into the next day
  let colX = null; // the weekday columns (a page without the weekday line goes on with the page before)
  for (const page of pages) {
    const wd = toLines(page.items).find(l => l.items.filter(i => CAL_WEEKDAYS.includes(i.text)).length === 7) || (colX && { y: -1 });
    if (!wd) continue;
    if (wd.items) colX = wd.items.filter(i => CAL_WEEKDAYS.includes(i.text)).map(i => i.x).sort((a, b) => a - b);
    const colOf = (x) => colX.reduce((k, cx, j) => (x >= cx - 8 ? j : k), 0);
    // the day-number lines: 7 items, numbers or "Mar. 31"
    const DAYNUM = /^(?:([A-Z][a-z]{2})\. )?(\d{1,2})$/;
    const dayLines = toLines(page.items.filter(i => i.y > wd.y + 3)).filter(l => l.items.length === 7 && l.items.every(i => DAYNUM.test(i.text)));
    // "28" "29" "Apr. 30" "1": the days before the first month name are in that month
    const firstMon = month == null && dayLines[0]?.items.map(i => DAYNUM.exec(i.text)[1]).find(Boolean);
    if (firstMon) { month = monthIndex(firstMon); if (month > month0 + 6) year -= 1; }
    for (const [w, dl] of dayLines.entries()) {
      const bottom = dayLines[w + 1]?.y ?? page.height;
      const cells = page.items.filter(i => i.y > dl.y + 3 && i.y < bottom - 3);
      for (const [c, di] of [...dl.items].sort((a, b) => a.x - b.x).entries()) {
        const [, mon, nn] = DAYNUM.exec(di.text);
        const n = +nn;
        if (mon) { const m = monthIndex(mon); if (month != null && m < month - 6) year += 1; if (month == null && m > month0 + 6) year -= 1; month = m; }
        else if (month == null) month = month0;
        else if (lastN != null && n < lastN) { month += 1; if (month > 11) { month = 0; year += 1; } }
        lastN = n;
        const t = Date.UTC(year, month, n);
        const d = new Date(t);
        const base = { section: 'published', date: `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${String(d.getUTCFullYear() % 100).padStart(2, '0')}`, day: WEEKDAYS[d.getUTCDay()], t, notes: [] };
        let first = true;
        const add = (r, marks) => {
          const row = { ...base, ...r, notes: r.notes || [] };
          rows.push(row);
          for (const [f, it] of marks) if (it && [].concat(it).length) mark(row, f, it);
          if (first) { mark(row, 'date', di); first = false; }
          return row;
        };
        // an event's end may wrap onto the next line ("SV1463" "RUH 15:35" / "~ 17:15 MED")
        const lines = [];
        for (const l of toLines(cells.filter(i => colOf(i.x) === c), 2)) {
          if (/^~/.test(l.items[0].text) && lines.length && !/~/.test(lines.at(-1).items.map(i => i.text).join(' '))) lines.at(-1).items.push(...l.items);
          else lines.push({ items: [...l.items] });
        }
        for (const l of lines) {
          const [nameItem, ...restItems] = l.items;
          const name = nameItem.text;
          const R = restItems.map(i => i.text).join(' ');
          let m;
          if (/^(Report|Apresentação|Apresentacao)$/.test(name) && (m = /^(\d{2}:\d{2}) ([A-Z0-9]{3})$/.exec(R))) { add({ duty: 'C/I', dep: m[2], begin: m[1] }, [['ci', restItems[0]], ['dep', restItems[1]]]); continue; }
          if (/^(Release|Liberação)$/.test(name) && (m = /^(\d{2}:\d{2}) ([A-Z0-9]{3})$/.exec(R))) { add({ duty: 'C/O', arr: m[2], end: m[1] }, [['co', restItems[0]], ['arr', restItems[1]]]); continue; }
          const code = /^(.+) \(([^)]+)\)$/.exec(name);
          const duty = name === 'Hotel' ? 'H' : code ? code[2] : name;
          const notes = code ? [`[${code[2]}: ${code[1]}]`] : [];
          m = /^(?:([A-Z0-9]{3}) )?(\d{2}:\d{2})? ?~ ?(\d{2}:\d{2})?(?: ([A-Z0-9]{3}))?$/.exec(R);
          if (!R) { add({ duty, notes }, [['duty', nameItem]]); continue; }
          if (!m) continue;
          const [, dep, t1, t2, arr] = m;
          const ws = restItems.flatMap(wordsIn);
          const w = (re, k = 0) => ws.filter(x => re.test(x.text))[k];
          const prev = open.get(duty);
          if (!t1 && t2 && prev) {
            // the end of an event from an earlier day
            const days = Math.round((t - prev.t) / 86400000);
            prev.end = `${t2}${days > 0 ? `+${days}` : ''}`;
            if (arr) prev.arr = arr;
            mark(prev, 'end', w(/^\d{2}:\d{2}$/));
            open.delete(duty);
            continue;
          }
          const row = add({ duty, dep: dep || '', arr: arr || '', begin: t1 || '', end: t2 || '', notes },
            [['duty', nameItem], ['dep', dep && w(/^[A-Z0-9]{3}$/)], ['begin', t1 && w(/^\d{2}:\d{2}$/)], ['end', t2 && w(/^\d{2}:\d{2}$/, t1 ? 1 : 0)], ['arr', arr && w(/^[A-Z0-9]{3}$/, dep ? 1 : 0)]]);
          if (t1 && !t2) open.set(duty, row);
        }
      }
    }
  }
  for (const r of rows) if (r.duty === 'H' && r.arr === r.dep) r.arr = '';
  const ts = rows.map(r => r.t);
  const fmt = (x) => { const d = new Date(x); return `${String(d.getUTCDate()).padStart(2, '0')}${MONTHS[d.getUTCMonth()]}${String(d.getUTCFullYear() % 100).padStart(2, '0')}`; };
  const out = rows.map(({ t, ...r }) => outputRow({ ...r, info: r.notes.join(' ') }, 'L'));
  return { format: 'month-calendar', period: ts.length ? `${fmt(Math.min(...ts))} - ${fmt(Math.max(...ts))}` : null, notices: [], recognized: out.length > 0, published: out, planned: [], _trace: trace, _rows: rows };
}

const EDW_COLS = { DATE: 'date', DUTY: 'duty', ROUTE: 'route', DETAILS: 'details', 'START/END (LT)': 'startEnd', 'STD / STA (UTC)': 'stdSta', POS: 'pos', 'POS TIME (LT)': 'posTime',
  'CHECK-IN /': 'ciCo', 'BLOCK OFF / ON': 'offOn', 'A/C': 'ac', BLOCK: 'block', 'BH 28': 'bh28', 'DH 7': 'dh7', 'DH 14': 'dh14', 'DH 28': 'dh28' };
const isDayLineRoster = (page) => ['ROUTE', 'DETAILS', 'START/END (LT)', 'STD / STA (UTC)', 'CHECK-IN /'].every(t => page.items.some(i => i.text === t));

/**
 * A month as a line per day (Edelweiss; "Nicolas Auer | 102732 | May - 2024"):
 *   DATE | DUTY | ROUTE | DETAILS | START/END (LT) | STD / STA (UTC) | POS | POS TIME (LT) | CHECK-IN / CHECK-OUT (UTC) | BLOCK OFF / ON (UTC) |
 *   A/C TYPE | BLOCK | BH 28 | DUTY | DH 7 | DH 14 | DH 28
 *   "02.05.2024 130-131 ZRH-HRG-ZRH 05:50-17:30 04:50-15:00 03:50-15:30 320 09:20 ... 11:40": a day's flights as one row (duty "130-131", the route's
 *   first and last airport, STD of the first and STA of the last leg, "[Route: ZRH-HRG-ZRH] [Block: 09:20]") between a C/I and a C/O row
 *   ("03:50 Z / 05:50 L", "15:30 Z / 17:30 L", "[Duty: 11:40]"); a duty over midnight prints "CI: 20:35" on its first day and "CO: 07:40" on the next.
 *   Day codes (OFF, RSV, OFC 08:00-17:00 local) with DETAILS in info ("[GAV]"). The cumulated hours (BH 28, DH 7/14/28) are not read.
 */
function parseDayLineRoster(pages) {
  const trace = startTrace();
  const rows = [];
  const range = (s) => /^(\d{2}:\d{2})-(\d{2}:\d{2})$/.exec(s || '');
  for (const page of pages) {
    const head = page.items.find(i => i.text === 'ROUTE');
    if (!head) continue;
    const seen = new Set();
    const cols = sameLine(page, head).map((h) => {
      let col = EDW_COLS[h.text];
      if (h.text === 'DUTY') { col = seen.has('DUTY') ? 'dutyTime' : 'duty'; seen.add('DUTY'); }
      return col && { col, x: h.x };
    }).filter(Boolean);
    const colOf = (i) => cols.reduce((c, h) => (h.x <= i.x + 4 ? h.col : c), 'date');
    for (const l of toLines(page.items.filter(i => i.y > head.y + 12), 2)) {
      const its = {};
      for (const i of l.items) (its[colOf(i)] ||= []).push(i);
      const cell = (c) => (its[c] || []).map(i => i.text).join(' ').trim();
      const dm = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(cell('date'));
      if (!dm) continue;
      const t = Date.UTC(+dm[3], +dm[2] - 1, +dm[1]);
      const d = new Date(t);
      const base = { section: 'published', date: `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${dm[3].slice(2)}`, day: WEEKDAYS[d.getUTCDay()], notes: [] };
      let first = true;
      const add = (r, marks) => {
        const row = { ...base, ...r, notes: r.notes || [] };
        rows.push(row);
        for (const [f, it] of marks) if (it && [].concat(it).length) mark(row, f, it);
        if (first) { mark(row, 'date', its.date); first = false; }
        return row;
      };
      const duty = cell('duty'), route = cell('route'), details = cell('details') === '-' ? '' : cell('details');
      const se = range(cell('startEnd')), ss = range(cell('stdSta')), cc = range(cell('ciCo'));
      const ci = cc?.[1] || /^CI: (\d{2}:\d{2})/.exec(cell('ciCo'))?.[1], co = cc?.[2] || /^CO: (\d{2}:\d{2})/.exec(cell('ciCo'))?.[1];
      const legs = /^[A-Z]{3}(-[A-Z]{3})+$/.test(route) ? route.split('-') : null;
      const dur = (c) => (/^\d{1,3}:\d{2}$/.test(cell(c)) && /[1-9]/.test(cell(c)) ? cell(c).padStart(5, '0') : '');
      if (legs) {
        if (ci) add({ duty: 'C/I', dep: legs[0], begin: `${ci} Z${se ? ` / ${se[1]} L` : ''}` }, [['ci', its.ciCo]]);
        add({ duty, dep: legs[0], arr: legs.at(-1), begin: ss ? `${ss[1]} Z` : '', end: ss ? `${ss[2]} Z${ss[2] < ss[1] ? ' +1' : ''}` : '', ac: cell('ac') === '-' ? '' : cell('ac'),
          notes: [legs.length > 2 && `[Route: ${route}]`, details && `[${details}]`, dur('block') && `[Block: ${dur('block')}]`].filter(Boolean) },
        [['duty', its.duty], ['dep', its.route], ['begin', its.stdSta], ['ac', its.ac], ['info', its.block]]);
        if (co) add({ duty: 'C/O', arr: legs.at(-1), end: `${co} Z${se ? ` / ${se[2]} L` : ''}`, notes: dur('dutyTime') ? [`[Duty: ${dur('dutyTime')}]`] : [] }, [['co', its.ciCo], ['info', its.dutyTime]]);
      } else if (duty) {
        add({ duty, begin: se ? `${se[1]} L` : '', end: se ? `${se[2]} L` : '', notes: [details && `[${details}]`, dur('dutyTime') && `[Duty: ${dur('dutyTime')}]`].filter(Boolean) },
          [['duty', its.duty], ['begin', its.startEnd], ['info', its.details]]);
      }
    }
  }
  const title = pages.flatMap(p => p.items).map(i => /\| ([A-Z][a-z]+) - (\d{4})$/.exec(i.text) || /^([A-Z][a-z]+) - (\d{4})$/.exec(i.text)).find(Boolean);
  const mi = title ? monthIndex(title[1].slice(0, 3)) : -1;
  const period = mi >= 0 ? `01${MONTHS[mi]}${title[2].slice(2)} - ${new Date(Date.UTC(+title[2], mi + 1, 0)).getUTCDate()}${MONTHS[mi]}${title[2].slice(2)}` : null;
  const out = rows.map(r => outputRow({ ...r, info: r.notes.join(' ') }, 'Z'));
  return { format: 'day-line-roster', period, notices: [], recognized: out.length > 0, published: out, planned: [], _trace: trace, _rows: rows };
}

const isMonthPlanDetail = (page) => lineTexts(page).some(t => /^MONTH PLAN \d{2}\/\d{2} - \d{2}\/\d{2}\/\d{4}$/.test(t)) && lineTexts(page).some(t => t === 'Detail duty plan');

/**
 * "MONTH PLAN 01/09 - 30/09/2025" (Vietnam Airlines), its "Detail duty plan": a day "31." with its legs on the line above
 * ("1135 HAN ==> 1235 DIN", up to four side by side) and their flight numbers on the line under ("VN1806"); a leg over midnight
 * prints "2305 DAD ==> HAN ..." and the next day "... DAD ==> 0030 HAN" (one row, end "+1"); other days a text: "--- Dayoff ---" with
 * "Day OFF based on fly schedule (FOM)", "Standby C (0900 -- 1700 )", "--- Extra off days ---", "Off/Birthday leave". Times taken as local.
 * The "Scheme" calendar above is not read.
 */
function parseMonthPlanDetail(pages) {
  const trace = startTrace();
  const rows = [];
  const all = lineTexts(pages.find(isMonthPlanDetail));
  const per = all.map(t => /^MONTH PLAN (\d{2})\/(\d{2}) - (\d{2})\/(\d{2})\/(\d{4})$/.exec(t)).find(Boolean);
  const y0 = +per[5], m0 = +per[2] - 1, d0 = +per[1];
  let month = null, year = y0, lastN = null, open = null;
  for (const page of pages) {
    const detail = toLines(page.items).find(l => l.items.map(i => i.text).join(' ') === 'Detail duty plan');
    if (!detail) continue;
    const labels = page.items.filter(i => i.y > detail.y && /^\d{1,2}\.$/.test(i.text) && i.x < 70).sort((a, b) => a.y - b.y);
    for (const [k, lab] of labels.entries()) {
      const n = parseInt(lab.text, 10);
      if (month == null) { month = n > d0 ? m0 - 1 : m0; if (month < 0) { month = 11; year -= 1; } }
      else if (n < lastN) { month += 1; if (month > 11) { month = 0; year += 1; } }
      lastN = n;
      const t = Date.UTC(year, month, n);
      const d = new Date(t);
      const base = { section: 'published', date: `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${String(d.getUTCFullYear() % 100).padStart(2, '0')}`, day: WEEKDAYS[d.getUTCDay()], t, notes: [] };
      const lo = Math.max(lab.y - 7, labels[k - 1] ? labels[k - 1].y + 7 : -Infinity), hi = labels[k + 1] ? Math.min(lab.y + 7, labels[k + 1].y - 7) : lab.y + 7;
      const band = page.items.filter(i => i !== lab && i.y >= lo && i.y <= hi && i.x > 70);
      const above = band.filter(i => i.y < lab.y).sort((a, b) => a.x - b.x), under = band.filter(i => i.y > lab.y).sort((a, b) => a.x - b.x);
      let first = true;
      const add = (r, marks) => {
        const row = { ...base, ...r, notes: r.notes || [] };
        rows.push(row);
        for (const [f, it] of marks) if (it && [].concat(it).length) mark(row, f, it);
        if (first) { mark(row, 'date', lab); first = false; }
        return row;
      };
      if (above.some(i => i.text === '==>')) {
        const flights = under.filter(i => /^[A-Z0-9]{2}\d{1,4}[A-Z]?$/.test(i.text));
        let f = 0;
        for (let j = 0; j < above.length; j++) {
          if (above[j].text !== '==>') continue;
          const b1 = above[j - 1], b2 = above[j - 2], a1 = above[j + 1], a2 = above[j + 2];
          const dep = /^[A-Z]{3}$/.test(b1?.text || '') ? b1 : null;
          const t1 = dep && /^\d{4}$/.test(b2?.text || '') ? b2 : null;
          const t2 = /^\d{4}$/.test(a1?.text || '') ? a1 : null;
          const arr = /^[A-Z]{3}$/.test((t2 ? a2 : a1)?.text || '') ? (t2 ? a2 : a1) : null;
          const flight = flights[f++];
          const hh = (x) => `${x.text.slice(0, 2)}:${x.text.slice(2)}`;
          if (!t1 && t2 && open && open.duty === flight?.text) {
            const days = Math.round((t - open.t) / 86400000);
            open.end = `${hh(t2)}${days > 0 ? `+${days}` : ''}`;
            mark(open, 'end', t2);
            open = null;
            continue;
          }
          const r = add({ duty: flight?.text || '', dep: dep?.text || '', arr: arr?.text || '', begin: t1 ? hh(t1) : '', end: t2 ? hh(t2) : '' },
            [['duty', flight], ['dep', dep], ['begin', t1], ['arr', arr], ['end', t2]]);
          if (r.begin && r.end && r.end < r.begin) r.end += '+1';
          open = t1 && !t2 ? r : null;
        }
        continue;
      }
      // a day's text: "--- Dayoff ---" + "Day OFF based on fly schedule (FOM)", "Standby C (0900 -- 1700 )"
      const lines = toLines(band, 2).map(l => l.items.map(i => i.text).join(' ').trim());
      const text = lines.join(' ');
      const sb = /^(.+?) \((\d{4}) -- (\d{4}) \)$/.exec(text);
      if (sb) { add({ duty: sb[1], begin: `${sb[2].slice(0, 2)}:${sb[2].slice(2)}`, end: `${sb[3].slice(0, 2)}:${sb[3].slice(2)}` }, [['duty', band.filter(i => !/\d/.test(i.text))], ['begin', band.find(i => i.text === `(${sb[2]}`)], ['end', band.find(i => i.text === sb[3])]]); continue; }
      const head = /^-+ (.+?) -+$/.exec(lines[0] || '');
      if (head) add({ duty: head[1], notes: lines.slice(1).map(x => `[${x}]`) }, [['duty', band.filter(i => i.y < lab.y + 1 && !/^-+$/.test(i.text))], ['info', band.filter(i => i.y > lab.y + 1)]]);
      else if (text) add({ duty: text }, [['duty', band]]);
    }
  }
  const pd = (dd, mm, yy) => `${dd}${MONTHS[+mm - 1]}${String(yy).slice(2)}`;
  const out = rows.map(({ t, ...r }) => outputRow({ ...r, info: r.notes.join(' ') }, 'L'));
  return { format: 'month-plan-detail', period: `${pd(per[1], per[2], per[5])} - ${pd(per[3], per[4], per[5])}`, notices: [], recognized: out.length > 0, published: out, planned: [], _trace: trace, _rows: rows };
}

/** A data line's items by the column whose header starts left of them (`cols`: [{ col, x }] in x order). */
function cellsByHeader(items, cols, tol = 4) {
  const its = {};
  for (const i of items) {
    const c = cols.reduce((b, h) => (h.x <= i.x + tol ? h.col : b), cols[0].col);
    (its[c] ||= []).push(i);
  }
  const cell = (c) => (its[c] || []).map(i => i.text).join(' ').trim();
  return { its, cell };
}

const isPilotLogBookReport = (page) => page.items.some(i => i.text === 'Pilot Log Book Report') && page.items.some(i => i.text === 'Flt No') && page.items.some(i => i.text === 'Dep Stn');

/**
 * "Pilot Log Book Report" (Qatar Airways, "From: 23-Feb-2019 To 02-Apr-2021"), a line per flight or simulator session:
 *   # | Date "26-03-2019" | Flt No | Dep Stn | Dep Time | Arr Stn | Arr Time | A/C Type | A/C Reg | Name Of PIC | Co-Pilot Name | Block Hrs | PIC Hrs |
 *   CP Acting As FO Hrs | Inst Hrs | Jump Seat Hrs | Logbook Hrs | SIM Hrs | Night Hrs | Take Off Day Night | Landings Day Night
 * Times UTC; crew "[PIC - name][Co-Pilot - name]"; info "[Block: ..] [PIC: ..] [CP as FO: ..] [Instructor: ..] [Jump Seat: ..] [Logbook: ..] [Sim: ..]
 * [Night: ..] [Takeoff Day: 1] [Landing Night: 1]" (00:00 and 0 left out); "MFTD" and the like (a simulator) as the duty.
 */
function parsePilotLogBookReport(pages) {
  const trace = startTrace();
  const rows = [];
  const NAMES = { '#': 'n', Date: 'date', 'Flt No': 'flight', 'Dep Stn': 'dep', 'Dep Time': 'begin', 'Arr Stn': 'arr', Arr: 'end', 'A/C': 'ac', Name: 'pic', 'Co-Pilot': 'co',
    Block: 'block', PIC: 'picH', 'CP Acting As': 'cpfo', Inst: 'inst', Jump: 'jump', Logbook: 'logbook', SIM: 'sim', Night: 'night', 'Take Off': 'tk', Landings: 'ld' };
  for (const page of pages) {
    const head = page.items.find(i => i.text === 'Flt No');
    if (!head) continue;
    const seen = {};
    const cols = sameLine(page, head).map((h) => {
      const n = (seen[h.text] = (seen[h.text] || 0) + 1);
      let col = NAMES[h.text];
      if (h.text === 'A/C') col = n === 1 ? 'ac' : 'reg';
      if (h.text === 'Name') col = n === 1 ? 'pic' : null; // "Name Of PIC", "Co-Pilot Name"
      if (h.text === 'Co-Pilot') col = 'coName';
      return col && { col, x: h.x };
    }).filter(Boolean);
    // the Day / Night columns under Take Off and Landings
    const sub = page.items.filter(i => i.y > head.y + 3 && i.y < head.y + 14 && /^(Day|Night)$/.test(i.text) && i.x > (cols.find(c => c.col === 'tk')?.x ?? Infinity) - 40).sort((a, b) => a.x - b.x);
    cols.push(...sub.map((s, k) => ({ col: ['tkDay', 'tkNight', 'ldDay', 'ldNight'][k], x: s.x })));
    cols.sort((a, b) => a.x - b.x);
    // a record per dated line; the lines under it carry its wrapped names ("D" "SOUZA" / "Wesley Adam" / "(95566 - FO)") and "(+1)"
    const records = [];
    for (const l of toLines(page.items.filter(i => i.y > head.y + 20), 2)) {
      const c = cellsByHeader(l.items, cols);
      if (/^\d{2}-\d{2}-\d{4}$/.test(c.cell('date'))) records.push(c.its);
      else if (records.length) for (const [k, list] of Object.entries(c.its)) if (k !== 'n') (records.at(-1)[k] ||= []).push(...list);
    }
    for (const its of records) {
      const cell = (c) => (its[c] || []).map(i => i.text).join(' ').trim();
      const dm = /^(\d{2})-(\d{2})-(\d{4})$/.exec(cell('date'));
      if (!dm || !/^[A-Z]{3}$/.test(cell('dep'))) continue;
      const t = Date.UTC(+dm[3], +dm[2] - 1, +dm[1]);
      const d = new Date(t);
      const dur = (c) => (/^\d{1,3}:\d{2}$/.test(cell(c)) && /[1-9]/.test(cell(c)) ? cell(c) : '');
      const cnt = (c) => (/^[1-9]\d*$/.test(cell(c)) ? cell(c) : '');
      const flight = cell('flight');
      const r = {
        section: 'published', date: `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${dm[3].slice(2)}`, day: WEEKDAYS[d.getUTCDay()],
        duty: flight.replace(/\s+/g, ''), dep: cell('dep'), arr: cell('arr'), begin: cell('begin'), end: cell('end').replace(/\s*\((\+\d)\)$/, '$1'),
        ac: cell('ac'), registration: cell('reg'),
        // the Co-Pilot cell: "NAME First (31861 - CP) NAME2 First2 (96860 - FO)"
        crew: [cell('pic') && `[PIC - ${cell('pic')}]`, ...[...cell('coName').matchAll(/\s*(.+?) \((\d+) - ([A-Z]+)\)/g)].map(m => `[${m[3]} - ${m[2]} - ${m[1]}]`)].filter(Boolean).join('')
          || (cell('coName') ? `[Co-Pilot - ${cell('coName')}]` : ''),
        notes: [...[['Block', 'block'], ['PIC', 'picH'], ['CP as FO', 'cpfo'], ['Instructor', 'inst'], ['Jump Seat', 'jump'], ['Logbook', 'logbook'], ['Sim', 'sim'], ['Night', 'night']]
          .filter(([, c]) => dur(c)).map(([k, c]) => `[${k}: ${dur(c)}]`),
        ...[['Takeoff Day', 'tkDay'], ['Takeoff Night', 'tkNight'], ['Landing Day', 'ldDay'], ['Landing Night', 'ldNight']].filter(([, c]) => cnt(c)).map(([k, c]) => `[${k}: ${cnt(c)}]`)],
      };
      rows.push(r);
      for (const [f, c] of [['date', 'date'], ['duty', 'flight'], ['dep', 'dep'], ['arr', 'arr'], ['begin', 'begin'], ['end', 'end'], ['ac', 'ac'], ['registration', 'reg'], ['crew', 'pic'], ['crew', 'coName']]) if (its[c]) mark(r, f, its[c]);
      for (const c of ['block', 'picH', 'cpfo', 'inst', 'jump', 'logbook', 'sim', 'night']) if (dur(c)) mark(r, 'info', its[c]);
      for (const c of ['tkDay', 'tkNight', 'ldDay', 'ldNight']) if (cnt(c)) mark(r, 'info', its[c]);
    }
  }
  const per = pages.flatMap(p => p.items).map(i => /^From: (\d{2})-([A-Z][a-z]{2})-(\d{4}) To (\d{2})-([A-Z][a-z]{2})-(\d{4})$/.exec(i.text)).find(Boolean);
  const out = rows.map(r => outputRow({ ...r, info: r.notes.join(' ') }, 'Z'));
  return { format: 'pilot-logbook-report', period: per ? `${per[1]}${per[2]}${per[3].slice(2)} - ${per[4]}${per[5]}${per[6].slice(2)}` : null, notices: [], recognized: out.length > 0, published: out, planned: [], _trace: trace, _rows: rows };
}

const isSequenceLogbook = (page) => page.items.some(i => i.text === 'Logbook') && ['SeqDate', 'DepSta', 'ArrSta', 'Out Dt Time', 'InDtTime'].every(t => page.items.some(i => i.text === t));

/**
 * "Logbook" (US airline sequences): YEAR | SeqDate | Seq | EmpSeat | Eq | EQCode | Flt | DepSta | ArrSta | Out Dt Time "Aug 6, 2024 09:34 AM" |
 * InDtTime | DH | AcNum | FLY | PAX | Distance. A row per leg on its Out date (local times), "+1" when In is on a later date; info
 * "[Seq: 31082] [Flight: 1:26] [Pax: 84] [Distance: 337]"; DH -> dc DH.
 */
function parseSequenceLogbook(pages) {
  const trace = startTrace();
  const rows = [];
  const NAMES = { YEAR: 'year', SeqDate: 'seqDate', Seq: 'seq', EmpSeat: 'seat', Eq: 'ac', EQCode: 'eqCode', Flt: 'flight', DepSta: 'dep', ArrSta: 'arr', 'Out Dt Time': 'out', InDtTime: 'in',
    DH: 'dh', AcNum: 'reg', FLY: 'fly', PAX: 'pax', Distance: 'dist' };
  const stamp = (s) => {
    const m = /^([A-Z][a-z]{2}) (\d{1,2}), (\d{4}) (\d{1,2}):(\d{2}) ([AP]M)$/.exec(s || '');
    if (!m) return null;
    const h = (+m[4] % 12) + (m[6] === 'PM' ? 12 : 0);
    return { t: Date.UTC(+m[3], monthIndex(m[1]), +m[2]), hhmm: `${String(h).padStart(2, '0')}:${m[5]}` };
  };
  for (const page of pages) {
    const head = page.items.find(i => i.text === 'SeqDate');
    if (!head) continue;
    const cols = sameLine(page, head).map(h => NAMES[h.text] && { col: NAMES[h.text], x: h.x }).filter(Boolean);
    for (const l of toLines(page.items.filter(i => i.y > head.y + 3), 2)) {
      const { its, cell } = cellsByHeader(l.items, cols);
      const o = stamp(cell('out')), n = stamp(cell('in'));
      if (!o || !/^[A-Z]{3}$/.test(cell('dep'))) continue;
      const d = new Date(o.t);
      const days = n ? Math.round((n.t - o.t) / 86400000) : 0;
      const r = {
        section: 'published', date: `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${String(d.getUTCFullYear() % 100).padStart(2, '0')}`, day: WEEKDAYS[d.getUTCDay()],
        dc: cell('dh') ? 'DH' : '', duty: cell('flight'), dep: cell('dep'), arr: cell('arr'), begin: o.hhmm, end: n ? `${n.hhmm}${days > 0 ? `+${days}` : ''}` : '', ac: cell('ac'), registration: cell('reg'),
        notes: [cell('seq') && `[Seq: ${cell('seq')}]`, /^\d+:\d{2}$/.test(cell('fly')) && `[Flight: ${cell('fly')}]`, cell('pax') && `[Pax: ${cell('pax')}]`, cell('dist') && `[Distance: ${cell('dist')}]`].filter(Boolean),
      };
      rows.push(r);
      for (const [f, c] of [['date', 'out'], ['duty', 'flight'], ['dep', 'dep'], ['arr', 'arr'], ['end', 'in'], ['ac', 'ac'], ['registration', 'reg'], ['info', 'seq'], ['info', 'fly'], ['info', 'pax'], ['info', 'dist']]) if (its[c]) mark(r, f, its[c]);
    }
  }
  const ts = rows.map(r => Date.parse(`${r.date.replace(/ (\d{2})$/, ' 20$1')} UTC`)).filter(Number.isFinite);
  const fmt = (x) => { const d = new Date(x); return `${String(d.getUTCDate()).padStart(2, '0')}${MONTHS[d.getUTCMonth()]}${String(d.getUTCFullYear() % 100).padStart(2, '0')}`; };
  const out = rows.map(r => outputRow({ ...r, info: r.notes.join(' ') }, 'L'));
  return { format: 'sequence-logbook', period: ts.length ? `${fmt(Math.min(...ts))} - ${fmt(Math.max(...ts))}` : null, notices: [], recognized: out.length > 0, published: out, planned: [], _trace: trace, _rows: rows };
}

const isCrewLegExport = (page) => ['SequenceNumber', 'OriginationDate', 'LegNumber', 'FlightNumber', 'CrewName1', 'DepartureStation', 'ArrivalStation'].every(t => page.items.some(i => i.text === t));

/**
 * A logbook export of legs with their crew ("938829.logbook_20260320-20260601"): EffectivePeriod | SequenceNumber | OriginationDate |
 * Seat | LegNumber | FlightNumber | CrewId1 | CrewSeat1 | CrewName1 | ... CrewName6 | DepartureStation | ArrivalStation. No times: a row per leg
 * on its sequence's origination date, crew "[CA - 772493 - Lonsdale, Daniel][FO - ...]", "[Seq: 9604] [Leg: 4]".
 */
function parseCrewLegExport(pages) {
  const trace = startTrace();
  const rows = [];
  for (const page of pages) {
    const head = page.items.find(i => i.text === 'OriginationDate');
    if (!head) continue;
    const cols = sameLine(page, head).map((h) => {
      const m = /^Crew(Id|Seat|Name)(\d)$/.exec(h.text);
      const col = m ? `${m[1].toLowerCase()}${m[2]}` : { SequenceNumber: 'seq', OriginationDate: 'date', Seat: 'seat', LegNumber: 'leg', FlightNumber: 'flight', DepartureStation: 'dep', ArrivalStation: 'arr' }[h.text];
      return col && { col, x: h.x };
    }).filter(Boolean);
    cols.unshift({ col: 'period', x: -Infinity });
    for (const l of toLines(page.items.filter(i => i.y > head.y + 3), 2)) {
      const { its, cell } = cellsByHeader(l.items, cols, 12);
      const dm = /^(\d{2})\/(\d{2})\/(\d{4})/.exec(cell('date'));
      if (!dm || !/^[A-Z]{3}$/.test(cell('dep'))) continue;
      const t = Date.UTC(+dm[3], +dm[2] - 1, +dm[1]);
      const d = new Date(t);
      const crew = [1, 2, 3, 4, 5, 6].filter(k => cell(`name${k}`)).map(k => `[${cell(`seat${k}`)} - ${cell(`id${k}`)} - ${cell(`name${k}`)}]`).join('');
      const r = {
        section: 'published', date: `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${dm[3].slice(2)}`, day: WEEKDAYS[d.getUTCDay()], duty: cell('flight'), dep: cell('dep'), arr: cell('arr'), crew,
        notes: [cell('seq') && `[Seq: ${cell('seq')}]`, cell('leg') && `[Leg: ${cell('leg')}]`].filter(Boolean),
      };
      rows.push(r);
      for (const [f, c] of [['duty', 'flight'], ['dep', 'dep'], ['arr', 'arr'], ['info', 'seq'], ['info', 'leg']]) if (its[c]) mark(r, f, its[c]);
      if (its.date) mark(r, 'date', pieceOf(its.date[0], 0, 10));
      for (const k of [1, 2, 3, 4, 5, 6]) for (const c of [`seat${k}`, `id${k}`, `name${k}`]) if (its[c]) mark(r, 'crew', its[c]);
    }
  }
  const per = pages.flatMap(p => p.items).map(i => /logbook_(\d{4})(\d{2})(\d{2})-(\d{4})(\d{2})(\d{2})$/.exec(i.text)).find(Boolean);
  const out = rows.map(r => outputRow({ ...r, info: r.notes.join(' ') }, 'L'));
  return { format: 'crew-leg-export', period: per ? `${per[3]}${MONTHS[+per[2] - 1]}${per[1].slice(2)} - ${per[6]}${MONTHS[+per[5] - 1]}${per[4].slice(2)}` : null,
    notices: [], recognized: out.length > 0, published: out, planned: [], _trace: trace, _rows: rows };
}

const isCarnetDeVol = (page) => page.items.some(i => i.text === 'Carnet de vol') && page.items.some(i => i.text === 'Programmé') && page.items.some(i => i.text === 'Réel');

/**
 * "Carnet de vol" (Air Austral flight log, "Horaires en UTC"): Avion "223 - FOTER" | Vol | Départ | Arrivée | Fonc. |
 * Programmé Début Fin Total Jour Nuit | Réel Début Fin Total Jour Nuit ("08/07/2022 11:45", decimal hours "1,68").
 * A row per flight on the actual times (UTC), type and registration from Avion, "[Function: OBS] [Total: 1,68] [Night: 0,87]".
 */
function parseCarnetDeVol(pages) {
  const trace = startTrace();
  const rows = [];
  for (const page of pages) {
    const reel = page.items.find(i => i.text === 'Réel');
    const head = page.items.find(i => i.text === 'Vol' && i.y > (reel?.y ?? Infinity));
    if (!head) continue;
    const sub = page.items.filter(i => i.y > head.y + 3 && i.y < head.y + 15 && /^(Début|Fin|Total|Jour|Nuit)$/.test(i.text)).sort((a, b) => a.x - b.x);
    const cols = [
      ...sameLine(page, head).map(h => ({ Avion: 'ac', Vol: 'flight', Départ: 'dep', Arrivée: 'arr', 'Fonc.': 'fn' }[h.text] && { col: { Avion: 'ac', Vol: 'flight', Départ: 'dep', Arrivée: 'arr', 'Fonc.': 'fn' }[h.text], x: h.x })).filter(Boolean),
      ...sub.map(s => ({ col: `${s.x < reel.x - 5 ? 'p' : 'r'}${s.text}`, x: s.x })),
    ].sort((a, b) => a.x - b.x);
    for (const l of toLines(page.items.filter(i => i.y > head.y + 15), 2)) {
      const { its, cell } = cellsByHeader(l.items, cols);
      const s = /^(\d{2})\/(\d{2})\/(\d{4}) (\d{2}:\d{2})$/.exec(cell('rDébut')), e = /^(\d{2})\/(\d{2})\/(\d{4}) (\d{2}:\d{2})$/.exec(cell('rFin'));
      const ac = /^(\S+) - (\S+)$/.exec(cell('ac'));
      if (!s || !/^[A-Z]{3}$/.test(cell('dep'))) continue;
      const t = Date.UTC(+s[3], +s[2] - 1, +s[1]);
      const d = new Date(t);
      const later = e && Date.UTC(+e[3], +e[2] - 1, +e[1]) > t;
      const hrs = (c) => (/^\d+(,\d+)?$/.test(cell(c)) && cell(c) !== '0' ? cell(c) : '');
      const r = {
        section: 'published', date: `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${s[3].slice(2)}`, day: WEEKDAYS[d.getUTCDay()], duty: cell('flight'), dep: cell('dep'), arr: cell('arr'),
        begin: s[4], end: e ? `${e[4]}${later ? '+1' : ''}` : '', ac: ac ? ac[1] : cell('ac'), registration: ac ? ac[2] : '',
        notes: [cell('fn') && `[Function: ${cell('fn')}]`, hrs('rTotal') && `[Total: ${hrs('rTotal')}]`, hrs('rNuit') && `[Night: ${hrs('rNuit')}]`].filter(Boolean),
      };
      rows.push(r);
      const pc = (it, off, len) => it && pieceOf(it, off, len);
      for (const [f, it] of [['date', pc(its.rDébut?.[0], 0, 10)], ['begin', pc(its.rDébut?.[0], 11, 5)], ['end', pc(its.rFin?.[0], 11, 5)], ['duty', its.flight], ['dep', its.dep], ['arr', its.arr],
        ['ac', ac && pc(its.ac[0], 0, ac[1].length)], ['registration', ac && pc(its.ac[0], its.ac[0].text.length - ac[2].length, ac[2].length)], ['info', its.fn],
        ['info', hrs('rTotal') && its.rTotal], ['info', hrs('rNuit') && its.rNuit]]) if (it) mark(r, f, it);
    }
  }
  const per = pages.flatMap(p => p.items).map(i => /^Du (\d{2}) (\S+) (\d{2}) Au (\d{2}) (\S+) (\d{2})$/.exec(i.text)).find(Boolean);
  const out = rows.map(r => outputRow({ ...r, info: r.notes.join(' ') }, 'Z'));
  return { format: 'carnet-de-vol', period: per && frenchMonth(per[2]) >= 0 ? `${per[1]}${MONTHS[frenchMonth(per[2])]}${per[3]} - ${per[4]}${MONTHS[frenchMonth(per[5])]}${per[6]}` : null,
    notices: [], recognized: out.length > 0, published: out, planned: [], _trace: trace, _rows: rows };
}

const isStartEndLogbook = (page) => ['START', 'END', 'AIRCRAFT', 'FROM', 'TO', 'DURATION', 'CHECKIN', 'CHECKOUT'].every(t => page.items.some(i => i.text === t))
  && page.items.some(i => i.text === 'REMARKS AND');

/**
 * A pilot logbook with START DATE / END DATE (Brazilian airline export, FAA-style columns), three lines per flight:
 *   "19/02/2018" "19/02/2018" (start / end date)
 *   E179 | PR-AXE | SDU | VCP | 01:15 (total) | single | 01:15 (multi) | 01:15 (jet) | 1 (day landings) | 0 (night) | 00:02 (night) | instrument actual |
 *   cross country | checkin | checkout | PIC | FO (second in command) | dual | instructor | 5798 (remarks: the flight number)
 *   "05:58" "07:13" (start / end time)
 * A row per flight (times taken as UTC; "+1" when it ends on a later date), "[Total: 01:15] [Landing Day: 1] [Night: 00:02] [IFR: 01:15] [Function: FO]".
 */
function parseStartEndLogbook(pages) {
  const trace = startTrace();
  const rows = [];
  const H = [['MODEL', 'ac'], ['IDENT', 'reg'], ['FROM', 'dep'], ['TO', 'arr'], ['DURATION', 'total'], ['MULTI-', 'multi'], ['JET', 'jet'], ['DAY', 'ldDay'], ['NIGHT', 'ldNight'],
    ['OF FLIGHT', 'night'], ['FLIGHT ACTUAL', 'ifr'], ['FLIGHT CROSS', 'xc'], ['CHECKIN', 'ci'], ['CHECKOUT', 'co'], ['PILOT IN', 'pic'], ['SECOND IN', 'sic'], ['TIME DUAL', 'dual'],
    ['FLIGHT', 'instr'], ['REMARKS AND', 'remark']];
  const dateOf = (s) => { const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(s || ''); return m && Date.UTC(+m[3], +m[2] - 1, +m[1]); };
  for (const page of pages) {
    const from = page.items.find(i => i.text === 'FROM');
    if (!from) continue;
    const band = page.items.filter(i => Math.abs(i.y - from.y) < 14);
    const cols = H.map(([t, col]) => { const h = band.filter(i => i.text === t).sort((a, b) => (t === 'FLIGHT' ? b.y - a.y : a.y - b.y))[0]; return h && { col, c: h.x + (h.w || 0) / 2 }; }).filter(Boolean);
    const colOf = (i) => cols.reduce((b, h) => (Math.abs(h.c - (i.x + (i.w || 0) / 2)) < Math.abs(b.c - (i.x + (i.w || 0) / 2)) ? h : b), cols[0]).col;
    const top = Math.max(...band.map(i => i.y)) + 3;
    const lines = toLines(page.items.filter(i => i.y > top), 2);
    for (const [k, l] of lines.entries()) {
      // the main line: an airport under FROM; the dates line above it, the times line under it
      const words = l.items;
      const cells = {};
      for (const i of words) (cells[colOf(i)] ||= []).push(i);
      const get = (c) => (cells[c] || []).map(i => i.text).join(' ');
      if (!/^[A-Z]{3,4}$/.test(get('dep')) || !/^[A-Z]{3,4}$/.test(get('arr'))) continue;
      const dl = lines[k - 1], tl = lines[k + 1];
      const dates = dl && l.y - dl.y < 8 ? dl.items.filter(i => dateOf(i.text) != null) : [];
      const times = tl && tl.y - l.y < 8 ? tl.items.filter(i => /^\d{2}:\d{2}$/.test(i.text)) : [];
      const t = dateOf(dates[0]?.text);
      if (t == null) continue;
      const te = dateOf(dates[1]?.text);
      const d = new Date(t);
      const dur = (c) => (/^\d{1,3}:\d{2}$/.test(get(c)) && /[1-9]/.test(get(c)) ? get(c) : '');
      const cnt = (c) => (/^[1-9]\d*$/.test(get(c)) ? get(c) : '');
      const fn = ['pic', 'sic', 'dual', 'instr'].map(get).find(v => /^[A-Z]{2,3}$/.test(v));
      const r = {
        section: 'published', date: `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${String(d.getUTCFullYear() % 100).padStart(2, '0')}`, day: WEEKDAYS[d.getUTCDay()],
        duty: /^\d{1,5}$/.test(get('remark')) ? get('remark') : '', ac: get('ac'), registration: get('reg'), dep: get('dep'), arr: get('arr'),
        begin: times[0]?.text || '', end: times[1] ? `${times[1].text}${te != null && te > t ? '+1' : ''}` : '',
        notes: [dur('total') && `[Total: ${get('total')}]`, cnt('ldDay') && `[Landing Day: ${get('ldDay')}]`, cnt('ldNight') && `[Landing Night: ${get('ldNight')}]`,
          dur('night') && `[Night: ${get('night')}]`, dur('ifr') && `[IFR: ${get('ifr')}]`, fn && `[Function: ${fn}]`, get('remark') && !/^\d{1,5}$/.test(get('remark')) && get('remark')].filter(Boolean),
      };
      rows.push(r);
      for (const [f, c] of [['duty', 'remark'], ['ac', 'ac'], ['registration', 'reg'], ['dep', 'dep'], ['arr', 'arr']]) if (cells[c]) mark(r, f, cells[c]);
      for (const c of ['total', 'night', 'ifr']) if (dur(c)) mark(r, 'info', cells[c]);
      for (const c of ['ldDay', 'ldNight']) if (cnt(c)) mark(r, 'info', cells[c]);
      mark(r, 'date', dates[0]); if (times[0]) mark(r, 'begin', times[0]); if (times[1]) mark(r, 'end', times[1]);
    }
  }
  const ts = rows.map(r => Date.parse(`${r.date.replace(/ (\d{2})$/, ' 20$1')} UTC`)).filter(Number.isFinite);
  const fmt = (x) => { const d = new Date(x); return `${String(d.getUTCDate()).padStart(2, '0')}${MONTHS[d.getUTCMonth()]}${String(d.getUTCFullYear() % 100).padStart(2, '0')}`; };
  const out = rows.map(r => outputRow({ ...r, info: r.notes.join(' ') }, 'Z'));
  return { format: 'start-end-logbook', period: ts.length ? `${fmt(Math.min(...ts))} - ${fmt(Math.max(...ts))}` : null, notices: [], recognized: out.length > 0, published: out, planned: [], _trace: trace, _rows: rows };
}

/** A line's text from its items (no space where they touch: a print with a character an item), and the items behind a stretch of it. */
function lineText(items) {
  const sorted = [...items].sort((a, b) => a.x - b.x);
  let text = '';
  const spans = [];
  let end = null;
  for (const it of sorted) {
    if (end != null && it.x - end > 1) text += ' ';
    spans.push({ it, from: text.length, to: text.length + it.text.length });
    text += it.text;
    end = it.x + (it.w || 0);
  }
  return { text, at: (from, to) => spans.filter(s => s.from < to && s.to > from).map(s => s.it) };
}

/** OCR slips of these prints: "O1" / "2025O4:00" (O for 0), "Oh 58m", "Wed1st", "Sun19h". Length is kept (offsets stay right). */
const crewAccessText = (t) => t.replace(/O(?=\d)|(?<=\d)O/g, '0').replace(/\bO[hb](?= \d)/g, '0h').replace(/\bFliqht\b/g, 'Flight');

const isCrewAccessDetail = (page) => {
  const texts = toLines(page.items, 3).map(l => crewAccessText(lineText(l.items).text));
  return texts.some(t => /Crew ?Access/.test(t)) && texts.some(t => /All activ\w* times are in the\w* .ocal time/.test(t));
};

/**
 * Crew Access "Schedule Summary" / "Escala Summary" print with the crew of each flight ("All activities times are in their local time
 * timezone"; Saudia, Azul). Pages may be text (a character an item, a "/" printed as "7": "04:007+1"), or drawn as outlines and read by OCR.
 *   "Mon, 5th Aug 2024 (RUH)" a day; "Check-In 16:30 - 17:54 RUH" -> C/I; "Release 23:15 - 23:45 RUH" -> C/O (its end);
 *   "Off" / "Leave" "00:00 - 00:00/+1 CNF Position: CA Activity Code: FP" -> duty FP "[FP: Off] [Position: CA]";
 *   a flight: "SV 323 ( TVL ) RUH > CAI Position: CA Flight Time: 2h 27m" (TVL = deadhead), its scheduled times on the line above
 *   ("00:30 / +1 - 02:25 / +1"), the actual ones in brackets under it -> "[Position: CA] [Flight: 02:27] [Actual: 00:23 +1 - 01:50 +1]";
 *   "Hotel 15:15 - 14:20 / +1" with the hotel's name above -> a hotel row at the day's station. The crew lists are not read.
 */
function parseCrewAccessDetail(pages) {
  const trace = startTrace();
  const rows = [];
  const DAY = /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun),? ?(\d{1,2}) ?(?:st|nd|rd|th|h)? ([A-Za-z]{3}) (\d{4}) ?(?:\(([A-Z]{3})\))?/d;
  const SPAN = /(\d{2}:\d{2}) ?(?:[/7] ?\+(\d))? ?-? ?(\d{2}:\d{2}) ?(?:[/7] ?\+(\d))?/d; // (OCR may drop the "-")
  let cur = null, curItems = null, station = '';
  const time = (t, p) => `${t}${p ? `+${p}` : ''}`;
  for (const page of pages) {
    const lines = [];
    for (const it of [...page.items].sort((a, b) => a.y - b.y)) {
      const l = lines.at(-1);
      if (l && it.y - l.yLast <= 3) { l.items.push(it); l.yLast = it.y; } else lines.push({ y: it.y, yLast: it.y, items: [it] });
    }
    const info = lines.map(l => { const t = lineText(l.items); return { ...l, text: crewAccessText(t.text), at: t.at }; });
    for (const [k, l] of info.entries()) {
      const dm = DAY.exec(l.text);
      if (dm) {
        const t = Date.UTC(+dm[4], monthIndex(dm[3]), +dm[2]);
        const d = new Date(t);
        cur = { section: 'published', date: `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${dm[4].slice(2)}`, day: WEEKDAYS[d.getUTCDay()] };
        curItems = l.at(0, dm.indices[4][1]);
        station = dm[5] || '';
        continue;
      }
      if (!cur) continue;
      const add = (r, marks) => {
        const row = { ...cur, notes: [], ...r };
        rows.push(row);
        for (const [f, it] of marks) if (it && [].concat(it).length) mark(row, f, it);
        if (curItems) { mark(row, 'date', curItems); curItems = null; }
        return row;
      };
      const at = (m, g) => (m?.indices?.[g] ? l.at(...m.indices[g]) : []);
      const span = SPAN.exec(l.text);
      const st = /\b([A-Z]{3})\s*$/d.exec(l.text.replace(/\s*\)\s*$/, ''));
      let m;
      if ((m = /^(Check-In|Apresentação|Release) /.exec(l.text)) && span) {
        const stm = /\b([A-Z]{3})\b(?!.*\b[A-Z]{3}\b)/d.exec(l.text.slice(span.index + span[0].length));
        const stItems = stm ? l.at(span.index + span[0].length + stm.indices[1][0], span.index + span[0].length + stm.indices[1][1]) : [];
        if (m[1] === 'Release') add({ duty: 'C/O', arr: stm?.[1] || station, end: time(span[3], span[4]) }, [['co', at(span, 3)], ['arr', stItems]]);
        else add({ duty: 'C/I', dep: stm?.[1] || station, begin: time(span[1], span[2]) }, [['ci', at(span, 1)], ['dep', stItems]]);
        continue;
      }
      if (/^Hotel /.test(l.text) && span) {
        const name = info.slice(Math.max(0, k - 3), k).flatMap(x => x.items).filter(i => i.x >= 350 && !/:/.test(i.text)).map(i => i.text).join(' ');
        add({ duty: 'H', dep: station, begin: time(span[1], span[2]), end: time(span[3], span[4]), notes: name ? [name] : [] }, [['begin', at(span, 1)], ['end', at(span, 3)]]);
        continue;
      }
      // an activity: "Off 00:00 - 00:00/+1 CNF Position: CA Activity Code: FP"
      if ((m = /^([A-Za-z][A-Za-z ]*?) (?=\d{2}:\d{2})/.exec(l.text)) && span && (m = /Activity Code:? ?(\S+)/d.exec(l.text))) {
        const name = /^([A-Za-z][A-Za-z ]*?) (?=\d{2}:\d{2})/d.exec(l.text);
        const stm = /\b([A-Z]{3}) +Position/d.exec(l.text);
        const pos = /Position:? ?([A-Z]{2,3})\b/d.exec(l.text);
        add({ duty: m[1].toUpperCase(), dep: stm?.[1] || '', begin: time(span[1], span[2]), end: time(span[3], span[4]), notes: [`[${m[1].toUpperCase()}: ${name[1]}]`, pos && `[Position: ${pos[1]}]`].filter(Boolean) },
          [['duty', at(m, 1)], ['dep', at(stm, 1)], ['begin', at(span, 1)], ['end', at(span, 3)], ['info', [...at(name, 1), ...at(pos, 1)]]]);
        continue;
      }
      // a flight: "SV 323 ( TVL ) RUH > CAI Position: CA Flight Time: 2h 27m", "AD4950 SSALEC Position: ..."
      const fm = /^([A-Z0-9]{2}) ?(\d{1,4}[A-Z]?)\b(?: ?\( ?(TVL) ?\))?.*?\b([A-Z]{3}) ?>? ?([A-Z]{3}) +Position/d.exec(l.text);
      if (fm) {
        // the scheduled times: a time span left of the flight on its own line above (or on this line), the actual ones in brackets under it
        const near = info.filter(x => x !== l && Math.abs(x.y - l.y) < 10);
        const schedLine = near.filter(x => x.y < l.y).reverse().find(x => SPAN.test(x.text) && !/^\(/.test(x.text.trim()));
        const actLine = near.filter(x => x.y > l.y).find(x => /^\(/.test(x.text.trim()) && SPAN.test(x.text));
        const sched = schedLine ? SPAN.exec(schedLine.text) : span && !/\(/.test(l.text.slice(0, span.index)) ? span : null;
        const act = actLine ? SPAN.exec(actLine.text) : null;
        const pos = /Position:? ?([A-Z]{2,3})\b/d.exec(l.text);
        const ft = /Flight Time:? ?(\d+)h ?(\d+)m/d.exec(l.text);
        const sAt = (g) => (sched && schedLine ? schedLine.at(...sched.indices[g]) : at(sched, g));
        add({
          duty: `${fm[1]}${fm[2]}`, dc: fm[3] ? 'DH' : '', dep: fm[4], arr: fm[5],
          begin: sched ? time(sched[1], sched[2]) : '', end: sched ? time(sched[3], sched[4]) : '',
          notes: [pos && `[Position: ${pos[1]}]`, ft && `[Flight: ${ft[1].padStart(2, '0')}:${ft[2].padStart(2, '0')}]`,
            act && `[Actual: ${act[1]}${act[2] ? ` +${act[2]}` : ''} - ${act[3]}${act[4] ? ` +${act[4]}` : ''}]`].filter(Boolean),
        }, [['duty', [...at(fm, 1), ...at(fm, 2)]], ['dep', at(fm, 4)], ['arr', at(fm, 5)], ['begin', sAt(1)], ['end', sAt(3)], ['info', [...at(pos, 1), ...at(ft, 1), ...at(ft, 2)]]]);
      }
    }
  }
  const out = rows.map(r => outputRow({ ...r, info: r.notes.join(' ') }, 'L'));
  const first = rows[0], last = rows.at(-1);
  const pd = (r) => { const [dd, mon, yy] = r.date.split(' '); return `${dd.padStart(2, '0')}${mon}${yy}`; };
  return { format: 'crew-access-detail', period: first ? `${pd(first)} - ${pd(last)}` : null, notices: [], recognized: out.length > 0, published: out, planned: [], _trace: trace, _rows: rows };
}

const isDayTableRoster = (page) => page.items.some(i => i.text === 'All times in station local time') && ['Aircraft Type', 'Description', 'Function', 'Crew', 'Block'].every(t => page.items.some(i => i.text === t));

/**
 * A month as a table of days (Flightworx, "All times in station local time"): Day "27 Aug Thu" | Aircraft Type "A320 9H-AEO" | Check In |
 * Description | Check Out | Function | Crew | Block. A day of flights takes several lines with its Day and Aircraft Type centred on them:
 *   "MMO030 11:50 MLA OTP 15:20" | FO | "AMS-CGA-" / "MRM / GMA-" / "SCE" (the crew wraps over three lines) | 02:30
 *   "MMO031 16:20 OTP MLA 17:50" | 18:20 (Check Out) | ...
 *   10:20 (Check In) | "MMO030/MMO031 10:20 MLA 18:20" (the duty's line)
 * -> a C/I row (Check In), the flights (ac / registration, crew "[Crew - AMS-CGA-MRM / GMA-SCE]", "[Function: FO] [Block: 02:30]"), a C/O row
 * (Check Out); "Off Duty MLA", "Home STBY 1000-1600Z 09:00 MLA 15:00" a row each. The totals page is not read.
 */
function parseDayTableRoster(pages) {
  const trace = startTrace();
  const rows = [];
  const DAY = /^(\d{2}) ([A-Z][a-z]{2}) (Mon|Tue|Wed|Thu|Fri|Sat|Sun)$/;
  const year = +(pages.flatMap(p => p.items).find(i => /^\d{4}$/.test(i.text) && i.y < 130)?.text || new Date().getUTCFullYear());
  for (const page of pages) {
    const head = page.items.find(i => i.text === 'Description');
    if (!head) continue;
    const H = (t) => page.items.find(i => i.text === t && Math.abs(i.y - head.y) < 8)?.x;
    const X = { ci: H('Check'), desc: H('Check') + 30, co: page.items.filter(i => i.text === 'Check' && Math.abs(i.y - head.y) < 8).map(i => i.x).sort((a, b) => a - b)[1], fn: H('Function'), crew: H('Crew'), block: H('Block') };
    const body = page.items.filter(i => i.y > head.y + 8);
    const labels = body.filter(i => DAY.test(i.text)).sort((a, b) => a.y - b.y);
    if (!labels.length) continue;
    const acItems = body.filter(i => i.x > 60 && i.x < X.ci - 10 && /^[A-Z0-9]{3,4} \S+$/.test(i.text));
    // the lines with a Description (crew wraps and day labels are not lines of their own)
    const lines = toLines(body.filter(i => i.x >= X.ci - 10 && i.x < X.fn - 5), 2).filter(l => l.items.some(i => i.x >= X.desc));
    const nearest = (y) => labels.reduce((b, d) => (Math.abs(d.y - y) < Math.abs(b.y - y) ? d : b), labels[0]);
    const groups = new Map(); // label -> lines
    let lastFlightLabel = null;
    for (const l of lines) {
      const desc = l.items.filter(i => i.x >= X.desc).map(i => i.text).join(' ');
      // the duty's line ("MMO030/MMO031 ...") goes with its flights' day
      const lab = /^[A-Z0-9]+\/[A-Z0-9]+/.test(desc) && lastFlightLabel ? lastFlightLabel : nearest(l.y);
      if (/^[A-Z]{2,3}\d{2,4}[A-Z]? \d{2}:\d{2} [A-Z]{3} [A-Z]{3} \d{2}:\d{2}/.test(desc)) lastFlightLabel = lab;
      (groups.get(lab) || groups.set(lab, []).get(lab)).push(l);
    }
    for (const lab of labels) {
      const [, dd, mon] = DAY.exec(lab.text);
      const t = Date.UTC(year, monthIndex(mon), +dd);
      const d = new Date(t);
      const base = { section: 'published', date: `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${String(year % 100).padStart(2, '0')}`, day: WEEKDAYS[d.getUTCDay()], notes: [] };
      let first = true;
      const add = (r, marks) => {
        const row = { ...base, ...r, notes: r.notes || [] };
        rows.push(row);
        for (const [f, it] of marks) if (it && [].concat(it).length) mark(row, f, it);
        if (first) { mark(row, 'date', lab); first = false; }
        return row;
      };
      const ls = (groups.get(lab) || []).sort((a, b) => a.y - b.y);
      const ac = acItems.find(i => Math.abs(i.y - lab.y) < 12);
      const [type, reg] = ac ? ac.text.split(' ') : [];
      const dutyLine = ls.find(l => /^[A-Z0-9]+\/[A-Z0-9]+/.test(l.items.filter(i => i.x >= X.desc).map(i => i.text).join(' ')));
      const ci = dutyLine?.items.find(i => i.x < X.desc && /^\d{2}:\d{2}$/.test(i.text));
      const flights = ls.filter(l => l !== dutyLine && /^[A-Z]{2,3}\d{2,4}[A-Z]? \d{2}:\d{2} [A-Z]{3} [A-Z]{3} \d{2}:\d{2}/.test(l.items.filter(i => i.x >= X.desc && i.x < X.co - 5).map(i => i.text).join(' ')));
      if (flights.length) {
        if (ci) add({ duty: 'C/I', dep: flights[0].items.filter(i => i.x >= X.desc)[2]?.text || '', begin: ci.text }, [['ci', ci]]);
        let co = null, arr = '';
        for (const fl of flights) {
          const [f, t1, dep, arrI, t2] = fl.items.filter(i => i.x >= X.desc && i.x < X.co - 5);
          const crewItems = body.filter(i => i.x >= X.crew - 30 && i.x < X.block - 5 && Math.abs(i.y - fl.y) < 10).sort((a, b) => a.y - b.y || a.x - b.x);
          const fn = body.find(i => i.x >= X.fn - 5 && i.x < X.crew - 30 && Math.abs(i.y - fl.y) < 3);
          const blk = body.find(i => i.x >= X.block - 5 && Math.abs(i.y - fl.y) < 3 && /^\d{2}:\d{2}$/.test(i.text));
          co = fl.items.find(i => i.x >= X.co - 5 && /^\d{2}:\d{2}$/.test(i.text)) || co;
          arr = arrI.text;
          add({ duty: f.text, dep: dep.text, arr: arrI.text, begin: t1.text, end: t2.text, ac: type || '', registration: reg || '',
            crew: crewItems.length ? `[Crew - ${crewItems.map(i => i.text).join('').replace(/\s*\/\s*/g, ' / ')}]` : '',
            notes: [fn && `[Function: ${fn.text}]`, blk && `[Block: ${blk.text}]`].filter(Boolean) },
          [['duty', f], ['begin', t1], ['dep', dep], ['arr', arrI], ['end', t2], ['ac', ac && pieceOf(ac, 0, type.length)], ['registration', ac && pieceOf(ac, type.length + 1, reg.length)],
            ['crew', crewItems], ['info', [fn, blk].filter(Boolean)]]);
        }
        if (co) add({ duty: 'C/O', arr, end: co.text }, [['co', co]]);
        continue;
      }
      for (const l of ls) {
        const ci2 = l.items.find(i => i.x < X.desc && /^\d{2}:\d{2}$/.test(i.text));
        const co2 = l.items.find(i => i.x >= X.co - 5 && /^\d{2}:\d{2}$/.test(i.text));
        const desc = l.items.filter(i => i.x >= X.desc && i.x < X.co - 5);
        const st = desc.find(i => /^[A-Z]{3}$/.test(i.text));
        const name = desc.filter(i => !/^\d{2}:\d{2}$/.test(i.text) && i !== st);
        const times = desc.filter(i => /^\d{2}:\d{2}$/.test(i.text));
        add({ duty: name.map(i => i.text).join(' '), dep: st?.text || '', begin: (ci2 || times[0])?.text || '', end: (co2 || times.at(-1))?.text || '' },
          [['duty', name], ['dep', st], ['begin', ci2 || times[0]], ['end', co2 || times.at(-1)]]);
      }
    }
  }
  const mon = pages.flatMap(p => p.items).find(i => /^(JANUARY|FEBRUARY|MARCH|APRIL|MAY|JUNE|JULY|AUGUST|SEPTEMBER|OCTOBER|NOVEMBER|DECEMBER)$/.test(i.text));
  const mi = mon ? monthIndex(mon.text.slice(0, 3)) : -1;
  const out = rows.map(r => outputRow({ ...r, info: r.notes.join(' ') }, 'L'));
  return { format: 'day-table-roster', period: mi >= 0 ? `01${MONTHS[mi]}${String(year).slice(2)} - ${new Date(Date.UTC(year, mi + 1, 0)).getUTCDate()}${MONTHS[mi]}${String(year).slice(2)}` : null,
    notices: [], recognized: out.length > 0, published: out, planned: [], _trace: trace, _rows: rows };
}

const isMinhaEscala = (page) => page.items.some(i => /^Minha$/.test(i.text)) && page.items.some(i => /^Escala$/.test(i.text))
  && ['Checkin', 'Checkout', 'AcVer'].every(t => page.items.some(i => i.text === t));

/**
 * Azul "Minha Escala" (a web page printed as one tall picture, read by OCR in strips): a table
 *   Activity | Checkin | Start | End | Checkout | Dep | Arr | AcVer | DD/CAT | Crews (Crew | Function)
 * each date-time cell on three lines ("28 JUN." / "2024" / "05:30"), the activity, airports, aircraft and DD/CAT on the middle one, the crew
 * table beside it. Rows: C/I (Checkin), the flight (Start / End, "DHD" -> dc DH, crew "[CA - CAVALCANTI][FO - BONITZ]..."), C/O (Checkout);
 * "Layover" a hotel row. Times taken as UTC, as in Azul's activity lists.
 */
function parseMinhaEscala(pages) {
  const trace = startTrace();
  const rows = [];
  const MON = (t) => monthIndex(String(t).slice(0, 3));
  for (const page of pages) {
    const head = page.items.find(i => i.text === 'AcVer');
    if (!head) continue;
    const hl = page.items.filter(i => Math.abs(i.y - head.y) < 8);
    const centre = (i) => i.x + (i.w || 0) / 2;
    const H = (re) => hl.find(i => re.test(i.text));
    const cols = [['act', /^Activ/], ['ci', /^Checkin$/], ['start', /^Start$/], ['end', /^End$/], ['co', /^Checkout$/], ['dep', /^Dep$/], ['arr', /^Arr$/], ['ac', /^AcVer$/], ['dd', /^DD/], ['crews', /^Cre[wW]s$/]]
      .map(([col, re]) => { const h = H(re); return h && { col, c: centre(h) }; }).filter(Boolean);
    const colOf = (i) => cols.reduce((b, h) => (Math.abs(h.c - centre(i)) < Math.abs(b.c - centre(i)) ? h : b), cols[0]).col;
    const crewX = (cols.find(c => c.col === 'crews')?.c ?? Infinity) - 30; // the crew names start well left of the "Crews" header's middle
    const body = page.items.filter(i => i.y > head.y + 10);
    // a record per activity in the first column (a flight number, "Layover")
    const anchors = body.filter(i => colOf(i) === 'act' && /^([A-Z0-9]{2}\d{2,4}[A-Z]?|[A-Z][a-z]+)$/.test(i.text) && i.x < (cols[1]?.c ?? 150) - 40).sort((a, b) => a.y - b.y);
    // the crew tables: rows (name, function) between "Crew | Function" headers
    const crewHeads = body.filter(i => /^Cre[wW]$/.test(i.text) && i.x > crewX - 150).map(i => i.y).sort((a, b) => a - b);
    // a crew row: its function (right column) and the name beside it (OCR puts them a few points apart)
    const fnHead = body.find(i => i.text === 'Function');
    const fnX = fnHead ? fnHead.x - 15 : crewX + 100;
    const names = body.filter(i => i.x > crewX - 150 && i.x < fnX && !/^(Cre[wW]|Function)$/.test(i.text));
    const crewRows = body.filter(i => i.x >= fnX && /^[A-Z]{2,3}$/.test(i.text)).map((fn) => {
      const near = names.filter(i => Math.abs(i.y - fn.y) < 8);
      const y0 = near.sort((a, b) => Math.abs(a.y - fn.y) - Math.abs(b.y - fn.y))[0]?.y;
      return { y: fn.y, fn, name: near.filter(i => Math.abs(i.y - y0) < 3).sort((a, b) => a.x - b.x) };
    });
    for (const [k, a] of anchors.entries()) {
      const band = body.filter(i => Math.abs(i.y - a.y) <= 34 && i.x < crewX - 150 + 20);
      const cell = (col) => band.filter(i => colOf(i) === col).sort((x, y) => x.y - y.y || x.x - y.x);
      const stamp = (col) => {
        const its = cell(col);
        const m = /(\d{1,2}) ?([A-Z]{3})\.?.*?(\d{4}).*?(\d{2}:\d{2})/.exec(its.map(i => i.text).join(' '));
        return m && MON(m[2]) >= 0 ? { t: Date.UTC(+m[3], MON(m[2]), +m[1]), hhmm: m[4], items: its } : null;
      };
      const [ci, s, e, co] = ['ci', 'start', 'end', 'co'].map(stamp);
      const first = s || ci || e;
      if (!first) continue;
      const day = (t) => { const d = new Date(t); return { section: 'published', date: `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${String(d.getUTCFullYear() % 100).padStart(2, '0')}`, day: WEEKDAYS[d.getUTCDay()] }; };
      const plus = (x, from) => (x && from && x.t > from.t ? `+${Math.round((x.t - from.t) / 86400000)}` : '');
      const get = (col) => cell(col).filter(i => Math.abs(i.y - a.y) < 8).map(i => i.text).join(' ');
      const dep = get('dep'), arr = get('arr'), dd = get('dd');
      const add = (r, marks) => { const row = { notes: [], ...r }; rows.push(row); for (const [f, it] of marks) if (it && [].concat(it).length) mark(row, f, it); return row; };
      if (ci) add({ ...day(ci.t), duty: 'C/I', dep, begin: ci.hhmm }, [['date', ci.items.slice(0, 1)], ['ci', ci.items.filter(i => i.text === ci.hhmm)]]);
      if (a.text === 'Layover') {
        add({ ...day(s.t), duty: 'H', dep, begin: s?.hhmm || '', end: e ? `${e.hhmm}${plus(e, s)}` : '' }, [['date', s.items.slice(0, 1)], ['dep', cell('dep')], ['begin', s.items.filter(i => i.text === s.hhmm)], ['end', e?.items.filter(i => i.text === e.hhmm)]]);
        continue;
      }
      // the crew rows of this record: in its crew table (between the headers around it), up to the next record
      const hTop = Math.max(-Infinity, ...crewHeads.filter(y => y < a.y + 20));
      const hNext = Math.min(anchors[k + 1] ? anchors[k + 1].y - 34 : Infinity, ...crewHeads.filter(y => y > a.y + 20));
      const crew = crewRows.filter(r => r.y > hTop && r.y < hNext);
      add({
        ...day((s || first).t), duty: a.text, dc: dd === 'DHD' ? 'DH' : '', dep, arr, begin: s?.hhmm || '', end: e ? `${e.hhmm}${plus(e, s)}` : '', ac: get('ac'),
        crew: crew.map(r => `[${r.fn.text} - ${r.name.map(i => i.text).join(' ')}]`).join(''), notes: dd && dd !== 'DHD' ? [`[${dd}]`] : [],
      }, [['date', (s || first).items.slice(0, 1)], ['duty', a], ['dep', cell('dep')], ['arr', cell('arr')], ['begin', s?.items.filter(i => i.text === s.hhmm)], ['end', e?.items.filter(i => i.text === e.hhmm)],
        ['ac', cell('ac')], ['crew', crew.flatMap(r => [r.fn, ...r.name])], ['info', dd !== 'DHD' ? cell('dd') : null]]);
      if (co) add({ ...day(s ? s.t : co.t), duty: 'C/O', arr, end: `${co.hhmm}${plus(co, s)}` }, [['co', co.items.filter(i => i.text === co.hhmm)]]);
    }
  }
  const fmt = (r) => { const [d, m, y] = r.date.split(' '); return `${d.padStart(2, '0')}${m}${y}`; };
  const out = rows.map(r => outputRow({ ...r, info: r.notes.join(' ') }, 'Z'));
  return { format: 'minha-escala', period: rows.length ? `${fmt(rows[0])} - ${fmt(rows.at(-1))}` : null, notices: [], recognized: out.length > 0, published: out, planned: [], _trace: trace, _rows: rows };
}

const LRR_PERIOD = /^(\d{2})-([A-Z][a-z]{2})-(\d{4}) ?to ?(\d{2})-([A-Z][a-z]{2})-(\d{4})$/;
const isLatamRosterReport = (page) => page.items.some(i => i.text === 'Roster Report') && page.items.some(i => LRR_PERIOD.test(i.text));
// a header column (its lines joined: "Dep Stn / Dep Time") -> field; the others (Rank, ACY Rep, SDC, Updated By ..) are not read
const LRR_COLUMNS = [[/ACY/, 'skip'], [/^Date/, 'date'], [/^DOW/, 'dow'], [/^Pairing/, 'pairing'], [/Debrief/, 'debrief'], [/Report/, 'report'], [/^Item/, 'item'],
  [/^Dep/, 'dep'], [/^Arr/, 'arr'], [/^(Flying|FH$)/, 'fh'], [/^(Duty H|DH$)/, 'dh'], [/^A\/C/, 'ac'], [/^Hotel/, 'hotel'], [/^(Work|WT)/, 'wt']];
// the columns of the print without a header row (the same as with one: "Roster Report" 1300 x 750 pt)
const LRR_DEFAULT = [['date', 25, 75], ['dow', 128, 150], ['pairing', 184, 255], ['report', 271, 330], ['item', 366, 400], ['skip', 433, 490], ['wt', 514, 565],
  ['dep', 587, 650], ['arr', 665, 730], ['debrief', 750, 800], ['fh', 829, 880], ['dh', 913, 965], ['skip', 1009, 1035], ['ac', 1078, 1120], ['hotel', 1168, 1230], ['skip', 1237, 1290]]
  .map(([f, left, right]) => ({ f, left, right }));

/**
 * "Roster Report" (LATAM / Jetstar, Sabre: "01-Jun-2024 to 01-Jul-2024", the crew member's name | id | base | rank), a line per event:
 *   Date | (DOW) | Pairing/Activity | (Duty) Report | Item | (Overridden) Rank | Work Type | Dep Stn / Dep Time | Arr. Stn / Arr. Time |
 *   (Duty) Debrief | Flying Hrs | Duty Hrs | SDC | A/C Type | Hotel | ...
 * The header's words take two or three lines ("Duty" over "Report"), a few prints have none (the columns are then where the others
 * print them). A cell that does not fit wraps above and below its line ("GRU" / "00:50(+1)"); "<==" for the date: the pairing began
 * before the period, on the weekday printed beside it. "(+1)" counts from the line's date, but some prints leave it out: a duty's times
 * are taken to run forward. Rows: C/I (Report), the flights ("PX" work type: dc DH, "[Block: ..]" its Flying Hrs), C/O (Debrief),
 * the hotel after it; an activity (DO, VC, RES-L, a simulator) a row of its own. The report says nothing of its time zone: taken as local.
 */
function parseLatamRosterReport(pages) {
  const trace = startTrace();
  const rows = [];
  const pm = pages.flatMap(p => p.items).map(i => LRR_PERIOD.exec(i.text)).find(Boolean);
  const from = Date.UTC(+pm[3], monthIndex(pm[2]), +pm[1]);
  const DAY = 86400000;
  const dateOf = (t) => { const d = new Date(t); return { section: 'published', date: `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${String(d.getUTCFullYear() % 100).padStart(2, '0')}`, day: WEEKDAYS[d.getUTCDay()] }; };
  const centre = (i) => i.x + (i.w || 0) / 2;
  // a station and / or a time in a cell's items: { st, hhmm, off, items (the pieces, for the trace) }
  const stnTime = (items) => {
    const out = { st: '', hhmm: '', off: 0, items: [] };
    for (const it of items) {
      const s = !out.st && /\b[A-Z]{3}\b/.exec(it.text);
      if (s && !/^\d/.test(it.text)) { out.st = s[0]; out.stItem = pieceOf(it, s.index, 3); }
      const t = !out.hhmm && /\b(\d{1,2}):(\d{2})\b/.exec(it.text);
      if (t) { out.hhmm = `${t[1].padStart(2, '0')}:${t[2]}`; out.tItem = pieceOf(it, t.index, t[0].length); }
      const o = /\(\+(\d)/.exec(it.text);
      if (o) out.off = +o[1];
    }
    return out;
  };
  let cols = null;
  let cur = null; // the date of the line before (a line without one goes on with it)
  let duty = null; // the open duty: { ci, flights: [], hotel }
  const add = (r, marks) => { const row = { notes: [], ...r }; rows.push(row); for (const [f, it] of marks) if (it && [].concat(it).length) mark(row, f, it); return row; };
  for (const page of pages) {
    const lines = toLines(page.items, 2);
    const pairings = page.items.filter(i => /^Pairing ?\/ ?Activity$/.test(i.text)).sort((a, b) => a.y - b.y);
    // the header: its lines (two items or more, no digit) around "Pairing/Activity"; a page may print it again lower down
    const headOf = (p) => lines.filter(l => l.y >= p.y - 8 && l.y <= p.y + 13 && l.items.length >= 2 && !l.items.some(i => /\d/.test(i.text))).flatMap(l => l.items);
    const heads = new Set(pairings.flatMap(headOf));
    const pairing = pairings[0];
    let top = (lines.find(l => l.items.some(i => LRR_PERIOD.test(i.text)))?.y ?? 0) + 10;
    if (pairing) {
      // a column per run of overlapping words
      const head = headOf(pairing);
      const clusters = [];
      for (const it of [...head].sort((a, b) => a.x - b.x)) {
        const r = it.x + (it.w || it.text.length * 4);
        const c = clusters.find(k => it.x < k.right - 1 && r > k.left + 1);
        if (c) { c.items.push(it); c.left = Math.min(c.left, it.x); c.right = Math.max(c.right, r); } else clusters.push({ left: it.x, right: r, items: [it] });
      }
      cols = clusters.map(c => ({ ...c, f: (LRR_COLUMNS.find(([re]) => re.test(c.items.sort((a, b) => a.y - b.y).map(i => i.text).join(' '))) || [, 'skip'])[1] }));
      top = Math.max(...head.map(i => i.y)) + 4;
    }
    const C = cols || LRR_DEFAULT;
    const colOf = (i) => C.reduce((b, c) => { const d = Math.max(0, c.left - centre(i), centre(i) - c.right); return d < b.d ? { d, f: c.f } : b; }, { d: Infinity, f: 'skip' }).f;
    const legend = page.items.find(i => i.text === 'LEGEND');
    const body = page.items.filter(i => i.y > top && !heads.has(i) && (!legend || i.y < legend.y - 4));
    // a station starts the Dep or the Arr cell (the nearer); a time under a station is in its column (a wrapped "GRU" / "00:50(+1)")
    const STN = /^[A-Z]{3}( \d{1,2}:\d{2}\S*)?$/;
    const stnCol = (i) => C.filter(c => c.f === 'dep' || c.f === 'arr').reduce((b, c) => { const d = Math.max(0, c.left - centre(i), centre(i) - c.right); return d < b.d ? { d, f: c.f } : b; }, { d: Infinity, f: 'skip' }).f;
    // (a station with its time may stand nearer a column not read, "SYD 04:55" under "ACY Deb"; "FDT" alone in Rank is no station)
    const isStn = (i) => STN.test(i.text) && (['dep', 'arr'].includes(colOf(i)) || (/\d/.test(i.text) && colOf(i) === 'skip'));
    const anchors = toLines(body, 2).filter(l => l.items.some(i => isStn(i) && stnCol(i) === 'dep'));
    if (!anchors.length) continue;
    const near = new Map(anchors.map(a => [a, []]));
    for (const it of body) {
      const a = anchors.reduce((b, l) => (Math.abs(l.y - it.y) < Math.abs(b.y - it.y) ? l : b), anchors[0]);
      if (Math.abs(a.y - it.y) <= 22) near.get(a).push(it);
    }
    for (const a of anchors) {
      const its = near.get(a).sort((p, q) => p.y - q.y || p.x - q.x);
      const stns = its.filter(isStn);
      // a cell's wrapped lines start where its first does ("Hotel Ibis Navegantes" / "Itajai")
      const colIn = new Map();
      for (const i of its) {
        const under = /^\d{1,2}:\d{2}|^\(\+/.test(i.text) && stns.find(s => Math.abs(s.x - i.x) < 4);
        const above = [...colIn.keys()].find(o => Math.abs(o.x - i.x) < 3 && o.y < i.y - 2);
        colIn.set(i, stns.includes(i) ? stnCol(i) : under ? stnCol(under) : above ? colIn.get(above) : colOf(i));
      }
      const cell = (f) => its.filter(i => colIn.get(i) === f);
      const text = (f) => cell(f).map(i => i.text).join(' ').trim();
      const dItem = cell('date')[0];
      let m;
      if (dItem && (m = /^(\d{2})-([A-Z][a-z]{2})-(\d{4})/.exec(dItem.text))) cur = Date.UTC(+m[3], monthIndex(m[2]), +m[1]);
      else if (dItem && (m = /^(\d{2})\/(\d{2})\/(\d{4})/.exec(dItem.text))) cur = Date.UTC(+m[3], +m[2] - 1, +m[1]);
      else if (dItem && dItem.text === '<==') {
        // the weekday the pairing began, on or before the period's first day
        const wd = WEEKDAYS.indexOf(text('dow').slice(0, 3));
        cur = from - (wd >= 0 ? ((new Date(from).getUTCDay() - wd + 7) % 7) * DAY : 0);
      }
      if (cur == null) cur = from;
      const item = text('item'), wt = text('wt');
      const rep = stnTime(cell('report')), dep = stnTime(cell('dep')), arr = stnTime(cell('arr')), deb = stnTime(cell('debrief'));
      const fh = text('fh'), dh = text('dh'), ac = text('ac'), hotel = text('hotel');
      const dateMark = dItem && dItem.text !== '<==' ? [pieceOf(dItem, 0, Math.min(dItem.text.length, 11))] : null;
      const flight = /^[A-Z0-9]{2}\d{1,4}[A-Z]?$/.test(item);
      const min = (x) => (x.hhmm ? x.off * 1440 + (+x.hhmm.slice(0, 2)) * 60 + (+x.hhmm.slice(3)) : null);
      if (!flight) {
        // an activity: its code, where, from and until
        duty = null;
        const code = item || text('pairing').split(/\s+/)[0];
        const b = min(dep) ?? min(rep), e0 = min(arr) ?? min(deb);
        const e = e0 != null && b != null && e0 < b ? e0 + 1440 * Math.ceil((b - e0) / 1440) : e0;
        const base = b != null ? Math.floor(b / 1440) : 0;
        const at = (v) => `${String(Math.floor((v % 1440) / 60)).padStart(2, '0')}:${String(v % 60).padStart(2, '0')}`;
        add({ ...dateOf(cur + base * DAY), duty: code, dep: dep.st, arr: arr.st && arr.st !== dep.st ? arr.st : '',
          begin: b != null ? at(b) : '', end: e != null ? `${at(e)}${Math.floor(e / 1440) > base ? `+${Math.floor(e / 1440) - base}` : ''}` : '' },
        [['date', dateMark], ['duty', cell(item ? 'item' : 'pairing').slice(0, 1).map(i => pieceOf(i, 0, code.length))], ['dep', dep.stItem], ['arr', arr.st !== dep.st && arr.stItem],
          ['begin', dep.tItem || rep.tItem], ['end', arr.tItem || deb.tItem]]);
        continue;
      }
      // a flight: the report opens a duty, the debrief closes it; its times run forward from the line before
      if (rep.hhmm || !duty) duty = { last: null, cur, hotel: '', hotelItems: [] };
      const fwd = (v) => { if (v == null) return null; let x = v; while (duty.last != null && x < duty.last - 60) x += 1440; duty.last = x; return x; };
      const repAt = rep.hhmm ? fwd(min(rep)) : null;
      const depAt = fwd(min(dep)), arrAt = fwd(min(arr)), debAt = deb.hhmm ? fwd(min(deb)) : null;
      const day0 = Math.floor((depAt ?? repAt ?? 0) / 1440);
      const hm = (x, v, d0) => (v == null ? '' : `${x.hhmm}${Math.floor(v / 1440) > d0 ? `+${Math.floor(v / 1440) - d0}` : ''}`);
      if (repAt != null) {
        add({ ...dateOf(duty.cur + Math.floor(repAt / 1440) * DAY), duty: 'C/I', dep: dep.st, begin: rep.hhmm, notes: dh && !/^0?0:00$/.test(dh) ? [`[Duty: ${dh}]`] : [] },
          [['date', dateMark], ['ci', rep.tItem], ['info', cell('dh')]]);
      }
      add({ ...dateOf(duty.cur + day0 * DAY), duty: item, dc: /^(PX|DH|DHD)$/.test(wt) ? 'DH' : '', dep: dep.st, arr: arr.st,
        begin: hm(dep, depAt, day0), end: hm(arr, arrAt, day0), ac, notes: fh && !/^0?0:00$/.test(fh) ? [`[Block: ${fh}]`] : [] },
      [['date', repAt == null ? dateMark : null], ['duty', cell('item')], ['dep', dep.stItem], ['arr', arr.stItem], ['begin', dep.tItem], ['end', arr.tItem], ['ac', cell('ac')], ['info', fh && !/^0?0:00$/.test(fh) ? cell('fh') : null]]);
      if (hotel) { duty.hotel = hotel; duty.hotelItems = cell('hotel'); }
      if (debAt != null) {
        add({ ...dateOf(duty.cur + day0 * DAY), duty: 'C/O', arr: arr.st, end: hm(deb, debAt, day0) }, [['co', deb.tItem]]);
        if (duty.hotel) add({ ...dateOf(duty.cur + day0 * DAY), duty: 'H', dep: arr.st, notes: [duty.hotel] }, [['hotel', duty.hotelItems]]);
        duty = null;
      }
    }
  }
  const out = rows.map(r => outputRow({ ...r, info: r.notes.join(' ') }, 'L'));
  const yy = (s) => s.slice(2);
  return { format: 'latam-roster-report', period: `${pm[1]}${pm[2]}${yy(pm[3])} - ${pm[4]}${pm[5]}${yy(pm[6])}`, notices: [], recognized: out.length > 0, published: out, planned: [], _trace: trace, _rows: rows };
}

const isCrewScheduleList = (page) => page.items.some(i => /^CREW SCHEDULE LIST/.test(i.text)) && page.items.some(i => i.text === 'DUTY END') && page.items.some(i => i.text === 'DETAIL INFO');

/**
 * "CREW SCHEDULE LIST (LATEST)" (Japan Airlines group, jasperadmin; "PERIOD 2025/04/01 - 2025/04/30"), an entry a block:
 *   LOCAL DATE "01APR" / "(Tue)" | DUTY | FLT NO. / FLEET | PORT (dep / arr) | REPORT | DEP | ARV | DUTY END (local; UTC under them,
 *   "(19:00-1)") | CREW: STAFF NO. / NAME / RANK, the crew's duty under DUTY | DETAIL INFO: PLACE, the crew member's part, EVENT
 * Rows: the entry's duty (a flight: its number, "DH1" -> dc DH, the fleet; "SIM", "TRG", "OFF", "BD"; "---" is a briefing: its event
 * "BRFG"), the place and event as info, the other crew "[CAP - 03389 - HIROYUKI HOSHINO]"; C/I (REPORT) and C/O (DUTY END) around
 * a duty with a flight or a simulator. Local times.
 */
function parseCrewScheduleList(pages) {
  const trace = startTrace();
  const rows = [];
  const all = pages.flatMap(p => p.items);
  const pm = /^(\d{4})\/(\d{2})\/(\d{2}) - (\d{4})\/(\d{2})\/(\d{2})$/.exec(all.find(i => /^\d{4}\/\d{2}\/\d{2} - \d{4}\/\d{2}\/\d{2}$/.test(i.text))?.text || '');
  const me = all.find(i => /^\d{4,6}$/.test(i.text) && all.some(s => s.text === 'STAFF NO.' && Math.abs(s.y - i.y) < 3 && s.x < 40))?.text;
  const y0 = pm ? +pm[1] : new Date().getUTCFullYear(), m0 = pm ? +pm[2] - 1 : 0;
  const DATE = /^(\d{2})([A-Z]{3})$/;
  const TIME = /^\d{2}:\d{2}(\+\d)?$/;
  let cur = null;
  let open = null; // the rows since the last C/I
  const add = (r, marks) => { const row = { notes: [], ...r }; rows.push(row); for (const [f, it] of marks) if (it && [].concat(it).length) mark(row, f, it); return row; };
  const close = () => {
    // C/I and C/O only around a duty with a flight or a simulator
    if (open && !open.rows.some(r => r.isFlight || /^(SIM|DH)/.test(r.duty) || r.dc === 'DH')) for (const r of open.rows.filter(x => /^C\/[IO]$/.test(x.duty))) rows.splice(rows.indexOf(r), 1);
    open = null;
  };
  for (const page of pages) {
    const head = page.items.find(i => i.text === 'DUTY END');
    if (!head) continue;
    const X = (t, below = 12) => page.items.find(i => i.text === t && i.y >= head.y - 15 && i.y <= head.y + below)?.x;
    const xs = { duty: X('DUTY'), flt: X('FLT NO.'), port: X('PORT'), rep: X('REPORT'), dep: X('DEP'), arv: X('ARV'), end: head.x, staff: X('STAFF NO.'), name: X('NAME'), place: X('PLACE'), event: X('EVENT') };
    const col = (i, k, tol = 12) => Math.abs(i.x - xs[k]) <= tol;
    const body = page.items.filter(i => i.y > head.y + 12 && !/PAGE$|^\/$/.test(i.text)); // not the page number ("3 / 4 PAGE")
    const lines = toLines(body, 2);
    // an entry's first line: a port, no UTC time in brackets
    const anchors = lines.filter(l => l.items.some(i => col(i, 'port', 10) && /^[A-Z]{3}$/.test(i.text)) && !l.items.some(i => /^\(/.test(i.text)));
    for (const [k, a] of anchors.entries()) {
      const next = anchors[k + 1]?.y ?? Infinity;
      const blk = lines.filter(l => l.y >= a.y && l.y < next - 2);
      const its = blk.flatMap(l => l.items);
      const at = (key, l, re, tol) => l?.items.find(i => col(i, key, tol) && (!re || re.test(i.text)));
      const dItem = a.items.find(i => i.x < 60 && DATE.test(i.text)); // (a date alone further down is a day with nothing)
      let m;
      if (dItem && (m = DATE.exec(dItem.text)) && monthIndex(m[2]) >= 0) {
        const mi = monthIndex(m[2]);
        cur = Date.UTC(y0 + (mi < m0 - 6 ? 1 : 0), mi, +m[1]);
      }
      if (cur == null) continue;
      const dutyItem = its.find(i => i.y <= a.y + 8 && col(i, 'duty', 10) && /^[A-Z0-9-]{1,4}$|^---$/.test(i.text));
      const code = dutyItem?.text || '';
      const flt = at('flt', a, /^[A-Z0-9]{2}\d{1,4}[A-Z]?$/, 14);
      const bottom = blk.find(l => l.y > a.y + 3 && l.y <= a.y + 12 && l.items.some(i => /^\(/.test(i.text)));
      const fleet = at('flt', bottom, /^\d{3}$|^[A-Z0-9]{3,4}$/, 14);
      const dep = at('port', a, /^[A-Z]{3}$/, 10), arr = flt ? at('port', bottom, /^[A-Z]{3}$/, 10) : null;
      const tm = (key) => at(key, a, TIME, 14); // ("01:10+1" starts a little left of the others)
      const [rep, dp, av, end] = ['rep', 'dep', 'arv', 'end'].map(tm);
      // the detail (place, part, event) on the entry's first line with one
      const det = blk.find(l => l.items.some(i => i.x >= xs.place - 12));
      const detItems = det ? det.items.filter(i => i.x >= xs.place - 12) : [];
      // PLACE "KZT/SIM2", the crew member's part "INSTR" (right of PLACE), EVENT
      const partX = xs.place + 30;
      const event = detItems.filter(i => i.x >= xs.event - 30).map(i => i.text).join(' ');
      const place = detItems.filter(i => i.x < partX).map(i => i.text).join(' ');
      const part = detItems.filter(i => i.x >= partX && i.x < xs.event - 30).map(i => i.text).join(' ');
      // the crew: a staff number, the name on the line after it, the crew member's duty beside the name
      const crew = [];
      const isName = (i) => i.x > xs.staff + 20 && i.x < xs.place - 20 && /[A-Z]{2,} [A-Z]/.test(i.text);
      for (const s of its.filter(i => col(i, 'staff', 8) && /^\d{4,6}$/.test(i.text) && i.text !== me)) {
        const nl = blk.find(l => l.y > s.y + 1 && l.y <= s.y + 8 && l.items.some(isName));
        const name = nl?.items.find(isName);
        const role = nl?.items.find(i => col(i, 'duty', 10)) || nl?.items.find(i => i.x >= partX && i.x < xs.event - 30);
        if (name) crew.push({ text: `[${role ? `${role.text} - ` : ''}${s.text} - ${name.text}]`, items: [role, s, name].filter(Boolean) });
      }
      // local times, "01:10+1" a day after the entry's date
      const min = (i) => (i ? (+(/\+(\d)/.exec(i.text)?.[1] || 0)) * 1440 + +i.text.slice(0, 2) * 60 + +i.text.slice(3, 5) : null);
      const first = min(rep) ?? min(dp) ?? 0;
      const d0 = Math.floor(first / 1440);
      const base = dateOf(cur + d0 * 86400000);
      const hm = (i, from) => { if (!i) return ''; let v = min(i); if (from != null && v < from) v += 1440; const d = Math.floor(v / 1440) - d0; return `${i.text.slice(0, 5)}${d > 0 ? `+${d}` : ''}`; };
      if (rep) { close(); open = { rows: [] }; open.rows.push(add({ ...base, duty: 'C/I', dep: dep?.text || '', begin: hm(rep) }, [['date', dItem], ['ci', pieceOf(rep, 0, 5)]])); }
      const duty = flt ? flt.text : code === '---' ? (event || code) : code;
      const row = add({
        ...base, duty, dc: /^DH/.test(code) ? 'DH' : '', dep: dep?.text || '', arr: arr?.text || '', begin: hm(dp), end: hm(av, min(dp)), ac: flt ? fleet?.text || '' : '',
        crew: crew.map(c => c.text).join(''),
        notes: [flt && code && !/^DH/.test(code) && `[Duty: ${code}]`, place && `[Place: ${place}]`, part && `[Part: ${part}]`, event && duty !== event && `[Event: ${event}]`].filter(Boolean),
      }, [['date', rep ? null : dItem], ['duty', flt || (code === '---' ? detItems.filter(i => i.x >= xs.event - 30) : dutyItem)], ['dep', dep], ['arr', arr], ['begin', dp && pieceOf(dp, 0, 5)], ['end', av && pieceOf(av, 0, 5)],
        ['ac', flt ? fleet : null], ['crew', crew.flatMap(c => c.items)], ['info', detItems.filter(i => duty !== event || i.x < xs.event - 30)]]);
      row.isFlight = !!flt;
      open?.rows.push(row);
      if (end) {
        open?.rows.push(add({ ...base, duty: 'C/O', arr: (arr || dep)?.text || '', end: hm(end, first) }, [['co', pieceOf(end, 0, 5)]]));
        close();
      }
    }
  }
  close();
  const out = rows.map(r => outputRow({ ...r, info: r.notes.join(' ') }, 'L'));
  return { format: 'crew-schedule-list', period: pm ? `${pm[3]}${MONTHS[+pm[2] - 1]}${pm[1].slice(2)} - ${pm[6]}${MONTHS[+pm[5] - 1]}${pm[4].slice(2)}` : null,
    notices: [], recognized: out.length > 0, published: out, planned: [], _trace: trace, _rows: rows };
}

const isMonthlyFlightProgram = (page) => page.items.some(i => /^(MONTHLY FLIGHT PROGRAM|AYLIK UCUS PROGRAMI)$/.test(i.text)) && page.items.some(i => /^Period:$/.test(i.text));
const TR_MONTHS = { OCA: 0, SUB: 1, MAR: 2, NIS: 3, MAY: 4, HAZ: 5, TEM: 6, AGU: 7, EYL: 8, EKI: 9, KAS: 10, ARA: 11 };

/**
 * Turkish Airlines "CREW PLANNING SYSTEM - MONTHLY FLIGHT PROGRAM" (or in Turkish "EKIP PLANLAMA SISTEMI - AYLIK UCUS PROGRAMI"):
 * the month as a grid, the trips in GMT, then "LOCAL TIME ROSTER DETAILS" ("LOKAL SAATLI UCUS PROGRAMI"), read here:
 *   Trip (TS/TE) | Duty: "DS: 03Jul2024 12:45" .. "DE: 04Jul2024 03:35" (GMB / GMS, "03TEM 00:00") | Value / Limit |
 *   Flight "TK6397" / an activity "CFR", "HSBY", "IBI" | Dep/LT "IST/13:45" | Arr/LT "ALG/15:15" | Cockpit "GYORGY MIKO (C1), ..."
 * Each column is stacked on its own (a duty's lines do not face its flights), so a flight goes to the duty whose
 * start and end take in its local times, in order. Rows: C/I (DS), the flights (the other cockpit crew), C/O (DE), the layover
 * ("LS/LRT: ICN/52:10": a hotel row, "[Layover: 52:10]"); an activity a row of its own.
 */
function parseMonthlyFlightProgram(pages) {
  const trace = startTrace();
  const rows = [];
  const all = pages.flatMap(p => p.items);
  const mon = (s) => { const m = String(s).toUpperCase(); return monthIndex(m) >= 0 ? monthIndex(m) : (TR_MONTHS[m] ?? -1); };
  const printed = all.map(i => /^Printed (\d{2})([A-Z]{3})(\d{4})/.exec(i.text)).find(Boolean);
  const pText = all.find((i, k, a) => a[k - 1]?.text === 'Period:' || (/^\d{2}[A-Za-z]{3}(\d{4})? - \d{2}[A-Za-z]{3}(\d{4})?$/.test(i.text) && i.y < 60))?.text || '';
  const pm = /^(\d{2})([A-Za-z]{3})(\d{4})? - (\d{2})([A-Za-z]{3})(\d{4})?$/.exec(pText);
  // the year: the period's, else the year it was printed in (a period early next year when printed late in the year)
  const yearOf = (mi) => (pm?.[3] ? +pm[3] + (mi < mon(pm[2]) ? 1 : 0) : printed ? +printed[3] + (mi < mon(printed[2]) - 6 ? 1 : 0) : new Date().getUTCFullYear());
  const stamp = (s) => {
    const m = /^(\d{2})([A-Za-z]{3})(\d{4})? (\d{1,2}):(\d{2})$/.exec(s || '');
    const mi = m ? mon(m[2]) : -1;
    return mi >= 0 ? Date.UTC(m[3] ? +m[3] : yearOf(mi), mi, +m[1], +m[4], +m[5]) : null;
  };
  // the crew member: the name under the staff number at the top ("069210" / "MIKO" / "GYORGY")
  const idItem = pages[0].items.find(i => /^\d{5,6}$/.test(i.text) && i.x < 140 && i.y < 140);
  const meWords = new Set(pages[0].items.filter(i => idItem && i.x < 140 && i.y > idItem.y + 3 && i.y < idItem.y + 30 && /^[A-Z]+$/.test(i.text)).map(i => i.text));
  const duties = [], entries = [], layovers = [];
  let inLocal = false;
  for (const page of pages) {
    const marker = page.items.find(i => /^(LOCAL TIME ROSTER DETAILS|LOKAL SAATLI UCUS PROGRAMI)$/.test(i.text));
    if (marker) inLocal = true;
    const fHead = page.items.find(i => /^(Flight|Ucus)$/.test(i.text) && page.items.some(j => /\/LT$/.test(j.text) && Math.abs(j.y - i.y) < 3));
    if (!inLocal || !fHead) continue;
    const cHead = page.items.find(i => /^(Cockpit|Kokpit)$/.test(i.text) && Math.abs(i.y - fHead.y) < 3);
    const body = page.items.filter(i => i.y > fHead.y + 5 && !/^Printed /.test(i.text));
    const right = (it, re) => body.find(j => Math.abs(j.y - it.y) < 2 && j.x > it.x && j.x < it.x + 60 && re.test(j.text));
    for (const it of body) {
      if (/^(DS|GMB):$/.test(it.text) || /^(DE|GMS):$/.test(it.text)) {
        const v = right(it, /^\d{2}[A-Za-z]{3}(\d{4})? \d{1,2}:\d{2}$/);
        const t = v && stamp(v.text);
        if (t == null) continue;
        if (/^(DS|GMB)/.test(it.text)) duties.push({ start: t, startItem: v, page: page.page, y: it.y, entries: [] });
        else { const d = [...duties].reverse().find(x => x.end == null && x.page === page.page && x.y <= it.y + 1) || duties.at(-1); if (d && d.end == null) { d.end = t; d.endItem = v; } }
      }
      if (/^(LS\/LRT|YI\/YDS):$/.test(it.text)) {
        const v = right(it, /^[A-Z]{3}\/\d{1,3}:\d{2}$/);
        if (v) layovers.push({ page: page.page, y: it.y, item: v });
      }
    }
    // the flight column: a flight number or an activity code, its stations and times to the right, the crew after them
    const crewX = cHead ? cHead.x - 40 : Infinity;
    const lineOf = (e) => body.filter(j => Math.abs(j.y - e.y) < 2 && j.x > e.x + 5).sort((a, b) => a.x - b.x);
    const codes = body.filter(i => Math.abs(i.x - fHead.x) < 10 && /^[A-Z0-9]{2,7}$/.test(i.text) && lineOf(i).some(j => /\d{1,2}:\d{2}/.test(j.text)));
    for (const c of codes) entries.push({ page: page.page, y: c.y, code: c, parts: lineOf(c), crewItems: [] });
    // crew lines of their own ("KUTAY" / "AYVALI (P6)"): with the nearest flight
    const pageEntries = entries.filter(e => e.page === page.page);
    for (const it of body.filter(i => i.x >= crewX && !codes.some(c => Math.abs(c.y - i.y) < 2) && /[A-Z]{2,}/.test(i.text))) {
      const e = pageEntries.reduce((b, x) => (!b || Math.abs(x.y - it.y) < Math.abs(b.y - it.y) ? x : b), null);
      if (e && Math.abs(e.y - it.y) < 14) e.crewItems.push(it);
    }
  }
  duties.sort((a, b) => a.start - b.start);
  // each entry into the duty whose times take it in, in order
  let k = 0, last = -Infinity;
  const at = (from, hh, mm) => { const d = new Date(from); let t = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), hh, mm); if (t < from) t += 86400000; return t; };
  for (const e of entries.sort((a, b) => a.page - b.page || a.y - b.y)) {
    const text = e.parts.map(p => p.text).join(' ');
    const legs = [...text.matchAll(/([A-Z]{3})\/(\d{1,2}):(\d{2})/g)];
    const times = legs.length ? legs.map(m => [+m[2], +m[3]]) : [...text.matchAll(/(\d{1,2}):(\d{2})/g)].slice(0, 2).map(m => [+m[1], +m[2]]);
    if (!times.length) continue;
    while (k < duties.length) {
      const d = duties[k];
      const dep = at(Math.max(d.start, last), ...times[0]);
      if (d.end == null || dep <= d.end) { e.dep = dep; break; }
      k += 1; last = -Infinity;
    }
    if (k >= duties.length) break;
    e.arr = times[1] ? at(e.dep, ...times[1]) : null;
    last = e.arr ?? e.dep;
    e.legs = legs;
    const crewText = [text.slice(legs.length ? legs.at(-1).index + legs.at(-1)[0].length : 0).replace(/^\s*(\d{1,2}:\d{2}\s*)*/, ''), ...e.crewItems.sort((a, b) => a.y - b.y).map(i => i.text)].join(' ').replace(/^\s*-\s*$/, '').trim();
    e.crew = [...crewText.matchAll(/([A-Z][A-Z .'-]*?) \(([A-Z]\d)\)/g)].map(m => ({ name: m[1].trim(), role: m[2] }))
      .filter(c => !(meWords.size && c.name.split(' ').every(w => meWords.has(w))));
    duties[k].entries.push(e);
  }
  const hm = (t) => { const d = new Date(t); return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`; };
  const day = (t) => Math.floor(t / 86400000);
  const end = (t, from) => (t == null ? '' : `${hm(t)}${day(t) > day(from) ? `+${day(t) - day(from)}` : ''}`);
  const add = (r, marks) => { const row = { notes: [], ...r }; rows.push(row); for (const [f, it] of marks) if (it && [].concat(it).length) mark(row, f, it); return row; };
  for (const d of duties) {
    const flights = d.entries.filter(e => /^[A-Z0-9]{2}\d{1,4}[A-Z]?$/.test(e.code.text));
    if (flights.length) add({ ...dateOf(d.start), duty: 'C/I', dep: flights[0].legs[0]?.[1] || '', begin: hm(d.start) }, [['date', pieceOf(d.startItem, 0, d.startItem.text.indexOf(' '))], ['ci', pieceOf(d.startItem, d.startItem.text.indexOf(' ') + 1, 5)]]);
    for (const e of d.entries) {
      const [dep, arr] = [e.legs[0]?.[1] || '', e.legs[1]?.[1] || ''];
      add({ ...dateOf(e.dep), duty: e.code.text, dep, arr: arr && arr !== dep ? arr : '', begin: hm(e.dep), end: end(e.arr, e.dep), crew: e.crew.map(c => `[${c.role} - ${c.name}]`).join('') },
        [['duty', e.code], ['dep', e.parts[0]], ['crew', e.crewItems]]);
    }
    if (flights.length && d.end != null) {
      const lastF = flights.at(-1);
      add({ ...dateOf(lastF.dep), duty: 'C/O', arr: lastF.legs[1]?.[1] || '', end: end(d.end, lastF.dep) }, [['co', pieceOf(d.endItem, d.endItem.text.indexOf(' ') + 1, 5)]]);
      // the layover printed in this duty's lines (up to the next duty's start)
      const next = duties.find(x => x.page > d.page || (x.page === d.page && x.y > d.y));
      const lo = layovers.find(l => (l.page > d.page || (l.page === d.page && l.y > d.y)) && (!next || l.page < next.page || (l.page === next.page && l.y < next.y)));
      if (lo) { const [st, rest] = lo.item.text.split('/'); add({ ...dateOf(lastF.dep), duty: 'H', dep: st, notes: [`[Layover: ${rest}]`] }, [['dep', pieceOf(lo.item, 0, 3)], ['info', pieceOf(lo.item, 4, rest.length)]]); }
    }
  }
  const out = rows.map(r => outputRow({ ...r, info: r.notes.join(' ') }, 'L'));
  const fmt = (dd, m, y) => `${dd}${MONTHS[mon(m)]}${String(y ?? yearOf(mon(m))).slice(-2)}`;
  return { format: 'monthly-flight-program', period: pm ? `${fmt(pm[1], pm[2], pm[3])} - ${fmt(pm[4], pm[5], pm[6])}` : null,
    notices: [], recognized: out.length > 0, published: out, planned: [], _trace: trace, _rows: rows };
}

const isNumberedLogbook = (page) => ['AIRCRAFT', 'DEPARTURE', 'ARRIVAL', 'SYNTHETIC DEVICES'].every(t => page.items.some(i => i.text === t)) && page.items.some(i => i.text === 'Regist');

/**
 * A pilot logbook with numbered columns (Turkish Airlines; "072905 JURGEN ... 14/07/2024 15:20" above it):
 *   1 Date | 2 AIRCRAFT Type, Registration | 3 DEPARTURE Place, Time | 4 ARRIVAL Place, Time | 5 SINGLE PILOT SE, ME | Multi Pilot |
 *   Total Time | Name of PIC | 9 LANDING Day, Night | 10 OPERATION CONDITION Night, IFR | 11 PILOT FUNCTION PIC, Co-Pilot, Dual |
 *   Instructor | 13 SYNTHETIC DEVICES Date, Type, Time | 14 Remarks and Endorsements
 * Rows: a flight (no number; "[Flight: total]", night / IFR / function times as tags), a simulator line (its place and times
 * with the synthetic device's date and time: "SIM", "[Sim: 04:00]"). Times taken as UTC, as logbooks keep them.
 */
function parseNumberedLogbook(pages) {
  const trace = startTrace();
  const rows = [];
  const NAMES = { Date: ['date'], Type: ['ac'], Regist: ['reg'], 'Dep.': ['depPlace', 'depTime'], 'Arr.': ['arrPlace', 'arrTime'], SE: ['se'], ME: ['me'], Multi: ['multi'],
    Total: ['total'], 'Name of': ['pic'], Landing: ['ldgDay', 'ldgNight'], Operation: ['night', 'ifr'], Function: ['fPic', 'fCo', 'fDual'], Instr: ['instructor'],
    'STDS (Date)': ['simDate'], STDS: ['simType', 'simTime'], Remarks: ['remark'] };
  const DATE = /^(\d{2})\/(\d{2})\/(\d{4})$/;
  const dur = (t) => (/^\d{1,3}:\d{2}$/.test(t || '') && /[1-9]/.test(t) ? t : '');
  let first = null, last = null;
  for (const page of pages) {
    const head = page.items.find(i => i.text === 'Regist');
    if (!head) continue;
    const seen = {};
    const cols = page.items.filter(i => Math.abs(i.y - head.y) < 3).sort((a, b) => a.x - b.x)
      .map(i => { const n = seen[i.text] = (seen[i.text] || 0) + 1; return { name: NAMES[i.text]?.[n - 1] || i.text, x: i.x }; });
    const nearest = (x) => cols.reduce((a, c) => (Math.abs(c.x - x) < Math.abs(a.x - x) ? c : a)).name;
    // a line without a date holds the wrapped ends of the cells above ("O" / "7M")
    const lines = [];
    for (const line of toLines(page.items.filter(i => i.y > head.y + 15), 2)) {
      if (lines.length && !line.items.some(i => DATE.test(i.text)) && line.y - lines.at(-1).y < 12) lines.at(-1).items.push(...line.items); else lines.push(line);
    }
    for (const line of lines) {
      const cell = {};
      for (const it of line.items) (cell[nearest(it.x)] ||= []).push(it);
      const get = (c) => (cell[c] || []).map(i => i.text).join(c === 'ac' ? '' : ' ').trim();
      // (the line's number stands left of its date)
      cell.date = (cell.date || []).filter(i => DATE.test(i.text));
      const m = DATE.exec(get('date'));
      if (!m) continue;
      const t = Date.UTC(+m[3], +m[2] - 1, +m[1]);
      const plus = get('arrTime') && get('arrTime') < get('depTime') ? '+1' : '';
      const sim = dur(get('simTime'));
      const tag = (k, c) => { const v = dur(get(c)); return v && `[${k}: ${v}]`; };
      const r = {
        ...dateOf(t), duty: sim && !get('ac') ? 'SIM' : '', dep: get('depPlace'), arr: get('arrPlace') !== get('depPlace') || !sim ? get('arrPlace') : '', begin: get('depTime'),
        end: get('arrTime') ? `${get('arrTime')}${plus}` : '', ac: get('ac'), registration: get('reg'), crew: get('pic') ? `[PIC - ${get('pic')}]` : '',
        notes: [sim && `[Sim: ${sim}]`, tag('Flight', 'total'), ...[['Landing Day', 'ldgDay'], ['Landing Night', 'ldgNight']].filter(([, c]) => /^[1-9]\d*$/.test(get(c))).map(([k, c]) => `[${k}: ${get(c)}]`),
          tag('Night', 'night'), tag('IFR', 'ifr'), tag('PIC', 'fPic'), tag('CoPilot', 'fCo'), tag('Dual', 'fDual'), tag('Instructor', 'instructor'), get('remark')].filter(Boolean),
      };
      rows.push(r);
      for (const [f, c] of [['date', 'date'], ['dep', 'depPlace'], ['begin', 'depTime'], ['arr', 'arrPlace'], ['end', 'arrTime'], ['ac', 'ac'], ['registration', 'reg'], ['crew', 'pic'],
        ['info', 'simTime'], ['info', 'total'], ['info', 'night'], ['info', 'ifr'], ['info', 'fPic'], ['info', 'fCo'], ['info', 'fDual'], ['info', 'instructor'], ['info', 'remark']]) mark(r, f, cell[c]);
      first ??= t; last = t;
    }
  }
  const fmt = (t) => { const x = new Date(t); return `${String(x.getUTCDate()).padStart(2, '0')}${MONTHS[x.getUTCMonth()]}${String(x.getUTCFullYear() % 100).padStart(2, '0')}`; };
  const out = rows.map(r => outputRow({ ...r, info: r.notes.join(' ') }, 'Z'));
  return { format: 'numbered-logbook', period: first != null ? `${fmt(first)} - ${fmt(last)}` : null, notices: [], recognized: out.length > 0, published: out, planned: [], _trace: trace, _rows: rows };
}

const isRulerLogbook = (page) => page.items.some(i => /^(Merged Logbook Records - from|Log Book record of Flight Duties from) /.test(i.text)) && page.items.some(i => /^Off-Blk/.test(i.text));
const RULER_COLS = ['date', 'flt', 'sector', 'reg', 'block', 'off', 'air', 'land', 'on', 'to', 'ld', 'auto', 'commander', 'ac', 'catg', 'training'];

/**
 * A logbook printed as fixed-width text (Cathay Pacific: "Merged Logbook Records - from 2025-04-01 to 2025-07-01", "Log Book record of
 * Flight Duties from ..."), its columns marked by a ruler of dashes under the header:
 *   Date(UTC) | Flt No. | Sector "HKG LHR" | Reg | Block Time | UTC Off-Blk | Airborne | Landing | On-Blk | Take Off | Land | Auto Land |
 *   Commander | AC Type | Catg | Training Type
 * A row per flight (UTC; "05:39+1" / "16:26-1" a day after / before the date): block off / on as begin / end, airborne / landing as
 * take-off / landing, "[Block: 14:23] [Takeoff Day/Night: 1] [Landing Day/Night: 1]", "[Commander - HUI WAI YAN C]".
 */
function parseRulerLogbook(pages) {
  const trace = startTrace();
  const rows = [];
  const DATE = /^(\d{4})\/(\d{2})\/(\d{2})$/;
  for (const page of pages) {
    const lines = toLines(page.items, 2);
    const ruler = lines.find(l => l.items.length >= 8 && l.items.every(i => /^-+$/.test(i.text)));
    if (!ruler) continue;
    const xs = ruler.items.map(i => i.x);
    for (const l of lines.filter(x => x.y > ruler.y && DATE.test(x.items[0].text))) {
      // (the data may stand left of the ruler by a few characters: the shift of the date column)
      const shift = l.items[0].x - xs[0];
      const cell = {};
      const rest = [];
      for (const it of l.items) {
        const k = xs.reduce((b, x, j) => (it.x - shift >= x - 8 ? j : b), 0);
        if (k < RULER_COLS.indexOf('on') || (k === RULER_COLS.indexOf('on') && /^\d{2}:\d{2}/.test(it.text))) (cell[RULER_COLS[k]] ||= []).push(it); else rest.push(it);
      }
      // the counts and names after On-Blk do not keep to the ruler in every print: in their order (take-offs, landings, autoland Y/N,
      // the commander, the aircraft type ...)
      for (const it of rest) {
        const k = /^\d+$/.test(it.text) && !cell.to ? 'to' : /^\d+$/.test(it.text) && !cell.ld ? 'ld' : /^[YN]$/.test(it.text) && !cell.auto ? 'auto'
          : RULER_COLS.slice(RULER_COLS.indexOf('commander')).find(c => !cell[c]);
        if (k) cell[k] = [it];
      }
      const get = (k) => (cell[k] || []).map(i => i.text).join(' ');
      const [, y, mo, d] = DATE.exec(get('date'));
      const sec = /^([A-Z]{3}) ([A-Z]{3})$/.exec(get('sector'));
      const t = (k) => (/^\d{2}:\d{2}([+-]\d)?$/.test(get(k)) ? get(k) : '');
      const n = (k) => (/^[1-9]\d*$/.test(get(k)) ? +get(k) : 0);
      const row = {
        ...dateOf(Date.UTC(+y, +mo - 1, +d)), duty: get('flt'), registration: get('reg'), dep: sec?.[1] || '', arr: sec?.[2] || '',
        begin: t('off'), takeoff: t('air'), landing: t('land'), end: t('on'), ac: get('ac'), crew: get('commander') ? `[Commander - ${get('commander')}]` : '',
        notes: [/^\d{2}:\d{2}$/.test(get('block')) && /[1-9]/.test(get('block')) && `[Block: ${get('block')}]`, n('to') && `[Takeoff Day/Night: ${n('to')}]`, n('ld') && `[Landing Day/Night: ${n('ld')}]`,
          /^Y/.test(get('auto')) && '[Autoland: Y]', get('catg') && `[Catg: ${get('catg')}]`, get('training')].filter(Boolean),
      };
      rows.push(row);
      for (const [f, k] of [['date', 'date'], ['duty', 'flt'], ['registration', 'reg'], ['dep', 'sector'], ['begin', 'off'], ['takeoff', 'air'], ['landing', 'land'], ['end', 'on'], ['ac', 'ac'], ['crew', 'commander'],
        ['info', 'block'], ['info', 'to'], ['info', 'ld']]) mark(row, f, cell[k]);
    }
  }
  const head = pages.flatMap(p => p.items).map(i => /from (\d{4})-(\d{2})-(\d{2}) to (\d{4})-(\d{2})-(\d{2})/.exec(i.text)).find(Boolean);
  const out = rows.map(r => outputRow({ ...r, info: r.notes.join(' ') }, 'Z'));
  return { format: 'ruler-logbook', period: head ? `${head[3]}${MONTHS[+head[2] - 1]}${head[1].slice(2)} - ${head[6]}${MONTHS[+head[5] - 1]}${head[4].slice(2)}` : null,
    notices: [], recognized: out.length > 0, published: out, planned: [], _trace: trace, _rows: rows };
}

const isAcknowledgedRoster = (page) => page.items.some(i => i.text === 'Acknowledged Roster') && page.items.some(i => i.text === 'Date (LT)') && page.items.some(i => i.text === 'Start (UTC)');
const ACK_COLS = [['Trip ID', 'trip'], ['Report (LT)', 'report'], ['Pos', 'pos'], ['Activity', 'act'], ['From', 'dep'], ['To', 'arr'], ['Start (UTC)', 'start'], ['End (UTC)', 'end'],
  ['A/C', 'ac'], ['Layover', 'layover'], ['Timezone', 'tz'], ['LSW', 'lsw'], ['BZW', 'bzw'], ['Tags', 'tags'], ['Blocktime', 'block'], ['FDP', 'fdp']];

/**
 * Lufthansa "Acknowledged Roster" (Jeppesen; "Month: March 2026"): the month as a grid of days, then a line per event:
 *   Date (LT) "21 Sat" | Trip ID | Report (LT) | Pos | Activity "412" / "RES" | From | To | Start (UTC) | End (UTC) "(22) 00:05" (another
 *   day of the month) | A/C | Layover "24:15" | Timezone Difference | LSW | BZW | Tags | Blocktime | FDP ... rest times
 * A flight over midnight may print its departure on one day's line and its arrival on the next ("22 Sun 20:50 FO 413 EWR (23) 01:50",
 * "23 Mon FO 413 MUC 09:25"): one row. Rows: C/I (Report, local), the flights (UTC, "[Block: 08:55]"), a hotel row after a leg with
 * a layover ("[Layover: 24:15]"); an activity with its station and times. "Layover: CPT" lines are the nights already given.
 */
function parseAcknowledgedRoster(pages) {
  const trace = startTrace();
  const rows = [];
  const all = pages.flatMap(p => p.items);
  const mm = /^([A-Z][a-z]+) (\d{4})$/.exec(all.find((i, k, a) => a[k - 1]?.text === 'Month:')?.text || all.find(i => /^[A-Z][a-z]+ \d{4}$/.test(i.text) && monthIndex(i.text.slice(0, 3)) >= 0)?.text || '');
  const mi = mm ? monthIndex(mm[1].slice(0, 3)) : -1, year = mm ? +mm[2] : new Date().getUTCFullYear();
  const DAY = /^(\d{2}) (Mon|Tue|Wed|Thu|Fri|Sat|Sun)$/;
  const add = (r, marks) => { const row = { notes: [], ...r }; rows.push(row); for (const [f, it] of marks) if (it && [].concat(it).length) mark(row, f, it); return row; };
  let cur = null, lastFlight = null;
  for (const page of pages) {
    const head = page.items.find(i => i.text === 'Date (LT)');
    if (!head || mi < 0) continue;
    const hl = page.items.filter(i => Math.abs(i.y - head.y) < 3);
    const cols = ACK_COLS.map(([t, k]) => ({ k, x: hl.find(i => i.text === t)?.x })).filter(c => c.x != null).sort((a, b) => a.x - b.x);
    const colOf = (i) => cols.reduce((b, c) => (c.x <= i.x + 12 ? c.k : b), 'date');
    const end = page.items.find(i => /^Created .* by /.test(i.text))?.y ?? Infinity;
    for (const l of toLines(page.items.filter(i => i.y > head.y + 45 && i.y < end), 2)) {
      const dItem = l.items.find(i => DAY.test(i.text) && i.x < head.x + 20);
      if (dItem) cur = Date.UTC(year, mi, +DAY.exec(dItem.text)[1]);
      if (cur == null) continue;
      const cell = {};
      for (const it of l.items.filter(i => i !== dItem)) (cell[colOf(it)] ||= []).push(it);
      const get = (k) => (cell[k] || []).map(i => i.text).join(' ');
      const act = get('act');
      if (!act || /^Layover:/.test(l.items.map(i => i.text).join(' '))) continue;
      // "(22) 00:05": a time on another day of the month than the line's
      const stamp = (k) => {
        const m = /^(?:\((\d{1,2})\) )?(\d{2}:\d{2})$/.exec(get(k));
        if (!m) return null;
        let t = cur;
        if (m[1]) { t = Date.UTC(year, mi, +m[1]); if (t < cur - 15 * 86400000) t = Date.UTC(year, mi + 1, +m[1]); }
        return { t, hhmm: m[2], item: (cell[k] || []).at(-1) };
      };
      const s = stamp('start'), e = stamp('end');
      const plus = (x, from) => (x && from && x.t > from.t ? ` +${Math.round((x.t - from.t) / 86400000)}` : '');
      const hm = (x, from) => (x ? `${x.hhmm}${plus(x, from)}`.replace(' +', '+') : '');
      const flight = /^\d{1,4}[A-Z]?$/.test(act);
      // the arrival of the flight on the line before
      if (flight && lastFlight && lastFlight.duty === act && !lastFlight.arr && !get('dep')) {
        Object.assign(lastFlight, { arr: get('arr'), end: hm(e, lastFlight._s) });
        mark(lastFlight, 'arr', cell.arr); mark(lastFlight, 'end', e?.item);
        if (get('block') && /[1-9]/.test(get('block'))) lastFlight.notes.push(`[Block: ${get('block')}]`);
        if (/[1-9]/.test(get('layover'))) add({ ...dateOf(lastFlight._s?.t ?? cur), duty: 'H', dep: get('arr'), notes: [`[Layover: ${get('layover')}]`] }, [['info', cell.layover]]);
        lastFlight = null;
        continue;
      }
      const report = /^\d{2}:\d{2}$/.test(get('report')) ? cell.report[0] : null;
      if (report) add({ ...dateOf(cur), duty: 'C/I', dep: get('dep'), begin: `!${report.text}` }, [['date', dItem], ['ci', report]]);
      const base = s || { t: cur };
      const row = add({
        ...dateOf(base.t), duty: act, dep: get('dep'), arr: flight || get('arr') !== get('dep') ? get('arr') : '', begin: s?.hhmm || '', end: hm(e, base), ac: get('ac'),
        notes: flight ? [get('block') && /[1-9]/.test(get('block')) && `[Block: ${get('block')}]`, get('pos') && `[Pos: ${get('pos')}]`].filter(Boolean) : [],
      }, [['date', report ? null : dItem], ['duty', cell.act], ['dep', cell.dep], ['arr', cell.arr], ['begin', s?.item], ['end', e?.item], ['ac', cell.ac], ['info', flight ? [...(cell.block || []), ...(cell.pos || [])] : null]]);
      row._s = s;
      lastFlight = flight && !get('arr') ? row : null;
      if (flight && get('arr') && /[1-9]/.test(get('layover'))) add({ ...dateOf(base.t), duty: 'H', dep: get('arr'), notes: [`[Layover: ${get('layover')}]`] }, [['info', cell.layover]]);
    }
  }
  const out = rows.map(r => outputRow({ ...r, info: r.notes.join(' ') }, 'Z'));
  const last = mi >= 0 ? new Date(Date.UTC(year, mi + 1, 0)).getUTCDate() : 0;
  return { format: 'acknowledged-roster', period: mi >= 0 ? `01${MONTHS[mi]}${String(year).slice(2)} - ${last}${MONTHS[mi]}${String(year).slice(2)}` : null,
    notices: [], recognized: out.length > 0, published: out, planned: [], _trace: trace, _rows: rows };
}

const isCrewBriefing = (page) => page.items.some(i => i.text === 'Crew Briefing') && page.items.some(i => i.text === 'Duty Detail') && page.items.some(i => /^Timed Mode:$/.test(i.text));

/**
 * "Crew Briefing" (Cebu Pacific; "Timed Mode: Local"), a block per duty:
 *   "Duty : 2P2043/2P2044/..." / "02-Jul-2026 14:20(L) ~ 03-Jul-2026 01:10(L)" (the duty's start and end), "Duty Detail", then per flight
 *   Assignment | Flight No. | DEP | ARR | STD | STA | Acting | Reg No. | Fleet | Conx, its Block / Pax / Cred Hours and crew lines
 *   "CP : Singh Shah,Shamsher/100872/MNL/FLY  FO : Ampong,Alfe/103273/MNL/FLY"; a day off: Assignment | Location | Date | Start Time | End Time
 * Rows: C/I (the duty's start), the flights ("[Block: 1:00]", the other crew "[FO - 103273 - Ampong,Alfe]"), C/O (the duty's end);
 * a day's assignment (DOFF) with its times. Local times.
 */
function parseCrewBriefing(pages) {
  const trace = startTrace();
  const rows = [];
  const all = pages.flatMap(p => p.items);
  const me = all.find(i => i.y < 70 && /,/.test(i.text) && !/:/.test(i.text))?.text?.trim();
  const zone = all.some(i => i.text === 'UTC' || i.text === 'GMT') ? 'Z' : 'L';
  const STAMP = /(\d{2})-([A-Z][a-z]{2})-(\d{4}) (\d{2}):(\d{2})\(L\) ~ (\d{2})-([A-Z][a-z]{2})-(\d{4}) (\d{2}):(\d{2})\(L\)/;
  const day = (d, m, y) => Date.UTC(+y, monthIndex(m), +d);
  const add = (r, marks) => { const row = { notes: [], ...r }; rows.push(row); for (const [f, it] of marks) if (it && [].concat(it).length) mark(row, f, it); return row; };
  // the stream of lines over all pages
  const lines = pages.flatMap(p => toLines(p.items, 2).map(l => ({ ...l, page: p.page })));
  let duty = null; // { start, end, startItem, flights: [] }
  const close = () => {
    if (duty?.flights.length && duty.end) {
      const last = duty.flights.at(-1);
      const d0 = Math.floor(last.t / 86400000);
      const dd = Math.floor(duty.end.t / 86400000) - d0;
      add({ ...dateOf(last.t), duty: 'C/O', arr: last.arr, end: `${duty.end.hhmm}${dd > 0 ? `+${dd}` : ''}` }, [['co', duty.endItem]]);
    }
    duty = null;
  };
  for (const [k, l] of lines.entries()) {
    const text = l.items.map(i => i.text).join(' ');
    const head = l.items.find(i => /^Duty : /.test(i.text));
    if (head) {
      close();
      // the duty's start and end, on the line below its name
      const sl = lines.slice(k, k + 3).find(x => x.items.some(i => STAMP.test(i.text)));
      const si = sl?.items.find(i => STAMP.test(i.text));
      const m = si && STAMP.exec(si.text);
      duty = { flights: [], start: m && { t: day(m[1], m[2], m[3]), hhmm: `${m[4]}:${m[5]}` }, end: m && { t: day(m[6], m[7], m[8]) + (+m[9] * 60 + +m[10]) * 60000, hhmm: `${m[9]}:${m[10]}` },
        startItem: si && pieceOf(si, 12, 5), endItem: si && pieceOf(si, si.text.indexOf('~') + 14, 5), ciDone: false };
      continue;
    }
    if (!duty?.start) continue;
    // a flight: FLY | 2P2043 | MNL | MPH | 15:50 | 16:55 | CP | RP-C8933 | 320 | 0:50
    const fl = l.items.find(i => /^[A-Z0-9]{2}\d{1,4}[A-Z]?$/.test(i.text) && i.x > 80 && i.x < 140);
    const st = l.items.filter(i => /^[A-Z]{3}$/.test(i.text) && i.x > 150 && i.x < 250);
    const tm = l.items.filter(i => /^\d{2}:\d{2}$/.test(i.text) && i.x > 250 && i.x < 350);
    if (fl && st.length === 2 && tm.length === 2) {
      // its date: the duty's start day, a day on when its time is earlier than the duty's start or the leg before
      const mins = (t) => +t.slice(0, 2) * 60 + +t.slice(3);
      const prev = duty.flights.at(-1);
      let t = duty.start.t + mins(tm[0].text) * 60000;
      while (t < (prev ? prev.arrT : duty.start.t + mins(duty.start.hhmm) * 60000 - 3600000)) t += 86400000;
      let arrT = Math.floor(t / 86400000) * 86400000 + mins(tm[1].text) * 60000;
      while (arrT < t) arrT += 86400000;
      if (!duty.ciDone) { add({ ...dateOf(duty.start.t), duty: 'C/I', dep: st[0].text, begin: duty.start.hhmm }, [['ci', duty.startItem]]); duty.ciDone = true; }
      const acting = l.items.find(i => i.x > 360 && i.x < 400), reg = l.items.find(i => i.x > 405 && i.x < 470), fleet = l.items.find(i => i.x > 470 && i.x < 530);
      // the block hours two lines down, the crew after them (up to the next flight's header)
      const after = lines.slice(k + 1, k + 9);
      const stop = after.findIndex(x => x.items.some(i => i.text === 'Assignment' || /^Duty : /.test(i.text)));
      const below = stop < 0 ? after : after.slice(0, stop);
      const blk = below.find(x => x.items.some(i => i.text === 'Block Hours'));
      const blkItem = blk && below[below.indexOf(blk) + 1]?.items.find(i => i.x < 80 && /^\d{1,2}:\d{2}$/.test(i.text));
      const crewItems = below.flatMap(x => x.items).filter(i => /^\S+ : .+\/\d+\//.test(i.text));
      const crew = crewItems.map(i => /^(\S+) : (.+?)\/(\d+)\//.exec(i.text)).filter(m => m && m[2] !== me).map(m => `[${m[1] === '-' ? 'Crew' : m[1]} - ${m[3]} - ${m[2]}]`).join('');
      const row = add({ ...dateOf(t), duty: fl.text, dep: st[0].text, arr: st[1].text, begin: tm[0].text, end: `${tm[1].text}${Math.floor(arrT / 86400000) > Math.floor(t / 86400000) ? '+1' : ''}`,
        registration: reg?.text || '', ac: fleet?.text || '', crew,
        notes: [acting && `[Acting: ${acting.text}]`, blkItem && /[1-9]/.test(blkItem.text) && `[Block: ${blkItem.text}]`].filter(Boolean) },
      [['duty', fl], ['dep', st[0]], ['arr', st[1]], ['begin', tm[0]], ['end', tm[1]], ['registration', reg], ['ac', fleet], ['info', [acting, blkItem].filter(Boolean)], ['crew', crewItems]]);
      duty.flights.push({ t, arrT, arr: st[1].text, row });
      continue;
    }
    // a day's assignment: DOFF | MNL | 01-Jul-2026 | 00:00 | 23:59
    const dm = /^([A-Z0-9_]{2,8}) ([A-Z]{3}) (\d{2})-([A-Z][a-z]{2})-(\d{4}) (\d{2}:\d{2}) (\d{2}:\d{2})/.exec(text);
    if (dm && !duty.flights.length) {
      add({ ...dateOf(day(dm[3], dm[4], dm[5])), duty: dm[1], dep: dm[2], begin: dm[6], end: `${dm[7]}${dm[7] < dm[6] ? '+1' : ''}` }, [['date', l.items[2]], ['duty', l.items[0]], ['dep', l.items[1]], ['begin', l.items[3]], ['end', l.items[4]]]);
    }
  }
  close();
  const out = rows.map(r => outputRow({ ...r, info: r.notes.join(' ') }, zone));
  const fmt = (s) => { const [d, m, y] = s.split(' '); return `${d.padStart(2, '0')}${m}${y}`; };
  return { format: 'crew-briefing', period: rows.length ? `${fmt(rows[0].date)} - ${fmt(rows.at(-1).date)}` : null, notices: [], recognized: out.length > 0, published: out, planned: [], _trace: trace, _rows: rows };
}

const isLegalBrLogbook = (page) => page.items.some(i => /^LOGBOOK - /.test(i.text)) && ['Flight', 'Dep', 'Arr', 'Reg', 'Out Z', 'In Z', 'Block Time'].every(t => page.items.some(i => i.text === t));

/**
 * LATAM "LEGAL_BR_Logbook" (Looker; "LOGBOOK - LATAM Airlines"): Flight | Dep | Arr | Reg | Aircraft | Function | Vim Date "2024-06-04" |
 * Out Z | In Z | Day Time | Night Time | Block Time. A row per flight (UTC, "+1" when In is earlier than Out), "[Function: PIC]
 * [Day: 01:05] [Night: 00:40] [Block: 01:08]" (zeros left out).
 */
function parseLegalBrLogbook(pages) {
  const trace = startTrace();
  const rows = [];
  const NAMES = { Flight: 'flight', Dep: 'dep', Arr: 'arr', Reg: 'reg', Aircraft: 'ac', Function: 'fn', 'Vim Date': 'date', 'Out Z': 'out', 'In Z': 'in', 'Day Time': 'day', 'Night Time': 'night', 'Block Time': 'block' };
  for (const page of pages) {
    const head = page.items.find(i => i.text === 'Out Z');
    if (!head) continue;
    const cols = page.items.filter(i => Math.abs(i.y - head.y) < 3 && NAMES[i.text]).map(i => ({ k: NAMES[i.text], x: i.x }));
    const colOf = (i) => cols.reduce((b, c) => (Math.abs(c.x - i.x) < Math.abs(b.x - i.x) ? c : b)).k;
    for (const l of toLines(page.items.filter(i => i.y > head.y + 5), 2)) {
      const cell = {};
      for (const it of l.items) (cell[colOf(it)] ||= []).push(it);
      const get = (k) => (cell[k] || []).map(i => i.text).join(' ');
      const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(get('date'));
      if (!m || !/^[A-Z]{3}$/.test(get('dep'))) continue;
      const dur = (k) => (/^\d{2}:\d{2}$/.test(get(k)) && /[1-9]/.test(get(k)) ? get(k) : '');
      const row = {
        ...dateOf(Date.UTC(+m[1], +m[2] - 1, +m[3])), duty: get('flight'), dep: get('dep'), arr: get('arr'), registration: get('reg'), ac: get('ac'),
        begin: get('out'), end: get('in') ? `${get('in')}${get('in') < get('out') ? '+1' : ''}` : '',
        notes: [get('fn') && `[Function: ${get('fn')}]`, dur('day') && `[Day: ${dur('day')}]`, dur('night') && `[Night: ${dur('night')}]`, dur('block') && `[Block: ${dur('block')}]`].filter(Boolean),
      };
      rows.push(row);
      for (const [f, k] of [['date', 'date'], ['duty', 'flight'], ['dep', 'dep'], ['arr', 'arr'], ['registration', 'reg'], ['ac', 'ac'], ['begin', 'out'], ['end', 'in'], ['info', 'fn'],
        ['info', dur('day') ? 'day' : null], ['info', dur('night') ? 'night' : null], ['info', dur('block') ? 'block' : null]]) if (k) mark(row, f, cell[k]);
    }
  }
  const pm = pages.flatMap(p => p.items).map(i => /from (\d{4})\/(\d{2})\/(\d{2}) until (\d{4})\/(\d{2})\/(\d{2})/.exec(i.text)).find(Boolean);
  const out = rows.map(r => outputRow({ ...r, info: r.notes.join(' ') }, 'Z'));
  return { format: 'legal-br-logbook', period: pm ? `${pm[3]}${MONTHS[+pm[2] - 1]}${pm[1].slice(2)} - ${pm[6]}${MONTHS[+pm[5] - 1]}${pm[4].slice(2)}` : null,
    notices: [], recognized: out.length > 0, published: out, planned: [], _trace: trace, _rows: rows };
}

const isAimsConvertedGrid = (page) => page.items.some(i => /^Escala de Tripulante Convertida/.test(i.text)) && page.items.some(i => /^Tripulante: .* \d{2}\/\d{2}\/\d{4} até \d{2}\/\d{2}\/\d{4}$/.test(i.text));

/**
 * "Escala de Tripulante Convertida para padrão AIMS" (LATAM Brasil): a column a day ("01Jun" / "Sat"), in it each activity as a block
 * of lines: code "DO" / "A320" / "EMG", its start twice, its station twice, its end twice. A row per activity: code, station, start,
 * end ("+1" when earlier than the start). Times as printed, taken as local.
 */
function parseAimsConvertedGrid(pages) {
  const trace = startTrace();
  const rows = [];
  const all = pages.flatMap(p => p.items);
  const pm = /(\d{2})\/(\d{2})\/(\d{4}) até (\d{2})\/(\d{2})\/(\d{4})$/.exec(all.find(i => /^Tripulante: /.test(i.text))?.text || '');
  const y0 = pm ? +pm[3] : new Date().getUTCFullYear(), m0 = pm ? +pm[2] - 1 : 0;
  const DAY = /^(\d{2})([A-Z][a-z]{2})$/;
  const events = [];
  for (const page of pages) {
    const days = page.items.filter(i => DAY.test(i.text) && monthIndex(DAY.exec(i.text)[2]) >= 0);
    if (!days.length) continue;
    const top = Math.max(...days.map(d => d.y)) + 10;
    const foot = page.items.find(i => /^Confira na escala/.test(i.text))?.y ?? Infinity;
    for (const d of days) {
      const [, dd, mon] = DAY.exec(d.text);
      const mi = monthIndex(mon);
      const t = Date.UTC(y0 + (mi < m0 - 6 ? 1 : 0), mi, +dd);
      const col = page.items.filter(i => i.y > top && i.y < foot && Math.abs(i.x - d.x) < 13).sort((a, b) => a.y - b.y);
      // a block of seven lines per activity: its code, start, start, station, station, end, end ("EMG" is a code, not a station)
      for (let k = 0; k < col.length; k += 1) {
        const it = col[k];
        if (/^\d{2}:\d{2}$/.test(it.text)) continue;
        const next = col.slice(k + 1, k + 7);
        const times = next.filter(i => /^\d{2}:\d{2}$/.test(i.text)), st = next.find(i => /^[A-Z]{3}$/.test(i.text));
        if (times.length < 2) continue;
        events.push({ t, d, code: it, st, start: times[0], end: times.at(-1) });
        k += next.length;
      }
    }
  }
  for (const e of events.sort((a, b) => a.t - b.t || a.code.y - b.code.y)) {
    const row = { ...dateOf(e.t), duty: e.code.text, dep: e.st?.text || '', begin: e.start.text, end: `${e.end.text}${e.end.text < e.start.text ? '+1' : ''}`, notes: [] };
    rows.push(row);
    mark(row, 'date', e.d); mark(row, 'duty', e.code); mark(row, 'dep', e.st); mark(row, 'begin', e.start); mark(row, 'end', e.end);
  }
  const out = rows.map(r => outputRow({ ...r, info: '' }, 'L'));
  return { format: 'aims-converted-grid', period: pm ? `${pm[1]}${MONTHS[+pm[2] - 1]}${pm[3].slice(2)} - ${pm[4]}${MONTHS[+pm[5] - 1]}${pm[6].slice(2)}` : null,
    notices: [], recognized: out.length > 0, published: out, planned: [], _trace: trace, _rows: rows };
}

const isMonthRosterSectors = (page) => page.items.some(i => /^[A-Z]+ \d{4} ROSTER$/.test(i.text)) && ['DATE', 'DAY', 'DUTY', 'SECTOR', 'REPORTING', 'BLOCK HOUR'].every(t => page.items.some(i => i.text === t));

/**
 * "FEBRUARY 2026 ROSTER" (Malaysia Airlines group): DATE | DAY | DUTY "3507" / "382/383" / "STANDBY 4" / "NS HKG" | SECTOR "KUL-SIN-KUL" /
 * "STANDBY HOME" | REPORTING "20:20" | TIME "21:20/01:30" (a departure and arrival per leg) | BLOCK HOUR | REMARKS
 * Rows: C/I (Reporting, when not 0:00), a flight a leg ("+1" when it lands earlier than it left), "NS HKG" a hotel row, others
 * (STANDBY 4, DO) with their times ("22:00/08:00 +1"); ">> END DUTY" is the end of the night before. Local times.
 */
function parseMonthRosterSectors(pages) {
  const trace = startTrace();
  const rows = [];
  const all = pages.flatMap(p => p.items);
  const tm = /^([A-Z]+) (\d{4}) ROSTER$/.exec(all.find(i => /^[A-Z]+ \d{4} ROSTER$/.test(i.text)).text);
  const mi = monthIndex(tm[1].slice(0, 3)), year = +tm[2];
  const add = (r, marks) => { const row = { notes: [], ...r }; rows.push(row); for (const [f, it] of marks) if (it && [].concat(it).length) mark(row, f, it); return row; };
  for (const page of pages) {
    const head = page.items.find(i => i.text === 'SECTOR');
    if (!head) continue;
    const hx = (t) => page.items.find(i => i.text === t && Math.abs(i.y - head.y) < 3)?.x;
    const X = { date: hx('DATE'), duty: hx('DUTY'), sector: hx('SECTOR'), rep: hx('REPORTING'), time: hx('TIME'), block: hx('BLOCK HOUR'), rem: hx('REMARKS') ?? Infinity };
    const colOf = (i) => (i.x >= X.rem - 5 ? 'rem' : i.x >= X.block - 5 ? 'block' : i.x >= X.time - 5 ? 'time' : i.x >= X.rep - 5 ? 'rep' : i.x >= X.sector - 5 ? 'sector' : i.x >= X.duty - 5 ? 'duty' : 'date');
    for (const l of toLines(page.items.filter(i => i.y > head.y + 5), 2)) {
      const cell = {};
      for (const it of l.items) (cell[colOf(it)] ||= []).push(it);
      const get = (k) => (cell[k] || []).map(i => i.text).join(' ');
      const dm = /^(\d{1,2}) [A-Z]{3}$/.exec(get('date'));
      if (!dm || !get('duty')) continue;
      const base = dateOf(Date.UTC(year, mi, +dm[1]));
      const duty = get('duty'), sector = get('sector'), time = get('time');
      if (/^>>/.test(duty)) continue;
      const times = time.split('/').map(t => t.trim()).filter(t => /^\d{1,2}:\d{2}( \+1)?$/.test(t));
      const pad = (t) => t.replace(/^(\d):/, '0$1:').replace(' +1', '+1');
      const later = (a, b) => (b && !/\+1/.test(b) && pad(b) < pad(a) ? '+1' : '');
      const legs = /^[A-Z]{3}(-[A-Z]{3})+$/.test(sector) ? sector.split('-') : null;
      if (legs && /^\d{2,4}[A-Z]?(\/\d{2,4}[A-Z]?)*$/.test(duty)) {
        const nums = duty.split('/');
        if (/^\d{1,2}:\d{2}$/.test(get('rep')) && /[1-9]/.test(get('rep'))) add({ ...base, duty: 'C/I', dep: legs[0], begin: pad(get('rep')) }, [['date', cell.date], ['ci', cell.rep]]);
        for (let k = 0; k < legs.length - 1; k += 1) {
          const [b, e] = [times[2 * k], times[2 * k + 1]];
          add({ ...base, duty: nums[Math.min(k, nums.length - 1)], dep: legs[k], arr: legs[k + 1], begin: b ? pad(b) : '', end: e ? `${pad(e)}${later(b, e)}` : '',
            notes: k === 0 && /[1-9]/.test(get('block')) ? [`[Block: ${get('block')}]`] : [] },
          [['date', k === 0 && !/[1-9]/.test(get('rep')) ? cell.date : null], ['duty', cell.duty], ['dep', cell.sector], ['begin', cell.time], ['info', k === 0 ? cell.block : null]]);
        }
        continue;
      }
      const ns = /^NS ([A-Z]{3})$/.exec(duty);
      const [b, e] = times;
      add({ ...base, duty: ns ? 'H' : duty, dep: ns ? ns[1] : '', begin: b && /[1-9]/.test(b) || e ? pad(b || '') : '', end: e ? `${pad(e)}${later(b, e)}` : '', notes: ns || duty === sector ? [] : [sector] },
        [['date', cell.date], ['duty', cell.duty], ['begin', cell.time], ['info', ns ? null : cell.sector]]);
    }
  }
  const out = rows.map(r => outputRow({ ...r, info: r.notes.filter(Boolean).join(' ') }, 'L'));
  const last = new Date(Date.UTC(year, mi + 1, 0)).getUTCDate();
  return { format: 'month-roster-sectors', period: `01${MONTHS[mi]}${String(year).slice(2)} - ${last}${MONTHS[mi]}${String(year).slice(2)}`, notices: [], recognized: out.length > 0,
    published: out, planned: [], _trace: trace, _rows: rows };
}

const isRocsIndividualPlan = (page) => page.items.some(i => i.text === 'Individual plan') && page.items.some(i => i.text === 'ROCS') && ['Duty', 'Departure', 'Arrival', 'Info'].every(t => page.items.some(i => i.text === t));

/**
 * "Individual plan" (ROCS; "01-01-2024 - 31-12-2024"): Date ("MON 2024" over "01 Jan") | Duty (the kind "FLIGHT DUTY" / "OFF" / "ABSENCE"
 * over its code "FR 5521" / "OFF" / "C/SICK") | Departure (station, time) | Arrival (time, station) | AC | Info ("FT 08:37", "DP 10:19",
 * "FDP 09:49": flight time, duty period, flight duty period of the day). A row per code line: a flight "FR5521" with its stations and times
 * ("+1" when it lands earlier), others with theirs; the day's FT / DP / FDP as "[FT: 08:37] [DP: 10:19] [FDP: 09:49]" on its first row.
 * Times as printed, taken as UTC.
 */
function parseRocsIndividualPlan(pages) {
  const trace = startTrace();
  const rows = [];
  const pm = pages.flatMap(p => p.items).map(i => /^(\d{2})-(\d{2})-(\d{4}) - (\d{2})-(\d{2})-(\d{4})$/.exec(i.text)).find(Boolean);
  const DAY = /^(\d{2}) ([A-Z][a-z]{2})$/;
  let year = pm ? +pm[3] : new Date().getUTCFullYear(), cur = null, curItem = null, dayRow = null;
  for (const page of pages) {
    const head = page.items.find(i => i.text === 'Departure');
    if (!head) continue;
    const hx = (t) => page.items.find(i => i.text === t && Math.abs(i.y - head.y) < 3)?.x;
    const X = { duty: hx('Duty'), dep: hx('Departure'), arr: hx('Arrival'), ac: hx('AC'), info: hx('Info') };
    const body = page.items.filter(i => i.y > head.y + 5);
    // the day's FT / DP / FDP (label and value side by side in Info)
    const infos = toLines(body.filter(i => i.x >= X.info - 5), 2).map(l => ({ y: l.y, text: l.items.map(i => i.text).join(' ') }));
    for (const l of toLines(body.filter(i => i.x < X.info - 5), 2)) {
      const yItem = l.items.find(i => /^[A-Z]{3} (\d{4})$/.test(i.text) && i.x < X.duty - 5);
      if (yItem) year = +yItem.text.slice(4);
      const dItem = l.items.find(i => DAY.test(i.text) && i.x < X.duty - 5);
      if (dItem) { const [, dd, mon] = DAY.exec(dItem.text); cur = Date.UTC(year, monthIndex(mon), +dd); curItem = dItem; dayRow = null; }
      if (cur == null) continue;
      const code = l.items.find(i => i.x >= X.duty - 5 && i.x < X.dep - 5);
      const dep = l.items.find(i => i.x >= X.dep - 5 && /^[A-Z]{3}$/.test(i.text) && i.x < X.dep + 25);
      const tms = l.items.filter(i => /^\d{2}:\d{2}$/.test(i.text) && i.x >= X.dep && i.x < X.ac - 20);
      // the kind of duty above its code ("FLIGHT DUTY", "DEAD HEAD", "OFF": no times, no station): not a row
      if (!code || (!tms.length && !dep)) continue;
      const arr = l.items.find(i => i.x > X.arr + 20 && i.x < X.ac - 5 && /^[A-Z]{3}$/.test(i.text));
      const ac = l.items.find(i => i.x >= X.ac - 5 && i.x < X.info - 5);
      const fl = /^([A-Z0-9]{2}) (\d{1,4}[A-Z]?)$/.exec(code.text);
      const [b, e] = tms;
      const row = { ...dateOf(cur), duty: fl ? `${fl[1]}${fl[2]}` : code.text, dep: dep?.text || '', arr: arr?.text || '', begin: b?.text || '', end: e ? `${e.text}${b && e.text < b.text ? '+1' : ''}` : '', ac: ac?.text || '', notes: [] };
      rows.push(row);
      if (curItem) { mark(row, 'date', curItem); curItem = null; }
      mark(row, 'duty', code); mark(row, 'dep', dep); mark(row, 'arr', arr); mark(row, 'begin', b); mark(row, 'end', e); mark(row, 'ac', ac);
      if (!dayRow) {
        dayRow = row;
        // this day's info lines: from its line down to the next day
        const next = body.filter(i => DAY.test(i.text) && i.x < X.duty - 5 && i.y > l.y + 3).map(i => i.y).sort((a, c) => a - c)[0] ?? Infinity;
        for (const inf of infos.filter(x => x.y >= l.y - 2 && x.y < next - 12)) {
          const m = /^(FT|DP|FDP) (\d{2}:\d{2})$/.exec(inf.text);
          if (m) row.notes.push(`[${m[1]}: ${m[2]}]`);
        }
      }
    }
  }
  const out = rows.map(r => outputRow({ ...r, info: r.notes.join(' ') }, 'Z'));
  return { format: 'rocs-individual-plan', period: pm ? `${pm[1]}${MONTHS[+pm[2] - 1]}${pm[3].slice(2)} - ${pm[4]}${MONTHS[+pm[5] - 1]}${pm[6].slice(2)}` : null,
    notices: [], recognized: out.length > 0, published: out, planned: [], _trace: trace, _rows: rows };
}

const isPortLocalRosterReport = (page) => lineTexts(page).some(t => /^Roster Report from \d{2}[A-Z]{3}\d{2}/.test(t.replace(/\s+/g, ' ')))
  && lineTexts(page).some(t => /Times shown are in Port Local times/.test(t.replace(/\s+/g, ' ')));

/**
 * Korean Air "Roster Report from 01JUN24 - 30JUN24" ("Times shown are in Port Local times"), a line per flight or day:
 *   Start Date "02JUN24 SUN" | Flight Number "KE 0101" | Sector "ICN NKG" | A/C "7MQ" | Duty "FLY" | Pairing | Duty Crew | Rank | Rpt | STD |
 *   STA | Flt Time "01 59" | Duty Time "07 41" | Hotel | Training | Remarks; a day: "01JUN24 SAT ICN DO 0"
 * Rows: C/I (Rpt, on a duty's first flight), the flights ("DH" duty: dc DH; "+1" when STA is earlier; "[Flight: 01:59] [Duty: 07:41]"),
 * a day's code (DO, RESERVE, ALV) at its station. Local times.
 */
function parsePortLocalRosterReport(pages) {
  const trace = startTrace();
  const rows = [];
  let cur = null, curItem = null;
  const FLT = /^(?:(\d{2}[A-Z]{3}\d{2}) [A-Z]{3} )?([A-Z0-9]{2}) (\d{1,4}) ([A-Z]{3}) ([A-Z]{3}) (\w{2,4}) ([A-Z]+)\b.*?\b(\d{4}) (\d{4})(?: (\d{4}))? (\d{2}) (\d{2})(?: (\d{2}) (\d{2}))?/;
  const DAYLINE = /^(\d{2}[A-Z]{3}\d{2}) [A-Z]{3} ([A-Z]{3}) ([A-Z][A-Z0-9/-]*)\b/;
  const hm = (t) => `${t.slice(0, 2)}:${t.slice(2)}`;
  for (const page of pages) {
    const head = page.items.find(i => /^DateDay$/.test(i.text) || /^Start$/.test(i.text) && page.items.some(j => j.text === 'Sector' && Math.abs(j.y - i.y) < 3));
    if (!head) continue;
    // (the print has NUL characters as items between some cells)
    for (const l of toLines(page.items.filter(i => i.y > head.y + 5 && i.text.replace(/\u0000/g, '').trim()), 2)) {
      const its = l.items;
      const text = its.map(i => i.text.trim()).join(' ').replace(/\s+/g, ' ');
      const dd = /^(\d{2}[A-Z]{3}\d{2})\b/.exec(text);
      if (dd) { const p = parseDdMonYy(`${dd[1].slice(0, 2)}${dd[1].slice(2, 3)}${dd[1].slice(3, 5).toLowerCase()}${dd[1].slice(5)}`); if (p) { cur = Date.UTC(2000 + p.year, p.month, p.day); curItem = its[0]; } }
      if (cur == null) continue;
      let m;
      if ((m = FLT.exec(text))) {
        const [, , al, num, dep, arr, ac, kind, t1, t2, t3, f1, f2, d1, d2] = m;
        const [rpt, std, sta] = t3 ? [t1, t2, t3] : [null, t1, t2];
        const add = (r, f) => { const row = { ...dateOf(cur), notes: [], ...r }; rows.push(row); if (curItem) { mark(row, 'date', curItem); curItem = null; } f?.(row); return row; };
        if (rpt) add({ duty: 'C/I', dep, begin: hm(rpt) });
        add({ duty: `${al}${num}`, dc: /^DH/.test(kind) ? 'DH' : '', dep, arr, ac, begin: hm(std), end: `${hm(sta)}${sta < std ? '+1' : ''}`,
          notes: [`[Flight: ${f1}:${f2}]`, d1 && `[Duty: ${d1}:${d2}]`].filter(Boolean) }, (row) => {
          const find = (re) => its.find(i => re.test(i.text.trim()));
          mark(row, 'duty', find(new RegExp(`^${num}$`)));
          mark(row, 'begin', find(new RegExp(`(^| )${std}( |$)`)));
        });
        continue;
      }
      if ((m = DAYLINE.exec(text)) && !/^\d/.test(m[3])) {
        const row = { ...dateOf(cur), duty: m[3], dep: m[2], notes: [] };
        rows.push(row);
        if (curItem) { mark(row, 'date', curItem); curItem = null; }
      }
    }
  }
  const pm = pages.flatMap(p => lineTexts(p)).map(t => /Roster Report from (\d{2})([A-Z]{3})(\d{2})\W+(\d{2})([A-Z]{3})(\d{2})/.exec(t.replace(/[\s\u0000]+/g, ' '))).find(Boolean);
  const cap = (s) => s[0] + s.slice(1).toLowerCase();
  const out = rows.map(r => outputRow({ ...r, info: r.notes.join(' ') }, 'L'));
  return { format: 'port-local-roster-report', period: pm ? `${pm[1]}${cap(pm[2])}${pm[3]} - ${pm[4]}${cap(pm[5])}${pm[6]}` : null,
    notices: [], recognized: out.length > 0, published: out, planned: [], _trace: trace, _rows: rows };
}

const isProgrammazioneIndividuale = (page) => page.items.some(i => i.text === 'Programmazione Individuale') && page.items.some(i => /^Data e Ora = UTC$/.test(i.text));

/**
 * Mistral Air "Crew Schedule - Programmazione Individuale dei Turni" ("Data e Ora = UTC"): Data "Tue-15-Mar" | Tipo (CHECKIN, FLIGHT,
 * POSITION) | Da | A ("==>>": it ends on a later day's "<<== 01:25" line) | Descrizione "VBS(A)-CAG(B)", under it "M4 783 EIGHA" (airline,
 * number, registration) or the activity's name ("OFF RICHIESTO", "HOTEL ACCOMODATION") | rank | Membri Equipaggio | ... | Ore Volo "001:30".
 * A day's label stands on its first line (the lines above the first label are the day before). Rows: CHECKIN -> C/I, FLIGHT / POSITION
 * (dc DH) a flight ("[Block: 01:30]"), HOTEL a hotel row, others (OFF, CORSO ...) by their name. UTC.
 */
function parseProgrammazioneIndividuale(pages) {
  const trace = startTrace();
  const rows = [];
  const DAY = /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun)-(\d{2})-([A-Z][a-z]{2})$/;
  const printed = pages.flatMap(p => p.items).map(i => /^Stampato il (\d{2})-(\d{2})-(\d{4})/.exec(i.text)).find(Boolean);
  const py = printed ? +printed[3] : new Date().getUTCFullYear(), pmo = printed ? +printed[2] - 1 : 0;
  const lines = [];
  for (const page of pages) {
    const head = page.items.find(i => i.text === 'Descrizione' && i.x > 100);
    if (!head) continue;
    lines.push(...toLines(page.items.filter(i => i.y > head.y + 5 && !/^Pagina /.test(i.text)), 2));
  }
  // the date of each line: from its day's label down; the lines above the first label are the day before
  const first = lines.findIndex(l => l.items.some(i => DAY.test(i.text)));
  if (first < 0) return { format: 'programmazione-individuale', period: null, notices: [], recognized: false, published: [], planned: [], _trace: trace, _rows: [] };
  const dayOfLabel = (t) => { const [, , dd, mon] = DAY.exec(t); const mi = monthIndex(mon); return Date.UTC(py - (mi > pmo + 6 ? 1 : 0), mi, +dd); };
  let cur = dayOfLabel(lines[first].items.find(i => DAY.test(i.text)).text) - 86400000;
  const dated = lines.map((l) => { const lab = l.items.find(i => DAY.test(i.text)); if (lab) cur = dayOfLabel(lab.text); return { ...l, t: cur, lab }; });
  const TIME = /^\d{2}:\d{2}$/;
  const add = (r, marks) => { const row = { notes: [], ...r }; rows.push(row); for (const [f, it] of marks) if (it && [].concat(it).length) mark(row, f, it); return row; };
  for (const [k, l] of dated.entries()) {
    const at = (lo, hi) => l.items.filter(i => i.x >= lo && i.x < hi);
    const kind = at(90, 170)[0];
    const da = at(170, 225).find(i => TIME.test(i.text)), a = at(225, 280)[0];
    const desc = at(280, 350)[0];
    if (!da && !kind) continue;
    if (!da && kind?.text !== 'CHECKIN') continue;
    // the end: "A", or on the "<<==" line of a later day
    let end = a && TIME.test(a.text) ? { item: a, t: l.t } : null;
    if (a?.text === '==>>') {
      const cont = dated.slice(k + 1).find(x => x.items.some(i => i.text === '<<=='));
      const ce = cont?.items.find(i => TIME.test(i.text) && i.x >= 225 && i.x < 280);
      if (ce) end = { item: ce, t: cont.t };
    }
    const endText = end ? `${end.item.text}${end.t > l.t ? `+${Math.round((end.t - l.t) / 86400000)}` : ''}` : '';
    const under = dated[k + 1]?.items.filter(i => i.x >= 280 && i.x < 450) || [];
    const base = dateOf(l.t);
    const dateMark = l.lab ? [['date', l.lab]] : [];
    if (kind?.text === 'CHECKIN') {
      const next = dated.slice(k + 1).find(x => x.items.some(i => /^(FLIGHT|POSITION)$/.test(i.text)));
      const route = next?.items.find(i => /^[A-Z]{3}(\([A-Z]\))?-[A-Z]{3}/.test(i.text));
      add({ ...base, duty: 'C/I', dep: route ? route.text.slice(0, 3) : '', begin: da?.text || '' }, [...dateMark, ['ci', da]]);
      continue;
    }
    if (/^(FLIGHT|POSITION)$/.test(kind?.text || '')) {
      const r = /^([A-Z]{3})(?:\([A-Z]\))?-([A-Z]{3})/.exec(desc?.text || '');
      const [al, num, reg] = under.map(i => i.text);
      const rank = at(350, 400)[0];
      const blk = l.items.find(i => /^\d{3}:\d{2}$/.test(i.text) && i.x > 680 && i.x < 740);
      const b = blk && /[1-9]/.test(blk.text) ? blk.text.replace(/^0/, '') : '';
      add({ ...base, duty: al && /^\d+$/.test(num || '') ? `${al}${num}` : '', dc: kind.text === 'POSITION' ? 'DH' : '', dep: r?.[1] || '', arr: r?.[2] || '', begin: da.text, end: endText,
        registration: /^[A-Z0-9]{4,6}$/.test(reg || '') ? reg : '', notes: [rank && `[Rank: ${rank.text}]`, b && `[Block: ${b}]`].filter(Boolean) },
      [...dateMark, ['duty', under.slice(0, 2)], ['dep', desc], ['begin', da], ['end', end?.item], ['registration', under[2]], ['info', [rank, blk].filter(Boolean)]]);
      continue;
    }
    // an activity: its station, its name on the line under it ("OFF RICHIESTO", "HOTEL ACCOMODATION", "CORSO - ADDESTRAMENTI ...")
    const name = under.filter(i => i.x < 450).map(i => i.text).join(' ');
    if (!name) continue;
    const hotel = /^HOTEL\b/.test(name);
    add({ ...base, duty: hotel ? 'H' : name.split(' ')[0], dep: /^[A-Z]{3}$/.test(desc?.text || '') ? desc.text : '', begin: da.text, end: endText, notes: hotel || name.split(' ').length === 1 ? [] : [name] },
      [...dateMark, ['duty', under[0]], ['dep', desc], ['begin', da], ['end', end?.item]]);
  }
  const fmt = (r) => { const [d, m, y] = r.date.split(' '); return `${d.padStart(2, '0')}${m}${y}`; };
  const out = rows.map(r => outputRow({ ...r, info: r.notes.join(' ') }, 'Z'));
  return { format: 'programmazione-individuale', period: rows.length ? `${fmt(rows[0])} - ${fmt(rows.at(-1))}` : null, notices: [], recognized: out.length > 0, published: out, planned: [], _trace: trace, _rows: rows };
}

const isFlightInformation = (page) => page.items.some(i => i.text === 'Flight Information') && ['Flight No.:', 'Origin:', 'Destination:', 'OFF Block Time:'].every(t => page.items.some(i => i.text === t));

/**
 * A flight's "Flight Information" sheet (Icelandair; "Digitally Signed By:", "Pre Flight Received (UTC)"): Flight No. "FI630(630)", Date
 * "10052022", Origin / Destination, Registration, the crew "CMD: KGA (Konrad ...)" / "F/O: ...", and the times "OFF Block Time: 0043",
 * "Take-Off Time", "Landing Time", "ON Block Time", "Total Block Time" / "Total Airborne Time". One row (UTC; "+1" when it lands or blocks
 * on earlier than it left), the crew "[CMD - KGA - Konrad ...]", "[Block: 05:15] [Flight: 05:00]".
 */
function parseFlightInformation(pages) {
  const trace = startTrace();
  const rows = [];
  for (const page of pages) {
    const label = (t) => page.items.find(i => i.text === t);
    const value = (t, dx = 30, re = /\S/) => { const l = label(t); return l && page.items.filter(i => i !== l && i.x > l.x && i.x < l.x + l.text.length * 6 + dx + 120 && Math.abs(i.y - l.y) < 6 && re.test(i.text)).sort((a, b) => a.x - b.x)[0]; };
    const fn = value('Flight No.:'), d = value('Date:', 30, /^\d{8}$/);
    if (!fn || !d) continue;
    const fl = /^([A-Z0-9]{2,3}\d{1,4}[A-Z]?)/.exec(fn.text);
    const t = Date.UTC(+d.text.slice(4), +d.text.slice(2, 4) - 1, +d.text.slice(0, 2));
    const time = (n) => value(n, 30, /^\d{4}$/);
    const [off, tk, ld, on] = ['OFF Block Time:', 'Take-Off Time:', 'Landing Time:', 'ON Block Time:'].map(time);
    const hm = (i) => (i ? `${i.text.slice(0, 2)}:${i.text.slice(2)}` : '');
    const later = (i) => (i && off && i.text < off.text ? '+1' : '');
    const dur = (n) => { const i = time(n); return i && /[1-9]/.test(i.text) ? hm(i) : ''; };
    const crewItems = page.items.filter(i => /^[A-Z/0-9]{2,4}:$/.test(i.text) && /^(CMD|F\/O|SO|CC\d|FO|CPT|FE)/.test(i.text));
    // the crew but the one it is signed by (the roster's owner)
    const signer = value('Digitally Signed By:')?.text;
    crewItems.sort((a, b) => a.y - b.y || a.x - b.x);
    const crew = crewItems.map(c => ({ c, v: page.items.find(i => i.x > c.x && i.x < c.x + 60 && Math.abs(i.y - c.y) < 4 && /\(/.test(i.text)) })).filter(x => x.v && !(signer && x.v.text.startsWith(`${signer} (`)))
      .map(({ c, v }) => { const m = /^(\S+) \((.+)\)$/.exec(v.text); return { text: m ? `[${c.text.slice(0, -1)} - ${m[1]} - ${m[2]}]` : `[${c.text.slice(0, -1)} - ${v.text}]`, items: [c, v] }; });
    const row = {
      ...dateOf(t), duty: fl ? fl[1] : fn.text, registration: value('Registration:')?.text || '', dep: value('Origin:', 30, /^[A-Z]{4}$/)?.text || '', arr: value('Destination:', 30, /^[A-Z]{4}$/)?.text || '',
      begin: hm(off), takeoff: tk ? `${hm(tk)}${later(tk)}` : '', landing: ld ? `${hm(ld)}${later(ld)}` : '', end: on ? `${hm(on)}${later(on)}` : '',
      crew: crew.map(c => c.text).join(''), notes: [dur('Total Block Time:') && `[Block: ${dur('Total Block Time:')}]`, dur('Total Airborne Time:') && `[Flight: ${dur('Total Airborne Time:')}]`].filter(Boolean),
    };
    rows.push(row);
    for (const [f, it] of [['date', d], ['duty', fn], ['registration', value('Registration:')], ['dep', value('Origin:')], ['arr', value('Destination:')], ['begin', off], ['takeoff', tk], ['landing', ld], ['end', on],
      ['crew', crew.flatMap(c => c.items)], ['info', [time('Total Block Time:'), time('Total Airborne Time:')].filter(Boolean)]]) mark(row, f, it);
  }
  const fmt = (r) => { const [d, m, y] = r.date.split(' '); return `${d.padStart(2, '0')}${m}${y}`; };
  const out = rows.map(r => outputRow({ ...r, info: r.notes.join(' ') }, 'Z'));
  return { format: 'flight-information', period: rows.length ? `${fmt(rows[0])} - ${fmt(rows.at(-1))}` : null, notices: [], recognized: out.length > 0, published: out, planned: [], _trace: trace, _rows: rows };
}

const isJourneyLog = (page) => page.items.some(i => i.text === 'Journey Log') && page.items.some(i => i.text === 'Date of flight:') && page.items.some(i => i.text === 'Routing');

/**
 * A business jet's "Journey Log" page (VistaJet): "Date of flight: 05 Feb 24", Registration, A/C Type, then three lines a leg:
 *   PIC "1JSC" | C/H | From "LFSB" | Off Block "10:00" | T/O "10:12" ...                  (above)
 *   Leg No. "1" | Flight No. "VJH727" | ... | Pax | Block Time "05:35" | Air Time "05:19" | Ldgs | APP ...
 *   F/O "1JCH" | ACM | To "OBBI" | On Block "15:35" | Landing "15:31" ...                   (below)
 * A row per leg (UTC): block off / on, take-off / landing, the crew "[PIC - 1JSC][C/H - 1ERI][F/O - 1JCH]", "[Block: 05:35] [Flight: 05:19] [Pax: 3]".
 */
function parseJourneyLog(pages) {
  const trace = startTrace();
  const rows = [];
  for (const page of pages) {
    const dl = page.items.find(i => i.text === 'Date of flight:');
    if (!dl) continue;
    const below = (l) => page.items.filter(i => i.y > l.y + 3 && i.y < l.y + 16 && Math.abs(i.x - l.x) < 20).sort((a, b) => a.y - b.y)[0];
    const dv = below(dl), reg = below(page.items.find(i => i.text === 'Registration:') || dl), type = below(page.items.find(i => i.text === 'A/C Type:') || dl);
    const dm = /^(\d{2}) ([A-Z][a-z]{2}) (\d{2})$/.exec(dv?.text || '');
    if (!dm) continue;
    const t = Date.UTC(2000 + +dm[3], monthIndex(dm[2]), +dm[1]);
    const typeText = [type, type && page.items.find(i => i.y > type.y + 5 && i.y < type.y + 25 && Math.abs(i.x - type.x - 10) < 15 && /^\d{3}$/.test(i.text))].filter(Boolean).map(i => i.text).join(' ');
    const lines = toLines(page.items, 2);
    for (const [k, l] of lines.entries()) {
      const leg = l.items[0], fl = l.items[1];
      if (!leg || !/^\d$/.test(leg.text) || leg.x > 50 || !fl || !/^[A-Z]{2,3}\d{1,4}[A-Z]?$/.test(fl.text)) continue;
      const above = [...lines.slice(Math.max(0, k - 3), k)].reverse().find(x => x.items.some(i => /^[A-Z]{4}$/.test(i.text) && i.x > 180 && i.x < 230));
      const under = lines.slice(k + 1, k + 4).find(x => x.items.some(i => /^[A-Z]{4}$/.test(i.text) && i.x > 180 && i.x < 230));
      if (!above || !under) continue;
      const TIME = /^\d{2}:\d{2}$/;
      const ap = (x) => x.items.find(i => /^[A-Z]{4}$/.test(i.text) && i.x > 180 && i.x < 230);
      const tm = (x, lo, hi) => x.items.find(i => TIME.test(i.text) && i.x >= lo && i.x < hi);
      const [off, tk] = [tm(above, 230, 290), tm(above, 290, 330)], [on, ld] = [tm(under, 230, 290), tm(under, 290, 330)];
      const [blk, air] = [tm(l, 265, 330), tm(l, 330, 360)];
      const pax = l.items.find(i => /^\d{1,2}$/.test(i.text) && i.x > 160 && i.x < 180);
      const codes = (x) => x.items.filter(i => /^\d?[A-Z]{3}$/.test(i.text) && i.x > 80 && i.x < 140);
      const [pic, ch] = codes(above), [fo, acm] = codes(under);
      const later = (i) => (i && off && i.text < off.text ? '+1' : '');
      const row = {
        ...dateOf(t), duty: fl.text, registration: reg?.text || '', ac: typeText, dep: ap(above).text, arr: ap(under).text,
        begin: off?.text || '', takeoff: tk ? `${tk.text}${later(tk)}` : '', landing: ld ? `${ld.text}${later(ld)}` : '', end: on ? `${on.text}${later(on)}` : '',
        crew: [['PIC', pic], ['C/H', ch], ['F/O', fo], ['ACM', acm]].filter(([, i]) => i).map(([n, i]) => `[${n} - ${i.text}]`).join(''),
        notes: [blk && `[Block: ${blk.text}]`, air && `[Flight: ${air.text}]`, pax && `[Pax: ${pax.text}]`].filter(Boolean),
      };
      rows.push(row);
      for (const [f, it] of [['date', dv], ['duty', fl], ['registration', reg], ['ac', type], ['dep', ap(above)], ['arr', ap(under)], ['begin', off], ['takeoff', tk], ['landing', ld], ['end', on],
        ['crew', [pic, ch, fo, acm].filter(Boolean)], ['info', [blk, air, pax].filter(Boolean)]]) mark(row, f, it);
    }
  }
  const fmt = (r) => { const [d, m, y] = r.date.split(' '); return `${d.padStart(2, '0')}${m}${y}`; };
  const out = rows.map(r => outputRow({ ...r, info: r.notes.join(' ') }, 'Z'));
  return { format: 'journey-log', period: rows.length ? `${fmt(rows[0])} - ${fmt(rows.at(-1))}` : null, notices: [], recognized: out.length > 0, published: out, planned: [], _trace: trace, _rows: rows };
}

/**
 * Papers about one flight, a row each (UTC):
 *   NAVBLUE flight plan: "LZB563 -LBSF/LPPT 02MAY26 ... ACFT. LZROM / A220-300S2", "STD UTC : 16:40  STA UTC : 21:15"
 *   flight plan ("BTI604 EBBR/EVRA 09 Jan 2022"): AC ID, "SCHEDULED DEPARTING: 09 Jan 2022 18 : 05 UTC", "SCHEDULED ARRIVING: ..."
 *   RVSM / ATIS report: "FLT NBR FB0563  SKD 02 May 16:40", "FROM LBSF  TO LPPT" (the year from the report's date)
 *   Virgin "Flight Report": Date | Registration | FLIGHT No., FROM / TO, STD / STA, ATD / ATA "2022-01-12T22:26:00", BLOCK TIME, and per pilot
 *   NAME | STAFF No. | RANK with ON DUTY / OFF DUTY (C/I and C/O from the first pilot's), the crew "[CAP - 407254 - John Margetts]"
 */
const SINGLE_FLIGHT_KINDS = [
  ['navblue-plan', (all) => all.some(i => /^\*\*\*NAVBLUE FLIGHT PLAN\*\*\*$/.test(i.text))],
  ['flight-plan', (all) => all.some(i => i.text === 'Flight Plan') && all.some(i => /^[A-Z0-9]{3,8} [A-Z]{4}\/[A-Z]{4} \d{2} [A-Z][a-z]{2} \d{4}$/.test(i.text)) && all.some(i => i.text === 'FLT SUMMARY')],
  ['flight-report-sheet', (all) => all.some(i => /^(RVSM|ATIS) Report - \d{2} [A-Z][a-z]{2} \d{4}/.test(i.text)) && all.some(i => i.text === 'FLT NBR')],
  ['virgin-flight-report', (all) => all.some(i => i.text === 'Flight Report') && all.some(i => i.text === 'ACTUAL SECTORS FLOWN') && all.some(i => i.text === 'FLIGHT No.')],
];
const isSingleFlightPaper = (pages) => { const all = pages.flatMap(p => p.items); return SINGLE_FLIGHT_KINDS.find(([, test]) => test(all))?.[0] || null; };

function parseSingleFlightPaper(pages, kind) {
  const trace = startTrace();
  // the pages one under the other (a page's items never meet another's), the trace on the real items
  const all = pages.flatMap((p, k) => p.items.map(i => ({ ...i, y: i.y + k * 10000, _src: i._src || i })));
  const row = { notes: [] };
  const right = (label, re, dy = 3, dx = 400) => { const l = all.find(i => i.text === label); return l && all.filter(i => i !== l && Math.abs(i.y - l.y) < dy && i.x > l.x && i.x < l.x + dx && (!re || re.test(i.text))).sort((a, b) => a.x - b.x)[0]; };
  const day = (d, mon, y) => Date.UTC(+y < 100 ? 2000 + +y : +y, monthIndex(mon), +d);
  let t = null, marks = [];
  if (kind === 'navblue-plan') {
    const h = all.map(i => ({ i, m: /^-([A-Z]{4})\/([A-Z]{4}) (\d{2})([A-Z]{3})(\d{2})$/.exec(i.text) })).find(x => x.m);
    const fl = h && all.find(i => Math.abs(i.y - h.i.y) < 3 && i.x < h.i.x && /^[A-Z0-9]{3,8}$/.test(i.text));
    if (!h) return null;
    t = day(h.m[3], h.m[4], h.m[5]);
    const acft = all.find(i => /^\/ \S+/.test(i.text) && Math.abs(i.y - h.i.y) < 3), reg = acft && all.find(i => Math.abs(i.y - acft.y) < 3 && i.x < acft.x && i.x > acft.x - 60);
    const std = all.find(i => /^: \d{2}:\d{2}$/.test(i.text) && all.some(j => j.text === 'UTC' && Math.abs(j.y - i.y) < 3 && j.x < i.x));
    const sta = all.find(i => /^STA UTC$/.test(i.text));
    const staV = sta && all.find(i => Math.abs(i.y - sta.y) < 3 && i.x > sta.x && /^: \d{2}:\d{2}$/.test(i.text));
    Object.assign(row, { duty: fl?.text || '', dep: h.m[1], arr: h.m[2], registration: reg?.text || '', ac: acft ? acft.text.slice(2) : '', begin: std ? std.text.slice(2) : '', end: staV ? staV.text.slice(2) : '' });
    if (row.end && row.begin && row.end < row.begin) row.end += '+1';
    marks = [['duty', fl], ['dep', h.i], ['registration', reg], ['begin', std], ['end', staV]];
  } else if (kind === 'flight-plan') {
    const h = all.map(i => ({ i, m: /^([A-Z0-9]{3,8}) ([A-Z]{4})\/([A-Z]{4}) (\d{2}) ([A-Z][a-z]{2}) (\d{4})$/.exec(i.text) })).find(x => x.m);
    t = day(h.m[4], h.m[5], h.m[6]);
    const sched = (label) => {
      const l = all.find(i => i.text === label);
      const its = l && all.filter(i => i.y > l.y - 2 && i.y < l.y + 8 && i.x > l.x + 100).sort((a, b) => a.x - b.x);
      const m = its && /(\d{2}) ([A-Z][a-z]{2}) (\d{4}) (\d{2}) ?: ?(\d{2}) UTC/.exec(its.map(i => i.text).join(' '));
      return m ? { t: day(m[1], m[2], m[3]), hm: `${m[4]}:${m[5]}`, items: its } : null;
    };
    const dep = sched('DEPARTING:'), arr = sched('ARRIVING:');
    const acId = all.find(i => i.text === 'AC ID:'), reg = acId && all.find(i => i.y > acId.y - 2 && i.y < acId.y + 6 && i.x > acId.x + 100);
    if (dep) t = dep.t;
    Object.assign(row, { duty: h.m[1], dep: h.m[2], arr: h.m[3], registration: reg?.text || '', begin: dep?.hm || '', end: arr ? `${arr.hm}${dep && arr.t > dep.t ? '+1' : ''}` : '' });
    marks = [['duty', pieceOf(h.i, 0, h.m[1].length)], ['dep', pieceOf(h.i, h.m[1].length + 1, 4)], ['arr', pieceOf(h.i, h.m[1].length + 6, 4)], ['registration', reg], ['begin', dep?.items], ['end', arr?.items]];
  } else if (kind === 'flight-report-sheet') {
    const yr = all.map(i => /^(?:RVSM|ATIS) Report - \d{2} [A-Z][a-z]{2} (\d{4})/.exec(i.text)).find(Boolean)[1];
    const fl = right('FLT NBR', /^[A-Z0-9]{3,8}$/), skd = right('SKD', /^\d{2} [A-Z][a-z]{2} \d{2}:\d{2}$/), from = right('FROM', /^[A-Z]{4}$/), to = right('TO', /^[A-Z]{4}$/);
    if (!fl || !skd) return null;
    const [dd, mon, hm] = skd.text.split(' ');
    t = day(dd, mon, yr);
    Object.assign(row, { duty: fl.text, dep: from?.text || '', arr: to?.text || '', begin: hm });
    marks = [['duty', fl], ['date', pieceOf(skd, 0, 6)], ['begin', pieceOf(skd, 7, 5)], ['dep', from], ['arr', to]];
  } else if (kind === 'virgin-flight-report') {
    const below = (label, re) => { const l = all.find(i => i.text === label); return l && all.filter(i => i.y > l.y + 5 && i.y < l.y + 40 && Math.abs(i.x - l.x) < 14 && (!re || re.test(i.text))).sort((a, b) => a.y - b.y)[0]; };
    const d = below('Date', /^\d{4}-\d{2}-\d{2}$/), reg = below('Registration'), fl = below('FLIGHT No.'), from = below('FROM', /^[A-Z]{3,4}$/), to = below('TO', /^[A-Z]{3,4}$/);
    const ISO = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/;
    const stamp = (label) => { const i = below(label, ISO); const m = i && ISO.exec(i.text); return m ? { t: Date.UTC(+m[1], +m[2] - 1, +m[3]), hm: `${m[4]}:${m[5]}`, item: i } : null; };
    const atd = stamp('ATD') || stamp('STD'), ata = stamp('ATA') || stamp('STA');
    const blk = below('BLOCK TIME', /^\d{2}:\d{2}$/);
    if (!atd) return null;
    t = atd.t;
    const plus = (x) => (x && x.t > atd.t ? `+${Math.round((x.t - atd.t) / 86400000)}` : '');
    // the crew: NAME | STAFF No. | RANK (where the header puts them: the cabin crew's stand elsewhere), then their ON DUTY / OFF DUTY
    const names = all.filter(i => i.text === 'NAME').map(n => ({ n, v: all.find(i => i.y > n.y + 10 && i.y < n.y + 35 && Math.abs(i.x - n.x) < 8) }));
    const crew = names.map(({ n, v }) => {
      const hx = (t) => all.find(i => i.text === t && Math.abs(i.y - n.y) < 3)?.x;
      const near = (x) => v && x != null && all.find(i => Math.abs(i.y - v.y) < 3 && Math.abs(i.x - x) < 12 && i.text.trim());
      const staff = near(hx('STAFF No.')), rank = near(hx('RANK'));
      return v && { text: `[${rank?.text || 'Crew'} - ${staff ? `${staff.text} - ` : ''}${v.text}]`, items: [v, staff, rank].filter(Boolean), n };
    }).filter(Boolean);
    const on = stamp('ON DUTY'), off = stamp('OFF DUTY');
    const rows = [];
    if (on) rows.push({ ...dateOf(on.t), duty: 'C/I', dep: from?.text || '', begin: on.hm, notes: [], _m: [['ci', on.item]] });
    Object.assign(row, { duty: fl?.text || '', registration: reg?.text || '', dep: from?.text || '', arr: to?.text || '', begin: atd.hm, end: ata ? `${ata.hm}${plus(ata)}` : '', crew: crew.map(c => c.text).join(''),
      notes: blk && /[1-9]/.test(blk.text) ? [`[Block: ${blk.text}]`] : [] });
    marks = [['duty', fl], ['registration', reg], ['dep', from], ['arr', to], ['begin', atd.item], ['end', ata?.item], ['crew', crew.flatMap(c => c.items)], ['info', blk]];
    rows.push({ ...dateOf(t), ...row, _m: [['date', d], ...marks] });
    if (off) rows.push({ ...dateOf(t), duty: 'C/O', arr: to?.text || '', end: `${off.hm}${plus(off)}`, notes: [], _m: [['co', off.item]] });
    for (const r of rows) for (const [f, it] of r._m) if (it) mark(r, f, it);
    const out = rows.map(r => outputRow({ ...r, info: r.notes.join(' ') }, 'Z'));
    const p = dateOf(t).date.split(' ');
    return { format: kind, period: `${p[0].padStart(2, '0')}${p[1]}${p[2]} - ${p[0].padStart(2, '0')}${p[1]}${p[2]}`, notices: [], recognized: true, published: out, planned: [], _trace: trace, _rows: rows };
  }
  if (t == null) return null;
  const r = { ...dateOf(t), ...row };
  for (const [f, it] of marks) if (it) mark(r, f, it);
  const p = r.date.split(' ');
  return { format: kind, period: `${p[0].padStart(2, '0')}${p[1]}${p[2]} - ${p[0].padStart(2, '0')}${p[1]}${p[2]}`, notices: [], recognized: true, published: [outputRow({ ...r, info: r.notes.join(' ') }, 'Z')], planned: [], _trace: trace, _rows: [r] };
}

function dateOf(t) {
  const d = new Date(t);
  return { section: 'published', date: `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${String(d.getUTCFullYear() % 100).padStart(2, '0')}`, day: WEEKDAYS[d.getUTCDay()] };
}

const isEmiratesPdf = (page) => page.items.some(i => i.text === 'Emirates Crew Roster (Detailed Report)') && page.items.some(i => i.text === 'Duty Details');

/**
 * The PDF print of "Emirates Crew Roster (Detailed Report)" as the Excel export's grid (its layout reads it,
 * services/table-roster-parser.js): the month ("March 2025") as "Staff : | 01/03/2025", the header cells, a cell per header's
 * column; a day's second leg, on a line of its own, joins the day's cells ("09:25-11:15 12:45-01:15(+)").
 */
function emiratesGrids(pages) {
  const NAMES = ['Day/Date', 'Duty/Trip', 'Label', 'Report', 'Time(Dep-Arv)', 'Duty Details', 'A/C', 'End', 'Block Hours'];
  const all = pages.flatMap(p => p.items.map(i => i.text));
  const mon = all.map(t => /^([A-Z][a-z]+) (\d{4})$/.exec(t)).find(m => m && MONTHS.includes(m[1].slice(0, 3)));
  return pages.map((page) => {
    const head = page.items.find(i => i.text === 'Duty Details');
    if (!head || !mon) return page;
    const line = page.items.filter(i => Math.abs(i.y - head.y) < 8);
    const xs = NAMES.map(n => line.find(i => i.text === n)?.x);
    if (xs.some(x => x == null)) return page;
    const colOf = (x) => xs.reduce((k, cx, j) => (x >= cx - 6 ? j : k), 0);
    const grid = [
      [[{ text: 'Staff :' }], [{ text: `01/${String(MONTHS.indexOf(mon[1].slice(0, 3)) + 1).padStart(2, '0')}/${mon[2]}` }]],
      NAMES.map(n => [{ text: n === 'Duty/Trip' ? 'Duty/Trip Code' : n }]),
    ];
    for (const l of toLines(page.items.filter(i => i.y > head.y + 8))) {
      if (l.items.some(i => /^Total Block Hours/.test(i.text))) break;
      const row = NAMES.map(() => []);
      for (const it of l.items) row[colOf(it.x)].push(it);
      const prev = grid.length > 2 ? grid.at(-1) : null;
      if (!row[0].length && prev) row.forEach((c, k) => prev[k].push(...c)); else grid.push(row);
    }
    return { ...page, grid };
  });
}

function parseAny(pages) {
  if (pages.some(findMonthRosterHeader)) return parseMonthRoster(pages);
  if (isPostflight(pages)) return parsePostflight(pages);
  // CSV / Excel: read by their column headers (services/table-roster-parser.js)
  const table = parseTableRoster(pages, { mark, startTrace });
  if (table) return table;
  if (pages.some(isEmiratesPdf)) { const t = parseTableRoster(emiratesGrids(pages), { mark, startTrace }); if (t?.recognized) return t; }
  if (pages.some(isQatarScheduleReport)) return parseQatarScheduleReport(pages);
  if (pages.some(isSwissRoster)) return parseSwissRoster(pages);
  if (pages.some(isPlanningNavigant)) return parsePlanningNavigant(pages);
  if (pages.some(isIberiaMonthly)) return parseIberiaMonthly(pages);
  if (pages.some(isOfp)) return parseOfp(pages);
  if (pages.some(isScheduleSummary)) return parseScheduleSummary(pages);
  if (pages.some(isPortCrewRosterReport)) return parsePortCrewRosterReport(pages);
  if (pages.some(isFlightLogSummary)) return parseFlightLogSummary(pages);
  if (pages.some(isQatarLogbook)) return parseQatarLogbook(pages);
  if (pages.some(isRolIndividual)) return parseRolIndividual(pages);
  if (pages.some(isFlightSheet)) return parseFlightSheet(pages);
  if (pages.some(isProgrammeDu)) return parseProgrammeDu(pages);
  if (pages.some(isMonthCalendar)) return parseMonthCalendar(pages);
  if (pages.some(isDayLineRoster)) return parseDayLineRoster(pages);
  if (pages.some(isMonthPlanDetail)) return parseMonthPlanDetail(pages);
  if (pages.some(isPilotLogBookReport)) return parsePilotLogBookReport(pages);
  if (pages.some(isSequenceLogbook)) return parseSequenceLogbook(pages);
  if (pages.some(isCrewLegExport)) return parseCrewLegExport(pages);
  if (pages.some(isCarnetDeVol)) return parseCarnetDeVol(pages);
  if (pages.some(isStartEndLogbook)) return parseStartEndLogbook(pages);
  if (pages.some(isCrewAccessDetail)) return parseCrewAccessDetail(pages);
  if (pages.some(isDayTableRoster)) return parseDayTableRoster(pages);
  if (pages.some(isMinhaEscala)) return parseMinhaEscala(pages);
  if (pages.some(isLatamRosterReport)) return parseLatamRosterReport(pages);
  if (pages.some(isCrewScheduleList)) return parseCrewScheduleList(pages);
  if (pages.some(isMonthlyFlightProgram)) return parseMonthlyFlightProgram(pages);
  if (pages.some(isNumberedLogbook)) return parseNumberedLogbook(pages);
  if (pages.some(isRulerLogbook)) return parseRulerLogbook(pages);
  if (pages.some(isAcknowledgedRoster)) return parseAcknowledgedRoster(pages);
  if (pages.some(isCrewBriefing)) return parseCrewBriefing(pages);
  if (pages.some(isLegalBrLogbook)) return parseLegalBrLogbook(pages);
  if (pages.some(isAimsConvertedGrid)) return parseAimsConvertedGrid(pages);
  if (pages.some(isMonthRosterSectors)) return parseMonthRosterSectors(pages);
  if (pages.some(isRocsIndividualPlan)) return parseRocsIndividualPlan(pages);
  if (pages.some(isPortLocalRosterReport)) return parsePortLocalRosterReport(pages);
  if (pages.some(isProgrammazioneIndividuale)) return parseProgrammazioneIndividuale(pages);
  if (pages.some(isFlightInformation)) return parseFlightInformation(pages);
  if (pages.some(isJourneyLog)) return parseJourneyLog(pages);
  const single = isSingleFlightPaper(pages);
  if (single) { const r = parseSingleFlightPaper(pages, single); if (r) return r; }
  if (pages.some(isPerformedActivities)) return parsePerformedActivities(pages);
  if (pages.some(isUtcPilotRoster)) return parseUtcPilotRoster(pages);
  if (pages.some(isNzPublishedRoster)) return parseNzPublishedRoster(pages);
  if (pages.some(isAllegiantRoster)) return parseAllegiantRoster(pages);
  if (pages.some(isLhCas)) return parseLhCas(pages);
  if (pages.some(isReleasedRoster)) return parseReleasedRoster(pages);
  if (pages.some(isTuiWeekGrid)) return parseTuiWeekGrid(pages);
  if (pages.some(isQantasPatterns)) return parseQantasPatterns(pages);
  if (pages.some(isLhCasPlan)) return parseLhCasPlan(pages);
  if (pages.some(isMonthlyOverview)) return parseMonthlyOverview(pages);
  if (pages.some(isFlightDatesTable)) return parseFlightDatesTable(pages);
  if (pages.some(isAirsideExport)) return parseAirsideExport(pages);
  if (pages.some(isCrewMemberRoster)) return parseCrewMemberRoster(pages);
  if (pages.some(isDutyTimesSchedule)) return parseDutyTimesSchedule(pages);
  if (pages.some(isFlightsByCrewMember)) return parseFlightsByCrewMember(pages);
  if (pages.some(isCockpitBriefing)) return parseCockpitBriefing(pages);
  if (pages.some(isArmsRoster)) return parseArmsRoster(pages);
  if (pages.some(isBrHoursReport)) return parseBrHoursReport(pages);
  if (pages.some(isAimsIndividual)) return parseAimsIndividual(pages);
  if (pages.some(isSnRoster)) return parseSnRoster(pages);
  if (pages.some(isJaaLogbook)) return parseJaaLogbook(pages);
  if (pages.some(isKlmCrewRoster)) return parseKlmCrewRoster(pages);
  if (pages.some(isCrewRosterByPeriod)) return parseCrewRosterByPeriod(pages);
  if (pages.some(isKlmFlightHours)) return parseKlmFlightHours(pages);
  if (pages.some(isLotLogbook)) return parseLotLogbook(pages);
  if (pages.some(isFlicaSchedule)) return parseFlicaSchedule(pages);
  if (pages.some(findTripInfoHeader)) return parseTripInformation(pages);
  if (pages.some(findActivityListHeader) || pages.some(p => findActivityListHeader({ ...p, items: joinTouching(p.items) }))) return parseActivityList(pages);
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
export { findPeriod, findNotices, findHotels, findLegend, findGridLegend, findOtherCrew, setDutyCrews, findCrewIdLists, setFlightCrews, findTrainings, isTrainingOf, findMemos, findHotelStays, toLines, PLANNED_RE, MONTHS, monthIndex };
