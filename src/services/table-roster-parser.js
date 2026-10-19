/**
 * Rosters and logbooks exported as tables (CSV / XLS / XLSX, read by
 * services/table-text.js). The pages of such a file keep their cell grid
 * (`page.grid[row][col]` = the cell's items), so a layout is read by its
 * column headers instead of by positions on a page.
 *
 *   parseTableRoster(pages, { mark, startTrace }) -> result like parseNetlinePdf, or null
 *     (not a table file, or no layout here knows its header)
 *
 * Layouts:
 *   logbook        Lido "Pilot Logbook" (Date | Airport | Time | Airport | Time | Type | Reg. | Flt time ...)
 *                  and its flat export (Id | Name | Date | DepPlace | DepTime | ArrPlace | ArrTime | ACType | Reg | FltTime ...)
 *   duty-report    Staff Number | ... | Duty_CD | Flight Number | Dep Arp | Arr Arp | Fleet | Tail Number | Act Start Date | Act Start Time ...
 *   ac-logbook     "Air Canada Logbook": Date | Type | Reg | FIN | Flt# | ... | Station | Time(L) | Station | Time(L) ...
 *   block-log      Departure | Arrival | Off Block | On Block | Block | ... | Aircraft | Model ...  (ICAO airports, "27.07.2025 11:41")
 *   raido          Raido "Performed Activities": Date | Des. | Code | ... | Dep | Arr | CI | STD | ATD | STA | ATA | CO
 * Rows follow the labels' conventions (services/pdf-roster-parser.js): date "1 Aug 24",
 * day "Thu", times "HH:MM Z" (or L when the file says local), "+1" only where the
 * file prints it next to the time ("2259+"); airports as printed (both, also for a
 * ground duty); durations as "[<header>: 01:13]" in info, block time always "[Block: 01:13]",
 * flight time "[Flight: 01:13]" (as duty "[Duty: ..]", layover "[Layover: ..]", rest "[Rest: ..]", sim "[Sim: ..]"). Pilot names and free-text
 * remarks are left out, as in the flight-log layout: a label holds what the model can
 * read off the words, nothing derived from other columns.
 * Rows keep the file's order.
 */
import { formatTime, MONTHS } from './pdf-roster-parser.js';

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const FIELDS = ['date', 'day', 'dc', 'duty', 'registration', 'dep', 'begin', 'end', 'arr', 'ac', 'crew', 'info'];
const AIRPORT_RE = /^\*?[A-Z]{3}$/;

const cellOf = (row, i) => {
  const items = (i == null ? null : row[i]) || [];
  return { items, text: items.map(it => it.text).join(' ').trim() };
};
const rowTexts = (row) => row.map(c => (c || []).map(it => it.text).join(' ').trim());

/** Calendar date -> { date: "1 Aug 24", day: "Thu", ymd } */
function dayOf(d, m, y) {
  const year = y < 100 ? 2000 + y : y;
  return { date: `${d} ${MONTHS[m]} ${String(year % 100).padStart(2, '0')}`, day: WEEKDAYS[new Date(year, m, d).getDay()], ymd: Date.UTC(year, m, d) };
}

/** "01Dec21", "01JAN24" -> calendar date */
function ddMonYy(text) {
  const m = /^(\d{1,2})([A-Za-z]{3})(\d{2}|\d{4})$/.exec(text);
  const mon = m && MONTHS.findIndex(x => x.toLowerCase() === m[2].toLowerCase());
  return m && mon >= 0 ? dayOf(Number(m[1]), mon, Number(m[3])) : null;
}

/** "Jun 21 2024" -> calendar date */
function monDdYyyy(text) {
  const m = /^([A-Za-z]{3}) (\d{1,2}),? (\d{4})$/.exec(text);
  const mon = m && MONTHS.findIndex(x => x.toLowerCase() === m[1].toLowerCase());
  return m && mon >= 0 ? dayOf(Number(m[2]), mon, Number(m[3])) : null;
}

/**
 * Numeric dates of one file ("22/02/24", "07/20/24", "27.07.2025"): day first,
 * unless one of them only works month first (US exports).
 */
function numericDates(texts) {
  const parts = texts.map(t => /^(\d{1,2})[/.](\d{1,2})[/.](\d{2}|\d{4})\b/.exec(t)).filter(Boolean);
  const monthFirst = parts.some(p => +p[2] > 12) && !parts.some(p => +p[1] > 12);
  return (text) => {
    const p = /^(\d{1,2})[/.](\d{1,2})[/.](\d{2}|\d{4})\b/.exec(text);
    if (!p) return null;
    const [d, m] = monthFirst ? [+p[2], +p[1]] : [+p[1], +p[2]];
    return m >= 1 && m <= 12 && d >= 1 && d <= 31 ? dayOf(d, m - 1, Number(p[3])) : null;
  };
}

/** "06:35", "6:35", "0635", "601" (Raido), "8:25PM", "2259+" -> "06:35 Z" (+ " +1"); something else -> as printed */
function timeOf(text, zone, nextDay = false) {
  return looseTime(text, zone, nextDay) ?? String(text || '').trim();
}

/** The same, null when the text is not a time (also used by services/pdf-row-assembler.js). */
export function looseTime(text, zone, nextDay = false) {
  let t = String(text || '').trim();
  if (!t) return '';
  let plus = nextDay;
  if (/\+$/.test(t)) { plus = true; t = t.slice(0, -1).trim(); }
  let m = /^(\d{1,2}):?(\d{2})\s*([AP]M)$/i.exec(t);
  if (m) {
    const h = (Number(m[1]) % 12) + (m[3].toUpperCase() === 'PM' ? 12 : 0);
    t = `${String(h).padStart(2, '0')}:${m[2]}`;
  } else if ((m = /^(\d{1,2}):(\d{2})$/.exec(t))) t = `${m[1].padStart(2, '0')}:${m[2]}`;
  else if (/^\d{1,4}$/.test(t) && Number(t.slice(-2)) < 60 && Number(t.padStart(4, '0').slice(0, 2)) < 24) t = t.padStart(4, '0');
  else return null;
  return `${formatTime(t, zone)}${plus ? ' +1' : ''}`;
}

/** A label row in field order. */
const outRow = (r) => Object.fromEntries(FIELDS.map(f => [f, r[f] || '']));

/** Period from the rows' first and last month: "01Jul24 - 31Jul24". */
function periodOfRows(rows) {
  const ymds = rows.map(r => r._ymd).filter(Number.isFinite);
  if (!ymds.length) return null;
  const a = new Date(Math.min(...ymds)), b = new Date(Math.max(...ymds));
  const last = new Date(Date.UTC(b.getUTCFullYear(), b.getUTCMonth() + 1, 0)).getUTCDate();
  const yy = (d) => String(d.getUTCFullYear() % 100).padStart(2, '0');
  return `01${MONTHS[a.getUTCMonth()]}${yy(a)} - ${last}${MONTHS[b.getUTCMonth()]}${yy(b)}`;
}

/** "01/02/2024 - 05/08/2024" (day first, see dayFirstDates) or "(01JAN24 - 06AUG24)" printed above the table. */
function printedPeriod(grid) {
  for (const row of grid.slice(0, 15)) {
    for (const t of rowTexts(row)) {
      let m = /^(\d{2})[/.](\d{2})[/.](\d{4})\s*-\s*(\d{2})[/.](\d{2})[/.](\d{4})/.exec(t);
      if (m) return `${m[1]}${MONTHS[+m[2] - 1]}${m[3].slice(2)} - ${m[4]}${MONTHS[+m[5] - 1]}${m[6].slice(2)}`;
      m = /^\(?(\d{2})([A-Za-z]{3})(\d{2})\s*-\s*(\d{2})([A-Za-z]{3})(\d{2})\)?$/.exec(t);
      const cap = (s) => s[0].toUpperCase() + s.slice(1).toLowerCase();
      if (m) return `${m[1]}${cap(m[2])}${m[3]} - ${m[4]}${cap(m[5])}${m[6]}`;
    }
  }
  return null;
}

/** Index of the n-th (0-based) header cell equal to `name`, after column `from`. */
function colIndex(header, name, { nth = 0, from = -1 } = {}) {
  let seen = 0;
  for (let i = from + 1; i < header.length; i++) if (header[i] === name && seen++ === nth) return i;
  return null;
}

// ---- layouts: find(header texts) -> columns | null; row(cells) -> rows ----

const LAYOUTS = [
  {
    name: 'logbook',
    find(h) {
      if (h.includes('Date') && h.includes('Airport') && h.includes('Reg.') && h.includes('Flt time')) { // Lido "Pilot Logbook"
        const dep = colIndex(h, 'Airport'), arr = colIndex(h, 'Airport', { nth: 1 });
        const flt = colIndex(h, 'Flt time'), type = colIndex(h, 'Type');
        return {
          date: colIndex(h, 'Date'), dep, begin: colIndex(h, 'Time', { from: dep }), arr, end: colIndex(h, 'Time', { from: arr }),
          ac: type, registration: colIndex(h, 'Reg.'), flt,
          simTime: h.lastIndexOf('Time') > flt ? h.lastIndexOf('Time') : null, simType: h.lastIndexOf('Type') > type ? h.lastIndexOf('Type') : null,
        };
      }
      if (['Date', 'DepPlace', 'DepTime', 'ArrPlace', 'ArrTime'].every(n => h.includes(n))) { // its flat export
        const at = (n) => (h.includes(n) ? h.indexOf(n) : null);
        return {
          date: at('Date'), dep: at('DepPlace'), begin: at('DepTime'), arr: at('ArrPlace'), end: at('ArrTime'),
          ac: at('ACType'), registration: at('Reg'), flt: at('FltTime'), simTime: at('SimTime'), simType: at('SimType'),
        };
      }
      return null;
    },
    rows(data, cols, { dateOf, zone }) {
      const out = [];
      for (const row of data) {
        const c = (k) => cellOf(row, cols[k]);
        const d = dateOf(c('date').text);
        if (!d || !AIRPORT_RE.test(c('dep').text)) continue; // the pilot's name line, "Totals :"
        const sim = c('simTime').text && !c('registration').text;
        const info = sim ? (c('simTime').text ? `[Sim: ${c('simTime').text}]` : '') : (c('flt').text ? `[Flight: ${c('flt').text}]` : '');
        out.push({
          ...d, duty: sim ? c('simType').text : '', dep: c('dep').text, begin: timeOf(c('begin').text, zone), arr: c('arr').text, end: timeOf(c('end').text, zone),
          ac: c('ac').text, registration: c('registration').text, info,
          _marks: [['date', c('date')], ['duty', sim ? c('simType') : null], ['dep', c('dep')], ['begin', c('begin')], ['arr', c('arr')], ['end', c('end')],
            ['ac', c('ac')], ['registration', c('registration')], ['info', sim ? c('simTime') : c('flt')]],
        });
      }
      return out;
    },
  },
  {
    name: 'duty-report',
    find(h) {
      if (!['Duty_CD', 'Flight Number', 'Dep Arp', 'Arr Arp', 'Act Start Date', 'Act Start Time'].every(n => h.includes(n))) return null;
      const at = (n) => (h.includes(n) ? h.indexOf(n) : null);
      return {
        code: at('Duty_CD'), flight: at('Flight Number'), dep: at('Dep Arp'), arr: at('Arr Arp'), ac: at('Fleet'), registration: at('Tail Number'),
        startDate: at('Act Start Date'), begin: at('Act Start Time'), endDate: at('Act End Date'), end: at('Act End Time'),
      };
    },
    rows(data, cols, { zone }) {
      const out = [];
      for (const row of data) {
        const c = (k) => cellOf(row, cols[k]);
        const d = ddMonYy(c('startDate').text);
        if (!d) continue;
        const duty = c('flight').text || c('code').text;
        out.push({
          ...d, duty, dep: c('dep').text, arr: c('arr').text,
          begin: timeOf(c('begin').text, zone), end: timeOf(c('end').text, zone),
          ac: c('ac').text, registration: c('registration').text,
          _marks: [['date', c('startDate')], ['duty', c('flight').text ? c('flight') : c('code')], ['dep', c('dep')], ['arr', c('arr')],
            ['begin', c('begin')], ['end', c('end')], ['ac', c('ac')], ['registration', c('registration')]],
        });
      }
      return out;
    },
  },
  {
    name: 'ac-logbook',
    find(h) {
      if (!(h.includes('Flt#') && h.includes('FIN') && h.includes('Station') && h.includes('Time(L)'))) return null;
      const dep = colIndex(h, 'Station'), arr = colIndex(h, 'Station', { nth: 1 });
      return {
        date: colIndex(h, 'Date'), ac: colIndex(h, 'Type'), registration: colIndex(h, 'Reg'), fin: colIndex(h, 'FIN'), flight: colIndex(h, 'Flt#'),
        dep, begin: colIndex(h, 'Time(L)', { from: dep }), arr, end: colIndex(h, 'Time(L)', { from: arr }), remark: colIndex(h, 'Remark'),
      };
    },
    rows(data, cols) {
      const out = [];
      for (const row of data) {
        const c = (k) => cellOf(row, cols[k]);
        const d = monDdYyyy(c('date').text);
        if (!d) continue;
        // the airline's flight number ("AC526") is printed in one of FIN / Flt#, the fleet number ("# 0578") in the other
        const flight = [c('flight'), c('fin')].find(x => /^[A-Z0-9]{2}\d{1,4}[A-Z]?$/.test(x.text)) || c('flight');
        out.push({
          ...d, duty: flight.text, dep: c('dep').text, begin: timeOf(c('begin').text, 'L'), arr: c('arr').text, end: timeOf(c('end').text, 'L'),
          ac: c('ac').text, registration: c('registration').text, info: '',
          _marks: [['date', c('date')], ['duty', flight], ['dep', c('dep')], ['begin', c('begin')], ['arr', c('arr')], ['end', c('end')],
            ['ac', c('ac')], ['registration', c('registration')]],
        });
      }
      return out;
    },
  },
  {
    name: 'block-log',
    find(h) {
      if (!['Departure', 'Arrival', 'Off Block', 'On Block'].every(n => h.includes(n))) return null;
      const at = (n) => (h.includes(n) ? h.indexOf(n) : null);
      return { dep: at('Departure'), arr: at('Arrival'), off: at('Off Block'), on: at('On Block'), block: at('Block'), registration: at('Aircraft'), ac: at('Model'), remark: at('Remark') };
    },
    rows(data, cols, { dateOf, zone }) {
      const out = [];
      for (const row of data) {
        const c = (k) => cellOf(row, cols[k]);
        // "27.07.2025 11:41": the date and the time are one cell (two words on the page);
        // each part is marked on its own (the word's offset in the item, as the PDF parsers do)
        const split = (cell) => {
          const it = cell.items[0];
          const [date = '', time = ''] = cell.text.split(' ');
          const part = (text, off) => ({ items: it && text ? [{ ...it, text, _src: it, _off: off }] : [] });
          return { date, time, dateCell: part(date, 0), timeCell: part(time, date.length + 1) };
        };
        const off = split(c('off')), on = split(c('on'));
        const d = dateOf(off.date);
        if (!d || !c('dep').text) continue;
        const info = c('block').text ? `[Block: ${c('block').text}]` : '';
        out.push({
          ...d, duty: '', dep: c('dep').text, arr: c('arr').text, begin: timeOf(off.time, zone), end: timeOf(on.time, zone),
          ac: c('ac').text, registration: c('registration').text, info,
          _marks: [['date', off.dateCell], ['begin', off.timeCell], ['dep', c('dep')], ['arr', c('arr')], ['end', on.timeCell], ['ac', c('ac')], ['registration', c('registration')], ['info', c('block')]],
        });
      }
      return out;
    },
  },
  {
    name: 'raido',
    find(h) {
      if (!['Code', 'Dep', 'Arr', 'STD', 'STA'].every(n => h.includes(n))) return null;
      const at = (n) => (h.includes(n) ? h.indexOf(n) : null);
      return {
        date: at('Date'), des: at('Des.'), code: at('Code'), ac: at('Type'), registration: at('Registration'), dep: at('Dep'), arr: at('Arr'),
        ci: at('CI'), std: at('STD'), atd: at('ATD'), sta: at('STA'), ata: at('ATA'), co: at('CO'),
      };
    },
    rows(data, cols, { zone }) {
      const out = [];
      let d = null;
      for (const row of data) {
        const c = (k) => cellOf(row, cols[k]);
        // the CI header is a merged cell: its values may sit one column left of it
        const ci = c('ci').text ? c('ci') : cellOf(row, cols.ci - 1);
        d = ddMonYy(c('date').text) || d;
        if (!d || !c('code').text || !AIRPORT_RE.test(c('dep').text) || !AIRPORT_RE.test(c('arr').text)) continue; // page headers, blank lines
        const at = { ...d };
        if (ci.text && ci.text !== '0') out.push({ ...at, duty: 'C/I', begin: timeOf(ci.text, zone), _marks: [['ci', ci]] });
        const info = [c('des').text && `[Des. ${c('des').text}]`, c('atd').text && `[ATD ${timeOf(c('atd').text, zone)}]`, c('ata').text && `[ATA ${timeOf(c('ata').text, zone)}]`].filter(Boolean).join(' ');
        out.push({
          ...at, duty: c('code').text, dep: c('dep').text, arr: c('arr').text, begin: timeOf(c('std').text, zone), end: timeOf(c('sta').text, zone),
          ac: c('ac').text, registration: c('registration').text, info,
          _marks: [['date', c('date')], ['duty', c('code')], ['dep', c('dep')], ['arr', c('arr')], ['begin', c('std')], ['end', c('sta')],
            ['ac', c('ac')], ['registration', c('registration')], ['info', c('des')], ['info', c('atd')], ['info', c('ata')]],
        });
        if (c('co').text) out.push({ ...at, duty: 'C/O', end: timeOf(c('co').text, zone), _marks: [['co', c('co')]] });
      }
      return out;
    },
  },
];

export function parseTableRoster(pages, { mark = () => {}, startTrace = () => null } = {}) {
  const grids = pages.map(p => p.grid).filter(Boolean);
  if (!grids.length) return null;
  for (const layout of LAYOUTS) {
    const found = [];
    for (const grid of grids) {
      const at = grid.findIndex(row => layout.find(rowTexts(row)));
      if (at >= 0) found.push({ grid, at, cols: layout.find(rowTexts(grid[at])) });
    }
    if (!found.length) continue;
    const trace = startTrace();
    const allText = grids.flatMap(g => g.flatMap(rowTexts));
    const zone = allText.some(t => /^TimeMode\s+Local/i.test(t)) ? 'L' : 'Z';
    // day or month first, from the table's own date column (the period line above it is already day first)
    const dateOf = numericDates(found.flatMap(({ grid, at, cols }) => grid.slice(at + 1).map(r => cellOf(r, cols.date ?? cols.off).text)));
    const rows = found.flatMap(({ grid, at, cols }) => layout.rows(grid.slice(at + 1), cols, { dateOf, zone }));
    const published = rows.map((r) => {
      const row = outRow(r);
      for (const [field, cell] of r._marks || []) if (cell?.items?.length) mark(row, field, cell.items);
      return row;
    });
    const period = found.map(f => printedPeriod(f.grid)).find(Boolean) || periodOfRows(rows.map(r => ({ _ymd: r.ymd })));
    return { _trace: trace, format: `table-${layout.name}`, period, notices: [], recognized: published.length > 0, published, planned: [] };
  }
  return null;
}
