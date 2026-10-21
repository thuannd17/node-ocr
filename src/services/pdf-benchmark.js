/**
 * The parser's reading of a text file (PDF, CSV, Excel, TXT), as /label Auto-fill shows it
 * (parsePdfFile), and comparing rows with a label ({ published: [rows], planned: [rows] }),
 * each table on its own (compareRows): rows are paired with the image benchmark's alignRows
 * (same 7 base fields), then all PDF fields are compared exactly (whitespace-normalized).
 */
import { alignRows } from './benchmark.js';
import { readPdfText, hasTextLayer } from './pdf-text.js';
import { parseNetlinePdf } from './pdf-roster-parser.js';
import { ocrPdfPages, ocrPdfAsImage } from './pdf-ocr.js';
import { parseRoster, cleanExtractionResult } from './roster-parser.js';

export const PDF_FIELDS = ['date', 'day', 'dc', 'duty', 'registration', 'dep', 'begin', 'takeoff', 'landing', 'end', 'arr', 'ac', 'crew', 'info'];

const norm = (v) => String(v ?? '').trim().replace(/\s+/g, ' ');

/**
 * Text layer when there is one; an image-only PDF goes through OCR (services/pdf-ocr.js):
 * read as a duty plan, else, when that finds no rows, as a roster picture (a roster
 * screen printed to PDF) by the image parser (services/roster-parser.js), readMode 'ocr-image'.
 */
export async function parsePdfFile(filePath) {
  const pages = await readPdfText(filePath);
  if (hasTextLayer(pages)) return { ...parseNetlinePdf(pages), readMode: 'text' };
  const plan = { ...parseNetlinePdf(await ocrPdfPages(filePath)), readMode: 'ocr' };
  if (plan.published.length + plan.planned.length) return plan;
  const { lines } = await ocrPdfAsImage(filePath);
  const roster = cleanExtractionResult(parseRoster(lines));
  if (!(roster.published?.length || roster.planned?.length)) return plan;
  return {
    format: 'roster-image', period: plan.period, notices: plan.notices || [], recognized: true, readMode: 'ocr-image',
    published: (roster.published || []).map(r => toPdfRow(r)), planned: (roster.planned || []).map(r => toPdfRow(r)),
  };
}

/** A row of the image parser with every PDF field. */
const toPdfRow = (r) => Object.fromEntries(PDF_FIELDS.map(f => [f, String(r?.[f] ?? '')]));

export function compareRows(predRows = [], expRows = []) {
  const perField = Object.fromEntries(PDF_FIELDS.map(f => [f, { matches: 0, total: 0 }]));
  const errors = [];
  let rowMatches = 0;
  for (const { pred, exp } of alignRows(predRows, expRows)) {
    if (!exp) { errors.push({ kind: 'extra', pred }); continue; }
    let ok = !!pred;
    for (const f of PDF_FIELDS) {
      perField[f].total += 1;
      const same = !!pred && norm(pred[f]) === norm(exp[f]);
      if (same) perField[f].matches += 1;
      else { ok = false; if (pred) errors.push({ kind: 'field', field: f, pred: norm(pred[f]), exp: norm(exp[f]), date: exp.date, duty: exp.duty }); }
    }
    if (!pred) errors.push({ kind: 'missing', exp });
    if (ok) rowMatches += 1;
  }
  return { rowMatches, rowTotal: expRows.length, predCount: predRows.length, perField, errors };
}

export const PDF_SECTIONS = ['published', 'planned'];
