/**
 * Learned PDF extractor, second half: words already tagged with a field (date,
 * duty, dep, arr, begin, takeoff, landing, end, ac, registration, hotel, dc, info, route, ci, co,
 * co_info, ci_info or O) -> roster rows, in the same shape as the parser
 * (services/pdf-roster-parser.js) and the labels in labels/pdf/.
 *
 * Nothing here knows a layout. Rows come from where the tagged words are:
 *   - pages are cut into blocks when the column header repeats on a line (NetLine
 *     prints 2-3 blocks of days side by side), and read block by block, top down;
 *   - a duty, a hotel code, a C/I or a C/O time starts a row; the other words of
 *     its line go to the nearest such row; a line without one adds to the last
 *     row, or starts a row when that row already has the field or is another day;
 *   - dates in any of the printed forms ("Sun01", "01. Thu", "01Jun24", "14.08.",
 *     "01/07/2024") set the day of the rows after them;
 *   - a page without any date after the days were read (statistics, overtime) adds nothing.
 * Document facts come from the parser's helpers (period, time-zone note, legend,
 * hotel table). How bare durations are written ("[Block: 3:25]") is learned from
 * the labels (`conventions`), keyed by the column header above them;
 * conventions.ocr (roster images): airport codes read with digits are repaired.
 *
 *   assembleRows(tagPages, pdfPages, conventions) -> { published, planned }
 *   learnConventions(tagPages, label) -> conventions of one labeled file (merge with mergeConventions)
 * tagPages: [{ width, height, tokens: [{ t, x, y, w, field }] }], pdfPages: readPdfText() pages.
 */
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { hotelAsEvent, hotelFromEvent, findPeriod, findNotices, findHotels, findLegend, findGridLegend, findOtherCrew, setDutyCrews, findCrewIdLists, setFlightCrews, findTrainings, isTrainingOf, findMemos, findHotelStays, PLANNED_RE, MONTHS, monthIndex, formatTime } from './pdf-roster-parser.js';
import { repairImageRows } from './roster-parser.js';
import { looseTime } from './table-roster-parser.js';

const HEADER_WORDS = new Set(JSON.parse(fs.readFileSync(fileURLToPath(new URL('./pdf-header-words.json', import.meta.url)), 'utf8')));
/** Column-header words: the base list plus those the model learned from labeled layouts (conventions.headerWords). */
export const headerWordsOf = (conventions = {}) => (conventions.headerWords?.length ? new Set([...HEADER_WORDS, ...conventions.headerWords]) : HEADER_WORDS);
const headerWordOk = (w) => /^\p{Ll}[\p{Ll}/().-]{1,20}$/u.test(w); // ("função", "vôo")
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const DAY_NAMES = {
  mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6, sun: 0,
  lunes: 1, martes: 2, miércoles: 3, miercoles: 3, jueves: 4, viernes: 5, sábado: 6, sabado: 6, domingo: 0,
};
// The planned part starts at: a NetLine plan's note, an image roster's second table title.
const PLANNED_LINE = [PLANNED_RE, /REST\s*[O0()D]?F\s*TH?I?S?\s*ROS[TI]ER\s*IS\s*P[L1I]?ANNED/i]; // OCR slips: "THERESTOFTHSROSTERISPLANNED", "REST)F", "ROSIER"
export const HOTEL_CODE_RE = /^H(\d+\*?|\?)$/;
const DURATION_RE = /^\d{1,3}:\d{2}$/;
const COUNT_RE = /^\d{1,3}$/; // a take-off / landing count ("1" under "TKoffsDay")
const DECIMAL_RE = /^\d{1,3},\d{1,2}$/; // decimal hours ("1,6" = 01:36), written as a duration where the labels do
const hoursOf = (t) => { const m = Math.round(+t.replace(',', '.') * 60); return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`; };
// a duration printed as whole minutes ("631" = 10:31), written as hh:mm where the labels do (learned per layout and column)
const MINUTES_RE = /^\d{2,4}$/;
const minutesOf = (t) => `${String(Math.floor(+t / 60)).padStart(2, '0')}:${String(+t % 60).padStart(2, '0')}`;
const VALUE_RE = /^(\d{1,3}:\d{2}|\d{1,3}|\d{1,3},\d{1,2})$/;
const INFO_FIELDS = new Set(['info', 'co_info', 'ci_info']);
// a printed key and its value(s): "BLK=6:22", "FDP=9:25[12:30]", "DUTY=" (the value on the next line)
const PAIR_RE = /^([A-Za-z][A-Za-z_]*)=(\d{1,3}:\d{2})?(?:\[(\d{1,3}:\d{2})\])?$/;
const TIME_IN_RE = /[AE]?!?\d{2}:?\d{2}([+-]\d(?!\d))?/g; // "A02:00": the A (actual) / E (estimated) stays
const ANCHORS = new Set(['duty', 'hotel', 'ci', 'co']);
const TIME_FIELDS = new Set(['begin', 'end', 'ci', 'co', 'takeoff', 'landing']);
const TIME_ONLY_RE = /^[AE]?!?\d{1,2}:?\d{2}(:\d{2})?([+-]\d)?$/;
// the parts of one crew member in a list ("AndreVanDerPut(475495-FO)" -> AndreVanDerPut, 475495, FO)
// (a name keeps its own dashes, "Marc-Olivier": only what is in brackets is split at them)
const crewParts = (item) => {
  const m = /^(.*?)\((.*)\)\s*$/.exec(item.trim());
  return (m ? [m[1], ...m[2].split('-')] : item.split(/\s+-\s+/)).map(p => p.trim()).filter(Boolean);
};
// A crew list as some exports print it: "NAME - FA,NAME - CA" (names only: "CP - PIC - 1096 - NAME" with staff numbers is another way) (written "[FA - NAME][CA - NAME]", as the parser does)
const CREW_LIST_RE = /\S\s+-\s+[A-Z]{2,4}\s*,/; // (a list: a comma after the first role; "Zacharoula - ZMO" is a name and initials)
function crewListTags(text) {
  const t = text.replace(/\s+/g, ' ').trim();
  const list = [...t.matchAll(/\s*([^,]+?)\s+-\s+([A-Z]{2,4})\s*(?:,|$)/g)];
  return list.length && list.map(c => c[0]).join('').replace(/\s/g, '') === t.replace(/\s/g, '') ? list.map(c => `[${c[2]} - ${c[1].trim()}]`).join('') : t;
}

/**
 * Crew words as members: one per "CP - ..." line, a name running on joins it ("[CP - NAME]").
 * With roles (isRole: a word the labels write as one, conventions.crewRoles), a "Pilot:" / "Cabin:" line is the
 * role of the names under it, one per line: "©PECOT Cyril (CYP)" -> "[Pilot - CYP - PECOT Cyril]".
 */
function crewMembers(spans, isRole = () => false) {
  const sorted = [...spans].sort((a, b) => a.tokens[0].y - b.tokens[0].y || a.x - b.x);
  const roleOf = (text) => { const r = /^([A-Z][a-z]+):\s*(.*)$/.exec(text); return r && isRole(r[1]) ? r : null; };
  const roles = sorted.some(s => roleOf(s.text.trim()));
  const members = [];
  let lastY = null;
  for (const s of sorted) {
    const text = s.text.replace(/\s+/g, ' ').trim();
    // (with roles a member is a line: "PECOT Cyril" "(CYP)" printed apart)
    const sameLine = roles && lastY != null && Math.abs(s.tokens[0].y - lastY) < 2;
    lastY = s.tokens[0].y;
    if (roles ? !sameLine : /^[A-Z]{2,3} - /.test(text) || !members.length) members.push(text);
    else members[members.length - 1] = roles ? `${members[members.length - 1]} ${text}` : `${members[members.length - 1].replace(/\s*-$/, ' -')} ${text}`;
  }
  // (a member with no letter or digit is an empty cell's mark: "-")
  const kept = members.filter(m => /[\p{L}\p{N}]/u.test(m));
  if (!roles) return kept.map(m => `[${m}]`).join('');
  let role = '';
  const out = [];
  for (const m of kept) {
    const r = roleOf(m);
    if (r) { role = r[1]; if (!r[2]) continue; }
    const t = (r ? r[2] : m).replace(/^©/, '');
    const c = /^(.*?)\s*\(([A-Z]{2,4})\)$/.exec(t);
    out.push(role ? (c ? `[${role} - ${c[2]} - ${c[1].trim()}]` : `[${role} - ${t}]`) : `[${t}]`);
  }
  return out.join('');
}

export function toLines(tokens, tol = 1.5) {
  const lines = [];
  for (const t of [...tokens].sort((a, b) => a.y - b.y || a.x - b.x)) {
    const last = lines[lines.length - 1];
    if (last && Math.abs(t.y - last.y) <= tol) last.tokens.push(t);
    else lines.push({ y: t.y, tokens: [t] });
  }
  for (const l of lines) l.tokens.sort((a, b) => a.x - b.x);
  return lines;
}

/**
 * Header lines of a page: several known column-header words, most of the line (a word tagged as a value is not a header).
 * The page's first line may also be a spreadsheet export's header: many known words among dozens of columns
 * no roster reads ("Mountain Landings > 2000m").
 */
export function headerLines(lines, words = HEADER_WORDS) {
  // (a database export's column names, "duty_start", "dep_stat", "flt_dt_utc": a known word as one of its parts)
  const known = (w) => words.has(w) || (/[_]/.test(w) && w.split('_').some(p => p.length > 1 && words.has(p)));
  const headers = lines.filter((l, k) => {
    const hit = l.tokens.filter(t => known(t.t.toLowerCase()) && (!t.field || t.field === 'O'));
    const hits = hit.length;
    const kinds = new Set(hit.map(t => t.t.toLowerCase())).size;
    // (3 different words: not a line of day codes, "FlD Off Off Vac Vac Vac")
    if (kinds < 3) return false;
    // (not a strip of weekdays over a month, "CRM Sat Sun Mon ... Mon" of a NetLine plan: a weekday twice; a week's
    // columns "Monday Tuesday ..." name each day once; a month's calendar has its dates right under them, "1 2 3 ...")
    const weekdays = hit.filter(t => WEEKDAY_WORD_RE.test(t.t)).map(t => t.t.toLowerCase().replace(/\.$/, ''));
    const datesUnder = lines[k + 1]?.tokens.some(t => t.field === 'date');
    if (weekdays.length > hits / 2 && new Set(weekdays).size < weekdays.length && !datesUnder) return false;
    // (nor a strip of day codes, "Sby FlD FlD Off Off Vac Vac Vac ...": a few words over and over, side by side; a header
    // repeats some among many others, "TIJD TIJD", "FDP FDP FDP duty work rest rest rest rest", or whole blocks,
    // "Code Descr. Flight ... Crew Code Descr. Flight ...")
    const twice = l.tokens.some((t, i) => i && t.t.toLowerCase() === l.tokens[i - 1].t.toLowerCase() && known(t.t.toLowerCase()));
    if (kinds * 3 < hits && twice) return false;
    // (not a line of totals, "Total Stick Time: 596: 51")
    const numbers = l.tokens.filter(t => /\d/.test(t.t)).length;
    // (not a title naming the crew member, "Individual duty plan for VOGELS, MAX", "BRUINESSEN,van, MAX"; "Make, Model, Var." is a header)
    if (l.tokens.some(t => /^\p{Lu}{2,}\S*,$/u.test(t.t))) return false;
    return hits >= 3 && numbers < hits / 2 && (hits >= 0.5 * l.tokens.length || (k === 0 && hits >= 8));
  });
  // The table's column header: the first one right above a line of row words (not a title over it, "Flight Time Report",
  // nor the upper line of a header over two lines)
  // (a row's line: 2+ tagged words, not one stray word under a title, "FO" of "FO - NAME #490575")
  const above = (n) => headers.find((h) => { const next = lines[lines.indexOf(h) + 1]; return next && !headers.includes(next) && next.tokens.filter(t => t.field && t.field !== 'O').length >= n; });
  const main = above(2) || above(1);
  if (main) main.main = true;
  return headers;
}

/**
 * x ranges of the blocks: where the header's first word repeats on its line,
 * each repeat starting a full header of its own (3+ header words).
 */
export function blockStarts(headers, words = HEADER_WORDS) {
  // The page's first column header (a later "header" may be another table: "Start Date End Date # Start Date ...").
  for (const header of headers.slice(0, 1)) {
    const first = header.tokens[0].t.toLowerCase();
    const at = header.tokens.map((t, i) => (t.t.toLowerCase() === first ? i : -1)).filter(i => i >= 0);
    if (at.length < 2) continue;
    const groups = at.map((i, k) => header.tokens.slice(i, at[k + 1] ?? header.tokens.length));
    if (groups.every(g => g.filter(t => words.has(t.t.toLowerCase())).length >= 3)) {
      const starts = at.map(i => header.tokens[i].x - 10);
      starts[0] = -Infinity;
      return starts;
    }
  }
  return [-Infinity];
}

/**
 * Header cell at or left of x: header words with small gaps between them form a
 * cell ("Blk Hrs", "Duty Hrs"). Its text, lower case, is the cell's key.
 */
function headerAt(header, x) {
  if (!header) return null;
  const toks = header.tokens;
  const cells = [];
  for (const t of toks) {
    const last = cells[cells.length - 1];
    const prev = last?.[last.length - 1];
    if (prev && t.x - (prev.x + (prev.w || prev.t.length * 4.5)) < 6) last.push(t); else cells.push([t]);
  }
  const left = cells.filter(c => c[0].x <= x + 4);
  const cell = left.length ? left[left.length - 1] : cells[0];
  const wordOf = c => c.map(t => t.t.toLowerCase()).join(' ');
  const word = wordOf(cell);
  // a header word printed twice ("TOFF Day | Night", "LND Day | Night"): which one, for what is learned per column
  const same = cells.filter(c => wordOf(c) === word);
  return { word, key: same.length > 1 ? `${word}#${same.indexOf(cell) + 1}` : word };
}

/**
 * The header cell of a number: the one whose middle is nearest its middle. Numbers are mostly right-aligned,
 * so one stands left of its own header word ("00:56" under "Night", "00:00" under "Total"), under the cell
 * before it by headerAt.
 */
function headerOfNumber(header, t) {
  if (!header) return null;
  const cells = [];
  for (const h of header.tokens) {
    const last = cells[cells.length - 1];
    const prev = last?.[last.length - 1];
    if (prev && h.x - (prev.x + (prev.w || prev.t.length * 4.5)) < 6) last.push(h); else cells.push([h]);
  }
  const mid = c => (c[0].x + c[c.length - 1].x + (c[c.length - 1].w || c[c.length - 1].t.length * 4.5)) / 2;
  const x = t.x + (t.w || t.t.length * 4.5) / 2;
  const cell = cells.reduce((a, c) => (Math.abs(mid(c) - x) < Math.abs(mid(a) - x) ? c : a));
  const wordOf = c => c.map(h => h.t.toLowerCase()).join(' ');
  const word = wordOf(cell);
  const same = cells.filter(c => wordOf(c) === word);
  return { word, key: same.length > 1 ? `${word}#${same.indexOf(cell) + 1}` : word };
}
const ZERO_RE = /^0{1,2}:00$|^0$|^0+,0+$/;

/** Is the column of x marked as UTC ("UTC", "(Z)") on any header line above? */
function utcColumn(headers, x) {
  for (const h of headers) {
    const left = h.tokens.filter(t => t.x <= x + 4);
    const w = left[left.length - 1];
    if (w && /^(utc|\(z\)|utc!)$/i.test(w.t)) return true;
    const near = h.tokens.find(t => Math.abs(t.x - x) < 25 && /^(utc|\(z\))$/i.test(t.t));
    if (near) return true;
  }
  return false;
}

/** "Sun01", "01. Thu", "01Jun24", "14.08.", "01/07/2024", "Lunes 01/07/2024", "2024 8 14.08." -> parts. */
// Month names as OCR misreads them ("F6b", "0ct", "Ju1", "Sp") -> the name.
const OCR_MONTHS = [[/\bF[6b]b\b|\bFb\b/g, 'Feb'], [/\b[0O]ct?\b|\b0c\b/g, 'Oct'], [/\bJu[1l]\b/g, 'Jul'], [/\bS[e]?p\b/g, 'Sep'], [/\bMa[yv]\b/g, 'May'], [/\bDe[cç]\b/g, 'Dec']];

const WEEKDAY_WORD = { mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6, sun: 0 };

export function parseDateText(text) {
  for (const [re, to] of OCR_MONTHS) text = text.replace(re, to);
  // A month name in capitals or another language ("SEP", "25JAN2024", "01AGO21", "OUT"): its English name, as the patterns below read it
  text = text.replace(/(?<![A-Za-z])([A-Za-z]{3})(?![A-Za-z])/g, (w) => {
    const k = monthIndex(w);
    return k >= 0 && (w === w.toUpperCase() || w[0] === w[0].toUpperCase()) ? MONTHS[k] : w;
  });
  const words = text.split(/\s+/);
  const out = {};
  let m;
  // Year first: "2024-01-01", "2025/08/05", "20240501", "2024-05-21T18:00:00Z"
  if ((m = /(?:^|\s)((?:19|20)\d{2})([-/]?)(\d{2})\2(\d{2})(?=T|\s|$)/.exec(text)) && +m[3] >= 1 && +m[3] <= 12 && +m[4] >= 1 && +m[4] <= 31) {
    return { day: +m[4], month: +m[3] - 1, year: +m[1] % 100 };
  }
  // A day with its weekday after it: "20SAT", "01-SAT", "05 Mon"
  if ((m = /^(\d{1,2})[-\s.]?(mon|tue|wed|thu|fri|sat|sun)[a-z]*\.?$/i.exec(text.trim()))) return { day: +m[1], weekday: WEEKDAY_WORD[m[2].toLowerCase()] };
  for (const w of words) {
    const name = DAY_NAMES[w.toLowerCase().replace(/[.,]$/, '').slice(0, w.length > 4 ? undefined : 3)];
    if (name != null && !/\d/.test(w)) out.weekday = name;
  }
  // A weekday glued to the day by OCR: "Th11", "Thu14", "Fr112" (= Fri 12, "i" read as 1).
  const glued = /(?:^|\s)(Mo|Tu|We|Th|Fr|Sa|Su)[a-z]{0,4}[,.]?(\d{1,3})(?!\d)/i.exec(text);
  if (glued && !/^(Mon|Tue|Wed|Thu|Fri|Sat|Sun)\d{2}$/.test(text.trim())) {
    out.weekday = { mo: 1, tu: 2, we: 3, th: 4, fr: 5, sa: 6, su: 0 }[glued[1].toLowerCase()];
    text = text.replace(glued[0], ` ${glued[2].length === 3 ? glued[2].slice(1) : glued[2]}`);
  }
  // "14 Feb 20", "Mon10 Feb 20", "25 Feb" (an image roster's date cell; a year cut off by OCR is carried on).
  const spaced = new RegExp(`(\\d{1,2})(?:\\s+|-|(?=[A-Z]))(${MONTHS.join('|')})[a-z]*\\.?(?:(?:\\s+|-)?(\\d{4}|\\d{2})(?!\\d))?`).exec(text);
  if (spaced) {
    Object.assign(out, { day: +spaced[1], month: MONTHS.indexOf(spaced[2]) });
    if (spaced[3]) out.year = +spaced[3] % 100;
  } else if ((m = new RegExp(`(${MONTHS.join('|')})[a-z]*\\.?\\s+(\\d{1,2}),?\\s+(\\d{4})(?!\\d)`).exec(text))) {
    Object.assign(out, { day: +m[2], month: MONTHS.indexOf(m[1]), year: +m[3] % 100 }); // "Jun 21 2024"
  } else if ((m = /(\d{1,2})[/.-](\d{1,2})[/.-](\d{4}|\d{2})(?!\d)/.exec(text))) Object.assign(out, { day: +m[1], month: +m[2] - 1, year: +m[3] % 100, numeric: true }); // "22/02/24" too
  else if ((m = /(\d{1,2})([A-Z][a-z]{2})(\d{2})/.exec(text)) && MONTHS.includes(m[2])) Object.assign(out, { day: +m[1], month: MONTHS.indexOf(m[2]), year: +m[3] });
  else if ((m = /(?:^|\s)(\d{1,2})\.(\d{1,2})\.(?:\s|$)/.exec(text))) {
    Object.assign(out, { day: +m[1], month: +m[2] - 1 });
    const y = words.find(w => /^(19|20)\d{2}$/.test(w));
    if (y) out.year = +y % 100;
  } else if ((m = /^(\d{1,2})\/(\d{1,2})$/.exec(text.trim())) && +m[2] >= 1 && +m[2] <= 12) Object.assign(out, { day: +m[1], month: +m[2] - 1 }); // "04/01" (day/month, pdf-text.js)
  else if ((m = /^([A-Za-z]{3})(\d{1,2})$/.exec(text)) && DAY_NAMES[m[1].toLowerCase()] != null) Object.assign(out, { day: +m[2], weekday: DAY_NAMES[m[1].toLowerCase()] });
  else if ((m = new RegExp(`(${MONTHS.join('|')})[a-z]*\\.?\\s+(\\d{2})(?!\\d)`).exec(text))) {
    // "Wed Feb 20": the number after the month is the year (OCR lost the day number).
    Object.assign(out, { month: MONTHS.indexOf(m[1]), year: +m[2] });
  } else if ((m = /(?:^|\s)(\d{1,2})\.?(?:\s|$)/.exec(text))) out.day = +m[1];
  // A weekday alone ("Wed Feb 20" with the day number lost by OCR) still says which day follows.
  return out.day ? out : out.weekday != null ? out : null;
}

const weekdayOf = (d) => new Date(2000 + d.year, d.month, d.day).getDay();

/**
 * Full dates for the rows' date parts. A day number alone counts on from the
 * period start (a smaller number is the next month); when the printed weekdays
 * disagree, the first month of the period that fits them all is used.
 */
function resolveDates(parts, period) {
  // "05/13/2024": the month first, in the whole document, when its dates fit that way better (a month 13, the weekdays)
  const swap = p => (p?.numeric && p.day <= 12 ? { ...p, day: p.month + 1, month: p.day - 1 } : p);
  const numeric = parts.filter(p => p?.numeric && p.year != null);
  if (numeric.length && numeric.every(p => p.day <= 12)) {
    const wrong = (list) => list.filter(p => p.month > 11 || (p.weekday != null && weekdayOf(p) !== p.weekday)).length;
    if (wrong(numeric.map(swap)) < wrong(numeric)) parts = parts.map(swap);
  }
  const run = (start) => {
    let month = start?.month ?? 0, year = start?.year ?? 0, last = null;
    return parts.map((p) => {
      if (!p || !p.day) return null; // weekday only: placed after the previous row below
      if (p.month != null && p.year != null) { month = p.month; year = p.year; last = p.day; return { day: p.day, month, year }; }
      if (p.month != null) {
        // ("05/12" then "21/01": the next year)
        if (last != null && p.month < month - 6) year += 1;
        month = p.month; last = p.day; return { day: p.day, month, year };
      }
      if (last != null && p.day < last) { month += 1; if (month > 11) { month = 0; year += 1; } }
      last = p.day;
      return { day: p.day, month, year };
    });
  };
  const misses = (dates) => dates.filter((d, i) => d && parts[i].weekday != null && weekdayOf(d) !== parts[i].weekday).length;
  let dates = run(period?.from);
  if (period?.from && period?.to && misses(dates)) {
    for (let y = period.from.year, m = period.from.month; y < period.to.year || (y === period.to.year && m <= period.to.month); m += 1) {
      if (m > 11) { m = 0; y += 1; }
      const cand = run({ month: m, year: y });
      if (!misses(cand)) { dates = cand; break; }
    }
  }
  // Rosters run in order. A date whose weekday disagrees, or a day without month and weekday that goes
  // back or jumps more than two weeks ahead (OCR: "20 Apr" for "3 Apr", "7 Jan" for "27 Jan"), is taken
  // as the first day from the previous row's date on with its weekday or day number; else that date.
  const dayNo = d => Date.UTC(2000 + d.year, d.month, d.day) / 86400000;
  const fromNo = n => { const c = new Date(n * 86400000); return { day: c.getUTCDate(), month: c.getUTCMonth(), year: c.getUTCFullYear() - 2000 }; };
  let prev = null;
  dates.forEach((d, i) => {
    const p = parts[i];
    if (!d && p && p.weekday != null && !p.day && prev) {
      for (let k = 1; k <= 7 && !dates[i]; k++) { const c = fromNo(dayNo(prev) + k); if (weekdayOf(c) === p.weekday) dates[i] = c; }
    } else if (d && prev && p) {
      const full = p.month != null && p.year != null;
      const wOk = p.weekday == null || weekdayOf(d) === p.weekday;
      const diff = dayNo(d) - dayNo(prev);
      // A day number with its weekday agreeing ("Sun22") is trusted even after a long gap; so is a day with its
      // month after a gap ("22/03" then "10/08", months without flights) when the next date goes on from it.
      const next = dates[i + 1], nextDiff = next && dayNo(next) - dayNo(d);
      const goesOn = p.month != null && parts[i + 1]?.month != null && diff > 14 && nextDiff >= 0 && nextDiff <= 14;
      if (!wOk || (!full && p.weekday == null && !goesOn && (diff < 0 || diff > 14))) {
        let fixed = null;
        for (let k = 0; k <= 14 && !fixed; k++) {
          const c = fromNo(dayNo(prev) + k);
          if (p.weekday != null ? weekdayOf(c) === p.weekday && k <= 6 : c.day === p.day) fixed = c;
        }
        dates[i] = fixed || (full ? d : { ...prev });
      }
    }
    if (dates[i]) prev = dates[i];
  });
  return dates;
}

/** "[ FT 05:49 ]" -> "[FT 05:49]", "[FT 07:15][DT 09:50]" -> "[FT 07:15] [DT 09:50]". */
const tidyInfo = (s) => s.replace(/\[\s+/g, '[').replace(/\s+]/g, ']').replace(/([\])])(?=[[(])/g, '$1 ').replace(/\s+/g, ' ').trim();

/** Times of a begin/end cell: "0800", "!1300", "2100-1", or two ("00:00 05:00": local and UTC by the header). */
function formatTimes(span, plain, headers) {
  // ("15 : 00": a time printed in pieces)
  if (/\d\s+:\s*\d|\d\s*:\s+\d/.test(span.text)) span = { ...span, text: span.text.replace(/(\d)\s*:\s*(\d)/g, '$1:$2') };
  const times = span.tokens.filter(t => /\d{2}:?\d{2}/.test(t.t));
  if (times.length === 2) {
    const [a, b] = times;
    // "09:00" with "[10:00]" under it: the local time in brackets ("LT of Arr & Dep: Times in Brackets")
    const local = /^\[(\d{1,2}:\d{2})]$/.exec(b.t);
    if (local && TIME_ONLY_RE.test(a.t)) return `${formatTime(a.t + (/([+-]\d)$/.exec(span.text)?.[1] || ''), plain)} / ${formatTime(local[1], 'L')}`;
    const aUtc = utcColumn(headers, a.x), bUtc = utcColumn(headers, b.x);
    if (aUtc !== bUtc) {
      const [z, l] = aUtc ? [a, b] : [b, a];
      return `${formatTime(z.t, 'Z')} / ${formatTime(l.t, 'L')}`;
    }
  }
  // (a time with a colon before four digits that may be a year: "16/02/2013, 23:00:00")
  const m = (span.text.match(/[AE]?!?\d{2}:\d{2}(?::\d{2})?([+-]\d(?!\d))?/g) || span.text.match(TIME_IN_RE))?.map(t => t.replace(/(\d{2}:\d{2}):\d{2}/, '$1'));
  // table exports: "601" (06:01), "8:25PM", "2259+" (next day)
  if (!m || /^\d{1,4}\+$/.test(span.text.trim())) return looseTime(span.text.trim(), plain) || span.text;
  return formatTime(m[0], plain);
}

/**
 * Words the tagger left out of a text it tagged around them: a lone closing
 * bracket after info ("[ FT 05:49 ]"), a word between two info words.
 */
function smoothLine(tokens) {
  for (let i = 1; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.field !== 'O') continue;
    const prev = tokens[i - 1], next = tokens[i + 1];
    const close = (a, b) => b.x - (a.x + (a.w || a.t.length * 4.5)) < 12;
    if (prev.field === 'info' && /^[\])]$/.test(t.t) && close(prev, t)) t.field = 'info';
    else if (prev.field === 'info' && next?.field === 'info' && close(prev, t) && close(t, next)) t.field = 'info';
  }
}

/** Spans: neighbouring words of one line with the same field (a wide gap between them: two cells, two spans). */
function spansOf(tokens, header = null) {
  const spans = [];
  // (a value or a mark, "15:37" / "Y", under another column's header than the one before it: another cell, however close)
  const mark = (s) => VALUE_RE.test(s) || /^[A-Z]$/.test(s);
  const otherColumn = (a, b) => header && mark(a.t) && mark(b.t) && headerAt(header, a.x)?.key !== headerAt(header, b.x)?.key;
  for (const t of tokens) {
    const last = spans[spans.length - 1];
    const prev = last?.tokens[last.tokens.length - 1];
    // (two values side by side, "1" "01:09", are two info cells, not one)
    const cells = INFO_FIELDS.has(t.field) && ((VALUE_RE.test(t.t) && VALUE_RE.test(prev?.t || '')) || (prev && otherColumn(prev, t)));
    if (last && last.field === t.field && !cells && t.x - (prev.x + widthOf(prev)) < 25) { last.tokens.push(t); last.text += ` ${t.t}`; } else spans.push({ field: t.field, tokens: [t], text: t.t, x: t.x });
  }
  return spans.filter(s => s.field !== 'O');
}

/**
 * The page's lines in reading order, as the assembler reads them: page by page,
 * block by block, top down, below the column header. [{ page, block, y, tokens }]
 */
export function readingLines(tagPages) {
  const out = [];
  let lastHeaders = [];
  tagPages.forEach((page, pi) => {
    const allLines = toLines(page.tokens);
    const headers = headerLines(allLines);
    if (headers.length) lastHeaders = headers;
    const lines = headers.length ? allLines.filter(l => l.y > headers[0].y + 1) : allLines;
    const starts = blockStarts(headers.length ? headers : lastHeaders);
    const blockOf = x => starts.filter(s => x >= s).length - 1;
    for (let b = 0; b < starts.length; b++) {
      for (const l of lines) {
        const tokens = l.tokens.filter(t => blockOf(t.x) === b);
        if (tokens.length) out.push({ page: pi, block: b, y: l.y, tokens });
      }
    }
  });
  return out;
}

/** The table layout a header line stands for (its words), the key of what is learned per layout. */
const layoutKey = (header) => (header ? header.tokens.map(t => t.t.toLowerCase()).join(' ') : '');
// The table's column header among a page's header lines (headerLines)
const mainHeader = (headers) => (headers?.length ? headers.find(h => h.main) || headers[0] : null);
const noticeKey = (n) => n.toLowerCase().replace(/\s+/g, ' ').trim();
const widthOf = (t) => t.w || t.t.length * 4.5;
const WEEKDAY_WORD_RE = /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun|Lunes|Martes|Mi[ée]rcoles|Jueves|Viernes|S[áa]bado|Domingo)\.?$/i;

/**
 * Day columns: a line holding 7+ full dates side by side ("01/07" ... "31/07")
 * heads a calendar grid, one column per day with its events stacked under its
 * date. The grid ends at the first wide text under it (a table title such as
 * "Total Hours and Statistics"). -> { y, endY, pitch, cols: [{ cx, date }] } | null
 */
function dayColumns(lines) {
  for (const l of lines) {
    const dated = l.tokens.map(t => ({ t, d: parseDateText(t.t) })).filter(({ d }) => d?.day && d.month != null);
    if (dated.length < 7) continue;
    const cols = dated.map(({ t, d }) => ({ cx: t.x + widthOf(t) / 2, date: { ...d, text: t.t } })).sort((a, b) => a.cx - b.cx);
    const pitch = (cols[cols.length - 1].cx - cols[0].cx) / (cols.length - 1);
    const wide = lines.find(m => m.y > l.y + 2 && m.tokens.some(t => widthOf(t) > 1.5 * pitch));
    return { y: l.y, endY: wide ? wide.y : Infinity, pitch, cols };
  }
  return null;
}

/**
 * Dates of a block for layouts whose date stands in the middle of its day
 * (vertically centred on the day's events): one per date, at the middle of the
 * date and a weekday printed right under it ("02/12/2024" / "Mon").
 */
function centredDates(lines) {
  const out = [];
  for (const l of lines) {
    const s = l.tokens.find(t => t.field === 'date');
    const d = s && parseDateText(l.tokens.filter(t => t.field === 'date').map(t => t.t).join(' '));
    if (!d?.day) continue;
    const wd = lines.find(m => m.y > l.y + 1 && m.y - l.y < 15 && m.tokens.some(t => WEEKDAY_WORD_RE.test(t.t) && Math.abs(t.x - s.x) < 30));
    out.push({ y: wd ? (l.y + wd.y) / 2 : l.y, date: { ...d, text: s.t } });
  }
  return out;
}

/**
 * The lines of each centred day: from the first line after the day before, down
 * as far below its date as that first line is above it (a day's date stands in
 * the middle of its lines, however many). The events and the crew lists beside
 * them are placed apart (a crew list can be taller than the day's events); a
 * line left over takes the nearest date. -> Map(line -> date)
 */
function centredDays(lines, dates, { crew = false } = {}) {
  const out = new Map();
  const own = lines.filter(l => (crew ? l.tokens.some(t => t.field === 'crew') : l.tokens.some(t => t.field !== 'crew' && t.field !== 'O')));
  const reach = crew ? 250 : 80;
  let i = 0;
  for (const d of [...dates].sort((a, b) => a.y - b.y)) {
    while (i < own.length && d.y - own[i].y > reach) i++;
    if (i >= own.length || own[i].y > d.y + 2) continue;
    const last = 2 * d.y - own[i].y;
    while (i < own.length && own[i].y <= last + 3) out.set(own[i++], d);
  }
  return out;
}

/** Zone of a time printed without "!": what the labels of a document saying the same thing used, else those of its layout
 * (its column header), else the plan's note, else UTC. */
function plainZone(notices, conventions, layout = '') {
  for (const n of notices) { const z = conventions.zone?.[noticeKey(n)]; if (z) return z; }
  // (a document with a note of its own goes by it: one layout prints its times in different zones by its note)
  const byLayout = !notices.length && layout && conventions.zone?.[`layout:${layout}`];
  if (byLayout) return byLayout;
  const has = re => notices.some(n => re.test(n));
  return has(/homebase timezone/i) ? 'B' : has(/departure airport timezone/i) ? 'LB' : has(/times are local/i) ? 'L' : 'Z';
}

/**
 * The period of a document the parser's findPeriod does not know: from its full dates ("03-SEP-2024",
 * "2025/08/05", "01Jun24") and month names with a year ("June 2026", "oktober 2022"), first to last.
 */
const MONTH_WORDS = { jan: 0, january: 0, januari: 0, janvier: 0, enero: 0, janeiro: 0, feb: 1, february: 1, februari: 1, febrero: 1, fevereiro: 1,
  mar: 2, march: 2, maart: 2, marzo: 2, 'março': 2, apr: 3, april: 3, abril: 3, may: 4, mei: 4, mayo: 4, maio: 4, jun: 5, june: 5, juni: 5, junio: 5, junho: 5,
  jul: 6, july: 6, juli: 6, julio: 6, julho: 6, aug: 7, august: 7, augustus: 7, agosto: 7, sep: 8, sept: 8, september: 8, septiembre: 8, setembro: 8,
  oct: 9, october: 9, oktober: 9, octubre: 9, outubro: 9, nov: 10, november: 10, noviembre: 10, novembro: 10, dec: 11, december: 11, diciembre: 11, dezembro: 11 };
export function documentPeriod(pdfPages) {
  const found = [];
  for (const p of pdfPages) {
    for (const it of p.items) {
      const text = String(it.text || '');
      for (const w of text.split(/\s+(?=\d)/)) {
        const d = /\d/.test(w) && w.length <= 30 ? parseDateText(w) : null;
        if (d?.day && d.month != null && d.year != null && d.month >= 0) found.push(d);
      }
      for (const mm of text.matchAll(/([A-Za-zçÇ]{3,10})\.?\s+((?:19|20)\d{2})(?!\d)/g)) {
        const k = MONTH_WORDS[mm[1].toLowerCase()];
        if (k != null) found.push({ day: 1, month: k, year: +mm[2] % 100, whole: true });
      }
    }
  }
  // ("05/31/2024": the month first, in the whole document)
  const numeric = found.filter(d => d.numeric);
  if (numeric.some(d => d.month > 11) && numeric.every(d => d.day <= 12)) for (const d of numeric) [d.day, d.month] = [d.month + 1, d.day - 1];
  for (let i = found.length - 1; i >= 0; i--) if (found[i].month > 11) found.splice(i, 1);
  if (!found.length) return null;
  const key = d => (d.year * 12 + d.month) * 32 + d.day;
  const from = found.reduce((a, b) => (key(b) < key(a) ? b : a));
  const to = found.reduce((a, b) => (key(b) > key(a) ? b : a));
  return { from: { day: from.day, month: from.month, year: from.year }, to: { day: to.whole ? 28 : to.day, month: to.month, year: to.year } };
}

/** The layout of a document: its first column header line ('grid' for a calendar of day columns). */
function fileLayoutOf(tagPages, words) {
  for (const page of tagPages) {
    const lines = toLines(page.tokens);
    if (dayColumns(lines)) return 'grid';
    const h = headerLines(lines, words);
    if (h.length) return layoutKey(mainHeader(h));
  }
  return '';
}

/**
 * Tagger slips that would break many rows, put right before the rows are made:
 *  - a lone number tagged date where the document's dates are written with letters ("Mon27", "27Jan25"):
 *    "Route Qualification Session 2", not a date; it would move every row after it to another day.
 *    It takes the field of the word before it on its line (else O).
 *  - in OCR text (a roster picture), a time zone letter tagged duty right after a time ("10:35 Z"): it would
 *    start a row (a PDF's duty may be "L", activity-calendar).
 */
function repairSlips(tagPages, ocr) {
  const dates = tagPages.flatMap(p => p.tokens.filter(t => t.field === 'date'));
  const bare = (t) => /^\d{1,2}$/.test(t.t);
  const lettered = dates.length >= 5 && dates.filter(t => /\p{L}/u.test(t.t)).length >= 0.9 * dates.length;
  const isTime = (t) => /^\d{1,2}:?\d{2}$/.test(t?.t || '');
  return tagPages.map(p => {
    const zone = (t) => ocr && t.field === 'duty' && /^[ZL]$/.test(t.t);
    if (!p.tokens.some(t => (lettered && t.field === 'date' && bare(t)) || zone(t))) return p;
    const tokens = p.tokens.map(t => ({ ...t }));
    const before = (t) => tokens.filter(u => u !== t && Math.abs(u.y - t.y) <= 1.5 && u.x < t.x).sort((a, b) => b.x - a.x)[0];
    for (const t of tokens) {
      if (lettered && t.field === 'date' && bare(t)) {
        const b = before(t);
        t.field = b && b.field !== 'date' ? b.field : 'O';
      } else if (zone(t) && isTime(before(t))) t.field = 'O';
    }
    return { ...p, tokens };
  });
}

export function assembleRows(tagPages0, pdfPages = [], conventions = {}) {
  const tagPages = repairSlips(tagPages0, !!conventions.ocr);
  const period = pdfPages.length ? (findPeriod(pdfPages) || documentPeriod(pdfPages)) : null;
  const words = headerWordsOf(conventions);
  const plain = plainZone(pdfPages.length ? findNotices(pdfPages) : [], conventions, fileLayoutOf(tagPages, words));
  const legend = pdfPages.length ? new Map([...findGridLegend(pdfPages), ...findLegend(pdfPages)]) : new Map();
  const hotels = pdfPages.length ? findHotels(pdfPages) : new Map();
  const rows = [];
  const crewOf = new Map(); // group (a day's block / column) -> crew spans, top down
  const dayCodes = new Map(); // group -> indicator codes of the day ("M", "B,M"), from the document's legend
  let datePart = null; // date of the rows that follow
  let prevLine = null; // { y, rows } of the last line that started rows: the line a cell printed over two lines goes on from
  let pendingCells = null; // { y, spans }: a line of dates only above an event's line, its cells' first part
  let crewListRow = null; // { row, y }: the row whose crew list ("NAME - FA, NAME - CA") may go on on the next lines
  let lastYear = period?.from?.year ?? null; // the year being read: a lone "23" is that, not a day
  let planned = false;
  let lastHeaders = [];

  const isCodes = (text) => text.split(',').map(c => c.trim()).every(c => c && legend.has(c));
  // a column whose text the labels of this layout put on every event of the day (the day's indicators)
  const dayWide = (s, headers) => {
    const h = headers.length && headerAt(headers[headers.length - 1], s.x);
    return !!h && conventions.dayWide?.[`${layoutKey(mainHeader(headers))}|${h.word}`] === 'day';
  };
  const addCodes = (group, text) => {
    const list = dayCodes.get(group) || [];
    for (const c of text.split(',').map(c => c.trim())) if (!list.includes(c)) list.push(c);
    dayCodes.set(group, list);
  };

  // One line of a block (or of a day column): its dates, the rows it starts, where its other words go.
  //   ctx.date:   the date of every row of the line (day columns, centred dates), not read from the line
  //   ctx.column: the line is in a day column; ctx.started tells whether the day's first event was seen
  function handleLine(inBlock, blockHeaders, ctx = {}) {
    // "The following is only for information ...": the days after it are planned, not published.
    if (PLANNED_LINE.some(re => re.test(inBlock.map(t => t.t).join(' ')))) planned = true;
    const spans = spansOf(inBlock, blockHeaders[blockHeaders.length - 1]);
    if (!spans.length) return;
    const make = (anchor) => {
      const row = { date: datePart, section: planned ? 'planned' : 'published', f: {}, info: [], anchor, y: inBlock[0].y, centred: !!ctx.centred, group: ctx.group, layout: ctx.layout ?? '' };
      rows.push(row);
      return row;
    };
    if (ctx.date !== undefined) datePart = ctx.date;
    else {
      // 1. Dates of this line. A lone number that is the year being read ("20" of "Sat 4 Apr 20") is not a day.
      let dated = false;
      for (const s of spans.filter(s => s.field === 'date')) {
        const d = parseDateText(s.text);
        if (!d || (/^\d{2}$/.test(s.text.trim()) && lastYear === +s.text.trim())) continue;
        datePart = { ...d, text: s.text };
        if (d.year != null) lastYear = d.year;
        dated = true;
      }
      // A full date the tagger left untagged at the start of an event's line ("Mon 4 May 20").
      const firstAnchor = spans.find(s => ANCHORS.has(s.field));
      if ((!dated || datePart?.day == null) && firstAnchor) {
        const before = inBlock.filter(t => t.x < firstAnchor.x && (t.field === 'O' || t.field === 'date')).map(t => t.t).join(' ');
        const d = before && parseDateText(before);
        if (d && (d.month != null || d.weekday != null) && /[A-Za-z]/.test(before)) datePart = { ...d, text: before };
      }
    }
    // A line of times only under an event's line ("01ABR21" / "02:31", "04ABR21" / "14:00"): its cells printed
    // over two lines, the date above, the time under it. Each time goes to that line's cell of its field (the C/I
    // or C/O row for "ci" / "co"), nearest by x; nothing new starts. A crew list going on beside them
    // ("NAME - FA, NAME - CA" over several lines) goes on in its row's crew.
    const valued = spans.filter(s => s.field !== 'date' && !(s.field === 'crew' && crewListRow));
    const crewGoesOn = spans.filter(s => s.field === 'crew' && crewListRow);
    // (a C/I or C/O time going on beside it does not start anything either)
    if (crewGoesOn.length && !spans.some(s => s.field === 'date' || (ANCHORS.has(s.field) && !TIME_ONLY_RE.test(s.text.trim()))) && inBlock[0].y - crewListRow.y < 16) {
      for (const s of crewGoesOn) crewListRow.row.crewText += ` ${s.text}`;
      crewListRow.y = inBlock[0].y;
    }
    // (a registration goes on too: "PR-" over "AYY")
    // (and a local time in brackets under its time: "[10:00]")
    const goesOn = s => (TIME_FIELDS.has(s.field) && TIME_ONLY_RE.test(s.text.trim().replace(/^\[(.*)]$/, '$1'))) || s.field === 'registration';
    // (beside local times, the event's description printed a line lower: "[11:00] [15:00] GROUND SCHOOL")
    const withLocal = valued.some(s => TIME_FIELDS.has(s.field) && /^\[\d{1,2}:\d{2}]$/.test(s.text.trim()));
    const besides = valued.filter(s => withLocal && INFO_FIELDS.has(s.field));
    // A hotel name going on on the line under it ("Crowne Plaza Istanbul -" / "Florya").
    const hotelAbove = !ctx.column && prevLine && inBlock[0].y - prevLine.y < 14 && prevLine.rows.find(r => r.anchor === 'hotelname' && r.info.length);
    if (hotelAbove && valued.length && valued.every(s => s.field === 'hotel' && !HOTEL_CODE_RE.test(s.text))) {
      const last = hotelAbove.info[hotelAbove.info.length - 1];
      last.text = `${last.text} ${valued.map(s => s.text).join(' ')}`;
      prevLine.y = inBlock[0].y;
      return;
    }
    if (!ctx.column && prevLine && !spans.some(s => s.field === 'date') && inBlock[0].y - prevLine.y < 20
      && (valued.length ? valued.every(s => goesOn(s) || besides.includes(s)) && valued.some(s => s.field !== 'registration' && !besides.includes(s)) : crewGoesOn.length)) {
      const cellOf = (s) => {
        const key = s.field === 'ci' ? 'begin' : s.field === 'co' ? 'end' : s.field;
        const own = s.field === 'ci' || s.field === 'co' ? prevLine.rows.filter(r => r.anchor === s.field) : prevLine.rows.filter(r => r.anchor !== 'ci' && r.anchor !== 'co');
        const local = /^\[.*]$/.test(s.text.trim());
        const open = (v) => !v || (typeof v === 'object' && (key === 'registration' ? /-$/.test(v.text) : local ? !/\[/.test(v.text) : !/\d{1,2}:\d{2}/.test(v.text)));
        const near = own.filter(r => open(r.f[key]));
        const row = near.reduce((best, r) => {
          const x = r.f[key]?.x ?? r.x ?? 0, bx = best ? best.f[key]?.x ?? best.x ?? 0 : Infinity;
          return Math.abs(x - s.x) < Math.abs(bx - s.x) ? r : best;
        }, null);
        return row && { row, key };
      };
      const cells = valued.filter(s => !besides.includes(s));
      const targets = cells.map(cellOf);
      if (!valued.length) return; // crew only, gone on above
      if (targets.every(Boolean)) {
        targets.forEach(({ row, key }, k) => {
          const s = cells[k];
          const cur = row.f[key];
          row.f[key] = cur && typeof cur === 'object' ? { ...cur, text: `${cur.text}${/-$/.test(cur.text) ? '' : ' '}${s.text}`, tokens: [...cur.tokens, ...s.tokens] } : { ...s, field: key };
        });
        for (const s of besides) targets[0].row.info.push(infoText(s, blockHeaders, conventions));
        return;
      }
    }
    // A line of dates only right above an event's line ("01NOV11 ... 02NOV11" over "SCH VCP VCP", the times under
    // it): the first part of that event's cells (begin, end, C/I, C/O), not rows of their own.
    const dateOnly = s => TIME_FIELDS.has(s.field) && !/\d{1,2}:\d{2}/.test(s.text) && parseDateText(s.text)?.month != null;
    if (!ctx.column && valued.length && valued.every(dateOnly)) { pendingCells = { y: inBlock[0].y, spans: valued }; return; }
    const pending = pendingCells && inBlock[0].y - pendingCells.y < 12 ? pendingCells.spans : [];
    pendingCells = null;
    // 2. Rows started on this line: C/I first, then duties / hotel codes left to right, C/O last.
    const anchors = spans.filter(s => ANCHORS.has(s.field));
    if (ctx.column) {
      const prev = rows[rows.length - 1];
      // Above the day's first event: the end of the last event of a day before, which ran past midnight
      // ("↓" "MIA" "A00:13" "[32Q]" under the next day's date): its arrival, end (+1), aircraft.
      if (!ctx.started && !anchors.length && prev && prev.date !== datePart) {
        for (const s of spans) {
          if (s.field === 'date') continue;
          if (s.field === 'info') prev.info.push({ text: tidyInfo(s.text) });
          else if (!prev.f[s.field]) { prev.f[s.field] = s; if (s.field === 'end') prev.endNextDay = true; }
        }
        return;
      }
      // The end of a flight number wrapped onto the line under it ("WAZ701" / "5").
      if (anchors.length === 1 && spans.length === 1 && anchors[0].field === 'duty' && /^[A-Z0-9]{1,2}$/.test(anchors[0].text)
        && prev?.anchor === 'duty' && prev.date === datePart && Object.keys(prev.f).length === 1) {
        prev.f.duty = { ...prev.f.duty, text: prev.f.duty.text + anchors[0].text, tokens: [...prev.f.duty.tokens, ...anchors[0].tokens] };
        return;
      }
      if (anchors.length) ctx.started = true;
    }
    const lineRows = [];
    const order = { ci: 0, duty: 1, hotel: 1, co: 2 };
    const hasDuty = anchors.some(s => s.field === 'duty');
    // A hotel name (not a code like "H1*") is a row of its own: "H", at the last arrival (on an event's line, that event's).
    const hotelName = s => s.field === 'hotel' && !HOTEL_CODE_RE.test(s.text);
    for (const s of [...anchors].sort((a, c) => order[a.field] - order[c.field] + (hotelName(a) - hotelName(c)) * 0.5 || a.x - c.x)) {
      if (s.field === 'hotel' && hasDuty && !hotelName(s)) continue; // the hotel code of an event on its line
      const row = make(hotelName(s) ? 'hotelname' : s.field);
      row.x = s.x;
      if (s.field === 'ci') { row.f.duty = 'C/I'; row.f.begin = s; } else if (s.field === 'co') { row.f.duty = 'C/O'; row.f.end = s; } else if (hotelName(s)) { row.f.duty = 'H'; row.info.push({ text: s.text }); } else row.f[s.field] = s;
      lineRows.push(row);
    }
    const mains = lineRows.filter(r => r.anchor === 'duty' || r.anchor === 'hotel');
    // the date parts held from the line above: to this line's C/I / C/O row, or its event (nearest by x)
    for (const s of pending) {
      const key = s.field === 'ci' ? 'begin' : s.field === 'co' ? 'end' : s.field;
      const own = s.field === 'ci' || s.field === 'co' ? lineRows.filter(r => r.anchor === s.field) : mains;
      let row = own.length ? own.reduce((a, r) => (Math.abs((r.x ?? 0) - s.x) < Math.abs((a.x ?? 0) - s.x) ? r : a)) : null;
      // (a C/I or C/O the event's line has no cell of: its row, the C/I before the line's rows, the C/O after them)
      if (!row && (s.field === 'ci' || s.field === 'co') && lineRows.length) {
        row = make(s.field);
        row.x = s.x;
        row.f.duty = s.field === 'ci' ? 'C/I' : 'C/O';
        if (s.field === 'ci') { rows.splice(rows.indexOf(row), 1); rows.splice(rows.indexOf(lineRows[0]), 0, row); lineRows.unshift(row); } else lineRows.push(row);
      }
      if (row && !row.f[key]) row.f[key] = { ...s, field: key };
    }
    const isHotelSpan = s => s.field === 'hotel' && hasDuty;
    // 3. The other words.
    for (const s of spans) {
      if (s.field === 'date' || (ANCHORS.has(s.field) && !(isHotelSpan(s) && !hotelName(s)))) continue;
      // A name in a table's crew column ("Self" under "PicName"): its row's crew, as the labels write it ("[PIC - Self]").
      const crewWrap = s.field === 'crew' && blockHeaders.length && conventions.crewWrap?.[`${layoutKey(mainHeader(blockHeaders))}|${headerAt(blockHeaders[blockHeaders.length - 1], s.x)?.key}`];
      // ("Name(385378-CA),Name(475495-FO)": each one's parts as the labels order them)
      const crewOrder = s.field === 'crew' && blockHeaders.length && conventions.crewOrder?.[`${layoutKey(mainHeader(blockHeaders))}|${headerAt(blockHeaders[blockHeaders.length - 1], s.x)?.key}`];
      const order = crewOrder && crewOrder.split(',').map(Number);
      const items = order && s.text.split(',').filter(i => i.trim());
      // (in brackets only: a list "NAME - FA,NAME - CA" may go on on the next lines, read as such below)
      if (order && items.every(i => /\(.*\)/.test(i) && crewParts(i).length === order.length)) {
        const row = mains.length ? [...mains].reverse().find(r => r.x <= s.x) || mains[0] : lineRows.find(r => r.anchor === null) || rows[rows.length - 1];
        if (row) for (const item of items) { const parts = crewParts(item); (row.crew ||= []).push(`[${order.map(k => parts[k]).join(' - ')}]`); }
        continue;
      }
      if (crewWrap && crewWrap !== 'no') {
        const row = mains.length ? [...mains].reverse().find(r => r.x <= s.x) || mains[0] : lineRows.find(r => r.anchor === null) || rows[rows.length - 1];
        if (row) (row.crew ||= []).push(crewWrap.replace('{}', s.text));
        continue;
      }
      // A crew list on an event's line ("NAME - FA,NAME - CA"): that event's crew, going on on the lines under it.
      if (s.field === 'crew' && mains.length && CREW_LIST_RE.test(s.text) && !/\d/.test(s.text)) {
        const row = [...mains].reverse().find(r => r.x <= s.x) || mains[0];
        row.crewText = (row.crewText ? `${row.crewText} ` : '') + s.text;
        crewListRow = { row, y: inBlock[0].y };
        continue;
      }
      // (no day to gather them by: the crew of the event on its line, or of the last event above it, "Pilot:" / "NAME (CODE)" lines)
      if (s.field === 'crew' && ctx.group == null && ctx.crewGroup == null) {
        const row = mains.length ? [...mains].reverse().find(r => r.x <= s.x) || mains[0] : [...rows].reverse().find(r => r.anchor === 'duty');
        if (row) { (row.crewSpans ||= []).push(s); continue; }
      }
      // The crew of the day's flights (a stack beside them), not of one row.
      if (s.field === 'crew') { const g = ctx.crewGroup ?? ctx.group ?? `d:${datePart?.text}`; if (!crewOf.has(g)) crewOf.set(g, []); crewOf.get(g).push(s); continue; }
      // Indicator codes of the legend ("M", "B,M"): the day's, for all its events.
      if (s.field === 'info' && ctx.group && (isCodes(s.text) || dayWide(s, blockHeaders))) { addCodes(ctx.group, s.text); continue; }
      let row;
      if (s.field === 'co_info' || s.field === 'ci_info') {
        const kind = s.field.slice(0, 2);
        row = lineRows.find(r => r.anchor === kind) || [...rows].reverse().find(r => r.anchor === kind);
      } else if (mains.length) {
        row = mains.reduce((best, r) => (Math.abs(r.x - s.x) < Math.abs(best.x - s.x) ? r : best));
        const leftOf = mains.filter(r => r.x <= s.x);
        if (leftOf.length) row = leftOf[leftOf.length - 1];
      } else {
        // A row this line already started (no duty in this layout); else info lines (stats, crew
        // messages) belong to the day's last event, not a hotel row after it; else the last row.
        const own = lineRows.find(r => r.anchor === null);
        const last = own || (s.field === 'info' ? [...rows].reverse().find(r => r.date === datePart && r.anchor !== 'hotel') || rows[rows.length - 1] : rows[rows.length - 1]);
        const sameDay = last && last.date === datePart;
        const free = last && (s.field === 'info' || !last.f[s.field]) && last.anchor !== 'co' && last.anchor !== 'ci';
        row = sameDay && free ? last : null;
        if (!row) { row = make(null); lineRows.push(row); }
      }
      if (!row) continue;
      if (s.field === 'info' || s.field === 'co_info' || s.field === 'ci_info') row.info.push(infoText(s, blockHeaders, conventions));
      else if (!row.f[s.field]) row.f[s.field] = s;
      else row.f[s.field] = { ...row.f[s.field], text: `${row.f[s.field].text} ${s.text}`, tokens: [...row.f[s.field].tokens, ...s.tokens] };
    }
    for (const r of lineRows) r.headers = blockHeaders;
    if (lineRows.length) prevLine = { y: inBlock[0].y, rows: lineRows };
  }

  tagPages.forEach((page, pi) => {
    // A page with no date at all after the days were read is not the days table: the
    // statistics / overtime / crew pages NetLine prints after it ("AO / M 0:00") make no rows.
    if (rows.length && !page.tokens.some(t => t.field === 'date')) return;
    const allLines = toLines(page.tokens);
    for (const l of allLines) smoothLine(l.tokens);
    const grid = dayColumns(allLines);
    if (grid) {
      // A calendar grid: each day's column top down, its date from the column head.
      const inGrid = page.tokens.filter(t => t.y > grid.y + 1 && t.y < grid.endY - 1);
      grid.cols.forEach((col, ci) => {
        const toks = inGrid.filter(t => Math.abs(t.x + widthOf(t) / 2 - col.cx) < grid.pitch / 2);
        const date = { ...col.date };
        if (date.year == null && period?.from) date.year = period.from.year + (date.month < period.from.month ? 1 : 0);
        const ctx = { column: true, started: false, date, group: `${pi}:c${ci}`, layout: 'grid' };
        const colLines = toLines(toks);
        // The column's last line, set apart from its events, made of legend codes ("S", "M,l"): the day's indicators.
        const last = colLines[colLines.length - 1];
        if (colLines.length > 1 && last.y - colLines[colLines.length - 2].y > 15 && last.tokens.every(t => isCodes(t.t) && !ANCHORS.has(t.field))) {
          for (const t of last.tokens) addCodes(ctx.group, t.t);
          colLines.pop();
        }
        for (const l of colLines) handleLine(l.tokens, [], ctx);
        // The day's indicators go on its events where the column ends: words of the next column
        // added to them later (a delay printed under the next day's date) come after.
        if (dayCodes.has(ctx.group)) {
          const codes = dayCodes.get(ctx.group);
          for (const r of rows.filter(r => r.group === ctx.group)) r.info.push({ codes });
          dayCodes.delete(ctx.group);
        }
      });
      return;
    }
    const headers = headerLines(allLines, words);
    // Rows are below the column header (above it: titles, the month's summary strip).
    // (below the table's own header when nothing above it is a row: not a title's, "Flight Time Report", with the crew
    // member's name under it)
    const main = mainHeader(headers);
    const rowAbove = main && allLines.some(l => l.y > headers[0].y + 1 && l.y < main.y - 1 && l.tokens.filter(t => t.field && t.field !== 'O').length >= 2);
    const lines = headers.length ? allLines.filter(l => l.y > (rowAbove ? headers[0] : main).y + 1) : allLines;
    if (headers.length) lastHeaders = headers;
    const pageHeaders = headers.length ? headers : lastHeaders;
    // Layouts whose labels put each event on the date nearest to it (the date in the middle of its day).
    const layout = layoutKey(mainHeader(pageHeaders));
    const centred = conventions.dateAnchor?.[layout] === 'center';
    const starts = blockStarts(pageHeaders, words);
    const blockOf = x => starts.filter(s => x >= s).length - 1;
    for (let b = 0; b < starts.length; b++) {
      const blockHeaders = pageHeaders.map(h => ({ ...h, tokens: h.tokens.filter(t => blockOf(t.x) === b) })).filter(h => h.tokens.length);
      const blockLines = lines.map(l => ({ ...l, tokens: l.tokens.filter(t => blockOf(t.x) === b) })).filter(l => l.tokens.length);
      const dates = centred ? centredDates(blockLines) : [];
      const nearest = (y) => dates.reduce((a, c) => (Math.abs(c.y - y) < Math.abs(a.y - y) ? c : a));
      const dayOf = dates.length ? centredDays(blockLines, dates) : new Map();
      const crewDayOf = dates.length ? centredDays(blockLines, dates, { crew: true }) : new Map();
      // Lines of a day holding only text of a cell (a "Details" cell over several lines): placed once the day's rows are made.
      const cellOnly = (line) => line.tokens.some(t => t.field === 'info') && line.tokens.every(t => ['info', 'date', 'O'].includes(t.field));
      const later = [];
      for (const line of blockLines) {
        if (!dates.length) { handleLine(line.tokens, blockHeaders, { layout }); continue; }
        const near = dayOf.get(line) ?? nearest(line.y);
        if (near.date.year != null) lastYear = near.date.year;
        const crewNear = crewDayOf.get(line) ?? near;
        const ctx = { date: near.date, centred: true, group: `${pi}:${b}:${near.y}`, crewGroup: `${pi}:${b}:${crewNear.y}`, layout };
        if (cellOnly(line)) later.push({ line, ctx }); else handleLine(line.tokens, blockHeaders, ctx);
      }
      for (const { line, ctx } of later) {
        // its row: the day's event nearest to it; of two as near, the one whose described duty goes on with these words
        const own = rows.filter(r => r.group === ctx.group && r.anchor && r.anchor !== 'ci' && r.anchor !== 'co');
        if (!own.length) {
          // a day with nothing but its indicators ("s"): a row of its own carries them
          const codes = spansOf(line.tokens).filter(s => s.field === 'info' && (isCodes(s.text) || dayWide(s, blockHeaders)));
          if (codes.length && !rows.some(r => r.group === ctx.group)) {
            const at = rows.findIndex(r => r.group?.startsWith(`${pi}:${b}:`) && r.y > line.y); // in its place top down
            rows.splice(at < 0 ? rows.length : at, 0, { date: ctx.date, section: planned ? 'planned' : 'published', f: {}, info: [], anchor: null, y: line.y, centred: true, group: ctx.group, layout });
          }
          handleLine(line.tokens, blockHeaders, ctx);
          continue;
        }
        const text = line.tokens.filter(t => t.field === 'info').map(t => t.t).join(' ');
        const describes = r => { const d = legend.get(r.f.duty?.text); return d && d.includes(text) ? 0 : 1; };
        const row = own.reduce((a, r) => { const da = Math.abs(a.y - line.y), dr = Math.abs(r.y - line.y); return dr < da - 1 || (Math.abs(dr - da) <= 1 && describes(r) < describes(a)) ? r : a; });
        for (const s of spansOf(line.tokens).filter(s => s.field === 'info')) {
          if (isCodes(s.text) || dayWide(s, blockHeaders)) addCodes(ctx.group, s.text); else row.info.push(infoText(s, blockHeaders, conventions));
        }
      }
    }
  });

  // A C/I printed above a timed duty that began before it ("17:55" "LSBY 15:15-17:55" "2705"): the duty came first.
  const minutes = (span) => { const m = span && typeof span === 'object' && /(\d{2}):?(\d{2})/.exec(span.text); return m ? +m[1] * 60 + +m[2] : null; };
  for (let i = 0; i + 1 < rows.length; i++) {
    const [a, b] = [rows[i], rows[i + 1]];
    if (a.layout !== 'grid' || a.anchor !== 'ci' || b.anchor !== 'duty' || a.group !== b.group || !b.f.end) continue;
    if (minutes(a.f.begin) != null && minutes(b.f.begin) != null && minutes(a.f.begin) > minutes(b.f.begin)) [rows[i], rows[i + 1]] = [b, a];
  }

  // A day whose date is centred on it: its C/I first and its C/O last, the events in between top down.
  const rank = r => (r.anchor === 'ci' ? 0 : r.anchor === 'co' ? 2 : 1);
  for (let i = 0; i < rows.length;) {
    let j = i + 1;
    while (j < rows.length && rows[i].centred && rows[j].group === rows[i].group) j++;
    if (j - i > 1) rows.splice(i, j - i, ...rows.slice(i, j).map((r, k) => ({ r, k })).sort((a, c) => rank(a.r) - rank(c.r) || a.k - c.k).map(o => o.r));
    i = j;
  }

  // A layout that prints the check-out on every leg of a duty ("Checkout" of an activity list) where its labels
  // have one C/O per duty (conventions.coOnce): the duty's last one, the one before the next C/I.
  for (let i = rows.length - 1, later = new Set(); i >= 0; i--) {
    const r = rows[i];
    if (r.anchor === 'ci') later.delete(r.section);
    else if (r.anchor === 'co' && conventions.coOnce?.[r.layout] === 'yes') {
      if (later.has(r.section)) rows.splice(i, 1); else later.add(r.section);
    }
  }

  // C/I takes the departure of the event after it, C/O the arrival of the one before,
  // in layouts whose labels write them so (conventions.place).
  // (an event's airports may be one route word, "ORY-FAO")
  const routeOf = (n) => { const t = n.f.route && typeof n.f.route === 'object' ? n.f.route.text : ''; return /^[A-Z]{3,4}\s*[-/]\s*[A-Z]{3,4}$/.test(t) ? t.split(/\s*[-/]\s*/) : null; };
  const depOf = (n) => n.f.dep || routeOf(n)?.[0];
  const arrOf = (n) => n.f.arr || routeOf(n)?.[1];
  rows.forEach((r, i) => {
    // (a C/I: within its duty, not past its C/O; a C/O: the last arrival, a duty without flights has none of its own)
    const ahead = () => { const n = rows.slice(i + 1); const end = n.findIndex(x => x.anchor === 'co' || x.anchor === 'ci'); return end < 0 ? n : n.slice(0, end); };
    if (r.anchor === 'ci' && conventions.place?.[`${r.layout}|ci`] !== 'no') r.f.dep ||= ahead().map(depOf).find(Boolean);
    if (r.anchor === 'co' && conventions.place?.[`${r.layout}|co`] !== 'no') r.f.arr ||= [...rows.slice(0, i)].reverse().map(arrOf).find(Boolean);
    if (r.anchor === 'hotelname') r.f.dep ||= [...rows.slice(0, i)].reverse().map(arrOf).find(Boolean);
  });

  const dates = resolveDates(rows.map(r => r.date), period);
  const written = []; // [{ r, section, ymd, row }] in order
  rows.forEach((r, i) => {
    let d = dates[i];
    // A C/I or C/O whose time cell has its own date ("12ABR21 01:05"): the row is that day's
    const own = r.anchor === 'ci' ? r.f.begin : r.anchor === 'co' ? r.f.end : null;
    const ownDate = own && typeof own === 'object' ? own.tokens.filter(t => !TIME_ONLY_RE.test(t.t)).map(t => t.t).join(' ') : '';
    const od = ownDate && /\d/.test(ownDate) ? parseDateText(ownDate) : null;
    if (d && od?.day && od.month != null) d = { day: od.day, month: od.month, year: od.year ?? d.year };
    // (a cell holding only a dash, "-", is an empty one; a duty "--" is a code: a day off)
    const val = f => {
      const v = (r.f[f] && typeof r.f[f] === 'object' ? r.f[f].text : r.f[f] || '').replace(/(\S)\s+[-–—]$/, '$1'); // ("AD4263 -": the empty cell beside it)
      return f !== 'duty' && /^[-–—]+$/.test(v.trim()) ? '' : v;
    };
    let dep = val('dep'), arr = val('arr');
    if (conventions.ocr) { dep = ocrAirport(dep); arr = ocrAirport(arr); }
    if (r.f.route) {
      // ("GYE / JFK", or one word "ORY-FAO")
      const route = val('route');
      const [a, c] = (/^[A-Z]{3,4}-[A-Z]{3,4}$/.test(route) ? route.split('-') : route.split('/')).map(s => s.trim());
      dep ||= a || '';
      arr ||= c || '';
    }
    let duty = val('duty');
    let ac = val('ac');
    // An aircraft type printed with the duty ("250 [32N]"): the type is the aircraft.
    const typed = /^(.*\S)\s*\[([A-Z0-9]{2,4})]$/.exec(duty);
    if (typed) { duty = typed[1]; ac ||= typed[2]; }
    ac = ac.replace(/^\[(.*)]$/, '$1');
    // Info cells written as the labels of this layout write them ("[RDO: Requested Day Off]").
    const isEventRow = !['C/I', 'C/O', 'H'].includes(duty);
    const codeTag = (c) => (legend.has(c) ? `[${c}: ${legend.get(c)}]` : `[${c}]`);
    const info = [];
    let codesAt = -1; // where the day's indicators stand among the row's info
    for (const e of cellsOf(r, conventions)) {
      if (e.codes) { if (isEventRow && codesAt < 0) { codesAt = info.length; for (const c of e.codes) if (!info.includes(codeTag(c))) info.push(codeTag(c)); } continue; }
      const paired = typeof e === 'object' && e.text.includes('=') ? pairsText(e.text, r.layout, conventions) : null;
      const text = typeof e === 'string' ? e : paired != null && paired !== e.text ? paired
        : e.wrap && duty ? e.wrap.replace('{duty}', duty).replace('{}', e.text) : e.text;
      if (!text) continue;
      // an indicator printed by the event in brackets ("(L)"): the legend's
      const paren = /^\(([^()\s]{1,2})\)$/.exec(text);
      info.push(paren && legend.has(paren[1]) ? codeTag(paren[1]) : text);
    }
    const hotel = val('hotel');
    if (r.anchor === 'hotel' && hotels.get(hotel.replace('*', ''))) info.unshift(hotels.get(hotel.replace('*', '')));
    const desc = duty ? legend.get(duty) ?? legend.get(duty.replace(/\s+/g, '')) : null;
    const squeeze = (v) => v.replace(/\s+/g, '');
    // the duty's description first, before the day's indicators
    if (desc && conventions.legendTag?.[r.layout] !== 'no' && !info.some(e => squeeze(e) === squeeze(`[${duty}: ${desc}]`))) {
      if (codesAt >= 0) info.splice(codesAt + (r.anchor === 'hotel' && hotels.get(hotel.replace('*', '')) ? 1 : 0), 0, `[${duty}: ${desc}]`);
      else info.push(`[${duty}: ${desc}]`);
    }
    // "A10:29/01:41": the end time and the delay
    const delay = r.f.end && typeof r.f.end === 'object' && /\/(\d{1,2}:\d{2})$/.exec(r.f.end.text);
    if (delay) info.push(`[Delay ${delay[1]}]`);
    // tags in the order this layout's labels write them ("[Flight: ..] [Night: ..] [Function: ..]"), not as printed
    // (two named tags swap only where the labels put them the other way round)
    // (names, "Flight" / "Memo"; not a legend's codes, "M" / "l", whose order is the day's)
    const tagName = (e) => { const n = typeof e === 'string' && /^\[([^\]\[:]+): /.exec(e)?.[1]; return n && n.length > 2 && /[a-z]/.test(n) ? n : null; };
    const slots = info.map((e, k) => (tagName(e) ? k : -1)).filter(k => k >= 0);
    for (let pass = 0; pass < slots.length; pass++) {
      for (let j = 0; j + 1 < slots.length; j++) {
        const [a, b] = [info[slots[j]], info[slots[j + 1]]];
        if (conventions.infoOrder?.[`${r.layout}|${tagName(b)}|${tagName(a)}`] === 'before') { info[slots[j]] = b; info[slots[j + 1]] = a; }
      }
    }
    // a time cell with its own date ("03MAR23 02:10" on a row of 2 Mar): "+1" for each day after the row's
    const daysAfter = (span) => {
      const dateText = span.tokens.filter(t => !TIME_ONLY_RE.test(t.t)).map(t => t.t).join(' ');
      const p = dateText && /\d/.test(dateText) ? parseDateText(dateText) : null;
      if (!p?.day || p.month == null || !d) return 0;
      const days = Math.round((Date.UTC(2000 + (p.year ?? d.year), p.month, p.day) - Date.UTC(2000 + d.year, d.month, d.day)) / 86400000);
      return days > 0 && days < 4 ? days : 0;
    };
    const time = (f) => {
      if (!r.f[f] || typeof r.f[f] !== 'object') return '';
      const later = (f === 'end' || f === 'begin') && !/[+-]\d$/.test(r.f[f].text) ? daysAfter(r.f[f]) : 0;
      if (later) return formatTimes({ ...r.f[f], text: `${r.f[f].text}+${later}` }, plain, r.headers || []);
      // (an end before its begin, in a layout whose labels write it as the next day's)
      const hm = (s) => /(\d{1,2}):(\d{2})/.exec(s?.text || '');
      // (not an actual time, "A08:21": printed by the day it happened)
      const mins = (m) => +m[1] * 60 + +m[2];
      const before = f === 'end' && conventions.overnight?.[r.layout] === 'yes' && hm(r.f.end) && hm(r.f.begin) && !/^[AE]/.test(r.f.end.text)
        && mins(hm(r.f.end)) < mins(hm(r.f.begin));
      const span = f === 'end' && (r.endNextDay || before) && !/[+-]\d$/.test(r.f[f].text) ? { ...r.f[f], text: `${r.f[f].text}+1` } : r.f[f];
      return formatTimes(span, plain, r.headers || []);
    };
    const section = period?.to && d && conventions.afterPeriod?.[r.layout] !== 'published' && (d.year > period.to.year || (d.year === period.to.year && (d.month > period.to.month || (d.month === period.to.month && d.day > period.to.day)))) ? 'planned' : r.section;
    written.push({ r, section, ymd: d ? Date.UTC(2000 + d.year, d.month, d.day) : null, crewShapes: conventions.crewShapes?.[r.layout], row: {
      date: d ? `${d.day} ${MONTHS[d.month]} ${String(d.year).padStart(2, '0')}` : '',
      day: d ? WEEKDAYS[weekdayOf(d)] : '',
      hotel, dc: val('dc'), duty, registration: val('registration').replace(/^\(([A-Z0-9-]+)\)$/, '$1'), dep, begin: time('begin'), takeoff: time('takeoff'), landing: time('landing'), end: time('end'), arr, ac, crew: r.crewText ? crewListTags(r.crewText) : r.crewSpans ? crewMembers(r.crewSpans, (w) => conventions.crewRoles?.[`${r.layout}|${w}`] === 'yes') : (r.crew || []).filter(c => !/^\[?[-–—]+\]?$/.test(c.trim())).join(''),
      // "Delay" "00:50" printed under a flight: its delay
      info: info.filter(Boolean).join(' ').replace(/\s+/g, ' ').trim().replace(/(^|\s)Delay (\d{1,2}:\d{2})(?=\s|$)/g, '$1[Delay $2]'),
      ...(conventions.debug ? { _dateText: r.date?.text || '' } : {}),
    } });
  });
  if (pdfPages.length) joinDocumentTables(written, pdfPages, { crewOf, dayCodes, legend, conventions });
  // A crew list printed under a duty's first flight, on its later flights too where the labels write it so (conventions.crewCarry).
  const carried = {};
  for (const { r, section, row } of written) {
    if (row.duty === 'C/I') carried[section] = '';
    if (row.crew) carried[section] = row.crew;
    else if (row.dep && row.arr && carried[section] && conventions.crewCarry?.[r.layout] === 'yes') row.crew = carried[section];
  }
  // given out with the hotel night as an event of its own (hotelAsEvent): a hotel code on an event's line is the night after it
  const out = { published: [], planned: [] };
  for (const { section, row } of written) {
    if (row.hotel && row.duty) {
      out[section].push(hotelAsEvent({ ...row, hotel: '' }));
      out[section].push(hotelAsEvent({ ...Object.fromEntries(Object.keys(row).map(k => [k, ''])), date: row.date, day: row.day, hotel: row.hotel, dep: row.arr || row.dep }));
    } else out[section].push(hotelAsEvent(row));
  }
  if (conventions.ocr) repairImageRows(out); // OCR slips the image parser knows ("CHECK-TN", "CI9", "CRI" for CRL)
  return out;
}

/**
 * What a roster's own tables add to the rows the tagged words made: the crew
 * tagged beside a day's flights, the day's indicator codes and the "Memos" table
 * (on each event of the day but C/I and C/O), the crew of the "Other Crew" and
 * "Training Details" tables (joined by date and flight number), the crew ids
 * listed per flight number in compact NetLine plans, and a row "H"
 * per night of the "Hotel Information" table, after that day's events.
 */
function joinDocumentTables(written, pdfPages, { crewOf, dayCodes, legend, conventions }) {
  const isEvent = (w) => !['C/I', 'C/O', 'H'].includes(w.row.duty);
  // a flight: an event with a route, its number shaped as the flights the labels of this layout give crew to
  const isFlight = (w) => w.row.dep && w.row.arr && isEvent(w) && (!w.crewShapes || w.crewShapes.split(' ').includes(dutyShape(w.row.duty)));
  const addInfo = (w, tag) => { if (!w.row.info.includes(tag)) w.row.info = `${w.row.info} ${tag}`.trim(); };
  // crew tagged beside the flights of a day: one member per "CP - ..." line; a name running on joins it
  for (const [group, spans] of crewOf) {
    const crew = crewMembers(spans, false);
    for (const w of written) if (w.r.group === group && isFlight(w)) w.row.crew = crew;
  }
  for (const [group, codes] of dayCodes) {
    for (const w of written) if (w.r.group === group && isEvent(w)) for (const c of codes) addInfo(w, legend.has(c) ? `[${c}: ${legend.get(c)}]` : `[${c}]`);
  }
  const ddmmyyyy = (ymd) => { const d = new Date(ymd); return `${String(d.getUTCDate()).padStart(2, '0')}/${String(d.getUTCMonth() + 1).padStart(2, '0')}/${d.getUTCFullYear()}`; };
  const memos = findMemos(pdfPages);
  for (const w of written) if (w.ymd != null && isEvent(w)) for (const m of memos.get(ddmmyyyy(w.ymd)) || []) addInfo(w, `[Memo: ${m}]`);
  setDutyCrews(written.map(w => w.row), findOtherCrew(pdfPages));
  // compact NetLine plans: crew ids per flight number under the days ("992 Cockpit:01736 03912")
  setFlightCrews(written.map(w => w.row), findCrewIdLists(pdfPages));
  for (const t of findTrainings(pdfPages)) {
    const w = written.find(x => x.ymd != null && isTrainingOf(t, ddmmyyyy(x.ymd), x.row));
    if (w && conventions.trainingCrew?.[w.r.layout] !== 'no') w.row.crew = (w.row.crew || '') + t.crew.map(c => `[${c}]`).join('');
  }
  // hotel nights: a row "H" after the night's last row, unless the tagged words made it already
  for (const stay of findHotelStays(pdfPages)) {
    for (const night of stay.dates) {
      const [dd, mm, yyyy] = night.split('/').map(Number);
      const ymd = Date.UTC(yyyy, mm - 1, dd);
      if (written.some(w => w.ymd === ymd && w.row.duty === 'H' && !w.r.fromTable)) continue;
      let at = written.findIndex(w => w.ymd != null && w.ymd > ymd);
      if (at < 0) at = written.length;
      const prev = written[at - 1];
      written.splice(at, 0, {
        r: { fromTable: true }, section: prev?.section || 'published', ymd,
        row: { date: `${dd} ${MONTHS[mm - 1]} ${String(yyyy).slice(2)}`, day: WEEKDAYS[new Date(ymd).getUTCDay()], hotel: '', dc: '', duty: 'H', registration: '',
          dep: stay.port, begin: '', takeoff: '', landing: '', end: '', arr: '', ac: '', crew: '', info: [stay.address, stay.phone && `Tel ${stay.phone}`].filter(Boolean).join(', ') },
      });
    }
  }
}

/** "WAZ7015" -> "A9" (letters A, digits 9, runs collapsed): what kind of number a duty is. */
const dutyShape = (duty) => String(duty || '').replace(/[A-Z]+/g, 'A').replace(/\d+/g, '9');

/** OCR text: an airport code read with digits ("ED1", "8RU") -> letters ("EDI", "BRU"). */
const ocrAirport = v => (/^[A-Z0-9]{3}$/.test(v) && /\d/.test(v) ? v.replace(/[0-9]/g, d => ({ 0: 'O', 1: 'I', 5: 'S', 8: 'B', 2: 'Z', 6: 'G' })[d] || d) : v);

/** A row's info entries; in a centred day, the pieces of one column's cell (lines above and under the row) joined top down. */
function cellsOf(r, conventions = {}) {
  if (!r.centred) {
    // a cell's text wrapped onto the line under it ("OFF (EXTENDED RECOVERY REST" / "PE"): one text, written once,
    // in layouts whose labels join such lines (conventions.infoJoin; a table's lines are rows of their own)
    if (conventions.infoJoin?.[r.layout] !== 'join') return r.info;
    const out = [];
    for (const e of r.info) {
      const last = out[out.length - 1];
      const goesOn = last && typeof e === 'object' && typeof last === 'object' && e.wrap && e.wrap === last.wrap && e.col === last.col && e.y - last.y > 0 && e.y - last.y <= 12;
      if (goesOn) out[out.length - 1] = { ...last, text: `${last.text} ${e.text}`, y: e.y }; else out.push(e);
    }
    return out;
  }
  const out = [];
  const byCol = new Map();
  for (const e of r.info) {
    if (typeof e !== 'object' || e.col == null) { out.push(e); continue; }
    if (!byCol.has(e.col)) { byCol.set(e.col, []); out.push(byCol.get(e.col)); }
    byCol.get(e.col).push(e);
  }
  return out.map(e => (Array.isArray(e) ? { ...e[0], text: [...e].sort((a, c) => a.y - c.y).map(x => x.text).join(' ') } : e));
}

/**
 * An info cell: stats tidied; a bare duration written as the labels write it for
 * its column; other text with how the labels of this layout wrap it, which needs
 * the row's duty and is applied when the row is written ({ text, wrap }).
 */
/**
 * "TOTAL BLK=6:22 FDP=9:25[12:30] DUTY=9:55" as this layout's labels write it (conventions.pairs):
 * "[Block: 6:22] [FDP: 9:25] [Max FDP: 12:30] [Duty: 9:55]", a zero left out where they leave it out.
 * Text with no key the labels named stays as printed.
 */
function pairsText(text, layout, conventions) {
  const learned = (k) => conventions.pairs?.[`${layout}|${k}`];
  const words = text.split(/\s+/).filter(Boolean);
  if (!words.some(w => { const m = PAIR_RE.exec(w); return m && (learned(m[1]) || learned(`${m[1]}[]`)); })) return text;
  const out = [];
  for (const w of words) {
    const m = PAIR_RE.exec(w);
    if (!m) { if (learned(`word:${w}`) !== 'omit') out.push(w); continue; }
    for (const [v, suffix] of [[m[2], ''], [m[3], '[]']]) {
      if (!v) continue; // ("DUTY=": its value on the next line)
      const name = learned(`${m[1]}${suffix}`);
      if (!name) out.push(suffix ? `[${v}]` : `${m[1]}=${v}`);
      else if (!(ZERO_RE.test(v) && learned(`${m[1]}${suffix}#0`) === 'omit')) out.push(`[${name}: ${v}]`);
    }
  }
  return out.join(' ');
}

function infoText(span, headers, conventions) {
  const text = tidyInfo(span.text);
  const h = headerAt(headers[headers.length - 1], span.x);
  if (MINUTES_RE.test(text)) {
    // whole minutes this layout's labels write as hh:mm ("631" under "Block" -> "[Block: 10:31]")
    const n = headerOfNumber(headers[headers.length - 1], { ...span.tokens[0], t: text });
    const dk = n && `${layoutKey(mainHeader(headers))}|num:`;
    const learned = (suffix) => n && (conventions.duration?.[`${dk}${n.key}${suffix}`] ?? conventions.duration?.[`${dk}${n.word}${suffix}`]);
    if (learned('#min') === 'minutes') {
      const pattern = learned('');
      return pattern && pattern !== 'omit' ? pattern.replace('{}', minutesOf(text)) : minutesOf(text);
    }
  }
  if (DURATION_RE.test(text) || COUNT_RE.test(text) || DECIMAL_RE.test(text)) {
    const n = headerOfNumber(headers[headers.length - 1], { ...span.tokens[0], t: text });
    // (decimal hours: learned per layout)
    const pre = DECIMAL_RE.test(text) ? `${layoutKey(mainHeader(headers))}|` : '';
    const learned = (k) => k && (conventions.duration?.[`${pre}num:${k.key}`] ?? conventions.duration?.[`${pre}num:${k.word}`]);
    // a zero this layout's labels leave out ("00:00" of a day off's flight time)
    if (ZERO_RE.test(text) && n && learned({ key: `${n.key}#0`, word: `${n.word}#0` }) === 'omit') return '';
    // decimal hours its labels write as a duration
    const dec = pre && n && learned({ key: `${n.key}#dec`, word: `${n.word}#dec` }) === 'hours';
    if (pre && !dec) return { text, col: h?.word ?? null, y: span.tokens[0].y };
    const pattern = dec ? learned(n) : (h && (conventions.duration?.[h.key] ?? conventions.duration?.[h.word])) ?? learned(n);
    if (pattern && pattern !== 'omit') return pattern.replace('{}', dec ? hoursOf(text) : text);
    if (dec) return hoursOf(text);
    if (DURATION_RE.test(text)) return text;
  }
  const wrap = h && conventions.wrap?.[`${layoutKey(mainHeader(headers))}|${h.word}`];
  return { text, ...(wrap && wrap !== '{}' ? { wrap } : {}), col: h?.word ?? null, y: span.tokens[0].y };
}

/**
 * What a labeled file teaches about its layout (tagPages with the true tags):
 *   duration:   how a bare duration or count in an info column is written ("3:25" under "Blk" -> "[Block: {}]",
 *               "1" under the second "Day" -> "[Landing Day: {}]")
 *   wrap:       how other info text is written, per layout and column ("Requested Day Off" -> "[{duty}: {}]")
 *   crewWrap:   how a name in a table's crew column is written, per layout and column ("Self" -> "[PIC - {}]")
 *   dateAnchor: whether an event belongs to the date above it ('previous') or the nearest one ('center'), per layout
 *   zone:       the zone letter of times printed plain, per note of the document ("All times in Local Station" -> L),
 *               and per layout ("layout:<its column header>")
 * Counts per key; mergeConventions keeps the most common answer.
 */
export function learnConventions(tagPages, label, pdfPages = []) {
  const duration = {}, infoOrder = {}, overnight = {}, crewOrder = {}, wrap = {}, dateAnchor = {}, zone = {}, headerWords = {}, place = {}, legendTag = {}, crewShapes = {}, dayWide = {}, afterPeriod = {}, trainingCrew = {}, crewWrap = {}, pairs = {}, crewCarry = {}, crewRoles = {}, infoJoin = {}, coOnce = {};
  const rowsOf = sec => (label[sec] || []).map(hotelFromEvent); // hotel nights as the words are tagged
  const vote = (obj, key, val) => { const seen = (obj[key] ||= {}); seen[val] = (seen[val] || 0) + 1; };
  // Column headers: the line right above a page's first row, 3+ words none of which belongs to a row,
  // most of them standing over a column of row values (a crew list or a title above the table does not).
  for (const page of tagPages) {
    const lines = toLines(page.tokens);
    if (dayColumns(lines)) continue;
    const first = lines.findIndex(l => l.tokens.some(t => t.row != null && t.field !== 'O'));
    // (over lines of data the labels leave out: "12/10 0,0 0,0", a day without a flight)
    let at = first - 1;
    // (a row's line: its first word a date like the first row's, in the same place)
    const leftmost = (l) => l.tokens.reduce((a, t) => (t.x < a.x ? t : a));
    const lead = first >= 0 ? leftmost(lines[first]) : null;
    const rowLike = (l) => lead?.field === 'date' && l.tokens.every(t => t.field === 'O') && Math.abs(leftmost(l).x - lead.x) < 4 && parseDateText(leftmost(l).t)?.month != null;
    while (at > 0 && rowLike(lines[at]) && lines[first].y - lines[at].y < 150) at -= 1;
    const above = at >= 0 ? lines[at] : null;
    if (!above || lines[at + 1].y - above.y > 40 || above.tokens.length < 3 || above.tokens.some(t => t.field !== 'O')) continue;
    const values = lines.slice(first, first + 30).flatMap(l => l.tokens.filter(t => t.field !== 'O'));
    // (or a number right aligned under it: "0,3" under "Noturna")
    const overColumn = above.tokens.filter(h => values.some(v => Math.abs(v.x - h.x) < 20 || Math.abs(v.x + widthOf(v) - h.x - widthOf(h)) < 8));
    // most of the line, or many words over columns (a spreadsheet export with dozens of unread columns)
    const most = overColumn.length >= 0.5 * above.tokens.length;
    if (overColumn.length < 3 || (!most && overColumn.length < 10)) continue;
    // (from a line of many words: not short ones, "off" / "on" are a roster's words too; an abbreviation "E." is one)
    for (const t of overColumn) { const w = t.t.toLowerCase(); if (headerWordOk(w) && (most || w.length >= 4 || w.endsWith('.'))) headerWords[w] = (headerWords[w] || 0) + 1; }
  }
  const words = new Set([...HEADER_WORDS, ...Object.keys(headerWords)]);
  // Whether this layout's C/I rows carry the airport (dep) and its C/O rows the arrival.
  const fileLayout = fileLayoutOf(tagPages, words);
  for (const row of [...rowsOf('published'), ...rowsOf('planned')]) {
    if (row.duty === 'C/I') vote(place, `${fileLayout}|ci`, row.dep ? 'yes' : 'no');
    if (row.duty === 'C/O') vote(place, `${fileLayout}|co`, row.arr ? 'yes' : 'no');
    if (row.crew && row.dep && row.arr) (crewShapes[fileLayout] ||= {})[dutyShape(row.duty)] = 1;
    // an end before its begin: written as the next day's ("01:00 L +1")?
    const b = /^(\d{2}):(\d{2})/.exec(row.begin || ''), e = /^(\d{2}):(\d{2})/.exec(row.end || '');
    // ("01:00 Z +1 / 03:00 L": with the local time after it)
    if (b && e && +e[1] * 60 + +e[2] < +b[1] * 60 + +b[2]) vote(overnight, fileLayout, /\+1(\s|$)/.test(row.end) ? 'yes' : 'no');
    // where each named tag stands among the row's tags
    const names = [...(row.info || '').matchAll(/\[([^\]\[:]+): /g)].map(m => m[1]);
    names.forEach((a, i) => names.slice(i + 1).forEach((b) => { vote(infoOrder, `${fileLayout}|${a}|${b}`, 'before'); vote(infoOrder, `${fileLayout}|${b}|${a}`, 'after'); }));
  }
  // A printed key and value, "BLK=6:22", "FDP=9:25[12:30]": the name the label gives it ("[Block: 6:22]", the one in
  // brackets "[Max FDP: 12:30]"), whether it leaves a zero out, and whether it keeps the words beside them ("TOTAL").
  for (const page of tagPages) {
    for (const l of toLines(page.tokens)) {
      const cell = l.tokens.filter(t => INFO_FIELDS.has(t.field) && t.row != null);
      if (!cell.some(t => PAIR_RE.test(t.t))) continue;
      for (const t of cell) {
        const info = rowsOf(t.section)[t.row]?.info || '';
        const m = PAIR_RE.exec(t.t);
        if (!m) { vote(pairs, `${fileLayout}|word:${t.t}`, info.split(/[\s[\]]+/).includes(t.t) ? 'keep' : 'omit'); continue; }
        for (const [v, suffix] of [[m[2], ''], [m[3], '[]']]) {
          if (!v) continue;
          const names = [...info.matchAll(new RegExp(`\\[([^\\]\\[:]+): ${v.replace(/[.:]/g, '\\$&')}\\]`, 'g'))].map(x => x[1]);
          const key = `${fileLayout}|${m[1]}${suffix}`;
          if (ZERO_RE.test(v)) vote(pairs, `${key}#0`, names.length ? 'keep' : 'omit');
          if (names.length === 1) vote(pairs, key, names[0]);
        }
      }
    }
  }
  // Does this layout's label add a duty's legend description ("[OFF: Day off]")? Only rows whose own words carry no info say so.
  const legend = pdfPages.length ? new Map([...findGridLegend(pdfPages), ...findLegend(pdfPages)]) : new Map();
  // (an indicator code of the legend, "D" or "B,M", is not such info)
  const isCode = (w) => w.split(',').every(c => legend.has(c.trim()));
  const withInfo = new Set(tagPages.flatMap(p => p.tokens.filter(t => t.field === 'info' && t.row != null && !isCode(t.t)).map(t => `${t.section}|${t.row}`)));
  // Does the label write a crew list's roles ("Pilot:" over the names: "[Pilot - CYP - PECOT Cyril]")?
  for (const page of tagPages) {
    for (const t of page.tokens) {
      const role = t.field === 'crew' && t.row != null && /^([A-Z][a-z]+):$/.exec(t.t);
      if (role) vote(crewRoles, `${fileLayout}|${role[1]}`, (rowsOf(t.section)[t.row]?.crew || '').includes(`[${role[1]} - `) ? 'yes' : 'no');
    }
  }
  // Info of a row printed over two lines ("OFF (EXTENDED RECOVERY REST" / "PE"): one text in the label, or two?
  for (const page of tagPages) {
    const byRow = new Map();
    for (const l of toLines(page.tokens)) {
      for (const t of l.tokens) {
        if (t.field !== 'info' || t.row == null) continue;
        const k = `${t.section}|${t.row}`;
        const lines = byRow.get(k) || byRow.set(k, new Map()).get(k);
        lines.set(l, [...(lines.get(l) || []), t.t]);
      }
    }
    for (const [k, lines] of byRow) {
      const texts = [...lines.values()].map(w => w.join(' '));
      if (texts.length !== 2) continue;
      const [sec, i] = k.split('|');
      const info = rowsOf(sec)[+i]?.info || '';
      if (info.includes(texts[0]) && info.includes(texts[1])) vote(infoJoin, fileLayout, info.includes(`${texts[0]} ${texts[1]}`) ? 'join' : 'apart');
    }
  }
  // Does a flight with no crew words of its own have the crew of the duty's flight before it?
  const withCrew = new Set(tagPages.flatMap(p => p.tokens.filter(t => t.field === 'crew' && t.row != null).map(t => `${t.section}|${t.row}`)));
  for (const sec of ['published', 'planned']) {
    let before = '';
    rowsOf(sec).forEach((row, i) => {
      if (row.duty === 'C/I') before = '';
      if (withCrew.has(`${sec}|${i}`)) before = row.crew || '';
      else if (row.dep && row.arr && before) vote(crewCarry, fileLayout, row.crew === before ? 'yes' : 'no');
    });
  }
  // One C/O per duty (after its last leg, before the next C/I), or one per leg?
  for (const sec of ['published', 'planned']) {
    let coSince = false;
    for (const row of rowsOf(sec)) {
      if (row.duty === 'C/I') coSince = false;
      else if (row.duty === 'C/O') { vote(coOnce, fileLayout, coSince ? 'no' : 'yes'); coSince = true; }
    }
  }
  for (const sec of ['published', 'planned']) {
    rowsOf(sec).forEach((row, i) => {
      const desc = row.duty && legend.get(row.duty);
      if (!desc || withInfo.has(`${sec}|${i}`)) return;
      vote(legendTag, fileLayout, (row.info || '').includes(`[${row.duty}: ${desc}]`) ? 'yes' : 'no');
    });
  }
  for (const page of tagPages) {
    const lines = toLines(page.tokens);
    if (dayColumns(lines)) continue; // a calendar grid is read by its columns
    const headers = headerLines(lines, words);
    const header = headers[headers.length - 1];
    if (!header) continue;
    const key = layoutKey(mainHeader(headers));
    const starts = blockStarts(headers, words);
    const blockOf = x => starts.filter(s => x >= s).length - 1;
    const blockHeader = (x) => { const tokens = header.tokens.filter(h => blockOf(h.x) === blockOf(x)); return tokens.length ? { tokens } : header; };
    // Only a duration alone in its cell ("3:25" under "Blk Hrs"), not one inside a printed stat ("[ FT 05:49 ]").
    // (values side by side in their own cells, "1" "1" "01:09", are each alone)
    const alone = new Set();
    for (const l of lines) {
      l.tokens.forEach((t, k) => {
        const same = n => n && n.field === t.field && n.row === t.row && n.section === t.section && !(VALUE_RE.test(n.t) && VALUE_RE.test(t.t));
        if (!same(l.tokens[k - 1]) && !same(l.tokens[k + 1])) alone.add(t);
      });
    }
    // A row's n-th value "02:09" is its label's n-th "[..: 02:09]" ("[Flight: 02:09] [PIC: 02:09]"); a count "1" as a duration.
    const seenOfRow = new Map();
    for (const t of [...page.tokens].sort((a, c) => a.y - c.y || a.x - c.x)) {
      if (!INFO_FIELDS.has(t.field) || !(DURATION_RE.test(t.t) || COUNT_RE.test(t.t) || DECIMAL_RE.test(t.t) || MINUTES_RE.test(t.t)) || t.row == null || !alone.has(t)) continue;
      const info = rowsOf(t.section)[t.row]?.info || '';
      if (MINUTES_RE.test(t.t)) {
        // whole minutes: in the label as hh:mm ("631" -> "[Block: 10:31]"), or as printed
        const num = headerOfNumber(blockHeader(t.x), t);
        const hm = minutesOf(t.t);
        const asMinutes = [...info.matchAll(new RegExp(`\\[([^\\]]*?)\\s*${hm}\\]`, 'g'))];
        const asPrinted = new RegExp(`[\\s\\[]${t.t}\\]`).test(info);
        if (num && (asMinutes.length || asPrinted)) {
          const dk = `${key}|num:${num.key}`;
          vote(duration, `${dk}#min`, asMinutes.length && !asPrinted ? 'minutes' : 'raw');
          if (asMinutes.length === 1 && !asPrinted) { vote(duration, dk, asMinutes[0][1] ? `[${asMinutes[0][1]} {}]` : '[{}]'); continue; }
        }
        if (!COUNT_RE.test(t.t)) continue; // (a 4-digit number is no count)
      }
      if (DECIMAL_RE.test(t.t)) {
        // decimal hours: in the label as the duration ("1,6" -> "[Flight: 01:36]"), or not
        const num = headerOfNumber(blockHeader(t.x), t);
        if (!num) continue;
        // (per layout: "Total" is the flight time of one report, the block time of another)
        const dk = `${key}|num:${num.key}`;
        if (ZERO_RE.test(t.t)) { vote(duration, `${dk}#0`, info.includes(t.t) ? 'keep' : 'omit'); continue; }
        const hm = hoursOf(t.t);
        // (several tags of that value, "[Flight: 01:36] [IFR: 01:36]": the one named as its header, else one no other header names)
        const all = [...info.matchAll(new RegExp(`\\[([^\\]]*?)\\s*${hm}\\]`, 'g'))];
        const name = (x) => x[1].replace(/:\s*$/, '').trim().toLowerCase();
        const others = new Set(blockHeader(t.x).tokens.map(h => h.t.toLowerCase()).filter(w => w !== num.word));
        const own = all.filter(x => name(x) === num.word);
        const left = own.length ? own : all.filter(x => !others.has(name(x)));
        vote(duration, `${dk}#dec`, all.length ? 'hours' : 'raw');
        if (left.length === 1) vote(duration, dk, left[0][1] ? `[${left[0][1]} {}]` : '[{}]');
        continue;
      }
      const seenKey = `${t.section}|${t.row}|${t.t}`;
      const nth = seenOfRow.get(seenKey) || 0;
      seenOfRow.set(seenKey, nth + 1);
      const m = [...info.matchAll(new RegExp(`\\[([^\\]]*?)\\s*${t.t.replace(/[.:]/g, '\\$&')}\\]`, 'g'))][nth];
      const num = headerOfNumber(blockHeader(t.x), t);
      // (a zero: does the label write it, or leave it out)
      if (ZERO_RE.test(t.t) && num) vote(duration, `num:${num.key}#0`, m ? 'keep' : 'omit');
      if (!m) continue;
      vote(duration, headerAt(blockHeader(t.x), t.x).key, m[1] ? `[${m[1]} {}]` : '[{}]');
      if (num) vote(duration, `num:${num.key}`, m[1] ? `[${m[1]} {}]` : '[{}]');
    }
    // A name in a crew column ("Self" under "PicName") as its label writes it: "[PIC - {}]".
    for (const t of page.tokens) {
      if (t.field !== 'crew' || t.row == null) continue;
      const words = page.tokens.filter(n => n.field === 'crew' && n.row === t.row && n.section === t.section && Math.abs(n.y - t.y) < 2 && headerAt(blockHeader(n.x), n.x).key === headerAt(blockHeader(t.x), t.x).key);
      if (words[0] !== t) continue; // once per cell
      const text = words.sort((a, c) => a.x - c.x).map(n => n.t).join(' ');
      const crew = rowsOf(t.section)[t.row]?.crew || '';
      const m = new RegExp(`\\[([^\\]\\[]*?) - ${text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\]`).exec(crew);
      vote(crewWrap, `${key}|${headerAt(blockHeader(t.x), t.x).key}`, m ? `[${m[1]} - {}]` : 'no');
      // A list of crew in one cell, "Name(385378-CA),Name(475495-FO)": the order its label writes each one's parts in,
      // "[CA - 385378 - Name]" -> "2,1,0".
      if (!m && /\(.*\)/.test(text)) {
        const first = crewParts(text.split(',')[0]);
        const lab = [...crew.matchAll(/\[([^\]]+)]/g)].map(x => x[1].split(' - ').map(p => p.trim()));
        const same = lab.find(l => l.length === first.length && l.every(p => first.includes(p)));
        if (first.length > 1 && same) vote(crewOrder, `${key}|${headerAt(blockHeader(t.x), t.x).key}`, same.map(p => first.indexOf(p)).join(','));
      }
    }
    // Other info text: a run of info words of one row on one line, as its label writes it.
    for (const l of lines.filter(l => l.y > headers[0].y + 1)) {
      const runs = [];
      for (const t of l.tokens) {
        const last = runs[runs.length - 1];
        // (a mark or value under the next column's header, "15:37" "Y" "Y": a cell of its own)
        const mark = (w) => VALUE_RE.test(w) || /^[A-Z]$/.test(w);
        const apart = last?.end && mark(last.end.t) && mark(t.t) && headerAt(blockHeader(t.x), t.x).key !== headerAt(blockHeader(last.end.x), last.end.x).key;
        if (t.field === 'info' && t.row != null && last && last.row === t.row && last.section === t.section && !apart) { last.text += ` ${t.t}`; last.end = t; continue; }
        runs.push(t.field === 'info' && t.row != null ? { row: t.row, section: t.section, text: t.t, x: t.x, end: t } : {});
      }
      for (const r of runs.filter(r => r.text && !DURATION_RE.test(r.text))) {
        const lab = rowsOf(r.section)[r.row];
        const text = tidyInfo(r.text);
        // A mark ("Y" under "Take off"): the tag its label writes for it, "[Takeoff Day/Night: 1]" (the one named as the
        // column, of the row's tags none of its other words are in)
        if (lab && /^[A-Z]$/.test(text) && !(lab.info || '').split(/[\s\[\]:]+/).includes(text)) {
          const squash = (w) => w.toLowerCase().replace(/[^\p{L}]/gu, '');
          const word = squash(headerAt(blockHeader(r.x), r.x).word || '');
          const others = l.tokens.filter(o => o.row === r.row && o.section === r.section && o.field === 'info' && !/^[A-Z]$/.test(o.t)).map(o => o.t);
          const tags = [...(lab.info || '').matchAll(/\[[^\]]+]/g)].map(m => m[0]).filter(g => !others.some(o => g.includes(o)));
          const tag = word.length > 2 && tags.find(g => squash(g).includes(word));
          if (tag) vote(wrap, `${key}|${headerAt(blockHeader(r.x), r.x).word}`, tag);
          continue;
        }
        if (!lab || !lab.info?.includes(text)) continue;
        const tagged = lab.duty && [...lab.info.matchAll(/\[([^\]]*?): ([^\]]*)]/g)].some(m => m[1] === lab.duty && m[2].includes(text));
        const named = !tagged && new RegExp(`\\[([^\\]\\[:]+): ${text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\]`).exec(lab.info);
        // (a name, "Function", or its column's, "SDC"; not another code, "[OFF: Day Off]" on a row read as another duty)
        const colWord = headerAt(blockHeader(r.x), r.x).word || '';
        const pattern = tagged ? '[{duty}: {}]' : named && (/[a-z]/.test(named[1]) || named[1].toLowerCase() === colWord) ? `[${named[1]}: {}]` : lab.info.includes(`[${text}]`) ? '[{}]' : '{}';
        const col = `${key}|${headerAt(blockHeader(r.x), r.x).word}`;
        vote(wrap, col, pattern);
        // on this row only, or on every event of its day (2+ events)?
        const events = rowsOf(r.section).filter(x => x.date === lab.date && !['C/I', 'C/O', 'H'].includes(x.duty));
        if (events.length > 1) vote(dayWide, col, events.every(x => (x.info || '').includes(text)) ? 'day' : 'row');
      }
    }
    // Dates: does an event's label date match the date above it, or the nearest one (they differ only when centred)?
    const below = lines.filter(l => l.y > headers[0].y + 1);
    const dates = centredDates(below);
    const lineDates = below.filter(l => l.tokens.some(t => t.field === 'date')).map(l => ({ y: l.y, d: parseDateText(l.tokens.filter(t => t.field === 'date').map(t => t.t).join(' ')) })).filter(x => x.d?.day);
    for (const t of page.tokens.filter(t => ANCHORS.has(t.field) && t.row != null)) {
      const want = /^(\d{1,2}) /.exec(rowsOf(t.section)[t.row]?.date || '')?.[1];
      const prev = [...lineDates].reverse().find(x => x.y <= t.y + 1)?.d.day;
      const near = dates.length ? dates.reduce((a, c) => (Math.abs(c.y - t.y) < Math.abs(a.y - t.y) ? c : a)).date.day : null;
      if (!want || prev === near) continue;
      if (+want === prev) vote(dateAnchor, key, 'previous');
      else if (+want === near) vote(dateAnchor, key, 'center');
    }
  }
  // Zone: the letter after the plain times of the label, by what the document says about its times.
  const notices = pdfPages.length ? findNotices(pdfPages) : [];
  for (const row of [...rowsOf('published'), ...rowsOf('planned')]) {
    for (const v of [row.begin, row.end]) {
      const m = /^[AE]?\d{2}:\d{2} (Z|L|B|LB)(?: [+-]\d)?$/.exec(v || '');
      if (m) for (const n of notices) vote(zone, noticeKey(n), m[1]);
      // (the layout's zone for its documents without a note: learned from such documents only)
      if (m && fileLayout && !notices.length) vote(zone, `layout:${fileLayout}`, m[1]);
    }
  }
  // Days after the period's end: does this layout's label put them in planned?
  const period = pdfPages.length ? (findPeriod(pdfPages) || documentPeriod(pdfPages)) : null;
  if (period?.to) {
    const after = (date) => {
      const m = /^(\d{1,2}) ([A-Z][a-z]{2}) (\d{2})$/.exec(date || '');
      if (!m) return false;
      const [d, mo, y] = [+m[1], MONTHS.indexOf(m[2]), +m[3]];
      return y > period.to.year || (y === period.to.year && (mo > period.to.month || (mo === period.to.month && d > period.to.day)));
    };
    for (const sec of ['published', 'planned']) for (const row of rowsOf(sec)) if (after(row.date)) vote(afterPeriod, fileLayout, sec);
  }
  // The "Training Details" table: does this layout's label add its crew to the duty's row?
  const trainings = pdfPages.length ? findTrainings(pdfPages) : [];
  if (trainings.length) {
    const crews = [...rowsOf('published'), ...rowsOf('planned')].map(r => r.crew || '').join(' ');
    vote(trainingCrew, fileLayout, trainings.some(t => t.crew.some(c => crews.includes(`[${c}]`))) ? 'yes' : 'no');
  }
  return { duration, infoOrder, overnight, crewOrder, wrap, dateAnchor, zone, headerWords, place, legendTag, crewShapes, dayWide, afterPeriod, trainingCrew, crewWrap, pairs, crewCarry, crewRoles, infoJoin, coOnce };
}

/** Conventions of several files: the most common answer per key. */
export function mergeConventions(list) {
  const out = { headerWords: [...new Set(list.flatMap(c => Object.keys(c.headerWords || {})))].sort(), crewShapes: {} };
  // duty shapes given crew, per layout: every shape any file of it showed ("9 A9")
  for (const c of list) for (const [k, v] of Object.entries(c.crewShapes || {})) out.crewShapes[k] = [...new Set([...(out.crewShapes[k]?.split(' ') || []), ...Object.keys(v)])].sort().join(' ');
  for (const part of ['duration', 'infoOrder', 'overnight', 'crewOrder', 'wrap', 'dateAnchor', 'zone', 'place', 'legendTag', 'dayWide', 'afterPeriod', 'trainingCrew', 'crewWrap', 'pairs', 'crewCarry', 'crewRoles', 'infoJoin', 'coOnce']) {
    const counts = {};
    for (const c of list) {
      for (const [k, v] of Object.entries(c[part] || {})) {
        // old conventions.json: a duration pattern as a plain string
        const seen = typeof v === 'string' ? { [v]: 1 } : v;
        for (const [p, n] of Object.entries(seen)) ((counts[k] ||= {})[p] = (counts[k]?.[p] || 0) + n);
      }
    }
    out[part] = {};
    for (const [k, v] of Object.entries(counts)) out[part][k] = Object.entries(v).sort((a, b) => b[1] - a[1])[0][0];
  }
  return out;
}
