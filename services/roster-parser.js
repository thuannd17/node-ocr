
// /services/roster-parser.js
/*
 * Content-based table parser for roster images (Ryanair Individual Plan).
 *
 * Input : raw OCR lines [{ text, confidence, box: [[x,y] x 4] }] from PaddleOCR.
 * Output: { published: [row], planned: [row] } with row = {
 *   date: "D MMM YY", day: "FRI", duty, dep, begin: "HH:MM Z", end, arr }
 *
 * Pipeline:
 *   1. Group OCR fragments into visual rows by y-coordinate.
 *   2. Detect header row(s) -> compute column x-ranges from header positions.
 *   3. Detect planned/published section boundary.
 *   4. For each data row: filter by table x-range (remove sidebar),
 *      extract fields using column-zone awareness + content patterns.
 *   5. Date carry-forward for sub-rows that lack their own date.
 *   6. Cut off noise sections (Checks, Annual Leave, copyright).
 *
 * Static patterns:
 *   models/parser-patterns.json (known duty codes, column zones) — produced
 *   once by the old calibration step, now a fixed config file — is used as a
 *   fallback when header detection fails, and for duty code validation.
 */

import { getParserPatterns } from './parser-rules.js';

function getPatterns() {
  return getParserPatterns();
}

const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
// Order matches JS Date.getDay() (0=Sunday..6=Saturday) — calculateWeekday()
// below indexes straight into this array with getDay(). It was previously
// ['MON',...,'SUN'] (Monday-first), silently shifting every *computed*
// weekday by one day for any row where the OCR text didn't literally
// contain a weekday name — confirmed via a real benchmark run 2026-09-21
// as the dominant cause of ~99% "day" (and much of "date") value_mismatch,
// on both the stock and a fine-tuned OCR model equally. The other two
// consumers of this array (fuzzyWeekday's .find(), isAirportCode's
// .includes()) are order-independent, so reordering here is safe.
const WEEKDAYS = ['SUN','MON','TUE','WED','THU','FRI','SAT'];

// Noise sections at bottom of page -> cutoff
// Must NOT match duty codes like CHECK-IN, CHECK-OUT
// Headers of the expiry/checks table printed below the roster tables. Its
// rows are dated ("25 Jul 19") and were parsed as planned rows (LCK, CAT3,
// PBN...) whenever this cutoff missed — at det limit 1920 "Checks" often reads
// "Cheeks" and "Issue Date"/"Expiry Date" come as their own boxes (2026-09-29).
// The recognizer fine-tuned on table text (paddleocr-roster-rec-tight) reads
// these headers more loosely still ("1se Expiry Dae", "1ue Dae ExpirDae",
// "Annl Leave for : 2020", "(c) A1 mtl ... cpyrght" footer), so "expir" and
// the annual-leave / copyright footers match anywhere in the line — none of
// these words occur in any labeled roster cell (checked 2026-09-30).
const BOTTOM_NOISE_RE = /^(check\s*code|annual\s*leave|start\s*date|total\s+days|ch[ea]{1,2}c?k?[s5]\s*$|issue\s*(date|expi)|expiry\s*date)|expi[ry]|\ban*u*a*l\s+lea?ve\b|\ble[a]?ve\s+f?or\b|^\(c?\)\s*a/i;
// A row grouped from the Checks header ("Check | Issue Date | Expiry Date")
// averages a pixel above the "Expiry" box that sets the cutoff, so rows within
// this many px above the cutoff are dropped too. Table rows sit ~16px apart.
const CUTOFF_SLACK = 4;
// Boilerplate help/disclaimer text some roster templates print in a side
// column running alongside the table. Its lines sit inside the same y-band
// as real table rows, so y-overlap row grouping glues it onto that row —
// merging into e.g. "TheCrewApp i theprimary | 1Feb20 St | OFF(Z) | EDI",
// which corrupts date/duty extraction for that row. Confirmed via a real
// benchmark run 2026-09-21 that this reaches production, not just the
// training-data exporter (which already filtered it — see
// scripts/build-recognition-groundtruth.mjs).
const SIDEBAR_NOISE_RE = /(ecrew|printable roster|published every friday|irish time|duty changes notified|generate change notifications|change notifications in idp|primary\s*reference)/i;
// Planned/published section marker
// Tolerates the spacing/letter slips OCR makes on this title at det limit
// 1920 ("RESTOFTHIS ROSTERISPLANNED", "THEREST OFTHS ROSTER", "ROSTERISPANNE");
// when it went unrecognised the title itself became a published row.
const PLANNED_MARKER_RE = /(rest\s*o[fe]\s*th[il1]?s\s*roster|roster\s*is\s*p[l1i]?ann)/i;
// "This roster is published until 16 Feb 20"
const PUBLISHED_UNTIL_RE = /published\s+(?:until|to)\s+(?:[A-Za-z]{3,9}\.?\s+)?(\d{1,2})\s*([A-Za-z]{3,9})\.?\s*(\d{2,4})/i;

// Column keyword search terms (for header detection + column range computation)
const COL_SEARCH_TERMS = [
  { key: 'date', search: 'date' },
  { key: 'duty', search: 'duty' },
  { key: 'dep',  search: 'dep' },
  { key: 'begin',search: 'begin' },
  { key: 'end',  search: 'end' },
  { key: 'arr',  search: 'arr' },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function levenshtein(a, b) {
  const m = a.length, n = b.length;
  if (m === 0) return n; if (n === 0) return m;
  const dp = new Array(n + 1);
  for (let j = 0; j <= n; j++) dp[j] = j;
  for (let i = 1; i <= m; i++) {
    let prev = dp[0]; dp[0] = i;
    for (let j = 1; j <= n; j++) {
      const tmp = dp[j];
      dp[j] = Math.min(dp[j]+1, dp[j-1]+1, prev+(a[i-1]===b[j-1]?0:1));
      prev = tmp;
    }
  }
  return dp[n];
}

const pad2 = n => String(n).padStart(2, '0');

function median(arr) {
  if (!Array.isArray(arr) || arr.length === 0) return null;
  const sorted = arr.filter(Number.isFinite).sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function fuzzyMonth(s) {
  if (!s) return null;
  const t = s.slice(0,3).toLowerCase();
  for (const m of MONTHS) if (m.toLowerCase() === t) return m;
  for (const m of MONTHS) if (levenshtein(t, m.toLowerCase()) <= 1) return m;
  return null;
}

function fuzzyWeekday(s) {
  if (!s) return null;
  const t = s.slice(0,3).toLowerCase();
  return WEEKDAYS.find(d => d.toLowerCase() === t)
    || WEEKDAYS.find(d => levenshtein(t, d.toLowerCase()) <= 1) || null;
}

function dateKey(ds) {
  const m = /(\d{1,2}) ([A-Za-z]{3}) (\d{2})/.exec(ds || '');
  if (!m) return null;
  const mo = MONTHS.findIndex(x => x.toLowerCase() === m[2].toLowerCase());
  return [parseInt(m[3],10), mo, parseInt(m[1],10)];
}

// ---------------------------------------------------------------------------
// Text normalization
// ---------------------------------------------------------------------------

export function normalizeRowText(text) {
  let t = text;
  // NOTE: digit-letter split done in extractDateFromText, not here (to avoid breaking duty codes like 6TRG)
  // 2. Detach trailing Z/z/2 from time
  t = t.replace(/(\d{2}:\d{2})\s*([Zz2])\b/g, '$1 $2');
  // 3. Detach leading Z before time
  t = t.replace(/\b([Zz])\s*(\d{2}:\d{2})/g, '$1 $2');
  // 4. Split merged time pairs: "08:00209:40" -> "08:00 Z 09:40"
  t = t.replace(/(\d{2}:\d{2})\s*\d*(\d{2}:\d{2})/g, (_m, t1, t2) => {
    if (t1 !== t2) return t1 + ' Z ' + t2;
    return _m;
  });
  // 5. Between two time patterns, "2" or "z" is Z
  t = t.replace(/(\d{2}:\d{2})\s*[2z]\s*(\d{2}:\d{2})/gi, '$1 Z $2');
  // 6. After time, trailing "2" before airport or end -> Z
  t = t.replace(/(\d{2}:\d{2})\s+2(?=\s+[A-Z]|$)/g, '$1 Z');
  // 7. Before time, leading "2" -> Z
  t = t.replace(/(?<=^|\s)2\s+(\d{2}:\d{2})/g, 'Z $1');
  // 8. OFF(2) -> OFF(Z), 0FF -> OFF
  t = t.replace(/OFF\((\d)\)/gi, 'OFF(Z)');
  t = t.replace(/0FF/gi, 'OFF');
  // 9. Merged/uncoloned time pairs -> canonical "HH:MM Z"
  t = canonicalizeTimes(t);
  return t;
}

// The detector often returns begin+end as ONE box, and how the recognizer
// spells it varies with the model and its training run: "00:00 Z 21:00 Z",
// "00:00 Z21:00 Z", "0000Z21:00Z", "2100 Z 00:00 Z". Only the first form
// survived the strict "\d{2}:\d{2}" extraction, so the other spellings gave
// empty begin/end (the dominant benchmark error, and the reason a model
// whose output happened to be spaced "nicely" scored 6 points higher than an
// equally accurate one). Rewrite every recognizable time into one canonical
// spelling so downstream extraction doesn't depend on the recognizer's style.
//
// Guards against false positives (flight numbers, dates, duty codes):
//   - no-colon times ("2100Z") must be followed by Z — "FR 8075", "20 2105"
//     are left alone;
//   - a time may not be glued to a preceding letter/digit/hyphen, which keeps
//     "SBY1030-Z" / "SBY0900Z" (standby duty codes) from turning into times;
//   - hours > 23 or minutes > 59 are never rewritten.
//   - a "Z" glued to a lowercase letter ("Zulu") is not a time marker; glued to
//     capitals it is Z + an airport code ("1415ZED").
const TIME_TOKEN_RE = /(?<![A-Za-z0-9:.\-])(?:(\d{2}):(\d{2})|(\d{1,2})[ .]?(\d{2})(?=\s*[Zz](?![a-z])))(?:\s*[Zz](?![a-z]))?/g;

export function canonicalizeTimes(text) {
  // "00:(() Z", "00:(0) Z", "0(:(() Z", "03:0() Z": the rec model reads a
  // round 0 as a bracket. Only colon-times followed by Z that contain a
  // bracket are touched ("(" -> 0, ")" dropped), so OFF(Z)/A/L(Z) can't match.
  // Lost the begin time on ~10 published rows, 2026-10-01.
  let t = text.replace(/(?<![A-Za-z0-9])\(?([0-9()]{1,3}):([0-9()]{1,3})(?=\s*[Zz](?![a-z]))/g, (match, hh, mm) => {
    if (!/[()]/.test(match)) return match;
    const fix = (p) => p.replace(/\)/g, '').replace(/\(/g, '0').padEnd(2, '0');
    const h = fix(hh), m = fix(mm);
    return h.length === 2 && m.length === 2 ? `${h}:${m}` : match;
  });
  // "22:0S Z", "1O:45 Z": a letter for a digit inside a colon-time followed by Z.
  // "Z1:05 Z": the leading 2 read as Z (2026-10-07).
  t = t.replace(/(?<![A-Za-z0-9])([0-9OSIl]{2}):([0-9OSIl]{2})(?=\s*[Zz](?![a-z]))/g, (match, hh, mm) => {
    if (!/[OSIl]/.test(match) || !/\d/.test(hh) || !/\d/.test(mm)) return match;
    const fix = (p) => p.replace(/O/g, '0').replace(/S/g, '5').replace(/[Il]/g, '1');
    return `${fix(hh)}:${fix(mm)}`;
  });
  t = t.replace(/(?<![A-Za-z0-9])Z([0-3]):([0-5]\d)(?=\s*[Zz](?![a-z]))/g, '2$1:$2');
  // "00100 Z", "09110Z": the colon read as "1". Only a 5-digit run followed by
  // Z whose outer pairs form a valid time (2026-10-07).
  t = t.replace(/(?<![A-Za-z0-9:.\-])([01]\d|2[0-3])1([0-5]\d)(?=\s*[Zz](?![a-z]))/g, '$1:$2');
  // "000022359Z": two uncoloned times whose separating Z was read as "2".
  t = t.replace(/(?<![A-Za-z0-9])(\d{4})2(\d{4})(?=\s*[Zz])/g, '$1 Z $2');
  // "0000Z2100Z": a digit glued to a preceding Z is the start of the next time.
  t = t.replace(/([Zz])(?=\d)/g, '$1 ');
  t = t.replace(TIME_TOKEN_RE, (match, h1, m1, h2, m2) => {
    const h = parseInt(h1 ?? h2, 10);
    const m = parseInt(m1 ?? m2, 10);
    if (!(h >= 0 && h <= 23 && m >= 0 && m <= 59)) return match;
    return `${pad2(h)}:${pad2(m)} Z`;
  });
  // "1415ZED" -> "14:15 ZED": keep a following airport code a separate token.
  return t.replace(/(\d{2}:\d{2} Z)(?=[A-Z])/g, '$1 ');
}

// ---------------------------------------------------------------------------
// Field extraction
// ---------------------------------------------------------------------------

/**
 * Calculate weekday (MON, TUE...) from a date string "D MMM YY".
 * Returns uppercase 3-letter weekday or null.
 */
function calculateWeekday(dateStr) {
  try {
    const [d, m, y] = dateStr.split(' ');
    const monthIdx = MONTHS.indexOf(m);
    if (monthIdx === -1) return null;
    // Year 20xx
    const date = new Date(2000 + parseInt(y, 10), monthIdx, parseInt(d, 10));
    if (isNaN(date.getTime())) return null;
    return WEEKDAYS[date.getDay()];
  } catch {
    return null;
  }
}

/**
 * Extract date. Uses \d{2}(?!\d) for year to avoid consuming duty codes.
 * Returns { date, day, matchedText } or null.
 */
function extractDateFromText(text) {
  // Primary: 2-digit year. Handles "21 Feb 25, Fri" and "Fri, 21 Feb 25".
  // Spacing around day/month/year is optional (\s* not \s+) because OCR —
  // even the stock model, not just a fine-tuned one — sometimes drops the
  // space in these short digit-letter-digit runs ("17Apr20", "20Apr 20").
  // The trailing (?![a-z0-9]) (rather than a plain \b) still rejects a
  // longer merged number/word right after the year, but allows a glued
  // capitalized weekday ("17Apr20Fri") to follow directly.
  // The "no lowercase letter after the year" rule is checked by hand below:
  // inside this /i regex a (?![a-z]) lookahead also rejected capitals, so
  // "19 Jan 25Sun" / "21 Jan25OFF" lost their date and inherited the previous
  // row's (2026-10-01).
  const re2 = /\b(?:(Mon|Tue|Wed|Thu|Fri|Sat|Sun)[A-Za-z]*[.,\s]*)?(\d{1,2})\s*([-./]?\s*)(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[A-Za-z.]*\s*([-./]?\s*)(\d[A-Za-z0-9])(?!\d)/gi;
  let m = null;
  for (const hit of text.matchAll(re2)) {
    if (/[a-z]/.test(text[hit.index + hit[0].length] || '')) continue;
    m = hit;
    break;
  }

  // Fallback: 4-digit year
  if (!m) {
    const re4 = /\b(?:(Mon|Tue|Wed|Thu|Fri|Sat|Sun)[A-Za-z]*[.,\s]*)?(\d{1,2})\s*([-./]?\s*)(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[A-Za-z.]*\s*([-./]?\s*)(\d{4})(?![a-z0-9])/i;
    m = text.match(re4);
  }
  
  if (!m) return null;
  
  const dayNum = parseInt(m[2], 10);
  const month = fuzzyMonth(m[4]);
  let year = m[6].replace(/[Oo]/g, '0').replace(/[^0-9]/g, '').replace(/^[A-Z]/i, '2');
  if (year.length === 4) year = year.slice(-2);
  if (year.length !== 2 || !month || dayNum < 1 || dayNum > 31) return null;
  
  const date = dayNum + ' ' + month + ' ' + year;
  let day = '';
  
  // 1. Try to extract day from the OCR text
  if (m[1]) {
    day = fuzzyWeekday(m[1]) || '';
  }
  
  // 2. Fallback: Auto-calculate weekday from date if not found in text
  if (!day) {
    day = calculateWeekday(date) || '';
  }
  
  return { date, day, matchedText: m[0] };
}

function extractTimesFromText(text) {
  const times = [];
  const re = /(\d{2}):(\d{2})(?:\s*Z)?/gi;
  let m;
  while ((m = re.exec(text)) !== null) {
    const h = parseInt(m[1],10), min = parseInt(m[2],10);
    if (h >= 0 && h <= 23 && min >= 0 && min <= 59)
      times.push(pad2(h) + ':' + pad2(min) + ' Z');
  }
  return times;
}

function isAirportCode(s) {
  const raw = String(s || '').trim();
  // A slash or bracket means a duty code, never an airport: "A/L(Z)" would
  // otherwise strip to "ALZ" and be taken as Dep, pushing the real Dep into
  // Arr (~75 published cells, 2026-10-01).
  if (/[/()]/.test(raw)) return false;
  // A garbled time pair ("00:00Z21Z00Z") strips to "ZZZ" (2026-10-07).
  if (/:|\d.*\d/.test(raw)) return false;
  const t = raw.replace(/[^A-Za-z]/g, '').toUpperCase();
  if (!/^[A-Z]{3}$/.test(t)) return false;
  if (raw !== raw.toUpperCase()) return false;
  if (WEEKDAYS.includes(t)) return false;
  if (MONTHS.includes(t[0]+t.slice(1).toLowerCase())) return false;
  // Not airport codes: duty/leave abbreviations
  return !/^(OFF|SBY|RST|A\/L|F\/D|IDP|TRG|SIM|DHY|CAB)$/.test(t);
}

// Bracketed day-off codes lose a parenthesis on tight OCR boxes ("OFF(Z",
// "OFFZ", "OFFZ)" — the table-only rec model did this on ~480 planned cells,
// 2026-09-29). The only bracketed duty codes in the labels are OFF(Z),
// OFF(A), A/L(Z) and A/L(T), and none of them has an unbracketed twin (OFF/A
// is a different code and is left alone), so restoring the brackets is safe.
const BRACKET_DUTY_RE = /^(OFF|A\/L)\s*\(?\s*([ZAT])\s*\)?$/i;

function normDuty(text) {
  const t = String(text || '').replace(/0FF/gi, 'OFF')
    // C19 (the 2020 COVID stand-down code) is read "CI9"/"Cl9"; 195 label cells
    // also said CI9 until they were checked against the images (2026-10-01).
    .replace(/\bC[Il|]9\b/g, 'C19')
    // RST2 read "RS72" (T as 7); no duty code starts with RS7 (2026-10-07).
    .replace(/\bRS7(\d)\b/g, 'RST$1')
    // one F lost: "Z0OF(Z)" (2026-10-07)
    .replace(/(^|[^F])OF\(([ZA])\)/g, '$1OFF($2)')
    .replace(/\s+/g, ' ').replace(/^[\s,|;:.\-]+|[\s,|;:.\-]+$/g, '').trim();
  const m = BRACKET_DUTY_RE.exec(t);
  if (!m) return t;
  const code = m[1].toUpperCase(), zone = m[2].toUpperCase();
  if (code === 'OFF' && zone === 'T') return t;
  // "OFFA" may just as well be OFF/A with the slash lost — only fix it when a bracket survived
  if (code === 'OFF' && zone === 'A' && !/[()]/.test(t)) return t;
  return `${code}(${zone})`;
}

// Every duty shape seen in the labels (digits as \d), plus their spaced
// variants. Used to tell a real duty from date-cell debris glued in front.
const DUTY_SHAPE_RE = /^(?:OFF ?\(Z\)|OFF|OFFZ|OFF\/A|OFF\(A\)|C\d{2}|A\/L ?\([ZT]\)|SBY[\dD]\d{3}-Z|(?:FR|DH) ?\d{2,4}|\d{2,4}|\d{4} \d{4}|CHECK-IN|CHECK-OUT|CTOT?|I?T?SIM|\dTO(?: SIM)?|GT|G?\dTRG|GTRG|F\/D|SFTY|RST\d|HSBY|AL\/?MAL|ALM|N\/A|[IT]?LCK(?: \d{3,4})?|ITUD|U\/L|ERST|INTSP|\dD OFF\(Z\)|DH FR\d{2,4}|RST \d (?:OPC|LPC|TRNG)|Unallocated|N?TSP|RETR)$/;
const MONTH_JUNK = '(?:JAN|JN|FEB|F6B|FB|MAR|MR|APR|AP|MAY|MAV|MY|JUN|JU1|JUI|JUL|AUG|AU|AG|SEP|OCT|QCT|0CT|OC|NOV|DEC)';
// Leftovers of the date cell: day/year numbers ("30", "20)", "1("), month
// fragments ("JU1", "14MAY", "6MAR20", "0JAN"), a stray zone ("Z0", "Z4"),
// or a weekday/month initial glued to digits ("S16", "TE11", "FB20", "F21").
const DATE_JUNK_RE = new RegExp(`^(?:\\d{1,2}[()]{0,2}|[()]{1,2}|\\d{0,2}${MONTH_JUNK}\\d{0,2}|Z\\d?|\\d?Z|(?!FR|DH)[A-Z]{1,2}\\d{0,4}|\\d[A-Z]{1,2}\\d{0,2})$`, 'i');
// The same debris glued straight onto a non-numeric code: "2OFF(Z)",
// "20A/L(Z)", "25OFF", "ZOFF(Z)", "0JAN2OFF(Z)", "20C19".
const GLUED_JUNK_RE = new RegExp(`^(?:\\d{0,2}${MONTH_JUNK}?\\d{0,2}|Z\\d?)(OFF\\(Z\\)|OFF|A\\/L\\([ZT]\\)|C\\d{2}|CHECK-IN|CHECK-OUT|CTO|HSBY|SIM|SFTY|ALMAL|ITUD|\\dTRG)$`, 'i');

// Single-character OCR slips in the common codes.
const DUTY_SLIPS = [
  [/^[QO0][EF]F(?=\(|$)/i, 'OFF'],            // QFF(Z), OEF(Z)
  [/^O?[EF]F\s*(?:\(?Z\)|\(Z\)?|\))$/i, 'OFF(Z)'], // OEFZ), FF(Z), FF(Z, FF)
  [/^O[BEF5][F5]\(Z\)$/i, 'OFF(Z)'],          // OBF(Z), OF5(Z)
  [/^OFF\(Z$/i, 'OFF(Z)'],
  [/^A\/?L\s*\(?([ZT])[Z)]*$/i, 'A/L($1)'],  // AL(Z), A/L(Z, A/L(ZZ
  [/^[CQ]HE?C?K-?\s*(?:[QO0]?[U0]?T|O[0O]T|00[7T])$/i, 'CHECK-OUT'], // CHECK-QUT, CHECKOUT, CHECK-O0T, CHECK-OT, QHECK-QUT, CHECK-007
  [/^CH[FE]CK-OUT$/i, 'CHECK-OUT'],
  [/^CHECK-?[TI1]N$/i, 'CHECK-IN'],           // CHECK-TN
  [/^CT[Q0]$/i, 'CTO'],
  [/^S[8B]Y(?=\d)/i, 'SBY'],
  [/^STM$/i, 'SIM'],
  [/C[Il|]9$/, 'C19'],                        // "20CI9" (normDuty's \b misses it)
];

/** Strip date-cell debris and fix common one-letter slips in a duty value. */
function cleanDutyJunk(duty) {
  let d = String(duty || '').trim();
  if (!d) return d;
  // Codes printed with inner spaces that OCR glues or drops (2023+ rosters):
  // "DH FR3529", "RST 3 OPC", "RST 4 TRNG".
  d = d.replace(/^DH\s*FR\s*(\d{2,4})$/i, 'DH FR$1').replace(/^RST\s*(\d)\s*(OPC|LPC|TRNG)$/i, 'RST $1 $2');
  // "Unallocated" (a BTC/DTC simulator slot) is a long word OCR mangles:
  // "UALLOCA", "UNALLOAED", "UNLOAD".
  if (/^U[A-Z1]{3,10}$/i.test(d) && (levenshtein(d.toUpperCase(), 'UNALLOCATED') <= 4 || /LLOC|LLOA|NLOA/i.test(d))) d = 'Unallocated';
  const slips = (s) => { for (const [re, to] of DUTY_SLIPS) s = s.replace(re, to); return s; };
  const fix = (s) => {
    s = slips(s);
    // Debris glued in front can hide a slip too: "2QFF(Z)", "ZCTQ".
    const m = /^(?:\d{1,2}|Z\d?)(?=[A-Z])/i.exec(s);
    if (m && !GLUED_JUNK_RE.test(s)) {
      const tail = slips(s.slice(m[0].length));
      if (GLUED_JUNK_RE.test(m[0] + tail)) s = m[0] + tail;
    }
    const g = GLUED_JUNK_RE.exec(s);
    if (g && g[1].length < s.length) s = g[1].toUpperCase();
    // Year glued onto a 4-digit flight: "208272" (label codes are <= 4 digits).
    if (/^2\d\d{4}$/.test(s)) s = s.slice(2);
    return s.replace(/^SBY(\d{4}) ?-? ?Z$/i, 'SBY$1-Z');
  };
  let toks = d.split(' ');
  toks[toks.length - 1] = fix(toks[toks.length - 1]);
  // Drop the shortest run of leading debris tokens after which the rest is
  // a real duty shape ("31 Z0 OFF(Z)" -> "OFF(Z)"); keep it all otherwise.
  for (let k = 1; k < toks.length && DATE_JUNK_RE.test(toks[k - 1]); k++) {
    if (DUTY_SHAPE_RE.test(fix(toks.slice(k).join(' ')))) { toks = toks.slice(k); break; }
  }
  d = fix(toks.join(' '));
  return d;
}

// ---------------------------------------------------------------------------
// Geometry + row grouping
// ---------------------------------------------------------------------------

function geom(box) {
  const xs = box.map(p => p[0]), ys = box.map(p => p[1]);
  const x0 = Math.min(...xs), x1 = Math.max(...xs);
  const y0 = Math.min(...ys), y1 = Math.max(...ys);
  return { x0, x1, y0, y1, yc: (y0+y1)/2, h: y1-y0 };
}

function groupRows(lines) {
  const sorted = [...lines].sort((a, b) => a.yc - b.yc);
  const rows = [];
  for (const line of sorted) {
    const prev = rows[rows.length - 1];
    if (prev) {
      const overlap = Math.min(prev.y1, line.y1) - Math.max(prev.y0, line.y0);
      if (overlap >= 0.5 * Math.min(prev.h, line.h)) {
        prev.lines.push(line);
        prev.y0 = Math.min(prev.y0, line.y0);
        prev.y1 = Math.max(prev.y1, line.y1);
        prev.yc = (prev.y0+prev.y1)/2;
        prev.h = prev.y1-prev.y0;
        continue;
      }
    }
    rows.push({ lines: [line], y0: line.y0, y1: line.y1, yc: line.yc, h: line.h });
  }
  return rows;
}

const ROW_DATE_ANCHOR_RE = /\d{1,2}\s*[A-Za-z]{2,9}\s*['’]?\d{2,4}\b/;

/**
 * Split table rows that groupRows' y-overlap heuristic accidentally fused
 * from 2+ real physical rows into one — common on dense layouts with tight
 * row spacing, where a real row's line boxes overlap enough vertically with
 * the next real row's to pass the 50%-overlap merge test. A fused row's
 * combined text can then contain two different rows' dates and duty/dep
 * values interleaved, which is what was producing non-chronological,
 * duplicated dates in extracted rows (confirmed via a real benchmark run
 * 2026-09-21). Detection: a row much taller than a normal single text line
 * AND containing 2+ date-like fragments is almost certainly fused — split
 * its lines by nearest date-anchor (the one column guaranteed once per real
 * row) and rebuild one row per anchor.
 *
 * This mirrors the date-anchor approach tried in
 * scripts/build-recognition-groundtruth.mjs, but scoped to only the rows
 * that actually look fused (rather than replacing row detection globally,
 * which scored worse there — real images have missed OCR detections that
 * break a strict one-anchor-per-row assumption more often than groupRows
 * merges rows). Applying it only as a targeted repair keeps groupRows as
 * the default and avoids that regression.
 */
function splitOversizedRows(rows, medianLineHeight) {
  const threshold = Math.max(medianLineHeight * 1.8, 14);
  const result = [];
  for (const row of rows) {
    if (row.h <= threshold) { result.push(row); continue; }
    const anchors = row.lines
      .filter(l => ROW_DATE_ANCHOR_RE.test(l.text))
      .sort((a, b) => a.yc - b.yc);
    if (anchors.length < 2) { result.push(row); continue; }

    const buckets = anchors.map(a => ({ anchorYc: a.yc, lines: [] }));
    for (const l of row.lines) {
      let best = 0, bestDist = Infinity;
      for (let i = 0; i < anchors.length; i++) {
        const dist = Math.abs(l.yc - anchors[i].yc);
        if (dist < bestDist) { bestDist = dist; best = i; }
      }
      buckets[best].lines.push(l);
    }
    for (const b of buckets) {
      if (!b.lines.length) continue;
      const y0 = Math.min(...b.lines.map(l => l.y0));
      const y1 = Math.max(...b.lines.map(l => l.y1));
      result.push({ lines: b.lines, y0, y1, yc: (y0 + y1) / 2, h: y1 - y0 });
    }
  }
  return result.sort((a, b) => a.yc - b.yc);
}

function buildParserMeta({ colRanges, parseMode, layoutHintSource }) {
  return { parseMode, layoutHintSource, colRanges };
}

// ---------------------------------------------------------------------------
// Header detection + column range computation
// ---------------------------------------------------------------------------

function isHeaderRow(row) {
  const text = row.lines.map(l => l.text).join(' ');
  let count = 0;
  if (/\bdate\b/i.test(text)) count++;
  if (/\bduty\b/i.test(text)) count++;
  if (/\bdep\b/i.test(text)) count++;
  if (/\bbegin\b/i.test(text)) count++;
  if (/\bend\b/i.test(text)) count++;
  if (/\barr\b/i.test(text)) count++;
  return count >= 3 && (/\bdate\b/i.test(text) || /\bduty\b/i.test(text));
}

function scoreHeaderRow(row) {
  const text = row.lines.map(l => l.text).join(' ');
  let score = 0;
  if (/\bdate\b/i.test(text)) score += 4;
  if (/\bduty\b/i.test(text)) score += 4;
  if (/\bdep\b/i.test(text)) score += 2;
  if (/\bbegin\b/i.test(text)) score += 2;
  if (/\bend\b/i.test(text)) score += 2;
  if (/\barr\b/i.test(text)) score += 2;
  score += Math.min(row.lines.length, 6);
  return score;
}

function getBestHeaderRow(rows) {
  const headerRows = rows.filter(isHeaderRow);
  if (headerRows.length === 0) return null;
  return [...headerRows].sort((a, b) => {
    const scoreDiff = scoreHeaderRow(b) - scoreHeaderRow(a);
    if (scoreDiff !== 0) return scoreDiff;
    return a.yc - b.yc;
  })[0];
}

function getLearnedColumnFallback() {
  const patterns = getPatterns();
  const zones = patterns?.columnZones;
  if (!zones) return null;
  return {
    dutyLeft: zones.dutyLeft?.median ?? 120,
    dutyRight: zones.dutyRight?.median ?? zones.depLeft?.median ?? 220,
    depLeft: zones.depLeft?.median ?? null,
    beginLeft: zones.beginLeft?.median ?? null,
    endLeft: zones.endLeft?.median ?? null,
    arrLeft: zones.arrLeft?.median ?? null,
    tableLeft: zones.tableLeft?.median ?? 50,
    tableRight: zones.tableRight?.median ?? 500,
  };
}

function mergeColumnRanges(detected, fallback) {
  if (!detected) return fallback || null;
  if (!fallback) return detected;
  return {
    ...(detected._fullHeader ? { _fullHeader: true } : {}),
    dutyLeft: detected.dutyLeft ?? fallback.dutyLeft,
    dutyRight: detected.dutyRight ?? fallback.dutyRight,
    depLeft: detected.depLeft ?? fallback.depLeft,
    beginLeft: detected.beginLeft ?? fallback.beginLeft,
    endLeft: detected.endLeft ?? fallback.endLeft,
    arrLeft: detected.arrLeft ?? fallback.arrLeft,
    tableLeft: detected.tableLeft ?? fallback.tableLeft,
    tableRight: detected.tableRight ?? fallback.tableRight,
  };
}

function pickLayoutClusterRanges(lines, detected) {
  const patterns = getPatterns();
  const clusters = patterns?.layoutClusters;
  if (!Array.isArray(clusters) || clusters.length === 0) return null;

  const observedMaxX = lines.length ? Math.max(...lines.map(l => l.x1 || 0)) : 0;
  const observedDutyLeft = detected?.dutyLeft ?? patterns?.columnZones?.dutyLeft?.median ?? 120;

  let best = null;
  let bestScore = Infinity;
  for (const cluster of clusters) {
    const c = cluster?.columns || {};
    const cTableRight = c.tableRight?.median;
    const cDutyLeft = c.dutyLeft?.median;
    if (!Number.isFinite(cTableRight) || !Number.isFinite(cDutyLeft)) continue;
    const score = Math.abs(cTableRight - observedMaxX) + 0.7 * Math.abs(cDutyLeft - observedDutyLeft);
    if (score < bestScore) {
      bestScore = score;
      best = c;
    }
  }

  if (!best) return null;
  return {
    dutyLeft: best.dutyLeft?.median ?? null,
    dutyRight: best.dutyRight?.median ?? null,
    depLeft: best.depLeft?.median ?? null,
    beginLeft: best.beginLeft?.median ?? null,
    endLeft: best.endLeft?.median ?? null,
    arrLeft: best.arrLeft?.median ?? null,
    tableLeft: best.tableLeft?.median ?? null,
    tableRight: best.tableRight?.median ?? null,
  };
}

function reconcileColumnRanges(detected, layoutFallback) {
  if (!detected) return layoutFallback || null;
  if (!layoutFallback) return detected;
  // A header that showed every column name was measured on THIS image; a
  // learned layout is a median over other images (other sizes/crops). Letting
  // the layout win shrank "1 (15).jpeg"'s duty zone to 5px (dutyLeft 100->188)
  // and every duty came out empty (2026-10-01). Only fill gaps in that case.
  if (detected._fullHeader) {
    const out = { ...detected };
    for (const [k, v] of Object.entries(layoutFallback)) if (!Number.isFinite(out[k])) out[k] = v;
    return out;
  }

  const thresholds = {
    dutyLeft: 80,
    dutyRight: 100,
    depLeft: 100,
    beginLeft: 120,
    endLeft: 140,
    arrLeft: 160,
    tableLeft: 80,
    tableRight: 140,
  };

  const out = { ...detected };
  for (const key of Object.keys(thresholds)) {
    const d = detected[key];
    const f = layoutFallback[key];
    if (!Number.isFinite(d)) {
      out[key] = f;
      continue;
    }
    if (Number.isFinite(f) && Math.abs(d - f) > thresholds[key]) {
      out[key] = f;
    }
  }
  return out;
}

/**
 * Compute column x-ranges from header fragment positions.
 * Excludes sidebar text (e.g. "Please Read") by finding the rightmost
 * column keyword and using it as the table right boundary.
 */
function computeColumnRanges(headerRow) {
  const frags = headerRow.lines.map(l => ({
    text: l.text, x0: l.x0, x1: l.x1
  }));

  // Find fragments that contain column keywords
  const colFrags = [];
  for (const f of frags) {
    for (const { search } of COL_SEARCH_TERMS) {
      if (new RegExp('\\b' + search + '\\b', 'i').test(f.text)) {
        colFrags.push(f);
        break;
      }
    }
  }
  if (colFrags.length === 0) return getLearnedColumnFallback();

  // tableRight = rightmost column fragment right edge + padding
  const arrRight = Math.max(...colFrags.map(f => f.x1));
  const tableLeft = Math.min(...colFrags.map(f => f.x0)) - 10;
  const tableRight = arrRight + 25;

  // For duty zone: find the duty and dep column fragments
  const dutyF = colFrags.find(f => /\bduty\b/i.test(f.text));
  const depF = colFrags.find(f => /\bdep\b/i.test(f.text));
  const beginF = colFrags.find(f => /\bbegin\b/i.test(f.text));
  const endF = colFrags.find(f => /\bend\b/i.test(f.text));
  const arrF = colFrags.find(f => /\barr\b/i.test(f.text));
  const fallback = getLearnedColumnFallback();
  const fullHeader = !!(dutyF && depF && beginF && endF && arrF);

  return mergeColumnRanges({
    _fullHeader: fullHeader,
    dutyLeft: dutyF ? dutyF.x0 - 25 : null,
    dutyRight: depF ? depF.x0 - 5 : null,
    depLeft: depF ? depF.x0 : null,
    beginLeft: beginF ? beginF.x0 : null,
    endLeft: endF ? endF.x0 : null,
    arrLeft: arrF ? arrF.x0 : null,
    tableLeft,
    tableRight,
  }, fallback);
}

// ---------------------------------------------------------------------------
// Row parsing
// ---------------------------------------------------------------------------

/**
 * Calculate confidence for a row based on its OCR fragments.
 * Returns: { overallConfidence: 0-1, fieldConfidences: { date, duty, dep, times, arr }, lowConfidenceFields: [] }
 */
function evaluateRowConfidence(row, colRanges) {
   const tableFrags = colRanges
     ? row.lines.filter(l => l.x0 <= colRanges.tableRight && l.x1 >= colRanges.tableLeft)
     : [...row.lines];
   if (tableFrags.length === 0) return { overallConfidence: 0, fieldConfidences: {}, lowConfidenceFields: [] };

   // Group fragments by field zone
   const dateFrags = row.lines.filter(l => !colRanges || l.x1 < colRanges.tableLeft);
   const dutyFrags = tableFrags.filter(l => colRanges && l.x1 >= colRanges.dutyLeft && l.x0 <= colRanges.dutyRight);
   const timeFrags = tableFrags.filter(l => {
     const text = String(l.text || '').toUpperCase();
     return /\d{2}:\d{2}/.test(text);
   });
   const airportFrags = tableFrags.filter(l => {
     const tokens = l.text.split(/\s+/);
     return tokens.some(t => isAirportCode(t));
   });

   // Calculate average confidence per field type
   const avg = (frags) => frags.length > 0 
     ? frags.reduce((s, f) => s + (f.confidence || 0.5), 0) / frags.length 
     : 0.5;

   const fieldConfidences = {
     date: avg(dateFrags),
     duty: avg(dutyFrags),
     times: avg(timeFrags),
     airports: avg(airportFrags),
   };

   // Identify low-confidence fields (< 0.5 for most, < 0.6 for dates/times)
   const lowConfidenceFields = [];
   if (fieldConfidences.date < 0.6 && dateFrags.length > 0) lowConfidenceFields.push('date');
   if (fieldConfidences.duty < 0.5 && dutyFrags.length > 0) lowConfidenceFields.push('duty');
   if (fieldConfidences.times < 0.6 && timeFrags.length > 0) lowConfidenceFields.push('times');
   if (fieldConfidences.airports < 0.5 && airportFrags.length > 0) lowConfidenceFields.push('airports');

   const overallConfidence = (fieldConfidences.date + fieldConfidences.duty + fieldConfidences.times + fieldConfidences.airports) / 4;

   return { overallConfidence, fieldConfidences, lowConfidenceFields };
}

/**
 * Parse one visual row into { date, day, duty, dep, begin, end, arr }.
 * Now tracks confidence levels per field.
 */
function parseContentRow(row, prevDate, colRanges, prevDay, findClosestDate) {
   // Filter by table x-range
   const tableFrags = colRanges
     ? row.lines.filter(l => l.x0 <= colRanges.tableRight && l.x1 >= colRanges.tableLeft)
     : [...row.lines];
   if (tableFrags.length === 0) return null;

   // Evaluate confidence early
   const confidence = evaluateRowConfidence(row, colRanges);
   
   const sorted = [...tableFrags].sort((a, b) => a.x0 - b.x0);
   const rawText = sorted.map(l => l.text).join(' ');
   const text = normalizeRowText(rawText);
  

  if (!text.trim()) return null;
  // Skip rows that absorbed section marker text
  if (/rest of this roster is planned/i.test(text)) return null;

  // --- Date + Day ---
  // Extract date from ALL row text (date column is left of tableLeft)
  const allRowText = normalizeRowText(row.lines.map(l => l.text).join(' '));
  let dateInfo = extractDateFromText(allRowText) || extractDateFromText(text);
  
  const dateFromText = !!dateInfo;
  if (!dateInfo) {
    // findClosestDate doesn't depend on prevDate at all — it searches the
    // whole page's pre-extracted date-lines — so it can help even on the
    // very FIRST content row, before any prevDate exists yet. Gating it
    // behind `prevDate` meant a row whose own date text got OCR-garbled
    // (e.g. "Jan" misread as "n") was simply dropped whenever it happened
    // to be one of the first rows, with no fallback available at all —
    // confirmed via a real benchmark run 2026-09-21 as the cause of some
    // images losing their first several rows entirely. prevDate is still
    // the final fallback when no nearby date-line is found.
    let closest = findClosestDate ? findClosestDate(row.yc) : null;
    // Rows come in reading order, so a dateless row (2nd+ sector of a day) is
    // never EARLIER than the row before it. The date lookup only holds rows
    // with <=2 boxes, so "20 Aug | CHECK-IN | 10:35" is missing from it and
    // the next sectors picked the "19 Aug" row above instead (2026-10-01).
    if (closest && prevDate) {
      const c = dateKey(closest.date), p = dateKey(prevDate);
      if (c && p && (c[0] - p[0] || c[1] - p[1] || c[2] - p[2]) < 0) closest = null;
      // A date line BELOW the row is the next day starting; the previous
      // row's date is the better guess for a trailing sector / CHECK-OUT.
      else if (closest.below) closest = null;
    }
    if (closest) {
      dateInfo = { date: closest.date, day: closest.day || '', matchedText: '' };
    } else if (prevDate) {
      dateInfo = { date: prevDate, day: prevDay || '', matchedText: '' };
    }
  }
  
  if (!dateInfo) return null;
  
  const date = dateInfo.date;
  let day = dateInfo.day || '';

  // Fix: If day is missing but date is present, calculate it (or inherit from prevDay if same date)
  if (!day) {
    if (prevDate === date) {
      day = prevDay || '';
    }
    // If still missing (either new date or prevDay was also empty), calculate it
    if (!day) {
      day = calculateWeekday(date) || '';
    }
  }

  // --- Times ---
  const times = extractTimesFromText(text);
  // NOTE: a lone time is reported as begin. Deciding begin-vs-end for a lone
  // time by box x-position (tried 2026-09-25, boundary midway between the
  // Begin/End header columns) moved ~35 rows the right way but broke more,
  // net -16 exact rows, so it was not kept.
  let begin = times.length >= 1 ? times[0] : '';
  let end = times.length >= 2 ? times[1] : '';
  // ...except CHECK-OUT, whose only time is printed in the End column (77 of
  // 101 labeled cells; the other 24 were label slips, fixed 2026-10-01).
  if (times.length === 1 && /CHECK-?\s*OUT/i.test(text)) { end = begin; begin = ''; }

  // --- Airports (from table-filtered tokens only) ---
  // Extract airports from RAW tokens (not normalized) to avoid digit-letter split breaking duty codes
  const allTokens = [];
  const tokenX = new Map(); // token index -> approx x centre (by character offset within its box)
  // The Arr code is often glued to the End time ("13:30Z15:10ZMLA",
  // "22:0S ZMAN"): split it off so it can be read as an airport (2026-10-05).
  const fragText = new Map(sorted.map(f => [f, f.text.replace(/(^|[\s\d])Z([A-Z][A-Z01]{2})\b/g, '$1Z $2')]));
  for (const f of sorted) {
    const ft = fragText.get(f);
    let from = 0;
    for (const p of ft.split(/\s+/).filter(Boolean)) {
      const at = ft.indexOf(p, from);
      from = at + p.length;
      const len = Math.max(1, ft.length);
      tokenX.set(allTokens.length, f.x0 + ((at + p.length / 2) / len) * (f.x1 - f.x0));
      allTokens.push(p);
    }
  }
  // Three-letter duty codes (CTO, SIM, ...) look like airports. When the header
  // gave us both the Duty and Dep columns, a token whose centre lies left of
  // the Duty/Dep boundary is duty, whatever its shape (2026-10-01).
  const depBoundary = colRanges && Number.isFinite(colRanges.dutyLeft) && Number.isFinite(colRanges.depLeft)
    && colRanges.depLeft - colRanges.dutyLeft > 20
    ? colRanges.depLeft - 0.25 * (colRanges.depLeft - colRanges.dutyLeft)
    : null;
  const inDutyColumn = (i) => depBoundary !== null && tokenX.get(i) < depBoundary;
  // Right of the duty column a 3-char code with a 1/0 is an airport misread
  // ("ED1" -> EDI, "P1K" -> PIK); flight numbers never get here.
  const apTokens = allTokens.map((t, i) => (depBoundary !== null && !inDutyColumn(i)
    && /^(?=(?:[^A-Z]*[A-Z]){2})[A-Z][A-Z01]{2}$/.test(t) ? t.replace(/1/g, 'I').replace(/0/g, 'O') : t));
  const airports = apTokens.filter((t, i) => isAirportCode(t) && !inDutyColumn(i));
  let dep = '', arr = '';
  if (airports.length >= 2) {
    dep = airports[0];
    arr = airports[airports.length - 1];
  } else if (airports.length === 1) {
    const apIdx = text.toUpperCase().indexOf(airports[0]);
    const ftIdx = text.search(/\d{2}:\d{2}/);
    if (apIdx >= 0 && (ftIdx < 0 || apIdx < ftIdx)) dep = airports[0];
    else arr = airports[0];
  }

  // --- Duty (zone-based or fallback) ---
  let duty;
  if (colRanges) {
    // Get tokens in duty zone (between duty column and the next known column)
    const dutyRightEdge = [colRanges.dutyRight, colRanges.depLeft, colRanges.beginLeft, colRanges.endLeft, colRanges.arrLeft]
      .filter(v => Number.isFinite(v))
      .sort((a, b) => a - b)[0] ?? (Number.isFinite(colRanges.dutyLeft) ? colRanges.dutyLeft + 120 : 220);
    const dutyTokens = [];
    const keepAsDuty = new Set(); // airport-shaped tokens that sit in the Duty column
    let tokIdx = 0;
    for (const f of sorted) {
      const parts = fragText.get(f).split(/\s+/).filter(Boolean);
      if (f.x1 >= colRanges.dutyLeft && f.x0 <= dutyRightEdge) {
        for (const p of parts) {
          if (isAirportCode(p) && inDutyColumn(tokIdx)) keepAsDuty.add(dutyTokens.length);
          dutyTokens.push(p);
          tokIdx++;
        }
      } else {
        tokIdx += parts.length;
      }
    }
    // Remove weekday names, month names, stray 1-2 digit numbers (unless they're known duty codes)
    const wdRe = /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun)/i;
    const moRe = /^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)/i;
    const patterns = getPatterns();
    const knownDutyCodes = new Set((patterns?.dutyPatterns?.known || []).map(c => c.toUpperCase()));
    // The date box can swallow the duty cell: "30 Mar2OFF(Z)", "17 Apr20OFF(Z)".
    // Keep the duty after the month/year and drop the day number before it,
    // which would otherwise pass as flight "30" (9 planned cells, 2026-10-07).
    for (let i = 0; i < dutyTokens.length; i++) {
      if (!/^(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)/i.test(dutyTokens[i])) continue;
      // lowercase-only month tail, so "MarOFF(Z)" keeps its OFF
      const rest = dutyTokens[i].slice(3).replace(/^[a-z]*\.?\d{0,4}/, '');
      if (!rest || /^\d+$/.test(rest) || !DUTY_SHAPE_RE.test(normDuty(rest))) continue;
      dutyTokens[i] = rest;
      if (i > 0 && /^\d{1,2}$/.test(dutyTokens[i - 1])) dutyTokens[i - 1] = '';
    }
    const filtered = dutyTokens.filter((t, i) => {
      if (!t) return false;
      if (keepAsDuty.has(i)) return true;
      if (wdRe.test(t)) return false;
      if (moRe.test(t)) return false;
      if (/^\d{1,2}$/.test(t) && !knownDutyCodes.has(t.toUpperCase())) return false;
      if (/^(DATE|DEP|BEGIN|END|ARR)$/i.test(t)) return false;
      if (isAirportCode(t)) return false;
      // Keep 1-2 digit numbers if they're known duty codes from calibration
      if (/^\d{1,2}$/.test(t)) {
        return knownDutyCodes.has(t.toUpperCase());
      }
      return true;
    });
    duty = normDuty(filtered.join(' '));
  } else {
    // Fallback: text between date and first airport
    duty = extractDutyFallback(text, airports, dateInfo);
  }

  // Apply learned duty normalizations from calibration
  const patterns = getPatterns();
  if (patterns?.dutyPatterns?.normalizations) {
    for (const [from, to] of Object.entries(patterns.dutyPatterns.normalizations)) {
      const re = new RegExp(from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
      duty = duty.replace(re, to);
    }
  }

  duty = normDuty(duty);
  // Normalize OFF variants FIRST (before cleanup removes Z/digits)
  duty = duty.replace(/OFF\s*\(\s*\d\s*\)/gi, 'OFF(Z)');
  duty = duty.replace(/OFF\s*\(\s*Z\s*\)/gi, 'OFF(Z)');
  duty = duty.replace(/OFE\s*\(\s*(\d|Z)\s*\)/gi, 'OFF(Z)');
  // Clean date remnants from duty (when date+duty share same OCR fragment)
  duty = duty.replace(/\b(Mon|Tue|Wed|Thu|Fri|Sat|Sun)[A-Za-z]*[.,\s]*/gi, '');
  duty = duty.replace(/\b\d{1,2}\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[A-Za-z.]*[.,\s]*/gi, '');
  // ...and a weekday glued to the day number ("Tu11 CHECK-IN", "F121Feb CHECK-IN").
  duty = duty.replace(/^(?:(?:Mo|Tu|We|Th|Fr|Sa|Su)[a-z]{0,2}\s?\d{0,2}|[FMW]\s?\d{1,3}\s?(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*)\s+(?=\S)/, '');
  // Remove time patterns only (date remnants already cleaned above)
  duty = duty.replace(/\d{2}:\d{2}/g, '');
  // Standby codes are always written "SBY0900-Z" in the labels (296 cells, never
  // "SBY0900 Z"); restore the hyphen before the standalone-Z removal below
  // would drop a hyphen-less Z.
  // Same 0-read-as-bracket slip as in times: "SBY(30() Z", "SBY103() Z".
  duty = duty.replace(/\bSBY([0-9()]{4,6})(?=\s*-?\s*Z\b)/gi, (m, digits) => {
    const d = digits.replace(/\)/g, '').replace(/\(/g, '0');
    return /^\d{4}$/.test(d) ? `SBY${d}` : m;
  });
  duty = duty.replace(/\b(SBY[0-9D]\d{3})\s*-?\s*Z\b/gi, (_m, code) => `${code.toUpperCase()}-Z`);
  // Remove standalone Z (timezone marker), but preserve Z after hyphen (e.g. SBY0900-Z)
  duty = duty.replace(/(?<![A-Za-z(-])\b[Zz]\b(?![A-Za-z)])/g, '').replace(/\s+/g, ' ').trim();
  // Duty cleanup: trailing "2" or "z" -> Z only if NOT part of a number (flight code).
  // RST2 is a real code (20 labeled cells), not RSTZ.
  if (!/^RST2$/i.test(duty)) duty = duty.replace(/(?<!\d)[2z]$/i, 'Z');
  // Remove trailing hyphen before Z if it was a timezone marker (e.g. "FR1234 - Z" -> "FR1234 Z")
   if (!/^SBY[0-9D]\d{3}-Z$/.test(duty)) duty = duty.replace(/\s*-\s*Z$/i, ' Z');
   duty = cleanDutyJunk(duty);
   if (/^Z$/i.test(duty)) duty = '';
   // The CHECK-OUT time -> End rule above only saw the raw text; a slip it
   // missed ("CHECK-O0T") is fixed by now.
   if (duty === 'CHECK-OUT' && begin && !end) { end = begin; begin = ''; }
   // "May 20" + "C19" read as one box "20019" (C as 0): 5 digits is never a duty.
   if (/^20[0OC]19$/.test(duty)) duty = 'C19';
   // These codes always span the same hours in the labels (OFF(Z) 1842/1842,
   // C19 526/526). When OCR lost or garbled one of the times ("2::00 Z",
   // "10)10)()Z"), but every time it did read fits, fill in the pair. A time
   // outside the pair is left alone (2026-10-07).
   const fixedTimes = FIXED_DUTY_TIMES[duty];
   if (fixedTimes && (begin !== fixedTimes[0] || end !== fixedTimes[1])
     && times.every(t => fixedTimes.includes(t))) [begin, end] = fixedTimes;

    if (!duty && !begin && !end && !dep && !arr) return null;

    // Row's pixel box in the *original* uploaded image (paddle-ocr.js already
    // undoes any OCR-side resize scaling before boxes reach here) — lets a
    // UI crop out exactly this row for a human to check the extraction
    // against, e.g. via <canvas>.drawImage(img, box.left, box.top,
    // box.right-box.left, box.bottom-box.top, ...). Not underscore-prefixed
    // like the _confidence/_fieldConfidences debug fields above: this one is
    // meant to reach the client, not be stripped by cleanExtractionResult.
    const boxLeft = colRanges?.tableLeft ?? Math.min(...row.lines.map(l => l.x0));
    const boxRight = colRanges?.tableRight ?? Math.max(...row.lines.map(l => l.x1));
    const box = {
      top: Math.round(row.y0),
      bottom: Math.round(row.y1),
      left: Math.round(boxLeft),
      right: Math.round(boxRight),
    };

    const parsedRow = {
      date,
      day: day.toUpperCase(),
      duty,
      dep,
      begin,
      end,
      arr,
      box,
      _confidence: confidence.overallConfidence,
      _fieldConfidences: confidence.fieldConfidences,
      _lowConfidenceFields: confidence.lowConfidenceFields,
      _dateFromText: dateFromText,
      _wdRead: readRowWeekday(row, colRanges),
      // Any text starting in the date column (left of Duty)? null = no geometry.
      _hasDateCell: Number.isFinite(colRanges?.dutyLeft)
        ? row.lines.some(l => l.x0 < colRanges.dutyLeft - 5 && /[A-Za-z0-9]/.test(l.text))
        : null,
    };

    return parsedRow;
 }

const GLUED_WEEKDAY_RE = /^(?:(Mo|Tu|We|Th|Fr|Sa|Su|Sn)[a-z]{0,2}1?(?:\d{1,2}(?!\d)|(?=[\s,.]|$))|([FMW])(?=\d{1,3}(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)))/;

/**
 * The weekday printed in the row's date cells ("Tue", "Fri,", OCR slips like
 * "Sati", "Fr1", "MOI)"), or '' when none is readable. Only boxes left of the
 * duty column count, so a duty/airport token can't pass for a weekday. A
 * token one edit from two weekdays ("S0": SAT/SUN) is ambiguous -> ''.
 */
function readRowWeekday(row, colRanges) {
  const dutyLeft = colRanges?.dutyLeft;
  const frags = [...row.lines].sort((a, b) => a.x0 - b.x0)
    .filter((l, i) => (Number.isFinite(dutyLeft) ? l.x0 < dutyLeft : i < 3));
  // Split glued runs too ("20Fri", "4May"), then drop month names: "Jun" is
  // one edit from "SUN".
  const toks = frags.flatMap(f => f.text.split(/[\s,.;:]+|(?<=\d)(?=[A-Za-z])|(?<=[A-Za-z])(?=\d{2})/))
    .map(tok => tok.replace(/[^A-Za-z0-9()]/g, '').slice(0, 3).toUpperCase())
    .filter(t => t.length >= 2 && !MONTHS.some(m => m.toUpperCase() === t));
  const exact = toks.find(t => WEEKDAYS.includes(t));
  if (exact) return exact;
  for (const t of toks) {
    if (t.length !== 3 || !/^[A-Z]/.test(t)) continue;
    const near = WEEKDAYS.filter(d => levenshtein(t.replace(/1/g, 'I').replace(/0/g, 'O'), d) <= 1);
    if (near.length === 1) return near[0];
  }
  // Date cells sometimes merge into the duty box: "Tu11 CHECK-IN",
  // "We CHECK-IN", "F121Feb CHECK-IN". Case matters: "FR5376" is a flight.
  const first = [...row.lines].sort((a, b) => a.x0 - b.x0).find(l => !frags.includes(l));
  for (const f of first ? [...frags, first] : frags) {
    const g = GLUED_WEEKDAY_RE.exec(f.text.trim());
    if (g) return WEEKDAYS.find(d => d.startsWith((g[1] || g[2]).toUpperCase().replace('SN', 'SU'))) || '';
  }
  return '';
}

const DAY_MS = 86400000;
function dateToKey(ds) {
  const k = dateKey(ds);
  return k && k[1] >= 0 ? Date.UTC(2000 + k[0], k[1], k[2]) / DAY_MS : null;
}
function keyToDate(key) {
  const d = new Date(key * DAY_MS);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${String(d.getUTCFullYear() % 100).padStart(2, '0')}`;
}
const keyWeekday = (key) => WEEKDAYS[new Date(key * DAY_MS).getUTCDay()];

/**
 * Re-date one section's rows, in place, from the sequence instead of row by
 * row. In the planned table OCR often garbles the date cell ("28 Arr",
 * "Mav 20", year "70", "17MY") while the printed weekday survives; the row
 * then inherited the previous row's date (or kept the bad one), shifting
 * date+day by one row — the top planned error (2026-10-05).
 * Dates never decrease down a table; labels: 29% of steps are 0 days (more
 * sectors on the same day), 67% +1, the rest rare. So:
 *   - anchor = date read from the row's own text, year = section majority,
 *     printed weekday (if read) agrees with it, and not before the previous row;
 *   - any other row with a readable weekday -> the first date >= previous
 *     row's date on that weekday (a repeated weekday = same day);
 *   - other rows keep their date, except a run of them between two anchors
 *     whose day gap equals the row gap -> one day per row.
 * Weekday is always recomputed from the final date (labels: 6233/6246 agree).
 * seedKey: the day before the first row, when known — the planned table
 * starts the day after the published one ends in 139 of 143 labels, which
 * dates planned rows whose own date cell is unreadable from the very top.
 */
function repairDateSequence(rows, seedKey = null) {
  if (rows.length < (seedKey == null ? 2 : 1)) return;
  const years = new Map();
  for (const r of rows) {
    const k = r._dateFromText && dateKey(r.date);
    if (k) years.set(k[0], (years.get(k[0]) || 0) + 1);
  }
  if (!years.size) return;
  const year = [...years.entries()].sort((a, b) => b[1] - a[1])[0][0];

  const info = rows.map(r => {
    let key = dateToKey(r.date);
    const k = dateKey(r.date);
    // A misread year ("27 Apr 70") is replaced by the section's majority year.
    if (k && k[0] !== year && Math.abs(k[0] - year) > 1) key = dateToKey(`${k[2]} ${MONTHS[k[1]]} ${String(year).padStart(2, '0')}`);
    const wdOk = !r._wdRead || (key != null && keyWeekday(key) === r._wdRead);
    return { key, anchor: !!(r._dateFromText && key != null && wdOk), wd: r._wdRead || '' };
  });

  // Forward pass.
  let prev = seedKey;
  const solid = new Array(rows.length).fill(false);
  const minutes = (t) => { const m = /^(\d{2}):(\d{2})/.exec(t || ''); return m ? +m[1] * 60 + +m[2] : null; };
  let lastT = null;
  for (let i = 0; i < rows.length; i++) {
    const it = info[i];
    // Times only grow inside one day's block (a leg past midnight shows it on
    // its End only), so a dateless row whose time runs backwards starts a new
    // day whose dated first row OCR missed (CHECK-OUT 22:00 then FR8330 15:25).
    const t = minutes(rows[i].begin || rows[i].end);
    // Only across a block boundary (after a CHECK-OUT, or at a CHECK-IN): mid-
    // block it is more likely a misread time ("10:00" for 18:00).
    const timeWentBack = t != null && lastT != null && t < lastT - 60
      && (/CHECK-?\s*OUT/i.test(rows[i - 1]?.duty || '') || /CHECK-?\s*IN/i.test(rows[i].duty || ''));
    const prevBefore = prev;
    if (it.anchor && (prev == null || (it.key >= prev && it.key - prev <= 14))) {
      solid[i] = true;
    } else if (prev != null && it.wd) {
      it.key = prev + ((WEEKDAYS.indexOf(it.wd) - WEEKDAYS.indexOf(keyWeekday(prev)) + 7) % 7);
      solid[i] = true;
    } else if (prev != null && rows[i]._hasDateCell === false && !(i === 0 && seedKey != null) && !timeWentBack) {
      // eCrew prints the date only on a day's first row: a row with nothing
      // in the date column continues the previous row's day. (A blanket
      // "CHECK-IN opens a new day" rule broke HSBY/RST3/TSIM + CHECK-IN days
      // and CHECK-OUT-after-midnight + CHECK-IN days in new rosters, 2026-10-06.)
      it.key = prev;
    } else if (prev != null && (rows[i]._hasDateCell || timeWentBack || /CHECK-?\s*IN/i.test(rows[i].duty || '') || (i === 0 && seedKey != null)) && (it.key == null || it.key <= prev)) {
      // Something (garbled) is printed in the date column: a new day starts.
      // Without column geometry, a CHECK-IN is the best new-day hint.
      it.key = prev + 1;
    } else if (prev != null && (it.key == null || it.key < prev)) {
      it.key = prev;
    }
    // Until the first solid row there is nothing to trust: a bad leading date
    // ("24 Jun" for 24 Jan) must not become the reference for the rest.
    if (it.key != null && (prev != null || solid[i])) prev = it.key;
    // A new day (even one opened by a timeless TSIM/RST2/LCK row) forgets the
    // previous day's last time.
    if (prev !== prevBefore) lastT = null;
    if (t != null) lastT = t;
  }
  // Leading rows before the first solid one: walk back from it by weekday.
  const first = solid.indexOf(true);
  if (first > 0) {
    let next = info[first].key;
    for (let i = first - 1; i >= 0; i--) {
      const it = info[i];
      if (it.wd) {
        it.key = next - ((WEEKDAYS.indexOf(keyWeekday(next)) - WEEKDAYS.indexOf(it.wd) + 7) % 7);
        solid[i] = true;
      } else if (it.key == null || it.key > next) it.key = next;
      next = it.key;
    }
  }
  // Runs of weak rows between two solid rows (the seed counts as one at
  // index -1): one row per day if it fits exactly.
  const keyAt = (j) => (j < 0 ? seedKey : info[j].key);
  let last = seedKey == null ? null : -1;
  for (let i = 0; i < rows.length; i++) {
    if (!solid[i]) continue;
    if (last != null && i - last > 1 && info[i].key - keyAt(last) === i - last) {
      for (let j = last + 1; j < i; j++) info[j].key = keyAt(last) + (j - last);
    }
    last = i;
  }

  rows.forEach((r, i) => {
    const key = info[i].key;
    if (key == null) return;
    r.date = keyToDate(key);
    r.day = keyWeekday(key);
  });
}

/**
 * Fill a flight row's empty Arr from the flight chain, in place. Every labeled
 * flight row has an Arr (0 of 2455 empty) and the Arr is the next row's Dep on
 * the same day, else — last leg of an out-and-back — the previous leg's Dep:
 * right for 2402 of 2455 labeled legs. OCR drops the Arr cell or leaves it
 * glued to unreadable time debris, so this recovers it (2026-10-05).
 */
// The duty printed after the date in one OCR box ("Wed 26 Feb 20 TSIM" -> "TSIM"),
// or '' when the box holds only the date.
function dateLineDuty(text) {
  const m = /^\W*(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)[a-z]*[.,\s]*\d{1,2}\s*(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s*(?:['’]?\d{2,4}\b)?\s*(.*)$/i.exec(String(text || ''));
  const rest = normDuty(m ? m[1] : '');
  return rest && DUTY_SHAPE_RE.test(rest) ? rest : '';
}

const FIXED_DUTY_TIMES ={ 'OFF(Z)': ['00:00 Z', '21:00 Z'], C19: ['00:00 Z', '23:59 Z'] };
const FLIGHT_DUTY_RE = /^(?:FR|DH)? ?\d{2,4}$/;
function inferMissingArr(rows) {
  rows.forEach((r, i) => {
    if (r.arr || !FLIGHT_DUTY_RE.test(r.duty || '')) return;
    const next = rows[i + 1], prev = rows[i - 1];
    if (next?.dep && next.date === r.date) r.arr = next.dep;
    // (prev.arr may itself be one letter off: "CRL BQD" then "BOD ?")
    else if (prev?.dep && r.dep && prev.arr && prev.date === r.date && FLIGHT_DUTY_RE.test(prev.duty || '')
      && [...prev.arr].filter((c, k) => c !== r.dep[k]).length <= 1) r.arr = prev.dep;
  });
}

/**
 * Where the chain says two cells hold the same airport (Arr of a leg and Dep of
 * the next leg that day) but OCR read them one letter apart ("CRL"/"CRI",
 * "MLA"/"MLZ"), rewrite the spelling that is rarer in this roster to the more
 * common one; ties are left alone. Real one-letter-apart pairs exist (TFS/TLS,
 * BRI/BRS, STC/STN in the labels), which is why a lone rare code is never
 * snapped without the chain linking it to its twin (2026-10-05).
 */
function reconcileAirportChain(sections) {
  const all = sections.flat();
  const count = new Map();
  for (const r of all) for (const a of [r.dep, r.arr]) if (a) count.set(a, (count.get(a) || 0) + 1);
  const oneApart = (a, b) => a.length === 3 && b.length === 3 && [...a].filter((c, i) => c !== b[i]).length === 1;
  // Non-flight rows (OFF, A/L, SBY, ...) sit at home base: 3279 of 3365
  // labeled ones carry the roster's most common non-flight Dep, and only 2 of
  // the rest are one letter away from it. So a one-letter-off Dep there is
  // the base misread ("CRI" for CRL).
  const baseCount = new Map();
  for (const r of all) if (r.dep && !FLIGHT_DUTY_RE.test(r.duty || '')) baseCount.set(r.dep, (baseCount.get(r.dep) || 0) + 1);
  const base = [...baseCount.entries()].sort((a, b) => b[1] - a[1])[0];
  if (base && base[1] >= 3) {
    for (const r of all) {
      if (r.dep && r.dep !== base[0] && !FLIGHT_DUTY_RE.test(r.duty || '') && oneApart(r.dep, base[0])) r.dep = base[0];
      // A return leg (Dep away from base) landing one letter off the base, on a
      // day whose first flight left from the base. That last check keeps real
      // near-twins: "FR 508 DUB BRS" while the crew was still DUB-based.
      else if (r.arr && FLIGHT_DUTY_RE.test(r.duty || '') && r.dep && r.dep !== base[0] && !oneApart(r.dep, base[0])
        && r.arr !== base[0] && oneApart(r.arr, base[0]) && (count.get(r.arr) || 0) * 4 <= base[1]
        && all.find(x => x.date === r.date && FLIGHT_DUTY_RE.test(x.duty || ''))?.dep === base[0]) r.arr = base[0];
    }
  }
  for (const rows of sections) {
    for (let i = 0; i + 1 < rows.length; i++) {
      const r = rows[i], n = rows[i + 1];
      if (!r.arr || !n.dep || r.date !== n.date || !oneApart(r.arr, n.dep)) continue;
      const ca = count.get(r.arr) || 0, cd = count.get(n.dep) || 0;
      if (ca > cd) n.dep = r.arr;
      else if (cd > ca) r.arr = n.dep;
    }
  }
}

/**
 * A roster prints flight numbers one way throughout ("FR 1505" in the 2020
 * layout, "FR1505" in later ones; no label mixes them), but OCR sometimes
 * drops or adds the space on single cells. Rewrite the minority spelling to
 * the roster's majority one, in place.
 */
function harmonizeFlightSpacing(rows) {
  const FR_RE = /\bFR ?(\d{2,5}[A-Z]?)\b/g;
  let spaced = 0, glued = 0;
  for (const r of rows) {
    for (const m of String(r.duty || '').matchAll(FR_RE)) (m[0][2] === ' ' ? spaced++ : glued++);
  }
  if (spaced === glued) return;
  const sep = spaced > glued ? ' ' : '';
  for (const r of rows) if (r.duty) r.duty = r.duty.replace(FR_RE, (_m, num) => `FR${sep}${num}`);
}

function extractDutyFallback(text, airports, dateInfo) {
  let t = text;
  if (dateInfo?.matchedText) t = t.replace(dateInfo.matchedText, '');
  t = t.replace(/\b(Mon|Tue|Wed|Thu|Fri|Sat|Sun)[A-Za-z]*\b/gi, '');
  t = t.replace(/\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[A-Za-z.]*\b/gi, '');
  t = t.replace(/\d{2}:\d{2}(?:\s*Z)?/gi, '');
  for (const ap of airports) {
    t = t.replace(new RegExp('\\b'+ap.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'\\b','gi'), '');
  }
  t = t.replace(/\b[Zz]\b/g, '').replace(/[,.\-]/g, ' ').replace(/\s+/g, ' ').trim();
  return t;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export function parseRoster(rawLines) {
  const lines = (rawLines || [])
    .map(l => ({
      text: String(l.text || '').trim(),
      confidence: l.confidence,
      box: Array.isArray(l.box) && l.box.length >= 4 ? l.box : null,
    }))
    .filter(l => l.text && l.box && (l.confidence == null || l.confidence >= 0.3) && !SIDEBAR_NOISE_RE.test(l.text))
    .map(l => ({ ...l, ...geom(l.box) }));
  if (lines.length === 0) return { published: [], planned: [] };

  // Drop the right-hand "Roster Responsibility" sidebar geometrically: its
  // text is garbled too often for SIDEBAR_NOISE_RE ("generae change
  // noificaions"), and a tall sidebar box overlapping two dense table rows
  // made groupRows fuse them ("FR7075 ... FR7074 ..." as one row, 2026-10-01).
  // Cut = right edge of the "Arr" header + margin; with no Arr header, keep all.
  const arrHeaders = lines.filter(l => /^arr$/i.test(l.text));
  if (arrHeaders.length) {
    const arrX1 = Math.min(...arrHeaders.map(l => l.x1));
    const arrW = Math.max(...arrHeaders.map(l => l.x1 - l.x0));
    const cut = arrX1 + Math.max(40, 2 * arrW);
    for (let i = lines.length - 1; i >= 0; i--) if (lines[i].x0 > cut) lines.splice(i, 1);
  }

  // Pre-extract date lines to prevent header from absorbing them
  const DATE_LINE_RE = /\b(Mon|Tue|Wed|Thu|Fri|Sat|Sun)[A-Za-z]*[.,\s]+\d{1,2}\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)/i;
  const dateLines = [];
  const nonDateLines = [];
  
  // Build dynamic duty pattern regex from learned patterns
  const patterns = getPatterns();
  const knownDutyCodes = patterns?.dutyPatterns?.known || [];
  const twoDigitDutyPattern = knownDutyCodes
    .filter(c => /^\d{1,2}$/.test(c))
    .map(c => c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('|');
  
  for (const l of lines) {
    // Check if line contains duty codes (including learned 2-digit codes)
    let _isDutyLine = /\b(OFF|C\d{1,2}|SBY|A\/L|F\/D|SIM|RS[T7]\d?|TRG|TSIM|DH\d)\b/i.test(l.text);
    if (!_isDutyLine && twoDigitDutyPattern) {
      _isDutyLine = new RegExp(`\\b(${twoDigitDutyPattern})\\b`, 'i').test(l.text);
    }
    if (DATE_LINE_RE.test(l.text) && !/\b(Duty|Dep|Begin|End|Arr)\b/i.test(l.text) && !_isDutyLine) {
      dateLines.push(l);
    } else {
      nonDateLines.push(l);
    }
  }
  let rows = groupRows(nonDateLines);
  // Add date lines back as single-line rows, flagged so the merge pass
  // below can find them precisely.
  for (const dl of dateLines) {
    rows.push({ lines: [dl], y0: dl.y0, y1: dl.y1, yc: dl.yc, h: dl.h, _dateOnly: true });
  }
  rows.sort((a, b) => a.yc - b.yc);

  // Merge each date-only pseudo-row into the NEXT row in reading order: the
  // duty/dep/times content that visually follows a date line belongs to
  // that date. This replaces relying on findClosestDate's absolute-distance
  // search to reunite them later, which could grab the wrong neighbor when
  // two date lines sit close together in dense layouts — confirmed via a
  // real benchmark run 2026-09-21 to scramble row order into
  // non-chronological, duplicated dates. Only merges forward when the next
  // row isn't itself another date-only line or a header; those rarer cases
  // still fall back to findClosestDate's distance search as a safety net.
  //
  // Same-row first, though: in the common layout the date sits on the SAME
  // visual row as its duty/times, and sorting by yc puts it after that row
  // whenever the content's yc is a pixel or two higher. "Next" was then the
  // row BELOW, so the date was glued onto the wrong row — its box spanned two
  // rows (visible in the upload page's row crop) and dates shifted by one
  // row (found 2026-09-29). So a date line joins the neighbouring row it
  // vertically overlaps (same test as groupRows); only a date line that
  // overlaps neither neighbour falls back to the forward merge.
  const overlapsRow = (a, b) => {
    const ov = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0);
    return ov >= 0.5 * Math.min(a.h, b.h);
  };
  const mergeInto = (target, dateRow) => {
    target.lines = [...dateRow.lines, ...target.lines];
    target.y0 = Math.min(target.y0, dateRow.y0);
    target.y1 = Math.max(target.y1, dateRow.y1);
    target.yc = (target.y0 + target.y1) / 2;
    target.h = target.y1 - target.y0;
  };
  const canTake = (r) => r && !r._dateOnly && !isHeaderRow(r);
  const mergedRows = [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (row._dateOnly) {
      const prev = mergedRows[mergedRows.length - 1];
      const next = rows[i + 1];
      const ovPrev = canTake(prev) && !prev._hasDate && overlapsRow(prev, row);
      const ovNext = canTake(next) && overlapsRow(next, row);
      if (ovPrev || ovNext) {
        const dist = (r) => Math.abs(r.yc - row.yc);
        const target = ovPrev && ovNext ? (dist(prev) <= dist(next) ? prev : next) : (ovPrev ? prev : next);
        mergeInto(target, row);
        target._hasDate = true;
        continue;
      }
      if (canTake(next)) {
        mergeInto(next, row);
        next._hasDate = true;
        continue; // date line is now part of `next` — drop the standalone pseudo-row
      }
    }
    mergedRows.push(row);
  }
  rows = mergedRows.sort((a, b) => a.yc - b.yc);
 const heights = lines.map(l => l.h).sort((a, b) => a - b);
  const medH = heights[Math.floor(heights.length / 2)] || 10;
  rows = splitOversizedRows(rows, medH);
  const headerRows = rows.filter(isHeaderRow).sort((a, b) => a.yc - b.yc);
  const deduped = [];
  for (const hr of headerRows) {
    const prev = deduped[deduped.length - 1];
    if (prev && Math.abs(hr.yc - prev.yc) < 1.5 * medH) continue;
    deduped.push(hr);
  }
  if (deduped.length === 0) {
    // No header found: column zones from the calibrated layout clusters / global zones
    const learnedRanges = mergeColumnRanges(pickLayoutClusterRanges(lines, null), getLearnedColumnFallback());
    const parsed = parseContentOnly(lines, rows, learnedRanges || null);
    return {
      ...parsed,
      _parserMeta: buildParserMeta({ colRanges: learnedRanges, parseMode: 'content-only', layoutHintSource: 'learned-fallback' }),
    };
  }

  const firstHeader = getBestHeaderRow(deduped) || deduped[0];
  // firstHeader (best-scoring) is only for column geometry. Rows must be kept
  // from the TOP-most header down: when the planned section's header reads
  // cleaner than the published one, using it as the cutoff dropped every
  // published row (confirmed on "1 (4).jpg": 13 published rows -> 0).
  const topHeader = deduped[0];
  const detectedRanges = computeColumnRanges(firstHeader);
  const layoutRanges = pickLayoutClusterRanges(lines, detectedRanges);
  const colRanges = reconcileColumnRanges(detectedRanges, mergeColumnRanges(layoutRanges, getLearnedColumnFallback()));

  // Section split
  let yPlanned;
  const marker = lines.find(l => PLANNED_MARKER_RE.test(l.text));
  if (marker) yPlanned = marker.yc;
  else if (deduped.length >= 2) yPlanned = deduped[1].yc;

  let publishedUntil = null;
  if (yPlanned == null) {
    const pu = lines.find(l => PUBLISHED_UNTIL_RE.test(l.text));
    if (pu) {
      const m = pu.text.match(PUBLISHED_UNTIL_RE);
      const d = extractDateFromText(m[1]+' '+m[2]+' '+m[3]);
      if (d) publishedUntil = d.date;
    }
  }

  // Cutoff
  let yCutoff = Infinity;
  for (const l of lines) {
    if (BOTTOM_NOISE_RE.test(l.text) && l.yc > topHeader.yc)
      yCutoff = Math.min(yCutoff, l.yc);
  }

  // Pre-pass: build date lookup from date-only rows
  const dateByYc = new Map();
  for (const row of rows) {
    if (row.yc <= topHeader.yc) continue;
    if (row.yc >= yCutoff - CUTOFF_SLACK) continue;
    if (isHeaderRow(row)) continue;
    const allTxt = normalizeRowText(row.lines.map(l => l.text).join(' '));
    const di = extractDateFromText(allTxt);
    if (di && row.lines.length <= 2) {
      // Also extract day from text if not in di
      if (!di.day) {
        const wd = allTxt.match(/\b(Mon|Tue|Wed|Thu|Fri|Sat|Sun)[A-Za-z]*\b/i);
        if (wd) di.day = (wd[1].slice(0,3)).toUpperCase();
      }
      if (!di.day) {
        const wd = allTxt.match(/\b(Mon|Tue|Wed|Thu|Fri|Sat|Sun)[A-Za-z]*\b/i);
        if (wd) di.day = wd[1].slice(0,3).toUpperCase();
      }
      dateByYc.set(row.yc, di);
    }
  }
  const dateEntries = [...dateByYc.entries()].sort((a, b) => a[0] - b[0]);
  // Prefer the nearest date-line AT OR ABOVE this row (natural reading
  // order: a row's date/duty content follows its date line, never precedes
  // it) before considering one below. Plain nearest-by-absolute-distance
  // was picking the wrong neighbor whenever two date lines sat close
  // together (dense layouts), scrambling row order — e.g. a content row
  // between "31 Jan" and "1 Feb" date-lines could get matched to the LATER
  // one just because it happened to be a few px closer, producing dates
  // out of chronological order (found via a real benchmark run 2026-09-21).
  const ABOVE_TOLERANCE = 8; // px slack for a date-line barely below due to OCR box jitter
  function findClosestDate(yc) {
    let bestAbove = null, bestAboveDist = Infinity;
    let bestBelow = null, bestBelowDist = Infinity;
    for (const [dyc, di] of dateEntries) {
      const dist = Math.abs(dyc - yc);
      if (dist >= 30) continue;
      if (dyc <= yc + ABOVE_TOLERANCE) {
        if (dist < bestAboveDist) { bestAboveDist = dist; bestAbove = { yc: dyc, ...di }; }
      } else if (dist < bestBelowDist) {
        bestBelowDist = dist; bestBelow = { yc: dyc, ...di };
      }
    }
    return bestAbove || (bestBelow && { ...bestBelow, below: true });
  }

  // Parse data rows
  const published = [], planned = [];
  let prevDate = null, prevDay = '';
  for (const row of rows) {
    if (row.yc <= topHeader.yc) continue;
    if (row.yc >= yCutoff - CUTOFF_SLACK) continue;
    if (isHeaderRow(row)) continue;
    if (row.lines.some(l => PLANNED_MARKER_RE.test(l.text))) {
      // the section title is not a data row; its "THE" is sometimes its own box
      row.lines = row.lines.filter(l => !PLANNED_MARKER_RE.test(l.text) && !/^[TI]?HE$/i.test(l.text.trim()));
      if (!row.lines.length) continue;
    }
    const inPlanned = yPlanned != null && row.yc > yPlanned;
    const parsed = parseContentRow(row, prevDate, colRanges, prevDay, findClosestDate);
    if (!parsed) continue;
    // Every labeled row has a duty, dep or arr (0 of 6245 without); a row with
    // only a time is a stray fragment (e.g. sidebar "…than 17:30 local time").
    if (!parsed.duty && !parsed.dep && !parsed.arr) continue;
    // Update prevDay from any row that has a day (before skipping date-only rows)
    if (parsed.day) prevDay = parsed.day;
    // Skip date-only rows (pre-extracted date lines that produce empty-duty rows)
    // ...unless the date box also holds the day's only duty ("Wed 26 Feb 20
    // TSIM", "Thu 27 Feb20 RS72"): TSIM/RST2/6TRG days have no other cells, and
    // dropping them also gave the next sectors the previous day (2026-10-07).
    if (row.lines.length === 1 && /\b(Mon|Tue|Wed|Thu|Fri|Sat|Sun)[A-Za-z]*[.,\s]+\d{1,2}\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)/i.test(row.lines[0].text)
      && !dateLineDuty(row.lines[0].text)) continue;
    prevDate = parsed.date;
    let isPlanned = inPlanned;
    if (yPlanned == null && publishedUntil) {
      const a = dateKey(parsed.date), b = dateKey(publishedUntil);
      isPlanned = !!(a && b && (a[0]>b[0]||(a[0]===b[0]&&(a[1]>b[1]||(a[1]===b[1]&&a[2]>b[2])))));
    }
    (isPlanned ? planned : published).push(parsed);
  }
  repairDateSequence(published);
  repairDateSequence(planned, published.length ? dateToKey(published[published.length - 1].date) : null);
  inferMissingArr(published);
  inferMissingArr(planned);
  reconcileAirportChain([published, planned]);
  harmonizeFlightSpacing([...published, ...planned]);
  return {
    published,
    planned,
    _parserMeta: buildParserMeta({ colRanges, parseMode: 'header-driven', layoutHintSource: 'header+cluster-fallback' }),
  };
}

function parseContentOnly(lines, rows, learnedRanges) {
  const marker = lines.find(l => PLANNED_MARKER_RE.test(l.text));
  const yPlanned = marker ? marker.yc : null;
  let publishedUntil = null;
  const pu = lines.find(l => PUBLISHED_UNTIL_RE.test(l.text));
  if (pu) {
    const m = pu.text.match(PUBLISHED_UNTIL_RE);
    publishedUntil = extractDateFromText(m[1]+' '+m[2]+' '+m[3]);
    if (publishedUntil) publishedUntil = publishedUntil.date;
  }
  const colRanges = learnedRanges || null;
  const published = [], planned = [];
  let prevDate = null, prevDay = '';
  for (const row of rows) {
    const parsed = parseContentRow(row, prevDate, colRanges, prevDay);
    if (!parsed) continue;
    prevDate = parsed.date;
    if (parsed.day) prevDay = parsed.day;
    let isPlanned = false;
    if (yPlanned != null) isPlanned = row.yc > yPlanned;
    else if (publishedUntil) {
      const a = dateKey(parsed.date), b = dateKey(publishedUntil);
      isPlanned = !!(a && b && (a[0]>b[0]||(a[0]===b[0]&&(a[1]>b[1]||(a[1]===b[1]&&a[2]>b[2])))));
    }
     (isPlanned ? planned : published).push(parsed);
   }
   repairDateSequence(published);
   repairDateSequence(planned, published.length ? dateToKey(published[published.length - 1].date) : null);
   inferMissingArr(published);
   inferMissingArr(planned);
   reconcileAirportChain([published, planned]);
   return { published, planned };
 }

 /**
  * Analyze extraction quality and determine if VLM fallback should be triggered.
  * Returns: { shouldUseVLM: boolean, confidence: number, reason: string }
  */
 export function analyzeExtractionQuality(result) {
   const allRows = [...(result.published || []), ...(result.planned || [])];
   if (allRows.length === 0) {
     return { shouldUseVLM: true, confidence: 0, reason: 'No rows extracted' };
   }

   // Calculate average confidence
   const avgConfidence = allRows.reduce((s, r) => s + (r._confidence || 0.5), 0) / allRows.length;
   
   // Count low-confidence rows
   const lowConfRows = allRows.filter(r => (r._confidence || 0.5) < 0.5).length;
   const lowConfRatio = lowConfRows / allRows.length;

   // Count rows with critical field failures
   const criticalFailures = allRows.filter(r => 
     (r._lowConfidenceFields || []).some(f => ['date', 'duty', 'times'].includes(f))
   ).length;
   const criticalFailureRatio = criticalFailures / allRows.length;

   // Determine if VLM fallback is needed
   let shouldUseVLM = false;
   let reason = '';

   if (allRows.length < 5) {
     shouldUseVLM = true;
     reason = `Too few rows extracted (${allRows.length})`;
   } else if (avgConfidence < 0.45) {
     shouldUseVLM = true;
     reason = `Low average confidence (${(avgConfidence * 100).toFixed(0)}%)`;
   } else if (lowConfRatio > 0.3) {
     shouldUseVLM = true;
     reason = `${Math.round(lowConfRatio * 100)}% of rows have low confidence`;
   } else if (criticalFailureRatio > 0.2) {
     shouldUseVLM = true;
     reason = `${Math.round(criticalFailureRatio * 100)}% of rows have critical field failures`;
   }

   return { shouldUseVLM, confidence: avgConfidence, reason };
 }

 /**
  * Clean extraction result to remove internal confidence tracking for API output.
  */
 export function cleanExtractionResult(result) {
   const clean = (rows) => rows.map(r => {
      const { _confidence, _fieldConfidences, _lowConfidenceFields, _dateFromText, _wdRead, _hasDateCell, ...cleaned } = r;
     return cleaned;
   });

   return {
     published: clean(result.published || []),
     planned: clean(result.planned || []),
      ...(result?._parserMeta ? { _parserMeta: result._parserMeta } : {}),
   };
 }

