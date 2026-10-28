/**
 * Rosters exported as text: CSV, Excel (XLS/XLSX) and plain text (TXT). They
 * have no page to look at, so they are laid out the way a monospace printout
 * of them would look and returned as the same pages as services/pdf-text.js:
 * everything after that (the learned model, the parser, labels, training,
 * benchmark) treats them like a PDF with a text layer.
 *
 *   readTableText(file) -> [{ page, width, height, items: [{ text, x, y, w, h }] }]
 *     CSV / XLS / XLSX: one page per sheet, one item per non-empty cell; columns
 *       are as wide as their longest cell, rows CHAR_H apart.
 *     TXT: one page; a line with tabs is split into cells like a CSV, any other
 *       line keeps its character columns (fixed-width reports) and is split
 *       into items at runs of 2+ spaces, as a PDF splits its text.
 *   previewHtml(file) -> HTML page showing the file (for the /label and /roster preview)
 */
import fs from 'node:fs';
import path from 'node:path';
import * as XLSX from 'xlsx';

export const TABLE_EXTS = ['csv', 'xls', 'xlsx', 'txt'];

const CHAR_W = 6; // points per character, like a 10 pt monospace font
const CHAR_H = 12;
const MARGIN = 20;
const COL_GAP = 2; // characters between spreadsheet columns

/** Text of a file: UTF-8 (BOM dropped), else Windows-1252 (Excel's "CSV" on Windows); stray NULs dropped. */
function decode(buf) {
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(buf).replace(/^﻿/, '');
  } catch {
    text = new TextDecoder('windows-1252').decode(buf);
  }
  return text.replaceAll(String.fromCharCode(0), '');
}

const pad2 = (n) => String(n).padStart(2, '0');

/**
 * What a cell shows. Excel dates and times are written day first ("31/07/2024",
 * "06:35"), like the rosters print them, whatever the sheet's own date format.
 */
function cellText(cell) {
  if (!cell || cell.v == null) return '';
  // A date cell whose file keeps its own text for it ("12/01/25" over a serial that formats as 11/30/25: an
  // export that wrote the typed text and a shifted date): that text, as the sheet shows it.
  if (cell.t === 'n' && cell.z && cell.w && XLSX.SSF.is_date(cell.z) && cell.w !== XLSX.SSF.format(cell.z, cell.v)) return cellLines(String(cell.w));
  if (cell.t === 'n' && cell.z && XLSX.SSF.is_date(cell.z)) {
    // to the nearest minute, as Excel shows it (0.2743 is 06:35, not 06:34:59)
    const mins = Math.round(cell.v * 1440);
    const d = XLSX.SSF.parse_date_code(Math.floor(mins / 1440));
    if (d) {
      const time = `${pad2(Math.floor((mins % 1440) / 60))}:${pad2(mins % 60)}`;
      if (mins < 1440) return time; // a time without a date
      const date = `${pad2(d.d)}/${pad2(d.m)}/${d.y}`;
      return mins % 1440 ? `${date} ${time}` : date;
    }
  }
  return cellLines(String(cell.w ?? cell.v));
}

/** A cell's lines (a multi-leg day holds "KL1826\nKL1943"), each with its spaces collapsed. */
const cellLines = (text) => text.split(/\r\n|\r|\n/).map(l => l.replace(/\s+/g, ' ').trim()).filter(Boolean).join('\n');

/**
 * What a file really holds, whatever its name says: 'excel' (an XLSX zip or an
 * old XLS), 'text', or 'binary' (anything else: a PDF, a picture, a broken file).
 * An Excel file renamed to .csv is read as Excel: read as text it is megabytes of
 * "cells" the CSV reader never gets through, and that hangs the whole server.
 */
function contentOf(buf) {
  if (buf[0] === 0x50 && buf[1] === 0x4b && buf[2] === 0x03 && buf[3] === 0x04) return 'excel'; // zip (XLSX)
  if (buf[0] === 0xd0 && buf[1] === 0xcf && buf[2] === 0x11 && buf[3] === 0xe0) return 'excel'; // OLE (XLS)
  if (buf.subarray(0, 5).toString('latin1') === '%PDF-') return 'binary';
  // text may hold a few stray control bytes (an export left NULs in a cell); a picture or a zip is full of them
  const head = buf.subarray(0, 8192);
  const control = head.reduce((n, c) => n + (c < 32 && c !== 9 && c !== 10 && c !== 13 && c !== 12 ? 1 : 0), 0);
  return control > head.length * 0.1 ? 'binary' : 'text';
}

const extName = (file) => path.extname(file).slice(1).toLowerCase();

/** The file and what it holds; a binary file or a text '.xlsx' is refused at once. */
function load(file) {
  const buf = fs.readFileSync(file);
  const content = contentOf(buf);
  if (content === 'binary' || (content === 'text' && extName(file) === 'xlsx')) {
    throw new Error(`The .${extName(file)} file is damaged or not in a known format (not CSV, Excel or text)`);
  }
  return { buf, content };
}

/**
 * A CSV whose every line was quoted once more ("STAFF_NUM,""FIRST_NAME"",..." — written as one cell by a second CSV
 * writer): its lines unwrapped. The first field, left unquoted by the export, gets its quotes back when other fields
 * follow quoted ("Quentin Roland, Marcel CROZET ,""03.07.2024 05:00"",..."), so the comma in it does not split it.
 */
function unwrapQuotedLines(text) {
  const lines = text.split(/\r\n|\r|\n/).filter(l => l.trim());
  if (lines.length < 2 || !lines.every(l => /^".*"\s*,?\s*$/.test(l) && l.includes('""'))) return text;
  return lines.map(l => l.trim().replace(/^"/, '').replace(/"\s*,?$/, '').replace(/""/g, '"')
    .replace(/^([^",][^"]*?)\s*,(?=")/, (m, first) => `"${first.trim()}",`)).join('\n');
}

/** Sheets as [{ name, rows: [[text]] }]; CSV cells are kept as written (no date guessing). */
function readSheets(file, { buf, content } = load(file)) {
  // an .xls may also be HTML/XML or tab-separated text from a web export: SheetJS reads those too
  const wb = content === 'text' && extName(file) !== 'xls'
    ? XLSX.read(unwrapQuotedLines(decode(buf)), { type: 'string', raw: true, dense: true })
    : XLSX.read(buf, { type: 'buffer', dense: true, cellNF: true }); // cellNF: keep number formats, to tell dates
  return wb.SheetNames.map((name) => {
    const ws = wb.Sheets[name];
    const rows = Array.from(ws['!data'] || [], r => Array.from(r || [], cellText)); // sparse: empty rows/cells are holes
    return { name, rows: trimRows(rows) };
  }).filter(s => s.rows.length);
}

/** Drops empty rows at the end and empty cells at the end of each row. */
function trimRows(rows) {
  const out = rows.map((r) => {
    const cells = Array.from(r, c => c || '');
    while (cells.length && !cells[cells.length - 1]) cells.pop();
    return cells;
  });
  while (out.length && !out[out.length - 1].length) out.pop();
  return out;
}

/**
 * A grid of cells as a page: each column as wide as its longest cell line; a cell
 * of several lines takes as many lines on the page, like the PDF it was exported
 * from prints it. The page keeps the grid too (`page.grid[row][col]` = the cell's
 * items, one per line, or null), not enumerable so it is never written out:
 * services/table-roster-parser.js reads the columns from it, and its items are
 * the page's own (dayFirstDates edits reach it).
 */
function gridPage(rows, page) {
  const widths = [];
  for (const r of rows) r.forEach((c, i) => { for (const l of c.split('\n')) widths[i] = Math.max(widths[i] || 0, l.length); });
  const starts = [];
  widths.reduce((x, w, i) => { starts[i] = x; return x + (w || 0) + COL_GAP; }, 0);
  const items = [];
  let line = 0;
  const grid = rows.map((r) => {
    const lines = r.map(text => (text ? text.split('\n') : null));
    const height = Math.max(1, ...lines.map(l => l?.length || 0));
    // a cell of fewer lines sits in the middle of its row, as the PDF prints a day's date beside its legs
    const cells = lines.map((ls, i) => ls && ls.map((t, k) => {
      const item = { text: t, x: MARGIN + starts[i] * CHAR_W, y: MARGIN + (line + (height - ls.length) / 2 + k) * CHAR_H, w: t.length * CHAR_W, h: CHAR_H - 2 };
      items.push(item);
      return item;
    }));
    line += height;
    return cells;
  });
  const chars = widths.reduce((s, w) => s + (w || 0) + COL_GAP, 0);
  const out = { page, width: 2 * MARGIN + chars * CHAR_W, height: 2 * MARGIN + line * CHAR_H, items };
  Object.defineProperty(out, 'grid', { value: grid });
  return out;
}

const expandTabs = (line) => line.replace(/[^\t]*\t/g, (m) => { const s = m.slice(0, -1); return s + ' '.repeat(8 - (s.length % 8)); });

function readTextFile(buf) {
  const lines = decode(buf).split(/\r?\n|\r/);
  const tabbed = lines.filter(l => l.includes('\t')).length;
  const nonEmpty = lines.filter(l => l.trim()).length;
  // Mostly tab-separated: a spreadsheet saved as text.
  if (nonEmpty && tabbed >= nonEmpty / 2) {
    return [gridPage(trimRows(lines.map(l => l.split('\t').map(cellLines))), 1)];
  }
  const items = [];
  let longest = 0;
  lines.forEach((raw, y) => {
    const line = expandTabs(raw);
    longest = Math.max(longest, line.length);
    for (const m of line.matchAll(/\S+(?: \S+)*/g)) {
      items.push({ text: m[0], x: MARGIN + m.index * CHAR_W, y: MARGIN + y * CHAR_H, w: m[0].length * CHAR_W, h: CHAR_H - 2 });
    }
  });
  return [{ page: 1, width: 2 * MARGIN + longest * CHAR_W, height: 2 * MARGIN + lines.length * CHAR_H, items }];
}

export function readTableText(file) {
  const loaded = load(file);
  const pages = extName(file) === 'txt' && loaded.content === 'text'
    ? readTextFile(loaded.buf)
    : readSheets(file, loaded).map((s, i) => gridPage(s.rows, i + 1));
  if (!pages.some(p => p.items.length)) throw new Error('The file has no data');
  // marked so hasTextLayer() never sends them to OCR
  for (const p of pages) p.fromTextFile = true;
  return pages;
}

const esc = (s) => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[c]));

/** The file as a page to look at: sheets as tables, a text file as it is. */
export function previewHtml(file) {
  const style = `<style>
    body { margin: 12px; font: 12px/1.4 Consolas, "Courier New", monospace; color: #222; background: #fff; }
    h3 { font: 600 13px system-ui, sans-serif; margin: 16px 0 6px; }
    table { border-collapse: collapse; }
    td { border: 1px solid #ddd; padding: 2px 6px; white-space: pre; vertical-align: top; }
    td.n { color: #999; background: #f6f6f6; text-align: right; }
    pre { margin: 0; }
  </style>`;
  let body;
  const loaded = load(file);
  if (extName(file) === 'txt' && loaded.content === 'text') {
    body = `<pre>${esc(decode(loaded.buf))}</pre>`;
  } else {
    const sheets = readSheets(file, loaded);
    body = sheets.map(s => `${sheets.length > 1 ? `<h3>${esc(s.name)}</h3>` : ''}<table>${s.rows.map((r, i) => `<tr><td class="n">${i + 1}</td>${r.map(c => `<td>${esc(c)}</td>`).join('')}</tr>`).join('')}</table>`).join('')
      || '<p>(empty file)</p>';
  }
  return `<!doctype html><html><head><meta charset="utf-8">${style}</head><body>${body}</body></html>`;
}
