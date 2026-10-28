import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readPdfText } from '../src/services/pdf-text.js';
import { parseNetlinePdf } from '../src/services/pdf-roster-parser.js';

// Made-up legs in the column layout of the real export (the real files are personal data and stay out of git).
async function parseCsv(lines) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'roster-table-test-'));
  const file = path.join(dir, 'legs.csv');
  try {
    const cell = (v) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v); // as a CSV writer quotes it
    fs.writeFileSync(file, lines.map(l => l.map(cell).join(',')).join('\n'));
    return parseNetlinePdf(await readPdfText(file));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('crew legs export: Flt_Nbr/airports/AC type, local times (actual "A", else scheduled "E"), C/I and C/O per duty period, pairing/block/layover in info', async () => {
  const header = ['EMPL_NBR', 'Rotn_Beg_Dt', 'Rotn_Prng_Nbr', 'Duty_Perd_Id', 'Flt_Orig_Dt', 'Flt_Nbr', 'Dprt_Arpt_Cd', 'Arr_Arpt_Cd', 'Actl_Crew_Schlg_Ac_Typ_Cd',
    'schld_dprt_lcl_dttm', 'schld_arr_lcl_dttm', 'schld_dprt_gmt_dttm', 'schld_arr_gmt_dttm',
    'actl_dprt_lcl_dttm', 'actl_arr_lcl_dttm', 'actl_dprt_gmt_dttm', 'actl_arr_gmt_dttm', 'Actl_Duty_Rpt_Lcl_Dttm', 'Actl_Duty_Rls_Lcl_Dttm',
    'Schld_Leg_Blk_Tm_Mnt_Cnt', 'Actl_Leg_Blk_Tm_Mnt_Cnt', 'Duty_Layovr_Tm_Mnt_Cnt'];
  const leg = (rot, dp, date, flt, dep, arr, sd, sa, ad, aa, rpt, rls, blk = ['', ''], lay = '0') => ['000000001', rot, '0100', dp, date, flt, `${dep}  `, `${arr}  `, '717',
    sd, sa, sd.replace(/ \d\d/, ' 00'), sa.replace(/ \d\d/, ' 00'), ad, aa, ad && ad.replace(/ \d\d/, ' 00'), aa && aa.replace(/ \d\d/, ' 00'), rpt, rls, ...blk, lay];
  const r = await parseCsv([header,
    leg('2026-03-02', '1', '2026-03-02', '1001', 'AAA', 'BBB', '2026-03-02 09:00:00', '2026-03-02 10:30:00', '2026-03-02 08:55:00', '2026-03-02 10:18:00', '2026-03-02 08:00:00', '2026-03-02 13:14:00', ['90', '84'], '1251'),
    leg('2026-03-02', '1', '2026-03-02', '1002', 'BBB', 'AAA', '2026-03-02 11:20:00', '2026-03-02 13:00:00', '2026-03-02 11:17:00', '2026-03-02 12:44:00', '2026-03-02 08:00:00', '2026-03-02 13:14:00', ['100', '87'], '1251'),
    // the next duty period: no actual times yet, released after midnight
    leg('2026-03-02', '2', '2026-03-03', '1003', 'AAA', 'CCC', '2026-03-03 22:10:00', '2026-03-03 23:40:00', '', '', '2026-03-03 21:10:00', '2026-03-04 00:10:00', ['90', ' ']),
  ]);
  assert.equal(r.format, 'table-crew-legs');
  assert.deepEqual(r.published.map(x => [x.date, x.day, x.duty, x.dep, x.begin, x.end, x.arr, x.ac, x.info]), [
    ['2 Mar 26', 'Mon', 'C/I', '', '08:00 L', '', '', '', ''],
    ['2 Mar 26', 'Mon', '1001', 'AAA', 'A08:55 L', 'A10:18 L', 'BBB', '717', '[Pairing: 0100] [Block: 01:24]'],
    ['2 Mar 26', 'Mon', '1002', 'BBB', 'A11:17 L', 'A12:44 L', 'AAA', '717', '[Pairing: 0100] [Block: 01:27]'],
    ['2 Mar 26', 'Mon', 'C/O', '', '', '13:14 L', '', '', '[Pairing: 0100] [Layover: 20:51]'],
    ['3 Mar 26', 'Tue', 'C/I', '', '21:10 L', '', '', '', ''],
    ['3 Mar 26', 'Tue', '1003', 'AAA', 'E22:10 L', 'E23:40 L', 'CCC', '717', '[Pairing: 0100] [Block: 01:30]'],
    ['3 Mar 26', 'Tue', 'C/O', '', '', '00:10 L +1', '', '', '[Pairing: 0100]'],
  ]);
});

test('flight records export: off/on block -> begin/end, takeoff/landing times of their own, C/I from onDutyTime, C/O from offDutyTime, totalTime as block, day/night take-offs and landings (none for 0)', async () => {
  const header = ['flightDate', 'flightNumber', 'from', 'actualDepartureTime', 'onDutyTime', 'takeoffTime', 'to', 'landingTime', 'actualArrivalTime', 'offDutyTime',
    'selectedAircraftType', 'selectedAircraftID', 'totalTime', 'dayTakeoffs', 'dayLandings'];
  const r = await parseCsv([header,
    ['2025/08/05', 'XX41', 'AAA', '2025/08/05 06:40', '2025/08/05 06:00', '2025/08/05 06:46', 'BBB', '2025/08/05 07:25', '2025/08/05 07:28', '', 'E145', 'G-ABCD', '00:48', '1', '1'],
    // landing and release after midnight
    ['2025/08/05', 'XX42', 'BBB', '2025/08/05 22:30', '', '2025/08/05 22:41', 'AAA', '2025/08/06 00:12', '2025/08/06 00:15', '2025/08/06 00:30', 'E145', 'G-ABCD', '01:45', '0', '0'],
  ]);
  assert.equal(r.format, 'table-flight-records');
  assert.deepEqual(r.published.map(x => [x.date, x.day, x.duty, x.dep, x.begin, x.takeoff, x.landing, x.end, x.arr, x.ac, x.registration, x.info]), [
    ['5 Aug 25', 'Tue', 'C/I', '', '06:00 Z', '', '', '', '', '', '', ''],
    ['5 Aug 25', 'Tue', 'XX41', 'AAA', '06:40 Z', '06:46 Z', '07:25 Z', '07:28 Z', 'BBB', 'E145', 'G-ABCD', '[Block: 00:48] [Takeoff Day: 1] [Landing Day: 1]'],
    ['5 Aug 25', 'Tue', 'XX42', 'BBB', '22:30 Z', '22:41 Z', '00:12 Z +1', '00:15 Z +1', 'AAA', 'E145', 'G-ABCD', '[Block: 01:45]'],
    ['5 Aug 25', 'Tue', 'C/O', '', '', '', '', '00:30 Z +1', '', '', '', ''],
  ]);
});

test('Raido "Performed Activities" with "01 Sat" dates: month from the printed period, "0000" CI is no check-in, the "Crew:" line is the flight\'s crew', async () => {
  const pad = (cells) => [...cells, ...Array(20 - cells.length).fill('')];
  const r = await parseCsv([
    pad(['', '', '', '', '', '', '', 'Performed Activities']),
    pad(['', '', '', '', '', '', '', '(01FEB20 - 31MAR20)']),
    pad(['TimeMode UTC']),
    ['Date', '', 'Des.', 'Code', '', 'LE', 'Type', '', 'Registration', '', 'Dep', 'Arr', '', 'CI', 'STD', 'ATD', '', 'STA', 'ATA', 'CO'],
    pad(['28 Fri', '', '', 'XX1', '', '', 'ER4', '', 'GABCD', '', 'AAA', 'BBB', '1410', '', '1510', '1518', '', '1605', '1610']),
    pad(['', '', '', '', 'Crew: CA: SMITH, Ann, FO(X): DOE, Bob']),
    pad(['', '', '', 'XX2', '', '', 'ER4', '', 'GABCD', '', 'BBB', 'AAA', '0000', '', '1635', '1700', '', '1730', '1754', '1814']),
    pad(['01 Sun', '', '', 'DO', '', '', '', '', '', '', 'AAA', 'AAA', '0000', '', '0000', '', '', '2359']),
  ]);
  assert.equal(r.format, 'table-raido');
  assert.deepEqual(r.published.map(x => [x.date, x.day, x.duty, x.dep, x.begin, x.end, x.arr, x.crew]), [
    ['28 Feb 20', 'Fri', 'C/I', '', '14:10 Z', '', '', ''],
    ['28 Feb 20', 'Fri', 'XX1', 'AAA', '15:10 Z', '16:05 Z', 'BBB', '[CA - SMITH, Ann][FO(X) - DOE, Bob]'],
    ['28 Feb 20', 'Fri', 'XX2', 'BBB', '16:35 Z', '17:30 Z', 'AAA', ''],
    ['28 Feb 20', 'Fri', 'C/O', '', '', '18:14 Z', '', ''],
    ['1 Mar 20', 'Sun', 'DO', 'AAA', '00:00 Z', '23:59 Z', 'AAA', ''],
  ]);
});

test('Crew Roster Report as CSV: C/I and C/O rows, times UTC then local, DC and A/C Reg on the activity, BH as block, DHrs/FDP/Max FDP on the C/O, the Hotel cell in info', async () => {
  const header = ['Date', 'DC', 'Activity', 'C/I(Z)', 'C/I(L)', 'C/O(Z)', 'C/O(L)', 'From', 'Start(Z)', 'Start(L)', 'To', 'Finish(Z)', 'Finish(L)', 'BH', 'DHrs', 'FDP', 'Max FDP', 'Hotel', 'A/C Reg'];
  const r = await parseCsv([header,
    ['16Sep26', '', 'OFF', '', '', '', '', 'AAA', '2200-1', '0000', 'AAA', '2159', '2359', '', '', '', '', '', ''],
    ['01Oct26', '', 'XX1', '0725', '0825', '', '', 'AAA', '0910', '1010', 'BBB', '1200', '1400', '2:50', '', '', '', '', 'ABCDE'],
    ['01Oct26', 'DH', 'POSTD', '', '', '1720', '1920', 'BBB', '1410', '1610', 'CCC', '1650', '1850', '', '9:55', '9:25', '13:00', 'PNR1 (Y)', ''],
    ['01Oct26', '', 'HTL', '', '', '', '', 'CCC', '1720', '1920', 'CCC', '0725+1', '0925+1', '', '', '', '', 'Hotel on CCC', ''],
  ]);
  assert.equal(r.format, 'table-roster-report');
  assert.deepEqual(r.published.map(x => [x.date, x.dc, x.duty, x.dep, x.begin, x.end, x.arr, x.registration, x.info]), [
    ['16 Sep 26', '', 'OFF', 'AAA', '22:00 Z -1 / 00:00 L', '21:59 Z / 23:59 L', 'AAA', '', ''],
    ['1 Oct 26', '', 'C/I', 'AAA', '07:25 Z / 08:25 L', '', '', '', ''],
    ['1 Oct 26', '', 'XX1', 'AAA', '09:10 Z / 10:10 L', '12:00 Z / 14:00 L', 'BBB', 'ABCDE', '[Block: 2:50]'],
    ['1 Oct 26', 'DH', 'POSTD', 'BBB', '14:10 Z / 16:10 L', '16:50 Z / 18:50 L', 'CCC', '', 'PNR1 (Y)'],
    ['1 Oct 26', '', 'C/O', '', '', '17:20 Z / 19:20 L', 'CCC', '', '[Duty: 9:55] [FDP: 9:25] [Max FDP: 13:00]'],
    ['1 Oct 26', '', 'HTL', 'CCC', '17:20 Z / 19:20 L', '07:25 Z +1 / 09:25 L +1', 'CCC', '', 'Hotel on CCC'],
  ]);
});

test('Crew Roster Report as CSV with only the local times: "HH:MM L", AC Type, a line with no date on the date above it', async () => {
  const header = ['Date', 'DC', 'Activity', 'C/I(L)', 'C/O(L)', 'From', 'Start(L)', 'To', 'Finish(L)', 'AC Type', 'BH', 'DHrs', 'FDP', 'Max FDP', 'EXT', 'Hotel'];
  const r = await parseCsv([header,
    ['17Dec25', '', 'XX1', '0555', '', 'AAA', '0758', 'BBB', '0900', '79N', '1:02', '', '', '', '0', ''],
    ['', '', 'XX2', '', '0051+1', 'BBB', '2203', 'CCC', '0021+1', '79N', '2:18', '14:21', '13:51', '17:00', '0', ''],
    ['', '', 'Hotel', '', '', 'CCC', '0120+1', 'CCC', '1100+2', '', '', '', '', '', '0', 'Hotel on CCC'],
  ]);
  assert.equal(r.format, 'table-roster-report');
  assert.deepEqual(r.published.map(x => [x.date, x.duty, x.dep, x.begin, x.end, x.arr, x.ac, x.info]), [
    ['17 Dec 25', 'C/I', 'AAA', '05:55 L', '', '', '', ''],
    ['17 Dec 25', 'XX1', 'AAA', '07:58 L', '09:00 L', 'BBB', '79N', '[Block: 1:02]'],
    ['17 Dec 25', 'XX2', 'BBB', '22:03 L', '00:21 L +1', 'CCC', '79N', '[Block: 2:18]'],
    ['17 Dec 25', 'C/O', '', '', '00:51 L +1', 'CCC', '', '[Duty: 14:21] [FDP: 13:51] [Max FDP: 17:00]'],
    ['17 Dec 25', 'Hotel', 'CCC', '01:20 L +1', '11:00 L +2', 'CCC', '', 'Hotel on CCC'],
  ]);
});

test('flights with their crew: local times, crew "[CP - id - name]" (several in one cell), Block and Credit in info (decimal hours as hh:mm)', async () => {
  const header = ['Flight', 'Date', 'A/C Type', 'Tail', 'Origin', 'Dest', 'Depart', 'Arrive', 'Block', 'Credit', 'Captain', 'First Officer', 'Flight Attendant'];
  const r = await parseCsv([header,
    ['3761', '03/01/2025', 'ER7', '', 'AAA', 'BBB', '20:40', '21:44', '02:04', '01:58', '051471 Ann Smith', '064757 Bob Doe', '063737 Cat Roe 079777 Dan Van Lee'],
    ['3793', '03/22/2025', 'ER7', 'N123', 'BBB', 'AAA', '17:00', '19:59', '01:59', '01:53', '051471 Ann Smith', '064757 Bob Doe', ''],
    ['3794', '03/22/2025', 'ER7', 'N123', 'AAA', 'BBB', '21:02', '22:11', '1.15', '0.97', '051471 Ann Smith', '', ''],
  ]);
  assert.equal(r.format, 'table-crew-flights');
  assert.deepEqual(r.published.map(x => [x.date, x.duty, x.registration, x.dep, x.begin, x.end, x.arr, x.ac, x.crew, x.info]), [
    ['1 Mar 25', '3761', '', 'AAA', '20:40 L', '21:44 L', 'BBB', 'ER7', '[CP - 051471 - Ann Smith][FO - 064757 - Bob Doe][FA - 063737 - Cat Roe][FA - 079777 - Dan Van Lee]', '[Block: 02:04] [Credit: 01:58]'],
    ['22 Mar 25', '3793', 'N123', 'BBB', '17:00 L', '19:59 L', 'AAA', 'ER7', '[CP - 051471 - Ann Smith][FO - 064757 - Bob Doe]', '[Block: 01:59] [Credit: 01:53]'],
    ['22 Mar 25', '3794', 'N123', 'AAA', '21:02 L', '22:11 L', 'BBB', 'ER7', '[CP - 051471 - Ann Smith]', '[Block: 01:09] [Credit: 00:58]'],
  ]);
});

test('Crew Roster Report as CSV with homebase (B) times, headers "Date$": "11:10 Z / 13:10 B", Turn in info', async () => {
  const header = ['Date$', 'DC$', 'Activity$', 'C/I(Z)$', 'C/O(Z)$', 'From$', 'Start(Z)$', 'To$', 'Finish(Z)$', 'AC Type$', 'Turn$', 'BH$', 'DHrs$', '1$', 'Ext$', 'Hotel$', 'C/I(B)$', 'C/O(B)$', 'Start(B)$', 'Finish(B)$'];
  const r = await parseCsv([header,
    ['02Jul26', '', '7166', '1255', '', 'AAA', '1511', 'BBB', '1845', '32A', '0:42', '', '', '0', '0', '', '1455', '', '1711', '2045'],
    ['', '', '7167', '', '2340', 'BBB', '1927', 'AAA', '2310', '32A', '', '7:17', '12:30', '0', '0', '', '', '0140+1', '2127', '0110+1'],
  ]);
  assert.equal(r.format, 'table-roster-report');
  assert.deepEqual(r.published.map(x => [x.date, x.duty, x.dep, x.begin, x.end, x.arr, x.ac, x.info]), [
    ['2 Jul 26', 'C/I', 'AAA', '12:55 Z / 14:55 B', '', '', '', ''],
    ['2 Jul 26', '7166', 'AAA', '15:11 Z / 17:11 B', '18:45 Z / 20:45 B', 'BBB', '32A', '[Turn: 0:42]'],
    ['2 Jul 26', '7167', 'BBB', '19:27 Z / 21:27 B', '23:10 Z / 01:10 B +1', 'AAA', '32A', '[Block: 7:17]'],
    ['2 Jul 26', 'C/O', '', '', '23:40 Z / 01:40 B +1', 'AAA', '', '[Duty: 12:30]'],
  ]);
});

test('Raido report saved with its field names (RaidoLab_Name, Text2, TimeText_CI ...): as the printed one, block from MimerValue1', async () => {
  const header = ['RaidoLab_Name', 'Text4', 'Text2', 'CrewOnBoardText', 'Text5', 'Text8', 'Text10', 'RaidoLab_EmpNo', 'Text11', 'Text12', 'TimeText_CI', 'TimeText_ValidFrom',
    'TimeText_ActualValidFrom', 'RaidoLab_ShortCode', 'TimeText_ValidToString', 'TimeText_ActualValidToString', 'TimeText_CO_String', 'MimerValue1'];
  const r = await parseCsv([header,
    ['Name', '', '', '', '', '', '', 'EmpNo', '', '', '', '', '', 'Shortcode'],
    ['13Nov24', '', 'XX762', '', '', 'ATR', 'GABCD', '', 'AAA', 'BBB', '0640', '0740', '0802', '', '0900 ', '0911 ', '', '01:09'],
    ['', '', '', 'Crew: CAP: SMITH, Ann, FO(X): DOE, Bob'],
    ['', 'X', 'XX763', '', '', 'ATR', 'GABCD', '', 'BBB', 'AAA', '0000', '1600', '1725', '', '1715 ', '1824 ', '1844 ', '00:59'],
  ]);
  assert.equal(r.format, 'table-raido');
  assert.deepEqual(r.published.map(x => [x.date, x.duty, x.dep, x.begin, x.end, x.arr, x.registration, x.crew, x.info]), [
    ['13 Nov 24', 'C/I', '', '06:40 Z', '', '', '', '', ''],
    ['13 Nov 24', 'XX762', 'AAA', '07:40 Z', '09:00 Z', 'BBB', 'GABCD', '[CAP - SMITH, Ann][FO(X) - DOE, Bob]', '[ATD 08:02 Z] [ATA 09:11 Z] [Block: 01:09]'],
    ['13 Nov 24', 'XX763', 'BBB', '16:00 Z', '17:15 Z', 'AAA', 'GABCD', '', '[Des. X] [ATD 17:25 Z] [ATA 18:24 Z] [Block: 00:59]'],
    ['13 Nov 24', 'C/O', '', '', '18:44 Z', '', '', '', ''],
  ]);
});

test('block times per leg: flight key -> duty, dep, arr; local times, Duration minutes as block, PIC/SIC numbers as crew', async () => {
  const header = ['Employee id', 'Crew id', 'Flight', 'Departure Date', 'Block off', 'Arrival Date', 'Block on', 'Aircraft Registration', 'Aircraft Type', 'Duration', 'Landing', 'PIC', 'SIC'];
  const r = await parseCsv([header,
    ['1', '1', 'XX7372-20250601-AAA-BBB', '2025-06-01', '14:18:00', '2025-06-01', '17:33:00', 'SEROK', '32N', '255', 'false', '69885', ''],
    ['1', '1', 'XX7373-20250601-BBB-CCC', '2025-06-01', '23:10:00', '2025-06-02', '00:40:00', 'SEROK', '32N', '90', 'true', '69885', '123'],
  ]);
  assert.equal(r.format, 'table-block-times');
  assert.deepEqual(r.published.map(x => [x.date, x.duty, x.dep, x.begin, x.end, x.arr, x.registration, x.ac, x.crew, x.info]), [
    ['1 Jun 25', 'XX7372', 'AAA', '14:18 L', '17:33 L', 'BBB', 'SEROK', '32N', '[PIC - 69885]', '[Block: 04:15]'],
    ['1 Jun 25', 'XX7373', 'BBB', '23:10 L', '00:40 L +1', 'CCC', 'SEROK', '32N', '[PIC - 69885][SIC - 123]', '[Block: 01:30]'],
  ]);
});

test('logbook by day with routes: the day code a row of its own, legs on the date above, totals after a blank line left out', async () => {
  const header = ['Date', 'Code', 'Fleet', 'Rego', 'PIC', 'FO', 'PAX', 'Route', 'Takeoff', 'Landing', 'Approach', 'Instrument Minutes', 'Day Hours', 'Night Hours'];
  const r = await parseCsv([header, [],
    ['Jan 01 2025', ''],
    ['Jan 03 2025', 'DDO', '73H', 'VHYFZ', 'Y', 'ANN SMITH', '', 'AAA-BBB', 'DAY', 'NIGHT', 'ILS', '30', '  2:06  ', ''],
    ['', '', '7M8', 'VH8IE', 'Y', 'ANN SMITH', '', 'BBB-AAA', '', '', '', '0', ' 0:35 ', ' 1:00 '],
    ['Jan 04 2025', 'BLANK'],
    [], [' ', 'Fleet Type', ' Total Flying Hours'], ['', '73H', ' 560:07 '],
  ]);
  assert.equal(r.format, 'table-route-log');
  assert.deepEqual(r.published.map(x => [x.date, x.duty, x.dep, x.arr, x.ac, x.registration, x.crew, x.info]), [
    ['3 Jan 25', 'DDO', '', '', '', '', '', ''],
    ['3 Jan 25', '', 'AAA', 'BBB', '73H', 'VHYFZ', '[FO - ANN SMITH]', '[Day: 2:06] [Takeoff Day: 1] [Landing Night: 1] [Approach: ILS] [Instrument: 30]'],
    ['3 Jan 25', '', 'BBB', 'AAA', '7M8', 'VH8IE', '[FO - ANN SMITH]', '[Day: 0:35] [Night: 1:00]'],
    ['4 Jan 25', 'BLANK', '', '', '', '', '', ''],
  ]);
});

test('calendar export: events in time order, C/I and C/O rows, "Z / L" times with day offsets from dtstart\'s day', async () => {
  const header = ['dtstart', 'dtend', 'dtstamp', 'organizer', 'uid', 'attendee', 'created', 'description', 'last-modified', 'location', 'sequence', 'status', 'summary', 'transp'];
  const ev = (start, end, desc) => [start, end, '', '', '', '', '', desc, '', '', '', '', '', ''];
  const r = await parseCsv([header,
    ev('2024-05-25T04:01:00Z', '2024-05-26T04:00:00Z', 'GDO YKF\\nStart 0401Z / 0001L\\nEnd 0400Z / 0000L\\nDuration: 23:59\\n'),
    ev('2024-05-24T00:40:00Z', '2024-05-24T06:10:00Z', 'F8521 YKF - YYC\\nCI 0040Z / 2040L\\nSTD 0140Z / 2140L\\nSTA 0555Z / 2355L\\nCO 0610Z / 0010L\\nRD: L,Y,X\\nDuration: 05:30, BLH: 04:07\\nSTC: J\\nAircraft: 7M8 - 7M8 - 7M8  - C-FLQZ\\n'),
  ]);
  assert.equal(r.format, 'table-calendar-events');
  assert.deepEqual(r.published.map(x => [x.date, x.duty, x.dep, x.begin, x.end, x.arr, x.ac, x.registration, x.info]), [
    ['24 May 24', 'C/I', 'YKF', '00:40 Z / 20:40 L -1', '', '', '', '', ''],
    ['24 May 24', 'F8521', 'YKF', '01:40 Z / 21:40 L -1', '05:55 Z / 23:55 L -1', 'YYC', '7M8', 'C-FLQZ', '[Block: 04:07] [Duration: 05:30] [RD: L,Y,X] [STC: J]'],
    ['24 May 24', 'C/O', '', '', '06:10 Z / 00:10 L', 'YYC', '', '', ''],
    ['25 May 24', 'GDO', 'YKF', '04:01 Z / 00:01 L', '04:00 Z +1 / 00:00 L +1', 'YKF', '', '', '[Duration: 23:59]'],
  ]);
});

test('logbook flat export: PIC name as crew, time by function "[PIC: ..] [CoPilot: ..] [Instructor: ..]", a sim session "[Sim: ..]"', async () => {
  const header = ['Id', 'Name', 'Date', 'DepPlace', 'DepTime', 'ArrPlace', 'ArrTime', 'ACType', 'Reg', 'FltTime', 'PicName', 'TKoffsDay', 'TKoffsNight', 'LandsDay', 'LandsNight', 'PIC', 'CoPlt', 'Instr', 'SimTime', 'SimType'];
  const r = await parseCsv([header,
    ['1', 'DOE BOB', '16/08/24', 'AAA', '06:00', 'BBB', '08:05', '32Q', 'EI-ABC', '02:05', 'Self', '1', '', '1', '', '02:05', '', '02:05', '', ''],
    ['1', 'DOE BOB', '17/08/24', 'BBB', '09:00', 'AAA', '10:00', '32Q', 'EI-ABC', '01:00', 'SMITH, ANN', '', '', '', '', '', '01:00', '', '', ''],
    ['1', 'DOE BOB', '18/08/24', 'AAA', '01:15', 'AAA', '05:15', 'AT7', '', '', '', '', '', '', '', '', '', '', '04:00', 'FFS'],
  ]);
  assert.equal(r.format, 'table-logbook');
  assert.deepEqual(r.published.map(x => [x.date, x.duty, x.dep, x.arr, x.crew, x.info]), [
    ['16 Aug 24', '', 'AAA', 'BBB', '[PIC - Self]', '[Flight: 02:05] [Takeoff Day: 1] [Landing Day: 1] [PIC: 02:05] [Instructor: 02:05]'],
    ['17 Aug 24', '', 'BBB', 'AAA', '[PIC - SMITH, ANN]', '[Flight: 01:00] [CoPilot: 01:00]'],
    ['18 Aug 24', 'FFS', 'AAA', 'AAA', '', '[Sim: 04:00]'],
  ]);
});

test('a printed take-off / landing remark (no day or night) as counts: "[Takeoff Day/Night: 1] [Landing Day/Night: 1]"', async () => {
  const { takeoffLandingTags } = await import('../src/services/pdf-roster-parser.js');
  assert.equal(takeoffLandingTags('Take-off, Landing'), '[Takeoff Day/Night: 1] [Landing Day/Night: 1]');
  assert.equal(takeoffLandingTags('[TT 01:30] 1Take-off, 1Landing'), '[TT 01:30] [Takeoff Day/Night: 1] [Landing Day/Night: 1]');
  assert.equal(takeoffLandingTags('Landing [DT 12:41]'), '[Landing Day/Night: 1] [DT 12:41]');
  assert.equal(takeoffLandingTags('Seat Landing lpc/opc'), 'Seat Landing lpc/opc'); // a word in other text
});

test('Flight Time Report: period from From: / To:, UTC ATD / ATA ("+1" when ATA is earlier), Block / Stick, Y take-off / landing, SDC, crew with ids', async () => {
  const header = ['Flight Date', 'A/C Type', 'Flt No', 'A/C Reg', 'From', 'To', 'ATD', 'ATA', 'Block', 'Stick', 'Take off', 'Landing', 'SDC', 'Crew Name', 'DE Time'];
  const r = await parseCsv([['Flight Time Report'], ['CA - ANN SMITH #455487'], ['From:', '04-Dec-2024'], ['To:', '21-Dec-2024'], ['Total Records:', '2'], [], header,
    ['10-DEC-2024', '77L', '0440', 'A6EWB', 'AAA', 'BBB', '22:01', '10:25', '12:24', '12:24', 'Y', 'Y', '', 'BobDoe(420949-CA),AnnSmith(455487-CA),CatRoe(494286-FO)', ''],
    ['18-DEC-2024', '77W', '0721', 'A6EGE', 'BBB', 'AAA', '12:47', '17:31', '04:44', '02:00', '', 'Y', 'B72,T', 'AnnSmith(455487-CA)', ''],
  ]);
  assert.equal(r.format, 'table-flight-time-report');
  assert.equal(r.period, '04Dec24 - 21Dec24');
  assert.deepEqual(r.published.map(x => [x.date, x.duty, x.dep, x.begin, x.end, x.arr, x.ac, x.registration, x.crew, x.info]), [
    ['10 Dec 24', '0440', 'AAA', '22:01 Z', '10:25 Z +1', 'BBB', '77L', 'A6EWB', '[CA - 420949 - BobDoe][CA - 455487 - AnnSmith][FO - 494286 - CatRoe]',
      '[Block: 12:24] [Stick: 12:24] [Takeoff Day/Night: 1] [Landing Day/Night: 1]'],
    ['18 Dec 24', '0721', 'BBB', '12:47 Z', '17:31 Z', 'AAA', '77W', 'A6EGE', '[CA - 455487 - AnnSmith]', '[Block: 04:44] [Stick: 02:00] [Landing Day/Night: 1] [SDC: B72,T]'],
  ]);
});

test('crew duties export (a line per duty or leg): activities, C/I - legs - C/O per duty_start, flh / duty_mins as hh:mm, PS, FOB, codes of a doubled line', async () => {
  const header = ['klm_id', 'first_name', 'last_name', 'fleet_cd', 'rank_cd', 'contract_cd', 'dib_ind', 'duty_start', 'act', 'act_assign_sdc', 'trip_assign_sdc', 'trip_sdc', 'item_sdc', 'FOB',
    'item_work_cd', 'flight', 'flt_dt_utc', 'dep_stat', 'arr_stat', 'subtype', 'ac_reg', 'detailcode', 'dty_seq_no', 'item_seq_no', 'leg_start', 'leg_end', 'flh', 'route_days', 'trip_cycle_len', 'duty_en', 'duty_mins'];
  const line = (v) => header.map(h => v[h] ?? '');
  const p = { klm_id: '1', first_name: 'ANN', last_name: 'SMITH', fleet_cd: '777', rank_cd: 'CP', contract_cd: '100', dib_ind: 'N' };
  const act = (sdc) => line({ ...p, duty_start: '13/02/2013 06:45', act: 'VTF', act_assign_sdc: sdc, FOB: 'CP', duty_en: '13/02/2013 12:45', duty_mins: '360' });
  const leg = (v) => line({ ...p, duty_start: '14/02/2013 19:45', item_work_cd: 'OP', subtype: '772', ac_reg: 'PHABC', duty_en: '15/02/2013 11:07', duty_mins: '922', ...v });
  const r = await parseCsv([header,
    line({ ...p, trip_sdc: 'PM', FOB: 'CP' }),
    act('Z771'), act('VTFQ'),
    leg({ FOB: 'FO', flight: 'XX429', dep_stat: 'AAA', arr_stat: 'BBB', leg_start: '14/02/2013 20:30', leg_end: '15/02/2013 02:23', flh: '353' }),
    leg({ FOB: 'CP', item_work_cd: 'PS', flight: 'XX430', dep_stat: 'BBB', arr_stat: 'AAA', leg_start: '15/02/2013 03:43', leg_end: '15/02/2013 10:37', flh: '414' }),
  ]);
  assert.equal(r.format, 'table-crew-duties');
  assert.deepEqual(r.published.map(x => [x.date, x.dc, x.duty, x.dep, x.begin, x.end, x.arr, x.ac, x.registration, x.info]), [
    ['13 Feb 13', '', 'VTF', '', '06:45 Z', '12:45 Z', '', '', '', '[Act SDC: Z771] [Act SDC: VTFQ]'],
    ['14 Feb 13', '', 'C/I', 'AAA', '19:45 Z', '', '', '', '', ''],
    ['14 Feb 13', '', 'XX429', 'AAA', '20:30 Z', '02:23 Z +1', 'BBB', '772', 'PHABC', '[Block: 05:53] [FOB: FO]'],
    ['15 Feb 13', 'PS', 'XX430', 'BBB', '03:43 Z', '10:37 Z', 'AAA', '772', 'PHABC', '[Block: 06:54]'],
    ['14 Feb 13', '', 'C/O', '', '', '11:07 Z +1', 'AAA', '', '', '[Duty: 15:22]'],
  ]);
});

test('Emirates Crew Roster (Detailed Report): the month from "Staff : ... 01/09/2024", two legs in one day line, "(+)" as +1, codes with their details', async () => {
  const header = ['Day/Date', 'Duty/Trip Code', 'Label', 'Report', 'Time(Dep-Arv)', 'Duty Details', 'A/C', 'End', 'Block Hours'];
  const r = await parseCsv([
    ['Emirates Crew Roster (Detailed Report)', 'Staff :', '460000', 'Name :', 'Ann Smith [FO]', '01/09/2024'],
    header,
    ['01-SUN', '4213', '', '00:50', '02:17-09:59', 'XX213 [AAA-BBB]', '77W', '10:29', '15: 42'],
    ['02-MON', '', '', '', '-', 'Rest Day', '', '', '-'],
    ['03-TUE', '4213 4213', 'M', '10:05', '10:52-14:06 16:29-01:55(+)', 'XX917 [BBB-CCC] XX918 [CCC-DDD]', '77X 77X', '02:25 (+)', '04: 14 03: 26'],
    ['04-WED', 'XX', 'M', '', '-', 'Day Off', '', '', '-'],
  ]);
  assert.equal(r.format, 'table-emirates-detailed');
  assert.equal(r.period, '01Sep24 - 30Sep24');
  assert.deepEqual(r.published.map(x => [x.date, x.duty, x.dep, x.begin, x.end, x.arr, x.ac, x.info]), [
    ['1 Sep 24', 'C/I', 'AAA', '00:50 L', '', '', '', ''],
    ['1 Sep 24', 'XX213', 'AAA', '02:17 L', '09:59 L', 'BBB', '77W', '[Block: 15:42] [Trip: 4213]'],
    ['1 Sep 24', 'C/O', '', '', '10:29 L', 'BBB', '', ''],
    ['2 Sep 24', 'Rest Day', '', '', '', '', '', ''],
    ['3 Sep 24', 'C/I', 'BBB', '10:05 L', '', '', '', ''],
    ['3 Sep 24', 'XX917', 'BBB', '10:52 L', '14:06 L', 'CCC', '77X', '[Block: 04:14] [Trip: 4213] [Label: M]'],
    ['3 Sep 24', 'XX918', 'CCC', '16:29 L', '01:55 L +1', 'DDD', '77X', '[Block: 03:26]'],
    ['3 Sep 24', 'C/O', '', '', '02:25 L +1', 'DDD', '', ''],
    ['4 Sep 24', 'XX', '', '', '', '', '', '[XX: Day Off] [Label: M]'],
  ]);
});

test('Spanish pilot logbook: "01.18" times as 01:18, UTC, landings by day / night, function times, a simulator session on its own', async () => {
  const head = ['FECHA', 'SALIDA', '', 'LLEGADA', '', 'AERONAVE', '', 'TIEMPO MONOPILOTO', '', 'TIEMPO MULTIPILOTO', 'TIEMPO TOTAL VUELO', 'NOMBRE PIC', 'ATERRIZAJES', '',
    'HORA Y CONDICION', '', 'FUNCION', '', '', '', 'SESION DE ENTRENADOR SINTETICO', '', '', 'OBSERVACIONES', 'REMARK'];
  const sub = ['', 'Lugar', 'Hora', 'Lugar', 'Hora', 'Fab.mod.var.', 'Matricula', 'SE', 'ME', '', '', '', 'Dia', 'Noche', 'Noche', 'IFR', 'Piloto', 'Co-piloto', 'Dbl-mando', 'Instuctor', 'Fecha', 'Tipo', 'Tot. hora sesion'];
  const dash = (n) => Array(n).fill('--');
  const r = await parseCsv([head, sub,
    ['13/01/25', 'LEMD', '20:08', 'LECO', '21:18', 'B737-B24', 'ECMUZ', '--', '--', '01.10', '01.10', 'SMITH', '0', '1', '00.18', '01.10', '01.10', ...dash(8)],
    [...dash(20), '26/02/25', 'SIM-1192', '06.00', '--', '--'],
  ]);
  assert.equal(r.format, 'table-spanish-logbook');
  assert.deepEqual(r.published.map(x => [x.date, x.duty, x.dep, x.begin, x.end, x.arr, x.ac, x.registration, x.crew, x.info]), [
    ['13 Jan 25', '', 'LEMD', '20:08 Z', '21:18 Z', 'LECO', 'B737-B24', 'ECMUZ', '[PIC - SMITH]', '[Flight: 01:10] [Landing Night: 1] [Night: 00:18] [IFR: 01:10] [PIC: 01:10]'],
    ['26 Feb 25', 'SIM-1192', '', '', '', '', '', '', '', '[Sim: 06:00]'],
  ]);
});

test('Outlook calendar export (Iberia, Spanish): "Firma" as C/I with pairing, flights from the subject in UTC with aircraft and mark, crew from the description, all-day codes a row per day', async () => {
  const head = ['Asunto', 'Fecha de comienzo', 'Comienzo', 'Fecha de finalización', 'Finalización', 'Todo el día', 'Reminder on/off', 'Description', 'Location'];
  const r = await parseCsv([head,
    ['X - DIA LIBRE', '06/09/2025', '00:01', '07/09/2025', '23:59', 'Verdadero', 'Falso', '', ''],
    ['Firma 14:30 Pairing 1589', '09/09/2025', '14:30', '09/09/2025', '15:45', 'Falso', 'Falso', '', ''],
    ['IB721  AAA1345-BBB1615 / 350 +O', '09/09/2025', '15:45', '09/09/2025', '18:15', 'Falso', 'Verdadero',
      'TECNICOS\n--------\nCT->I3 113794 DOE SMITH         , JOHN\nTCP\n---\nSC   291874 ROE                 ,ANN\n---', ''],
    ['IB212  BBB2050-AAA0405 / 359', '13/09/2025', '22:50', '14/09/2025', '06:05', 'Falso', 'Falso', '', ''],
    ['I4 - INSTRUCTOR / equipo: MZ3', '16/09/2025', '16:00', '16/09/2025', '17:30', 'Falso', 'Falso', '', ''],
  ]);
  assert.equal(r.format, 'table-outlook-calendar');
  assert.deepEqual(r.published.map(x => [x.date, x.duty, x.dep, x.begin, x.end, x.arr, x.ac, x.crew, x.info]), [
    ['6 Sep 25', 'X', '', '', '', '', '', '', '[X: DIA LIBRE]'],
    ['7 Sep 25', 'X', '', '', '', '', '', '', '[X: DIA LIBRE]'],
    ['9 Sep 25', 'C/I', 'AAA', '14:30 L', '', '', '', '', '[Pairing: 1589]'],
    ['9 Sep 25', 'IB721', 'AAA', '13:45 Z', '16:15 Z', 'BBB', '350', '[CT - 113794 - DOE SMITH, JOHN][SC - 291874 - ROE, ANN]', '[+O]'],
    ['13 Sep 25', 'IB212', 'BBB', '20:50 Z', '04:05 Z +1', 'AAA', '359', '', ''],
    ['16 Sep 25', 'I4', '', '16:00 L', '17:30 L', '', '', '', '[I4: INSTRUCTOR / equipo: MZ3]'],
  ]);
});

test('a CSV whose lines were quoted twice is unwrapped; blocks logbook (Blocks Off/On Actual, "1h55" durations, crew names)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'roster-table-test-'));
  const file = path.join(dir, 'log.csv');
  try {
    const head = ['Crew', 'Blocks Off Actual', 'AF_DEP', 'AF_ARR', 'Blocks On Actual', 'Flight #', 'AC_REG', 'AC_MODEL', 'Takeoffs Day', 'Landings Day', 'TIME_TOTAL', 'Flight Time Actual', 'PIC Time'];
    const vals = ['06.07.2024 23:05', 'LFPB', 'LEMH', '07.07.2024 01:00', 'JFA06A', 'LX-PCI', 'PC24', '1', '1', '1h55', "48'", '1h55'];
    // each line quoted once more by a second CSV writer; the export left the first field (with its comma) unquoted
    const wrap = (inner) => `"${inner.replace(/"/g, '""')}"`;
    fs.writeFileSync(file, [
      wrap(head.map(h => `"${h}"`).join(',').replace(/^"Crew"/, 'Crew')),
      wrap(`Ann Doe, Bob Roe ,${vals.map(v => `"${v}"`).join(',')}`),
    ].join('\r\n'));
    const r = parseNetlinePdf(await readPdfText(file));
    assert.equal(r.format, 'table-blocks-logbook');
    assert.deepEqual(r.published.map(x => [x.date, x.duty, x.registration, x.dep, x.begin, x.end, x.arr, x.ac, x.crew, x.info]), [
      ['6 Jul 24', 'JFA06A', 'LX-PCI', 'LFPB', '23:05 Z', '01:00 Z +1', 'LEMH', 'PC24', '[Crew - Ann Doe][Crew - Bob Roe]', '[Block: 01:55] [Flight: 00:48] [Takeoff Day: 1] [Landing Day: 1] [PIC: 01:55]'],
    ]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('FTL duty legs: Start Duty / Check-Out as C/I / C/O with the duty totals, a leg "EGLK - EGAE" with off / take-off / landing / on, a code', async () => {
  const head = ['&nbsp;', 'Date', 'AC', 'Funct.', 'Duty', 'Start Duty', 'Off-Block', 'Take Off', 'Ldg', 'On-Block', 'Check-Out', 'Reason', 'Break time', 'Sct', 'Flight Time', 'Block Time (DP)',
    'Flight Duty Period (act)', 'Duty Period (DP)'];
  const r = await parseCsv([head,
    ['', '11/10/2019', 'G-FFFC', 'SIC', 'EGLK - EGAE', '14:10', '14:40', '14:49', '16:15', '16:20', '22:20', 'Rest', '', '1', '1:26', '1:40', '7:55', '8:10'],
    ['', '27/10/2019', '', '', 'OFF', '0:00', '', '', '', '', '23:59', 'Rest'],
  ]);
  assert.equal(r.format, 'table-duty-legs');
  assert.deepEqual(r.published.map(x => [x.date, x.duty, x.registration, x.dep, x.begin, x.takeoff, x.landing, x.end, x.arr, x.info]), [
    ['11 Oct 19', 'C/I', '', 'EGLK', '14:10 Z', '', '', '', '', ''],
    ['11 Oct 19', '', 'G-FFFC', 'EGLK', '14:40 Z', '14:49 Z', '16:15 Z', '16:20 Z', 'EGAE', ''],
    ['11 Oct 19', 'C/O', '', '', '', '', '', '22:20 Z', 'EGAE', '[Flight: 01:26] [Block: 01:40] [FDP: 07:55] [Duty: 08:10]'],
    ['27 Oct 19', 'OFF', '', '', '00:00 Z', '', '', '23:59 Z', '', ''],
  ]);
});

test('duty sectors list: Duty Start / Duty End as C/I / C/O (local, "+1"), legs AAA-BBB with local times, a code with its times, day codes', async () => {
  const r = await parseCsv([['Generated 20/05/20 10:26 - X'], ['Duty Start', 'Flt/GD', 'SD', 'Sector', 'A/C', 'Dep', 'Arr', 'Duty End', 'GMT'],
    ['01/06/2020', 'DO'],
    ['05/06/2020 1100L', 'Z1204', 'CH', '', '', '', '', '05/06/2020 1630L'],
    ['06/06/2020 1800L', 'LD680', '', 'AAA-BBB', 'ABY', '1900L', '2050L'],
    ['', 'LD681', '', 'BBB-AAA', 'ABY', '2215L', '0005L', '07/06/2020 0020L'],
  ]);
  assert.equal(r.format, 'table-duty-sectors');
  assert.deepEqual(r.published.map(x => [x.date, x.duty, x.dep, x.begin, x.end, x.arr, x.ac, x.info]), [
    ['1 Jun 20', 'DO', '', '', '', '', '', ''],
    ['5 Jun 20', 'Z1204', '', '11:00 L', '16:30 L', '', '', '[SD: CH]'],
    ['6 Jun 20', 'C/I', 'AAA', '18:00 L', '', '', '', ''],
    ['6 Jun 20', 'LD680', 'AAA', '19:00 L', '20:50 L', 'BBB', 'ABY', ''],
    ['6 Jun 20', 'LD681', 'BBB', '22:15 L', '00:05 L +1', 'AAA', 'ABY', ''],
    ['6 Jun 20', 'C/O', '', '', '00:20 L +1', 'AAA', '', ''],
  ]);
});

test('logbook exports: Aircraft ID / Out / In with PIC and SIC; Start UTC / End UTC with "11h16"; FAR logbook with decimal hours and Paired With', async () => {
  const a = await parseCsv([['Date', 'Aircraft ID', 'Aircraft Type', 'Out', 'In', 'PIC/P1 Crew', 'SIC/P2 Crew', 'Total Time', 'Remarks', 'Flight #', 'From', 'To', 'Total Pax'],
    ['5/22/2026', 'N132AN', 'A321', '23:42', '07:30', 'Crews, Stephen', 'Reece, Timothy', '4.80', '', '3318', 'LAS', 'MIA', '188']]);
  assert.equal(a.format, 'table-aircraft-id-logbook');
  assert.deepEqual(a.published.map(x => [x.date, x.duty, x.registration, x.dep, x.begin, x.end, x.arr, x.ac, x.crew, x.info]), [
    ['22 May 26', '3318', 'N132AN', 'LAS', '23:42 Z', '07:30 Z +1', 'MIA', 'A321', '[PIC - Crews, Stephen][SIC - Reece, Timothy]', '[Total Time: 4.80] [Pax: 188]'],
  ]);
  const u = await parseCsv([['Start UTC', 'From', 'End UTC', 'To', 'Flight time', 'SIMU ins', 'SIMU trg', 'Type', 'Function', 'Aircraft'],
    ['16/08/2024 14:39', 'LFPO', '17/08/2024 01:54', 'FMEE', '11h15', '', '', 'Flight', 'CC', 'FHMIX A35K']]);
  assert.equal(u.format, 'table-utc-legs');
  assert.deepEqual(u.published.map(x => [x.date, x.registration, x.dep, x.begin, x.end, x.arr, x.ac, x.info]), [
    ['16 Aug 24', 'FHMIX', 'LFPO', '14:39 Z', '01:54 Z +1', 'FMEE', 'A35K', '[Flight: 11:15] [Function: CC]'],
  ]);
  const f = await parseCsv([['Name', 'Date', 'Typename', 'Tail', 'From', 'To', 'Blk Hrs', 'FAR 91', 'FAR 91k', 'FAR 135', 'PIC', 'SIC', 'NFC', 'Day T/O', 'Day Ldg', 'Night T/O', 'Night Ldg', 'Night Hrs', 'IFR Hrs', 'IFR Appr', 'Paired With'],
    ['Ann Doe', '2022-11-14 17:48:00.0 Z', 'CE-560XLS', 'CSDXV', 'LEIB', 'LPPT', '1.7', '0', '0', '0', '0', '1.7', '0', '0', '0', '1', '1', '1.6', '1.6', '1', 'Roe, Bob PIC']]);
  assert.equal(f.format, 'table-far-logbook');
  assert.deepEqual(f.published.map(x => [x.date, x.registration, x.dep, x.begin, x.arr, x.ac, x.crew, x.info]), [
    ['14 Nov 22', 'CSDXV', 'LEIB', '17:48 Z', 'LPPT', 'CE-560XLS', '[PIC - Roe, Bob]', '[Block: 1.7] [SIC: 1.7] [Takeoff Night: 1] [Landing Night: 1] [Night: 1.6] [IFR: 1.6]'],
  ]);
});

test('"Planning from ... till ...": C/I at a duty\'s first leg, flights with crew / aircraft / pax, C/O from Duty end, positioning VS, hotel; Saudia duty lines with Z / L times', async () => {
  const p = await parseCsv([['Planning from 01/05/2025 till 31/05/2025'], ['', 'Check-in', 'Start', 'City', 'End', 'Debrief end', 'Duty end', 'City', 'Duty', 'Rest', 'Description', 'Extensions', 'Notes', 'Pax'],
    ['Thu', '01/05/2025 12:15', '01/05/2025 13:13', 'AAA', '01/05/2025 15:37', '', '', 'BBB', 'AEA1173', '', 'TEC : PM:JULIO CO:ROE', '', 'Aircraft : ECNAB Aircraft type : B738-738', '182'],
    ['Thu', '01/05/2025 15:55', '01/05/2025 16:49', 'BBB', '01/05/2025 19:11', '', '19:41', 'AAA', 'AEA1174', '', 'TEC : PM:JULIO CO:ROE', '', 'Aircraft : ECNAB Aircraft type : B738-738', '182'],
    ['Sun', '04/05/2025 08:00', '04/05/2025 09:00', 'AAA', '04/05/2025 11:25', '', '11:25', 'CCC', 'VS', '', '', '', 'FR 2629 PWS13C Transport:Aircraft'],
    ['Sun', '04/05/2025 15:30', '04/05/2025 15:30', 'CCC', '05/05/2025 09:59', '', '', 'CCC', 'HOTEL', '', 'HOTEL', '', 'HOTEL'],
  ]);
  assert.equal(p.format, 'table-planning-checkin');
  assert.deepEqual(p.published.map(x => [x.date, x.dc, x.duty, x.registration, x.dep, x.begin, x.end, x.arr, x.ac, x.crew, x.info]), [
    ['1 May 25', '', 'C/I', '', 'AAA', '12:15 Z', '', '', '', '', ''],
    ['1 May 25', '', 'AEA1173', 'ECNAB', 'AAA', '13:13 Z', '15:37 Z', 'BBB', 'B738', '[PM - JULIO][CO - ROE]', '[Pax: 182]'],
    ['1 May 25', '', 'AEA1174', 'ECNAB', 'BBB', '16:49 Z', '19:11 Z', 'AAA', 'B738', '[PM - JULIO][CO - ROE]', '[Pax: 182]'],
    ['1 May 25', '', 'C/O', '', '', '', '19:41 Z', 'AAA', '', '', ''],
    ['4 May 25', '', 'C/I', '', 'AAA', '08:00 Z', '', '', '', '', ''],
    ['4 May 25', 'DH', 'VS', '', 'AAA', '09:00 Z', '11:25 Z', 'CCC', '', '', 'FR 2629 PWS13C Transport:Aircraft'],
    ['4 May 25', '', 'C/O', '', '', '', '11:25 Z', 'CCC', '', '', ''],
    ['4 May 25', '', 'HT', '', 'CCC', '15:30 Z', '09:59 Z +1', '', '', '', ''],
  ]);
  const s = await parseCsv([['STAFF_NUM', 'DUTY_STR_DATE', 'DUTY_CD', 'PRNG_NUM', 'FLT_NUM', 'DEPARURE_PORT', 'ARRIVAL_PORT', 'FLEET_CD', 'TAIL_NUM', 'ACTUAL_START_DATE_GMT', 'ACTUAL_START_TIME_GMT',
    'ACTUAL_END_DATE_GMT', 'ACTUAL_END_TIME_GMT', 'ACTUAL_START_DATE_LOCAL', 'ACTUAL_START_TIME_LOCAL', 'ACTUAL_END_DATE_LOCAL', 'ACTUAL_END_TIME_LOCAL'],
    ['1', '17-AUG-17', 'RST', '8770244', 'RST', 'JED', 'JED', '-', '', '17-AUG-17', '13:30', '18-AUG-17', '01:30', '17-AUG-17', '16:30', '18-AUG-17', '04:30'],
    ['1', '18-AUG-17', 'FLY', '8770244', '1234', 'JED', 'RUH', '321', 'HZ-ASA', '18-AUG-17', '05:00', '18-AUG-17', '06:30', '18-AUG-17', '08:00', '18-AUG-17', '09:30']]);
  assert.equal(s.format, 'table-saudia-duties');
  assert.deepEqual(s.published.map(x => [x.date, x.duty, x.dep, x.begin, x.end, x.arr, x.ac, x.registration, x.info]), [
    ['17 Aug 17', 'RST', 'JED', '13:30 Z / 16:30 L', '01:30 Z +1 / 04:30 L +1', '', '', '', '[Pairing: 8770244]'],
    ['18 Aug 17', '1234', 'JED', '05:00 Z / 08:00 L', '06:30 Z / 09:30 L', 'RUH', '321', 'HZ-ASA', '[Pairing: 8770244]'],
  ]);
});

test('German logbooks (Flugbuch / Vereinsflieger) and a flight-school brakes log: airfield codes, block and flight time, crew, take-off / landing', async () => {
  const fb = await parseCsv([
    ['Datum', 'LFZ Typ', 'Kennzeichen', 'von', 'nach', 'Start', 'Landung', 'BlockOff', 'BlockOn', 'Landungen', 'Flugstunden', 'Blockzeit', 'Preiskategorie', 'Schüler', 'Bemerkung'],
    ['01.09.22', 'C172M', 'D-EXXX', 'EDHE', 'EDHE', '07:57', '08:37', '07:50', '08:40', '1', '00:40', '00:50', '', 'Doe, John', ''],
  ]);
  assert.equal(fb.format, 'table-german-logbook');
  assert.deepEqual(fb.published.map(x => [x.date, x.registration, x.ac, x.dep, x.begin, x.takeoff, x.landing, x.end, x.arr, x.crew, x.info]), [
    ['1 Sep 22', 'D-EXXX', 'C172M', 'EDHE', '07:50 Z', '07:57 Z', '08:37 Z', '08:40 Z', 'EDHE', '[Student - Doe, John]', '[Block: 00:50] [Flight: 00:40] [Landing Day/Night: 1]'],
  ]);
  const vf = await parseCsv([
    ['Datum', 'Lfz.', 'Startort', 'Landeort', 'Off-Block', 'On-Block', 'Blockzeit in hh:mm', 'Landungen', 'Pilot', 'Begleiter/FI', 'Flugzeit', 'Lfz.-Muster'],
    ['27/09/2025', 'D-6506', 'Goch-Asperden EDLG', 'Goch-Asperden EDLG', '10:50', '11:14', '00:24', '1', 'Doe, Tim', 'Roe, Alex', '24', 'SZD-54-2'],
  ]);
  assert.deepEqual(vf.published.map(x => [vf.format, x.date, x.registration, x.ac, x.dep, x.begin, x.end, x.arr, x.crew, x.info]), [
    ['table-german-logbook', '27 Sep 25', 'D-6506', 'SZD-54-2', 'EDLG', '10:50 Z', '11:14 Z', 'EDLG', '[Pilot - Doe, Tim][FI - Roe, Alex]', '[Block: 00:24] [Flight: 00:24] [Landing Day/Night: 1]'],
  ]);
  const br = await parseCsv([
    ['Date', 'Aircraft', 'Flight Log', 'From', 'To', 'Brakes Off', 'Take Off', 'Landing', 'Brakes On', 'PIC', 'Student', 'Defects'],
    ['27/01/2024', 'G-BSCZ', '221849', 'eglk', 'eglk', '12:40:40', '12:48:00', '13:13:00', '13:16:10', 'John Doe', 'Sam Roe', 'NIL'],
  ]);
  assert.deepEqual(br.published.map(x => [br.format, x.date, x.registration, x.dep, x.begin, x.takeoff, x.landing, x.end, x.arr, x.crew, x.info]), [
    ['table-brakes-logbook', '27 Jan 24', 'G-BSCZ', 'EGLK', '12:40 Z', '12:48 Z', '13:13 Z', '13:16 Z', 'EGLK', '[PIC - John Doe][Student - Sam Roe]', ''],
  ]);
});

test('pilot exports: legs as pilot flying, UTC legs with the crew, a flight-school log, a logbook with stamps, Southwest flights below gauge values', async () => {
  const pf = await parseCsv([
    ['EmployeeID', 'Crew Name', 'Flight Date', 'Flight Number', 'Takeoff (as PF)', 'TO Location', 'Out Time', 'TO Daytime/Nightime', 'Landing (as PF)', 'Ldg Location', 'In Time',
      'Ldg Daytime/Nightime', 'Flight Hours (Block)', 'Rank', 'Airline', 'Tail Number', 'Airline Registration', 'Aircraft Type', 'Paired Crew Member'],
    ['1', 'DOE, JOHN', '21-Sep-25', '2931', 'True', 'MUVR', '00:03', 'False', 'True', 'CYUL', '03:46', 'True', '03:43', 'Captain - PIC', 'WS', '379', 'C-GFVE', 'B737 MAX-8', ''],
  ]);
  assert.deepEqual(pf.published.map(x => [pf.format, x.date, x.duty, x.registration, x.ac, x.dep, x.begin, x.end, x.arr, x.info]), [
    ['table-pf-legs', '21 Sep 25', 'WS2931', 'C-GFVE', 'B737 MAX-8', 'MUVR', '00:03 Z', '03:46 Z', 'CYUL', '[Block: 03:43] [Takeoff Day: 1] [Landing Night: 1] [Rank: Captain - PIC]'],
  ]);
  const legs = await parseCsv([
    ['departUTC', 'arriveUTC', 'fltNum', 'origin', 'destination', 'acRegistration', 'acType', 'crew', 'hours'],
    ['2024-08-25T22:13', '2024-08-26T03:01', '2387', 'CYHM', 'CYVR', 'C-GAZF', '767-300', 'CA: John Doe / FO: Jim Roe', '4.8'],
  ]);
  assert.deepEqual(legs.published.map(x => [legs.format, x.date, x.duty, x.dep, x.begin, x.end, x.arr, x.crew, x.info]), [
    ['table-utc-crew-legs', '25 Aug 24', '2387', 'CYHM', '22:13 Z', '03:01 Z +1', 'CYVR', '[CA - John Doe][FO - Jim Roe]', '[Block: 4.8]'],
  ]);
  const school = await parseCsv([
    ['id', 'date', 'reg', 'type', 'flight_type', 'pic', 'customer', 'instructor', 'from', 'to', 'off_blocks_utc', 'takeoff_utc', 'landing_utc', 'on_blocks_utc', 'total_block', 'total_airborne', 'takeoffs_landings'],
    ['1', '27/05/2026', 'G-CMKJ', 'PA28-161', 'PPL', 'J Doe', 'A Roe', 'J Doe', 'EGLK', 'EGLK', '16:06', '16:18', '16:57', '17:00', '0:54', '0:39', '1'],
  ]);
  assert.deepEqual(school.published.map(x => [school.format, x.date, x.registration, x.ac, x.begin, x.takeoff, x.landing, x.end, x.crew, x.info]), [
    ['table-school-flights', '27 May 26', 'G-CMKJ', 'PA28-161', '16:06 Z', '16:18 Z', '16:57 Z', '17:00 Z', '[PIC - J Doe][Customer - A Roe][Instructor - J Doe]',
      '[Block: 00:54] [Flight: 00:39] [Landing Day/Night: 1] [Flight type: PPL]'],
  ]);
  const stamps = await parseCsv([
    ['date_of_flight', 'call_sign', 'departure_airport', 'off_block', 'take_off', 'destination_airport', 'landing', 'on_block', 'aircraft_model', 'aircraft_registration', 'airtime', 'block_time',
      'capt_on_flight', 'role_on_flight'],
    ['22/05/2015', 'LS185', 'EGNM', '22/05/2015 06:22', '22/05/2015 06:31', 'LEMG', '22/05/2015 09:07', '22/05/2015 09:10', '737-800', 'GGDFP', '2:36', '2:48', 'Paul DOE', 'FO'],
  ]);
  assert.deepEqual(stamps.published.map(x => [stamps.format, x.date, x.duty, x.dep, x.begin, x.takeoff, x.landing, x.end, x.arr, x.crew, x.info]), [
    ['table-stamp-logbook', '22 May 15', 'LS185', 'EGNM', '06:22 Z', '06:31 Z', '09:07 Z', '09:10 Z', 'LEMG', '[CP - Paul DOE]', '[Block: 02:48] [Flight: 02:36] [Role: FO]'],
  ]);
  const wn = await parseCsv([
    ['TotalBlockhrsmins'], ['80:05'], [],
    ['DATE', 'Flight', 'dhd', 'From', 'Depart', 'To', 'Arrive', 'Block', 'Tail_Number', 'A_C_Type', 'CoPilot'],
    ['2022-02-05', 'WN5695', 'DH', 'MCO', '1411', 'DAL', '1658', '0', 'N903WN', '737-73W', 'Deadheading'],
    ['2022-03-15', 'WN2120', '', 'MCO', '2250', 'BWI', '103', '213', 'N8600F', '737-73H', 'FO DOE JOHN *INTL* [124921]'],
  ]);
  assert.deepEqual(wn.published.map(x => [wn.format, x.date, x.dc, x.duty, x.dep, x.begin, x.end, x.arr, x.crew, x.info]), [
    ['table-dhd-flights', '5 Feb 22', 'DH', 'WN5695', 'MCO', '14:11 L', '16:58 L', 'DAL', '', ''],
    ['table-dhd-flights', '15 Mar 22', '', 'WN2120', 'MCO', '22:50 L', '01:03 L +1', 'BWI', '[FO - 124921 - DOE JOHN]', '[Block: 02:13]'],
  ]);
});

test('SAS activity lines: checkin -> C/I at the next flight\'s station, flights with duty and meal codes, NightStop -> hotel, checkout -> C/O', async () => {
  const r = await parseCsv([
    ['Day', 'Date', 'Duty', 'Meal', 'Activity', 'C/I', 'From', 'STD', 'STA', 'To', 'C/O', 'Stop time'],
    ['Sun', '03AUG2025', '', '', 'checkin', '', '', '15:45', '15:45', '', '', '00:00'],
    ['Sun', '03AUG2025', 'IL', 'V', 'SK2697', '', 'CPH', '17:00', '19:05', 'VCE', '', '00:50'],
    ['Sun', '03AUG2025', 'IL', '', 'SK2698', '', 'VCE', '22:55', '00:59', 'CPH', '', '15:41'],
    ['Mon', '04AUG2025', '', '', 'checkout', '', '', '01:20', '01:20', '', '', '00:00'],
    ['Mon', '04AUG2025', '', '', 'NightStop', '', '', '01:30', '15:05', '', '', '00:00'],
  ]);
  assert.equal(r.format, 'table-activity-lines');
  assert.deepEqual(r.published.map(x => [x.date, x.duty, x.dep, x.begin, x.end, x.arr, x.info]), [
    ['3 Aug 25', 'C/I', 'CPH', '15:45 L', '', '', ''],
    ['3 Aug 25', 'SK2697', 'CPH', '17:00 L', '19:05 L', 'VCE', '[Duty: IL] [Meal: V]'],
    ['3 Aug 25', 'SK2698', 'VCE', '22:55 L', '00:59 L +1', 'CPH', '[Duty: IL]'],
    ['4 Aug 25', 'C/O', '', '', '01:20 L', 'CPH', ''],
    ['4 Aug 25', 'HT', 'CPH', '01:30 L', '15:05 L', '', ''],
  ]);
});
