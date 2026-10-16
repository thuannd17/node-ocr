#!/usr/bin/env node
/**
 * Training data for a learned roster extractor: every word of the labeled PDFs,
 * with its position and the field / row it belongs to.
 *
 *   node scripts/build-pdf-token-data.mjs [--out exports/pdf-tokens]
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
import { readPdfText } from '../services/pdf-text.js';
import { parseNetlinePdf } from '../services/pdf-roster-parser.js';
import { compareRows, PDF_SECTIONS } from '../services/pdf-benchmark.js';
import { wordsOf, plainTokens } from '../services/pdf-tokens.js';
import { alignLabel } from '../services/pdf-label-align.js';
import { listLabels, dataFile, labelFile } from '../utils/data-files.js';

const args = process.argv.slice(2);
const outDir = path.resolve(args[args.indexOf('--out') + 1] && args.includes('--out') ? args[args.indexOf('--out') + 1] : 'exports/pdf-tokens');
const pdfDir = path.resolve('fake-data');
const labelsDir = path.resolve('labels');
fs.mkdirSync(outDir, { recursive: true });

const CORE = ['duty', 'dc', 'registration', 'dep', 'arr', 'begin', 'end', 'ac', 'hotel'];
const summary = { files: [], skipped: [], aligned: [], tokens: 0, tagged: 0, byField: {}, conflicts: 0, coverage: {} };
for (const f of CORE) summary.coverage[f] = { withToken: 0, total: 0 };

const names = listLabels(labelsDir, 'pdf').filter(n => fs.existsSync(dataFile(pdfDir, n)));

for (const name of names) {
  const label = JSON.parse(fs.readFileSync(labelFile(labelsDir, name), 'utf8'));
  const pages = await readPdfText(dataFile(pdfDir, name));
  if (!pages.some(p => p.items.length)) { summary.skipped.push({ file: name, reason: 'no text layer (image-only PDF)' }); continue; }
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
        const hit = hits[0];
        let field = hit ? hit.field : 'O';
        // Info of a row made from a C/I or C/O time column ("Duty Hrs" of a roster report) is its own field: it sits on another event's line.
        const ciCo = field === 'info' && ciCoRows.get(`${hit.section}|${hit.index}`);
        if (ciCo) field = `${ciCo}_info`;
        // "GYE / JFK", "*BCN - BIO" (one PDF item): its words are the departure and the arrival, as a label would mark them.
        if (field === 'route') field = tk.t === '/' || tk.t === '-' ? 'O' : tk.off === 0 ? 'dep' : 'arr';
        // "A07:12 - A08:31" (one PDF item): begin, then end
        if (field === 'times') field = tk.t === '-' ? 'O' : tk.off === 0 ? 'begin' : 'end';
        tk.field = field;
        if (hit && field !== 'O') { tk.section = hit.section; tk.row = hit.index; }
      }
    }
  }
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
    (result[sec] || []).forEach((r, i) => {
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
console.log(`Rows: ${summary.files.reduce((s, f) => s + f.rows, 0)}, words: ${summary.tokens}, tagged: ${summary.tagged} (${pct(summary.tagged, summary.tokens)}%), words hit by 2 fields: ${summary.conflicts}`);
console.log(`Words per field: ${Object.entries(summary.byField).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(', ')}`);
console.log(`Coverage (label value has a tagged word): ${CORE.map(f => `${f} ${pct(summary.coverage[f].withToken, summary.coverage[f].total)}% of ${summary.coverage[f].total}`).join(', ')}`);
console.log(`Written to ${path.relative(process.cwd(), outDir)}/`);
