/**
 * ACARS pictures: a photo or screenshot of the cockpit's ACARS / AOC "OOOI" page
 * (FLIGHT NO, DEPT/DEST, OUT, OFF, ON, IN, BLOCK, FLIGHT), read by OCR.
 *
 * A label (ground truth, /label "ACARS files") is one flat object:
 *   { flt: "DE4800", date: "11 Nov 25", dept: "EDDL", dest: "EDDF", out: "09:58", off: "10:14", on: "10:45", in: "10:55",
 *     info: "[Flight: 00:31] [Block: 00:57]" }
 * Times as HH:MM, as printed (ACARS prints UTC); a value the page does not show ("----") is ''.
 * The date as much of it as the page prints: "11 Nov 25" (11NOV25, 11/11/25), "28 May" (28/MAY), "14" (the day
 * after the flight number: QFA0057/14, 0875-15).
 *
 *   acarsWordPages(lines, width, height)  OCR lines -> words for the tagger (services/ocr-tokens.js, kind 'acars'),
 *                                        after undoing OCR glue ("0UT23:30", "EDDH/LSZH", "1 5 1 2")
 *   parseAcars(pages)                    the rule-based reader (label words -> the value under or after them): /label Auto-fill
 *   alignAcars(pages, label)             training tags from a label (scripts/build-acars-token-data.mjs)
 *   assembleAcars(pages)                 the AI model's tags -> a label-shaped result
 *   compareAcars(pred, label)            per-field score (model benchmark)
 *
 * The tagger's ACARS fields (ACARS_TAGS) are its own: flt, adate, dept, dest, out, off, on, in, block, flight
 * ("adate", not "date": a roster's date is another field of the same tagger); block and flight go to info.
 */
import { ocrWordPages } from './ocr-tokens.js';

export const ACARS_FIELDS = ['flt', 'date', 'dept', 'dest', 'out', 'off', 'on', 'in', 'info'];
export const ACARS_TAGS = ['flt', 'adate', 'dept', 'dest', 'out', 'off', 'on', 'in', 'block', 'flight'];
const TIME_TAGS = ['out', 'off', 'on', 'in', 'block', 'flight'];

export const emptyAcars = () => Object.fromEntries(ACARS_FIELDS.map(f => [f, '']));

// ---- OCR text ----

// OCR reads digits as look-alike letters on these screens ("1Z11", "02SEP2Z", "0UT").
const AS_DIGIT = { O: '0', D: '0', Q: '0', I: '1', L: '1', '|': '1', T: '1', Z: '2', S: '5', B: '8', G: '6' };
const AS_LETTER = { 0: 'O', 1: 'I', 2: 'Z', 5: 'S', 8: 'B', 6: 'G' };
/** Letters of a label word, OCR digits read back as letters: "0UT" -> "OUT", "FLIGHI" -> "FLIGHI". */
export const labelText = (t) => String(t || '').toUpperCase().replace(/[0-9]/g, d => AS_LETTER[d] || d).replace(/[^A-Z]/g, '');

/**
 * A printed time or duration -> "HH:MM", '' when it is not one: "0958Z", "09:58", "1Z11", "15:32:25",
 * "0 7 3 9 Z" (spaces already removed), "0256" (a duration), "141228" (HHMMSS), "01+16" (a duration).
 */
export function toHHMM(text) {
  let t = String(text || '').toUpperCase().trim().replace(/\s+/g, '');
  if (!t || /[A-Z]{3}/.test(t.replace(/Z$/, ''))) return '';
  t = t.replace(/Z$/, '');
  if (!/^[0-9OQDILTZSBG|:.+]+$/.test(t)) return '';
  const secs = /^(\w{1,2})[:.](\w{2})[:.](\w{2})$/.exec(t); // 15:32:25 -> 15:32
  if (secs) t = secs[1] + secs[2];
  let d = t.replace(/[:.+]/g, '').replace(/[A-Z|]/g, c => AS_DIGIT[c] ?? c);
  if (/^\d{6}$/.test(d) && !/[:.+]/.test(t)) d = d.slice(0, 4); // HHMMSS: 141228 -> 14:12
  if (!/^\d{3,4}$/.test(d)) return '';
  const p = d.padStart(4, '0');
  return Number(p.slice(2)) < 60 ? `${p.slice(0, 2)}:${p.slice(2)}` : '';
}

const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
const toDigits = (s) => s.replace(/[A-Z|]/g, c => AS_DIGIT[c] ?? c);
const toLetters = (s) => s.replace(/[0-9]/g, d => AS_LETTER[d] || d);

/**
 * A printed date -> { d, m?, y? } (m 0-11, y 2 digits), null when it is not one: "02SEP22", "07N0V2Z" (OCR slips),
 * "27OCT", "27/11/22" (day first), "28/MAY", "22JAN26". dayOnly: a bare day ("14") counts too.
 */
export function parseAcarsDate(text, { dayOnly = false } = {}) {
  const t = String(text || '').toUpperCase().replace(/\s+/g, '').replace(/^[/-](?=\d)/, ''); // "/21" after a flight number
  const day = (s) => { const d = Number(toDigits(s)); return d >= 1 && d <= 31 ? d : null; };
  let m = /^([0-9OIZSBGLT]{1,2})([A-Z0-9]{3})([0-9OIZSBGLT]{2})?$/.exec(t);
  if (m && /[A-Z]/.test(m[2])) {
    const mon = MONTHS.indexOf(toLetters(m[2]).replace('0', 'O'));
    const y = m[3] ? toDigits(m[3]) : null;
    if (mon >= 0 && day(m[1]) && (y == null || /^\d{2}$/.test(y))) return { d: day(m[1]), m: mon, ...(y != null ? { y } : {}) };
  }
  // day first; OCR slips in the digits ("27/11/2Z", "Z8/MAY")
  if ((m = /^([0-9OIZS]{1,2})\/([0-9OIZS]{1,2})\/([0-9OIZS]{2}|[0-9OIZS]{4})$/.exec(t)) && day(m[1]) && +toDigits(m[2]) >= 1 && +toDigits(m[2]) <= 12) {
    return { d: day(m[1]), m: +toDigits(m[2]) - 1, y: toDigits(m[3]).slice(-2) };
  }
  if ((m = /^([0-9OIZS]{1,2})\/([A-Z]{3})$/.exec(t)) && day(m[1]) && MONTHS.includes(m[2])) return { d: day(m[1]), m: MONTHS.indexOf(m[2]) };
  if (dayOnly && /^\d{1,2}$/.test(t) && day(t)) return { d: day(t) };
  return null;
}

/** { d, m, y } -> "2 Sep 22" | "28 May" | "14": as much as the page printed. */
export const formatAcarsDate = (p) => (p ? [p.d, p.m != null ? MONTHS[p.m][0] + MONTHS[p.m].slice(1).toLowerCase() : null, p.y ?? null].filter(v => v != null).join(' ') : '');

// Label words whose value OCR glues to them ("0UT23:30", "0FF23:47", "RETURN02:47").
const GLUED_LABELS = new Set(['OUT', 'OFF', 'ON', 'IN', 'BLOCK', 'BLOC', 'BLK', 'FLT', 'FLIGHT', 'ETA', 'UTC', 'RETURN', 'TIME', 'FUEL']);
const KEEP_WHOLE = /^(FLIGHTNO|FLTNOBR|ORIGDEST|DEPTDEST|ACARSMENU)$/;

/** One OCR box's text as words the tagger can use. */
export function fixAcarsText(text) {
  let s = String(text || '').trim();
  // "1 5 1 Z", "16:1 7", "06 :50": a time read with gaps between its digits
  if (/\d/.test(s) && /\s/.test(s) && /^[\dOZISB:.\s]+$/.test(s)) s = s.replace(/\s+/g, '');
  // a date is one word: "22 Jan 26" -> "22JAN26"; "27/11/22" and "28/MAY" keep their "/" (marked here, put back below)
  s = s.replace(/\b(\d{1,2}) (JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC) (\d{2})\b/gi, (_, d, mo, y) => `${d}${mo.toUpperCase()}${y}`);
  s = s.replace(/\b(\d) (\d[A-Z0-9]{3}[0-9OIZS]{2})\b/g, (all, a, b) => (parseAcarsDate(a + b) ? a + b : all)); // "1 4JULZ5"
  s = s.replace(/\b([0-9OIZS]{1,2})\/([0-9OIZS]{1,2})\/([0-9OIZS]{2,4})\b/g, '$1⁄$2⁄$3').replace(/\b([0-9OIZS]{1,2})\/(JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)\b/g, '$1⁄$2');
  // "EDDH/LSZH", "1743/1756Z", "02:43/0040": two values
  s = s.replace(/([^\s/])\/(?=[^\s/])/g, '$1 / ').replace(/⁄/g, '/');
  // "EFKE-EFHK", "0875-15": two values (not "--Z", "-TIMES-")
  s = s.replace(/([A-Z0-9]{2,})-(?=[A-Z0-9]{2,})/g, '$1 - ');
  return s.split(/\s+/).map((w) => {
    // "0UT23:30" -> "0UT 23:30"
    const m = /^([A-Z0-9]*[A-Z][A-Z0-9]*?)(\d{1,2}[:.]\d{2}(?:[:.]\d{2})?Z?|\d{4}Z)$/.exec(w);
    if (m && GLUED_LABELS.has(labelText(m[1]))) return `${m[1]} ${m[2]}`;
    // "AFR86N270CT": a flight number with the date glued to it
    const g = /^([A-Z0-9]*?[A-Z][A-Z0-9]*?)([0-3]\d[A-Z0-9]{3}(?:[0-9OIZS]{2})?)$/.exec(w);
    if (g && /\d/.test(g[1]) && parseAcarsDate(g[2])) return `${g[1]} ${g[2]}`;
    // "EDDLEDDF": two airports printed with the "/" lost
    if (/^[A-Z]{8}$/.test(w) && !KEEP_WHOLE.test(w)) return `${w.slice(0, 4)} ${w.slice(4)}`;
    return w;
  }).join(' ');
}

/** OCR lines of an ACARS picture -> tagger pages ({ kind: 'acars', width, height, tokens }). */
export function acarsWordPages(lines, width, height, { keepBox = false } = {}) {
  const fixed = lines.map(l => ({ ...l, text: fixAcarsText(l.text) }));
  return ocrWordPages(fixed, width, height, { unglue: false, keepBox }).map(p => ({ ...p, kind: 'acars' })); // the roster unglue would split "02SEP22"
}

// ---- reading lines and label words ----

/** Tokens in lines (same y after ocrWordPages), top to bottom, each left to right. */
export function linesOf(tokens) {
  const by = new Map();
  for (const t of tokens) {
    const k = t.y;
    if (!by.has(k)) by.set(k, []);
    by.get(k).push(t);
  }
  return [...by.entries()].sort((a, b) => a[0] - b[0]).map(([y, ts]) => ({ y, tokens: ts.sort((a, b) => a.x - b.x) }));
}

/**
 * What a label phrase ("FLIGHT NO", "ORIG / DEST", "OUT") names. Returns a key:
 *   flt | date | route | dept | dest | out | off | on | in | block | flight | outoff | onin | fltroute,
 *   other (a label of something else: UTC, ETA, FOB, RETURN, ...) | null (not a label)
 */
export function labelKey(words) {
  const w = words.map(labelText).join('');
  if (!w) return null;
  if (/^(ATC|AIC|ATG)?(FLIGHT|FLIGHI|FLT|FLI)(NO|NBR|NUM|NUMBER|ID|IO)(DAY|DATE|DAIE)?$/.test(w) || /^CALLSIGN(DATE)?$/.test(w)) return 'flt';
  if (/^(FLT|FLIGHT)(NO|NUM|ID)(DATE|DAIE)?(ORIG|DEP)(DEST|DES)$/.test(w)) return 'fltroute';
  // the two airports under labels of their own ("DEPT" over MROC, "DEST" over MGGT; "FROM" / "TO")
  if (/^(DEPT|ORIG|FROM)$/.test(w)) return 'dept';
  if (/^(DEST|TO)$/.test(w)) return 'dest';
  if (/^(TRIP|AIR)$/.test(w)) return 'flight';
  if (/^(DEPT|DEP|DEPI|DPT|ORIG|ORIGIN|FROM)(DEST|DES|DESI|DESJ|TO)$/.test(w)) return 'route';
  if (/^(FLTNUM|FLTNUMDATE|FLTID|FLTIDDATE|NUMDATE)?(DATE|DAIE)?(ORIG|DEP)(DEST|DES)$/.test(w)) return 'route';
  if (/^(OUT|QUT)(TIME|FUEL)?$/.test(w) || /^OFFBLOCKS?$/.test(w)) return 'out';
  if (/^OUTOFF$/.test(w)) return 'outoff';
  if (/^ONIN$/.test(w)) return 'onin';
  if (/^OFF(TIME|FUEL)?$/.test(w) || /^AIRBORNE$/.test(w)) return 'off';
  if (/^ON(TIME|FUEL)?$/.test(w) || /^TOUCHDOWN$/.test(w)) return 'on';
  if (/^(IN|TN|IIN)(TIME|FUEL)?$/.test(w) || /^ONBLOCKS?$/.test(w)) return 'in';
  if (/^(BLOCK|BLOC|BLK)(TIME|IIME|TIMES)?$/.test(w)) return 'block';
  if (/^(FLIGHT|FLIGHI|FLT|AIRTIME|FLTTIME)(TIME|TIMES|IIME)?$/.test(w)) return 'flight';
  if (/^(DATE|DAIE|DAY)$/.test(w)) return 'date';
  if (/^(UTC|ETA|ETE|FOB|F0B|FUEL|RETURN|RETURNTO|TIME|TIMES|GROUNDACK|GSTIME|GSIIIME|GSIZTIME|PRINT|MENU|STATUS|SENSORS)$/.test(w)) return 'other';
  return null;
}

/** A word that can be part of a label: letters (OCR may read one as a digit), or a "/" "-" between label words. */
const labelish = (t) => /^[/-]$/.test(t) || (/[A-Za-z]/.test(t) && (t.match(/\d/g) || []).length <= 1 && t.length >= 2 && !/:./.test(t));
const isSep = (t) => /^[/-]$/.test(t);

/** Label phrases of a line: per token { key } for each word of a phrase, else null. Longest phrase first. */
function lineLabels(line) {
  const ts = line.tokens, out = new Array(ts.length).fill(null);
  for (let k = 0; k < ts.length; k++) {
    if (out[k] || isSep(ts[k].t) || !labelish(ts[k].t)) continue;
    for (let n = Math.min(5, ts.length - k); n >= 1; n--) {
      const part = ts.slice(k, k + n);
      if (isSep(part[n - 1].t) || !part.every(p => labelish(p.t))) continue;
      // words of one phrase stand close ("FLIGHT NO", "ORIG/DEST"), not "OUT" and "OFF" across the screen
      if (part.some((p, j) => j && p.x - (part[j - 1].x + part[j - 1].w) > 2.5 * Math.max(p.h, 4))) continue;
      const key = labelKey(part.map(p => p.t));
      if (!key) continue;
      // two time labels are one ("OUT/OFF") only with the "/" printed between them
      if (n > 1 && ['outoff', 'onin'].includes(key) && !part.some(p => p.t === '/')) continue;
      for (let j = k; j < k + n; j++) out[j] = { key };
      k += n - 1;
      break;
    }
  }
  return out;
}

/**
 * The label of each value word: the label left of it on its line ("OUT 16:17"), else the one above it
 * on one of the two lines before (labels over values; right-aligned ones over right-aligned values).
 * -> Map(token -> { key, isLabel }) (isLabel: the word is part of a label phrase itself)
 */
export function labelsOf(lines) {
  const out = new Map();
  const per = lines.map(lineLabels);
  lines.forEach((line, li) => {
    line.tokens.forEach((t, k) => {
      if (per[li][k]) { out.set(t, { key: per[li][k].key, isLabel: true }); return; }
      // same line: the nearest label to its left, with nothing value-like between
      for (let j = k - 1; j >= 0; j--) {
        if (per[li][j]) { out.set(t, { key: per[li][j].key }); return; }
        if (!isSep(line.tokens[j].t)) break;
      }
      // lines above: the label over it (overlapping, else the closest by centre)
      for (const ui of [li - 1, li - 2]) {
        if (ui < 0) break;
        const cands = lines[ui].tokens.map((u, k2) => ({ u, lab: per[ui][k2] })).filter(c => c.lab && !isSep(c.u.t));
        if (!cands.length) continue;
        const c = (x) => x.x + x.w / 2;
        const overlap = cands.filter(({ u }) => u.x < t.x + t.w && t.x < u.x + u.w);
        const best = (overlap.length ? overlap : cands).sort((a, b) => Math.abs(c(a.u) - c(t)) - Math.abs(c(b.u) - c(t)))[0];
        if (overlap.length || Math.abs(c(best.u) - c(t)) < 6 * Math.max(t.h, 4)) { out.set(t, { key: best.lab.key }); return; }
        break; // the line just above has labels, none over this word: not one of them
      }
    });
  });
  return out;
}

const ICAO_RE = /^[A-Z]{4}$/;
const IATA_RE = /^[A-Z]{3}$/;
const FLT_RE = /^[A-Z0-9]{2,3}\d{1,5}[A-Z]{0,2}$|^\d{2,5}$/;
const looksAirport = (t) => ICAO_RE.test(t) || IATA_RE.test(t);

// ---- the rule-based reader (Auto-fill) ----

/** Label-shaped fields from an ACARS picture's words, by its label words. */
export function parseAcars(pages) {
  const lines = linesOf(pages.flatMap(p => p.tokens));
  const tokens = lines.flatMap(l => l.tokens); // reading order
  const labels = labelsOf(lines);
  const r = emptyAcars();
  const times = {};
  // "FLT NUM-DATE ORIG-DEST" over "0875-15 EBLG-UACC": one label for both
  const keyIs = (t, key) => labels.get(t)?.key === key || (labels.get(t)?.key === 'fltroute' && ['flt', 'route'].includes(key));
  const take = (key, fn) => tokens.filter(t => keyIs(t, key) && !labels.get(t).isLabel).map(fn).filter(Boolean);
  for (const k of ['out', 'off', 'on', 'in', 'block', 'flight']) {
    const v = take(k, t => toHHMM(t.t))[0];
    if (v) times[k] = v;
  }
  // "OUT/OFF 1743/1756Z", "ON/IN 1758/1803Z"
  for (const [pair, a, b] of [['outoff', 'out', 'off'], ['onin', 'on', 'in']]) {
    const v = take(pair, t => toHHMM(t.t));
    if (v[0] && !times[a]) times[a] = v[0];
    if (v[1] && !times[b]) times[b] = v[1];
  }
  for (const k of ['out', 'off', 'on', 'in']) r[k] = times[k] || '';
  r.flt = take('flt', t => (FLT_RE.test(t.t) ? t.t : null))[0] || '';
  const route = take('route', t => (looksAirport(t.t) ? t.t : null));
  r.dept = take('dept', t => (looksAirport(t.t) ? t.t : null))[0] || route[0] || '';
  // "FROM" over "EDDH/LSZH": both airports under the first label
  r.dest = take('dest', t => (looksAirport(t.t) ? t.t : null))[0] || route[1] || take('dept', t => (looksAirport(t.t) ? t.t : null))[1] || '';
  r.info = acarsInfo(times.flight, times.block);
  r.date = formatAcarsDate(findDate(lines, labels));
  return r;
}

/**
 * The date of the page: under / after a DATE label; else the day printed after the flight number
 * ("QFA0057/14", "0875-15", "BAW43 /21"); else any word that is a whole date ("22JAN26").
 */
function findDate(lines, labels) {
  const tokens = lines.flatMap(l => l.tokens);
  const labeled = tokens.filter(t => labels.get(t)?.key === 'date' && !labels.get(t).isLabel);
  for (const t of labeled) { const p = parseAcarsDate(t.t, { dayOnly: true }); if (p) return p; }
  for (const line of lines) {
    const ts = line.tokens;
    for (let k = 0; k + 1 < ts.length; k++) {
      const key = labels.get(ts[k])?.key;
      if (!['flt', 'fltroute'].includes(key) || labels.get(ts[k]).isLabel || !FLT_RE.test(ts[k].t)) continue;
      // "QFA0057 / 14" or "BAW43 /21" (the "/" glued to the day)
      const day = isSep(ts[k + 1].t) ? ts[k + 2]?.t : /^[/-]\d{1,2}$/.test(ts[k + 1].t) ? ts[k + 1].t.slice(1) : null;
      const p = day && parseAcarsDate(day, { dayOnly: true });
      if (p) return p;
    }
  }
  for (const t of tokens) {
    const p = parseAcarsDate(t.t);
    if (p && labels.get(t)?.key !== 'other') return p;
  }
  return null;
}

/** "[Flight: 02:35] [Block: 02:56]" */
export const acarsInfo = (flight, block) => [flight && `[Flight: ${flight}]`, block && `[Block: ${block}]`].filter(Boolean).join(' ');
/** Flight and block time from info. */
export function infoTimes(info) {
  const get = (k) => new RegExp(`\\[${k}:\\s*(\\d{1,3}:\\d{2})\\]`, 'i').exec(String(info || ''))?.[1] || '';
  return { flight: get('Flight'), block: get('Block') };
}

// ---- training tags from a label ----

/** Same value, OCR slips allowed: letters/digits OCR confuses count as the same character. */
const loose = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/[A-Z]/g, c => AS_DIGIT[c] ?? c);

/**
 * Tag the words of an ACARS picture from its label: field (ACARS_TAGS), O, or "?" (a value the label
 * has but the words do not show clearly: left out of training rather than taught as O).
 * -> { found: n, missing: [field] }
 */
export function alignAcars(pages, label) {
  const tokens = pages.flatMap(p => p.tokens);
  for (const t of tokens) t.field = 'O';
  const labels = labelsOf(linesOf(tokens));
  const { flight, block } = infoTimes(label.info);
  const want = { flt: label.flt, dept: label.dept, dest: label.dest, out: label.out, off: label.off, on: label.on, in: label.in, flight, block, adate: label.date };
  const dateKey = formatAcarsDate(parseAcarsDate(label.date, { dayOnly: true }));
  // the word after the flight number ("QFA0057 / 14"), where a day stands without a DATE label
  const afterFlt = new Set();
  for (const line of linesOf(tokens)) {
    line.tokens.forEach((t, k) => {
      if (!FLT_RE.test(t.t) || !['flt', 'fltroute'].includes(labels.get(t)?.key)) return;
      const next = line.tokens[k + 1];
      if (next && isSep(next.t) && line.tokens[k + 2]) afterFlt.add(line.tokens[k + 2]);
      else if (next) afterFlt.add(next);
    });
  }
  const used = new Set();
  const missing = [];
  let found = 0;
  const keyFits = (field, t) => {
    const k = labels.get(t)?.key;
    return k === field || (k === 'outoff' && ['out', 'off'].includes(field)) || (k === 'onin' && ['on', 'in'].includes(field))
      || (k === 'route' && ['dept', 'dest'].includes(field)) || (k === 'fltroute' && ['flt', 'dept', 'dest'].includes(field))
      || (field === 'adate' && (k === 'date' || afterFlt.has(t)));
  };
  const same = (field, t, value) => (TIME_TAGS.includes(field) ? toHHMM(t.t) === value
    : field === 'adate' ? formatAcarsDate(parseAcarsDate(t.t, { dayOnly: true })) === dateKey
      : loose(t.t) === loose(value));
  // the same time can be printed twice (OUT 09:58 and a GS time 09:58): the one under / after its label first;
  // the date last (a bare day "14" only where a day stands)
  const order = ['out', 'off', 'on', 'in', 'block', 'flight', 'dept', 'dest', 'flt', 'adate'];
  for (const field of order) {
    const value = want[field];
    if (!value) continue;
    const cands = tokens.filter(t => !used.has(t) && same(field, t, value));
    // a bare day ("14") is only taken where a day stands; a whole date ("11NOV25") anywhere it is the only one
    const dayOnly = field === 'adate' && !/[A-Za-z]/.test(dateKey);
    const pick = cands.find(t => keyFits(field, t)) || (cands.length === 1 && !dayOnly ? cands[0] : null);
    if (pick) { pick.field = field; used.add(pick); found++; continue; }
    missing.push(field);
    // not found (OCR misread it) or not sure which: the words that could be it are left out of training
    const maybe = cands.length ? cands : tokens.filter(t => !used.has(t) && keyFits(field, t) && !labels.get(t)?.isLabel);
    for (const t of maybe) if (t.field === 'O') t.field = '?';
    // where the value should be (its label's place), but read wrong: the OCR training crops use it (acarsLineTruths)
    if (!cands.length) for (const t of maybe) if (t.field === '?') (t.misreadOf ||= []).push(field);
  }
  return { found, missing };
}

// ---- the AI model's tags -> fields ----

/** Fields from tagged words (t.field from the tagger): the first word of each field in reading order. */
export function assembleAcars(pages) {
  const tokens = linesOf(pages.flatMap(p => p.tokens)).flatMap(l => l.tokens);
  const first = (tag, fn = t => t.t) => tokens.filter(t => t.field === tag).map(fn).find(Boolean) || '';
  const r = emptyAcars();
  r.flt = first('flt');
  r.date = first('adate', t => formatAcarsDate(parseAcarsDate(t.t, { dayOnly: true })));
  r.dept = first('dept');
  r.dest = first('dest');
  for (const k of ['out', 'off', 'on', 'in']) r[k] = first(k, t => toHHMM(t.t));
  r.info = acarsInfo(first('flight', t => toHHMM(t.t)), first('block', t => toHHMM(t.t)));
  return r;
}

// ---- OCR training crops (scripts/ocr-acars-crops.mjs) ----

// Words these screens print besides the values; an OCR line made of them (and values) can be a training crop.
const SCREEN_WORDS = new Set(['ACARS', 'AOC', 'DLNK', 'OOOI', 'STATUS', 'CURRENT', 'PREVIOUS', 'PREV', 'CURR', 'FLT', 'LOG', 'PRINT',
  'RETURN', 'TO', 'MENU', 'INDEX', 'UTC', 'DATE', 'TIME', 'TIMES', 'FOB', 'FUEL', 'SENSORS', 'BEGIN', 'END', 'NO', 'COMM', 'ID', 'NBR',
  'NUM', 'DEST', 'DEPT', 'DEP', 'DES', 'ORIG', 'ORIGIN', 'FROM', 'OUT', 'OFF', 'ON', 'IN', 'BLOCK', 'BLOC', 'BLK', 'FLIGHT', 'DAY',
  'ETA', 'GROUND', 'ACK', 'MISSION', 'SUMMARY', 'STATE', 'TRIP', 'AIR', 'AIRBORNE', 'TOUCHDOWN', 'BLOCKS', 'BLOCKTIME', 'AIRTIME',
  'ARRIVAL', 'ACT', 'CALLSIGN', 'MSG', 'REM', 'SELECT', 'REPORT', 'VHF', 'PROG', 'NO', 'MAP']);

/** The printed form of a time value, in the shape OCR saw it: "09:58", "0958Z", "01+16"; null when it cannot be known (seconds). */
function printedTime(ocrWord, hhmm) {
  const t = String(ocrWord).toUpperCase();
  let z = /Z$/.test(t) ? 'Z' : '';
  let core = t.replace(/Z$/, '');
  // "08:2Z": the Z is a misread 2 (HH:MM leaves no room for a Z), not the UTC mark
  if (z && /[:.]/.test(core) && core.replace(/[:.+]/g, '').length < 4) { z = ''; core = t; }
  if (/^\w{1,2}[:.]\w{2}[:.]\w{2}$/.test(core) || /^\d{5,}$/.test(core)) return null; // 15:32:25, 141228: seconds unknown
  const [h, m] = hhmm.split(':');
  const sep = (/[:.+]/.exec(core) || [''])[0];
  return `${h}${sep}${m}${z}`;
}

/** The printed form of the date, in the shape OCR saw it: "02SEP22", "27/11/22", "28/MAY", "04", "/21"; null when unsure. */
function printedDate(ocrWord, labelDate, raw = '') {
  const p = parseAcarsDate(labelDate, { dayOnly: true });
  if (!p) return null;
  // "22 Jan 26": printed with spaces and the month's own case (fixAcarsText joined it into one word)
  const spaced = /\b\d{1,2} ([A-Za-z]{3}) \d{2}\b/.exec(raw);
  if (spaced && p.m != null && p.y != null) {
    const mon = MONTHS[p.m];
    const cased = spaced[1] === spaced[1].toUpperCase() ? mon : spaced[1] === spaced[1].toLowerCase() ? mon.toLowerCase() : mon[0] + mon.slice(1).toLowerCase();
    return `${p.d} ${cased} ${p.y}`;
  }
  const t = String(ocrWord).toUpperCase();
  const lead = /^[/-]/.test(t) ? t[0] : '';
  const core = t.slice(lead.length);
  const dayWidth = (/^[0-9OIZSBGLT]{1,2}/.exec(core) || ['0'])[0].length;
  const dd = String(p.d).padStart(dayWidth, '0');
  if (p.m == null) return `${lead}${dd}`;
  const parts = core.split('/');
  if (parts.length === 3) return `${dd}/${String(p.m + 1).padStart(parts[1].length, '0')}/${parts[2].length === 4 ? `20${p.y}` : p.y}`;
  if (parts.length === 2) return `${dd}/${MONTHS[p.m]}`;
  return `${dd}${MONTHS[p.m]}${p.y ?? ''}`;
}

/**
 * The true text of each OCR line of an ACARS picture, from its label, for recognition training:
 * values in their printed form (alignAcars finds which words they are), screen words with OCR slips undone
 * ("0UT" -> "OUT", "FLIGHI" is not one: left out), "/" and "-" as printed. A line with any word not known
 * for sure (a "?" word, an unknown word, a time with seconds) is left out.
 * -> [{ index (into lines), ocr, truth }]
 */
export function acarsLineTruths(lines, width, height, label) {
  const pages = acarsWordPages(lines, width, height, { keepBox: true });
  alignAcars(pages, label);
  const { flight, block } = infoTimes(label.info);
  const times = { out: label.out, off: label.off, on: label.on, in: label.in, flight, block };
  const byBox = new Map();
  // a value OCR read wrong: the one word in its place, of the right shape, is that value
  // (not a time on a screen that prints seconds: "06:1" may be 06:14:55; not a code much shorter than the value:
  // the OCR box may hold only part of it)
  const withSeconds = pages[0].tokens.some(t => /^\d{1,2}[:.]\d{2}[:.]\d{2}/.test(t.t));
  const shapeFits = (field, w) => (TIME_TAGS.includes(field) ? !withSeconds && w.length >= 3 && /^[0-9OQDILTZSBG|]{1,2}[:.+]?[0-9OQDILTZSBG|]{1,2}Z?$/i.test(w)
    : field === 'adate' ? /\d/.test(w) && w.length <= 9
      : Math.abs(w.length - String(label[field] || '').length) <= 1 && /^[A-Z0-9]+$/i.test(w));
  const misread = new Map();
  for (const t of pages[0].tokens) for (const f of t.misreadOf || []) misread.set(f, [...(misread.get(f) || []), t]);
  for (const [field, toks] of misread) {
    const fits = toks.filter(t => t.misreadOf.length === 1 && shapeFits(field, t.t));
    if (fits.length === 1 && toks.length === 1) fits[0].field = field;
  }
  for (const t of pages[0].tokens) {
    if (!byBox.has(t.box)) byBox.set(t.box, []);
    byBox.get(t.box).push(t);
  }
  const out = [];
  for (const [index, toks] of byBox) {
    toks.sort((a, b) => a.x - b.x);
    const raw = String(lines[index].text || '').trim();
    // "EDDLEDDF": two airports OCR glued, the "/" (or space) between them lost: what was printed is not known
    if (raw.split(/\s+/).some(w => /^[A-Z]{8}$/.test(w) && !KEEP_WHOLE.test(w))) continue;
    const words = [];
    let ok = true;
    for (const t of toks) {
      let w = null;
      if (t.field === '?') w = null;
      else if (TIME_TAGS.includes(t.field)) w = times[t.field] ? printedTime(t.t, times[t.field]) : null;
      else if (t.field === 'adate') w = printedDate(t.t, label.date, raw);
      else if (['flt', 'dept', 'dest'].includes(t.field)) w = /^[A-Z0-9]+$/i.test(t.t) ? String(label[t.field] || '').toUpperCase() || null : null;
      else if (isSep(t.t)) w = t.t;
      else if (t.t.toUpperCase() === 'Z' && words.length && /\d$/.test(words[words.length - 1])) { words[words.length - 1] += 'Z'; continue; } // "0627 Z"
      else {
        // a screen word, maybe with a mark around it ("*PRINT", "TIME:", "<RETURN"); OCR digits read back as letters
        // ("0UT" -> "OUT"), the printed case kept ("Flight")
        const m = /^([*<]?)([A-Za-z0-9]+)([*:>]?)$/.exec(t.t);
        if (m && SCREEN_WORDS.has(labelText(m[2]))) w = m[1] + m[2].replace(/[0-9]/g, d => AS_LETTER[d] || d) + m[3];
      }
      if (!w) { ok = false; break; }
      words.push(w);
    }
    if (!ok || !words.length) continue;
    let truth = words.join(' ');
    if (/\S\/\S/.test(raw)) truth = truth.replace(/ \/ /g, '/');
    if (/\w-\w/.test(raw)) truth = truth.replace(/ - /g, '-');
    out.push({ index, ocr: raw, truth });
  }
  return out;
}

// ---- scoring ----

/** A field's value as compared: upper case without spaces; times HH:MM; info as its two times. */
export function normalizeAcarsField(field, value) {
  const v = String(value || '').trim();
  if (field === 'info') { const t = infoTimes(v); return `${t.flight}|${t.block}`; }
  if (field === 'date') return formatAcarsDate(parseAcarsDate(v, { dayOnly: true })) || v.toUpperCase();
  if (['out', 'off', 'on', 'in'].includes(field)) return toHHMM(v) || v.toUpperCase();
  return v.toUpperCase().replace(/\s+/g, '');
}

/** -> { perField: { f: { matches, total } }, allRight, diffs: [{ field, pred, exp }] } */
export function compareAcars(pred, label) {
  const perField = {}, diffs = [];
  for (const f of ACARS_FIELDS) {
    const p = normalizeAcarsField(f, pred?.[f]), e = normalizeAcarsField(f, label?.[f]);
    const ok = p === e;
    perField[f] = { matches: ok ? 1 : 0, total: 1 };
    if (!ok) diffs.push({ kind: 'field', field: f, pred: pred?.[f] || '', exp: label?.[f] || '' });
  }
  return { perField, allRight: diffs.length === 0, diffs };
}
