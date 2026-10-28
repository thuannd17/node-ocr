#!/usr/bin/env node
/**
 * Training data for a learned roster extractor: every word of the labeled PDFs,
 * with its position and the field / row it belongs to.
 *
 *   node scripts/build-pdf-token-data.mjs [--out <work>/exports/pdf-tokens] [--only <name part>,...]
 *
 * For each PDF labeled in labels/pdf/ with a text layer: when the parser's rows equal
 * the verified label exactly, the parser's trace says which word went into
 * which row and field (services/pdf-roster-parser.js, trace mode). Otherwise (a
 * format the parser misreads, fixed by hand in /label) the label's values are
 * found among the words (services/pdf-label-align.js). Image-only PDFs are skipped.
 *
 * Output: <out>/<file>.json { file, source: parser|label, format, period, pages:
 * [{ width, height, tokens: [{ t, x, y, w, h, field, section, row }] }] } where
 * field is one of date, duty, dc, registration, dep, arr, begin, end, ac, hotel,
 * info, ci, co, co_info, ci_info, "O" (not part of any row) or "?" (unsure: left
 * out of training), and row is the row's index in its section.
 * Plus <out>/summary.json.
 */
import fs from 'node:fs';
import path from 'node:path';
import { readPdfText, hasTextLayer } from '../services/pdf-text.js';
import { parseNetlinePdf, hotelFromEvent } from '../services/pdf-roster-parser.js';
import { compareRows, PDF_SECTIONS } from '../services/pdf-benchmark.js';
import { wordsOf, plainTokens } from '../services/pdf-tokens.js';
import { alignLabel } from '../services/pdf-label-align.js';
import { listReviewedLabels, dataFile, labelFile, DATA_ROOT, LABELS_ROOT } from '../utils/data-files.js';
import { syncForScript } from '../services/media-client.js';
import { EXPORTS_DIR } from '../utils/paths.js';

// The roster data lives in MinIO: bring its local mirror (DATA_ROOT / LABELS_ROOT) up to date.
await syncForScript();

const args = process.argv.slice(2);
const outDir = path.resolve(args[args.indexOf('--out') + 1] && args.includes('--out') ? args[args.indexOf('--out') + 1] : path.join(EXPORTS_DIR, 'pdf-tokens'));
const pdfDir = DATA_ROOT;
const labelsDir = LABELS_ROOT;
fs.mkdirSync(outDir, { recursive: true });

const TIME_FIELDS = new Set(['begin', 'end', 'ci', 'co', 'takeoff', 'landing']);
const CORE = ['duty', 'dc', 'registration', 'dep', 'arr', 'begin', 'takeoff', 'landing', 'end', 'ac', 'hotel'];
const summary = { files: [], skipped: [], aligned: [], tokens: 0, tagged: 0, byField: {}, conflicts: 0, coverage: {}, suspect: [] };
for (const f of CORE) summary.coverage[f] = { withToken: 0, total: 0 };

// (--only: just the files whose names have one of these parts, to check a change on a few)
const only = args.includes('--only') ? String(args[args.indexOf('--only') + 1] || '').split(',').filter(Boolean) : null;
const names = listReviewedLabels(labelsDir, 'pdf').filter(n => fs.existsSync(dataFile(pdfDir, n)) && (!only || only.some(o => n.includes(o))));

// Fields read from a cell's words as they are (not built from several cells): a word of one is in the label's value.
const CELL_FIELDS = new Set(['duty', 'ac', 'registration', 'dc']);
// Fields a word missed by the parser's trace may still belong to (date, day, times are
// always traced; these are the values the parser builds from several cells).
const FILL_FIELDS = ['info', 'crew', 'registration', 'ac', 'dc'];
// A word the label alignment left "?" (unsure: the same value on many lines) may be any field but the date,
// once its line shows which row it is on.
const UNSURE_FILL_FIELDS = [...FILL_FIELDS, 'duty', 'dep', 'arr', 'begin', 'end'];
const valueWords = (v) => String(v || '').split(/[\s\[\]]+/).map(w => w.replace(/^[,;]+|[,;]+$/g, '')).filter(Boolean);

/**
 * The parser's trace does not record every word that went into a row: a count it
 * turned into "[Landing Day: 1]", a name it joined into "[PIC - NAME]". Left "O",
 * those words teach the model they are noise and the assembler never sees them.
 * A word still "O" on a line that holds exactly one traced row is given the field
 * of that row's label whose value has it as a word (only when exactly one field does),
 * and only while the label has that word more often than the row already has it
 * tagged: "1:04" printed under Block, IFR and Day is written once ("[Block: 1:04]").
 * Returns how many words were filled in.
 */
function fillFromLabel(wordPages, label) {
  let filled = 0;
  const used = new Map(); // "<section>|<row>|<field>|<word>" -> words tagged so (all pages)
  const strip = (t) => t.replace(/^[,;]+|[,;]+$/g, '');
  for (const page of wordPages) {
    for (const o of page.tokens) {
      if (o.row == null || o.field === 'O' || o.field === '?') continue;
      const k = `${o.section}|${o.row}|${o.field}|${strip(o.t)}`;
      used.set(k, (used.get(k) || 0) + 1);
    }
  }
  for (const page of wordPages) {
    // rows present on each line (by y, 2 pt tolerance), indexed by whole points
    const byY = new Map();
    for (const o of page.tokens) {
      if (o.row == null || o.field === 'O' || o.field === '?') continue;
      const k = Math.round(o.y);
      if (!byY.has(k)) byY.set(k, []);
      byY.get(k).push(o);
    }
    const rowsAt = (tk) => {
      const out = new Set();
      for (let k = Math.round(tk.y) - 2; k <= Math.round(tk.y) + 2; k++) {
        for (const o of byY.get(k) || []) if (Math.abs(o.y - tk.y) < 2) out.add(`${o.section}|${o.row}`);
      }
      return out;
    };
    for (const tk of page.tokens) {
      if ((tk.field !== 'O' && tk.field !== '?') || !tk.t.trim()) continue;
      const rows = rowsAt(tk);
      if (rows.size !== 1) continue;
      const [section, idx] = [...rows][0].split('|');
      const row = label[section]?.[Number(idx)];
      if (!row) continue;
      const word = strip(tk.t);
      // (separators: "-" in "CP - PIC - 1096" is written by the label's own format, not read)
      if (!word || /^[-–—/+|.:]+$/.test(word)) continue;
      const fields = (tk.field === '?' ? UNSURE_FILL_FIELDS : FILL_FIELDS).filter(f => valueWords(row[f]).includes(word));
      if (fields.length !== 1) continue;
      const k = `${section}|${idx}|${fields[0]}|${word}`;
      if ((used.get(k) || 0) >= valueWords(row[fields[0]]).filter(w => w === word).length) continue;
      used.set(k, (used.get(k) || 0) + 1);
      tk.field = fields[0]; tk.section = section; tk.row = Number(idx);
      filled += 1;
    }
  }
  return filled;
}

/**
 * A check-out column printed on every leg of a duty ("Checkout" of an activity list) while the label has
 * one C/O, after the duty's last leg: the column's words on the other legs were left "O", so the same
 * column was "co" on one line and noise on the next, and the model guessed (often "end", the column
 * beside it). They are "co" too (no row of their own): the model learns the column and the assembler
 * keeps a duty's last C/O (conventions.coOnce). A word counts when it stands where a "co" word of the
 * page stands (left or right edge) and is written like one ("25NOV11", "18:59"), by the words of a flight
 * whose duty has its C/O later in the label (not a day off's or a standby's line, nor "End Rest 03:35").
 * Returns how many words were so tagged.
 */
/**
 * Words tagged with a field whose value in their row does not hold them: a dash beside a flight
 * number tagged "duty", a cell's label word tagged "ac". The tagger learns such words as values
 * of every layout, so scripts/model-train.mjs stops before training when a file has many.
 * Only the fields read from one cell as printed are checked (built values, info, times are not).
 * rowsOf(section) -> the rows the words' row indexes point into. Returns { count, examples }.
 */
const CHECKED_FIELDS = new Set(['duty', 'dc', 'registration', 'ac', 'dep', 'arr']);
function suspectWords(wordPages, rowsOf) {
  const out = { count: 0, examples: {} };
  const rows = Object.fromEntries(PDF_SECTIONS.map(sec => [sec, (rowsOf(sec) || []).map(hotelFromEvent)]));
  for (const page of wordPages) {
    for (const tk of page.tokens) {
      if (!CHECKED_FIELDS.has(tk.field) || tk.row == null) continue;
      const row = rows[tk.section]?.[tk.row];
      if (!row) continue;
      const value = String(row[tk.field] || '').toLowerCase().replace(/\s+/g, '');
      // ("FR 6652" for "FR6652", "*BCN" for "BCN", "(AD4064)": the word's letters and digits; a mark alone as it is;
      // a word holding the value, "MEL-SYD" for dep MEL, "SK0449-20250526-GOT-CPH" for duty SK0449)
      const word = /[\p{L}\p{N}]/u.test(tk.t) ? tk.t.toLowerCase().replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '') : tk.t;
      if (value.includes(word) || (value.length >= 2 && word.includes(value))) continue;
      out.count += 1;
      const k = `${tk.t} as ${tk.field}`;
      out.examples[k] = (out.examples[k] || 0) + 1;
    }
  }
  return out;
}

function fillCheckoutColumn(wordPages, label) {
  // flights followed by a C/O before the next C/I: "<section>|<row>"
  const legs = new Set();
  for (const sec of PDF_SECTIONS) {
    let pending = [];
    for (const [i, r] of (label[sec] || []).entries()) {
      if (r.duty === 'C/I') pending = [];
      else if (r.duty === 'C/O') { pending.forEach(k => legs.add(k)); pending = []; }
      else if (r.dep && r.arr && r.dep !== r.arr) pending.push(`${sec}|${i}`);
    }
  }
  let filled = 0;
  const shape = (t) => t.replace(/[A-Za-z]/g, 'A').replace(/\d/g, '9');
  for (const page of wordPages) {
    const co = page.tokens.filter(t => t.field === 'co');
    if (co.length < 2) continue;
    const shapes = new Set(co.map(t => shape(t.t)));
    const duties = page.tokens.filter(t => t.field === 'duty' && t.row != null);
    for (const tk of page.tokens) {
      if (tk.field !== 'O' || !shapes.has(shape(tk.t))) continue;
      if (!co.some(c => Math.abs(c.x - tk.x) < 3 || Math.abs(c.x + c.w - tk.x - tk.w) < 3)) continue;
      // (the duty nearest to it, a leg's)
      const near = duties.reduce((a, d) => (!a || Math.abs(d.y - tk.y) < Math.abs(a.y - tk.y) ? d : a), null);
      if (!near || Math.abs(near.y - tk.y) >= 20 || !legs.has(`${near.section}|${near.row}`)) continue;
      // (and its line holds words of that leg: "02NOV11 ... 02:30", not a line of its own, "End Rest ==> 00:52")
      if (!page.tokens.some(o => Math.abs(o.y - tk.y) < 2 && o.row === near.row && o.section === near.section)) continue;
      tk.field = 'co';
      filled += 1;
    }
  }
  return filled;
}

for (const [k, name] of names.entries()) {
  console.log(`  [PDF ${k + 1}/${names.length}] ${name}`); // (progress for the /models page)
  const label = JSON.parse(fs.readFileSync(labelFile(labelsDir, name), 'utf8'));
  const pages = await readPdfText(dataFile(pdfDir, name));
  // (a picture with a few stray characters as text counts as one: scripts/build-image-token-data.mjs reads it by OCR)
  if (!hasTextLayer(pages)) { summary.skipped.push({ file: name, reason: 'no text layer (image-only PDF)' }); continue; }
  const result = parseNetlinePdf(pages, { trace: true });

  // Where the parser gives exactly the verified label, its trace says which word is what.
  // Elsewhere (a format the parser misreads, fixed by hand in /label) the label is matched to the words.
  const diffs = PDF_SECTIONS.map(sec => {
    const cmp = compareRows(result[sec] || [], label[sec] || []);
    return cmp.rowMatches !== cmp.rowTotal || cmp.predCount !== cmp.rowTotal ? `${sec} ${cmp.rowMatches}/${cmp.rowTotal} (parser ${cmp.predCount})` : null;
  }).filter(Boolean);
  const wordPages = wordsOf(pages);
  let source = 'parser';
  if (diffs.length) {
    source = 'label';
    const st = alignLabel(wordPages, label);
    summary.aligned.push({ file: name, parser: diffs.join(', '), rows: `${st.anchored}/${st.rows}`, missing: st.missing });
  } else {
    // Trace entries by PDF item.
    const byItem = new Map();
    for (const e of result.trace) {
      if (e.index < 0) continue; // a row that was dropped later
      if (!byItem.has(e.item)) byItem.set(e.item, []);
      byItem.get(e.item).push(e);
    }
    const ciCoRows = new Map(result.trace.filter(e => e.field === 'ci' || e.field === 'co').map(e => [`${e.section}|${e.index}`, e.field]));
    for (const page of wordPages) {
      for (const tk of page.tokens) {
        // A split item ("2220 !0054+1 OSL") has entries for its parts (off/len).
        const hits = (byItem.get(tk.item) || []).filter(e => e.off == null || (tk.off >= e.off && tk.off < e.off + e.len));
        if (new Set(hits.map(e => `${e.field}|${e.section}|${e.index}`)).size > 1) summary.conflicts += 1;
        // A cell marked for several fields ("01MAR23 17:01" is the row's date and its begin): each word the one it is,
        // a time the time field, a date the date (else every word of the cell was "date" and no word ever "begin").
        // (or a piece of one printed apart, "15" ":" "40": a number of 1-2 digits by a ":", or the ":")
        const k = page.tokens.indexOf(tk), near = (o) => o && Math.abs(o.y - tk.y) < 2 && Math.abs(o.x - tk.x) < 30;
        const piece = (tk.t === ':' && near(page.tokens[k - 1]) && near(page.tokens[k + 1]))
          || (/^\d{1,2}$/.test(tk.t) && ((near(page.tokens[k + 1]) && page.tokens[k + 1].t === ':') || (near(page.tokens[k - 1]) && page.tokens[k - 1].t === ':')));
        const isTime = piece || (/^[AE]?!?\d{1,2}:?\d{2}(:\d{2})?([+-]\d)?$/.test(tk.t) && /:|!|^\d{4}/.test(tk.t));
        const hit = (isTime && hits.find(e => TIME_FIELDS.has(e.field))) || (!isTime && hits.find(e => e.field === 'date' && /\d/.test(tk.t))) || hits[0];
        let field = hit ? hit.field : 'O';
        // Info of a row made from a C/I or C/O time column ("Duty Hrs" of a roster report) is its own field: it sits on another event's line.
        const ciCo = field === 'info' && ciCoRows.get(`${hit.section}|${hit.index}`);
        if (ciCo) field = `${ciCo}_info`;
        // A cell the parser read whole for one value ("FLT - XK150 - 320": the duty XK150, the aircraft 320):
        // each word the field of its row that holds it, a word no field holds ("FLT", the dashes) none.
        // (so too a mark in a cell of its own the parser joined to the value, "AD4064" "-": no part of duty "AD4064")
        if (CELL_FIELDS.has(field)) {
          const row = result[hit.section]?.[hit.index];
          const holds = (f, w = tk.t) => String(row?.[f] || '').split(/\s+/).includes(w);
          const cell = page.tokens.filter(o => o.item === tk.item);
          if (row && !holds(field) && (cell.some(o => o !== tk && holds(field, o.t)) || !/[\p{L}\p{N}]/u.test(tk.t))) field = [...CELL_FIELDS].find(f => holds(f)) || 'O';
        }
        // "GYE / JFK", "*BCN - BIO" (one PDF item): its words are the departure and the arrival, as a label would mark them.
        // ("ORY-FAO (FGZHP)": one word for both airports, a route; the aircraft's registration in brackets)
        if (field === 'route') field = /^[A-Z]{3,4}[-/][A-Z]{3,4}$/.test(tk.t) ? 'route' : /^\([A-Z0-9-]+\)$/.test(tk.t) ? 'registration'
          : tk.t === '/' || tk.t === '-' ? 'O' : tk.off === 0 ? 'dep' : 'arr';
        // (a time cell's mark with no digit, ">>>" for "goes on": no part of the time; the ":" of "15" ":" "40" is)
        if (TIME_FIELDS.has(field) && !/[\d:]/.test(tk.t)) field = 'O';
        // "A07:12 - A08:31" (one PDF item): begin, then end
        if (field === 'times') field = tk.t === '-' ? 'O' : tk.off === 0 ? 'begin' : 'end';
        tk.field = field;
        if (hit && field !== 'O') { tk.section = hit.section; tk.row = hit.index; }
      }
    }
  }
  // (both sources: the trace and the label alignment each miss words of composed values)
  summary.filledIn = (summary.filledIn || 0) + fillFromLabel(wordPages, label);
  summary.checkoutColumn = (summary.checkoutColumn || 0) + fillCheckoutColumn(wordPages, label);
  // A dash standing apart from the other words of its value ("FR" ... "-", the empty cell beside it the parser joined
  // to the activity) is no part of it; a dash among them ("CP - PIC - 1096") or alone ("--", a day off) is.
  for (const page of wordPages) {
    for (const tk of page.tokens) {
      if (!/^[-–—]+$/.test(tk.t) || tk.field === 'O' || tk.row == null) continue;
      const same = page.tokens.filter(o => o !== tk && o.field === tk.field && o.row === tk.row && o.section === tk.section && Math.abs(o.y - tk.y) < 3);
      const gap = (o) => (o.x > tk.x ? o.x - (tk.x + tk.w) : tk.x - (o.x + o.w));
      if (same.length && Math.min(...same.map(gap)) > 25) { tk.field = 'O'; delete tk.row; delete tk.section; }
    }
  }
  const suspect = suspectWords(wordPages, sec => (source === 'parser' ? result[sec] : label[sec]));
  const checked = wordPages.reduce((n, p) => n + p.tokens.filter(t => CHECKED_FIELDS.has(t.field)).length, 0);
  if (suspect.count) summary.suspect.push({ file: name, words: suspect.count, of: checked, examples: Object.entries(suspect.examples).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([k, n]) => `"${k}" ${n}`) });
  const outPages = plainTokens(wordPages);
  for (const page of outPages) {
    for (const tk of page.tokens) {
      summary.tokens += 1;
      if (tk.field !== 'O' && tk.field !== '?') summary.tagged += 1;
      summary.byField[tk.field] = (summary.byField[tk.field] || 0) + 1;
    }
  }

  // Coverage: a label row's non-empty core field should have at least one tagged token.
  if (source === 'parser') {
  const tagged = new Set(outPages.flatMap(p => p.tokens.filter(t => t.field !== 'O').map(t => `${t.section}|${t.row}|${t.field}`)));
  for (const sec of PDF_SECTIONS) {
    (result[sec] || []).map(hotelFromEvent).forEach((r, i) => { // hotel nights as the words are tagged
      for (const f of CORE) {
        if (!r[f]) continue;
        // C/I and C/O rows of a roster report share the airport printed on the activity line.
        if (result.format === 'crew-roster-report' && (r.duty === 'C/I' || r.duty === 'C/O') && (f === 'dep' || f === 'arr')) continue;
        summary.coverage[f].total += 1;
        // Other words that carry the value: "GYE / JFK" (route), a roster report's C/I / C/O time, its hotel name.
        const ciCo = r.duty === 'C/I' ? 'ci' : r.duty === 'C/O' ? 'co' : '';
        const via = f === 'dep' || f === 'arr' ? 'route'
          : f === 'duty' ? ciCo || (r.duty === 'H' ? 'hotel' : '')
            : f === 'begin' || f === 'end' ? ciCo : '';
        if (tagged.has(`${sec}|${i}|${f}`) || (via && tagged.has(`${sec}|${i}|${via}`))) summary.coverage[f].withToken += 1;
      }
    });
  }
  }

  fs.writeFileSync(path.join(outDir, `${name}.json`), JSON.stringify({ file: name, source, format: source === 'parser' ? result.format : 'unknown', period: result.period, notices: result.notices, pages: outPages }));
  summary.files.push({ file: name, format: result.format, rows: result.published.length + result.planned.length, tokens: outPages.reduce((s, p) => s + p.tokens.length, 0) });
}

fs.writeFileSync(path.join(outDir, 'summary.json'), JSON.stringify(summary, null, 2));
const pct = (a, b) => (b ? (100 * a / b).toFixed(1) : '-');
console.log(`Files used: ${summary.files.length}, skipped: ${summary.skipped.length}`);
for (const s of summary.skipped) console.log(`  skipped ${s.file}: ${s.reason}`);
for (const a of summary.aligned) console.log(`  from the label (parser differs: ${a.parser}): ${a.file}, rows found ${a.rows}${Object.keys(a.missing).length ? `, values not found ${JSON.stringify(a.missing)}` : ''}`);
const byFormat = {};
for (const f of summary.files) byFormat[f.format] = (byFormat[f.format] || 0) + 1;
console.log(`Formats: ${Object.entries(byFormat).map(([k, v]) => `${k} ${v}`).join(', ')}`);
console.log(`Rows: ${summary.files.reduce((s, f) => s + f.rows, 0)}, words: ${summary.tokens}, tagged: ${summary.tagged} (${pct(summary.tagged, summary.tokens)}%), words hit by 2 fields: ${summary.conflicts}, filled in from the label: ${summary.filledIn || 0}`);
console.log(`Words per field: ${Object.entries(summary.byField).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(', ')}`);
console.log(`Coverage (label value has a tagged word): ${CORE.map(f => `${f} ${pct(summary.coverage[f].withToken, summary.coverage[f].total)}% of ${summary.coverage[f].total}`).join(', ')}`);
for (const x of [...summary.suspect].sort((a, b) => b.words - a.words).slice(0, 15)) console.log(`  words not in their row's value: ${x.file} ${x.words} of ${x.of} (${x.examples.join(', ')})`);
console.log(`Written to ${path.relative(process.cwd(), outDir)}/`);
