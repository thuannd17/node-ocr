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
 *   crew-legs      one row per leg: Flt_Nbr | Dprt_Arpt_Cd | Arr_Arpt_Cd | Actl_Crew_Schlg_Ac_Typ_Cd | schld_/actl_ ..._lcl_dttm |
 *                  Actl_Duty_Rpt_Lcl_Dttm | Actl_Duty_Rls_Lcl_Dttm (all local: "A08:55 L" actual, else "E09:00 L" scheduled; C/I, C/O)
 *                  info "[Pairing: 0178] [Block: 01:24]" on a flight, "[Pairing: 0178] [Layover: 20:51]" on a C/O (minutes columns)
 *   raido          Raido "Performed Activities": Date | Des. | Code | ... | Dep | Arr | CI | STD | ATD | STA | ATA | CO
 *                  (dates "01Jan24", or "01 Sat" in the printed period's months; a "Crew: CA: NAME, First, FO(X): ..." line
 *                  under a flight -> its crew "[CA - NAME, First][FO(X) - ...]"); also saved with Raido's field names
 *                  (RaidoLab_Name | Text2 | ... | Text11 | Text12 | TimeText_CI | TimeText_ValidFrom | ...)
 *   roster-report  "Crew Roster Report" as CSV: Date | DC | Activity | C/I(Z) | C/I(L) | C/O(Z) | ... | From | Start(Z) | To | Finish(Z) | ... | BH | DHrs | FDP | Max FDP | Hotel | A/C Reg
 *                  (times "HH:MM Z / HH:MM L": UTC, then local; some files only have the (L) columns, AC Type; or (B) homebase times)
 *   crew-flights   one row per flight with its crew: Flight | Date | A/C Type | Tail | Origin | Dest | Depart | Arrive | Block | Credit |
 *                  Captain | First Officer | Flight Attendant (local times; crew "[CP - 051471 - Matt Johnson]")
 *   block-times    one row per leg: Flight "SK7372-20250601-RHO-SVG" | Departure Date | Block off | Arrival Date | Block on | ... | Duration (min) | PIC | SIC
 *   route-log      pilot logbook by day: Date "Jan 02 2025" | Code | Fleet | Rego | PIC | FO | Route "MEL-BNE" | Takeoff | Landing | ... | Day Hours | Night Hours
 *   calendar-events  calendar export: dtstart | dtend | description ("F8521 YKF - YYC\nCI 0040Z / 2040L\nSTD ...") | summary
 *   emirates-detailed  "Emirates Crew Roster (Detailed Report)": Day/Date "05-WED" | Duty/Trip Code | Label | Report |
 *                  Time(Dep-Arv) | Duty Details "EK9919 [DWC-ZAZ]" | A/C | End | Block Hours (local times; the month above it)
 *   spanish-logbook  EASA pilot logbook in Spanish: FECHA | SALIDA | LLEGADA | AERONAVE | ... | TIEMPO TOTAL VUELO | NOMBRE PIC | ...
 *   crew-duties    crew planning export, a line per duty or leg: klm_id | ... | duty_start | act | ... | flight | dep_stat | arr_stat |
 *                  subtype | ac_reg | ... | leg_start | leg_end | flh | ... | duty_en | duty_mins (UTC)
 *   flight-time-report  "Flight Time Report": Flight Date "10-DEC-2024" | A/C Type | Flt No | A/C Reg | From | To | ATD | ATA | Block | Stick |
 *                  Take off | Landing (Y) | SDC | Crew Name "Name(420949-CA),..."; period from "From:" / "To:" above it
 *   flight-records one row per flight: flightDate | flightNumber | from | actualDepartureTime | onDutyTime | takeoffTime | to |
 *                  landingTime | actualArrivalTime | offDutyTime | selectedAircraftType | selectedAircraftID | ... | totalTime
 *                  ("2025/08/05 06:40", UTC); C/I from onDutyTime, C/O from offDutyTime, takeoff / landing times of their own
 *   blocks-logbook  business-aviation export: Crew | Blocks Off/On Estimated/Actual "06.07.2024 05:05" | From/To Airport | ... | Block Time Actual "1h55"
 *   duty-legs      FTL record: Date | AC | Funct. | Duty "EGLK - EGAE" | Start Duty | Off-Block | Take Off | Ldg | On-Block | Check-Out | ... (C/I, C/O)
 *   duty-sectors   Duty Start "05/06/2020 1100L" | Flt/GD | SD | Sector "HKG-TPE" | A/C | Dep | Arr | Duty End (local)
 *   aircraft-id-logbook  Date | Aircraft ID | Aircraft Type | Out | In | PIC/P1 Crew | SIC/P2 Crew | Total Time | Remarks | Flight # | From | To | Total Pax
 *   utc-legs       Start UTC | From | End UTC | To | Flight time "11h16" | SIMU ins | SIMU trg | Type | Function | Aircraft "FHMIB A35K"
 *   far-logbook    Name | Date "2022-11-14 14:14:00.0 Z" | Typename | Tail | From | To | Blk Hrs | FAR 91 | ... | Paired With "Beliard, Laurent PIC"
 *   planning-checkin  "Planning from ... till ...": Check-in | Start | City | End | Debrief end | Duty end | City | Duty | ... | Description | Notes | Pax
 *   saudia-duties  DUTY_CD | PRNG_NUM | FLT_NUM | DEPARURE_PORT | ARRIVAL_PORT | ... | ACTUAL_START_DATE_GMT | ... | ACTUAL_END_TIME_LOCAL ("Z / L")
 *   german-logbook  Flugbuch: Datum | LFZ Typ | Kennzeichen | von | nach | Start | Landung | BlockOff | BlockOn | ... | Schüler; or Datum | Lfz. |
 *                  Startort "Goch-Asperden EDLG" | Landeort | Off-Block | On-Block | ... | Pilot | Begleiter/FI | Flugzeit (minutes) | Lfz.-Muster
 *   brakes-logbook  Date | Aircraft | Flight Log | From | To | Brakes Off | Take Off | Landing | Brakes On | PIC | Student | Defects
 *   pf-legs        Flight Date "21-Sep-25" | Flight Number | Takeoff (as PF) | TO Location | Out Time | ... | Ldg Location | In Time | ... | Airline
 *   utc-crew-legs  departUTC | arriveUTC | fltNum | origin | destination | acRegistration | acType | crew "CA: .. / FO: .." | hours
 *   school-flights  id | date | reg | type | flight_type | pic | customer | instructor | from | to | off_blocks_utc | takeoff_utc | ... | total_block
 *   activity-lines  SAS: Day | Date "01AUG2025" | Duty | Meal | Activity (checkin, a flight, NightStop, checkout) | From | STD | STA | To | Stop time
 *   dhd-flights    Southwest: DATE | Flight | dhd | From | Depart "1411" | To | Arrive | Block "213" | Tail_Number | A_C_Type | CoPilot
 *   stamp-logbook  date_of_flight | call_sign | departure_airport | off_block "22/05/2015 06:22" | take_off | ... | on_block | ... | capt_on_flight
 *   block-time-report  Actual Out | Actual In | Orig | Dest | Crew Count ("DHD": deadhead) | Block Time ("12+33")
 *   outlook-calendar  Outlook calendar export (Iberia, Spanish): Asunto | Fecha de comienzo | Comienzo | ... | Todo el día | ... | Description
 *                  ("Firma 14:30 Pairing 1589" -> C/I, "IB721  MAD1345-LHR1615 / 350 +O" a flight in UTC, "X - DIA LIBRE" codes, crew lines)
 * Rows follow the labels' conventions (services/pdf-roster-parser.js): date "1 Aug 24",
 * day "Thu", times "HH:MM Z" (or L when the file says local; takeoff / landing too, where the file has them), "+1" only where the
 * file prints it next to the time ("2259+"); airports as printed (both, also for a
 * ground duty); durations as "[<header>: 01:13]" in info, block time always "[Block: 01:13]",
 * flight time "[Flight: 01:13]" (as duty "[Duty: ..]", layover "[Layover: ..]", rest "[Rest: ..]", sim "[Sim: ..]"); a logbook's
 * time by function "[PIC: ..] [CoPilot: ..] [Instructor: ..]", take-offs / landings "[Takeoff Day: 1] [Takeoff Night: 1]
 * [Landing Day: 1] [Landing Night: 1]" where the file counts them by day and night. Crew "[ROLE - NAME]" where the file names them; free-text
 * remarks are left out: a label holds what the model can read off the words, nothing derived from other columns.
 * Rows keep the file's order.
 */
import { formatTime, MONTHS } from './pdf-roster-parser.js';

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const FIELDS = ['date', 'day', 'dc', 'duty', 'registration', 'dep', 'begin', 'takeoff', 'landing', 'end', 'arr', 'ac', 'crew', 'info'];
const AIRPORT_RE = /^\*?[A-Z]{3}$/;
const AIRPORT_ICAO_OR_IATA = /^[A-Z]{3,4}$/;

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

/** Take-off / landing counts, by day and night: "[Takeoff Day: 1] [Landing Night: 2]" (none for an empty cell or 0). */
const counted = (cell) => /^\d+$/.test(cell.text) && +cell.text > 0;
const countTags = (pairs) => pairs.filter(([, cell]) => counted(cell)).map(([k, cell]) => `[${k}: ${+cell.text}]`);
/** Marks of the counted cells (a 0 is not in info). */
const countMarks = (...cells) => cells.filter(counted).map(cell => ['info', cell]);

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

/**
 * "01/02/2024 - 05/08/2024" (day first, see dayFirstDates), "(01JAN24 - 06AUG24)", "From: | 01-Sep-2024", "To: | 30-Sep-2025"
 * or a month ("Staff : ... | 01/03/2025") printed above the table.
 */
function printedPeriod(grid) {
  const fromTo = (name) => {
    const cells = grid.slice(0, 15).map(rowTexts).find(r => r[0] === name);
    const m = cells && /^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/.exec(cells[1] || '');
    return m ? `${m[1].padStart(2, '0')}${m[2][0].toUpperCase()}${m[2].slice(1).toLowerCase()}${m[3].slice(2)}` : null;
  };
  if (fromTo('From:') && fromTo('To:')) return `${fromTo('From:')} - ${fromTo('To:')}`;
  // a month's report: "Staff : | 444123 | Name : | ... | 01/03/2025"
  for (const row of grid.slice(0, 15).map(rowTexts)) {
    const m = row.includes('Staff :') && row.map(t => /^01\/(\d{2})\/(\d{4})$/.exec(t)).find(Boolean);
    if (!m) continue;
    const mon = MONTHS[+m[1] - 1], yy = m[2].slice(2);
    return `01${mon}${yy} - ${new Date(Date.UTC(+m[2], +m[1], 0)).getUTCDate()}${mon}${yy}`;
  }
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
          ac: type, registration: colIndex(h, 'Reg.'), flt, picName: colIndex(h, 'Name PIC'),
          // TOFF | LND above them: Day | Night | Day | Night
          tkDay: colIndex(h, 'Day', { from: flt }), tkNight: colIndex(h, 'Night', { from: flt }),
          ldDay: colIndex(h, 'Day', { from: flt, nth: 1 }), ldNight: colIndex(h, 'Night', { from: flt, nth: 1 }),
          pic: colIndex(h, 'PIC', { from: flt }), coPilot: colIndex(h, 'Co-Plt'), instructor: colIndex(h, 'Instr'),
          simTime: h.lastIndexOf('Time') > flt ? h.lastIndexOf('Time') : null, simType: h.lastIndexOf('Type') > type ? h.lastIndexOf('Type') : null,
        };
      }
      if (['Date', 'DepPlace', 'DepTime', 'ArrPlace', 'ArrTime'].every(n => h.includes(n))) { // its flat export
        const at = (n) => (h.includes(n) ? h.indexOf(n) : null);
        return {
          date: at('Date'), dep: at('DepPlace'), begin: at('DepTime'), arr: at('ArrPlace'), end: at('ArrTime'),
          ac: at('ACType'), registration: at('Reg'), flt: at('FltTime'), picName: at('PicName'),
          tkDay: at('TKoffsDay'), tkNight: at('TKoffsNight'), ldDay: at('LandsDay'), ldNight: at('LandsNight'),
          pic: at('PIC'), coPilot: at('CoPlt'), instructor: at('Instr'), simTime: at('SimTime'), simType: at('SimType'),
        };
      }
      return null;
    },
    // Info in the file's column order: "[Flight: 02:09]" (a simulator session: duty = its type, "[Sim: 04:00]"),
    // take-offs / landings "[Takeoff Day: 1] [Landing Day: 1]", the pilot's time by function "[PIC: 02:09] [CoPilot: 01:16] [Instructor: 02:05]";
    // crew "[PIC - Self]" / "[PIC - MARQUEZ, MARC]" (Name PIC).
    rows(data, cols, { dateOf, zone }) {
      const out = [];
      for (const row of data) {
        const c = (k) => cellOf(row, cols[k]);
        const d = dateOf(c('date').text);
        if (!d || !AIRPORT_RE.test(c('dep').text)) continue; // the pilot's name line, "Totals :"
        const sim = c('simTime').text && !c('registration').text;
        const info = [
          !sim && c('flt').text && `[Flight: ${c('flt').text}]`,
          ...countTags([['Takeoff Day', c('tkDay')], ['Takeoff Night', c('tkNight')], ['Landing Day', c('ldDay')], ['Landing Night', c('ldNight')]]),
          ...[['PIC', 'pic'], ['CoPilot', 'coPilot'], ['Instructor', 'instructor']].map(([k, f]) => c(f).text && `[${k}: ${c(f).text}]`),
          c('simTime').text && `[Sim: ${c('simTime').text}]`,
        ].filter(Boolean).join(' ');
        out.push({
          ...d, duty: sim ? c('simType').text : '', dep: c('dep').text, begin: timeOf(c('begin').text, zone), arr: c('arr').text, end: timeOf(c('end').text, zone),
          ac: c('ac').text, registration: c('registration').text, crew: c('picName').text ? `[PIC - ${c('picName').text}]` : '', info,
          _marks: [['date', c('date')], ['duty', sim ? c('simType') : null], ['dep', c('dep')], ['begin', c('begin')], ['arr', c('arr')], ['end', c('end')],
            ['ac', c('ac')], ['registration', c('registration')], ['crew', c('picName')], ['info', sim ? null : c('flt')],
            ['info', c('pic')], ['info', c('coPilot')], ['info', c('instructor')], ['info', c('simTime')],
            ...countMarks(c('tkDay'), c('tkNight'), c('ldDay'), c('ldNight'))],
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
      return {
        dep: at('Departure'), arr: at('Arrival'), off: at('Off Block'), on: at('On Block'), block: at('Block'), registration: at('Aircraft'), ac: at('Model'), remark: at('Remark'),
        ldDay: at('Day Landings'), ldNight: at('Night Landings'),
      };
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
        const info = [c('block').text && `[Block: ${c('block').text}]`, ...countTags([['Landing Day', c('ldDay')], ['Landing Night', c('ldNight')]])].filter(Boolean).join(' ');
        out.push({
          ...d, duty: '', dep: c('dep').text, arr: c('arr').text, begin: timeOf(off.time, zone), end: timeOf(on.time, zone),
          ac: c('ac').text, registration: c('registration').text, info,
          _marks: [['date', off.dateCell], ['begin', off.timeCell], ['dep', c('dep')], ['arr', c('arr')], ['end', on.timeCell], ['ac', c('ac')], ['registration', c('registration')], ['info', c('block')],
            ...countMarks(c('ldDay'), c('ldNight'))],
        });
      }
      return out;
    },
  },
  {
    name: 'crew-legs',
    // one row per leg, US airline export: Flt_Nbr | Dprt_Arpt_Cd | Arr_Arpt_Cd | Actl_Crew_Schlg_Ac_Typ_Cd |
    // schld_/actl_ dprt_/arr_ lcl_/gmt_ dttm ("2026-07-16 09:00:00") | Actl_Duty_Rpt_Lcl_Dttm | Actl_Duty_Rls_Lcl_Dttm ...
    find(h) {
      const lower = h.map(t => t.toLowerCase());
      const at = (n) => (lower.includes(n) ? lower.indexOf(n) : null);
      if (!['flt_nbr', 'dprt_arpt_cd', 'arr_arpt_cd', 'schld_dprt_lcl_dttm', 'schld_arr_lcl_dttm'].every(n => lower.includes(n))) return null;
      return {
        date: at('flt_orig_dt'), flight: at('flt_nbr'), dep: at('dprt_arpt_cd'), arr: at('arr_arpt_cd'), ac: at('actl_crew_schlg_ac_typ_cd'),
        rotation: at('rotn_beg_dt'), pairing: at('rotn_prng_nbr'), dutyPeriod: at('duty_perd_id'),
        std: at('schld_dprt_lcl_dttm'), sta: at('schld_arr_lcl_dttm'), atd: at('actl_dprt_lcl_dttm'), ata: at('actl_arr_lcl_dttm'),
        report: at('actl_duty_rpt_lcl_dttm'), release: at('actl_duty_rls_lcl_dttm'),
        block: at('actl_leg_blk_tm_mnt_cnt'), schedBlock: at('schld_leg_blk_tm_mnt_cnt'), layover: at('duty_layovr_tm_mnt_cnt'),
      };
    },
    // Every time in local (the file has GMT too): begin/end are the actual times ("A08:55 L"), or the
    // scheduled ones ("E09:00 L") when a leg has no actual time yet. A duty period (the same
    // rotation + duty period id on its legs) gets a C/I row from its report time before its first leg
    // and a C/O row from its release time after its last one. "+1" when a time falls on a later day.
    // Info: "[Pairing: 0178]" (Rotn_Prng_Nbr) on every flight and C/O; "[Block: 01:24]" on a flight
    // (actual block minutes, else scheduled); "[Layover: 20:51]" on the C/O when the duty period has one.
    rows(data, cols) {
      const out = [];
      // "2026-07-16 09:00:00": the date and the time are one cell; each part is marked on its own
      const stamp = (cell) => {
        const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/.exec(cell.text);
        if (!m) return null;
        const it = cell.items[0], off = cell.text.indexOf(' ') + 1;
        return {
          day: dayOf(+m[3], +m[2] - 1, +m[1]), hhmm: `${m[4]}${m[5]}`,
          timeCell: { items: it ? [{ ...it, text: cell.text.slice(off, off + 5), _src: it, _off: off }] : [] },
        };
      };
      const isoDay = (cell) => {
        const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(cell.text);
        return m ? dayOf(+m[3], +m[2] - 1, +m[1]) : null;
      };
      const time = (s, prefix, from) => (s ? formatTime(`${prefix}${s.hhmm}`, 'L') + (from && s.day.ymd > from.ymd ? ' +1' : '') : '');
      // minutes ("84", "1251") -> "01:24", "20:51"; 0 or blank -> ''
      const hhmm = (text) => (/^\d+$/.test(text) && +text > 0 ? `${String(Math.floor(+text / 60)).padStart(2, '0')}:${String(+text % 60).padStart(2, '0')}` : '');
      const tags = (...parts) => parts.filter(([, v]) => v).map(([k, v]) => `[${k}: ${v}]`).join(' ');
      let open = null; // the duty period now running: { key, release, date, pairing, layover }
      const close = () => {
        if (open?.release) {
          out.push({
            ...open.date, duty: 'C/O', end: time(open.release, '', open.date),
            info: tags(['Pairing', open.pairing.text], ['Layover', hhmm(open.layover.text)]),
            _marks: [['co', open.release.timeCell], ['info', open.pairing], ['info', hhmm(open.layover.text) ? open.layover : null]],
          });
        }
        open = null;
      };
      for (const row of data) {
        const c = (k) => cellOf(row, cols[k]);
        const sched = [stamp(c('std')), stamp(c('sta'))], actual = [stamp(c('atd')), stamp(c('ata'))];
        const d = isoDay(c('date')) || sched[0]?.day;
        if (!d || !c('flight').text || !AIRPORT_RE.test(c('dep').text)) continue;
        const key = [c('rotation').text, c('pairing').text, c('dutyPeriod').text].join('|');
        if (!open || open.key !== key) {
          close();
          const report = stamp(c('report'));
          open = { key, release: stamp(c('release')), date: report?.day || d, pairing: c('pairing'), layover: c('layover') };
          if (report) out.push({ ...open.date, duty: 'C/I', begin: time(report, ''), _marks: [['date', c('date')], ['ci', report.timeCell]] });
        }
        const [b, e] = [actual[0] ? [actual[0], 'A'] : [sched[0], 'E'], actual[1] ? [actual[1], 'A'] : [sched[1], 'E']];
        const block = hhmm(c('block').text) ? c('block') : c('schedBlock');
        out.push({
          ...d, duty: c('flight').text, dep: c('dep').text, arr: c('arr').text,
          begin: time(b[0], b[1], d), end: time(e[0], e[1], d), ac: c('ac').text,
          info: tags(['Pairing', c('pairing').text], ['Block', hhmm(block.text)]),
          _marks: [['date', c('date')], ['duty', c('flight')], ['dep', c('dep')], ['arr', c('arr')],
            ['begin', b[0]?.timeCell], ['end', e[0]?.timeCell], ['ac', c('ac')], ['info', c('pairing')], ['info', hhmm(block.text) ? block : null]],
        });
      }
      close();
      return out;
    },
  },
  {
    name: 'raido',
    find(h) {
      const at = (n) => (h.includes(n) ? h.indexOf(n) : null);
      // the same report saved with Raido's own field names (one line of them above the printed headers);
      // MimerValue1 is the block time ("01:09")
      if (['RaidoLab_Name', 'Text2', 'Text11', 'Text12', 'TimeText_CI', 'TimeText_ValidFrom', 'TimeText_ValidToString'].every(n => h.includes(n))) {
        return {
          date: at('RaidoLab_Name'), des: at('Text4'), code: at('Text2'), ac: at('Text8'), registration: at('Text10'), dep: at('Text11'), arr: at('Text12'),
          ci: at('TimeText_CI'), std: at('TimeText_ValidFrom'), atd: at('TimeText_ActualValidFrom'), sta: at('TimeText_ValidToString'),
          ata: at('TimeText_ActualValidToString'), co: at('TimeText_CO_String'), block: at('MimerValue1'), exact: true,
        };
      }
      if (!['Code', 'Dep', 'Arr', 'STD', 'STA'].every(n => h.includes(n))) return null;
      return {
        date: at('Date'), des: at('Des.'), code: at('Code'), ac: at('Type'), registration: at('Registration'), dep: at('Dep'), arr: at('Arr'),
        ci: at('CI'), std: at('STD'), atd: at('ATD'), sta: at('STA'), ata: at('ATA'), co: at('CO'),
      };
    },
    rows(data, cols, { zone, periodStart }) {
      const out = [];
      let d = null, flight = null;
      // "01 Sat": the day of the printed period's months, the next month when the day number goes down
      const cal = periodStart ? { y: new Date(periodStart.ymd).getUTCFullYear(), m: new Date(periodStart.ymd).getUTCMonth(), last: 0 } : null;
      const dayOfMonth = (text) => {
        const m = /^(\d{1,2})\s+[A-Za-z]{2,3}$/.exec(text);
        if (!m || !cal) return null;
        if (+m[1] < cal.last) { cal.m += 1; if (cal.m > 11) { cal.m = 0; cal.y += 1; } }
        cal.last = +m[1];
        return dayOf(+m[1], cal.m, cal.y);
      };
      for (const row of data) {
        const c = (k) => cellOf(row, cols[k]);
        // "Crew: CA: McWILLIAM, Elaine, FO(X): FOYLE, Rachel": the crew of the flight above
        const crewCell = row.map((_, i) => cellOf(row, i)).find(x => /^Crew:/.test(x.text));
        if (crewCell) {
          if (flight) {
            const list = crewCell.text.replace(/^Crew:\s*/, '');
            flight.crew = [...list.matchAll(/([A-Z]{2,4}(?:\([^)]*\))?):\s*(.*?)(?=,\s*[A-Z]{2,4}(?:\([^)]*\))?:|$)/g)].map(m => `[${m[1]} - ${m[2].trim()}]`).join('');
            flight._marks.push(['crew', crewCell]);
          }
          continue;
        }
        // the CI header is a merged cell: its values may sit one column left of it
        const ci = c('ci').text || cols.exact ? c('ci') : cellOf(row, cols.ci - 1);
        d = ddMonYy(c('date').text) || dayOfMonth(c('date').text) || d;
        if (!d || !c('code').text || !AIRPORT_RE.test(c('dep').text) || !AIRPORT_RE.test(c('arr').text)) continue; // page headers, blank lines
        const at = { ...d };
        // "0" / "0000": no check-in (a leg after the first of a duty)
        if (ci.text && !/^0+$/.test(ci.text)) out.push({ ...at, duty: 'C/I', begin: timeOf(ci.text, zone), _marks: [['ci', ci]] });
        const info = [c('des').text && `[Des. ${c('des').text}]`, c('atd').text && `[ATD ${timeOf(c('atd').text, zone)}]`, c('ata').text && `[ATA ${timeOf(c('ata').text, zone)}]`,
          /^\d+:\d{2}$/.test(c('block').text) && `[Block: ${c('block').text}]`].filter(Boolean).join(' ');
        flight = {
          ...at, duty: c('code').text, dep: c('dep').text, arr: c('arr').text, begin: timeOf(c('std').text, zone), end: timeOf(c('sta').text, zone),
          ac: c('ac').text, registration: c('registration').text, info,
          _marks: [['date', c('date')], ['duty', c('code')], ['dep', c('dep')], ['arr', c('arr')], ['begin', c('std')], ['end', c('sta')],
            ['ac', c('ac')], ['registration', c('registration')], ['info', c('des')], ['info', c('atd')], ['info', c('ata')], ['info', c('block')]],
        };
        out.push(flight);
        if (c('co').text) out.push({ ...at, duty: 'C/O', end: timeOf(c('co').text, zone), _marks: [['co', c('co')]] });
      }
      return out;
    },
  },
  {
    name: 'roster-report',
    // the "Crew Roster Report" as CSV (services/pdf-roster-parser.js parseCrewRosterReport reads the PDF), with the local times too:
    // Date | DC | Activity | C/I(Z) | C/I(L) | C/O(Z) | C/O(L) | From | Start(Z) | Start(L) | To | Finish(Z) | Finish(L) | BH | DHrs | FDP | Max FDP | Hotel | A/C Reg
    // or only the local ones: Date | DC | Activity | C/I(L) | C/O(L) | From | Start(L) | To | Finish(L) | AC Type | BH | DHrs | FDP | Max FDP | EXT | Hotel
    // or homebase times (B) instead of local, headers "Date$" ...: ... | AC Type | Turn | BH | DHrs | 1 | Ext | Hotel | C/I(B) | C/O(B) | Start(B) | Finish(B)
    find(header) {
      const h = header.map(t => t.replace(/\$$/, ''));
      if (!['Date', 'Activity', 'From', 'To'].every(n => h.includes(n))) return null;
      if (!['Z', 'L', 'B'].some(z => [`Start(${z})`, `Finish(${z})`].every(n => h.includes(n)))) return null;
      const at = (n) => (h.includes(n) ? h.indexOf(n) : null);
      const local = h.includes('Start(L)') ? 'L' : h.includes('Start(B)') ? 'B' : null; // the second time of each
      return {
        date: at('Date'), dc: at('DC'), activity: at('Activity'), ci: at('C/I(Z)'), ciL: at(`C/I(${local})`), co: at('C/O(Z)'), coL: at(`C/O(${local})`), dep: at('From'),
        begin: at('Start(Z)'), beginL: at(`Start(${local})`), arr: at('To'), end: at('Finish(Z)'), endL: at(`Finish(${local})`), local,
        block: at('BH'), turn: at('Turn'), duty: at('DHrs'), fdp: at('FDP'), maxFdp: at('Max FDP'), hotel: at('Hotel'), registration: at('A/C Reg'), ac: at('AC Type'),
      };
    },
    // As the PDF's rows: a C/I row (its time, dep) before the activity, the activity (DC, registration; "[Block: 2:50]",
    // the Hotel cell as printed in info), a C/O row (its time, arr; "[Duty: 9:55] [FDP: 9:25] [Max FDP: 13:00]") after it.
    // Times UTC then local, as the other layouts printing both: "2200-1" + "0000" -> "22:00 Z -1 / 00:00 L",
    // "0725+1" + "0825+1" -> "07:25 Z +1 / 08:25 L +1"; "12:00 L" alone where the file only has local times;
    // "13:10 B" for homebase times. "[Turn: 0:42]" on the flight with it. A line with no date (a hotel, a second
    // flight) is on the date above it.
    rows(data, cols) {
      const out = [];
      const TIME = /^\d{4}([+-]\d)?$/;
      const both = (z, l) => [TIME.test(z.text) && formatTime(z.text, 'Z'), TIME.test(l.text) && formatTime(l.text, cols.local)].filter(Boolean).join(' / ');
      const tags = (...parts) => parts.filter(([, cell]) => /^\d+:\d{2}$/.test(cell.text)).map(([k, cell]) => `[${k}: ${cell.text}]`);
      let d = null;
      for (const row of data) {
        const c = (k) => cellOf(row, cols[k]);
        const dated = ddMonYy(c('date').text);
        if (dated) d = dated;
        else if (c('date').text) d = null; // a footer, not an undated line
        if (!d || !c('activity').text) continue;
        const date = dated ? c('date') : null;
        const ci = TIME.test(c('ci').text) || TIME.test(c('ciL').text);
        if (ci) out.push({ ...d, duty: 'C/I', dep: c('dep').text, begin: both(c('ci'), c('ciL')), _marks: [['date', date], ['ci', c('ci')], ['ci', c('ciL')]] });
        out.push({
          ...d, dc: c('dc').text, duty: c('activity').text, dep: c('dep').text, arr: c('arr').text,
          begin: both(c('begin'), c('beginL')), end: both(c('end'), c('endL')), registration: c('registration').text, ac: c('ac').text,
          info: [...tags(['Turn', c('turn')], ['Block', c('block')]), c('hotel').text].filter(Boolean).join(' '),
          _marks: [['date', ci ? null : date], ['dc', c('dc')], ['duty', c('activity')], ['dep', c('dep')], ['arr', c('arr')],
            ['begin', c('begin')], ['begin', c('beginL')], ['end', c('end')], ['end', c('endL')], ['registration', c('registration')], ['ac', c('ac')],
            ['info', c('turn')], ['info', c('block')], ['info', c('hotel')]],
        });
        if (TIME.test(c('co').text) || TIME.test(c('coL').text)) {
          out.push({
            ...d, duty: 'C/O', arr: c('arr').text, end: both(c('co'), c('coL')),
            info: tags(['Duty', c('duty')], ['FDP', c('fdp')], ['Max FDP', c('maxFdp')]).join(' '),
            _marks: [['co', c('co')], ['co', c('coL')], ['info', c('duty')], ['info', c('fdp')], ['info', c('maxFdp')]],
          });
        }
      }
      return out;
    },
  },
  {
    name: 'crew-flights',
    // one row per flight, with its crew: Flight | Date "03/01/2025" | A/C Type | Tail | Origin | Dest | Depart | Arrive | Block | Credit |
    // Captain | First Officer | Flight Attendant ("051471 Matt Johnson", several in one cell: "063737 Jane Doe 079777 John Roe")
    find(h) {
      if (!['Flight', 'Date', 'Origin', 'Dest', 'Depart', 'Arrive'].every(n => h.includes(n))) return null;
      const at = (n) => (h.includes(n) ? h.indexOf(n) : null);
      return {
        flight: at('Flight'), date: at('Date'), ac: at('A/C Type'), registration: at('Tail'), dep: at('Origin'), arr: at('Dest'),
        begin: at('Depart'), end: at('Arrive'), block: at('Block'), credit: at('Credit'),
        crew: [['CP', at('Captain')], ['FO', at('First Officer')], ['FA', at('Flight Attendant')]].filter(([, i]) => i != null),
      };
    },
    // Times are each airport's local time (SLC 20:40 -> LGB 21:44 with Block 02:04), so "20:40 L".
    // Crew "[CP - 051471 - Matt Johnson][FA - 063737 - Jane Doe][FA - 079777 - John Roe]"; info "[Block: 02:04] [Credit: 01:58]"
    // (some exports print decimal hours, "1.37" -> "01:22").
    rows(data, cols, { dateOf }) {
      const out = [];
      const hoursText = (t) => {
        if (/^\d+:\d{2}$/.test(t)) return t;
        if (!/^\d+\.\d+$/.test(t)) return '';
        const min = Math.round(Number(t) * 60);
        return `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
      };
      for (const row of data) {
        const c = (k) => cellOf(row, cols[k]);
        const d = dateOf(c('date').text);
        if (!d || !AIRPORT_RE.test(c('dep').text)) continue;
        const crew = cols.crew.flatMap(([role, i]) => [...cellOf(row, i).text.matchAll(/(\d{3,})\s+(.+?)(?=\s+\d{3,}\s|$)/g)]
          .map(m => `[${role} - ${m[1]} - ${m[2]}]`)).join('');
        const tags = [['Block', c('block')], ['Credit', c('credit')]].map(([k, cell]) => hoursText(cell.text) && `[${k}: ${hoursText(cell.text)}]`).filter(Boolean);
        out.push({
          ...d, duty: c('flight').text, dep: c('dep').text, begin: timeOf(c('begin').text, 'L'), arr: c('arr').text, end: timeOf(c('end').text, 'L'),
          ac: c('ac').text, registration: c('registration').text, crew, info: tags.join(' '),
          _marks: [['date', c('date')], ['duty', c('flight')], ['dep', c('dep')], ['begin', c('begin')], ['arr', c('arr')], ['end', c('end')],
            ['ac', c('ac')], ['registration', c('registration')], ...cols.crew.map(([, i]) => ['crew', cellOf(row, i)]), ['info', c('block')], ['info', c('credit')]],
        });
      }
      return out;
    },
  },
  {
    name: 'block-times',
    // one row per leg: Employee id | Crew id | Flight "SK7372-20250601-RHO-SVG" | Departure Date "2025-06-01" | Block off "14:18:00" |
    // Arrival Date | Block on | Aircraft Registration | Aircraft Type | Duration (minutes) | Landing (true/false) | PIC | SIC (employee numbers)
    find(h) {
      if (!['Flight', 'Departure Date', 'Block off', 'Arrival Date', 'Block on'].every(n => h.includes(n))) return null;
      const at = (n) => (h.includes(n) ? h.indexOf(n) : null);
      return {
        flight: at('Flight'), date: at('Departure Date'), begin: at('Block off'), endDate: at('Arrival Date'), end: at('Block on'),
        registration: at('Aircraft Registration'), ac: at('Aircraft Type'), block: at('Duration'), pic: at('PIC'), sic: at('SIC'),
      };
    },
    // Duty = the flight number, dep / arr from the flight's key. Times are each airport's local time (RHO 14:18 -> SVG 17:33
    // is the 255 minutes of Duration only with RHO UTC+3, SVG UTC+2), so "14:18 L"; "+1" when Arrival Date is the next day.
    // Info "[Block: 04:15]"; crew "[PIC - 69885][SIC - ...]" (numbers only, as printed).
    rows(data, cols) {
      const out = [];
      const isoDay = (t) => { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(t); return m ? dayOf(+m[3], +m[2] - 1, +m[1]) : null; };
      for (const row of data) {
        const c = (k) => cellOf(row, cols[k]);
        const d = isoDay(c('date').text);
        const key = /^([A-Z0-9]{2,3}\d+[A-Z]?)-\d{8}-([A-Z]{3})-([A-Z]{3})$/.exec(c('flight').text);
        if (!d || !key) continue;
        const arrDay = isoDay(c('endDate').text);
        const days = arrDay ? Math.round((arrDay.ymd - d.ymd) / 86400000) : 0;
        const hhmm = (t) => t.replace(/^(\d{1,2}:\d{2}):\d{2}$/, '$1');
        const min = /^\d+$/.test(c('block').text) ? +c('block').text : null;
        const crew = [['PIC', c('pic')], ['SIC', c('sic')]].filter(([, cell]) => cell.text).map(([role, cell]) => `[${role} - ${cell.text}]`).join('');
        out.push({
          ...d, duty: key[1], dep: key[2], arr: key[3], begin: timeOf(hhmm(c('begin').text), 'L'),
          end: `${timeOf(hhmm(c('end').text), 'L')}${days ? ` ${days > 0 ? '+' : ''}${days}` : ''}`,
          registration: c('registration').text, ac: c('ac').text, crew,
          info: min == null ? '' : `[Block: ${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}]`,
          _marks: [['date', c('date')], ['duty', c('flight')], ['begin', c('begin')], ['end', c('end')], ['registration', c('registration')], ['ac', c('ac')],
            ['crew', c('pic')], ['crew', c('sic')], ['info', c('block')]],
        });
      }
      return out;
    },
  },
  {
    name: 'route-log',
    // a pilot's logbook by day: Date "Jan 02 2025" (empty on a day's next legs) | Code (the day's duty: FLY, DDO, BLANK ...) |
    // Fleet | Rego | PIC ("Y": the pilot) | FO | PAX | Route "MEL-BNE" | Takeoff | Landing (DAY / NIGHT) | Approach | Instrument Minutes |
    // Day Hours | Night Hours. No times of day.
    find(h) {
      if (!['Date', 'Code', 'Rego', 'Route', 'Day Hours', 'Night Hours'].every(n => h.includes(n))) return null;
      const at = (n) => (h.includes(n) ? h.indexOf(n) : null);
      return {
        date: at('Date'), code: at('Code'), ac: at('Fleet'), registration: at('Rego'), pic: at('PIC'), fo: at('FO'), route: at('Route'),
        takeoff: at('Takeoff'), landing: at('Landing'), approach: at('Approach'), instrument: at('Instrument Minutes'), day: at('Day Hours'), night: at('Night Hours'),
      };
    },
    // A day's code is a row of its own (date, duty), before its legs; a leg: dep / arr from the route, ac, registration,
    // crew "[FO - NAME]" (and "[PIC - NAME]" when PIC is a name, not "Y"), info "[Day: 2:17] [Night: 1:00]",
    // "[Takeoff Day: 1] [Landing Night: 1]" (Takeoff / Landing "DAY" / "NIGHT": the pilot's one), as printed "[Approach: ILS] [Instrument: 30]".
    rows(data, cols) {
      const out = [];
      let d = null;
      for (const row of data) {
        const c = (k) => cellOf(row, cols[k]);
        const dated = monDdYyyy(c('date').text);
        if (dated) d = dated;
        else if (c('date').text || rowTexts(row).every(t => !t)) d = null; // a blank line ends the days (the fleet totals below it)
        if (!d) continue;
        const date = dated ? c('date') : null;
        if (c('code').text) out.push({ ...d, duty: c('code').text, _marks: [['date', date], ['duty', c('code')]] });
        const route = /^([A-Z]{3})-([A-Z]{3})$/.exec(c('route').text);
        if (!route) continue;
        const crew = [['PIC', c('pic')], ['FO', c('fo')]].filter(([, cell]) => cell.text && cell.text !== 'Y').map(([role, cell]) => `[${role} - ${cell.text}]`).join('');
        const info = [
          ...[['Day', c('day')], ['Night', c('night')]].filter(([, cell]) => /^\d+:\d{2}$/.test(cell.text)).map(([k, cell]) => `[${k}: ${cell.text}]`),
          ...[['Takeoff', c('takeoff')], ['Landing', c('landing')]].filter(([, cell]) => /^(DAY|NIGHT)$/i.test(cell.text))
            .map(([k, cell]) => `[${k} ${cell.text[0].toUpperCase()}${cell.text.slice(1).toLowerCase()}: 1]`),
          c('approach').text && `[Approach: ${c('approach').text}]`,
          /^[1-9]\d*$/.test(c('instrument').text) && `[Instrument: ${c('instrument').text}]`,
        ].filter(Boolean).join(' ');
        out.push({
          ...d, dep: route[1], arr: route[2], ac: c('ac').text, registration: c('registration').text, crew, info,
          _marks: [['date', c('code').text ? null : date], ['dep', c('route')], ['arr', c('route')], ['ac', c('ac')], ['registration', c('registration')],
            ['crew', c('pic')], ['crew', c('fo')], ['info', c('day')], ['info', c('night')], ['info', c('takeoff')], ['info', c('landing')],
            ['info', c('approach')], ['info', c('instrument')]],
        });
      }
      return out;
    },
  },
  {
    name: 'calendar-events',
    // a calendar export saved as CSV: dtstart "2024-05-24T00:40:00Z" | dtend | ... | description | ... | summary, one event per line,
    // its details in the description: "F8521 YKF - YYC\nCI 0040Z / 2040L\nSTD 0140Z / 2140L\nSTA 0555Z / 2355L\nRD: L,Y,X\n
    // Duration: 05:03, BLH: 04:07\nSTC: J\nAircraft: 7M8 - 7M8 - 7M8  - C-FLQZ" or "PRPM (Pilot Res PM) YKF\nCI ..\nStart ..\nEnd ..\nCO ..".
    find(h) {
      if (!['dtstart', 'dtend', 'description', 'summary'].every(n => h.includes(n))) return null;
      return { date: h.indexOf('dtstart'), description: h.indexOf('description') };
    },
    // Events in time order (the export is not). Dated by dtstart's (UTC) day; times "00:40 Z / 20:40 L -1", day offsets
    // from that date. A C/I row (CI) before the event, a C/O row (CO) after it; a flight: STD / STA, ac and registration
    // from "Aircraft", info "[Block: 04:07] [Duration: 05:03] [RD: L,Y,X] [STC: J]"; another event: Start / End, its
    // name in info ("[Pilot Res PM] [Duration: 09:59]").
    rows(data, cols) {
      const events = [];
      for (const row of data) {
        const c = (k) => cellOf(row, cols[k]);
        const start = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(c('date').text);
        const lines = c('description').text.split(/\\n|\n/).map(t => t.trim()).filter(Boolean);
        if (!start || !lines.length) continue;
        events.push({ c, start, lines, at: Date.UTC(+start[1], +start[2] - 1, +start[3], +start[4], +start[5]) });
      }
      events.sort((a, b) => a.at - b.at);
      const out = [];
      for (const { c, start, lines, at } of events) {
        const d = dayOf(+start[3], +start[2] - 1, +start[1]);
        const field = (name) => lines.find(l => l.startsWith(`${name} `) || l.startsWith(`${name}:`))?.slice(name.length).replace(/^:/, '').trim() || '';
        // "0040Z / 2040L": UTC from the event's start on (a time well before the one above it is the next day), local by its offset
        let last = at, first = true;
        const time = (text) => {
          const m = /^(\d{2})(\d{2})Z\s*\/\s*(\d{2})(\d{2})L$/.exec(text);
          if (!m) return '';
          const zMin = +m[1] * 60 + +m[2], lMin = +m[3] * 60 + +m[4];
          let utc = Date.UTC(new Date(last).getUTCFullYear(), new Date(last).getUTCMonth(), new Date(last).getUTCDate()) + zMin * 60000;
          if (utc < last - (first ? 6 * 3600000 : 0)) utc += 86400000; // (a flight's STD may be a little before its dtstart)
          last = utc;
          first = false;
          const offset = ((lMin - zMin + 720 + 1440 * 2) % 1440) - 720; // local - UTC, minutes
          const days = (t) => Math.floor((t - d.ymd) / 86400000);
          const off = (n) => (n ? ` ${n > 0 ? '+' : ''}${n}` : '');
          return `${m[1]}:${m[2]} Z${off(days(utc))} / ${m[3]}:${m[4]} L${off(days(utc + offset * 60000))}`;
        };
        const head = /^(\S+)(?:\s+\((.*)\))?\s+([A-Z]{3})(?:\s+-\s+([A-Z]{3}))?$/.exec(lines[0]);
        if (!head) continue;
        const [, code, name, dep, arr] = head;
        const marks = [['date', c('date')], ['info', c('description')]];
        const ci = time(field('CI'));
        if (ci) out.push({ ...d, duty: 'C/I', dep, begin: ci, _marks: marks });
        const flight = !!field('STD');
        const begin = time(field(flight ? 'STD' : 'Start')), end = time(field(flight ? 'STA' : 'End'));
        const [duration, blh] = [/^(\d+:\d{2})/.exec(field('Duration'))?.[1], /BLH:\s*(\d+:\d{2})/.exec(field('Duration'))?.[1]];
        const aircraft = field('Aircraft').split(/\s+-\s+/).map(t => t.trim()).filter(Boolean);
        const info = [
          name && `[${name}]`, blh && `[Block: ${blh}]`, duration && `[Duration: ${duration}]`,
          field('RD') && `[RD: ${field('RD')}]`, field('STC') && `[STC: ${field('STC')}]`, field('Hotel') && field('Hotel') !== '-' && `[Hotel: ${field('Hotel')}]`,
        ].filter(Boolean).join(' ');
        out.push({
          ...d, duty: code, dep, arr: arr || dep, begin, end, ac: flight ? aircraft[0] || '' : '', registration: flight && aircraft.length > 1 ? aircraft.at(-1) : '',
          info, _marks: marks,
        });
        const co = time(field('CO'));
        if (co) out.push({ ...d, duty: 'C/O', arr: arr || dep, end: co, _marks: [] });
      }
      return out;
    },
  },
  {
    name: 'crew-duties',
    // a crew planning export, one line per duty or leg (KLM style): klm_id | first_name | last_name | fleet_cd | rank_cd | ... |
    // duty_start "13/01/2013 15:10" | act | act_assign_sdc | trip_assign_sdc | trip_sdc | item_sdc | FOB | item_work_cd (OP / PS) |
    // flight | flt_dt_utc | dep_stat | arr_stat | subtype | ac_reg | ... | leg_start | leg_end | flh (minutes) | ... | duty_en | duty_mins
    find(h) {
      if (!['duty_start', 'act', 'flight', 'dep_stat', 'arr_stat', 'leg_start', 'leg_end', 'duty_en'].every(n => h.includes(n))) return null;
      const at = (n) => (h.includes(n) ? h.indexOf(n) : null);
      return {
        date: at('duty_start'), start: at('duty_start'), act: at('act'), rank: at('rank_cd'), fob: at('FOB'), work: at('item_work_cd'),
        flight: at('flight'), dep: at('dep_stat'), arr: at('arr_stat'), ac: at('subtype'), registration: at('ac_reg'),
        off: at('leg_start'), on: at('leg_end'), flh: at('flh'), end: at('duty_en'), mins: at('duty_mins'),
        sdc: [['Act SDC', at('act_assign_sdc')], ['Trip assign SDC', at('trip_assign_sdc')], ['Trip SDC', at('trip_sdc')], ['Item SDC', at('item_sdc')]].filter(([, i]) => i != null),
      };
    },
    // Times UTC ("flt_dt_utc"; a leg's off / on are its flh minutes apart). An activity (act: RV, VN, RT-E ...) is a row
    // of its own (duty_start - duty_en). The legs of one duty (the lines with its duty_start) make a C/I row (duty_start),
    // a row per leg (duty = flight, ac = subtype, registration = ac_reg, dc "PS" for a positioning leg, info "[Block: 10:31]",
    // "[FOB: FO]" when the pilot flies in another function than their rank) and a C/O row (duty_en, "[Duty: 12:23]").
    // The special duty codes in info as "[Trip assign SDC: V+]" (an activity or leg printed once per code: one row with all of
    // them). Lines without a duty_start (the header's rank lines) are left out.
    rows(data, cols, { dateOf }) {
      const out = [];
      const stamp = (cell) => {
        const m = /^(\S+)\s+(\d{1,2}:\d{2})$/.exec(cell.text);
        const d = m && dateOf(m[1]);
        return d ? { ...d, time: m[2] } : null;
      };
      const hhmm = (min) => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
      // "03:03" of a later day than `from`: "03:03 Z +1"
      const z = (s, from = s) => { const n = Math.round((s.ymd - from.ymd) / 86400000); return formatTime(`${s.time.replace(':', '').padStart(4, '0')}${n ? `+${n}` : ''}`, 'Z'); };
      let duty = null; // { key, start, end, mins, ci, co, legs }
      const flush = () => {
        if (!duty) return;
        const { start, end } = duty;
        out.push({ ...start, duty: 'C/I', dep: duty.legs[0]?.dep || '', begin: z(start), _marks: [['date', duty.startCell], ['ci', duty.startCell]] });
        out.push(...duty.legs);
        if (end) {
          out.push({
            ...start, duty: 'C/O', arr: duty.legs.at(-1)?.arr || '', end: z(end, start),
            info: /^\d+$/.test(duty.mins.text) ? `[Duty: ${hhmm(+duty.mins.text)}]` : '',
            _marks: [['co', duty.endCell], ['info', duty.mins]],
          });
        }
        duty = null;
      };
      for (const row of data) {
        const c = (k) => cellOf(row, cols[k]);
        const start = stamp(c('start'));
        if (!start) continue;
        const end = stamp(c('end'));
        const sdc = cols.sdc.map(([k, i]) => [k, cellOf(row, i)]).filter(([, cell]) => cell.text);
        const sdcInfo = sdc.map(([k, cell]) => `[${k}: ${cell.text}]`);
        // the same activity or leg on two lines, one per special duty code: one row with both codes
        const merge = (prev, row) => {
          if (!prev || ['date', 'duty', 'begin', 'end', 'dep', 'arr'].some(k => (prev[k] || '') !== (row[k] || ''))) return false;
          const tags = [...new Set([...(prev.info || '').split(/(?<=\])\s+/), ...(row.info || '').split(/(?<=\])\s+/)].filter(Boolean))];
          prev.info = tags.join(' ');
          prev._marks.push(...row._marks.filter(([f]) => f === 'info'));
          return true;
        };
        if (!c('flight').text) {
          flush();
          if (!c('act').text) continue;
          const act = {
            ...start, duty: c('act').text, begin: z(start), end: end ? z(end, start) : '', info: sdcInfo.join(' '),
            _marks: [['date', c('start')], ['duty', c('act')], ['begin', c('start')], ['end', c('end')], ...sdc.map(([, cell]) => ['info', cell])],
          };
          if (!merge(out.at(-1), act)) out.push(act);
          continue;
        }
        if (duty && duty.key !== c('start').text) flush();
        duty ||= { key: c('start').text, start, end, startCell: c('start'), endCell: c('end'), mins: c('mins'), legs: [] };
        const off = stamp(c('off')), on = stamp(c('on'));
        if (!off) continue;
        const fob = c('fob').text && c('fob').text !== c('rank').text ? `[FOB: ${c('fob').text}]` : '';
        const leg = {
          ...off, dc: c('work').text === 'PS' ? 'PS' : '', duty: c('flight').text, dep: c('dep').text, arr: c('arr').text,
          begin: z(off), end: on ? z(on, off) : '', ac: c('ac').text, registration: c('registration').text,
          info: [/^\d+$/.test(c('flh').text) && `[Block: ${hhmm(+c('flh').text)}]`, fob, ...sdcInfo].filter(Boolean).join(' '),
          _marks: [['date', c('off')], ['duty', c('flight')], ['dep', c('dep')], ['arr', c('arr')], ['begin', c('off')], ['end', c('on')], ['ac', c('ac')],
            ['registration', c('registration')], ['info', c('flh')], ['info', fob ? c('fob') : null], ...sdc.map(([, cell]) => ['info', cell])],
        };
        if (!merge(duty.legs.at(-1), leg)) duty.legs.push(leg);
      }
      flush();
      return out;
    },
  },
  {
    name: 'emirates-detailed',
    // "Emirates Crew Roster (Detailed Report)" (one month; "Staff : | 444123 | Name : | ... | 01/03/2025" above a calendar of
    // codes, then a line per day): Day/Date "05-WED" | Duty/Trip Code | Label | Report | Time(Dep-Arv) "14:00-18:45" |
    // Duty Details "EK9919 [DWC-ZAZ]" | A/C | End | Block Hours "07: 45". A day with two legs holds two of each
    // ("09:25-11:15 12:45-01:15(+)", "EK9238 [DWC-IKA] EK9238 [IKA-HKG]", "77X 77X", "02: 20 08: 00").
    // One export keeps those columns in its header line; the other merges its header cells, its values then in fixed columns.
    find(h) {
      if (!['Day/Date', 'Label', 'Report', 'Time(Dep-Arv)', 'Duty Details'].every(n => h.includes(n))) return null;
      if (h.includes('Duty/Trip Code')) {
        const at = (n) => h.indexOf(n);
        return { day: at('Day/Date'), code: at('Duty/Trip Code'), label: at('Label'), report: at('Report'), times: at('Time(Dep-Arv)'),
          details: at('Duty Details'), ac: at('A/C'), end: at('End'), block: at('Block Hours') };
      }
      return { day: 1, code: 8, label: 11, report: 13, times: 14, details: 15, ac: 18, end: 21, block: 25 };
    },
    // Times are each airport's local time (DWC 14:00 -> ZAZ 18:45 is the Block 07:45 only so): "14:00 L", "(+)" -> "+1".
    // A day with legs: a C/I row (Report, dep), a row per leg (duty = the flight, dep / arr from "[DWC-ZAZ]", ac, info
    // "[Block: 07:45]", the first leg also "[Trip: 9919] [Label: M]"), a C/O row (End, arr). Another day: one row,
    // duty = the code (else the details: "Rest Day"), its details as "[XX: Day Off]", Report - End as its times.
    rows(data, cols, { periodStart }) {
      const out = [];
      if (!periodStart) return out;
      const cal = { y: new Date(periodStart.ymd).getUTCFullYear(), m: new Date(periodStart.ymd).getUTCMonth(), last: 0 };
      const t = (text) => { const m = /^(\d{2}:\d{2})\s*(\(\+\))?$/.exec(text); return m ? `${formatTime(m[1].replace(':', ''), 'L')}${m[2] ? ' +1' : ''}` : ''; };
      for (const row of data) {
        const c = (k) => cellOf(row, cols[k]);
        const m = /^(\d{2})-([A-Z]{3})$/.exec(c('day').text);
        if (!m) continue;
        if (+m[1] < cal.last) { cal.m += 1; if (cal.m > 11) { cal.m = 0; cal.y += 1; } }
        cal.last = +m[1];
        const d = dayOf(+m[1], cal.m, cal.y);
        const legs = [...c('details').text.matchAll(/(\S+) \[([A-Z]{3})-([A-Z]{3})\]/g)];
        const code = c('code').text.split(/\s+/)[0] || '';
        const tags = [code && code !== legs[0]?.[1] && `[Trip: ${code}]`, c('label').text && `[Label: ${c('label').text}]`];
        if (legs.length) {
          const times = [...c('times').text.matchAll(/(\d{2}:\d{2})-(\d{2}:\d{2})(\(\+\))?/g)];
          const acs = c('ac').text.split(/\s+/).filter(Boolean);
          const blocks = [...c('block').text.matchAll(/(\d+):\s*(\d{2})/g)].map(b => `${b[1].padStart(2, '0')}:${b[2]}`);
          if (t(c('report').text)) out.push({ ...d, duty: 'C/I', dep: legs[0][2], begin: t(c('report').text), _marks: [['date', c('day')], ['ci', c('report')]] });
          legs.forEach((leg, i) => {
            const tm = times[i];
            out.push({
              ...d, duty: leg[1], dep: leg[2], arr: leg[3], begin: tm ? t(tm[1]) : '', end: tm ? t(`${tm[2]}${tm[3] || ''}`) : '', ac: acs[i] || '',
              info: [blocks[i] && blocks[i] !== '00:00' && `[Block: ${blocks[i]}]`, ...(i ? [] : tags)].filter(Boolean).join(' '),
              _marks: [['date', i || t(c('report').text) ? null : c('day')], ['duty', c('details')], ['dep', c('details')], ['arr', c('details')], ['begin', c('times')], ['end', c('times')],
                ['ac', c('ac')], ['info', c('block')], ...(i ? [] : [['info', c('code')], ['info', c('label')]])],
            });
          });
          if (t(c('end').text)) out.push({ ...d, duty: 'C/O', arr: legs.at(-1)[3], end: t(c('end').text), _marks: [['co', c('end')]] });
        } else {
          const details = c('details').text === '-' ? '' : c('details').text;
          const duty = code || details;
          if (!duty) continue;
          out.push({
            ...d, duty, begin: t(c('report').text), end: t(c('end').text),
            info: [code && details && `[${code}: ${details}]`, c('label').text && `[Label: ${c('label').text}]`].filter(Boolean).join(' '),
            _marks: [['date', c('day')], ['duty', code ? c('code') : c('details')], ['begin', c('report')], ['end', c('end')], ['info', code ? c('details') : null], ['info', c('label')]],
          });
        }
      }
      return out;
    },
  },
  {
    name: 'spanish-logbook',
    // an EASA pilot logbook in Spanish: FECHA | SALIDA (Lugar, Hora) | LLEGADA (Lugar, Hora) | AERONAVE (Fab.mod.var., Matricula) |
    // TIEMPO MONOPILOTO (SE, ME) | TIEMPO MULTIPILOTO | TIEMPO TOTAL VUELO | NOMBRE PIC | ATERRIZAJES (Dia, Noche) |
    // HORA Y CONDICION (Noche, IFR) | FUNCION (Piloto, Co-piloto, Dbl-mando, Instructor) | SESION DE ENTRENADOR SINTETICO
    // (Fecha, Tipo, Tot. hora sesion) | OBSERVACIONES | REMARK; times as "01.18" (1 h 18), "--" for none
    find(h) {
      if (!['FECHA', 'SALIDA', 'LLEGADA', 'AERONAVE', 'TIEMPO TOTAL VUELO'].every(n => h.includes(n))) return null;
      const at = (n) => h.indexOf(n);
      const dep = at('SALIDA'), arr = at('LLEGADA'), ac = at('AERONAVE'), land = at('ATERRIZAJES'), cond = at('HORA Y CONDICION'), fn = at('FUNCION'), sim = at('SESION DE ENTRENADOR SINTETICO');
      return {
        date: at('FECHA'), dep, begin: dep + 1, arr, end: arr + 1, ac, registration: ac + 1, total: at('TIEMPO TOTAL VUELO'), pic: at('NOMBRE PIC'),
        ldDay: land, ldNight: land + 1, night: cond, ifr: cond + 1, fnPic: fn, fnCo: fn + 1, fnDual: fn + 2, fnInstr: fn + 3,
        simDate: sim, simType: sim + 1, simTime: sim + 2, remarks: at('OBSERVACIONES'), remark: at('REMARK'),
      };
    },
    // Times UTC (LEMD 13:57 -> LPPT 15:15 is the 01.18 flown only so): "13:57 Z". Info in column order: "[Flight: 01:18]",
    // landings "[Landing Day: 1] [Landing Night: 1]", "[Night: 00:18] [IFR: 01:18]", the function "[PIC: ..] [CoPilot: ..]
    // [Dual: ..] [Instructor: ..]", remarks as printed; crew "[PIC - MILLAN]". A simulator session: duty its type, "[Sim: 04:00]".
    // Times of 00.00 and "--" are left out.
    rows(data, cols, { dateOf }) {
      const out = [];
      const dur = (cell) => { const m = /^(\d{1,3})[.:](\d{2})$/.exec(cell.text); return m && +(m[1] + m[2]) ? `${m[1].padStart(2, '0')}:${m[2]}` : ''; };
      const text = (cell) => (cell.text === '--' ? '' : cell.text);
      for (const row of data) {
        const c = (k) => cellOf(row, cols[k]);
        const d = dateOf(c('date').text), simDay = dateOf(c('simDate').text);
        if (!d && !simDay) continue; // a simulator session only: FECHA "--"
        const durs = [['Flight', 'total'], ['Night', 'night'], ['IFR', 'ifr'], ['PIC', 'fnPic'], ['CoPilot', 'fnCo'], ['Dual', 'fnDual'], ['Instructor', 'fnInstr']]
          .map(([k, f]) => [k, f, dur(c(f))]);
        const tag = (k) => { const x = durs.find(([n]) => n === k); return x[2] && `[${k}: ${x[2]}]`; };
        const remarks = [text(c('remarks')), text(c('remark'))].filter(Boolean);
        if (d && AIRPORT_ICAO_OR_IATA.test(c('dep').text)) {
          out.push({
            ...d, dep: c('dep').text, begin: timeOf(c('begin').text, 'Z'), arr: c('arr').text, end: timeOf(c('end').text, 'Z'),
            ac: text(c('ac')), registration: text(c('registration')), crew: text(c('pic')) ? `[PIC - ${c('pic').text}]` : '',
            info: [tag('Flight'), ...countTags([['Landing Day', c('ldDay')], ['Landing Night', c('ldNight')]]), tag('Night'), tag('IFR'),
              tag('PIC'), tag('CoPilot'), tag('Dual'), tag('Instructor'), ...remarks].filter(Boolean).join(' '),
            _marks: [['date', c('date')], ['dep', c('dep')], ['begin', c('begin')], ['arr', c('arr')], ['end', c('end')], ['ac', c('ac')], ['registration', c('registration')],
              ['crew', c('pic')], ...durs.filter(x => x[2]).map(([, f]) => ['info', c(f)]), ...countMarks(c('ldDay'), c('ldNight')), ['info', c('remarks')], ['info', c('remark')]],
          });
        }
        if (text(c('simType')) && (simDay || d)) {
          out.push({
            ...(simDay || d), duty: c('simType').text, info: [dur(c('simTime')) && `[Sim: ${dur(c('simTime'))}]`, ...(AIRPORT_ICAO_OR_IATA.test(c('dep').text) ? [] : remarks)].filter(Boolean).join(' '),
            _marks: [['date', c('simDate')], ['duty', c('simType')], ['info', c('simTime')]],
          });
        }
      }
      return out;
    },
  },
  {
    name: 'flight-time-report',
    // "Flight Time Report" (pilot, From: / To:, totals above): Flight Date "10-DEC-2024" | A/C Type | Flt No | A/C Reg | From | To |
    // ATD | ATA | Block | Stick | Take off (Y) | Landing (Y) | SDC | Crew Name "GaganChadha(420949-CA),PaulLeRoux(455487-CA)" | DE Time
    find(h) {
      if (!['Flight Date', 'Flt No', 'From', 'To', 'ATD', 'ATA', 'Stick'].every(n => h.includes(n))) return null;
      const at = (n) => (h.includes(n) ? h.indexOf(n) : null);
      return {
        date: at('Flight Date'), ac: at('A/C Type'), flight: at('Flt No'), registration: at('A/C Reg'), dep: at('From'), arr: at('To'),
        begin: at('ATD'), end: at('ATA'), block: at('Block'), stick: at('Stick'), takeoff: at('Take off'), landing: at('Landing'), sdc: at('SDC'), crew: at('Crew Name'),
      };
    },
    // One clock for ATD and ATA (DXB 22:01 -> ADL 10:25 is the Block 12:24), UTC: "22:01 Z", "10:25 Z +1" when the
    // arrival's time is before the departure's. Info "[Block: 12:24] [Stick: 12:24]", the pilot's take-off / landing (Y)
    // "[Takeoff Day/Night: 1] [Landing Day/Night: 1]" (no day or night here), "[SDC: M]"; crew "[CA - 420949 - GaganChadha]".
    rows(data, cols) {
      const out = [];
      const minutes = (t) => { const m = /^(\d{1,2}):(\d{2})$/.exec(t); return m ? +m[1] * 60 + +m[2] : null; };
      for (const row of data) {
        const c = (k) => cellOf(row, cols[k]);
        const m = /^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/.exec(c('date').text);
        const mon = m ? MONTHS.findIndex(x => x.toLowerCase() === m[2].toLowerCase()) : -1;
        if (mon < 0 || !AIRPORT_RE.test(c('dep').text)) continue;
        const off = minutes(c('begin').text), on = minutes(c('end').text);
        const crew = [...c('crew').text.matchAll(/([^,(]+)\((\d+)-([A-Z]+)\)/g)].map(x => `[${x[3]} - ${x[2]} - ${x[1].trim()}]`).join('');
        const info = [
          ...[['Block', c('block')], ['Stick', c('stick')]].filter(([, cell]) => /^\d+:\d{2}$/.test(cell.text)).map(([k, cell]) => `[${k}: ${cell.text}]`),
          ...[['Takeoff', c('takeoff')], ['Landing', c('landing')]].filter(([, cell]) => cell.text === 'Y').map(([k]) => `[${k} Day/Night: 1]`),
          c('sdc').text && `[SDC: ${c('sdc').text}]`,
        ].filter(Boolean).join(' ');
        out.push({
          ...dayOf(+m[1], mon, +m[3]), duty: c('flight').text, dep: c('dep').text, arr: c('arr').text,
          begin: timeOf(c('begin').text, 'Z'), end: timeOf(c('end').text, 'Z', off != null && on != null && on < off),
          ac: c('ac').text, registration: c('registration').text, crew, info,
          _marks: [['date', c('date')], ['duty', c('flight')], ['dep', c('dep')], ['arr', c('arr')], ['begin', c('begin')], ['end', c('end')],
            ['ac', c('ac')], ['registration', c('registration')], ['crew', c('crew')], ['info', c('block')], ['info', c('stick')],
            ['info', c('takeoff').text === 'Y' ? c('takeoff') : null], ['info', c('landing').text === 'Y' ? c('landing') : null], ['info', c('sdc')]],
        });
      }
      return out;
    },
  },
  {
    name: 'blocks-logbook',
    // business-aviation logbook export: Crew | Blocks Off Estimated | Blocks Off Actual | From Airport (AF_DEP) | To Airport (AF_ARR) |
    // Blocks On Estimated | Blocks On Actual | Funct. | ... | Booking | Flight # | Aircraft Registration (AC_REG) | Aircraft Model (AC_MODEL) |
    // ... | Takeoffs Day | Takeoffs Night | ... | Landings Day | Landings Night | ... | Block Time Actual (TIME_TOTAL) | Flight Time Actual |
    // Flight Time Pilot | PIC Time | SIC Time | Night Time | Inst Time ("1h55", "48'"); "06.07.2024 05:05" stamps (UTC)
    find(h) {
      const at = (...names) => { const i = h.findIndex(t => names.includes(t)); return i < 0 ? null : i; };
      const cols = {
        crew: at('Crew'), off: at('Blocks Off Actual'), dep: at('From Airport', 'AF_DEP'), arr: at('To Airport', 'AF_ARR'), on: at('Blocks On Actual'),
        flight: at('Flight #'), registration: at('Aircraft Registration', 'AC_REG'), ac: at('Aircraft Model', 'AC_MODEL'), sim: at('SIM Time'),
        tkDay: at('Takeoffs Day'), tkNight: at('Takeoffs Night'), ldDay: at('Landings Day'), ldNight: at('Landings Night'),
        block: at('Block Time Actual', 'TIME_TOTAL'), flt: at('Flight Time Actual'), pic: at('PIC Time'), sic: at('SIC Time'), night: at('Night Time'), inst: at('Inst Time'),
      };
      return ['off', 'dep', 'arr', 'on', 'block'].every(k => cols[k] != null) ? cols : null;
    },
    // A row per flight: begin / end = blocks off / on (actual), "+1" on a later day; duty the flight number; crew "[Crew - Quentin Roland]"
    // per name; info "[Block: 01:55] [Flight: 01:42] [Takeoff Day: 1] [Landing Day: 1] [PIC: 01:55] [SIC: ..] [Night: ..] [IFR: ..] [Sim: ..]".
    rows(data, cols) {
      const out = [];
      const dur = (t) => {
        const m = /^(?:(\d+)h)?(\d{2})?'?$/.exec(String(t || '').trim());
        if (!m || (!m[1] && !m[2])) return '';
        const mins = (+(m[1] || 0)) * 60 + +(m[2] || 0);
        return mins ? `${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}` : '';
      };
      const stamp = (cell) => {
        const m = /^(\d{2})\.(\d{2})\.(\d{4}) (\d{2}):(\d{2})$/.exec(cell.text);
        if (!m) return null;
        const it = cell.items[0];
        return { day: dayOf(+m[1], +m[2] - 1, +m[3]), hhmm: `${m[4]}:${m[5]}`, timeCell: { items: it ? [{ ...it, text: `${m[4]}:${m[5]}`, _src: it._src || it, _off: (it._off || 0) + 11 }] : [] } };
      };
      for (const row of data) {
        const c = (k) => cellOf(row, cols[k]);
        const off = stamp(c('off')), on = stamp(c('on'));
        if (!off || !AIRPORT_ICAO_OR_IATA.test(c('dep').text)) continue;
        const info = [
          ...[['Block', 'block'], ['Flight', 'flt']].filter(([, k]) => dur(c(k).text)).map(([n, k]) => `[${n}: ${dur(c(k).text)}]`),
          ...countTags([['Takeoff Day', c('tkDay')], ['Takeoff Night', c('tkNight')], ['Landing Day', c('ldDay')], ['Landing Night', c('ldNight')]]),
          ...[['PIC', 'pic'], ['SIC', 'sic'], ['Night', 'night'], ['IFR', 'inst'], ['Sim', 'sim']].filter(([, k]) => dur(c(k).text)).map(([n, k]) => `[${n}: ${dur(c(k).text)}]`),
        ].join(' ');
        out.push({
          ...off.day, duty: c('flight').text, dep: c('dep').text, arr: c('arr').text, begin: formatTime(off.hhmm, 'Z'),
          end: on ? `${formatTime(on.hhmm, 'Z')}${on.day.ymd > off.day.ymd ? ' +1' : ''}` : '',
          registration: c('registration').text, ac: c('ac').text,
          crew: c('crew').text.split(/\s*,\s*/).filter(Boolean).map(n => `[Crew - ${n}]`).join(''), info,
          _marks: [['date', c('off')], ['duty', c('flight')], ['dep', c('dep')], ['arr', c('arr')], ['begin', off.timeCell], ['end', on?.timeCell], ['registration', c('registration')],
            ['ac', c('ac')], ['crew', c('crew')], ...['block', 'flt', 'pic', 'sic', 'night', 'inst', 'sim'].filter(k => dur(c(k).text)).map(k => ['info', c(k)]),
            ...countMarks(c('tkDay'), c('tkNight'), c('ldDay'), c('ldNight'))],
        });
      }
      return out;
    },
  },
  {
    name: 'duty-legs',
    // FTL record, a line per leg: Date | AC | Funct. | Duty "EGLK - EGAE" (or a code: OFF) | Start Duty | Off-Block | Take Off | Ldg | On-Block |
    // Check-Out | Reason | Break time | Sct | Flight Time | Block Time (DP) | 28d | 3m | 12m | ... | Flight Duty Period (act) | ... | Duty Period (DP) | ...
    find(h) {
      const at = (n) => { const i = h.indexOf(n); return i < 0 ? null : i; };
      if (!['Start Duty', 'Off-Block', 'On-Block', 'Check-Out'].every(n => h.includes(n))) return null;
      return {
        date: at('Date'), registration: at('AC'), duty: at('Duty'), ci: at('Start Duty'), off: at('Off-Block'), takeoff: at('Take Off'), landing: at('Ldg'), on: at('On-Block'),
        co: at('Check-Out'), flt: at('Flight Time'), block: at('Block Time (DP)'), fdp: at('Flight Duty Period (act)'), dp: at('Duty Period (DP)'),
      };
    },
    // Start Duty -> a C/I row, Check-Out -> a C/O row with the duty's "[Flight: 02:16] [Block: 02:45] [FDP: 07:55] [Duty: 08:10]";
    // a leg "EGLK - EGAE" with off / take-off / landing / on (UTC); a code ("OFF") with its start / end.
    rows(data, cols, { dateOf }) {
      const out = [];
      const dur = (cell) => (/^\d{1,2}:\d{2}$/.test(cell.text) && /[1-9]/.test(cell.text) ? cell.text.padStart(5, '0') : '');
      for (const row of data) {
        const c = (k) => cellOf(row, cols[k]);
        const d = dateOf(c('date').text);
        if (!d) continue;
        const leg = /^([A-Z]{3,4}) - ([A-Z]{3,4})$/.exec(c('duty').text);
        if (!leg) {
          if (c('duty').text) out.push({ ...d, duty: c('duty').text, begin: timeOf(c('ci').text, 'Z'), end: timeOf(c('co').text, 'Z'), _marks: [['date', c('date')], ['duty', c('duty')], ['begin', c('ci')], ['end', c('co')]] });
          continue;
        }
        if (c('ci').text) out.push({ ...d, duty: 'C/I', dep: leg[1], begin: timeOf(c('ci').text, 'Z'), _marks: [['ci', c('ci')]] });
        out.push({
          ...d, dep: leg[1], arr: leg[2], registration: c('registration').text,
          begin: timeOf(c('off').text, 'Z'), takeoff: timeOf(c('takeoff').text, 'Z'), landing: timeOf(c('landing').text, 'Z'), end: timeOf(c('on').text, 'Z'),
          _marks: [['date', c('date')], ['registration', c('registration')], ...[['dep', 1, 0], ['arr', 2, c('duty').text.length - leg[2].length]].map(([f, g, off]) => {
            const it = c('duty').items[0];
            return [f, { items: it ? [{ ...it, text: leg[g], _src: it._src || it, _off: (it._off || 0) + off }] : [] }];
          }),
            ['begin', c('off')], ['takeoff', c('takeoff')], ['landing', c('landing')], ['end', c('on')]],
        });
        if (c('co').text) {
          const info = [['Flight', 'flt'], ['Block', 'block'], ['FDP', 'fdp'], ['Duty', 'dp']].filter(([, k]) => dur(c(k))).map(([n, k]) => `[${n}: ${dur(c(k))}]`).join(' ');
          out.push({ ...d, duty: 'C/O', arr: leg[2], end: timeOf(c('co').text, 'Z'), info, _marks: [['co', c('co')], ...['flt', 'block', 'fdp', 'dp'].filter(k => dur(c(k))).map(k => ['info', c(k)])] });
        }
      }
      return out;
    },
  },
  {
    name: 'duty-sectors',
    // duty list ("Generated 20/05/20 10:26 - AHK1555 ..."): Duty Start "05/06/2020 1100L" | Flt/GD | SD | Sector "HKG-TPE" | A/C | Dep "1900L" |
    // Arr "2050L" | Duty End "07/06/2020 0020L"; the duty's later legs have no Duty Start; day codes alone ("DO", "O").
    find(h) {
      if (!['Duty Start', 'Flt/GD', 'Sector', 'Dep', 'Arr', 'Duty End'].every(n => h.includes(n))) return null;
      const at = (n) => { const i = h.indexOf(n); return i < 0 ? null : i; };
      return { date: at('Duty Start'), duty: at('Flt/GD'), sd: at('SD'), sector: at('Sector'), ac: at('A/C'), dep: at('Dep'), arr: at('Arr'), end: at('Duty End') };
    },
    // Duty Start -> a C/I row, Duty End -> a C/O row ("+1" on a later day); a leg dep-arr with its local times ("+1" when it lands
    // earlier than it left), "[SD: CD]"; a code with a duty start / end: one row with those times.
    rows(data, cols, { dateOf }) {
      const out = [];
      let cur = null;
      const stamp = (t) => { const m = /^(\S+) (\d{4})L$/.exec(t); return m && { d: dateOf(m[1]), t: m[2] }; };
      for (const row of data) {
        const c = (k) => cellOf(row, cols[k]);
        const start = stamp(c('date').text), end = stamp(c('end').text);
        const d = start?.d || dateOf(c('date').text);
        if (d) cur = d;
        if (!cur || !c('duty').text) continue;
        const sec = /^([A-Z]{3})-([A-Z]{3})$/.exec(c('sector').text);
        const plus = (e) => (e?.d && e.d.ymd > cur.ymd ? ' +1' : '');
        if (!sec) {
          out.push({ ...cur, duty: c('duty').text, begin: start ? timeOf(start.t, 'L') : '', end: end ? `${timeOf(end.t, 'L')}${plus(end)}` : '', info: c('sd').text ? `[SD: ${c('sd').text}]` : '',
            _marks: [['date', c('date')], ['duty', c('duty')], ['info', c('sd')]] });
          continue;
        }
        if (start) out.push({ ...cur, duty: 'C/I', dep: sec[1], begin: timeOf(start.t, 'L'), _marks: [['date', c('date')], ['ci', c('date')]] });
        const t1 = c('dep').text.replace(/L$/, ''), t2 = c('arr').text.replace(/L$/, '');
        out.push({ ...cur, duty: c('duty').text, dep: sec[1], arr: sec[2], begin: timeOf(t1, 'L'), end: timeOf(t2, 'L', t2 < t1), ac: c('ac').text, info: c('sd').text ? `[SD: ${c('sd').text}]` : '',
          _marks: [['duty', c('duty')], ['dep', c('sector')], ['begin', c('dep')], ['end', c('arr')], ['ac', c('ac')], ['info', c('sd')]] });
        if (end) out.push({ ...cur, duty: 'C/O', arr: sec[2], end: `${timeOf(end.t, 'L')}${plus(end)}`, _marks: [['co', c('end')]] });
      }
      return out;
    },
  },
  {
    name: 'aircraft-id-logbook',
    // Date "5/28/2026" | Aircraft ID | Aircraft Type | Out | In | PIC/P1 Crew | SIC/P2 Crew | Total Time | Remarks | Flight # | From | To | Total Pax
    find(h) {
      if (!['Aircraft ID', 'Out', 'In', 'PIC/P1 Crew', 'Flight #', 'From', 'To'].every(n => h.includes(n))) return null;
      const at = (n) => { const i = h.indexOf(n); return i < 0 ? null : i; };
      return { date: at('Date'), registration: at('Aircraft ID'), ac: at('Aircraft Type'), out: at('Out'), in: at('In'), pic: at('PIC/P1 Crew'), sic: at('SIC/P2 Crew'),
        total: at('Total Time'), remark: at('Remarks'), flight: at('Flight #'), dep: at('From'), arr: at('To'), pax: at('Total Pax') };
    },
    // A row per flight (times as printed, taken as UTC; "+1" when In is earlier than Out), crew "[PIC - Lonsdale, Daniel][SIC - ...]",
    // info "[Total Time: 1.20] [Pax: 126]" and the remark.
    rows(data, cols, { dateOf, zone }) {
      const out = [];
      for (const row of data) {
        const c = (k) => cellOf(row, cols[k]);
        const d = dateOf(c('date').text);
        if (!d || !AIRPORT_ICAO_OR_IATA.test(c('dep').text)) continue;
        out.push({
          ...d, duty: c('flight').text, registration: c('registration').text, ac: c('ac').text, dep: c('dep').text, arr: c('arr').text,
          begin: timeOf(c('out').text, zone), end: timeOf(c('in').text, zone, c('in').text < c('out').text),
          crew: [['PIC', 'pic'], ['SIC', 'sic']].filter(([, k]) => c(k).text).map(([n, k]) => `[${n} - ${c(k).text}]`).join(''),
          info: [c('total').text && `[Total Time: ${c('total').text}]`, c('pax').text && `[Pax: ${c('pax').text}]`, c('remark').text].filter(Boolean).join(' '),
          _marks: [['date', c('date')], ['duty', c('flight')], ['registration', c('registration')], ['ac', c('ac')], ['dep', c('dep')], ['arr', c('arr')], ['begin', c('out')], ['end', c('in')],
            ['crew', c('pic')], ['crew', c('sic')], ['info', c('total')], ['info', c('pax')], ['info', c('remark')]],
        });
      }
      return out;
    },
  },
  {
    name: 'utc-legs',
    // Start UTC "03/08/2024 07:54" | From | End UTC | To | Flight time "11h16" | SIMU ins | SIMU trg | Type (Flight) | Function | Aircraft "FHMIB A35K"
    find(h) {
      if (!['Start UTC', 'From', 'End UTC', 'To', 'Aircraft'].every(n => h.includes(n))) return null;
      const at = (n) => { const i = h.indexOf(n); return i < 0 ? null : i; };
      return { date: at('Start UTC'), dep: at('From'), end: at('End UTC'), arr: at('To'), flt: at('Flight time'), simIns: at('SIMU ins'), simTrg: at('SIMU trg'), type: at('Type'), fn: at('Function'), aircraft: at('Aircraft') };
    },
    // A row per leg (UTC; "+1" when it ends on a later date), registration and type from Aircraft, "[Flight: 11:16] [Function: CC]"; a simulator
    // session (Type other than Flight) its Type as duty, "[Sim: ..]".
    rows(data, cols, { dateOf }) {
      const out = [];
      const dur = (t) => { const m = /^(\d+)h(\d{2})$/.exec(t || ''); return m ? `${m[1].padStart(2, '0')}:${m[2]}` : ''; };
      for (const row of data) {
        const c = (k) => cellOf(row, cols[k]);
        const s = /^(\S+) (\d{2}:\d{2})$/.exec(c('date').text), e = /^(\S+) (\d{2}:\d{2})$/.exec(c('end').text);
        const d = s && dateOf(s[1]);
        if (!d) continue;
        const ed = e && dateOf(e[1]);
        const [reg, type] = c('aircraft').text.split(/\s+/);
        const flight = !c('type').text || /^Flight$/i.test(c('type').text);
        const sim = dur(c('simIns').text) || dur(c('simTrg').text);
        out.push({
          ...d, duty: flight ? '' : c('type').text, dep: c('dep').text, arr: c('arr').text, begin: timeOf(s[2], 'Z'), end: e ? timeOf(e[2], 'Z', ed && ed.ymd > d.ymd) : '',
          registration: reg || '', ac: type || '',
          info: [dur(c('flt').text) && `[Flight: ${dur(c('flt').text)}]`, sim && `[Sim: ${sim}]`, c('fn').text && `[Function: ${c('fn').text}]`].filter(Boolean).join(' '),
          _marks: [['date', c('date')], ['dep', c('dep')], ['arr', c('arr')], ['end', c('end')], ['registration', c('aircraft')], ['info', c('flt')], ['info', c('fn')]],
        });
      }
      return out;
    },
  },
  {
    name: 'far-logbook',
    // Name | Date "2022-11-14 14:14:00.0 Z" | Typename | Tail | From | To | Blk Hrs | FAR 91 | FAR 91k | FAR 135 | PIC | SIC | NFC | Day T/O | Day Ldg |
    // Night T/O | Night Ldg | Night Hrs | IFR Hrs | IFR Appr | Paired With "Beliard, Laurent PIC" (decimal hours)
    find(h) {
      if (!['Typename', 'Tail', 'From', 'To', 'Blk Hrs', 'Paired With'].every(n => h.includes(n))) return null;
      const at = (n) => { const i = h.indexOf(n); return i < 0 ? null : i; };
      return { date: at('Date'), ac: at('Typename'), registration: at('Tail'), dep: at('From'), arr: at('To'), block: at('Blk Hrs'), far91: at('FAR 91'), far91k: at('FAR 91k'), far135: at('FAR 135'),
        pic: at('PIC'), sic: at('SIC'), tkDay: at('Day T/O'), ldDay: at('Day Ldg'), tkNight: at('Night T/O'), ldNight: at('Night Ldg'), night: at('Night Hrs'), ifr: at('IFR Hrs'), paired: at('Paired With') };
    },
    // A row per flight: begin the Date's time (UTC), crew from Paired With "[PIC - Beliard, Laurent]", info "[Block: 2.5] [FAR 135: 2.5] [SIC: 2.5]
    // [Takeoff Day: 1] [Landing Night: 1] [Night: 1.6] [IFR: 1.6]" (decimal hours as printed, zeros left out).
    rows(data, cols) {
      const out = [];
      const hrs = (cell) => (/^\d+(\.\d+)?$/.test(cell.text) && +cell.text > 0 ? cell.text : '');
      for (const row of data) {
        const c = (k) => cellOf(row, cols[k]);
        const m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})/.exec(c('date').text);
        if (!m || !AIRPORT_ICAO_OR_IATA.test(c('dep').text)) continue;
        const it = c('date').items[0];
        const pm = /^(.+?)\s+([A-Z]{2,4})$/.exec(c('paired').text);
        out.push({
          ...dayOf(+m[3], +m[2] - 1, +m[1]), ac: c('ac').text, registration: c('registration').text, dep: c('dep').text, arr: c('arr').text, begin: formatTime(`${m[4]}${m[5]}`, 'Z'),
          crew: c('paired').text ? (pm ? `[${pm[2]} - ${pm[1]}]` : `[Crew - ${c('paired').text}]`) : '',
          info: [...[['Block', 'block'], ['FAR 91', 'far91'], ['FAR 91k', 'far91k'], ['FAR 135', 'far135'], ['PIC', 'pic'], ['SIC', 'sic']].filter(([, k]) => hrs(c(k))).map(([n, k]) => `[${n}: ${c(k).text}]`),
            ...countTags([['Takeoff Day', c('tkDay')], ['Takeoff Night', c('tkNight')], ['Landing Day', c('ldDay')], ['Landing Night', c('ldNight')]]),
            ...[['Night', 'night'], ['IFR', 'ifr']].filter(([, k]) => hrs(c(k))).map(([n, k]) => `[${n}: ${c(k).text}]`)].join(' '),
          _marks: [['date', c('date')], ['begin', { items: it ? [{ ...it, text: `${m[4]}:${m[5]}`, _src: it._src || it, _off: (it._off || 0) + 11 }] : [] }], ['ac', c('ac')],
            ['registration', c('registration')], ['dep', c('dep')], ['arr', c('arr')], ['crew', c('paired')],
            ...['block', 'far91', 'far91k', 'far135', 'pic', 'sic', 'night', 'ifr'].filter(k => hrs(c(k))).map(k => ['info', c(k)]), ...countMarks(c('tkDay'), c('tkNight'), c('ldDay'), c('ldNight'))],
        });
      }
      return out;
    },
  },
  {
    name: 'planning-checkin',
    // "Planning from 01/05/2025 till 31/05/2025": (weekday) | Check-in | Start | City | End | Debrief end | Duty end | City | Duty | Rest / End rest |
    // Description | Extensions | Notes | Pax; stamps "01/05/2025 12:15" (UTC)
    find(h) {
      if (!['Check-in', 'Start', 'End', 'Duty end', 'Duty', 'Description', 'Notes'].every(n => h.includes(n))) return null;
      const at = (n, k = 0) => colIndex(h, n, { nth: k });
      return { ci: at('Check-in'), date: at('Start'), dep: at('City'), end: at('End'), co: at('Duty end'), arr: at('City', 1), duty: at('Duty'), desc: at('Description'), notes: at('Notes'), pax: at('Pax') };
    },
    // A flight ("AEA1173"): C/I from Check-in at the duty's first leg, registration / type from Notes ("Aircraft : ECNAB Aircraft type : B738-738"),
    // crew from Description ("TEC : PM:JULIO CO:ALHAMA" -> "[PM - JULIO][CO - ALHAMA]"), "[Pax: 182]"; Duty end -> a C/O row; VS (positioning,
    // dc DH) with its Notes ("FR 2629 PWS13C Transport:Aircraft"); HOTEL a hotel row; other duties ("IMAGINARIA EN BASE", "LIBRE") with their times.
    rows(data, cols, { dateOf }) {
      const out = [];
      let inDuty = false;
      for (const row of data) {
        const c = (k) => cellOf(row, cols[k]);
        const s = /^(\S+) (\d{2}:\d{2})$/.exec(c('date').text), e = /^(\S+) (\d{2}:\d{2})$/.exec(c('end').text), ci = /^(\S+) (\d{2}:\d{2})$/.exec(c('ci').text);
        const d = s && dateOf(s[1]);
        if (!d || !c('duty').text) continue;
        const ed = e && dateOf(e[1]);
        const end = e ? timeOf(e[2], 'Z', ed && ed.ymd > d.ymd) : '';
        const duty = c('duty').text;
        const flight = /^[A-Z]{2,3}\d{1,4}[A-Z]?$/.test(duty) && duty !== 'VS';
        if ((flight || duty === 'VS') && ci && !inDuty) out.push({ ...d, duty: 'C/I', dep: c('dep').text, begin: timeOf(ci[2], 'Z'), _marks: [['date', c('date')], ['ci', c('ci')]] });
        if (flight || duty === 'VS') inDuty = true;
        const acm = /Aircraft : (\S+) Aircraft type : ([A-Z0-9]+)/.exec(c('notes').text);
        const crew = [...c('desc').text.matchAll(/([A-Z]{2,3}):([A-ZÀ-Ü][A-ZÀ-Ü' -]*?)(?=\s+[A-Z]{2,3}:|$)/g)].map(m => `[${m[1]} - ${m[2].trim()}]`).join('');
        const r = {
          ...d, duty: duty === 'HOTEL' ? 'H' : duty, dc: duty === 'VS' ? 'DH' : '', dep: c('dep').text, arr: c('arr').text !== c('dep').text || flight ? c('arr').text : '',
          begin: timeOf(s[2], 'Z'), end, registration: acm ? acm[1] : '', ac: acm ? acm[2] : '', crew: flight ? crew : '',
          info: [flight && c('pax').text && `[Pax: ${c('pax').text}]`, duty === 'VS' && c('notes').text, !flight && duty !== 'VS' && duty !== 'HOTEL' && c('notes').text !== duty && c('notes').text].filter(Boolean).join(' '),
          _marks: [['date', c('date')], ['duty', c('duty')], ['dep', c('dep')], ['arr', c('arr')], ['begin', c('date')], ['end', c('end')], ['registration', c('notes')], ['crew', flight ? c('desc') : null]],
        };
        out.push(r);
        const co = /^(\d{2}:\d{2})$/.exec(c('co').text);
        if (co && inDuty) { out.push({ ...d, duty: 'C/O', arr: c('arr').text, end: timeOf(co[1], 'Z', co[1] < s[2]), _marks: [['co', c('co')]] }); inDuty = false; }
      }
      return out;
    },
  },
  {
    name: 'saudia-duties',
    // STAFF_NUM | ... | DUTY_STR_DATE | DUTY_END_DATE | DUTY_CD | PRNG_NUM | FLT_NUM | DEPARURE_PORT | ARRIVAL_PORT | ... | FLEET_CD | TAIL_NUM |
    // ACTUAL_START_DATE_GMT | ACTUAL_START_TIME_GMT | ACTUAL_END_DATE_GMT | ACTUAL_END_TIME_GMT | ACTUAL_START_DATE_LOCAL | ... (dates "17-AUG-17")
    find(h) {
      if (!['DUTY_CD', 'FLT_NUM', 'ACTUAL_START_TIME_GMT', 'ACTUAL_END_TIME_GMT'].every(n => h.includes(n))) return null;
      const at = (n) => { const i = h.indexOf(n); return i < 0 ? null : i; };
      return { code: at('DUTY_CD'), pairing: at('PRNG_NUM'), flight: at('FLT_NUM'), dep: at('DEPARURE_PORT') ?? at('DEPARTURE_PORT'), arr: at('ARRIVAL_PORT'), ac: at('FLEET_CD'), registration: at('TAIL_NUM'),
        sd: at('ACTUAL_START_DATE_GMT'), st: at('ACTUAL_START_TIME_GMT'), ed: at('ACTUAL_END_DATE_GMT'), et: at('ACTUAL_END_TIME_GMT'),
        sdl: at('ACTUAL_START_DATE_LOCAL'), stl: at('ACTUAL_START_TIME_LOCAL'), edl: at('ACTUAL_END_DATE_LOCAL'), etl: at('ACTUAL_END_TIME_LOCAL') };
    },
    // A row per line: a flight number (not "0") as duty, else the duty code (OR, RST, GS ...); times "12:00 Z / 15:00 L" ("+1" on a later
    // date); "[Pairing: 8770244]"; fleet / tail when given ("-" left out).
    rows(data, cols) {
      const out = [];
      const ddMonYy2 = (t) => { const m = /^(\d{2})-([A-Z]{3})-(\d{2})$/.exec(t); const mon = m && MONTHS.findIndex(x => x.toUpperCase() === m[2]); return m && mon >= 0 ? dayOf(+m[1], mon, +m[3]) : null; };
      for (const row of data) {
        const c = (k) => cellOf(row, cols[k]);
        const d = ddMonYy2(c('sd').text);
        if (!d) continue;
        const zl = (dk, tk, ldk, ltk) => {
          const z = c(tk).text, l = c(ltk).text;
          if (!z) return '';
          const zd = ddMonYy2(c(dk).text), ld = ddMonYy2(c(ldk).text);
          const p = (x) => (x && x.ymd > d.ymd ? ` +${Math.round((x.ymd - d.ymd) / 86400000)}` : '');
          return l ? `${z} Z${p(zd)} / ${l} L${p(ld)}` : `${z} Z${p(zd)}`;
        };
        const flight = /^\d+$/.test(c('flight').text) && c('flight').text !== '0';
        out.push({
          ...d, duty: flight ? c('flight').text : c('code').text, dep: c('dep').text, arr: c('arr').text !== c('dep').text || flight ? c('arr').text : '',
          begin: zl('sd', 'st', 'sdl', 'stl'), end: zl('ed', 'et', 'edl', 'etl'),
          ac: /^[A-Z0-9]{3,4}$/.test(c('ac').text) ? c('ac').text : '', registration: /^[A-Z0-9-]{4,}$/.test(c('registration').text) ? c('registration').text : '',
          info: c('pairing').text ? `[Pairing: ${c('pairing').text}]` : '',
          _marks: [['date', c('sd')], ['duty', flight ? c('flight') : c('code')], ['dep', c('dep')], ['arr', c('arr')], ['begin', c('st')], ['begin', c('stl')], ['end', c('et')], ['end', c('etl')],
            ['ac', c('ac')], ['registration', c('registration')], ['info', c('pairing')]],
        });
      }
      return out;
    },
  },
  {
    name: 'german-logbook',
    // German flight-school / club logbooks: "Flugbuch" Datum "01.09.22" | LFZ Typ | Kennzeichen | von | nach | Start | Landung | BlockOff | BlockOn |
    // Landungen | Flugstunden | Blockzeit | ... | Schüler | Bemerkung; or (Vereinsflieger) Datum | Lfz. | Startort "Goch-Asperden EDLG" | Landeort |
    // Off-Block | Start | Landung | On-Block | Blockzeit in hh:mm | Landungen | Pilot | Begleiter/FI | Flugzeit (minutes) | ... | Lfz.-Muster
    find(h) {
      const at = (n) => { const i = h.indexOf(n); return i < 0 ? null : i; };
      if (!h.includes('Datum') || !(h.includes('BlockOff') || h.includes('Off-Block'))) return null;
      if (!((h.includes('von') && h.includes('nach')) || (h.includes('Startort') && h.includes('Landeort')))) return null;
      return { date: at('Datum'), reg: at('Kennzeichen') ?? at('Lfz.'), ac: at('LFZ Typ') ?? at('Lfz.-Muster'), dep: at('von') ?? at('Startort'), arr: at('nach') ?? at('Landeort'),
        off: at('BlockOff') ?? at('Off-Block'), takeoff: at('Start'), landing: at('Landung'), on: at('BlockOn') ?? at('On-Block'), ldg: at('Landungen'),
        flight: at('Flugstunden') ?? at('Flugzeit'), block: at('Blockzeit') ?? at('Blockzeit in hh:mm'), student: at('Schüler'), pilot: at('Pilot'), fi: at('Begleiter/FI'), remark: at('Bemerkung') };
    },
    // A row per flight: the airfield's ICAO code ("Goch-Asperden EDLG" -> EDLG), block off / on as begin / end, take-off / landing times,
    // "[Block: 00:50] [Flight: 00:40] [Landing Day/Night: 1]" (Flugzeit in minutes -> hh:mm), crew "[Pilot - ...][FI - ...]" / "[Student - ...]".
    // Times as printed, taken as UTC.
    rows(data, cols, { dateOf }) {
      const out = [];
      const icao = (t) => /([A-Z]{4})$/.exec(t)?.[1] || (AIRPORT_ICAO_OR_IATA.test(t) ? t : '');
      const hm = (t) => (/^\d{1,3}$/.test(t) ? `${String(Math.floor(+t / 60)).padStart(2, '0')}:${String(+t % 60).padStart(2, '0')}` : /^\d{1,2}:\d{2}$/.test(t) ? t.padStart(5, '0') : '');
      for (const row of data) {
        const c = (k) => cellOf(row, cols[k]);
        const d = dateOf(c('date').text);
        const dep = icao(c('dep').text), arr = icao(c('arr').text);
        if (!d || !dep) continue;
        const off = c('off').text, on = c('on').text;
        out.push({
          ...d, registration: c('reg').text, ac: cols.ac === cols.reg ? '' : c('ac').text, dep, arr,
          begin: timeOf(off, 'Z'), end: on ? timeOf(on, 'Z', on < off) : '', takeoff: timeOf(c('takeoff').text, 'Z'), landing: timeOf(c('landing').text, 'Z'),
          crew: [['Pilot', 'pilot'], ['FI', 'fi'], ['Student', 'student']].filter(([, k]) => c(k).text).map(([n, k]) => `[${n} - ${c(k).text}]`).join(''),
          info: [hm(c('block').text) && /[1-9]/.test(hm(c('block').text)) && `[Block: ${hm(c('block').text)}]`, hm(c('flight').text) && /[1-9]/.test(hm(c('flight').text)) && `[Flight: ${hm(c('flight').text)}]`,
            counted(c('ldg')) && `[Landing Day/Night: ${+c('ldg').text}]`, c('remark').text].filter(Boolean).join(' '),
          _marks: [['date', c('date')], ['registration', c('reg')], ['ac', cols.ac === cols.reg ? null : c('ac')], ['dep', c('dep')], ['arr', c('arr')], ['begin', c('off')], ['end', c('on')],
            ['takeoff', c('takeoff')], ['landing', c('landing')], ['crew', c('pilot')], ['crew', c('fi')], ['crew', c('student')], ['info', c('block')], ['info', c('flight')], ['info', c('ldg')], ['info', c('remark')]],
        });
      }
      return out;
    },
  },
  {
    name: 'brakes-logbook',
    // flight-school log: Date | Aircraft (registration) | Flight Log | From | To | Brakes Off | Take Off | Landing | Brakes On | PIC | Student | Defects
    find(h) {
      if (!['Aircraft', 'From', 'To', 'Brakes Off', 'Take Off', 'Landing', 'Brakes On', 'PIC'].every(n => h.includes(n))) return null;
      const at = (n) => { const i = h.indexOf(n); return i < 0 ? null : i; };
      return { date: at('Date'), reg: at('Aircraft'), dep: at('From'), arr: at('To'), off: at('Brakes Off'), takeoff: at('Take Off'), landing: at('Landing'), on: at('Brakes On'),
        pic: at('PIC'), student: at('Student'), defects: at('Defects') };
    },
    // A row per flight (airports upper-cased: "eglk"), brakes off / on as begin / end, take-off / landing, "[PIC - ..][Student - ..]", a defect
    // other than NIL as info. Times taken as UTC.
    rows(data, cols, { dateOf }) {
      const out = [];
      for (const row of data) {
        const c = (k) => cellOf(row, cols[k]);
        const d = dateOf(c('date').text);
        const dep = c('dep').text.toUpperCase(), arr = c('arr').text.toUpperCase();
        if (!d || !AIRPORT_ICAO_OR_IATA.test(dep)) continue;
        const hm = (k) => c(k).text.replace(/^(\d{1,2}:\d{2}):\d{2}$/, '$1'); // (the CSV keeps the seconds: "15:37:49")
        const off = hm('off'), on = hm('on');
        out.push({
          ...d, registration: c('reg').text, dep, arr, begin: timeOf(off, 'Z'), end: on ? timeOf(on, 'Z', on < off) : '', takeoff: timeOf(hm('takeoff'), 'Z'), landing: timeOf(hm('landing'), 'Z'),
          crew: [['PIC', 'pic'], ['Student', 'student']].filter(([, k]) => c(k).text).map(([n, k]) => `[${n} - ${c(k).text}]`).join(''),
          info: c('defects').text && !/^NIL$/i.test(c('defects').text) ? c('defects').text : '',
          _marks: [['date', c('date')], ['registration', c('reg')], ['dep', c('dep')], ['arr', c('arr')], ['begin', c('off')], ['end', c('on')], ['takeoff', c('takeoff')], ['landing', c('landing')],
            ['crew', c('pic')], ['crew', c('student')]],
        });
      }
      return out;
    },
  },
  {
    name: 'pf-legs',
    // pilot's flights export (WestJet): EmployeeID | Crew Name | Flight Date "21-Sep-25" | Flight Number | Takeoff (as PF) | TO Location | Out Time |
    // TO Daytime/Nightime | Landing (as PF) | Ldg Location | In Time | ... | Flight Hours (Block) | ... | Rank | ... | Airline | Tail Number |
    // Airline Registration | Aircraft Type | Paired Crew Member
    find(h) {
      if (!['Flight Date', 'Flight Number', 'TO Location', 'Out Time', 'Ldg Location', 'In Time'].every(n => h.includes(n))) return null;
      const at = (n) => { const i = h.indexOf(n); return i < 0 ? null : i; };
      return { date: at('Flight Date'), flight: at('Flight Number'), tkPf: at('Takeoff (as PF)'), dep: at('TO Location'), out: at('Out Time'), tkNight: at('TO Daytime/Nightime'),
        ldPf: at('Landing (as PF)'), arr: at('Ldg Location'), in: at('In Time'), ldNight: at('Ldg Daytime/Nightime'), block: at('Flight Hours (Block)'), rank: at('Rank'),
        airline: at('Airline'), reg: at('Airline Registration'), ac: at('Aircraft Type'), paired: at('Paired Crew Member') };
    },
    // A row per flight: the airline's code with the number ("WS2931"), out / in (taken as UTC; "+1" when In is earlier), "[Block: 03:43]",
    // take-off / landing as pilot flying by day or night ("[Takeoff Night: 1]"), "[Rank: Captain - PIC]", the paired crew member.
    rows(data, cols, { dateOf }) {
      const out = [];
      const dmy = (t) => { const m = /^(\d{1,2})-([A-Za-z]{3})-(\d{2})$/.exec(t); const mon = m && MONTHS.findIndex(x => x.toLowerCase() === m[2].toLowerCase()); return m && mon >= 0 ? dayOf(+m[1], mon, +m[3]) : dateOf(t); };
      for (const row of data) {
        const c = (k) => cellOf(row, cols[k]);
        const d = dmy(c('date').text);
        if (!d || !AIRPORT_ICAO_OR_IATA.test(c('dep').text)) continue;
        const pf = (k, night, name) => (/^true$/i.test(c(k).text) ? `[${name} ${/^true$/i.test(c(night).text) ? 'Night' : 'Day'}: 1]` : '');
        out.push({
          ...d, duty: `${/^[A-Z0-9]{2}$/.test(c('airline').text) ? c('airline').text : ''}${c('flight').text}`, registration: c('reg').text, ac: c('ac').text, dep: c('dep').text, arr: c('arr').text,
          begin: timeOf(c('out').text, 'Z'), end: timeOf(c('in').text, 'Z', c('in').text < c('out').text),
          crew: c('paired').text ? `[Crew - ${c('paired').text}]` : '',
          info: [c('block').text && `[Block: ${c('block').text}]`, pf('tkPf', 'tkNight', 'Takeoff'), pf('ldPf', 'ldNight', 'Landing'), c('rank').text && `[Rank: ${c('rank').text}]`].filter(Boolean).join(' '),
          _marks: [['date', c('date')], ['duty', c('airline')], ['duty', c('flight')], ['registration', c('reg')], ['ac', c('ac')], ['dep', c('dep')], ['arr', c('arr')], ['begin', c('out')], ['end', c('in')],
            ['crew', c('paired')], ['info', c('block')], ['info', c('rank')]],
        });
      }
      return out;
    },
  },
  {
    name: 'utc-crew-legs',
    // departUTC "2024-08-25T02:13" | arriveUTC | fltNum | origin | destination | acRegistration | acType | crew "CA: Matthew Davis / FO: ..." | hours
    find(h) {
      if (!['departUTC', 'arriveUTC', 'fltNum', 'origin', 'destination'].every(n => h.includes(n))) return null;
      const at = (n) => { const i = h.indexOf(n); return i < 0 ? null : i; };
      return { dep_t: at('departUTC'), arr_t: at('arriveUTC'), flight: at('fltNum'), dep: at('origin'), arr: at('destination'), reg: at('acRegistration'), ac: at('acType'), crew: at('crew'), hours: at('hours') };
    },
    // A row per flight (UTC; "+1" when it arrives on a later date), crew "[CA - Matthew Davis][FO - Christopher Baron]", "[Block: 4.8]" (decimal hours)
    rows(data, cols) {
      const out = [];
      const stamp = (t) => /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(t);
      for (const row of data) {
        const c = (k) => cellOf(row, cols[k]);
        const s = stamp(c('dep_t').text), e = stamp(c('arr_t').text);
        if (!s) continue;
        const d = dayOf(+s[3], +s[2] - 1, +s[1]);
        const later = e && dayOf(+e[3], +e[2] - 1, +e[1]).ymd > d.ymd;
        out.push({
          ...d, duty: c('flight').text, registration: c('reg').text, ac: c('ac').text, dep: c('dep').text, arr: c('arr').text,
          begin: formatTime(`${s[4]}${s[5]}`, 'Z'), end: e ? `${formatTime(`${e[4]}${e[5]}`, 'Z')}${later ? ' +1' : ''}` : '',
          crew: [...c('crew').text.matchAll(/([A-Z]{2,3}): ([^/]+?)(?=\s*\/|$)/g)].map(m => `[${m[1]} - ${m[2].trim()}]`).join(''),
          info: c('hours').text ? `[Block: ${c('hours').text}]` : '',
          _marks: [['date', c('dep_t')], ['duty', c('flight')], ['registration', c('reg')], ['ac', c('ac')], ['dep', c('dep')], ['arr', c('arr')], ['crew', c('crew')], ['info', c('hours')]],
        });
      }
      return out;
    },
  },
  {
    name: 'school-flights',
    // flight-school export: id | date | reg | type | flight_type | pic | customer | instructor | from | to | off_blocks_utc | takeoff_utc | landing_utc |
    // on_blocks_utc | off_blocks_local | ... | total_block "0:54" | total_airborne | takeoffs_landings | student_takeoff_landings
    find(h) {
      if (!['reg', 'from', 'to', 'off_blocks_utc', 'on_blocks_utc'].every(n => h.includes(n))) return null;
      const at = (n) => { const i = h.indexOf(n); return i < 0 ? null : i; };
      return { date: at('date'), reg: at('reg'), ac: at('type'), kind: at('flight_type'), pic: at('pic'), customer: at('customer'), instructor: at('instructor'), dep: at('from'), arr: at('to'),
        off: at('off_blocks_utc'), takeoff: at('takeoff_utc'), landing: at('landing_utc'), on: at('on_blocks_utc'), block: at('total_block'), air: at('total_airborne'), ldg: at('takeoffs_landings') };
    },
    // A row per flight (the UTC times), crew "[PIC - C Sarel][Customer - J Lilley][Instructor - ..]", "[Block: 00:54] [Flight: 00:39] [Landing Day/Night: 1]
    // [Flight type: PPL]"
    rows(data, cols, { dateOf }) {
      const out = [];
      const hm = (t) => (/^\d{1,2}:\d{2}$/.test(t) && /[1-9]/.test(t) ? t.padStart(5, '0') : '');
      for (const row of data) {
        const c = (k) => cellOf(row, cols[k]);
        const d = dateOf(c('date').text);
        if (!d || !AIRPORT_ICAO_OR_IATA.test(c('dep').text)) continue;
        const off = c('off').text, on = c('on').text;
        out.push({
          ...d, registration: c('reg').text, ac: c('ac').text, dep: c('dep').text, arr: c('arr').text,
          begin: timeOf(off, 'Z'), end: on ? timeOf(on, 'Z', on < off) : '', takeoff: timeOf(c('takeoff').text, 'Z'), landing: timeOf(c('landing').text, 'Z'),
          crew: [['PIC', 'pic'], ['Customer', 'customer'], ['Instructor', 'instructor']].filter(([, k]) => c(k).text).map(([n, k]) => `[${n} - ${c(k).text}]`).join(''),
          info: [hm(c('block').text) && `[Block: ${hm(c('block').text)}]`, hm(c('air').text) && `[Flight: ${hm(c('air').text)}]`, counted(c('ldg')) && `[Landing Day/Night: ${+c('ldg').text}]`,
            c('kind').text && `[Flight type: ${c('kind').text}]`].filter(Boolean).join(' '),
          _marks: [['date', c('date')], ['registration', c('reg')], ['ac', c('ac')], ['dep', c('dep')], ['arr', c('arr')], ['begin', c('off')], ['end', c('on')], ['takeoff', c('takeoff')], ['landing', c('landing')],
            ['crew', c('pic')], ['crew', c('customer')], ['crew', c('instructor')], ['info', c('block')], ['info', c('air')], ['info', c('ldg')], ['info', c('kind')]],
        });
      }
      return out;
    },
  },
  {
    name: 'activity-lines',
    // SAS crew schedule export: Day | Date "01AUG2025" | Duty "IL" | Meal | Activity (checkin, a flight, NightStop, transport, checkout, F) |
    // C/I | From | STD | STA | To | C/O | Stop time
    find(h) {
      if (!['Day', 'Date', 'Duty', 'Meal', 'Activity', 'From', 'STD', 'STA', 'To', 'Stop time'].every(n => h.includes(n))) return null;
      const at = (n) => { const i = h.indexOf(n); return i < 0 ? null : i; };
      return { date: at('Date'), duty: at('Duty'), meal: at('Meal'), act: at('Activity'), dep: at('From'), std: at('STD'), sta: at('STA'), arr: at('To'), stop: at('Stop time') };
    },
    // checkin -> C/I (at its STD), checkout -> C/O, a flight with its airports (local times, "+1" when STA is earlier), "[Duty: IL] [Meal: V]";
    // NightStop -> a hotel row at the last arrival; others (F, transport) a row with their times
    rows(data, cols, { dateOf }) {
      const out = [];
      let lastArr = '', nextDep = '';
      const flightRe = /^[A-Z0-9]{2}\d{1,4}[A-Z]?$/;
      // a C/I's station: the next flight's departure
      const deps = data.map((row) => cellOf(row, cols.act).text).map((t, i) => (flightRe.test(t) ? cellOf(data[i], cols.dep).text : ''));
      for (const [i, row] of data.entries()) {
        const c = (k) => cellOf(row, cols[k]);
        const d = dateOf(c('date').text) || ddMonYy(c('date').text);
        if (!d || !c('act').text) continue;
        const act = c('act').text, std = c('std').text, sta = c('sta').text;
        nextDep = deps.slice(i).find(Boolean) || '';
        if (/^checkin$/i.test(act)) { out.push({ ...d, duty: 'C/I', dep: nextDep, begin: timeOf(std, 'L'), _marks: [['date', c('date')], ['ci', c('std')]] }); continue; }
        if (/^checkout$/i.test(act)) { out.push({ ...d, duty: 'C/O', arr: lastArr, end: timeOf(sta, 'L'), _marks: [['co', c('sta')]] }); continue; }
        if (flightRe.test(act)) {
          lastArr = c('arr').text;
          out.push({
            ...d, duty: act, dep: c('dep').text, arr: c('arr').text, begin: timeOf(std, 'L'), end: timeOf(sta, 'L', sta < std),
            info: [c('duty').text && `[Duty: ${c('duty').text}]`, c('meal').text && `[Meal: ${c('meal').text}]`].filter(Boolean).join(' '),
            _marks: [['date', c('date')], ['duty', c('act')], ['dep', c('dep')], ['arr', c('arr')], ['begin', c('std')], ['end', c('sta')], ['info', c('duty')], ['info', c('meal')]],
          });
          continue;
        }
        out.push({ ...d, duty: /^NightStop$/i.test(act) ? 'H' : act, dep: /^NightStop$/i.test(act) ? lastArr : '', begin: timeOf(std, 'L'), end: timeOf(sta, 'L', sta < std),
          _marks: [['date', c('date')], ['duty', c('act')], ['begin', c('std')], ['end', c('sta')]] });
      }
      return out;
    },
  },
  {
    name: 'dhd-flights',
    // Southwest pilot's flights (below "TotalBlockhrsmins" / TAFB gauge values): DATE "2022-02-05" | Flight "WN5695" | dhd "DH" | From | Depart "1411" |
    // To | Arrive | Block "213" | Tail_Number | A_C_Type | (TakeOff | Landing) | CoPilot "FO BROCK TRAVIS *INTL* [124921]" / "Deadheading"
    find(h) {
      if (!['DATE', 'Flight', 'dhd', 'From', 'Depart', 'To', 'Arrive', 'Block'].every(n => h.includes(n))) return null;
      const at = (n) => { const i = h.indexOf(n); return i < 0 ? null : i; };
      return { date: at('DATE'), flight: at('Flight'), dhd: at('dhd'), dep: at('From'), std: at('Depart'), arr: at('To'), sta: at('Arrive'), block: at('Block'), reg: at('Tail_Number'),
        ac: at('A_C_Type'), to: at('TakeOff'), ld: at('Landing'), copilot: at('CoPilot') };
    },
    // A row per flight (local times; "+1" when it arrives earlier than it left), "DH" -> dc DH, "[Block: 02:13]", the other pilot
    // "[FO - 124921 - BROCK TRAVIS]", take-offs / landings "[Takeoff Day/Night: 1]"
    rows(data, cols) {
      const out = [];
      for (const row of data) {
        const c = (k) => cellOf(row, cols[k]);
        const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(c('date').text);
        if (!m || !AIRPORT_ICAO_OR_IATA.test(c('dep').text)) continue;
        const std = c('std').text, sta = c('sta').text;
        const b = /^\d{1,4}$/.test(c('block').text) && +c('block').text > 0 ? c('block').text.padStart(4, '0') : '';
        const cp = /^([A-Z]{2,3}) (.+?)(?: \*\w+\*)?(?: \[(\d+)\])?$/.exec(c('copilot').text);
        out.push({
          ...dayOf(+m[3], +m[2] - 1, +m[1]), duty: c('flight').text, dc: /^DH/i.test(c('dhd').text) ? 'DH' : '', registration: c('reg').text, ac: c('ac').text, dep: c('dep').text, arr: c('arr').text,
          begin: timeOf(std, 'L'), end: timeOf(sta, 'L', +sta.replace(':', '') < +std.replace(':', '')), // ("913", "9:13", "1046")
          crew: cp && !/^Deadheading$/i.test(c('copilot').text) ? `[${cp[1]} - ${cp[3] ? `${cp[3]} - ` : ''}${cp[2]}]` : '',
          info: [b && `[Block: ${b.slice(0, 2)}:${b.slice(2)}]`, counted(c('to')) && `[Takeoff Day/Night: ${+c('to').text}]`, counted(c('ld')) && `[Landing Day/Night: ${+c('ld').text}]`].filter(Boolean).join(' '),
          _marks: [['date', c('date')], ['duty', c('flight')], ['registration', c('reg')], ['ac', c('ac')], ['dep', c('dep')], ['arr', c('arr')], ['begin', c('std')], ['end', c('sta')],
            ['crew', cp ? c('copilot') : null], ['info', b ? c('block') : null], ...countMarks(c('to'), c('ld'))],
        });
      }
      return out;
    },
  },
  {
    name: 'stamp-logbook',
    // pilot logbook export: date_of_flight | call_sign | departure_airport | off_block "22/05/2015 06:22" | take_off | destination_airport | landing |
    // on_block | aircraft_manufacturer | aircraft_model | aircraft_registration | ... | airtime | block_time | ... | night_landing | capt_on_flight |
    // ... | role_on_flight | ...
    find(h) {
      if (!['date_of_flight', 'call_sign', 'departure_airport', 'off_block', 'destination_airport', 'on_block'].every(n => h.includes(n))) return null;
      const at = (n) => { const i = h.indexOf(n); return i < 0 ? null : i; };
      return { date: at('date_of_flight'), flight: at('call_sign'), dep: at('departure_airport'), off: at('off_block'), takeoff: at('take_off'), arr: at('destination_airport'), landing: at('landing'),
        on: at('on_block'), ac: at('aircraft_model'), reg: at('aircraft_registration'), air: at('airtime'), block: at('block_time'), capt: at('capt_on_flight'), role: at('role_on_flight') };
    },
    // A row per flight (times from the stamps, taken as UTC; "+1" on a later date), "[Block: 02:48] [Flight: 02:36] [Role: Psv]", the captain "[CP - Paul BOWE]"
    rows(data, cols, { dateOf }) {
      const out = [];
      const st = (t) => /^(\S+) (\d{1,2}:\d{2})$/.exec(t);
      const hm = (t) => (/^\d{1,3}:\d{2}$/.test(t) && /[1-9]/.test(t) ? t.padStart(5, '0') : '');
      for (const row of data) {
        const c = (k) => cellOf(row, cols[k]);
        const d = dateOf(c('date').text);
        if (!d || !AIRPORT_ICAO_OR_IATA.test(c('dep').text)) continue;
        const [off, tk, ld, on] = ['off', 'takeoff', 'landing', 'on'].map(k => st(c(k).text));
        const later = (s) => { const x = s && dateOf(s[1]); return !!(x && x.ymd > d.ymd); };
        out.push({
          ...d, duty: c('flight').text, registration: c('reg').text, ac: c('ac').text, dep: c('dep').text, arr: c('arr').text,
          begin: off ? timeOf(off[2], 'Z') : '', takeoff: tk ? timeOf(tk[2], 'Z', later(tk)) : '', landing: ld ? timeOf(ld[2], 'Z', later(ld)) : '', end: on ? timeOf(on[2], 'Z', later(on)) : '',
          crew: c('capt').text ? `[CP - ${c('capt').text}]` : '',
          info: [hm(c('block').text) && `[Block: ${hm(c('block').text)}]`, hm(c('air').text) && `[Flight: ${hm(c('air').text)}]`, c('role').text && `[Role: ${c('role').text}]`].filter(Boolean).join(' '),
          _marks: [['date', c('date')], ['duty', c('flight')], ['registration', c('reg')], ['ac', c('ac')], ['dep', c('dep')], ['arr', c('arr')], ['begin', c('off')], ['takeoff', c('takeoff')],
            ['landing', c('landing')], ['end', c('on')], ['crew', c('capt')], ['info', c('block')], ['info', c('air')], ['info', c('role')]],
        });
      }
      return out;
    },
  },
  {
    name: 'block-time-report',
    // crew block time report: "Actual Out" | "Actual In" | Orig | Dest | Crew Count | Block Time minutes tenth ("12+33") | ...; the crew member's
    // name line ("Alexander, Aisha J. - 70722") above the legs; stamps "01/01/2022 22:21" (UTC)
    find(h) {
      if (!['Actual Out', 'Actual In', 'Orig', 'Dest'].every(n => h.includes(n))) return null;
      const at = (n) => { const i = h.findIndex(t => t === n || t.startsWith(`${n} `)); return i < 0 ? null : i; };
      return { date: at('Actual Out'), in: at('Actual In'), dep: at('Orig'), arr: at('Dest'), crewCount: at('Crew Count'), block: at('Block Time') };
    },
    rows(data, cols, { dateOf }) {
      const out = [];
      for (const row of data) {
        const c = (k) => cellOf(row, cols[k]);
        const s = /^(\S+) (\d{2}:\d{2})$/.exec(c('date').text), e = /^(\S+) (\d{2}:\d{2})$/.exec(c('in').text);
        const d = s && dateOf(s[1]);
        if (!d || !AIRPORT_ICAO_OR_IATA.test(c('dep').text)) continue;
        const ed = e && dateOf(e[1]);
        const bm = /^(\d+)\+(\d{2})$/.exec(c('block').text);
        out.push({
          ...d, dc: c('crewCount').text === 'DHD' ? 'DH' : '', dep: c('dep').text, arr: c('arr').text, begin: timeOf(s[2], 'Z'), end: e ? timeOf(e[2], 'Z', ed && ed.ymd > d.ymd) : '',
          info: [bm && `[Block: ${bm[1].padStart(2, '0')}:${bm[2]}]`, /^\d+$/.test(c('crewCount').text) && `[Crew: ${c('crewCount').text}]`].filter(Boolean).join(' '),
          _marks: [['date', c('date')], ['dep', c('dep')], ['arr', c('arr')], ['end', c('in')], ['info', c('block')], ['info', c('crewCount')]],
        });
      }
      return out;
    },
  },
  {
    name: 'outlook-calendar',
    // Iberia roster exported from Outlook (Spanish): Asunto | Fecha de comienzo | Comienzo | Fecha de finalización | Finalización |
    // Todo el día | ... | Description (the crew, a line each). Subjects:
    //   "Firma 14:30 Pairing 1589"            sign-on -> C/I at 14:30 (calendar time, local), "[Pairing: 1589]", dep of the next flight
    //   "IB721  MAD1345-LHR1615 / 350 +O"     a flight, times in UTC; "/ 350" the aircraft; a mark after it ("+O", "H+") -> "[+O]"
    //   "X - DIA LIBRE", "IM - IMAGINARIA"    a code and its meaning -> duty X "[X: DIA LIBRE]"; all day ("Todo el día" Verdadero):
    //                                         a row per day from start to end date, else with the calendar's (local) times
    // Crew "CT->I3 113794 ROSARIO SANCHEZ-SIMON , JAVIER VICENTE" -> "[CT - 113794 - ROSARIO SANCHEZ-SIMON, JAVIER VICENTE]".
    find(h) {
      const at = (re) => { const i = h.findIndex(t => re.test(t)); return i < 0 ? null : i; };
      const cols = {
        subject: at(/^(Asunto|Subject)$/), startDate: at(/^(Fecha de comienzo|Start Date)$/), start: at(/^(Comienzo|Start Time)$/),
        endDate: at(/^(Fecha de finalizaci.n|End Date)$/), end: at(/^(Finalizaci.n|End Time)$/), allDay: at(/^(Todo el d.a|All day event)$/),
      };
      return Object.values(cols).every(v => v != null) ? cols : null;
    },
    rows(data, cols) {
      const out = [];
      const ddmmyyyy = (t) => { const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(t); return m ? dayOf(+m[1], +m[2] - 1, +m[3]) : null; };
      const hhmm = (t) => { const m = /^(\d{2})(\d{2})$/.exec(t); return m ? `${m[1]}:${m[2]}` : null; };
      let ci = null;
      for (const row of data) {
        const c = (k) => cellOf(row, cols[k]);
        const subj = c('subject').text;
        const it = c('subject').items[0];
        // a part of the subject (regex group n, matched with the d flag), for the trace
        const part = (m, n) => ({ items: it && m.indices[n] ? [{ ...it, text: m[n], _src: it._src || it, _off: (it._off || 0) + m.indices[n][0] }] : [] });
        const d = ddmmyyyy(c('startDate').text);
        if (!subj || !d) continue;
        // the crew: lines of the other cells ("TECNICOS" / "TCP" titles, "---" rules left out)
        const crewItems = row.slice(cols.allDay + 1).flat().filter(it => /^\S+\s+\d{5,6}\s+.+,/.test(it?.text || ''));
        const crew = crewItems.map(it => {
          const m = /^(\S+?)(?:->\S+)?\s+(\d{5,6})\s+(.+?)\s*,\s*(.+?)\s*$/.exec(it.text);
          return m ? `[${m[1]} - ${m[2]} - ${m[3]}, ${m[4]}]` : '';
        }).join('');
        let m;
        if ((m = /^Firma\s+(\d{2}:\d{2})(?:\s+Pairing\s+(\S+))?/d.exec(subj))) {
          ci = { ...d, duty: 'C/I', begin: timeOf(m[1], 'L'), info: m[2] ? `[Pairing: ${m[2]}]` : '', _marks: [['date', c('startDate')], ['ci', part(m, 1)], ['info', m[2] ? part(m, 2) : null]] };
          out.push(ci);
          continue;
        }
        if ((m = /^([A-Z0-9]{2}\d{1,4}[A-Z]?)\s+([A-Z]{3})(\d{4})-([A-Z]{3})(\d{4})(?:\s*\/\s*(\S+))?(?:\s+(\S+))?\s*$/d.exec(subj))) {
          const [, flight, dep, t1, arr, t2, ac, flag] = m;
          if (ci && !ci.dep) ci.dep = dep;
          ci = null;
          out.push({
            ...d, duty: flight, dep, arr, begin: formatTime(hhmm(t1), 'Z'), end: `${formatTime(hhmm(t2), 'Z')}${t2 < t1 ? ' +1' : ''}`, ac: ac || '', crew,
            info: flag ? `[${flag}]` : '',
            _marks: [['date', c('startDate')], ['duty', part(m, 1)], ['dep', part(m, 2)], ['begin', part(m, 3)], ['arr', part(m, 4)], ['end', part(m, 5)],
              ['ac', ac ? part(m, 6) : null], ['info', flag ? part(m, 7) : null], ['crew', { items: crewItems }]],
          });
          continue;
        }
        ci = null;
        m = /^(\S+?)\s*-\s*(.+?)\s*$/d.exec(subj);
        const duty = m ? m[1] : subj.trim(), info = m ? `[${m[1]}: ${m[2]}]` : '';
        const marks = m ? [['duty', part(m, 1)], ['info', part(m, 2)]] : [['duty', c('subject')]];
        if (/^(Verdadero|True)$/i.test(c('allDay').text)) {
          const e = ddmmyyyy(c('endDate').text) || d;
          for (let t = d.ymd; t <= e.ymd; t += 86400000) {
            const x = new Date(t);
            out.push({ ...dayOf(x.getUTCDate(), x.getUTCMonth(), x.getUTCFullYear()), duty, info, _marks: t === d.ymd ? [['date', c('startDate')], ...marks] : [] });
          }
        } else {
          const e = ddmmyyyy(c('endDate').text);
          out.push({
            ...d, duty, begin: timeOf(c('start').text, 'L'), end: timeOf(c('end').text, 'L', e && e.ymd > d.ymd), crew, info,
            _marks: [['date', c('startDate')], ...marks, ['begin', c('start')], ['end', c('end')], ['crew', { items: crewItems }]],
          });
        }
      }
      return out;
    },
  },
  {
    name: 'flight-records',
    // one row per flight (a pilot logbook export): flightDate "2025/08/05" | flightNumber | from | actualDepartureTime |
    // onDutyTime | takeoffTime | to | landingTime | actualArrivalTime | offDutyTime | selectedAircraftType | selectedAircraftID | ... | totalTime
    find(h) {
      const lower = h.map(t => t.toLowerCase());
      const at = (n) => (lower.includes(n) ? lower.indexOf(n) : null);
      if (!['flightdate', 'flightnumber', 'from', 'to', 'actualdeparturetime', 'actualarrivaltime', 'takeofftime', 'landingtime'].every(n => lower.includes(n))) return null;
      return {
        date: at('flightdate'), flight: at('flightnumber'), dep: at('from'), arr: at('to'),
        off: at('actualdeparturetime'), on: at('actualarrivaltime'), takeoff: at('takeofftime'), landing: at('landingtime'),
        report: at('ondutytime'), release: at('offdutytime'), ac: at('selectedaircrafttype'), registration: at('selectedaircraftid'), block: at('totaltime'),
        tkDay: at('daytakeoffs'), tkNight: at('nighttakeoffs'), ldDay: at('daylandings'), ldNight: at('nightlandings'),
      };
    },
    // Times as printed, in UTC: off / on block -> begin / end, takeoff / landing their own fields; "+1" when a time
    // falls on a later day than the flight's date. onDutyTime (on a duty's first flight) -> a C/I row before it,
    // offDutyTime (on its last) -> a C/O row after it. Info "[Block: 00:48]" (totalTime).
    rows(data, cols, { zone }) {
      const out = [];
      // "2025/08/05 06:40": the date and the time are one cell; the time is marked on its own
      const stamp = (cell) => {
        const m = /^(\d{4})[/-](\d{2})[/-](\d{2})[ T](\d{2}):(\d{2})/.exec(cell.text);
        if (!m) return null;
        const it = cell.items[0], off = cell.text.indexOf(' ') + 1;
        return {
          day: dayOf(+m[3], +m[2] - 1, +m[1]), hhmm: `${m[4]}${m[5]}`,
          timeCell: { items: it ? [{ ...it, text: cell.text.slice(off, off + 5), _src: it, _off: off }] : [] },
        };
      };
      const time = (s, from) => (s ? formatTime(s.hhmm, zone) + (s.day.ymd > from.ymd ? ' +1' : '') : '');
      for (const row of data) {
        const c = (k) => cellOf(row, cols[k]);
        const m = /^(\d{4})[/-](\d{2})[/-](\d{2})$/.exec(c('date').text);
        if (!m || !c('dep').text) continue;
        const d = dayOf(+m[3], +m[2] - 1, +m[1]);
        const [off, takeoff, landing, on] = ['off', 'takeoff', 'landing', 'on'].map(k => stamp(c(k)));
        const report = stamp(c('report')), release = stamp(c('release'));
        if (report) out.push({ ...report.day, duty: 'C/I', begin: time(report, report.day), _marks: [['ci', report.timeCell]] });
        out.push({
          ...d, duty: c('flight').text, dep: c('dep').text, arr: c('arr').text,
          begin: time(off, d), takeoff: time(takeoff, d), landing: time(landing, d), end: time(on, d),
          ac: c('ac').text, registration: c('registration').text,
          info: [c('block').text && `[Block: ${c('block').text}]`,
            ...countTags([['Takeoff Day', c('tkDay')], ['Takeoff Night', c('tkNight')], ['Landing Day', c('ldDay')], ['Landing Night', c('ldNight')]])].filter(Boolean).join(' '),
          _marks: [['date', c('date')], ['duty', c('flight')], ['dep', c('dep')], ['arr', c('arr')], ['begin', off?.timeCell], ['takeoff', takeoff?.timeCell],
            ['landing', landing?.timeCell], ['end', on?.timeCell], ['ac', c('ac')], ['registration', c('registration')], ['info', c('block')],
            ...countMarks(c('tkDay'), c('tkNight'), c('ldDay'), c('ldNight'))],
        });
        if (release) out.push({ ...d, duty: 'C/O', end: time(release, d), _marks: [['co', release.timeCell]] });
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
    const printed = found.map(f => printedPeriod(f.grid)).find(Boolean);
    const periodStart = printed ? ddMonYy(printed.split(' - ')[0]) : null;
    const rows = found.flatMap(({ grid, at, cols }) => layout.rows(grid.slice(at + 1), cols, { dateOf, zone, periodStart }));
    const published = rows.map((r) => {
      const row = outRow(r);
      for (const [field, cell] of r._marks || []) if (cell?.items?.length) mark(row, field, cell.items);
      return row;
    });
    const period = printed || periodOfRows(rows.map(r => ({ _ymd: r.ymd })));
    return { _trace: trace, format: `table-${layout.name}`, period, notices: [], recognized: published.length > 0, published, planned: [] };
  }
  return null;
}
