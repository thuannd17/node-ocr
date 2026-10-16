/**
 * Scores the PDF duty-plan parser against verified labels in labels/pdf/
 * ({ published: [rows], planned: [rows] }), each table on its own.
 * Rows are paired with the image benchmark's alignRows (same 7 base fields),
 * then all 12 PDF fields are compared exactly (whitespace-normalized).
 */
import fs from 'node:fs';
import { alignRows } from './benchmark.js';
import { readPdfText, hasTextLayer } from './pdf-text.js';
import { parseNetlinePdf } from './pdf-roster-parser.js';
import { ocrPdfPages, ocrPdfAsImage } from './pdf-ocr.js';
import { parseRoster, cleanExtractionResult } from './roster-parser.js';
import { listLabels, dataFile, labelFile } from '../utils/data-files.js';

export const PDF_FIELDS = ['date', 'day', 'hotel', 'dc', 'duty', 'registration', 'dep', 'begin', 'end', 'arr', 'ac', 'crew', 'info'];

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

export async function runPdfBenchmark({ pdfDir, labelsDir }) {
  // pdfDir / labelsDir = the fake-data/ and labels/ roots; PDFs sit in their pdf/ subfolders
  const files = listLabels(labelsDir, 'pdf').filter(n => fs.existsSync(dataFile(pdfDir, n)));
  const perField = Object.fromEntries(PDF_FIELDS.map(f => [f, { matches: 0, total: 0 }]));
  const results = [];
  let rowMatches = 0, rowTotal = 0;
  for (const name of files) {
    const label = JSON.parse(fs.readFileSync(labelFile(labelsDir, name), 'utf8'));
    let pred;
    try {
      pred = await parsePdfFile(dataFile(pdfDir, name));
    } catch (e) {
      // e.g. an image-only PDF while the OCR server is down: its rows count as wrong, the run goes on
      const total = PDF_SECTIONS.reduce((n, sec) => n + (label[sec] || []).length, 0);
      rowTotal += total;
      for (const sec of PDF_SECTIONS) for (const _ of label[sec] || []) for (const f of PDF_FIELDS) perField[f].total += 1;
      results.push({ file: name, rowMatches: 0, rowTotal: total, predCount: 0, sections: {}, errors: [], error: e.message });
      continue;
    }
    const sections = {};
    let fileMatches = 0, fileTotal = 0, predCount = 0;
    const errors = [];
    for (const sec of PDF_SECTIONS) {
      const cmp = compareRows(pred[sec] || [], label[sec] || []);
      sections[sec] = { rowMatches: cmp.rowMatches, rowTotal: cmp.rowTotal, predCount: cmp.predCount };
      fileMatches += cmp.rowMatches;
      fileTotal += cmp.rowTotal;
      predCount += cmp.predCount;
      for (const f of PDF_FIELDS) {
        perField[f].matches += cmp.perField[f].matches;
        perField[f].total += cmp.perField[f].total;
      }
      errors.push(...cmp.errors.map(e => ({ section: sec, ...e })));
    }
    rowMatches += fileMatches;
    rowTotal += fileTotal;
    results.push({ file: name, rowMatches: fileMatches, rowTotal: fileTotal, predCount, sections, errors });
  }
  return {
    labeledCount: files.length,
    rowMatches,
    rowTotal,
    rowExactMatchRate: rowTotal ? rowMatches / rowTotal : 0,
    perField,
    files: results,
  };
}
