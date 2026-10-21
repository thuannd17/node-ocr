/**
 * Training tags from a verified label, without the parser: which words of the
 * PDF hold each label row's values. This is what lets the learned extractor
 * learn a roster format the parser does not read: fix the rows in /label, save,
 * retrain.
 *
 *   alignLabel(tagPages, label) -> { tokens tagged in place, stats }
 * Each token gets field (date, duty, dc, registration, dep, arr, begin, takeoff, landing, end, ac,
 * hotel, info, ci, co, co_info, O, or "?" = not sure, left out of training),
 * section and row.
 *
 * How: rows are found in reading order (services/pdf-row-assembler.js
 * readingLines), each by its anchor word (duty, hotel code, C/I-C/O time, ...),
 * searched forward from the previous row's line. A row's other values are looked
 * for on its own lines (its line up to the next row's line): times in any
 * printed form ("0800", "08:00", "!0800", "2100-1"), dates ("Sun01", "01.",
 * "01Dec24", "14.08.", "01/12/2024"), info word by word. Values the PDF does
 * not print near the row (a legend description, a hotel's name from the hotel
 * table, a C/I row's airport) are not looked for. Lines of a row with a value
 * not found are marked "?" so a miss never teaches the model "O".
 */
import { readingLines, parseDateText, HOTEL_CODE_RE } from './pdf-row-assembler.js';
import { hotelFromEvent } from './pdf-roster-parser.js';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WEEKDAY_RE = /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun|Lunes|Martes|Mi[ée]rcoles|Jueves|Viernes|S[áa]bado|Domingo)\.?,?$/i;

/** "08:00 LB" / "21:00 Z -1" / "00:54 L +1" -> [{ hhmm: '0800', off: '' }, ...] (two for "05:00 Z / 00:00 L"). */
function timesOf(value) {
  return [...String(value || '').matchAll(/(\d{2}):(\d{2})(?:\s+[A-Z]{1,2})?(?:\s+([+-]\d))?/g)].map(m => ({ hhmm: m[1] + m[2], off: m[3] || '' }));
}

// OCR text (images): read slips like "ED1" for "EDI", "00:00)" for "00:00" still count as the value.
let FUZZY = false;
const CONFUSED = { 0: 'O', 1: 'I', 5: 'S', 8: 'B', 2: 'Z', 6: 'G' };
const looseText = s => s.toUpperCase().replace(/[.,;:)]+$/, '').replace(/^[(]+/, '').replace(/[0-9]/g, d => CONFUSED[d] || d);
/** A word printed as this value word (exactly; for OCR text also with confusable characters). */
const same = (t, w) => t === w || (FUZZY && w.length >= 2 && looseText(t) === looseText(w));

/** Does a word print this time? "0800", "08:00", "!0800", "2100-1", "!0054+1". */
function wordIsTime(tok, time) {
  let t = typeof tok === 'string' ? tok : tok.t;
  if (FUZZY) t = t.replace(/^[(]/, '').replace(/[)Z.,]+$/, '');
  const m = /^!?(\d{2}):?(\d{2})([+-]\d)?$/.exec(t);
  return !!m && m[1] + m[2] === time.hhmm && (m[3] || '') === time.off;
}

/** "1 Dec 24" -> { day, month, year }. */
function labelDate(value) {
  const m = /^(\d{1,2}) ([A-Z][a-z]{2}) (\d{2})$/.exec(String(value || '').trim());
  return m ? { day: +m[1], month: MONTHS.indexOf(m[2]), year: +m[3] } : null;
}

const norm = s => s.replace(/[[\]()]/g, '').replace(/[,;]$/, '');
// a label's take-off / landing count, as one word to find
const TAKEOFF_WORD = '\u0001takeoff', LANDING_WORD = '\u0001landing';

export function alignLabel(tagPages, label, { ocr = false } = {}) {
  FUZZY = ocr;
  const lines = readingLines(tagPages);
  for (const p of tagPages) for (const t of p.tokens) { t.field = 'O'; delete t.section; delete t.row; }
  const used = new Set();
  const take = (t, field, sec, row) => { used.add(t); t.field = field; t.section = sec; t.row = row; };
  const free = t => !used.has(t);

  const rows = [];
  // a label's hotel night (duty "H1*" / "HT") as the words are tagged: a hotel code, or duty "H" with the hotel's name
  for (const sec of ['published', 'planned']) (label[sec] || []).forEach((r, i) => rows.push({ sec, i, r: hotelFromEvent(r) }));

  // Which line each token is on.
  const lineOf = new Map();
  lines.forEach((l, li) => l.tokens.forEach(t => lineOf.set(t, li)));

  /**
   * Words in a row (same line, consecutive) that print the value: word for word,
   * or, with the default test, the same characters spaced differently ("FR6652"
   * printed "FR 6652", "OFF (Z)" for "OFF(Z)").
   */
  const findWords = (words, fromLine, toLine, test = null) => {
    const target = words.join('');
    for (let li = fromLine; li <= Math.min(toLine, lines.length - 1); li++) {
      const toks = lines[li].tokens;
      for (let k = 0; k < toks.length; k++) {
        if (test) {
          if (k + words.length <= toks.length && words.every((w, j) => free(toks[k + j]) && test(toks[k + j], w))) return toks.slice(k, k + words.length);
          continue;
        }
        let joined = '';
        for (let j = k; j < Math.min(toks.length, k + 4) && free(toks[j]); j++) {
          joined += toks[j].t;
          if (same(joined, target)) return toks.slice(k, j + 1);
          if (joined.length >= target.length + 2) break;
        }
      }
    }
    // A value printed as one word ("OFF(Z)" vs "OFF (Z)") or split over two lines is not searched further.
    return null;
  };

  const stats = { rows: rows.length, anchored: 0, missing: {}, ignoredLines: 0 };
  const miss = (f) => { stats.missing[f] = (stats.missing[f] || 0) + 1; };

  // 1. Anchors, in order.
  let cursor = 0;
  const WINDOW = 60; // lines a row may be after the previous one
  const NEAR = 6; // lines a day's first row may be after its date
  let prevDate = null;
  for (const row of rows) {
    const { r } = row;
    // A new day: its row starts at its date (when printed), not at the same code earlier ("URLAUB" every day).
    const d = labelDate(r.date);
    const start = cursor;
    // How far after the previous row this one may be: near its date when the date is printed (a misread
    // duty must not be found again weeks later), else a window (OCR text: a small one).
    let limit = cursor + (FUZZY ? 8 : WINDOW);
    if (d && r.date !== prevDate) {
      for (let li = cursor; li < Math.min(lines.length, limit); li++) {
        if (lines[li].tokens.some(t => free(t) && (() => { const p = parseDateText(t.t); return p && p.day === d.day && (p.month == null || p.month === d.month); })())) { cursor = li; limit = li + NEAR; break; }
      }
    }
    prevDate = r.date;
    const duty = String(r.duty || '').trim();
    const derivedCiCo = (duty === 'C/I' || duty === 'C/O') && !findWords([duty], cursor, limit);
    const hotelName = duty === 'H' && r.info && !r.hotel;
    let found = null, field = null;
    if (derivedCiCo) {
      const time = timesOf(duty === 'C/I' ? r.begin : r.end)[0];
      if (time) { found = findWords([time], cursor, limit, wordIsTime); field = duty === 'C/I' ? 'ci' : 'co'; }
    } else if (hotelName) {
      found = findWords(r.info.split(/\s+/), cursor, limit); field = 'hotel';
    } else if (duty) {
      found = findWords(duty.split(/\s+/), cursor, limit); field = 'duty';
    } else if (r.hotel) {
      found = findWords([r.hotel], cursor, limit); field = 'hotel';
    }
    if (!found && !duty && !r.hotel) {
      // No duty: the first value the row prints (calendar rows, flight logs, message-only days).
      const time = timesOf(r.begin)[0];
      if (time) { found = findWords([time], cursor, limit, wordIsTime); field = 'begin'; }
      if (!found && r.dep) { found = findWords([r.dep], cursor, limit); field = 'dep'; }
      if (!found && r.info) {
        const w = r.info.split(/\s+/).find(x => !/^\[/.test(x));
        if (w) { found = findWords([w], cursor, limit, (t, v) => norm(t.t) === norm(v)); field = 'info'; }
      }
    }
    row.derivedCiCo = derivedCiCo;
    row.hotelName = hotelName;
    if (!found && cursor !== start) { cursor = start; row.retry = true; } // date not printed with it: search as before
    if (!found && row.retry) {
      row.retry = false;
      if (derivedCiCo) { const time = timesOf(duty === 'C/I' ? r.begin : r.end)[0]; if (time) found = findWords([time], cursor, limit, wordIsTime); }
      else if (hotelName) found = findWords(r.info.split(/\s+/), cursor, limit);
      else if (duty) found = findWords(duty.split(/\s+/), cursor, limit);
      else if (r.hotel) found = findWords([r.hotel], cursor, limit);
    }
    if (!found) { row.line = null; miss('anchor'); continue; }
    stats.anchored += 1;
    if (field === 'begin' && timesOf(r.begin).length === 2) {
      // "05:00 Z / 00:00 L": both times are the begin.
      const other = findWords([timesOf(r.begin)[1]], lineOf.get(found[0]), lineOf.get(found[0]), wordIsTime);
      if (other) found.push(...other);
    }
    for (const t of found) take(t, field, row.sec, row.i);
    row.line = lineOf.get(found[0]);
    row.anchorField = field;
    cursor = row.line;
  }

  // 2. Each row's lines: its anchor line up to the next anchored row's line (the same line when they share it).
  const anchored = rows.filter(r => r.line != null);
  anchored.forEach((row, k) => {
    const next = anchored[k + 1];
    row.last = next ? Math.max(row.line, next.line - (next.line > row.line ? 1 : 0)) : Math.min(row.line + 3, lines.length - 1);
  });

  // 3. Values of each row.
  let lastDateKey = null;
  for (const row of anchored) {
    const { r, sec, i } = row;
    const from = row.line, to = row.last;
    const missed = [];
    const one = (field, value, as = field) => {
      if (!value || row.anchorField === field) return;
      const got = findWords(String(value).trim().split(/\s+/), from, to);
      if (got) got.forEach(t => take(t, as, sec, i)); else missed.push(field);
    };
    const time = (field, value, as = field) => {
      if (row.anchorField === field) return;
      for (const tm of timesOf(value)) {
        const got = findWords([tm], from, to, wordIsTime);
        if (got) take(got[0], as, sec, i); else missed.push(field);
      }
    };
    if (!row.derivedCiCo && !row.hotelName) {
      one('dep', r.dep);
      one('arr', r.arr);
      one('ac', r.ac);
      one('registration', r.registration);
      one('dc', r.dc);
      if (row.anchorField !== 'hotel') one('hotel', r.hotel);
      time('begin', r.begin);
      time('takeoff', r.takeoff);
      time('landing', r.landing);
      time('end', r.end);
    } else if (row.derivedCiCo && row.anchorField === 'co' && timesOf(r.begin).length) time('begin', r.begin);
    // Date: the day's first row, on its line or the lines just before it (since the previous row).
    const d = labelDate(r.date);
    const key = `${sec}|${r.date}`;
    const isDate = t => { const p = parseDateText(t.t); return p && p.day === d.day && (p.month == null || p.month === d.month); };
    // A date printed on the row's own line (flight logs print it on every row); else the day's first row looks above.
    const ownLine = d && lines[from].tokens.some(t => free(t) && t.field === 'O' && isDate(t) && t.x < lines[from].tokens.find(a => a.row === i && a.section === sec)?.x);
    if (d && (key !== lastDateKey || ownLine)) {
      lastDateKey = key;
      const prev = anchored[anchored.indexOf(row) - 1];
      const start = ownLine ? from : prev ? prev.line : Math.max(0, from - 3);
      let hit = null;
      for (let li = from; li >= start && !hit; li--) {
        const cand = lines[li].tokens.find(t => free(t) && isDate(t));
        if (cand) hit = cand;
      }
      if (!hit) {
        // The day number lost (OCR "Wed Feb 20"): its weekday / month words on the row's line are still the date.
        const wd = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'][new Date(Date.UTC(2000 + d.year, d.month, d.day)).getUTCDay()];
        const anchorX = lines[from].tokens.find(a => a.row === i && a.section === sec)?.x ?? Infinity;
        for (const t of lines[from].tokens) {
          if (!free(t) || t.x >= anchorX) continue;
          const w = t.t.toLowerCase().replace(/[.,]$/, '');
          if (w.slice(0, 3) === wd || new RegExp(`^${MONTHS[d.month]}`, 'i').test(t.t) || t.t === String(d.year).padStart(2, '0')) take(t, 'date', sec, i);
        }
      }
      if (hit) {
        take(hit, 'date', sec, i);
        // Weekday / year / month words printed next to it ("01. Thu", "Lunes 01/07/2024", "2024 8 14.08.").
        const lt = lines[lineOf.get(hit)].tokens;
        const at = lt.indexOf(hit);
        // Also "31 Jan 20 Fri" (an image roster's date cell): month name, two-digit year, weekday, as long as they follow on.
        const partOfDate = (t, left) => free(t) && (WEEKDAY_RE.test(t.t.replace(/,$/, ''))
          || (left && (+t.t === 2000 + d.year || +t.t === d.month + 1))
          || new RegExp(`^${MONTHS[d.month]}`, 'i').test(t.t) || (!left && t.t === String(d.year).padStart(2, '0')));
        for (let j = at - 1; j >= Math.max(0, at - 2) && partOfDate(lt[j], true); j--) take(lt[j], 'date', sec, i);
        for (let j = at + 1; j < Math.min(lt.length, at + 4) && partOfDate(lt[j], false); j++) take(lt[j], 'date', sec, i);
      }
    }
    row.missed = missed;
  }

  // 4. Info, word by word: first on the row's own lines, then a few lines after them (a stats line under a hotel line).
  const infoField = row => (row.derivedCiCo ? (r => (r.duty === 'C/I' ? 'ci_info' : 'co_info'))(row.r) : 'info');
  for (const pass of [0, 1]) {
    for (const row of anchored) {
      if (row.hotelName) continue;
      if (!row.infoLeft) {
        const duty = String(row.r.duty || '').trim();
        const text = String(row.r.info || '');
        // The legend description at the end ("[SSB: Short Standby]") is printed elsewhere.
        const own = (duty && text.endsWith(']') && text.lastIndexOf(`[${duty}: `) >= 0 ? text.slice(0, text.lastIndexOf(`[${duty}: `)) : text)
          // "[Takeoff Day/Night: 1]" is the printed "1Take-off," / "Take-off," (takeoffLandingTags), "[Landing Day/Night: 1]" "Landing"
          .replace(/\[Takeoff Day\/Night: \d+]/g, TAKEOFF_WORD).replace(/\[Landing Day\/Night: \d+]/g, LANDING_WORD);
        row.infoLeft = own.split(/\s+/).filter(Boolean).map(norm).filter(Boolean);
        // Words that must be found: all but a bracket's name ("Block:" of "[Block: 3:25]" may be the label's own words).
        row.infoNeed = new Set();
        for (const m of own.matchAll(/\[[^\]]*]|\S+/g)) {
          const ws = m[0].split(/\s+/);
          for (const w of m[0].startsWith('[') ? ws.filter(x => /\d/.test(x)) : ws) if (norm(w)) row.infoNeed.add(norm(w));
        }
      }
      if (!row.infoLeft.length) continue;
      const from = pass ? row.last + 1 : row.line, to = pass ? row.last + 4 : row.last;
      for (let li = from; li <= Math.min(to, lines.length - 1) && row.infoLeft.length; li++) {
        for (const t of lines[li].tokens) {
          if (!free(t)) continue;
          // "00:00][DT": stats printed without spaces are several label words.
          const parts = t.t.split(/[\])]\s*[[(]/).map(norm).filter(Boolean);
          const left = [...row.infoLeft];
          const asLabel = w => (/^\d*Take-off$/.test(w) && left.includes(TAKEOFF_WORD) ? TAKEOFF_WORD : /^\d*Landing$/.test(w) && left.includes(LANDING_WORD) ? LANDING_WORD : w);
          const ok = parts.length && parts.every(w => { const k = left.indexOf(asLabel(w)); if (k < 0) return false; left.splice(k, 1); return true; });
          if (ok) { take(t, infoField(row), row.sec, row.i); for (const w of parts) row.infoNeed.delete(asLabel(w)); row.infoLeft = left; }
          else if (/^[\])]$/.test(t.t) && row.infoLeft.length >= 0 && lines[li].tokens[lines[li].tokens.indexOf(t) - 1]?.field === infoField(row)) take(t, infoField(row), row.sec, row.i);
        }
      }
    }
  }
  // A lone "[" / "(" opening a stat the label has ("[ FT 05:49 ]").
  for (const l of lines) {
    l.tokens.forEach((t, k) => {
      const next = l.tokens[k + 1];
      if (t.field === 'O' && /^[[(]$/.test(t.t) && next && /info$/.test(next.field)) take(t, next.field, next.section, next.row);
    });
  }
  // Hotel names written out on rows of hotel codes come from the hotel table: not missing.
  for (const row of anchored) {
    if (row.infoNeed?.size && !(row.r.hotel && HOTEL_CODE_RE.test(row.r.hotel))) row.missed.push('info');
  }

  // 5. Rows with a value not found: their lines' untagged words are unsure.
  for (const row of rows) {
    if (row.line == null) continue;
    for (const f of row.missed) miss(f);
    if (row.missed.length) {
      for (let li = row.line; li <= row.last; li++) for (const t of lines[li].tokens) if (t.field === 'O') t.field = '?';
      stats.ignoredLines += row.last - row.line + 1;
    }
  }
  // A row not found at all: the whole stretch between its neighbours is unsure.
  rows.forEach((row, k) => {
    if (row.line != null) return;
    const before = rows.slice(0, k).reverse().find(x => x.line != null);
    const after = rows.slice(k + 1).find(x => x.line != null);
    const a = before ? before.line : 0, b = after ? after.line : lines.length - 1;
    for (let li = a; li <= b; li++) for (const t of lines[li].tokens) if (t.field === 'O') t.field = '?';
  });
  return stats;
}
