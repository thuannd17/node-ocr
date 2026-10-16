/**
 * Learned PDF extractor, second half: words already tagged with a field (date,
 * duty, dep, arr, begin, end, ac, registration, hotel, dc, info, route, ci, co,
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
 * hotel table). How bare durations are written ("[Blk Hrs 3:25]") is learned from
 * the labels (`conventions`), keyed by the column header above them;
 * conventions.ocr (roster images): airport codes read with digits are repaired.
 *
 *   assembleRows(tagPages, pdfPages, conventions) -> { published, planned }
 *   learnConventions(tagPages, label) -> conventions of one labeled file (merge with mergeConventions)
 * tagPages: [{ width, height, tokens: [{ t, x, y, w, field }] }], pdfPages: readPdfText() pages.
 */
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { findPeriod, findNotices, findHotels, findLegend, findGridLegend, findOtherCrew, setDutyCrews, findCrewIdLists, setFlightCrews, findTrainings, findMemos, findHotelStays, PLANNED_RE, MONTHS, formatTime } from './pdf-roster-parser.js';
import { repairImageRows } from './roster-parser.js';

const HEADER_WORDS = new Set(JSON.parse(fs.readFileSync(fileURLToPath(new URL('./pdf-header-words.json', import.meta.url)), 'utf8')));
/** Column-header words: the base list plus those the model learned from labeled layouts (conventions.headerWords). */
export const headerWordsOf = (conventions = {}) => (conventions.headerWords?.length ? new Set([...HEADER_WORDS, ...conventions.headerWords]) : HEADER_WORDS);
const headerWordOk = (w) => /^[a-z][a-z/().-]{1,20}$/.test(w);
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const DAY_NAMES = {
  mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6, sun: 0,
  lunes: 1, martes: 2, miércoles: 3, miercoles: 3, jueves: 4, viernes: 5, sábado: 6, sabado: 6, domingo: 0,
};
// The planned part starts at: a NetLine plan's note, an image roster's second table title.
const PLANNED_LINE = [PLANNED_RE, /REST\s*[O0()D]?F\s*TH?I?S?\s*ROS[TI]ER\s*IS\s*P[L1I]?ANNED/i]; // OCR slips: "THERESTOFTHSROSTERISPLANNED", "REST)F", "ROSIER"
export const HOTEL_CODE_RE = /^H(\d+\*?|\?)$/;
const DURATION_RE = /^\d{1,3}:\d{2}$/;
const TIME_IN_RE = /[AE]?!?\d{2}:?\d{2}([+-]\d(?!\d))?/g; // "A02:00": the A (actual) / E (estimated) stays
const ANCHORS = new Set(['duty', 'hotel', 'ci', 'co']);

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

/** Header lines of a page: several known column-header words, most of the line (a word tagged as a value is not a header). */
export function headerLines(lines, words = HEADER_WORDS) {
  return lines.filter((l) => {
    const hits = l.tokens.filter(t => words.has(t.t.toLowerCase()) && (!t.field || t.field === 'O')).length;
    return hits >= 3 && hits >= 0.5 * l.tokens.length;
  });
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
  return { word: cell.map(t => t.t.toLowerCase()).join(' ') };
}

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

export function parseDateText(text) {
  for (const [re, to] of OCR_MONTHS) text = text.replace(re, to);
  const words = text.split(/\s+/);
  const out = {};
  for (const w of words) {
    const name = DAY_NAMES[w.toLowerCase().replace(/[.,]$/, '').slice(0, w.length > 4 ? undefined : 3)];
    if (name != null && !/\d/.test(w)) out.weekday = name;
  }
  let m;
  // A weekday glued to the day by OCR: "Th11", "Thu14", "Fr112" (= Fri 12, "i" read as 1).
  const glued = /(?:^|\s)(Mo|Tu|We|Th|Fr|Sa|Su)[a-z]{0,4}[,.]?(\d{1,3})(?!\d)/i.exec(text);
  if (glued && !/^(Mon|Tue|Wed|Thu|Fri|Sat|Sun)\d{2}$/.test(text.trim())) {
    out.weekday = { mo: 1, tu: 2, we: 3, th: 4, fr: 5, sa: 6, su: 0 }[glued[1].toLowerCase()];
    text = text.replace(glued[0], ` ${glued[2].length === 3 ? glued[2].slice(1) : glued[2]}`);
  }
  // "14 Feb 20", "Mon10 Feb 20", "25 Feb" (an image roster's date cell; a year cut off by OCR is carried on).
  const spaced = new RegExp(`(\\d{1,2})\\s+(${MONTHS.join('|')})[a-z]*\\.?(?:\\s+(\\d{4}|\\d{2})(?!\\d))?`).exec(text);
  if (spaced) {
    Object.assign(out, { day: +spaced[1], month: MONTHS.indexOf(spaced[2]) });
    if (spaced[3]) out.year = +spaced[3] % 100;
  } else if ((m = /(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})/.exec(text))) Object.assign(out, { day: +m[1], month: +m[2] - 1, year: +m[3] % 100 });
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
  const run = (start) => {
    let month = start?.month ?? 0, year = start?.year ?? 0, last = null;
    return parts.map((p) => {
      if (!p || !p.day) return null; // weekday only: placed after the previous row below
      if (p.month != null && p.year != null) { month = p.month; year = p.year; last = p.day; return { day: p.day, month, year }; }
      if (p.month != null) { month = p.month; last = p.day; return { day: p.day, month, year }; }
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
      // A day number with its weekday agreeing ("Sun22") is trusted even after a long gap.
      if (!wOk || (!full && p.weekday == null && (diff < 0 || diff > 14))) {
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
  const times = span.tokens.filter(t => /\d{2}:?\d{2}/.test(t.t));
  if (times.length === 2) {
    const [a, b] = times;
    const aUtc = utcColumn(headers, a.x), bUtc = utcColumn(headers, b.x);
    if (aUtc !== bUtc) {
      const [z, l] = aUtc ? [a, b] : [b, a];
      return `${formatTime(z.t, 'Z')} / ${formatTime(l.t, 'L')}`;
    }
  }
  const m = span.text.match(TIME_IN_RE);
  return m ? formatTime(m[0], plain) : span.text;
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
function spansOf(tokens) {
  const spans = [];
  for (const t of tokens) {
    const last = spans[spans.length - 1];
    const prev = last?.tokens[last.tokens.length - 1];
    if (last && last.field === t.field && t.x - (prev.x + widthOf(prev)) < 25) { last.tokens.push(t); last.text += ` ${t.t}`; } else spans.push({ field: t.field, tokens: [t], text: t.t, x: t.x });
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

/** Zone of a time printed without "!": what the labels of a document saying the same thing used, else the plan's note, else UTC. */
function plainZone(notices, conventions) {
  for (const n of notices) { const z = conventions.zone?.[noticeKey(n)]; if (z) return z; }
  const has = re => notices.some(n => re.test(n));
  return has(/homebase timezone/i) ? 'B' : has(/departure airport timezone/i) ? 'LB' : has(/times are local/i) ? 'L' : 'Z';
}

export function assembleRows(tagPages, pdfPages = [], conventions = {}) {
  const period = pdfPages.length ? findPeriod(pdfPages) : null;
  const plain = plainZone(pdfPages.length ? findNotices(pdfPages) : [], conventions);
  const legend = pdfPages.length ? new Map([...findGridLegend(pdfPages), ...findLegend(pdfPages)]) : new Map();
  const hotels = pdfPages.length ? findHotels(pdfPages) : new Map();
  const words = headerWordsOf(conventions);
  const rows = [];
  const crewOf = new Map(); // group (a day's block / column) -> crew spans, top down
  const dayCodes = new Map(); // group -> indicator codes of the day ("M", "B,M"), from the document's legend
  let datePart = null; // date of the rows that follow
  let lastYear = period?.from?.year ?? null; // the year being read: a lone "23" is that, not a day
  let planned = false;
  let lastHeaders = [];

  const isCodes = (text) => text.split(',').map(c => c.trim()).every(c => c && legend.has(c));
  // a column whose text the labels of this layout put on every event of the day (the day's indicators)
  const dayWide = (s, headers) => {
    const h = headers.length && headerAt(headers[headers.length - 1], s.x);
    return !!h && conventions.dayWide?.[`${layoutKey(headers[0])}|${h.word}`] === 'day';
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
    const spans = spansOf(inBlock);
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
    // A hotel name (not a code like "H1*") on an event's line is a row of its own: "H", at that event's arrival.
    const hotelName = s => s.field === 'hotel' && hasDuty && !HOTEL_CODE_RE.test(s.text);
    for (const s of [...anchors].sort((a, c) => order[a.field] - order[c.field] + (hotelName(a) - hotelName(c)) * 0.5 || a.x - c.x)) {
      if (s.field === 'hotel' && hasDuty && !hotelName(s)) continue; // the hotel code of an event on its line
      const row = make(hotelName(s) ? 'hotelname' : s.field);
      row.x = s.x;
      if (s.field === 'ci') { row.f.duty = 'C/I'; row.f.begin = s; } else if (s.field === 'co') { row.f.duty = 'C/O'; row.f.end = s; } else if (hotelName(s)) { row.f.duty = 'H'; row.info.push({ text: s.text }); } else row.f[s.field] = s;
      lineRows.push(row);
    }
    const mains = lineRows.filter(r => r.anchor === 'duty' || r.anchor === 'hotel');
    const isHotelSpan = s => s.field === 'hotel' && hasDuty;
    // 3. The other words.
    for (const s of spans) {
      if (s.field === 'date' || (ANCHORS.has(s.field) && !(isHotelSpan(s) && !hotelName(s)))) continue;
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
    const lines = headers.length ? allLines.filter(l => l.y > headers[0].y + 1) : allLines;
    if (headers.length) lastHeaders = headers;
    const pageHeaders = headers.length ? headers : lastHeaders;
    // Layouts whose labels put each event on the date nearest to it (the date in the middle of its day).
    const layout = layoutKey(pageHeaders[0]);
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

  // C/I takes the departure of the event after it, C/O the arrival of the one before,
  // in layouts whose labels write them so (conventions.place).
  rows.forEach((r, i) => {
    if (r.anchor === 'ci' && conventions.place?.[`${r.layout}|ci`] !== 'no') r.f.dep ||= rows.slice(i + 1).find(n => n.f.dep)?.f.dep;
    if (r.anchor === 'co' && conventions.place?.[`${r.layout}|co`] !== 'no') r.f.arr ||= [...rows.slice(0, i)].reverse().find(n => n.f.arr)?.f.arr;
    if (r.anchor === 'hotelname') r.f.dep ||= [...rows.slice(0, i)].reverse().find(n => n.f.arr)?.f.arr;
  });

  const dates = resolveDates(rows.map(r => r.date), period);
  const written = []; // [{ r, section, ymd, row }] in order
  rows.forEach((r, i) => {
    const d = dates[i];
    const val = f => (r.f[f] && typeof r.f[f] === 'object' ? r.f[f].text : r.f[f] || '');
    let dep = val('dep'), arr = val('arr');
    if (conventions.ocr) { dep = ocrAirport(dep); arr = ocrAirport(arr); }
    if (r.f.route) {
      const [a, c] = val('route').split('/').map(s => s.trim());
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
    for (const e of cellsOf(r)) {
      if (e.codes) { if (isEventRow && codesAt < 0) { codesAt = info.length; for (const c of e.codes) if (!info.includes(codeTag(c))) info.push(codeTag(c)); } continue; }
      const text = typeof e === 'string' ? e : e.wrap && duty ? e.wrap.replace('{duty}', duty).replace('{}', e.text) : e.text;
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
    const time = (f) => {
      if (!r.f[f] || typeof r.f[f] !== 'object') return '';
      const span = f === 'end' && r.endNextDay && !/[+-]\d$/.test(r.f[f].text) ? { ...r.f[f], text: `${r.f[f].text}+1` } : r.f[f];
      return formatTimes(span, plain, r.headers || []);
    };
    const section = period?.to && d && conventions.afterPeriod?.[r.layout] !== 'published' && (d.year > period.to.year || (d.year === period.to.year && (d.month > period.to.month || (d.month === period.to.month && d.day > period.to.day)))) ? 'planned' : r.section;
    written.push({ r, section, ymd: d ? Date.UTC(2000 + d.year, d.month, d.day) : null, crewShapes: conventions.crewShapes?.[r.layout], row: {
      date: d ? `${d.day} ${MONTHS[d.month]} ${String(d.year).padStart(2, '0')}` : '',
      day: d ? WEEKDAYS[weekdayOf(d)] : '',
      hotel, dc: val('dc'), duty, registration: val('registration'), dep, begin: time('begin'), end: time('end'), arr, ac, crew: '',
      // "Delay" "00:50" printed under a flight: its delay
      info: info.filter(Boolean).join(' ').replace(/\s+/g, ' ').trim().replace(/(^|\s)Delay (\d{1,2}:\d{2})(?=\s|$)/g, '$1[Delay $2]'),
      ...(conventions.debug ? { _dateText: r.date?.text || '' } : {}),
    } });
  });
  if (pdfPages.length) joinDocumentTables(written, pdfPages, { crewOf, dayCodes, legend, conventions });
  const out = { published: [], planned: [] };
  for (const w of written) out[w.section].push(w.row);
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
    const members = [];
    for (const s of [...spans].sort((a, b) => a.tokens[0].y - b.tokens[0].y)) {
      const text = s.text.replace(/\s+/g, ' ').trim();
      if (/^[A-Z]{2,3} - /.test(text) || !members.length) members.push(text);
      else members[members.length - 1] = `${members[members.length - 1].replace(/\s*-$/, ' -')} ${text}`;
    }
    const crew = members.map(m => `[${m}]`).join('');
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
    const w = written.find(x => x.ymd != null && ddmmyyyy(x.ymd) === t.date && (x.row.duty || '').replace(/^[A-Z]*0*/, '') === t.duty.replace(/^[A-Z]*0*/, ''));
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
          dep: stay.port, begin: '', end: '', arr: '', ac: '', crew: '', info: [stay.address, stay.phone && `Tel ${stay.phone}`].filter(Boolean).join(', ') },
      });
    }
  }
}

/** "WAZ7015" -> "A9" (letters A, digits 9, runs collapsed): what kind of number a duty is. */
const dutyShape = (duty) => String(duty || '').replace(/[A-Z]+/g, 'A').replace(/\d+/g, '9');

/** OCR text: an airport code read with digits ("ED1", "8RU") -> letters ("EDI", "BRU"). */
const ocrAirport = v => (/^[A-Z0-9]{3}$/.test(v) && /\d/.test(v) ? v.replace(/[0-9]/g, d => ({ 0: 'O', 1: 'I', 5: 'S', 8: 'B', 2: 'Z', 6: 'G' })[d] || d) : v);

/** A row's info entries; in a centred day, the pieces of one column's cell (lines above and under the row) joined top down. */
function cellsOf(r) {
  if (!r.centred) return r.info;
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
function infoText(span, headers, conventions) {
  const text = tidyInfo(span.text);
  const h = headerAt(headers[headers.length - 1], span.x);
  if (DURATION_RE.test(text)) {
    const pattern = h && conventions.duration?.[h.word];
    return pattern ? pattern.replace('{}', text) : text;
  }
  const wrap = h && conventions.wrap?.[`${layoutKey(headers[0])}|${h.word}`];
  return { text, ...(wrap && wrap !== '{}' ? { wrap } : {}), col: h?.word ?? null, y: span.tokens[0].y };
}

/**
 * What a labeled file teaches about its layout (tagPages with the true tags):
 *   duration:   how a bare duration in an info column is written ("3:25" under "Blk" -> "[Blk Hrs {}]")
 *   wrap:       how other info text is written, per layout and column ("Requested Day Off" -> "[{duty}: {}]")
 *   dateAnchor: whether an event belongs to the date above it ('previous') or the nearest one ('center'), per layout
 *   zone:       the zone letter of times printed plain, per note of the document ("All times in Local Station" -> L)
 * Counts per key; mergeConventions keeps the most common answer.
 */
export function learnConventions(tagPages, label, pdfPages = []) {
  const duration = {}, wrap = {}, dateAnchor = {}, zone = {}, headerWords = {}, place = {}, legendTag = {}, crewShapes = {}, dayWide = {}, afterPeriod = {}, trainingCrew = {};
  const rowsOf = sec => label[sec] || [];
  const vote = (obj, key, val) => { const seen = (obj[key] ||= {}); seen[val] = (seen[val] || 0) + 1; };
  // Column headers: the line right above a page's first row, 3+ words none of which belongs to a row,
  // most of them standing over a column of row values (a crew list or a title above the table does not).
  for (const page of tagPages) {
    const lines = toLines(page.tokens);
    if (dayColumns(lines)) continue;
    const first = lines.findIndex(l => l.tokens.some(t => t.row != null && t.field !== 'O'));
    const above = first > 0 ? lines[first - 1] : null;
    if (!above || lines[first].y - above.y > 40 || above.tokens.length < 3 || above.tokens.some(t => t.field !== 'O')) continue;
    const values = lines.slice(first, first + 6).flatMap(l => l.tokens.filter(t => t.field !== 'O'));
    const overColumn = above.tokens.filter(h => values.some(v => Math.abs(v.x - h.x) < 20));
    if (overColumn.length < 3 || overColumn.length < 0.5 * above.tokens.length) continue;
    for (const t of overColumn) { const w = t.t.toLowerCase(); if (headerWordOk(w)) headerWords[w] = (headerWords[w] || 0) + 1; }
  }
  const words = new Set([...HEADER_WORDS, ...Object.keys(headerWords)]);
  // Whether this layout's C/I rows carry the airport (dep) and its C/O rows the arrival.
  const fileLayout = (() => {
    for (const page of tagPages) {
      const lines = toLines(page.tokens);
      if (dayColumns(lines)) return 'grid';
      const h = headerLines(lines, words);
      if (h.length) return layoutKey(h[0]);
    }
    return '';
  })();
  for (const row of [...rowsOf('published'), ...rowsOf('planned')]) {
    if (row.duty === 'C/I') vote(place, `${fileLayout}|ci`, row.dep ? 'yes' : 'no');
    if (row.duty === 'C/O') vote(place, `${fileLayout}|co`, row.arr ? 'yes' : 'no');
    if (row.crew && row.dep && row.arr) (crewShapes[fileLayout] ||= {})[dutyShape(row.duty)] = 1;
  }
  // Does this layout's label add a duty's legend description ("[OFF: Day off]")? Only rows whose own words carry no info say so.
  const legend = pdfPages.length ? new Map([...findGridLegend(pdfPages), ...findLegend(pdfPages)]) : new Map();
  // (an indicator code of the legend, "D" or "B,M", is not such info)
  const isCode = (w) => w.split(',').every(c => legend.has(c.trim()));
  const withInfo = new Set(tagPages.flatMap(p => p.tokens.filter(t => t.field === 'info' && t.row != null && !isCode(t.t)).map(t => `${t.section}|${t.row}`)));
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
    const key = layoutKey(headers[0]);
    const starts = blockStarts(headers, words);
    const blockOf = x => starts.filter(s => x >= s).length - 1;
    const blockHeader = (x) => { const tokens = header.tokens.filter(h => blockOf(h.x) === blockOf(x)); return tokens.length ? { tokens } : header; };
    // Only a duration alone in its cell ("3:25" under "Blk Hrs"), not one inside a printed stat ("[ FT 05:49 ]").
    const alone = new Set();
    for (const l of lines) {
      l.tokens.forEach((t, k) => {
        const same = n => n && n.field === t.field && n.row === t.row && n.section === t.section;
        if (!same(l.tokens[k - 1]) && !same(l.tokens[k + 1])) alone.add(t);
      });
    }
    for (const t of page.tokens) {
      if (!['info', 'co_info', 'ci_info'].includes(t.field) || !DURATION_RE.test(t.t) || t.row == null || !alone.has(t)) continue;
      const info = rowsOf(t.section)[t.row]?.info || '';
      const m = new RegExp(`\\[([^\\]]*?)\\s*${t.t.replace(/[.:]/g, '\\$&')}\\]`).exec(info);
      if (!m) continue;
      vote(duration, headerAt(blockHeader(t.x), t.x).word, m[1] ? `[${m[1]} {}]` : '[{}]');
    }
    // Other info text: a run of info words of one row on one line, as its label writes it.
    for (const l of lines.filter(l => l.y > headers[0].y + 1)) {
      const runs = [];
      for (const t of l.tokens) {
        const last = runs[runs.length - 1];
        if (t.field === 'info' && t.row != null && last && last.row === t.row && last.section === t.section) { last.text += ` ${t.t}`; continue; }
        runs.push(t.field === 'info' && t.row != null ? { row: t.row, section: t.section, text: t.t, x: t.x } : {});
      }
      for (const r of runs.filter(r => r.text && !DURATION_RE.test(r.text))) {
        const lab = rowsOf(r.section)[r.row];
        const text = tidyInfo(r.text);
        if (!lab || !lab.info?.includes(text)) continue;
        const tagged = lab.duty && [...lab.info.matchAll(/\[([^\]]*?): ([^\]]*)]/g)].some(m => m[1] === lab.duty && m[2].includes(text));
        const pattern = tagged ? '[{duty}: {}]' : lab.info.includes(`[${text}]`) ? '[{}]' : '{}';
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
    }
  }
  // Days after the period's end: does this layout's label put them in planned?
  const period = pdfPages.length ? findPeriod(pdfPages) : null;
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
  return { duration, wrap, dateAnchor, zone, headerWords, place, legendTag, crewShapes, dayWide, afterPeriod, trainingCrew };
}

/** Conventions of several files: the most common answer per key. */
export function mergeConventions(list) {
  const out = { headerWords: [...new Set(list.flatMap(c => Object.keys(c.headerWords || {})))].sort(), crewShapes: {} };
  // duty shapes given crew, per layout: every shape any file of it showed ("9 A9")
  for (const c of list) for (const [k, v] of Object.entries(c.crewShapes || {})) out.crewShapes[k] = [...new Set([...(out.crewShapes[k]?.split(' ') || []), ...Object.keys(v)])].sort().join(' ');
  for (const part of ['duration', 'wrap', 'dateAnchor', 'zone', 'place', 'legendTag', 'dayWide', 'afterPeriod', 'trainingCrew']) {
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
