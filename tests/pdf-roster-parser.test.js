import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readPdfText } from '../src/services/pdf-text.js';
import { parseNetlinePdf, formatTime } from '../src/services/pdf-roster-parser.js';

// Synthetic page with the NetLine/Crew coordinates (block 1 only); the real
// sample PDFs are personal data and stay out of git.
const it = (text, x, y) => ({ text, x, y, w: text.length * 4, h: 5 });
const HEADER = [it('date', 28, 88), it('H', 53, 88), it('duty', 82, 88), it('R dep', 123, 88), it('arr', 196, 88), it('AC', 216, 88), it('info', 243, 88)];

function page(items) {
  return [{ page: 1, width: 842, height: 595, items: [it('Period:', 28, 36), it('01Mar25 -', 94, 36), it('31Mar25', 160, 36), ...HEADER, ...items] }];
}

test('day line, flight legs with registration line, C/O with statistics in the info column', () => {
  const { published: rows, period } = parseNetlinePdf(page([
    it('Sat01', 28, 118), it('STBY', 70, 118), it('HAM', 132, 118), it('0315', 154, 118), it('1515', 174, 118),
    it('[DT', 243, 118), it('00:00]', 268, 118), it('[FDT', 243, 124), it('00:00]', 268, 124),
    it('Sun02', 28, 177), it('C/I', 60, 177), it('HAM', 132, 177), it('0455', 154, 177),
    it('EW', 70, 181), it('7526', 85, 181), it('HAM', 132, 181), it('0605', 154, 181), it('1100', 174, 181), it('FUE', 196, 181), it('320', 215, 181),
    it('A321', 130, 189),
    it('C/O', 60, 219), it('1725', 174, 219), it('HAM', 196, 219), it('[DT', 243, 219), it('12:30]', 268, 219),
  ]));
  assert.equal(period, '01Mar25 - 31Mar25');
  assert.deepEqual(rows.map(r => [r.date, r.day, r.duty, r.registration, r.dep, r.begin, r.end, r.arr, r.ac]), [
    ['1 Mar 25', 'Sat', 'STBY', '', 'HAM', '03:15 Z', '15:15 Z', '', ''],
    ['2 Mar 25', 'Sun', 'C/I', '', 'HAM', '04:55 Z', '', '', ''],
    ['2 Mar 25', 'Sun', 'EW 7526', 'A321', 'HAM', '06:05 Z', '11:00 Z', 'FUE', '320'],
    ['2 Mar 25', 'Sun', 'C/O', '', '', '', '17:25 Z', 'HAM', ''],
  ]);
  assert.equal(rows[0].info, '[DT 00:00] [FDT 00:00]');
  assert.equal(rows[3].info, '[DT 12:30]');
});

test('a "count/time" statistic like [RT 11/0614] is kept with the others', () => {
  const { published: rows } = parseNetlinePdf(page([
    it('Sat01', 28, 118), it('C/O', 60, 118), it('1725', 174, 118), it('HAM', 196, 118),
    it('[DT', 243, 118), it('12:30]', 268, 118), it('[RT', 243, 124), it('11/0614]', 268, 124), it('[BRK', 243, 130), it('014:29]', 268, 130),
  ]));
  assert.equal(rows[0].info, '[DT 12:30] [RT 11/0614] [BRK 014:29]');
});

test('statistics on their own lines, a crew message after them, R flag on the item line, later sections ignored', () => {
  const { published: rows } = parseNetlinePdf(page([
    it('Tue18', 28, 118), it('C/O', 60, 118), it('2110', 174, 118), it('VIE', 196, 118),
    it('[FT', 51, 123), it('03:10][DT', 76, 123), it('05:35]', 123, 123),
    it('(ABLZ', 51, 130), it('3:02)', 73, 130), it('To', 90, 130), it('c/m: note', 105, 130),
    it('Wed19', 28, 150), it('DBF', 70, 150), it('R', 124, 150), it('VIE', 132, 150),
    it('Thu20', 28, 170), it('[ABLZ', 51, 176), it('0:00]', 73, 176), // a day without any item
    it('Crew Information on', 38, 200), it('Fri21', 37, 210), it('OS', 69, 210), it('171', 83, 210),
  ]));
  assert.deepEqual(rows.map(r => [r.date, r.duty, r.registration, r.dep, r.info]), [
    ['18 Mar 25', 'C/O', '', '', '[FT 03:10] [DT 05:35] (ABLZ 3:02) To c/m: note'],
    ['19 Mar 25', 'DBF', 'R', 'VIE', ''],
  ]);
});

test('a hotel code in the H column is a row of its own, with name and phone from the Hotels table', () => {
  const pages = page([
    it('Thu02', 28, 137), it('AV', 70, 137), it('383', 85, 137), it('SAL', 132, 137), it('1445', 154, 137), it('1735', 174, 137), it('BOG', 196, 137),
    it('[DTR', 243, 137), it('00:00]', 268, 137),
    it('H1*', 51, 148), it('BOG', 132, 148), // layover line
    it('[ABLZ', 51, 154), it('5:09]', 73, 154), // statistics under the hotel line still belong to the leg
  ]);
  // Hotels table in block 3 (title, then code | name | phone, name wrapping).
  pages[0].items.push(
    it('Hotels', 572, 300), it('H1', 572, 318), it('Sheraton Bogota Hotel,', 594, 318), it('011-57-1-210-5000', 737, 318),
    it('Bogota', 594, 324),
  );
  const { published: rows } = parseNetlinePdf(pages);
  assert.deepEqual(rows.map(r => [r.date, r.day, r.hotel, r.duty, r.dep, r.info]), [
    ['2 Mar 25', 'Thu', '', 'AV 383', 'SAL', '[DTR 00:00] [ABLZ 5:09]'],
    ['2 Mar 25', 'Thu', 'H1*', '', 'BOG', 'Sheraton Bogota Hotel, Bogota, Tel 011-57-1-210-5000'],
  ]);
});

test('a code alone under an event is a row only if the legend has it; a day with only a crew message gets a row', () => {
  const pages = page([
    it('Mon18', 28, 118), it('C/I', 60, 118), it('CGN', 132, 118), it('0800', 154, 118),
    it('KOMBI', 64, 124), // not in the legend: skipped
    it('FDP_EXT', 64, 130), // in the legend: a row
    it('EBT1-S', 64, 136), it('25', 64, 142), // not in the legend, nor its "25"
    it('GAF', 70, 148), it('3740A', 85, 148), it('CGN', 132, 148), it('1000', 154, 148), it('1150', 174, 148), it('RZE', 196, 148),
    it('Tue19', 28, 180), it('URLAUB', 70, 180), it('CGN', 132, 180),
    it('URLAUB', 64, 186), // the same code again under it: skipped
    it('Wed20', 28, 210), it('From c/m:', 243, 210), it('Req. OFF', 243, 216),
  ]);
  pages[0].items.push(
    it('Absence/Ground Activity Legend', 572, 300), it('code', 568, 312), it('description', 636, 312),
    it('FDP_EXT', 568, 324), it('FDZ-Verlaengerung', 636, 324),
    it('URLAUB', 568, 330), it('Erholungsurlaub', 636, 330),
  );
  const { published: rows } = parseNetlinePdf(pages);
  assert.deepEqual(rows.map(r => [r.date, r.duty, r.dep, r.info]), [
    ['18 Mar 25', 'C/I', 'CGN', ''],
    ['18 Mar 25', 'FDP_EXT', '', '[FDP_EXT: FDZ-Verlaengerung]'],
    ['18 Mar 25', 'GAF 3740A', 'CGN', ''],
    ['19 Mar 25', 'URLAUB', 'CGN', '[URLAUB: Erholungsurlaub]'],
    ['20 Mar 25', '', '', 'From c/m: Req. OFF'],
  ]);
});

test('"H?" (hotel not known yet) in the H column is a hotel row too', () => {
  const { published: rows } = parseNetlinePdf(page([
    it('Mon19', 28, 118), it('DH/OU', 60, 118), it('450', 85, 118), it('ZAG', 132, 118), it('0620', 154, 118), it('0830', 174, 118), it('AMS', 196, 118),
    it('H?', 53, 130), it('AMS', 132, 130),
  ]));
  assert.deepEqual(rows.map(r => [r.hotel, r.duty, r.dep, r.info]), [['', 'DH/OU 450', 'ZAG', ''], ['H?', '', 'AMS', '']]);
});

test('codes from the Absence/Ground Activity Legend get their description, after statistics and hotel', () => {
  const pages = page([
    it('Sat01', 28, 118), it('STBY', 70, 118), it('HAM', 132, 118), it('0315', 154, 118), it('1515', 174, 118), it('[DT', 243, 118), it('00:00]', 268, 118),
    it('Sun02', 28, 150), it('CBT-R-S', 70, 150), it('25', 70, 158), // code continued on the next line
    it('Mon03', 28, 180), it('REF', 70, 180), it('HAM', 132, 180), // in the legend without a description
  ]);
  pages[0].items.push(
    it('Absence/Ground Activity Legend', 572, 300), it('code', 568, 312), it('description', 636, 312),
    it('STBY', 568, 324), it('Standby', 636, 324),
    it('CBT-R-S25', 568, 330), it('CBT REF', 636, 330), it('S25', 665, 330),
    it('REF', 568, 336),
    it('Additional Summary', 576, 356), it('Off', 588, 370), it('days', 603, 370),
  );
  const { published: rows } = parseNetlinePdf(pages);
  assert.deepEqual(rows.map(r => [r.duty, r.info]), [
    ['STBY', '[DT 00:00] [STBY: Standby]'],
    ['CBT-R-S 25', '[CBT-R-S 25: CBT REF S25]'],
    ['REF', ''],
  ]);
});

test('text under an event in the R column ("Instructor, LC") is info, an aircraft code is registration', () => {
  const { published: rows } = parseNetlinePdf(page([
    it('Tue18', 28, 118), it('OS', 70, 118), it('171', 85, 118), it('R', 124, 118), it('VIE', 132, 118), it('1645', 154, 118), it('1820', 174, 118), it('HAM', 196, 118), it('320', 215, 118),
    it('Instructor, LC', 130, 131),
    it('EW', 70, 140), it('7526', 85, 140), it('HAM', 132, 140), it('0605', 154, 140), it('1100', 174, 140), it('FUE', 196, 140), it('320', 215, 140),
    it('A321', 130, 148),
  ]));
  assert.deepEqual(rows.map(r => [r.duty, r.registration, r.info]), [
    ['OS 171', 'R', 'Instructor, LC'],
    ['EW 7526', 'A321', ''],
  ]);
});

test('a note on the Period line right of the dates is returned as a notice', () => {
  const pages = page([it('Sat01', 28, 118), it('OFF', 70, 118), it('HAM', 132, 118)]);
  pages[0].items.push(it('Local times at event airport. (!)', 434, 36), it('if not in', 637, 36), it('homebase timezone', 697, 36),
    it('contract:', 287, 39)); // a different line
  assert.deepEqual(parseNetlinePdf(pages).notices, ['Local times at event airport. (!) if not in homebase timezone']);
  assert.deepEqual(parseNetlinePdf(page([])).notices, []);
});

test('days after "The following is only for information" go to planned; "!" times are kept', () => {
  const { published, planned } = parseNetlinePdf(page([
    it('Fri22', 28, 118), it('C/I', 60, 118), it('VNO', 132, 118), it('!1300', 152, 118),
    it('The', 28, 140), it('following is', 48, 140), it('only for information because the', 110, 140),
    it('published period ends', 28, 147), // the note wraps
    it('Sat23', 28, 170), it('OFF', 70, 170), it('CGN', 132, 170),
  ]));
  assert.deepEqual(published.map(r => [r.date, r.duty, r.dep, r.begin]), [['22 Mar 25', 'C/I', 'VNO', '13:00 L']]);
  assert.deepEqual(planned.map(r => [r.date, r.duty, r.dep, r.info]), [['23 Mar 25', 'OFF', 'CGN', '']]);
});

test('other text in the info column on an event line goes to its info; a crew message under it too', () => {
  const { published } = parseNetlinePdf(page([
    it('Sat01', 28, 118), it('OS', 70, 118), it('103', 85, 118), it('R', 124, 118), it('VIE', 132, 118), it('1255', 154, 118), it('1355', 174, 118), it('MUC', 196, 118), it('E95', 215, 118),
    it('72049', 243, 118), it('ALTC', 265, 118),
    it('To', 209, 126), it('c/m: welcome day', 220, 126), // crew message on its own line (as printed in I71 (1))
  ]));
  assert.deepEqual(published.map(r => [r.duty, r.info]), [['OS 103', '72049 ALTC To c/m: welcome day']]);
});

test('info text wrapping onto the next line joins the event, then the crew message after it', () => {
  const { published } = parseNetlinePdf(page([
    it('Wed28', 28, 118), it('OU', 70, 118), it('368', 85, 118), it('ZAG', 132, 118), it('1200', 154, 118), it('1315', 174, 118), it('SKP', 196, 118), it('A32X', 213, 118),
    it('KURJAKOV', 243, 118),
    it('OBS', 243, 124), // wrapped info text
    it('From c/m:', 209, 132), it('Z-3', 244, 132), // crew message running across columns
  ]));
  assert.deepEqual(published.map(r => [r.duty, r.info]), [['OU 368', 'KURJAKOV OBS From c/m: Z-3']]);
});

test('crew messages: after statistics on the same item, wrapped over lines, attached to the event before', () => {
  const { published } = parseNetlinePdf(page([
    it('Tue18', 28, 118), it('C/O', 60, 118), it('2110', 174, 118), it('VIE', 196, 118),
    it('[FT', 51, 123), it('03:10]', 76, 123),
    it('(ABLZ', 51, 130), it('2:37) To', 73, 130), it('c/m: Der', 105, 130), it('Zeitraum der', 137, 130), // message starts inside an item
    it('Reservetag (RES) ist', 51, 136), it('17:00-20:00 Wiener', 126, 136), it('Lokalzeit.', 195, 136), // wrapped line
    it('Wed19', 28, 160), it('DBF', 70, 160), it('R', 124, 160), it('VIE', 132, 160), // next day ends the message
  ]));
  assert.deepEqual(published.map(r => [r.duty, r.info]), [
    ['C/O', '[FT 03:10] (ABLZ 2:37) To c/m: Der Zeitraum der Reservetag (RES) ist 17:00-20:00 Wiener Lokalzeit.'],
    ['DBF', ''],
  ]);
});

test('a text block under a flight is info line by line; "0900 !1145" in one item is begin and end', () => {
  const { published } = parseNetlinePdf(page([
    it('Mon18', 28, 118), it('GAF', 60, 118), it('3740A', 75, 118), it('CGN', 132, 118), it('0900 !1145', 154, 118), it('RZE', 196, 118), it('21N', 215, 118),
    it('EATC Rzeszow', 128, 126), it('**', 128, 132), it('BGR CAE', 128, 138), it('**', 128, 144),
    it('JIL LT', 128, 150), it('gem. LP372a Flug 2', 150, 150), // runs into the begin column
    it('EW', 70, 160), it('7526', 85, 160), it('HAM', 132, 160), it('0605', 154, 160), it('1100', 174, 160), it('FUE', 196, 160), it('320', 215, 160),
    it('A321', 130, 166), // an aircraft code stays the registration
  ]));
  assert.deepEqual(published.map(r => [r.duty, r.begin, r.end, r.registration, r.info]), [
    ['GAF 3740A', '09:00 Z', '11:45 L', '', 'EATC Rzeszow ** BGR CAE ** JIL LT gem. LP372a Flug 2'],
    ['EW 7526', '06:05 Z', '11:00 Z', 'A321', ''],
  ]);
});

test('a text line under an event with a 3-letter word in it ("INST" / "LTA") is still info', () => {
  const { published } = parseNetlinePdf(page([
    it('Wed04', 28, 118), it('NG#8', 70, 118), it('OSL', 132, 118), it('1300', 154, 118), it('1400', 174, 118), it('S738', 215, 118),
    it('RECENCY TRAINING, INST', 128, 126), it('LTA', 190, 126),
    it('TRAINING', 128, 132),
    it('DEM', 128, 138), it('CAE', 145, 138), // two 3-letter words in one column: text
    it('Thu05', 28, 150), it('DO', 70, 150), it('CPH', 132, 150),
    it('BOG', 132, 156), // an airport alone under a day is no text
  ]));
  assert.deepEqual(published.map(r => [r.duty, r.info]), [['NG#8', 'RECENCY TRAINING, INST LTA TRAINING DEM CAE'], ['DO', '']]);
});

test('a code on the day line above the event is skipped; a lone word in a text block and "(...)" in a message are text', () => {
  const { published } = parseNetlinePdf(page([
    it('Mon03', 28, 118), it('INFO_FELD', 60, 118),
    it('FVD9', 70, 124), it('CGN', 132, 124), it('0700', 154, 124), it('1630', 174, 124),
    it('Tue04', 28, 150), it('GAF', 70, 150), it('3701A', 85, 150), it('CGN', 132, 150), it('0745', 154, 150), it('0900', 174, 150), it('BER', 196, 150),
    it('COS LT', 128, 158), it('BRA', 128, 166), it('SJA LT', 128, 174), // "BRA" alone inside the text block
    it('Wed05', 28, 200), it('OFFBLUE', 70, 200), it('CGN', 132, 200), it('From c/m:', 243, 206), it('Req. Off Blue', 243, 214), it('(Konzert-Tickets)', 243, 222),
  ]));
  assert.deepEqual(published.map(r => [r.date, r.duty, r.info]), [
    ['3 Mar 25', 'FVD9', ''],
    ['4 Mar 25', 'GAF 3701A', 'COS LT BRA SJA LT'],
    ['5 Mar 25', 'OFFBLUE', 'From c/m: Req. Off Blue (Konzert-Tickets)'],
  ]);
});

test('"2220 !0054+1 OSL" in one item: begin, end on the next day, arr', () => {
  const { published } = parseNetlinePdf(page([
    it('Mon28', 28, 118), it('DY', 70, 118), it('1885', 85, 118), it('ATH', 132, 118), it('2220 !0054+1 OSL', 154, 118), it('S738', 215, 118),
  ]));
  assert.deepEqual(published.map(r => [r.duty, r.dep, r.begin, r.end, r.arr, r.ac]), [['DY 1885', 'ATH', '22:20 Z', '00:54 L +1', 'OSL', 'S738']]);
});

// Single-column RYR plan (portrait): "date stops duty req dep arr AC rank info", days "01. Wed".
function ryrPage(items, period = ['11Sep19 -', '31Dec20']) {
  const header = ['date', 'stops', 'duty', 'req', 'dep', 'arr', 'AC', 'rank', 'info']
    .map((t, k) => it(t, [83, 119, 179, 232, 252, 332, 364, 392, 421][k], 116));
  return [{ page: 1, width: 595, height: 842, items: [it('Period:', 70, 58), it(period[0], 121, 58), it(period[1], 178, 58), ...header, ...items] }];
}

test('RYR layout: "01. Wed" days, flights, deadhead, hotel line; the start month comes from the weekdays', () => {
  const pages = ryrPage([
    it('01. Wed', 74, 126), it('FR', 164, 126), it('8922', 182, 126), it('PMO', 252, 126), it('0943', 276, 126), it('1120', 306, 126), it('TSF', 333, 126), it('B738', 360, 126),
    it('[FT', 421, 126), it('03:07]', 453, 126),
    it('02. Thu', 74, 166), it('(-)', 151, 166),
    it('OFF(Z)', 164, 174), it('PMO', 252, 174), it('0000', 276, 174), it('2100', 306, 174),
    it('03. Fri', 74, 184), it('DH/FR', 151, 184), it('4901', 182, 184), it('PMO', 252, 184), it('0535', 276, 184), it('0647', 306, 184), it('FCO', 333, 184),
    it('H1', 116, 192), it('FCO', 252, 192),
    it('Flight time:', 62, 380), it('922:01', 187, 380), // totals, then the hotel list, after the last day
    it('H1', 62, 400), it('Hotel:', 88, 400), it('STC,', 128, 400), it('Phone:', 394, 400), it('123456', 432, 400),
  ]);
  const { published } = parseNetlinePdf(pages);
  // Period starts 11Sep19 but "01. Wed" is 1 Jan 2020 (a later page range was printed).
  assert.deepEqual(published.map(r => [r.date, r.day, r.hotel, r.duty, r.dep, r.begin, r.end, r.arr, r.ac, r.info]), [
    ['1 Jan 20', 'Wed', '', 'FR 8922', 'PMO', '09:43 Z', '11:20 Z', 'TSF', 'B738', '[FT 03:07]'],
    ['2 Jan 20', 'Thu', '', 'OFF(Z)', 'PMO', '00:00 Z', '21:00 Z', '', '', ''],
    ['3 Jan 20', 'Fri', '', 'DH/FR 4901', 'PMO', '05:35 Z', '06:47 Z', 'FCO', '', ''],
    ['3 Jan 20', 'Fri', 'H1', '', 'FCO', '', '', '', '', 'STC, Tel 123456'],
  ]);
});

test('RYR layout: a code on the day line above the flight ("IWOFF") is an all-day event row of its own', () => {
  const pages = ryrPage([
    it('07. Sat', 74, 126), it('(-)', 142, 126), it('IWOFF', 156, 126),
    it('FR', 156, 134), it('8612', 175, 134), it('NRN', 250, 134), it('1555', 274, 134), it('1834', 307, 134), it('AGP', 335, 134), it('B738', 363, 134),
  ], ['01Feb09 -', '28Feb09']);
  const { published } = parseNetlinePdf(pages);
  assert.deepEqual(published.map(r => [r.date, r.duty, r.dep, r.begin, r.arr]), [
    ['7 Feb 09', 'IWOFF', '', '', ''],
    ['7 Feb 09', 'FR 8612', 'NRN', '15:55 Z', 'AGP'],
  ]);
});

test('Crew Roster Report: C/I and C/O rows, DC, AC or hotel, Blk Hrs on the event, Duty Hrs on the C/O', () => {
  const header = ['Date', 'DC', 'C/I (Z)', 'C/O (Z)', 'Activity', 'From', 'STD (Z)', 'To', 'STA (Z)', 'AC/Hotel', 'Blk Hrs', 'Duty Hrs']
    .map((t, k) => it(t, [38, 86, 105, 140, 179, 228, 259, 301, 329, 371, 470, 512][k], 177));
  const { published, format } = parseNetlinePdf([{ page: 1, width: 595, height: 842, items: [
    it('Period: 01May24 - 31May24', 226, 148), ...header,
    it('20May24', 48, 190), it('R*', 86, 190), it('1035', 105, 190), it('DI6829', 179, 190), it('HER', 228, 190), it('1135', 259, 190), it('FDH', 301, 190), it('1435', 329, 190), it('32Y', 371, 190), it('3:00', 492, 190),
    it('R*', 86, 203), it('2130', 140, 203), it('DI6828', 179, 203), it('FDH', 228, 203), it('1810', 259, 203), it('HER', 301, 203), it('2100', 329, 203), it('32Y', 371, 203), it('2:50', 492, 203), it('11:55', 536, 203),
    it('21May24', 48, 215), it('SPLIT', 179, 215), it('HER', 228, 215), it('2200-1', 259, 215), it('HER', 301, 215), it('0605', 329, 215), it('Aquila Atlantis Hotel', 371, 215),
    it('file:///C:/Users/x/HistoricRoster.html', 24, 817), it('1/1', 560, 817), // page footer
  ] }]);
  assert.equal(format, 'crew-roster-report');
  assert.deepEqual(published.map(r => [r.date, r.day, r.dc, r.duty, r.dep, r.begin, r.end, r.arr, r.ac, r.info]), [
    ['20 May 24', 'Mon', '', 'C/I', 'HER', '10:35 Z', '', '', '', ''],
    ['20 May 24', 'Mon', 'R*', 'DI6829', 'HER', '11:35 Z', '14:35 Z', 'FDH', '32Y', '[Blk Hrs 3:00]'],
    ['20 May 24', 'Mon', 'R*', 'DI6828', 'FDH', '18:10 Z', '21:00 Z', 'HER', '32Y', '[Blk Hrs 2:50]'],
    ['20 May 24', 'Mon', '', 'C/O', '', '', '21:30 Z', 'HER', '', '[Duty Hrs 11:55]'],
    ['21 May 24', 'Tue', '', 'SPLIT', 'HER', '22:00 Z -1', '06:05 Z', 'HER', '', ''],
    ['21 May 24', 'Tue', '', 'H', 'HER', '', '', '', '', 'Aquila Atlantis Hotel'],
  ]);
});

test('Crew Roster Report: a C/O on the next day ("0210+1") is still a C/O row with its Duty Hrs', () => {
  const header = ['Date', 'DC', 'C/I (Z)', 'C/O (Z)', 'Activity', 'From', 'STD (Z)', 'To', 'STA (Z)', 'AC/Hotel', 'Blk Hrs', 'Duty Hrs']
    .map((t, k) => it(t, [38, 86, 105, 140, 179, 228, 259, 301, 329, 371, 470, 512][k], 177));
  const { published } = parseNetlinePdf([{ page: 1, width: 595, height: 842, items: [
    it('Period: 01Jul24 - 31Jul24', 226, 148), ...header,
    it('27Jul24', 48, 190), it('1550', 105, 190), it('FB563', 179, 190), it('SOF', 228, 190), it('1650', 259, 190), it('LIS', 301, 190), it('2100', 329, 190), it('220', 371, 190), it('4:10', 492, 190),
    it('0210+1', 140, 203), it('FB564', 179, 203), it('LIS', 228, 203), it('2150', 259, 203), it('SOF', 301, 203), it('0140+1', 329, 203), it('220', 371, 203), it('3:50', 492, 203), it('10:20', 536, 203),
  ] }]);
  assert.deepEqual(published.slice(-2).map(r => [r.duty, r.end, r.arr, r.info]), [
    ['FB564', '01:40 Z +1', 'SOF', '[Blk Hrs 3:50]'],
    ['C/O', '02:10 Z +1', 'SOF', '[Duty Hrs 10:20]'],
  ]);
});

test('Crew Roster Report: C/I and C/O only around flights, simulators and deadheads, not around OFF / SEP / standby', () => {
  const header = ['Date', 'DC', 'C/I (Z)', 'C/O (Z)', 'Activity', 'From', 'STD (Z)', 'To', 'STA (Z)', 'AC/Hotel', 'Blk Hrs', 'Duty Hrs']
    .map((t, k) => it(t, [38, 86, 105, 140, 179, 228, 259, 301, 329, 371, 470, 512][k], 177));
  const { published } = parseNetlinePdf([{ page: 1, width: 595, height: 842, items: [
    it('Period: 01Jul25 - 31Jul25', 226, 148), ...header,
    it('01Jul25', 48, 190), it('0400', 105, 190), it('1200', 140, 190), it('OFF', 179, 190), it('AAA', 228, 190), it('0400', 259, 190), it('AAA', 301, 190), it('1200', 329, 190),
    it('03Jul25', 48, 203), it('0930', 105, 203), it('1100', 140, 203), it('SEP', 179, 203), it('AAA', 228, 203), it('0930', 259, 203), it('AAA', 301, 203), it('1100', 329, 203),
    it('06Jul25', 48, 216), it('0425', 105, 216), it('XX61', 179, 216), it('AAA', 228, 216), it('0525', 259, 216), it('BBB', 301, 216), it('1033', 329, 216), it('32N', 371, 216),
    it('1103', 140, 229), it('XX60', 179, 229), it('BBB', 228, 229), it('1140', 259, 229), it('AAA', 301, 229), it('1648', 329, 229), it('32N', 371, 229),
    it('29Jul25', 48, 242), it('1530', 105, 242), it('1715', 140, 242), it('LPC4', 179, 242), it('AAA', 228, 242), it('1645', 259, 242), it('AAA', 301, 242), it('1845', 329, 242),
    it('31Jul25', 48, 255), it('DH', 86, 255), it('0330', 105, 255), it('0835', 140, 255), it('OAIR', 179, 255), it('AAA', 228, 255), it('0400', 259, 255), it('BBB', 301, 255), it('0835', 329, 255),
  ] }]);
  assert.deepEqual(published.map(r => [r.date, r.duty]), [
    ['1 Jul 25', 'OFF'], ['3 Jul 25', 'SEP'],
    ['6 Jul 25', 'C/I'], ['6 Jul 25', 'XX61'], ['6 Jul 25', 'XX60'], ['6 Jul 25', 'C/O'],
    ['29 Jul 25', 'C/I'], ['29 Jul 25', 'LPC4'], ['29 Jul 25', 'C/O'],
    ['31 Jul 25', 'C/I'], ['31 Jul 25', 'OAIR'], ['31 Jul 25', 'C/O'],
  ]);
});

test('flight time record: flightno -> duty, registr -> registration, type -> ac, block time in info, UTC note as notice', () => {
  const header = ['flight', 'date', 'flightno', 'registr', 'type', 'dep', 'arr', 'Block Time', 'per Leg', 'SIM']
    .map((t, k) => it(t, [60, 109, 149, 207, 258, 292, 394, 428, 482, 528][k], 106));
  const r = parseNetlinePdf([{ page: 1, width: 595, height: 842, items: [
    it('Date : Aug24', 57, 70), it('Original', 173, 70), it('All times in', 290, 70), it('UTC! Only FT', 352, 70), it('from 25.03.1997 accounted !!!', 414, 70),
    ...header,
    it('297', 64, 120), it('14Aug24', 99, 120), it('OS', 149, 120), it('863', 168, 120), it('OELZC', 207, 120), it('320', 258, 120),
    it('VIE', 292, 120), it('0954', 326, 120), it('1306', 360, 120), it('CAI', 394, 120), it('3:12', 487, 120),
    it('sum', 60, 363), it('537:18', 126, 363), // totals
  ] }]);
  assert.equal(r.period, '01Aug24 - 31Aug24');
  assert.deepEqual(r.notices, ['All times in UTC! Only FT from 25.03.1997 accounted !!!']);
  assert.deepEqual(r.published.map(x => [x.date, x.day, x.duty, x.registration, x.ac, x.dep, x.begin, x.end, x.arr, x.info]), [
    ['14 Aug 24', 'Wed', 'OS 863', 'OELZC', '320', 'VIE', '09:54 Z', '13:06 Z', 'CAI', '[Block Time 3:12]'],
  ]);
});

test('crew flight log: Block-Off/On -> begin/end, Blocktime -> [Block Hrs: ..], AcType -> ac, AcRegId -> registration', () => {
  const header = ['Year', 'Month', 'Date', 'Dep', 'Block-Off', 'Arr', 'Block-On', 'Blocktime', 'AcType', 'AcRegId', 'PiC', 'FO']
    .map((t, k) => it(t, [50, 82, 124, 160, 190, 246, 275, 329, 387, 435, 546, 681][k], 134));
  const r = parseNetlinePdf([{ page: 1, width: 792, height: 612, items: [
    it('Austrian Airlines Crew Flightlog', 40, 38), ...header,
    it('2024', 50, 149), it('8', 93, 149), it('14.08.', 122, 149), it('VIE', 162, 149), it('09:54', 199, 149), it('CAI', 246, 149),
    it('13:06', 283, 149), it('03:12', 340, 149), it('320', 395, 149), it('OELZC', 433, 149), it('FORSTERLEITHNER', 493, 149), it('03:12', 675, 149),
    it('14.08.', 122, 164), it('CAI', 161, 164), it('14:06', 199, 164), it('VIE', 247, 164), it('17:33', 283, 164), it('03:27', 340, 164), it('320', 395, 164), it('OELZC', 433, 164),
    it('8', 80, 179), it('-', 88, 179), it('Summary', 95, 179), it('51:22', 339, 179), // totals
  ] }]);
  assert.equal(r.format, 'flight-log');
  assert.equal(r.period, '01Aug24 - 31Aug24');
  assert.deepEqual(r.published.map(x => [x.date, x.day, x.dep, x.begin, x.end, x.arr, x.ac, x.registration, x.info]), [
    ['14 Aug 24', 'Wed', 'VIE', '09:54 Z', '13:06 Z', 'CAI', '320', 'OELZC', '[Block Hrs: 03:12]'],
    ['14 Aug 24', 'Wed', 'CAI', '14:06 Z', '17:33 Z', 'VIE', '320', 'OELZC', '[Block Hrs: 03:27]'],
  ]);
});

test('Spanish activity calendar: "Lunes 01/07/2024", times as "UTC Z / local L", Asignación as duty, Descripción as info', () => {
  const r = parseNetlinePdf([{ page: 1, width: 612, height: 792, items: [
    it('Fecha Inicio', 26, 55), it('01/07/2024', 77, 55), it('Fecha Fin', 200, 55), it('31/07/2024', 241, 55),
    it('Hora Salida', 190, 138), it('Descripción', 317, 138), it('Horas', 502, 138),
    it('Fecha Asignación', 46, 142.7), it('Hora Salida', 136, 142.7), it('Asignación', 248, 142.7), it('ORI/DES', 389, 142.7), it('Hora Llegada', 435, 142.7), it('Nro Vuelo', 549, 142.7),
    it('UTC', 203, 148), it('Asignación', 318, 148), it('Llegada UTC', 490, 148),
    it('Lunes 01/07/2024', 47, 160), it('00:00', 148, 160), it('05:00', 202, 160), it('L', 266, 160), it('GYE /', 395, 160), it('00:00', 450, 160), it('05:00', 504, 160),
    it('Martes 02/07/2024', 45, 171), it('16:20', 148, 171), it('21:20', 202, 171), it('GYE / JFK', 388, 171), it('23:50', 450, 171), it('03:50', 504, 171), it('7392', 559, 171),
    it('Jueves 04/07/2024', 46, 181), it('08:00', 148, 181), it('13:00', 202, 181), it('SBY', 249, 181), it('Reserva', 320, 181), it('GYE /', 395, 181), it('12:00', 450, 181), it('17:00', 504, 181),
    it('1/2', 574, 724), // page footer
  ] }]);
  assert.equal(r.format, 'activity-calendar');
  assert.equal(r.period, '01Jul24 - 31Jul24');
  assert.deepEqual(r.published.map(x => [x.date, x.day, x.duty, x.dep, x.arr, x.begin, x.end, x.info]), [
    ['1 Jul 24', 'Mon', 'L', 'GYE', '', '05:00 Z / 00:00 L', '05:00 Z / 00:00 L', ''],
    ['2 Jul 24', 'Tue', '7392', 'GYE', 'JFK', '21:20 Z / 16:20 L', '03:50 Z / 23:50 L', ''],
    ['4 Jul 24', 'Thu', 'SBY', 'GYE', '', '13:00 Z / 08:00 L', '17:00 Z / 12:00 L', 'Reserva'],
  ]);
});

test('times: one format, "HH:MM Z" (UTC), "HH:MM L" (local, printed with "!"), both only when both are known', () => {
  assert.equal(formatTime('0315'), '03:15 Z');
  assert.equal(formatTime('!1300'), '13:00 L');
  assert.equal(formatTime('09:54'), '09:54 Z');
  assert.equal(formatTime('2200-1'), '22:00 Z -1');
  assert.equal(formatTime('0140+1'), '01:40 Z +1');
  assert.equal(formatTime('05:00 Z / 00:00 L'), '05:00 Z / 00:00 L');
  assert.equal(formatTime(''), '');
  assert.equal(formatTime('0700', 'B'), '07:00 B'); // plan noted "(!) if not in homebase timezone"
  assert.equal(formatTime('!1145', 'B'), '11:45 L');
  assert.equal(formatTime('0759', 'LB'), '07:59 LB'); // "(!) if not in departure airport timezone"
  assert.equal(formatTime('1445', 'L'), '14:45 L'); // "All CI/CO times are local"
});

test('the plan note decides the zone of plain times: departure airport -> LB, "times are local" -> L', () => {
  const rows = (note) => {
    const pages = page([it('Sat13', 28, 118), it('DY', 60, 118), it('1354', 75, 118), it('OSL', 132, 118), it('0759', 154, 118), it('!0842', 174, 118), it('EDI', 196, 118)]);
    pages[0].items.push(it(note, 434, 36));
    return parseNetlinePdf(pages).published.map(r => [r.begin, r.end]);
  };
  assert.deepEqual(rows('Local times at event airport. (!) if not in departure airport timezone'), [['07:59 LB', '08:42 L']]);
  assert.deepEqual(rows('All CI/CO times are local'), [['07:59 L', '08:42 L']]);
});

test('a plan noted "(!) if not in homebase timezone" gives homebase times as B, "!" times as L', () => {
  const pages = page([
    it('Wed20', 28, 118), it('GAF', 60, 118), it('3733B', 75, 118), it('ZNW', 132, 118), it('0900', 154, 118), it('!1145', 174, 118), it('VNO', 196, 118),
  ]);
  pages[0].items.push(it('Local times at event airport. (!)', 434, 36), it('if not in', 637, 36), it('homebase timezone', 697, 36));
  const { published } = parseNetlinePdf(pages);
  assert.deepEqual(published.map(r => [r.duty, r.begin, r.end]), [['GAF 3733B', '09:00 B', '11:45 L']]);
});

test('Personal Crew Schedule Report: one column per day, overnight flight lands on the next column, other crew on the whole duty', () => {
  const g = (text, x, y) => ({ text, x, y, w: text.length * 3.4, h: 6.8 });
  const days = ['01/07', '02/07', '03/07', '04/07', '05/07', '06/07', '07/07'];
  const col = (d) => 20 + d * 26; // left edge of day d's column
  const items = [
    g('Personal Crew Schedule Report', 292, 18), g('01/07/2024 - 31/07/2024 (All times in Local Station)', 274, 52),
    ...days.map((t, d) => g(t, col(d), 100)), ...['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((t, d) => g(t, col(d) + 4, 109)),
    // 01/07: C/I, two flights, C/O
    ...['13:50', '856', '15:05', 'KUL', 'CNX', '16:50', '[AK2A]', '', '857', '17:20', 'CNX', 'KUL', '21:15', '[AK2A]', '', '21:45']
      .map((t, k) => t && g(t, col(0), 119 + k * 6.7)).filter(Boolean),
    g('KU4', col(1), 119), g('12:00', col(1), 125.7), g('20:00', col(1), 132.4),
    // 03/07: a flight landing after midnight, 04/07: its arrival and C/O, then REST
    g('12:50', col(2), 119), g('5752', col(2), 132), g('21:15', col(2), 139), g('TWU', col(2), 145.7), g('→', col(2), 152.4),
    g('↓', col(3), 119), g('KUL', col(3), 125.7), g('00:05', col(3), 132.4), g('[AK20]', col(3), 139), g('00:35', col(3), 152.4), g('REST', col(3), 165.8),
    g('OFF', col(5), 119), g('OFF', col(6), 119),
    g('Total Hours and Statistics', 18, 300), g('72:55', 18, 320),
    // other crew: listed for the second flight of 01/07, wrapped over two lines; a date a day off the grid's (04/07 for 5752)
    g('Other Crew', 17, 350), g('Date', 18, 365), g('Duty', 95, 365), g('Details', 171, 365),
    g('CP - 1014526 - REKHRAJ, SUNEEL | FO - 1036821 -', 172, 371), g('01/07/2024', 18, 380), g('A0857', 95, 380), g('NUR FAQIHAH | CC -', 172, 380),
    g('1008829 - EMELDA', 172, 389), // three lines centred on the entry
    g('04/07/2024', 18, 401), g('A5752', 95, 401), g('CP - 1 - A | FO - 2 - B', 172, 401),
    // legend: code and description as one item or two, a wrapped description, an indicator
    g('Duty Codes', 17, 428), g('Indicators', 421, 428),
    g('KU4', 17, 447), g('- KUL Home Standby', 38, 447), g('REST - Rest', 17, 466),
    g('OFF', 17, 485), g('- Day', 38, 485), g('Off', 38, 492), g('X - Not a code here', 421, 447),
    g('Generated on Jun 26, 2024 15:00', 14, 559),
  ];
  const r = parseNetlinePdf([{ page: 1, width: 842, height: 595, items }]);
  assert.equal(r.format, 'schedule-grid');
  assert.equal(r.period, '01Jul24 - 31Jul24');
  const crew1 = '[CP - 1014526 - REKHRAJ, SUNEEL][FO - 1036821 - NUR FAQIHAH][CC - 1008829 - EMELDA]';
  assert.deepEqual(r.published.map(x => [x.duty, x.crew]).filter(x => x[1]), [['856', crew1], ['857', crew1], ['5752', '[CP - 1 - A][FO - 2 - B]']]);
  assert.deepEqual(r.published.map(x => [x.date, x.day, x.duty, x.dep, x.begin, x.end, x.arr, x.ac, x.info]), [
    ['1 Jul 24', 'Mon', 'C/I', '', '13:50 L', '', '', '', ''],
    ['1 Jul 24', 'Mon', '856', 'KUL', '15:05 L', '16:50 L', 'CNX', 'AK2A', ''],
    ['1 Jul 24', 'Mon', '857', 'CNX', '17:20 L', '21:15 L', 'KUL', 'AK2A', ''],
    ['1 Jul 24', 'Mon', 'C/O', '', '', '21:45 L', '', '', ''],
    ['2 Jul 24', 'Tue', 'KU4', '', '12:00 L', '20:00 L', '', '', '[KU4: KUL Home Standby]'],
    ['3 Jul 24', 'Wed', 'C/I', '', '12:50 L', '', '', '', ''],
    ['3 Jul 24', 'Wed', '5752', 'TWU', '21:15 L', '00:05 L +1', 'KUL', 'AK20', ''],
    ['4 Jul 24', 'Thu', 'C/O', '', '', '00:35 L', '', '', ''],
    ['4 Jul 24', 'Thu', 'REST', '', '', '', '', '', '[REST: Rest]'],
    ['6 Jul 24', 'Sat', 'OFF', '', '', '', '', '', '[OFF: Day Off]'],
    ['7 Jul 24', 'Sun', 'OFF', '', '', '', '', '', '[OFF: Day Off]'],
  ]);
});

test('Personal Crew Schedule Report grid (Wizz Air): UTC, wrapped flight numbers, A-times, (L), Delay, duty with a route, C/I before a duty, day indicators on every event of the day but C/I and C/O, F/D totals skipped', () => {
  const g = (text, x, y) => ({ text, x, y, w: text.length * 3.4, h: 6.8 });
  const col = (d) => 25 + d * 26; // left of the first column: the F / D labels
  const items = [
    g('Personal Crew Schedule Report', 292, 18), g('01/01/2025 - 31/01/2025 (All times in UTC)', 295, 52),
    ...['01/01', '02/01', '03/01', '04/01', '05/01', '06/01', '07/01'].map((t, d) => g(t, col(d), 100)),
    ...['Wed', 'Thu', 'Fri', 'Sat', 'Sun', 'Mon', 'Tue'].map((t, d) => g(t, col(d) + 4, 109)),
    // 01/01: a standby to the next morning; 02/01: its end
    g('SBY', col(0), 120), g('19:50', col(0), 128), g('→', col(0), 136),
    g('↓', col(1), 120), g('05:50', col(1), 128),
    // 03/01: "EBT" + "O"
    g('EBT', col(2), 120), g('O', col(2), 127), g('03:00', col(2), 135), g('07:00', col(2), 143),
    // 04/01: C/I, a flight to the next day; 05/01: its arrival, delay, C/O
    g('20:35', col(3), 120), g('WMT28', col(3), 137), g('25', col(3) + 7, 145), g('A21:45', col(3), 153), g('AUH', col(3), 161), g('→', col(3), 169),
    g('↓', col(4), 120), g('MLE', col(4), 128), g('A02:45', col(4), 137), g('[32Q]', col(4), 145), g('Delay', col(4), 161), g('00:50', col(4), 169), g('03:15', col(4), 185),
    // 07/01: a duty with a route ("*" kept), then a C/I before a timed duty
    g('PCAR55', col(6), 120), g('15:30', col(6), 128), g('*VIE', col(6), 137), g('BUD', col(6), 145), g('18:30', col(6), 153),
    g('20:05', col(6), 161), g('ST', col(6), 169), g('21:35', col(6), 177), g('23:00', col(6), 185),
    // 06/01: C/I, a flight with an indicator, C/O
    g('00:55', col(5), 120), g('WAZ701', col(5), 137), g('5', col(5) + 8, 145), g('A02:00', col(5), 153), g('AUH', col(5), 161), g('GYD', col(5), 169),
    g('A05:00', col(5), 177), g('(L)', col(5), 185), g('[321]', col(5), 194), g('05:30', col(5), 210),
    // day indicators, then the F / D totals
    g('S', col(0) + 6, 308), g('D', col(3) + 6, 308), g('L', col(5) + 6, 308),
    g('F', 15, 326), g('06:25', col(0), 326), g('D', 15, 345), g('07:45', col(0), 345), g('01:03', col(3), 345),
    g('Total Hours and Statistics', 18, 380),
    g('Duty Codes', 17, 428), g('Indicators', 421, 428), g('SBY - Home standby', 17, 447),
    g('S - Swap', 421, 447), g('D - Daily allowance', 421, 466), g('L - Line Training (Instructor)', 421, 485),
    g('Generated on Jan 16, 2025 09:13', 14, 559),
  ];
  const r = parseNetlinePdf([{ page: 1, width: 842, height: 595, items }]);
  assert.equal(r.format, 'schedule-grid');
  assert.deepEqual(r.notices, ['All times in UTC']);
  assert.deepEqual(r.published.map(x => [x.date, x.duty, x.dep, x.begin, x.end, x.arr, x.ac, x.info]), [
    ['1 Jan 25', 'SBY', '', '19:50 Z', '05:50 Z +1', '', '', '[SBY: Home standby] [S: Swap]'],
    ['3 Jan 25', 'EBTO', '', '03:00 Z', '07:00 Z', '', '', ''],
    ['4 Jan 25', 'C/I', '', '20:35 Z', '', '', '', ''],
    ['4 Jan 25', 'WMT2825', 'AUH', 'A21:45 Z', 'A02:45 Z +1', 'MLE', '32Q', '[D: Daily allowance] [Delay 00:50]'],
    ['5 Jan 25', 'C/O', '', '', '03:15 Z', '', '', ''],
    ['6 Jan 25', 'C/I', '', '00:55 Z', '', '', '', ''],
    ['6 Jan 25', 'WAZ7015', 'AUH', 'A02:00 Z', 'A05:00 Z', 'GYD', '321', '[L: Line Training (Instructor)]'],
    ['6 Jan 25', 'C/O', '', '', '05:30 Z', '', '', ''],
    ['7 Jan 25', 'PCAR55', '*VIE', '15:30 Z', '18:30 Z', 'BUD', '', ''],
    ['7 Jan 25', 'C/I', '', '20:05 Z', '', '', '', ''],
    ['7 Jan 25', 'ST', '', '21:35 Z', '23:00 Z', '', '', ''],
  ]);
});

test('Personal Crew Schedule Report, Schedule Details: C/I and C/O from report/debrief times, routes, crew, hotels', () => {
  const g = (text, x, y) => ({ text, x, y, w: text.length * 4, h: 8.4 });
  const head = [['Date', 17], ['Duties', 93], ['Details', 181], ['Report times', 306], ['Actual times/Delays', 380], ['Debrief times', 507], ['Indicators', 595], ['Crew', 656]];
  const items = [
    g('Personal Crew Schedule Report', 292, 18), g('01/09/2024 - 30/09/2024 (All times in Local Station)', 274, 52),
    g('Schedule Details', 17, 117), ...head.map(([t, x]) => g(t, x, 138)),
    g('01/09/2024 Sun', 16, 157), g('OFF', 92, 157), g('Day off', 180, 157), g('B,M', 595, 157),
    // a day of two flights: date, report and debrief level with their middle; a crew stack of three, centred too
    g('03/09/2024 Tue', 16, 185), g('3880', 92, 180), g('*BCN - BIO', 180, 180), g('A07:12 - A08:31', 380, 180),
    g('3881', 92, 190), g('BIO - RMU', 180, 190), g('A09:11 - A10:29/01:41', 380, 190),
    g('06:15', 305, 185), g('10:59', 506, 185),
    g('CP - DHC - 1096 - CASANOVAS', 655, 175), g('FO - 2151 - EREZUMA', 655, 185), g('PU - 300411 - VITORICA', 655, 195),
    // details wrapping onto two lines, centred on the duty
    g('04/09/2024 Wed', 16, 215), g('FFSZ', 92, 215), g('Full Flight Sim', 180, 210), g('319', 180, 220), g('08:30 - 12:30', 380, 215),
    g('Total Hours and Statistics', 18, 240),
    g('Hotel Information', 17, 300), g('Port', 17, 318), g('Phone', 218, 318), g('Address', 420, 318), g('Locators', 621, 318),
    g('\u0000', 218, 330), g('BIO', 17, 340), g('+34 944', 218, 340), g('HOTEL BED4U', 420, 335), g('48012 Bilbo,', 420, 345),
    g('03/09/2024', 621, 335), g('04/09/2024', 621, 345),
    g('Memos', 17, 370), g('Date', 17, 380), g('Category', 93, 380), g('Memo', 281, 380),
    g('01/09/2024', 17, 390), g('Day Memo', 93, 390), g('MOLTES FELICITATS', 281, 390),
    g('Descriptions', 17, 410), g('Duty Codes', 17, 420), g('Indicators', 421, 420),
    g('OFF - Day off', 17, 430), g('B - Happy Birthday', 420, 430), g('M - Day Memo', 420, 440),
    g('Generated on Sep 28, 2024 11:06', 14, 559),
  ];
  const r = parseNetlinePdf([{ page: 1, width: 842, height: 595, items }]);
  assert.equal(r.format, 'schedule-details');
  assert.equal(r.period, '01Sep24 - 30Sep24');
  assert.deepEqual(r.published.map(x => [x.date, x.day, x.duty, x.dep, x.arr, x.begin, x.end, x.crew, x.info]), [
    ['1 Sep 24', 'Sun', 'OFF', '', '', '', '', '', '[OFF: Day off] [B: Happy Birthday] [M: Day Memo] [Memo: MOLTES FELICITATS]'],
    ['3 Sep 24', 'Tue', 'C/I', '', '', '06:15 L', '', '', ''],
    ['3 Sep 24', 'Tue', '3880', '*BCN', 'BIO', 'A07:12 L', 'A08:31 L', '[CP - DHC - 1096 - CASANOVAS][FO - 2151 - EREZUMA][PU - 300411 - VITORICA]', ''],
    ['3 Sep 24', 'Tue', '3881', 'BIO', 'RMU', 'A09:11 L', 'A10:29 L', '[CP - DHC - 1096 - CASANOVAS][FO - 2151 - EREZUMA][PU - 300411 - VITORICA]', '[Delay 01:41]'],
    ['3 Sep 24', 'Tue', 'C/O', '', '', '', '10:59 L', '', ''],
    ['3 Sep 24', 'Tue', 'H', 'BIO', '', '', '', '', 'HOTEL BED4U, 48012 Bilbo, Tel +34 944'],
    ['4 Sep 24', 'Wed', 'FFSZ', '', '', '08:30 L', '12:30 L', '', '[FFSZ: Full Flight Sim 319]'],
    ['4 Sep 24', 'Wed', 'H', 'BIO', '', '', '', '', 'HOTEL BED4U, 48012 Bilbo, Tel +34 944'],
  ]);
});

test('compact plan "date duty dep arr AC": period after the name, LB times, crew ids per flight number', () => {
  const w = (text, x, y) => ({ text, x, y, w: text.length * 3.5, h: 5 });
  const pages = [{ page: 1, width: 841, height: 595, items: [
    w('Individual duty plan for', 31, 22), w('Period:', 456, 22), w('31Aug26', 503, 22), w('--', 575, 22), w('06Sep26', 588, 22),
    w('date', 51, 80), w('duty', 110, 80), w('dep', 153, 80), w('arr', 227, 80), w('AC', 257, 80),
    w('Sat05', 51, 162), w('DDO', 106, 162),
    w('Sun06', 51, 176), w('C/I', 78, 176), w('MFM', 152, 176), w('1745', 176, 176),
    w('NX992', 106, 189), w('MFM', 152, 189), w('1855', 176, 189), w('!2110', 201, 189), w('BKK', 225, 189), w('A3XX', 250, 189),
    w('C/O', 78, 216), w('2320', 201, 216), w('BKK', 225, 216),
    w('992', 78, 230), w('Cockpit:01736 03912', 96, 230),
    w('Cabin:06366 06377', 96, 243),
    w('Local time at homebase or (!) outside homebase', 28, 522),
    w('[16] PR-1: Post release check-1st', 148, 556),
  ] }];
  const { published: rows, period } = parseNetlinePdf(pages);
  assert.equal(period, '31Aug26 - 06Sep26');
  assert.deepEqual(rows.map(r => [r.date, r.day, r.duty, r.dep, r.begin, r.end, r.arr, r.ac, r.crew, r.info]), [
    ['5 Sep 26', 'Sat', 'DDO', '', '', '', '', '', '', ''],
    ['6 Sep 26', 'Sun', 'C/I', 'MFM', '17:45 LB', '', '', '', '', ''],
    ['6 Sep 26', 'Sun', 'NX992', 'MFM', '18:55 LB', '21:10 L', 'BKK', 'A3XX', '[Cockpit - 01736][Cockpit - 03912][Cabin - 06366][Cabin - 06377]', ''],
    ['6 Sep 26', 'Sun', 'C/O', '', '', '23:20 LB', 'BKK', '', '', ''],
  ]);
});

test('compact plan in 3 columns: a header "date" 1.5 pt above the others still starts a column; C/I 24 pt right of "date" is the duty', () => {
  // coordinates of 451bf660… (Dec 2024): the third "date" at y 72.87, the rest of the header at 74.3
  const w = (text, x, y) => ({ text, x, y, w: text.length * 3.5, h: 7 });
  const head = (dateY, ...xs) => ['date', 'duty', 'dep', 'arr', 'AC'].map((t, k) => w(t, xs[k], k ? 74.32 : dateY));
  const pages = [{ page: 1, width: 842, height: 595, items: [
    w('Individual duty plan for', 18, 13), w('Period:', 434, 13), w('01Dec24', 471, 13), w('--', 514, 13), w('31Dec24', 526, 13),
    ...head(74.38, 22.8, 76.9, 126.4, 204.2, 235.9), ...head(74.38, 278.6, 333.4, 382.9, 460.7, 489.6), ...head(72.87, 529.9, 585, 628.9, 701.2, 730.1),
    w('Sun01', 22, 90), w('C/I', 47, 90.6), w('KHH', 128, 90.6), w('1340', 155, 90.6),
    w('NX667', 78, 100), w('KHH', 128, 100), w('1440', 155, 100), w('1615', 182, 100), w('MFM', 209, 100), w('A3XX', 236, 100),
    w('C/O', 47, 109), w('1645', 182, 109), w('MFM', 209, 109),
    w('Thu12', 277, 90), w('DDO', 335, 90),
    w('Tue24', 529, 90), w('C/I', 555.5, 90.6), w('MFM', 629, 90.6), w('1530', 653.5, 90.6),
    w('NX936', 583.5, 100), w('MFM', 629, 100), w('1650', 653.5, 100), w('!1850', 678, 100), w('DMK', 702.5, 100), w('A3XX', 727, 100),
    w('C/O', 555.5, 109), w('!1920', 678, 109), w('DMK', 702.5, 109),
    w('Local time at homebase or (!) outside homebase', 18, 545),
  ] }];
  const { published: rows } = parseNetlinePdf(pages);
  assert.deepEqual(rows.map(r => [r.date, r.duty, r.dep, r.begin, r.end, r.arr, r.ac]), [
    ['1 Dec 24', 'C/I', 'KHH', '13:40 LB', '', '', ''],
    ['1 Dec 24', 'NX667', 'KHH', '14:40 LB', '16:15 LB', 'MFM', 'A3XX'],
    ['1 Dec 24', 'C/O', '', '', '16:45 LB', 'MFM', ''],
    ['12 Dec 24', 'DDO', '', '', '', '', ''],
    ['24 Dec 24', 'C/I', 'MFM', '15:30 LB', '', '', ''],
    ['24 Dec 24', 'NX936', 'MFM', '16:50 LB', '18:50 L', 'DMK', 'A3XX'],
    ['24 Dec 24', 'C/O', '', '', '19:20 L', 'DMK', ''],
  ]);
});

// ---- 2026-10-20 layouts (synthetic pages with the samples' coordinates; names and numbers made up) ----
const iw = (text, x, y, w) => ({ text, x, y, w, h: 5 });

test('activity list (Azul style): C/I once per duty, legs, C/O after the last leg, Portuguese months, split times', () => {
  const head = [iw('Activity', 21, 60, 26), iw('Checkin', 68, 60, 29), iw('Start', 146, 60, 18), iw('Dep', 224, 60, 14), iw('Arr', 256, 60, 11),
    iw('End', 285, 60, 13), iw('Checkout', 363, 60, 34), iw('AcVer', 441, 60, 20), iw('DD', 481, 60, 11), iw('CAT', 509, 60, 15), iw('Crew', 542, 60, 19)];
  // the checkin / checkout repeated on both legs, times cut into "15" ":" "00"
  const t = (date, hh, mm, x, y) => [iw(`${date} ${hh}`, x, y, 44), iw(':', x + 44, y, 2), iw(mm, x + 46, y, 10)];
  const leg = (y, no, start, dep, arr, end) => [iw(no, 21, y, 29), ...t('01AGO22', '15', '00', 68, y), ...t(...start, 146, y), iw(dep, 224, y, 15), iw(arr, 256, y, 15),
    ...t(...end, 285, y), ...t('01AGO22', '23', '27', 363, y), iw('EJF', 441, y, 13), iw('-', 481, y, 4), iw('FO', 509, y, 11), iw('-', 542, y, 4)];
  const pages = [
    { page: 1, width: 595, height: 842, items: [iw('12345 - JOAO TESTE (01/08/2022 - 31/08/2022)', 21, 40, 200), ...head,
      ...leg(80, 'AD2020', ['01AGO22', '15', '40'], 'VCP', 'BEL', ['01AGO22', '19', '04']),
      ...leg(90, 'AD2021', ['01AGO22', '21', '51'], 'BEL', 'MAO', ['02AGO22', '00', '57'])] },
    // the next page goes on without the header line
    { page: 2, width: 595, height: 842, items: [iw('FR', 21, 40, 11), iw('-', 68, 40, 4), ...t('04AGO22', '08', '25', 146, 40), iw('VCP', 224, 40, 15), iw('VCP', 256, 40, 15),
      ...t('05AGO22', '08', '25', 285, 40), iw('-', 363, 40, 4), iw('-', 441, 40, 4), iw('-', 481, 40, 4), iw('FO', 509, 40, 11), iw('-', 542, 40, 4)] },
  ];
  const r = parseNetlinePdf(pages);
  assert.equal(r.format, 'activity-list');
  assert.equal(r.period, '01Aug22 - 05Aug22');
  assert.deepEqual(r.published.map(x => [x.date, x.day, x.dc, x.duty, x.dep, x.begin, x.end, x.arr, x.ac]), [
    ['1 Aug 22', 'Mon', '', 'C/I', 'VCP', '15:00 Z', '', '', ''],
    ['1 Aug 22', 'Mon', 'FO', 'AD2020', 'VCP', '15:40 Z', '19:04 Z', 'BEL', 'EJF'],
    ['1 Aug 22', 'Mon', 'FO', 'AD2021', 'BEL', '21:51 Z', '00:57 Z +1', 'MAO', 'EJF'],
    ['1 Aug 22', 'Mon', '', 'C/O', '', '', '23:27 Z', 'MAO', ''],
    ['4 Aug 22', 'Thu', 'FO', 'FR', 'VCP', '08:25 Z', '08:25 Z +1', 'VCP', ''],
  ]);
});

test('Log Book Report by Crew Members: one duty per CheckIn (C/I, legs, C/O at Rest After), OFF, HOTAC, rail', () => {
  const head = [
    iw('Log Book Report by Crew Members on period [01/04/2024-30/04/2024]', 23, 22, 300), iw('Schedule in UTC', 23, 45, 60),
    iw('Activity', 79, 98, 30), iw('Begin', 131, 98, 20), iw('End', 161, 98, 15), iw('Description', 241, 98, 40), iw('Role', 386, 98, 15), iw('Before', 520, 98, 25), iw('After', 625, 98, 20), iw('Night', 737, 98, 20),
    iw('Date', 27, 93, 15), iw('Type', 315, 93, 15), iw('Registr.', 347, 93, 30), iw('CheckIn', 573, 93, 30),
    iw('Departure', 27, 103, 40), iw('Arrival', 191, 103, 30), iw('Dep', 422, 103, 15), iw('Arr', 457, 103, 15), iw('Rot.', 491, 103, 15), iw('Block', 677, 103, 20), iw('Flight', 707, 103, 20), iw('Simu', 767, 103, 20),
  ];
  const act = (y, [d1, d2, d3], main, [t1, t2, t3]) => [
    iw(d1, 523, y - 5, 40), iw(d2, 576, y - 5, 40), iw(d3, 628, y - 5, 40),
    ...main.map(([text, x]) => iw(text, x, y, text.length * 4)),
    iw(t1, 533, y + 5, 20), iw(t2, 586, y + 5, 20), iw(t3, 638, y + 5, 20),
  ];
  const items = [...head,
    ...act(126, ['01/04/2024', '01/04/2024', '02/04/2024'], [['01/04/2024', 29], ['OFF', 79], ['22:00', 133], ['21:59', 163], ['02/04/2024', 193], ['ORY', 422], ['ORY', 457], ['00:00', 680]], ['22:00', '22:00', '21:59']),
    ...act(150, ['07/04/2024', '07/04/2024', '07/04/2024'], [['07/04/2024', 29], ['Flight', 79], ['05:45', 133], ['08:15', 163], ['07/04/2024', 193], ['TO1234', 241], ['73H', 315], ['FABCD', 342], ['ORY', 422], ['CZL', 457], ['1', 500], ['02:30', 680], ['02:15', 710], ['00:05', 740]], ['04:30', '04:30', '11:50']),
    ...act(174, ['07/04/2024', '07/04/2024', '07/04/2024'], [['07/04/2024', 29], ['Flight', 79], ['09:25', 133], ['11:20', 163], ['07/04/2024', 193], ['TO1235', 241], ['73H', 315], ['FABCD', 342], ['CZL', 422], ['LYS', 457], ['1', 500], ['01:55', 680], ['01:40', 710], ['00:00', 740]], ['04:30', '04:30', '11:50']),
    ...act(198, ['07/04/2024', '07/04/2024', '08/04/2024'], [['07/04/2024', 29], ['HOTAC', 79], ['12:10', 133], ['03:50', 163], ['08/04/2024', 193], ['LYS', 422], ['LYS', 457]], ['12:10', '12:10', '03:50']),
    ...act(222, ['08/04/2024', '08/04/2024', '08/04/2024'], [['08/04/2024', 29], ['Rail', 79], ['04:56', 133], ['06:46', 163], ['08/04/2024', 193], ['TGV1111', 241], ['LYS', 422], ['GPL', 457]], ['04:41', '04:41', '07:16']),
  ];
  const r = parseNetlinePdf([{ page: 1, width: 842, height: 595, items }]);
  assert.equal(r.format, 'logbook-report');
  assert.equal(r.period, '01Apr24 - 30Apr24');
  assert.deepEqual(r.published.map(x => [x.date, x.dc, x.duty, x.registration, x.dep, x.begin, x.end, x.arr, x.ac, x.info]), [
    ['1 Apr 24', '', 'OFF', '', 'ORY', '22:00 Z', '21:59 Z +1', 'ORY', '', ''],
    ['7 Apr 24', '', 'C/I', '', 'ORY', '04:30 Z', '', '', '', ''],
    ['7 Apr 24', '', 'TO1234', 'FABCD', 'ORY', '05:45 Z', '08:15 Z', 'CZL', '73H', '[Block: 02:30] [Flight: 02:15]'],
    ['7 Apr 24', '', 'TO1235', 'FABCD', 'CZL', '09:25 Z', '11:20 Z', 'LYS', '73H', '[Block: 01:55] [Flight: 01:40]'],
    ['7 Apr 24', '', 'C/O', '', '', '', '11:50 Z', 'LYS', '', ''],
    ['7 Apr 24', '', 'HT', '', 'LYS', '12:10 Z', '03:50 Z +1', '', '', ''],
    ['8 Apr 24', '', 'C/I', '', 'LYS', '04:41 Z', '', '', '', ''],
    ['8 Apr 24', '', 'TGV1111', '', 'LYS', '04:56 Z', '06:46 Z', 'GPL', '', '[Rail]'],
    ['8 Apr 24', '', 'C/O', '', '', '', '07:16 Z', 'GPL', '', ''],
  ]);
});

test('day blocks (Air Nostrum style): days in columns, Firma -> C/I, flights, positioning, all-day codes, next year', () => {
  const col = (x0, y) => [iw('Descr. Código', x0, y, 40), iw('Vuelo', x0 + 42, y, 15), iw('ORI-DES', x0 + 72, y, 25), iw('STD - STA', x0 + 101, y, 28), iw('Tripulación', x0 + 132, y, 35)];
  const items = [
    iw('Periodo 01/12/2021 - 01/01/2022 - Tiempos UTC', 341, 52, 150),
    ...col(14, 106), ...col(218, 106), ...col(420, 106),
    // column 1
    iw('Fecha:', 14, 113, 14), iw('mi. 01 dic.', 28, 113, 30),
    iw('Vacaciones voluntarias', 14, 120, 40), iw('VV', 56, 120, 8), iw('-', 94, 120, 3), iw('0:00 -', 115, 120, 12), iw('0:00', 129, 120, 10),
    iw('Totales : Blq', 14, 127, 22), iw('0:00:00', 37, 127, 12),
    // column 2: a duty with a positioning flight
    iw('Fecha:', 217, 113, 14), iw('mi. 29 dic.', 230, 113, 30), iw('Firma:', 295, 113, 14), iw('7:50', 309, 113, 10),
    iw('CRK', 239, 120, 12), iw('IB1001', 259, 120, 20), iw('VLC-MAD', 289, 120, 25), iw('8:35 -', 318, 120, 12), iw('9:40', 331, 120, 10), iw('Situación', 349, 120, 25),
    iw('ATX', 239, 127, 12), iw('IB1002', 259, 127, 20), iw('MAD-MLN', 289, 127, 25), iw('10:35 - 12:25', 315, 127, 30), iw('(d) PEREZ(D)', 349, 127, 35),
    iw('Totales : Blq', 217, 134, 22), iw('3:00:00', 239, 134, 12),
    iw('Fecha:', 217, 141, 14), iw('sá. 01 ene.', 230, 141, 30),
    iw('Licencia Funciones Sindi', 217, 148, 40), iw('LCA8', 259, 148, 15), iw('-', 297, 148, 3), iw('7:30 - 15:30', 317, 148, 30),
    // the legend column: no "Fecha:", nothing read
    iw('A = Entrenamiento', 425, 120, 60),
  ];
  const r = parseNetlinePdf([{ page: 1, width: 841, height: 595, items }]);
  assert.equal(r.format, 'day-blocks');
  assert.equal(r.period, '01Dec21 - 01Jan22');
  assert.deepEqual(r.published.map(x => [x.date, x.day, x.dc, x.duty, x.dep, x.begin, x.end, x.arr, x.ac, x.crew]), [
    ['1 Dec 21', 'Wed', '', 'VV', '', '', '', '', '', ''],
    ['29 Dec 21', 'Wed', '', 'C/I', 'VLC', '07:50 Z', '', '', '', ''],
    ['29 Dec 21', 'Wed', 'DHD', 'IB1001', 'VLC', '08:35 Z', '09:40 Z', 'MAD', 'CRK', ''],
    ['29 Dec 21', 'Wed', '', 'IB1002', 'MAD', '10:35 Z', '12:25 Z', 'MLN', 'ATX', '(d) PEREZ(D)'],
    ['1 Jan 22', 'Sat', '', 'LCA8', '', '07:30 Z', '15:30 Z', '', '', ''],
  ]);
});

test('Trip Information: duties with C/I and C/O (UTC), legs "Z / L" by their weekday, DH as dc, Duty Summary on the C/O, the trip\'s crew on flights', () => {
  const row = (y, cells) => cells.map(([text, x]) => iw(text, x, y, text.length * 4));
  const items = [
    ...row(34, [['Trip Information', 44]]), ...row(54, [['Date:', 44], ['13Aug2026', 94]]),
    ...row(95, [['Operates: Only on Sun 16Aug2026', 44], ['Duty Summary', 396], ['Trip Summary', 479]]),
    ...row(110, [['Day', 44], ['Flight', 74], ['Departure-Arrival', 125], ['Start(LT)', 197], ['End(LT)', 234], ['Start', 267], ['End', 293], ['Block', 319], ['A/C', 346], ['Cnx', 369]]),
    ...row(122, [['Duty start', 74], ['03:30', 267], ['Duty', 396], ['01:45', 454], ['Crew: 1CP', 479]]),
    ...row(134, [['Sun', 44], ['DH XX1582', 74], ['AAA-BBB', 125], ['21:30', 197], ['22:11', 234], ['03:30', 267], ['05:11', 293], ['-', 321], ['00:04', 369], ['Block', 396], ['00:00', 454]]),
    ...row(158, [['16Aug', 44], ['Duty end', 74], ['05:15', 293], ['Rest', 396], ['10:00', 454]]),
    ...row(183, [['Duty start', 74], ['15:15', 267], ['Duty', 396], ['18:45', 454]]),
    ...row(195, [['Sun', 44], ['484', 74], ['BBB-CCC', 125], ['11:45', 197], ['22:30', 234], ['18:45', 267], ['01:00', 293], ['06:15', 319], ['74Y', 346], ['Block', 396], ['06:15', 454]]),
    ...row(220, [['16Aug', 44], ['Duty end', 74], ['01:30', 293], ['Rest', 396], ['-', 454]]),
  ];
  const crew = [...row(34, [['Trip Information', 44]]), ...row(97, [['Pos', 44], ['Crew ID', 87], ['Name', 146]]), ...row(109, [['CP', 44], ['2465', 87], ['Ann Smith', 146]])];
  const r = parseNetlinePdf([{ page: 1, width: 595, height: 842, items }, { page: 2, width: 595, height: 842, items: crew }]);
  assert.equal(r.format, 'trip-information');
  assert.equal(r.period, '16Aug26 - 16Aug26');
  assert.deepEqual(r.published.map(x => [x.date, x.day, x.dc, x.duty, x.dep, x.begin, x.end, x.arr, x.ac, x.crew, x.info]), [
    ['16 Aug 26', 'Sun', '', 'C/I', 'AAA', '03:30 Z', '', '', '', '', ''],
    ['16 Aug 26', 'Sun', 'DH', 'XX1582', 'AAA', '03:30 Z / 21:30 L -1', '05:11 Z / 22:11 L -1', 'BBB', '', '', '[Cnx: 00:04]'],
    ['16 Aug 26', 'Sun', '', 'C/O', '', '', '05:15 Z', 'BBB', '', '', '[Duty: 01:45] [Block: 00:00] [Rest: 10:00]'],
    ['16 Aug 26', 'Sun', '', 'C/I', 'BBB', '15:15 Z', '', '', '', '', ''],
    ['16 Aug 26', 'Sun', '', '484', 'BBB', '18:45 Z / 11:45 L', '01:00 Z +1 / 22:30 L', 'CCC', '74Y', '[CP - 2465 - Ann Smith]', '[Block: 06:15]'],
    ['16 Aug 26', 'Sun', '', 'C/O', '', '', '01:30 Z +1', 'CCC', '', '', '[Duty: 18:45] [Block: 06:15]'],
  ]);
});

test('Crew Roster Report with the local times too (C/I (L) | C/I (Z) ... STD (L) | STD (Z)): "11:15 Z / 13:15 L", airports apart from the times', () => {
  const row = (y, cells) => cells.map(([text, x]) => iw(text, x, y, text.length * 4));
  const items = [
    ...row(24, [['Crew Roster Report', 255]]), ...row(139, [['Period: 25Jun24 - 12Jul24', 228]]),
    ...row(167, [['Date', 38], ['DC', 79], ['C/I (L)', 97], ['C/I (Z)', 128], ['C/O (L)', 159], ['C/O (Z)', 195], ['Activity', 231], ['From', 271], ['STD (L)', 299], ['STD (Z)', 337],
      ['To', 376], ['STA (L)', 402], ['STA (Z)', 440], ['AC/Hotel', 478], ['Blk Hrs', 523]]),
    ...row(180, [['25Jun24', 43], ['DO', 231], ['AAA', 271], ['0000', 299], ['2200-1', 337], ['AAA', 376], ['2359', 402], ['2159', 440]]),
    ...row(193, [['26Jun24', 43], ['1315', 97], ['1115', 128], ['XX143', 231], ['AAA', 271], ['1400', 299], ['1200', 337], ['BBB', 376], ['1520', 402], ['1320', 440], ['AT7', 478], ['1:20', 541]]),
    ...row(205, [['I*', 79], ['2255', 159], ['2055', 195], ['XX160', 231], ['BBB', 271], ['2120', 299], ['1920', 337], ['AAA', 376], ['2240', 402], ['2040', 440], ['AT7', 478]]),
  ];
  const r = parseNetlinePdf([{ page: 1, width: 595, height: 842, items }]);
  assert.equal(r.format, 'crew-roster-report');
  assert.deepEqual(r.published.map(x => [x.date, x.dc, x.duty, x.dep, x.begin, x.end, x.arr, x.ac, x.info]), [
    ['25 Jun 24', '', 'DO', 'AAA', '22:00 Z -1 / 00:00 L', '21:59 Z / 23:59 L', 'AAA', '', ''],
    ['26 Jun 24', '', 'C/I', 'AAA', '11:15 Z / 13:15 L', '', '', '', ''],
    ['26 Jun 24', '', 'XX143', 'AAA', '12:00 Z / 14:00 L', '13:20 Z / 15:20 L', 'BBB', 'AT7', '[Block: 1:20]'],
    ['26 Jun 24', 'I*', 'XX160', 'BBB', '19:20 Z / 21:20 L', '20:40 Z / 22:40 L', 'AAA', 'AT7', ''],
    ['26 Jun 24', '', 'C/O', '', '', '20:55 Z / 22:55 L', 'AAA', '', ''],
  ]);
});

async function parseTxt(text) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'roster-txt-test-'));
  const file = path.join(dir, 'roster.txt');
  try {
    fs.writeFileSync(file, text);
    return parseNetlinePdf(await readPdfText(file));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('LOT logbook as text (fixed width): flights, a passenger leg, a simulator session, the other pilots as crew', async () => {
  const r = await parseTxt([
    'Okres:20240501-20240531;70000001;SMITH ANN;',
    '--------.-------------.-------------.-----.---.-----.-----------.-------.-------------------------------------------------',
    'CZYNNOSC.ODKOLOWANIE  .WYL.SILNIKOW .NALOT.NOC.SAM  .REJS       .TRASA . IL.LAD.   KM          .(K) - kapitan (P) - II pilot',
    '--------.-------------.-------------.-----.---.-----.-----------.-------.-------------------------------------------------',
    'Lot      20240501 2313 20240502 0032 0119      SPABC XX 460      AAA BBB 1        832             (K)J.Doe(P)K.Roe',
    'Pax      20240505 1412 20240505 1502           SPABD XX 3807     BBB CCC 0          0',
    'Sym      20240506                    0400      EM7      0                0          0',
    '.',
    'Razem godz.na "Sym" jako instruktor:000:00',
  ].join('\r\n'));
  assert.equal(r.format, 'lot-logbook');
  assert.equal(r.period, '01May24 - 31May24');
  assert.deepEqual(r.published.map(x => [x.date, x.dc, x.duty, x.registration, x.dep, x.begin, x.end, x.arr, x.ac, x.crew, x.info]), [
    ['1 May 24', '', 'XX 460', 'SPABC', 'AAA', '23:13 Z', '00:32 Z +1', 'BBB', '', '[K - J.Doe][P - K.Roe]', '[Flight: 01:19] [Landing Day/Night: 1] [KM: 832]'],
    ['5 May 24', 'Pax', 'XX 3807', 'SPABD', 'BBB', '14:12 Z', '15:02 Z', 'CCC', '', '', ''],
    ['6 May 24', '', 'Sym', '', '', '', '', '', 'EM7', '', '[Sim: 04:00]'],
  ]);
});

test('FLICA schedule as text: pairing with BSE REPT, legs, D-END with the duty totals, the layover hotel, PAY legs, activities', async () => {
  const T = '\t';
  const r = await parseTxt([
    'FLICA', '', 'June Schedule', '', 'Last Updated Jul 15, 2022 00:32:42 EDT',
    ` WE ${T}08 ${T}B5282C${T}CLE`,
    `B5282C : 08JUN${T}ONLY ON WED${T}BSE REPT: 1636L${T}Operates: Jun 8 Only`,
    `DY${T}DD${T}DH${T}C${T}FLTNO${T}DPS-ARS${T}DEPL${T}ARRL${T}BLKT${T}GRNT${T}OA${T}    ${T}TBLK${T}TDHD${T} ${T}TCRD${T}TDUTY/FDP${T}LAYOVER  `,
    `WE${T}08${T} ${T} ${T}641${T}AAA-BBB${T}2332${T}0147${T} 0215${T} ${T}${T} ${T}0215${T}        ${T}        ${T}0215${T}0326/0311${T}BBB 1347`,
    ` ${T}D-END: 0202L REPT: 1549L${T}Hotel One${T}(216)575-1234`,
    `TH${T}09${T} ${T} ${T}1032${T}BBB-AAA${T}1657${T}1759${T} 0000${T}PAY ${T}${T} `,
    `TH${T}09${T} ${T} ${T}1033${T}BBB-AAA${T}1657${T}1759${T} 0102${T} ${T}${T} ${T}0102${T}        ${T}        ${T}0130${T}0210/0200${T} `,
    ` ${T}D-END: 1814L    T.A.F.B.: 2538    TRIP RIG: 0023   ${T}${T} `,
    `Crew:${T} `,
    `    ${T}CA ${T} 4992${T}  DOE, BOB ${T}    ${T}FO ${T} 45831${T}  SMITH, ANN `,
    'HST : 22JUN',
    `Activity${T}Start Date${T}Start Time${T}End Date${T}End Time${T}Credit`,
    `HST${T}22JUN${T}09:00${T}22JUN${T}17:00${T}0400`,
  ].join('\n'));
  assert.equal(r.format, 'flica-schedule');
  assert.equal(r.period, '01Jun22 - 30Jun22');
  const crew = '[CA - 4992 - DOE, BOB][FO - 45831 - SMITH, ANN]';
  assert.deepEqual(r.published.map(x => [x.date, x.duty, x.dep, x.begin, x.end, x.arr, x.crew, x.info]), [
    ['8 Jun 22', 'C/I', 'AAA', '16:36 L', '', '', '', ''],
    ['8 Jun 22', '641', 'AAA', '23:32 L', '01:47 L +1', 'BBB', crew, '[Block: 02:15]'],
    ['8 Jun 22', 'C/O', '', '', '02:02 L +1', 'BBB', '', '[Block: 02:15] [Credit: 02:15] [Duty: 03:26] [FDP: 03:11]'],
    ['8 Jun 22', 'HT', 'BBB', '', '', '', '', 'Hotel One (216)575-1234 [Layover: 13:47]'],
    ['9 Jun 22', 'C/I', 'BBB', '15:49 L', '', '', '', ''],
    ['9 Jun 22', '1032', 'BBB', '16:57 L', '17:59 L', 'AAA', '', '[PAY]'],
    ['9 Jun 22', '1033', 'BBB', '16:57 L', '17:59 L', 'AAA', crew, '[Block: 01:02]'],
    ['9 Jun 22', 'C/O', '', '', '18:14 L', 'AAA', '', '[Block: 01:02] [Credit: 01:30] [Duty: 02:10] [FDP: 02:00] [TAFB: 25:38] [Trip rig: 00:23]'],
    ['22 Jun 22', 'HST', '', '09:00 L', '17:00 L', '', '', '[Credit: 04:00]'],
  ]);
});

test('KLM "Chronologisch overzicht Vlieguren": day codes with a description going on, a duty over two lines, UTC, RUST on the C/I', () => {
  const row = (y, cells) => cells.map(([text, x]) => iw(text, x, y, text.length * 4));
  const items = [
    ...row(16, [['Datum: 08-01-25 09:05', 18], ['Chronologisch overzicht Vlieguren', 261]]),
    ...row(30, [['KLM ID: 00012345', 18], ['Naam: SMITH, A', 113], ['Periode: 01-10-2022 t/m 31-10-2022', 633]]),
    ...row(63, [['AANM', 115], ['VERT', 147], ['TIJD', 215], ['CMC', 261], ['TIJD', 408], ['AANK', 436], ['AFML', 482], ['WC', 532], ['NW', 566], ['AC', 633]]),
    ...row(73, [['DG', 18], ['LIJNNR', 39], ['ACREG', 76], ['TIJD', 118], ['TIJD', 149], ['VST', 189], ['V', 220], ['F', 244], ['AST', 261], ['SDC', 377], ['V', 413],
      ['TIJD', 438], ['TIJD', 484], ['VLGU', 527], ['VLGU', 562], ['VDT', 597], ['RUST', 627], ['DP', 668], ['FDP', 697], ['RECALC', 730]]),
    ...row(89, [['03', 17], ['RVF - Reisverlof', 259]]), ...row(99, [['Inneembaar', 259]]),
    ...row(148, [['06', 17], ['XX 573', 37], ['PHABC', 74], ['07:15', 112], ['09:03', 145], ['AAA', 187], ['+2', 225], ['FO', 239], ['BBB', 259], ['RI', 375], ['+3', 417], ['17:40', 432], ['8:37', 538]]),
    ...row(158, [['06', 17], ['XX 573', 37], ['PHABC', 74], ['18:39', 145], ['BBB', 187], ['+3', 225], ['FO', 239], ['CCC', 259], ['+3', 417], ['19:55', 432], ['20:25', 486], ['1:16', 538],
      ['13:10', 597], ['13:10', 667], ['12:40', 698]]),
    ...row(168, [['07', 17], ['XX 535', 37], ['PHABD', 74], ['19:25', 112], ['20:46', 145], ['CCC', 187], ['+3', 225], ['FO', 239], ['AAA', 259], ['+2', 417], ['04:59', 432], ['+1', 467],
      ['05:29', 486], ['+1', 509], ['8:13', 538], ['10:04', 597], ['23:00', 634], ['10:04', 667], ['9:34', 702]]),
  ];
  const r = parseNetlinePdf([{ page: 1, width: 842, height: 595, items }]);
  assert.equal(r.format, 'klm-flight-hours');
  assert.equal(r.period, '01Oct22 - 31Oct22');
  assert.deepEqual(r.published.map(x => [x.date, x.duty, x.registration, x.dep, x.begin, x.end, x.arr, x.info]), [
    ['3 Oct 22', 'RVF', '', '', '', '', '', '[RVF: Reisverlof Inneembaar]'],
    ['6 Oct 22', 'C/I', '', 'AAA', '07:15 Z', '', '', ''],
    ['6 Oct 22', 'XX 573', 'PHABC', 'AAA', '09:03 Z', '17:40 Z', 'BBB', '[Block: 08:37] [SDC: RI]'],
    ['6 Oct 22', 'XX 573', 'PHABC', 'BBB', '18:39 Z', '19:55 Z', 'CCC', '[Block: 01:16]'],
    ['6 Oct 22', 'C/O', '', '', '', '20:25 Z', 'CCC', '[Duty: 13:10] [DP: 13:10] [FDP: 12:40]'],
    ['7 Oct 22', 'C/I', '', 'CCC', '19:25 Z', '', '', '[Rest: 23:00]'],
    ['7 Oct 22', 'XX 535', 'PHABD', 'CCC', '20:46 Z', '04:59 Z +1', 'AAA', '[Block: 08:13]'],
    ['7 Oct 22', 'C/O', '', '', '', '05:29 Z +1', 'AAA', '[Duty: 10:04] [DP: 10:04] [FDP: 09:34]'],
  ]);
});

test('KLM "Chronologisch overzicht Vlieguren": a simulator day "VA OPS check" and "RT-B" with their times, a page going on without the header', () => {
  const row = (y, cells) => cells.map(([text, x]) => iw(text, x, y, text.length * 4));
  const head = [
    ...row(16, [['Datum: 08-01-25 09:05', 18], ['Chronologisch overzicht Vlieguren', 261]]),
    ...row(30, [['KLM ID: 00012345', 18], ['Periode: 01-10-2022 t/m 31-10-2022', 633]]),
    ...row(73, [['DG', 18], ['LIJNNR', 39], ['ACREG', 76], ['TIJD', 118], ['TIJD', 149], ['VST', 189], ['V', 220], ['F', 244], ['AST', 261], ['SDC', 377], ['V', 413],
      ['TIJD', 438], ['TIJD', 484], ['VLGU', 527], ['VLGU', 562], ['VDT', 597], ['RUST', 627], ['DP', 668], ['FDP', 697], ['RECALC', 730]]),
  ];
  const r = parseNetlinePdf([
    { page: 1, width: 842, height: 595, items: [...head, ...row(89, [['12', 17], ['2', 43], ['10:15', 112], ['VA', 259], ['OPS check', 352], ['15:15', 486]]), ...row(99, [['14', 17], ['HKG', 259], ['V+', 377]])] },
    { page: 2, width: 842, height: 595, items: [...row(14, [['22', 17], ['05:00', 112], ['RT-B - Reserve Thuis', 259], ['17:00', 486]]), ...row(24, [['30', 17], ['RV - Reisverlof', 259]])] },
  ]);
  assert.deepEqual(r.published.map(x => [x.date, x.duty, x.begin, x.end, x.info]), [
    ['12 Oct 22', 'VA', '10:15 Z', '15:15 Z', '[VA: OPS check]'],
    ['22 Oct 22', 'RT-B', '05:00 Z', '17:00 Z', '[RT-B: Reserve Thuis]'],
    ['30 Oct 22', 'RV', '', '', '[RV: Reisverlof]'],
  ]);
});

test('Crew Roster by Period: duty with C/I, flights (route a line lower), crew lists, C/O totals, hotel, OFF; local times in brackets', () => {
  const row = (y, cells) => cells.map(([text, x]) => iw(text, x, y, text.length * 4));
  const items = [
    ...row(16, [['Crew Roster by Period [01/04/2024-30/04/2024]', 31], ['Licenced to EXAMPLE', 361]]),
    ...row(27, [['Schedule in UTC (LT of Arr & Dep: Times in Brackets)', 31]]),
    ...row(65, [['Type', 29], ['From', 103], ['To', 144], ['Activity', 168], ['Fct Routing / Description', 218], ['A/C', 384], ['Blk', 412], ['Training', 434], ['Crew Member', 491], ['Remark', 632]]),
    ...row(76, [['Sun 07/04/2024', 34]]),
    ...row(98, [['Begin Duty', 29], ['06:30', 103], ['>>>', 143], ['Standard', 238], ['Duty', 282], ['Check In (UTC) : 07/04/2024 06:30', 632]]),
    ...row(107, [['[08:30]', 98]]),
    ...row(118, [['Duty Flight', 29], ['07:46', 103], ['10:31', 138], ['XX7672', 168], ['CC', 221], ['73H', 386], ['02:45', 408], ['Pilot:', 491]]),
    ...row(127, [['[09:46]', 98], ['[11:31]', 133], ['AAA-BBB', 238], ['(FGABC)', 277], ['©SMITH Ann', 495], ['(SMA)', 601]]),
    ...row(136, [['End Duty', 29], ['>>>', 108], ['11:01', 138], ['TOTAL BLK=2:45 FDP=4:00[12:30] DUTY=', 632]]),
    ...row(145, [['[13:01]', 133]]),
    ...row(154, [['HOTAC', 29], ['11:30', 103], ['>>>', 143], ['Hotel', 238], ['One', 262], ['4:31', 632]]),
    ...row(163, [['Mon 08/04/2024', 34]]),
    ...row(172, [['Ground Act.', 29], ['22:00', 103], ['>>>', 143], ['OFF', 168], ['JOUR', 238], ['OFF', 262]]),
  ];
  const r = parseNetlinePdf([{ page: 1, width: 842, height: 595, items }]);
  assert.equal(r.format, 'crew-roster-by-period');
  assert.equal(r.period, '01Apr24 - 30Apr24');
  assert.deepEqual(r.published.map(x => [x.date, x.duty, x.registration, x.dep, x.begin, x.end, x.arr, x.ac, x.crew, x.info]), [
    ['7 Apr 24', 'C/I', '', 'AAA', '06:30 Z / 08:30 L', '', '', '', '', ''],
    ['7 Apr 24', 'XX7672', 'FGABC', 'AAA', '07:46 Z / 09:46 L', '10:31 Z / 11:31 L', 'BBB', '73H', '[Pilot - SMA - SMITH Ann]', '[Block: 02:45]'],
    ['7 Apr 24', 'C/O', '', '', '', '11:01 Z / 13:01 L', 'BBB', '', '', '[Block: 2:45] [FDP: 4:00] [Max FDP: 12:30] [Duty: 4:31]'],
    ['7 Apr 24', 'HT', '', 'BBB', '', '', '', '', '', 'Hotel One'],
    ['8 Apr 24', 'OFF', '', '', '22:00 Z', '', '', '', '', '[OFF: JOUR OFF]'],
  ]);
});

test('KLM CREW ROSTER FROM .. UPTO ..: day activities, a leg landing the next day ("-->"), DBRF as C/O on the duty date, local times', () => {
  const row = (y, cells) => cells.map(([text, x]) => iw(text, x, y, text.length * 4));
  const items = [
    ...row(51, [['CREW ROSTER FROM 17FEB2025 UPTO 17MAR2025', 177]]), ...row(74, [['All Times In :', 386], ['Local', 450]]),
    ...row(242, [['Date', 14], ['Activity', 56], ['RPT', 134], ['DBRF', 158], ['Departure', 182], ['Arrival', 230], ['A/C', 278], ['OP', 302], ['Comp', 320], ['Status', 344],
      ['Fly', 368], ['Duty', 398], ['Total Flying', 422], ['Total Duty', 470]]),
    ...row(250, [['TIME', 134], ['TIME', 158], ['Type', 278], ['RNK', 302], ['/SDC', 344], ['Hrs', 368], ['Hrs', 398]]),
    ...row(261, [['Mon 17-Feb', 14], ['Reisverlof', 56]]),
    ...row(275, [['Tue 18-Feb', 14], ['Standby thuis', 56], ['07:00', 134], ['19:00', 158], ['03:00', 398]]),
    ...row(332, [['Sat 22-Feb', 14], ['XX879', 56], ['09:35', 134], ['AAA', 182], ['10:50', 206], ['LT+', 344]]),
    ...row(346, [['Sun 23-Feb', 14], ['-->', 56], ['10:10', 158], ['BBB', 230], ['00:40', 254], ['781', 280], ['09:20', 368], ['11:05', 398], ['09:20', 434]]),
  ];
  const r = parseNetlinePdf([{ page: 1, width: 595, height: 842, items }]);
  assert.equal(r.format, 'klm-crew-roster');
  assert.equal(r.period, '17Feb25 - 17Mar25');
  assert.deepEqual(r.published.map(x => [x.date, x.duty, x.dep, x.begin, x.end, x.arr, x.ac, x.info]), [
    ['17 Feb 25', 'Reisverlof', '', '', '', '', '', ''],
    ['18 Feb 25', 'Standby thuis', '', '07:00 L', '19:00 L', '', '', '[Duty: 03:00]'],
    ['22 Feb 25', 'C/I', 'AAA', '09:35 L', '', '', '', ''],
    ['22 Feb 25', 'XX879', 'AAA', '10:50 L', '00:40 L +1', 'BBB', '781', '[Block: 09:20] [SDC: LT+]'],
    ['22 Feb 25', 'C/O', '', '', '10:10 L +1', 'BBB', '', '[Duty: 11:05]'],
  ]);
});

test('JAA PILOT LOGBOOK: flights with landings, IFR and function times, the PIC as crew, remarks; a simulator session', () => {
  const row = (y, cells) => cells.map(([text, x]) => iw(text, x, y, text.length * 4));
  const items = [
    ...row(12, [['JAA PILOT LOGBOOK', 543]]), ...row(67, [['Report Date 31/05/2009 19:24', 23], ['Period', 600], ['01/05/2009', 644], ['- 31/05/2009', 706]]),
    ...row(99, [['Date', 26], ['Departure', 57], ['Arrival', 111], ['Aircraft', 178], ['Multi-', 248], ['Name PIC', 305], ['Landings', 375], ['Operational C. T.', 414],
      ['Pilot Function Time', 478], ['Synthetic Training Dev. Ses.', 544], ['Remarks and endorsements', 656], ['LVIS', 763]]),
    ...row(106.5, [['Pilot Time', 237]]),
    ...row(108, [['Place', 50], ['Time', 73], ['Place', 97], ['Time', 121], ['Make, Model, Var.', 150], ['Reg.', 208], ['Day', 375], ['Ngt', 389], ['Night', 414], ['IFR', 447],
      ['PIC', 481], ['Instructor', 504], ['Date', 542], ['Type', 571], ['Total', 606]]),
    ...row(117, [['01/05/09', 22], ['AAA', 50], ['04:40', 72], ['BBB', 97], ['06:05', 115], ['734', 148], ['OOABC', 202], ['1:25', 246], ['SMITH, ANN', 292], ['1', 378], ['0', 393],
      ['0:00', 415], ['1:25', 446], ['1:25', 481], ['(CPT) + (FO)DOE,', 656]]),
    ...row(126, [['07/05/09', 542], ['737_SIM', 571], ['4:00', 606]]),
    ...row(135, [['subtotal / 734', 148], ['1:25', 246]]),
  ];
  const r = parseNetlinePdf([{ page: 1, width: 792, height: 612, items }]);
  assert.equal(r.format, 'jaa-logbook');
  assert.equal(r.period, '01May09 - 31May09');
  assert.deepEqual(r.published.map(x => [x.date, x.duty, x.dep, x.begin, x.end, x.arr, x.ac, x.registration, x.crew, x.info]), [
    ['1 May 09', '', 'AAA', '04:40 Z', '06:05 Z', 'BBB', '734', 'OOABC', '[PIC - SMITH, ANN]', '[Flight: 1:25] [Landing Day: 1] [IFR: 1:25] [PIC: 1:25] (CPT) + (FO)DOE,'],
    ['7 May 09', 'SIM', '', '', '', '', '737_SIM', '', '', '[Sim: 4:00]'],
  ]);
});

test('Brussels Airlines roster: flights with crew lists (" = the same), remarks, an activity begun the evening before, stop over (its times, layover), Rest until', () => {
  const row = (y, cells) => cells.map(([text, x, dy = 0]) => iw(text, x, y + dy, text.length * 4));
  const items = [
    ...row(21, [['Roster : 13JUL2024', 374], ['31AUG2024', 489], ['-', 481]]),
    ...row(112, [['Sched. times', 86], ['Description', 151], ['Rest until (real)', 495]]),
    ...row(134, [['SUN', 24], ['14', 45], ['TRI', 64, 1.6], ['08:30-11:05', 84, 1.6], ['XX3811', 144], ['AAA-BBB', 207], ['(FO)X.DOE', 245], ['(PU)K.ROE', 317], ['*15JUL 05:45', 485]]),
    ...row(145, [['(CCM)A.SMITH', 144]]),
    ...row(156, [['CGW', 144], ['-', 163], ['NO', 173], ['Recup', 187]]),
    ...row(176, [['TRI', 64], ['11:55-14:15', 84], ['XX3812', 144], ['BBB-AAA', 207], ['"', 245], ['*15JUL 05:45', 485]]),
    ...row(186, [['TRI', 64], ['21:20 --.--', 84], ['Stop', 144], ['over', 168], ['at', 192], ['AAA', 207], ['(Hotel', 226], ['One)', 259]]),
    ...row(240, [['MON', 24], ['15', 45], ['TRI', 64], ['--.-- 05:10', 84], ['"', 144]]),
    ...row(253, [['CPT', 64], ['22:00 --.--', 84]]),
    ...row(263, [['TUE', 24], ['16', 45], ['CPT', 64], ['--.-- 21:59', 84], ['WR/', 144], ['-', 192], ['Weekly', 211], ['Rest', 245]]),
  ];
  const r = parseNetlinePdf([{ page: 1, width: 612, height: 792, items }]);
  assert.equal(r.format, 'sn-roster');
  assert.equal(r.period, '13Jul24 - 31Aug24');
  const crew = '[FO - X.DOE][PU - K.ROE][CCM - A.SMITH]';
  assert.deepEqual(r.published.map(x => [x.date, x.duty, x.dep, x.begin, x.end, x.arr, x.crew, x.info]), [
    ['14 Jul 24', 'XX3811', 'AAA', '08:30 Z', '11:05 Z', 'BBB', crew, 'CGW - NO Recup'],
    ['14 Jul 24', 'XX3812', 'BBB', '11:55 Z', '14:15 Z', 'AAA', crew, '[Rest until: 15JUL 05:45]'],
    ['14 Jul 24', 'HT', 'AAA', '21:20 Z', '05:10 Z +1', '', '', 'Hotel One [Layover: 07:50]'],
    ['16 Jul 24', 'WR', '', '22:00 Z -1', '21:59 Z', '', '', '[WR: Weekly Rest]'],
  ]);
});

test('AIMS Individual Roster: C/I, flights, C/O, a hotel over midnight as one row, an activity ending the next day without its name', () => {
  const row = (y, cells) => cells.map(([text, x]) => iw(text, x, y, text.length * 4));
  const items = [
    ...row(25, [['Individual Roster', 258]]), ...row(50, [['CDG-CDB', 40], ['07AUG24 - 01SEP24', 267]]),
    ...row(108, [['Date', 40], ['Du,,', 94], ['Activity', 130], ['C/I', 178], ['Orig', 214], ['STD', 247], ['Dest', 280], ['STA', 334], ['C/O', 370], ['AC', 412], ['Rq', 448], ['LE', 484]]),
    ...row(124, [['08THU', 40], ['CIS', 130], ['AAA', 211], ['00:00', 247], ['AAA', 281], ['24:00', 334]]),
    ...row(318, [['22THU', 40], ['XX1562', 130], ['11:30', 180], ['AAA', 211], ['12:30', 247], ['BBB', 281], ['14:25', 334], ['E90', 412]]),
    ...row(343, [['XX1186', 130], ['BBB', 211], ['19:40', 247], ['CCC', 281], ['21:30', 334], ['21:45', 370], ['E90', 412]]),
    ...row(356, [['HTL', 130], ['CCC', 211], ['21:45', 247]]),
    ...row(370, [['23FRI', 40], ['HTL', 130], ['CCC', 281], ['05:40', 334]]),
    ...row(382, [['MPI', 130], ['06:55', 180], ['CCC', 211], ['08:25', 247]]),
    ...row(395, [['24SAT', 40], ['AAA', 281], ['16:50', 334], ['17:35', 370]]),
  ];
  const r = parseNetlinePdf([{ page: 1, width: 612, height: 792, items }]);
  assert.equal(r.format, 'aims-individual');
  assert.equal(r.period, '07Aug24 - 01Sep24');
  assert.deepEqual(r.published.map(x => [x.date, x.duty, x.dep, x.begin, x.end, x.arr, x.ac]), [
    ['8 Aug 24', 'CIS', 'AAA', '00:00 L', '24:00 L', 'AAA', ''],
    ['22 Aug 24', 'C/I', 'AAA', '11:30 L', '', '', ''],
    ['22 Aug 24', 'XX1562', 'AAA', '12:30 L', '14:25 L', 'BBB', 'E90'],
    ['22 Aug 24', 'XX1186', 'BBB', '19:40 L', '21:30 L', 'CCC', 'E90'],
    ['22 Aug 24', 'C/O', '', '', '21:45 L', 'CCC', ''],
    ['22 Aug 24', 'HTL', 'CCC', '21:45 L', '05:40 L +1', 'CCC', ''],
    ['23 Aug 24', 'C/I', 'CCC', '06:55 L', '', '', ''],
    ['23 Aug 24', 'MPI', 'CCC', '08:25 L', '16:50 L +1', 'AAA', ''],
    ['23 Aug 24', 'C/O', '', '', '17:35 L +1', 'AAA', ''],
  ]);
});

test('Lufthansa CAS Persönlicher Einsatzplan: no row for the briefing, UTC legs with DH, day activities (one with a reference, "OTX/OR XX103-P", then a SIM of its own; a SIM on the day\'s line; a leg over midnight ended on the next day\'s line); the month from "Monat :"', () => {
  const row = (y, cells) => cells.map(([text, x]) => iw(text, x, y, text.length * 4));
  const items = [
    ...row(14, [['Crew Assignment System v14.0.2.1.', 14]]),
    ...row(52, [['FEB', 457], ['2011', 483]]), ...row(55, [['Dienstplan für :', 14], ['Monat :', 428]]),
    ...row(228, [['UTC Kalender/Homebase FRA', 14], ['UTC', 165]]),
    ...row(237, [['Datum Umlauf', 14], ['Pos', 95]]),
    ...row(273, [['Di 01 101307', 14], ['CP', 106]]),
    ...row(282, [['Briefingzeit(LT AAA):', 46], ['01/02/11', 165], ['10:00', 214]]),
    ...row(291, [['YNJ1', 46], ['XX2528-1', 95], ['A320', 154], ['AAA', 187], ['10:10-13:15 BBB 03:05 03:06', 208]]),
    ...row(300, [['YNJ1', 46], ['DH', 79], ['XX2529-1', 95], ['BBB', 187], ['23:10-00:25 AAA 01:15 00:00', 208]]),
    ...row(345, [['Fr 04 MO', 14], ['08:00-17:00', 208]]),
    ...row(453, [['Mi 09 U', 14], ['-', 235]]),
    ...row(561, [['Mo 21 OTX/OR', 14], ['XX103-P', 106], ['06:00-07:10', 208]]),
    ...row(570, [['SIM', 46], ['LSW', 295]]),
    ...row(579, [['A320', 46], ['OT2OP319', 106], ['CCC', 187], ['10:05-14:05', 208], ['4', 295], ['CHOPC', 370]]),
    ...row(588, [['OTX', 46], ['XX116-P', 106], ['15:20-16:15', 208]]),
  ];
  const items2 = [
    ...row(88, [['UTC Kalender/Homebase FRA', 14], ['UTC', 165]]), ...row(97, [['Datum Umlauf', 14], ['Pos', 95]]),
    ...row(208, [['So', 14], ['23 SIM', 28], ['EBTF5A', 96], ['LSW', 264], ['BZW', 288], ['RZ', 312]]),
    ...row(216, [['A320', 43], ['OT1EB320', 96], ['CCC', 168], ['04:55-08:55', 187], ['4', 264], ['4', 288], ['12', 312], ['TTC', 331]]),
    ...row(428, [['Fr', 14], ['25 423', 28], ['XX423-1', 86], ['A330', 139], ['DDD', 168], ['22:00-', 187]]),
    ...row(436, [['Sa', 14], ['26 X', 28], ['-05:20', 211], ['CCC', 244], ['07:20', 264], ['00:00', 292]]),
  ];
  const r = parseNetlinePdf([{ page: 1, width: 850, height: 595, items }, { page: 2, width: 850, height: 595, items: items2 }]);
  assert.equal(r.format, 'lh-cas');
  assert.equal(r.period, '01Feb11 - 28Feb11');
  assert.deepEqual(r.published.map(x => [x.date, x.dc, x.duty, x.dep, x.begin, x.end, x.arr, x.ac, x.info]), [
    ['1 Feb 11', '', 'XX2528', 'AAA', '10:10 Z', '13:15 Z', 'BBB', 'A320', '[Block: 03:05]'],
    ['1 Feb 11', 'DH', 'XX2529', 'BBB', '23:10 Z', '00:25 Z +1', 'AAA', '', '[Block: 01:15]'],
    ['4 Feb 11', '', 'MO', '', '08:00 Z', '17:00 Z', '', '', ''],
    ['9 Feb 11', '', 'U', '', '', '', '', '', ''],
    ['21 Feb 11', '', 'OTX/OR', '', '06:00 Z', '07:10 Z', '', '', '[XX103-P]'],
    ['21 Feb 11', '', 'SIM', 'CCC', '10:05 Z', '14:05 Z', '', 'A320', '[Sim: OT2OP319 CHOPC]'],
    ['21 Feb 11', '', 'OTX', '', '15:20 Z', '16:15 Z', '', '', '[XX116-P]'],
    ['23 Feb 11', '', 'SIM', 'CCC', '04:55 Z', '08:55 Z', '', 'A320', '[Sim: EBTF5A OT1EB320 TTC]'],
    ['25 Feb 11', '', 'XX423', 'DDD', '22:00 Z', '05:20 Z +1', 'CCC', 'A330', '[Block: 07:20]'],
    ['26 Feb 11', '', 'X', 'CCC', '', '', '', '', ''],
  ]);
});

test('merlot.aero Employee Roster Report (Allegiant): a day off, a duty block with its sectors above and below the date, decimal hours', () => {
  const row = (y, cells) => cells.map(([text, x]) => iw(text, x, y, text.length * 4));
  const items = [
    ...row(51, [['Allegiant Air', 50]]), ...row(58, [['merlot.aero-Employee Roster Report', 50]]), ...row(87, [['1/Oct/2024 to 31/Oct/2024', 358]]),
    ...row(113, [['Day', 61], ['Date', 92], ['Duty', 121], ['Property', 148], ['From', 180], ['Report', 202], ['To', 228], ['Release', 242], ['Duty Time', 354],
      ['TAFB Time', 393], ['Sector(s)/Event(s)', 467], ['Allowances', 531]]),
    ...row(129, [['01-Oct', 88]]), ...row(133, [['Tue', 51], ['X-1', 115], ['AAA', 180]]),
    ...row(169, [['951 AAA 14:24 L BBB', 460]]),
    ...row(176, [['03-Oct', 88], ['G30084P-', 115], ['13:24', 202], ['16:49 L', 460]]),
    ...row(179, [['Thu', 51], ['AAA', 180], ['20:18', 242], ['L', 258], ['4.82', 271], ['4.82', 317], ['6.90', 352], ['6.90', 391], ['17.80', 431]]),
    ...row(183, [['1', 115], ['2502 BBB 17:39 L AAA', 460]]), ...row(190, [['20:03 L', 460]]),
  ];
  const r = parseNetlinePdf([{ page: 1, width: 612, height: 792, items }]);
  assert.equal(r.format, 'allegiant-roster');
  assert.equal(r.period, '01Oct24 - 31Oct24');
  assert.deepEqual(r.published.map(x => [x.date, x.duty, x.dep, x.begin, x.end, x.arr, x.info]), [
    ['1 Oct 24', 'X-1', 'AAA', '', '', '', ''],
    ['3 Oct 24', 'C/I', 'AAA', '13:24 L', '', '', '[Trip: G30084P-1]'],
    ['3 Oct 24', '951', 'AAA', '14:24 L', '16:49 L', 'BBB', ''],
    ['3 Oct 24', '2502', 'BBB', '17:39 L', '20:03 L', 'AAA', ''],
    ['3 Oct 24', 'C/O', '', '', '20:18 L', 'AAA', '[Block: 04:49] [Duty: 06:54] [TAFB: 06:54] [Rest: 17:48]'],
  ]);
});

test('Air NZ Published Roster (box table): day off, duty with C/I, flights, C/O and hotel, a deadhead, a flight landing on a later line, crew', () => {
  const lines = [
    'Name :DOE JOHN ( 1 )                           Published Roster: 08/2024                Printed on 05-Jul-24 16:01',
    '│NZ        │LOCAL     │        │        │     │       │HOTEL  │         │    │    │FLIGHT│DUTY │O/N │UTC   │   │NOTES/          │',
    '│DATE      │DATE      │DUTY    │ACTIVITY│ROLE │SECTOR │PICKUP │REP/FIN  │ETD │ETA │TIME  │TIME │CITY│DEV   │DEA│TRAINING        │',
    '│Mon-15Jul │Mon-15Jul │        │MOF     │     │       │       │0000/2359│    │    │      │     │    │      │   │                │',
    '│Tue-16Jul │Tue-16Jul │MEL5194 │ NZ253  │ F/O │AAA BBB│       │0500/    │0600│0805│ 4:05 │     │    │      │   │I-X1:Line Trg   │',
    '│          │          │        │        │     │       │       │    /    │    │    │      │     │    │      │   │. Crw SMITH (2) │',
    '│          │          │        │ NZ264  │ F/O │BBB CCC│       │    /1500│0915│1430│ 3:15 │10:00│CCC │+12   │ 2 │HTL:GRAND HOTEL │',
    '│Wed-17Jul │Wed-17Jul │        │IFSR    │     │       │ 0540  │0600/    │    │    │      │     │    │      │   │                │',
    '│          │          │        │TVNZ642 │ 32A │CCC AAA│       │    /    │0700│0755│ 0:55 │     │    │      │   │                │',
    '│          │          │        │M       │     │       │       │    /    │    │    │      │     │    │      │   │                │',
    '│          │          │        │  NZ65  │ F/O │AAA    │       │    /    │2350│    │      │     │    │      │   │                │',
    '│Thu-18Jul │Thu-18Jul │        │        │     │    DDD│       │    /0600│    │0530│ 5:40 │9:10 │    │      │   │                │',
    'Additional Crew On Flight:',
    '16-JUL  NZ-0253       (T) ANN SMITH (2), BOB LEE (3)',
  ];
  const items = lines.map((text, k) => iw(text, 20, 40 + k * 7, text.length * 3.6));
  const r = parseNetlinePdf([{ page: 1, width: 595, height: 842, items }]);
  assert.equal(r.format, 'nz-published-roster');
  assert.equal(r.period, '15Jul24 - 18Jul24');
  assert.deepEqual(r.published.map(x => [x.date, x.dc, x.duty, x.dep, x.begin, x.end, x.arr, x.ac, x.crew, x.info]), [
    ['15 Jul 24', '', 'MOF', '', '00:00 L', '23:59 L', '', '', '', ''],
    ['16 Jul 24', '', 'C/I', 'AAA', '05:00 L', '', '', '', '', '[Trip: MEL5194]'],
    ['16 Jul 24', '', 'NZ253', 'AAA', '06:00 L', '08:05 L', 'BBB', '', '[T - 2 - ANN SMITH][3 - BOB LEE]', '[Block: 04:05] I-X1:Line Trg. Crw SMITH (2)'],
    ['16 Jul 24', '', 'NZ264', 'BBB', '09:15 L', '14:30 L', 'CCC', '', '', '[Block: 03:15]'],
    ['16 Jul 24', '', 'C/O', '', '', '15:00 L', 'CCC', '', '', '[Duty: 10:00]'],
    ['16 Jul 24', '', 'HT', 'CCC', '', '', '', '', '', 'GRAND HOTEL'],
    ['17 Jul 24', '', 'C/I', 'CCC', '06:00 L', '', '', '', '', '[Pickup: 05:40]'],
    ['17 Jul 24', 'DH', 'NZ642', 'CCC', '07:00 L', '07:55 L', 'AAA', '32A', '', '[Block: 00:55]'],
    ['17 Jul 24', '', 'NZ65', 'AAA', '23:50 L', '05:30 L +1', 'DDD', '', '', '[Block: 05:40]'],
    ['18 Jul 24', '', 'C/O', '', '', '06:00 L', 'DDD', '', '', '[Duty: 09:10]'],
  ]);
});

test('activity list on two lines: times under the dates, Night/Total Time, Prefix, wrapped crew "NAME - ROLE,", a Checkout per leg: only the last leg\'s is the C/O', () => {
  const row = (y, cells) => cells.map(([text, x]) => iw(text, x, y, text.length * 4));
  const items = [
    ...row(35, [['Activity', 15], ['Checkin', 76], ['Start', 164], ['Dep', 223], ['Arr', 258], ['End', 312], ['Checkout', 379], ['Daytime', 447],
      ['Night', 504], ['Total', 557], ['AcVer', 599], ['Prefix', 639], ['DD', 681], ['CAT', 708], ['Crew', 737], ['System', 800]]),
    ...row(48, [['Time', 505], ['Time', 556]]),
    ...row(66, [['FR', 15], ['-', 60], ['15/02/2013,', 140], ['VCP', 221], ['VCP', 253], ['16/02/2013,', 286], ['16/02/2013,', 366], ['00:00', 447], ['00:00', 495], ['00:00', 548], ['-', 599], ['FO', 708], ['-', 737], ['CREW', 790]]),
    ...row(77, [['23:00:00', 140], ['23:00:00', 286], ['23:30:00', 366], ['CONTROL', 790]]),
    ...row(94, [['AD4241', 15], ['22/02/2013,', 60], ['22/02/2013', 140], ['VCP', 221], ['GIG', 253], ['22/02/2013', 286], ['22/02/2013,', 366], ['00:56', 447], ['00:00', 495], ['00:56', 548], ['E90', 599], ['PR-', 637], ['FO', 708], ['ANN DOE -', 737], ['CREW', 790]]),
    ...row(105, [['08:52:00', 60], ['09:51:00', 140], ['10:47:00', 286], ['11:17:00', 366], ['AZD', 637], ['FA,BOB', 737], ['CONTROL', 790]]),
    ...row(114, [['LEE - CA', 737]]),
    ...row(130, [['AD4263', 15], ['-', 60], ['22/02/2013', 140], ['GIG', 221], ['VCP', 253], ['22/02/2013', 286], ['22/02/2013,', 366], ['00:40', 447], ['00:30', 495], ['01:10', 548], ['E90', 599], ['PR-', 637], ['FO', 708], ['-', 737], ['CREW', 790]]),
    ...row(141, [['11:36:00', 140], ['12:46:00', 286], ['13:16:00', 366], ['AZD', 637], ['CONTROL', 790]]),
  ];
  const r = parseNetlinePdf([{ page: 1, width: 842, height: 595, items }]);
  assert.equal(r.format, 'activity-list');
  assert.deepEqual(r.published.map(x => [x.date, x.duty, x.dep, x.begin, x.end, x.arr, x.ac, x.registration, x.crew, x.info]), [
    ['15 Feb 13', 'FR', 'VCP', '23:00 Z', '23:00 Z +1', 'VCP', '', '', '', ''],
    ['22 Feb 13', 'C/I', 'VCP', '08:52 Z', '', '', '', '', '', ''],
    ['22 Feb 13', 'AD4241', 'VCP', '09:51 Z', '10:47 Z', 'GIG', 'E90', 'PR-AZD', '[FA - ANN DOE][CA - BOB LEE]', '[Block: 00:56]'],
    ['22 Feb 13', 'AD4263', 'GIG', '11:36 Z', '12:46 Z', 'VCP', 'E90', 'PR-AZD', '', '[Block: 01:10] [Night: 00:30]'],
    ['22 Feb 13', 'C/O', '', '', '13:16 Z', 'VCP', '', '', '', ''],
  ]);
});

test('"All times in UTC" pilot roster: days in the middle of their lines, wrapped aircraft and crew, a flight over midnight, standby, off', () => {
  const row = (y, cells) => cells.map(([text, x]) => iw(text, x, y, text.length * 4));
  const items = [
    ...row(14, [['All times in UTC', 29]]), ...row(66, [['14-10-2025', 516]]), ...row(109, [['MONTH', 66], ['OCTOBER', 191], ['YEAR', 324], ['2025', 470]]),
    ...row(145, [['Aircraft', 81], ['Check', 127], ['Check', 277], ['Home', 447]]),
    ...row(149, [['Day', 42], ['Description', 190], ['Function', 310], ['Crew', 369], ['Block', 410], ['Pilot note', 503]]),
    ...row(174, [['AAA-BBB /', 367]]), ...row(178, [['A320 D-', 84]]),
    ...row(182, [['09:35', 128], ['XX134', 159], ['10:45', 170], ['AAA', 203], ['BBB', 235], ['14:40', 265], ['CPT', 329], ['CCC-', 366], ['03:55', 416], ['AAA', 452]]),
    ...row(185, [['ABCD', 87]]), ...row(189, [['DDD', 369]]),
    ...row(194, [['15 Oct', 39]]), ...row(202, [['Wed', 42]]),
    ...row(215, [['XX135', 159], ['15:40', 170], ['BBB', 204], ['CCC', 235], ['23:00', 265], ['CPT', 329], ['04:20', 416], ['AAA', 452]]),
    ...row(241, [['16 Oct', 39]]), ...row(245, [['CCC', 235]]), ...row(248, [['Thu', 44]]),
    ...row(275, [['XX136', 159], ['23:40', 170], ['CCC', 204], ['CPT', 329], ['AAA', 452]]), ...row(275, [['17 Oct Fri', 33]]),
    ...row(308, [['AAA', 235], ['03:40', 265], ['04:10', 294], ['CPT', 329], ['04:00', 416], ['AAA', 452]]),
    ...row(317, [['18 Oct', 39]]), ...row(334, [['08:30', 128], ['STANDBY', 155], ['08:30', 202], ['AAA', 235], ['14:00', 265], ['14:00', 294]]), ...row(325, [['Sat', 44]]),
    ...row(360, [['19 Oct', 39]]), ...row(364, [['OFF', 181], ['AAA', 235]]), ...row(368, [['Sun', 44]]),
  ];
  const r = parseNetlinePdf([{ page: 1, width: 595, height: 842, items }]);
  assert.equal(r.format, 'utc-pilot-roster');
  assert.equal(r.period, '15Oct25 - 19Oct25');
  assert.deepEqual(r.published.map(x => [x.date, x.duty, x.dep, x.begin, x.end, x.arr, x.ac, x.registration, x.crew, x.info]), [
    ['15 Oct 25', 'C/I', 'AAA', '09:35 Z', '', '', '', '', '', ''],
    ['15 Oct 25', 'XX134', 'AAA', '10:45 Z', '14:40 Z', 'BBB', 'A320', 'D-ABCD', 'AAA-BBB / CCC-DDD', '[Block: 03:55]'],
    ['15 Oct 25', 'XX135', 'BBB', '15:40 Z', '23:00 Z', 'CCC', '', '', '', '[Block: 04:20]'],
    ['17 Oct 25', 'XX136', 'CCC', '23:40 Z', '03:40 Z +1', 'AAA', '', '', '', '[Block: 04:00]'],
    ['18 Oct 25', 'C/O', '', '', '04:10 Z', 'AAA', '', '', '', ''],
    ['18 Oct 25', 'STANDBY', 'AAA', '08:30 Z', '14:00 Z', '', '', '', '', ''],
    ['19 Oct 25', 'OFF', 'AAA', '', '', '', '', '', '', ''],
  ]);
});

test('Current Roster Report (Jeppesen): "JUL 24WED" dates, a flight over midnight, a hotel a column right, crew and hotel name from the lists below', () => {
  const row = (y, cells) => cells.map(([text, x]) => iw(text, x, y, text.length * 4));
  const items = [
    ...row(34, [['Current Roster Report', 44]]), ...row(53, [['Planning Period:', 44], ['28JUN2024-11SEP2024', 114]]),
    ...row(141, [['Date', 48], ['DD', 143], ['Activity', 185], ['C/I', 242], ['Orig', 270], ['STD', 297], ['Dest', 326], ['STA', 355], ['C/O', 383], ['Rq', 412], ['BLC', 433], ['BLH', 459]]),
    ...row(152, [['JUL 20SAT', 48], ['DMR', 185], ['00:00', 433], ['00:00', 459]]),
    ...row(219, [['JUL 26FRI', 48], ['XX202', 185], ['13:48', 242], ['AAA', 270], ['14:48', 297], ['BBB', 326], ['15:27', 355], ['01:39', 433], ['01:39', 459]]),
    ...row(238, [['XX702', 185], ['BBB', 270], ['20:01', 297]]),
    ...row(248, [['JUL 27SAT', 48], ['XX702', 185], ['CCC', 326], ['01:05', 355], ['01:35', 383], ['04:04', 433], ['04:04', 459]]),
    ...row(258, [['HTL', 185], ['CCC', 297], ['01:35', 326]]),
    ...row(267, [['JUL 28SUN', 48], ['HTL', 185], ['CCC', 355], ['01:25', 383]]),
    ...row(304, [['Crew Onboard', 48]]),
    ...row(318, [['Jul 26Fri XX202 FA: P.ANN CP: J.DOE FO: M.PONCE DE LEON', 48]]),
    ...row(413, [['Hotel information', 48]]), ...row(426, [['Arrival', 48], ['Departure', 143], ['Name', 185]]),
    ...row(436, [['27Jul24', 48], ['28Jul24', 143], ['Grand Hotel', 185]]),
  ];
  const r = parseNetlinePdf([{ page: 1, width: 595, height: 842, items }]);
  assert.equal(r.format, 'aims-individual');
  assert.equal(r.period, '28Jun24 - 11Sep24');
  assert.deepEqual(r.published.map(x => [x.date, x.duty, x.dep, x.begin, x.end, x.arr, x.crew, x.info]), [
    ['20 Jul 24', 'DMR', '', '', '', '', '', ''],
    ['26 Jul 24', 'C/I', 'AAA', '13:48 L', '', '', '', ''],
    ['26 Jul 24', 'XX202', 'AAA', '14:48 L', '15:27 L', 'BBB', '[FA - P.ANN][CP - J.DOE][FO - M.PONCE DE LEON]', '[Block: 01:39]'],
    ['26 Jul 24', 'XX702', 'BBB', '20:01 L', '01:05 L +1', 'CCC', '', '[Block: 04:04]'],
    ['26 Jul 24', 'C/O', '', '', '01:35 L +1', 'CCC', '', ''],
    ['27 Jul 24', 'HTL', 'CCC', '01:35 L', '01:25 L +1', 'CCC', '', 'Grand Hotel'],
  ]);
});

test('Sabre Individual Roster: "Crew onboard" (ISO dates, a flight twice a day), "Day notes", "Hotel information" and "Information" go to crew and info; the hotel printed again the next day is one night', () => {
  const row = (y, cells) => cells.map(([text, x]) => iw(text, x, y, text.length * 4));
  const head = (y) => row(y, [['Date', 37], ['DD', 69], ['Activity', 101], ['C/I', 147], ['Orig', 170], ['STD', 196], ['Dest', 223], ['STA', 249], ['C/O', 281], ['AC', 307], ['FDP', 458]]);
  const p1 = [
    ...row(28, [['Individual Roster', 260]]), ...row(59, [['AAA-OPL', 37], ['01FEB2021 - 28FEB2021', 261], ['UTC', 553]]), ...head(112),
    ...row(131, [['01MON', 37], ['JL', 101], ['AAA', 170], ['00:00', 196], ['AAA', 222], ['24:00', 249]]),
    ...row(146, [['02TUE', 37], ['XX776', 101], ['14:15', 147], ['AAA', 170], ['15:08', 196], ['BBB', 222], ['16:50', 249], ['32N', 307]]),
    ...row(157, [['XX776', 101], ['BBB', 170], ['17:59', 196], ['CCC', 222], ['19:29', 249], ['32N', 307]]),
    ...row(169, [['HOT', 101], ['CCC', 170], ['20:15', 196], ['CCC', 222], ['10:50', 249], ['5:14', 458]]),
    ...row(184, [['03WED', 37], ['HOT', 101], ['CCC', 170], ['20:15', 196], ['CCC', 222], ['10:50', 249]]),
    ...row(196, [['C', 69], ['XX777', 101], ['10:50', 147], ['CCC', 170], ['11:42', 196], ['AAA', 222], ['13:22', 249], ['13:42', 281], ['32N', 307], ['2:52', 458]]),
  ];
  const p2 = [
    ...row(28, [['Individual Roster', 260]]), ...row(59, [['AAA-OPL', 37], ['01FEB2021 - 28FEB2021', 261], ['UTC', 553]]), ...head(112),
    ...row(144, [['Crew onboard', 43]]),
    ...row(155, [['2021-02-02 XX776 CDB:AAB CC:AAC HST:AAD', 43]]),
    ...row(164, [['2021-02-02 XX776 CDB:AAB CC:AAC HST:AAE CDB:AAF(S)', 43]]),
    ...row(174, [['2021-02-03 XX777 CDB:AAB CC:AAC', 43]]),
    ...row(190, [['Day notes', 43]]), ...row(201, [['2021-02-03 cel', 43]]),
    ...row(217, [['Hotel information', 43]]), ...row(228, [['02FEB21 - 03FEB21 HOTEL ONE CCC', 43]]),
    ...row(254, [['Document expire', 43]]), ...row(265, [['CEL: CONTROLE EN LIGNE 30JUN21', 43]]),
    ...row(653, [['Information', 43]]), ...row(664, [['JL = JOUR LIBRE', 43]]), ...row(673, [['HOT = Hôtel', 43]]), ...row(683, [['C = élève instruction vol', 43]]),
  ];
  const r = parseNetlinePdf([{ page: 1, width: 595, height: 842, items: p1 }, { page: 2, width: 595, height: 842, items: p2 }]);
  assert.equal(r.format, 'aims-individual');
  assert.deepEqual(r.published.map(x => [x.date, x.dc, x.duty, x.dep, x.begin, x.end, x.arr, x.crew, x.info]), [
    ['1 Feb 21', '', 'JL', 'AAA', '00:00 Z', '24:00 Z', 'AAA', '', '[JL: JOUR LIBRE]'],
    ['2 Feb 21', '', 'C/I', 'AAA', '14:15 Z', '', '', '', ''],
    ['2 Feb 21', '', 'XX776', 'AAA', '15:08 Z', '16:50 Z', 'BBB', '[CDB - AAB][CC - AAC][HST - AAD]', ''],
    ['2 Feb 21', '', 'XX776', 'BBB', '17:59 Z', '19:29 Z', 'CCC', '[CDB - AAB][CC - AAC][HST - AAE][CDB - AAF(S)]', ''],
    ['2 Feb 21', '', 'HOT', 'CCC', '20:15 Z', '10:50 Z +1', 'CCC', '', 'HOTEL ONE CCC [HOT: Hôtel]'],
    ['3 Feb 21', '', 'C/I', 'CCC', '10:50 Z', '', '', '', ''],
    ['3 Feb 21', 'C', 'XX777', 'CCC', '11:42 Z', '13:22 Z', 'AAA', '[CDB - AAB][CC - AAC]', '[C: élève instruction vol] [Memo: cel]'],
    ['3 Feb 21', '', 'C/O', '', '', '13:42 Z', 'AAA', '', '[FDP: 2:52]'],
  ]);
});

test('Performed Activities (Sleipner): C/I, actual times, crew line, C/O with duty, "+" next day, two cells in one item', () => {
  const row = (y, cells) => cells.map(([text, x]) => iw(text, x, y, text.length * 4));
  const items = [
    ...row(34, [['Performed Activities', 224]]), ...row(63, [['(24NOV24 - 25NOV24)', 270]]), ...row(96, [['TimeMode UTC', 30]]),
    ...row(141, [['BlockOff', 489], ['BlockOn', 528]]),
    ...row(145, [['Date', 30], ['Des.', 81], ['Code', 103], ['LE', 137], ['Type', 154], ['Registration', 182], ['Dep', 222], ['Arr', 251], ['CI', 273], ['STD', 302],
      ['ATD', 330], ['STA', 358], ['ATA', 387], ['CO', 421], ['BLH', 449]]),
    ...row(158, [['24Nov24', 30], ['LM161', 103], ['ATR', 154], ['GABCD', 183], ['AAA', 222], ['BBB', 251], ['0840', 273], ['0940', 302], ['0937', 330], ['1045', 358], ['1042', 387], ['1100', 421], ['01:05', 449], ['24NOV', 489], ['24NOV', 528]]),
    ...row(167, [['0937', 489], ['1042', 528]]),
    ...row(177, [['Crew: CAP: DOE, Ann, FO(X): LEE, Bob', 109]]),
    ...row(186, [['TD', 81], ['POS', 103], ['BBB', 222], ['CCC 1400', 251], ['1430', 302], ['1810', 358]]),
    ...row(197, [['HTL', 103], ['CCC', 222], ['CCC', 251], ['0000', 273], ['1900', 302], ['1000+', 358]]),
  ];
  const r = parseNetlinePdf([{ page: 1, width: 595, height: 842, items }]);
  assert.equal(r.format, 'performed-activities');
  assert.equal(r.period, '24Nov24 - 25Nov24');
  assert.deepEqual(r.published.map(x => [x.date, x.duty, x.dep, x.begin, x.end, x.arr, x.ac, x.registration, x.crew, x.info]), [
    ['24 Nov 24', 'C/I', 'AAA', '08:40 Z', '', '', '', '', '', ''],
    ['24 Nov 24', 'LM161', 'AAA', '09:37 Z', '10:42 Z', 'BBB', 'ATR', 'GABCD', '[CAP - DOE, Ann][FO(X) - LEE, Bob]', '[Block: 01:05]'],
    ['24 Nov 24', 'C/O', '', '', '11:00 Z', 'BBB', '', '', '', ''],
    ['24 Nov 24', 'C/I', 'BBB', '14:00 Z', '', '', '', '', '', ''],
    ['24 Nov 24', 'POS', 'BBB', '14:30 Z', '18:10 Z', 'CCC', '', '', '', ''],
    ['24 Nov 24', 'HTL', 'CCC', '19:00 Z', '10:00 Z +1', 'CCC', '', '', '', ''],
  ]);
});

test('Sleipner "Roster" (local time): "01 Thu" dates, values left of their headers, a C/O the next day, crew going on a line', () => {
  const row = (y, cells) => cells.map(([text, x]) => iw(text, x, y, text.length * 4));
  const items = [
    ...row(34, [['Roster', 281]]), ...row(63, [['(01AUG24 - 31AUG24)', 270]]), ...row(96, [['TimeMode Local time', 30]]),
    ...row(145, [['Date', 30], ['Des.', 78], ['Code', 100], ['Req', 139], ['LE', 160], ['CI', 177], ['Dep', 194], ['STD', 217], ['Arr', 239], ['STA', 262], ['CO', 285],
      ['AC', 307], ['WA', 330], ['Func', 353], ['Rank', 381]]),
    ...row(158, [['01 Thu', 30], ['VAC', 93], ['0000', 174], ['AAA', 194], ['0000', 217], ['AAA', 239], ['2359', 262], ['CA', 381]]),
    ...row(300, [['13 Tue', 30], ['F8441', 93], ['J', 130], ['2015', 174], ['AAA', 194], ['2115', 217], ['BBB', 239], ['2310', 262], ['7M8', 307], ['CA', 381], ['04:45', 404]]),
    ...row(314, [['BKD', 77], ['F8440', 93], ['J', 130], ['0000', 174], ['BBB', 194], ['2355', 217], ['AAA', 239], ['0705', 262], ['0710', 285], ['7M8', 307], ['CA', 381]]),
    ...row(326, [['Crew: CA: Doe, Ann , FO(GP5): Lee, Bob, CC:', 103]]), ...row(332, [['Roe, Cy', 103]]),
  ];
  const r = parseNetlinePdf([{ page: 1, width: 595, height: 842, items }]);
  assert.equal(r.format, 'performed-activities');
  assert.deepEqual(r.published.map(x => [x.date, x.duty, x.dep, x.begin, x.end, x.arr, x.ac, x.crew]), [
    ['1 Aug 24', 'VAC', 'AAA', '00:00 L', '23:59 L', 'AAA', '', ''],
    ['13 Aug 24', 'C/I', 'AAA', '20:15 L', '', '', '', ''],
    ['13 Aug 24', 'F8441', 'AAA', '21:15 L', '23:10 L', 'BBB', '7M8', ''],
    ['13 Aug 24', 'F8440', 'BBB', '23:55 L', '07:05 L +1', 'AAA', '7M8', '[CA - Doe, Ann][FO(GP5) - Lee, Bob][CC - Roe, Cy]'],
    ['13 Aug 24', 'C/O', '', '', '07:10 L +1', 'AAA', '', ''],
  ]);
});

test('KLM Chronologisch overzicht, older print: "T/M" period, a joined header word, the date over the flight, VC column, codes without a dash', () => {
  const row = (y, cells) => cells.map(([text, x]) => iw(text, x, y, text.length * 4));
  const items = [
    ...row(26, [['SPL/NK Datum: 02-01-13 08:51', 28], ['Chronologisch overzicht', 250], ['01-11-12', 445], ['T/M', 493], ['30-11-12', 513]]),
    ...row(65, [['AANM', 119], ['VERT', 155], ['CMC', 294], ['AFML', 450], ['WC', 487]]),
    ...row(75, [['DG', 28], ['LIJNNR', 49], ['ACREG', 83], ['TIJD', 122], ['TIJD', 157], ['VST', 188], ['TIJDV', 215], ['F', 251], ['VC', 270], ['AST', 295], ['SDC', 326],
      ['TIJDV', 352], ['AANK TIJD', 393], ['TIJD', 453], ['VLGU', 483], ['VLGU', 516], ['VDT', 549]]),
    ...row(86, [['01', 29], ['20121101', 43], ['JV', 292], ['Vakantie', 355]]),
    ...row(140, [['05', 29], ['2012110505112012/F', 43], ['KL 0569', 51], ['PHAKD', 86], ['08:00', 125], ['569-02I/0', 137], ['09:15', 159], ['AAA', 188], ['+1', 236], ['CP', 248], ['0', 286], ['BBB', 293], ['+3', 356], ['17:52', 397], ['08:37', 492]]),
    ...row(151, [['05', 29], ['KL 0569', 51], ['PHAKD', 86], ['18:37', 159], ['BBB', 188], ['+3', 236], ['CP', 248], ['0', 286], ['CCC', 293], ['+3', 356], ['19:39', 397], ['20:09', 459], ['01:02', 492], ['12:09', 550]]),
  ];
  const r = parseNetlinePdf([{ page: 1, width: 841, height: 595, items }]);
  assert.equal(r.format, 'klm-flight-hours');
  assert.equal(r.period, '01Nov12 - 30Nov12');
  assert.deepEqual(r.published.map(x => [x.date, x.duty, x.dep, x.begin, x.end, x.arr, x.registration, x.info]), [
    ['1 Nov 12', 'JV', '', '', '', '', '', '[JV: Vakantie]'],
    ['5 Nov 12', 'C/I', 'AAA', '08:00 Z', '', '', '', ''],
    ['5 Nov 12', 'KL 0569', 'AAA', '09:15 Z', '17:52 Z', 'BBB', 'PHAKD', '[Block: 08:37]'],
    ['5 Nov 12', 'KL 0569', 'BBB', '18:37 Z', '19:39 Z', 'CCC', 'PHAKD', '[Block: 01:02]'],
    ['5 Nov 12', 'C/O', '', '', '20:09 Z', 'CCC', '', '[Duty: 12:09]'],
  ]);
});

test('Activity / Flight Details: "C/" + "I(L)" headers, local times only, a Hotel activity with its name over two lines; Z and L columns', () => {
  const row = (y, cells) => cells.map(([text, x]) => iw(text, x, y, text.length * 4));
  const local = [
    ...row(40, [['Activity', 40], ['Details', 100]]),
    ...row(85, [['Date', 44], ['DC', 93], ['Activity', 116], ['C/', 165], ['I(L)', 175], ['C/', 207], ['O(L)', 217], ['From', 251], ['Start(L)', 283], ['To', 327], ['Finish(L)', 358],
      ['AC', 405], ['BH', 447], ['DHrs', 481], ['FDP', 516], ['Max', 550], ['EXT', 595], ['Hotel', 622]]),
    ...row(105, [['Type', 405], ['FDP', 550]]),
    ...row(207, [['02Jan26', 44], ['Z0783', 116], ['1230', 165], ['0009+1', 207], ['AAA', 251], ['1359', 283], ['BBB', 327], ['1839', 358], ['79U', 405], ['9:40', 447], ['11:39', 481], ['0', 595]]),
    ...row(235, [['03Jan26', 44], ['Hotel', 116], ['BBB', 251], ['1939-1', 283], ['BBB', 327], ['1935+1', 358], ['0', 595], ['The Grand', 622]]),
    ...row(256, [['Hotel Centre', 622]]),
  ];
  const r = parseNetlinePdf([{ page: 1, width: 842, height: 595, items: local }]);
  assert.equal(r.format, 'crew-roster-report');
  assert.deepEqual(r.published.map(x => [x.date, x.duty, x.dep, x.begin, x.end, x.arr, x.ac, x.info]), [
    ['2 Jan 26', 'C/I', 'AAA', '12:30 L', '', '', '', ''],
    ['2 Jan 26', 'Z0783', 'AAA', '13:59 L', '18:39 L', 'BBB', '79U', '[Block: 9:40]'],
    ['2 Jan 26', 'C/O', '', '', '00:09 L +1', 'BBB', '', '[Duty: 11:39]'],
    ['3 Jan 26', 'HT', 'BBB', '19:39 L -1', '19:35 L +1', 'BBB', '', 'The Grand Hotel Centre'],
  ]);
  const both = [
    ...row(85, [['Date', 44], ['DC', 95], ['Activity', 118], ['C/', 161], ['C/', 193], ['C/', 225], ['C/', 258], ['From', 291], ['Start(Z)', 328], ['Start(L)', 372], ['To', 415],
      ['Finish(Z)', 451], ['Finish(L)', 499], ['AC', 546], ['BH', 579], ['DHrs', 607], ['Hotel', 735]]),
    ...row(105, [['I(Z)', 161], ['I(L)', 193], ['O(Z)', 225], ['O(L)', 258], ['Type', 546]]),
    ...row(516, [['13May25', 44], ['DH', 95], ['DX524', 118], ['1510', 161], ['1710', 193], ['1719', 225], ['1919', 258], ['AAA', 291], ['1600', 328], ['1800', 372], ['BBB', 415], ['1659', 451], ['1859', 499], ['DO5', 546], ['9:09', 607], ['Crew house', 735]]),
  ];
  const r2 = parseNetlinePdf([{ page: 1, width: 842, height: 595, items: both }]);
  assert.deepEqual(r2.published.map(x => [x.dc, x.duty, x.dep, x.begin, x.end, x.arr, x.info]), [
    ['', 'C/I', 'AAA', '15:10 Z / 17:10 L', '', '', ''],
    ['DH', 'DX524', 'AAA', '16:00 Z / 18:00 L', '16:59 Z / 18:59 L', 'BBB', ''],
    ['', 'C/O', '', '', '17:19 Z / 19:19 L', 'BBB', '[Duty: 9:09]'],
    ['DH', 'HT', 'BBB', '', '', '', 'Crew house'],
  ]);
});

test('LH CAS "Achtung! Nur zur Info!" plan: day blocks, briefing with the pairing, a flight on two lines, icons, hotel, an activity over midnight', () => {
  const row = (y, cells) => cells.map(([text, x]) => iw(text, x, y, text.length * 4));
  const items = [
    ...row(42, [['Achtung! Nur zur Info! CAS ist der Master!', 36]]), ...row(73, [['Persönlicher Einsatzplan', 36], ['01OCT24 - 31OCT24', 185]]),
    ...row(132, [['01OCT', 37]]), ...row(142, [['S4', 137], ['AAA', 211]]), ...row(147, [['Tuesday', 37]]),
    ...row(218, [['1', 113], ['154302/18', 133], ['A350', 206], ['CP:1 SF:1 FO:1', 245]]), ...row(221, [['04OCT', 37]]),
    ...row(235, [['Friday', 37], ['', 118], ['Briefing', 137], ['AAA', 256], ['11:55', 302]]), ...row(238, [['[13:55]', 331]]),
    ...row(257, [['', 120], ['LH476', 137]]),
    ...row(273, [['A350', 113], ['AAA', 159], ['14:16', 205], ['[16:16]', 234], ['00:32+1', 310], ['[17:32]', 351], ['BBB', 416], ['10:16', 474]]),
    ...row(289, [['05OCT', 37]]), ...row(292, [['X', 137]]), ...row(313, [['Hotel', 137], ['BBB', 256]]),
    ...row(513, [['12OCT', 37]]), ...row(519, [['TTC OT RE 359', 137], ['/O', 216], ['AAA', 286], ['21:20', 332], ['[23:20]', 361]]),
    ...row(542, [['13OCT', 37]]), ...row(548, [['TTC OT RE 359', 137], ['/O', 216], ['AAA', 286], ['01:20', 438], ['[03:20]', 467]]),
  ];
  const r = parseNetlinePdf([{ page: 1, width: 595, height: 842, items }]);
  assert.equal(r.format, 'lh-cas-plan');
  assert.equal(r.period, '01Oct24 - 31Oct24');
  assert.deepEqual(r.published.map(x => [x.date, x.duty, x.dep, x.begin, x.end, x.arr, x.ac, x.info]), [
    ['1 Oct 24', 'S4', 'AAA', '', '', '', '', ''],
    ['4 Oct 24', 'C/I', 'AAA', '11:55 Z / 13:55 L', '', '', '', '[Trip: 154302/18]'],
    ['4 Oct 24', 'LH476', 'AAA', '14:16 Z / 16:16 L', '00:32 Z +1 / 17:32 L', 'BBB', 'A350', '[Block: 10:16]'],
    ['5 Oct 24', 'X', '', '', '', '', '', ''],
    ['5 Oct 24', 'HT', 'BBB', '', '', '', '', ''],
    ['12 Oct 24', 'TTC OT RE 359', 'AAA', '21:20 Z / 23:20 L', '01:20 Z +1 / 03:20 L +1', '', '', ''],
  ]);
});

test('MONTHLY OVERVIEW (KLM Cityhopper): a day\'s C/I, activities and C/O in order, flights with registration, block and allowance, codes', () => {
  const row = (y, cells) => cells.map(([text, x]) => iw(text, x, y, text.length * 4));
  const items = [
    ...row(44, [['MONTHLY OVERVIEW', 48]]), ...row(51, [['Period: From 01-12-2024 to 31-12-2024', 405]]),
    ...row(83, [['C/I or', 118], ['Dep', 150], ['Arr', 173], ['AC', 198], ['C/O or', 224], ['Flight', 257], ['FLD', 289], ['Cor', 321], ['Daily', 358]]),
    ...row(88, [['Day', 48], ['Duty', 69], ['Duty Description', 389]]),
    ...row(92, [['Dep', 122], ['Stat', 151], ['Stat', 173], ['Reg', 198], ['Arr', 231], ['hrs', 263], ['Time', 288], ['FLDT', 319], ['Allow', 358]]),
    ...row(102, [['1', 63], ['LVEC', 69], ['Flight Leave FD', 389]]),
    ...row(170, [['6', 63], ['KL9936', 69], ['09:48', 120], ['AAA', 151], ['BBB', 172], ['EZC', 197], ['10:45', 227], ['00:57', 259], ['€ 93,77', 361], ['Stop at BBB.', 389]]),
    ...row(182, [['6', 63], ['C/I - C/O', 69], ['08:45', 120], ['11:15', 227], ['02:30', 287], ['02:30', 319]]),
    ...row(512, [['TOTALS:', 220]]),
  ];
  const r = parseNetlinePdf([{ page: 1, width: 842, height: 595, items }]);
  assert.equal(r.format, 'monthly-overview');
  assert.equal(r.period, '01Dec24 - 31Dec24');
  assert.deepEqual(r.published.map(x => [x.date, x.duty, x.dep, x.begin, x.end, x.arr, x.registration, x.info]), [
    ['1 Dec 24', 'LVEC', '', '', '', '', '', '[LVEC: Flight Leave FD]'],
    ['6 Dec 24', 'C/I', 'AAA', '08:45 L', '', '', '', ''],
    ['6 Dec 24', 'KL9936', 'AAA', '09:48 L', '10:45 L', 'BBB', 'EZC', '[Block: 00:57] [EUR: 93,77] Stop at BBB.'],
    ['6 Dec 24', 'C/O', '', '', '11:15 L', 'BBB', '', '[Duty: 02:30]'],
  ]);
});

test('merlot.aero (Eastern Airways): "01-" over "Aug L" dates, a ground course as an event, H:MM hours by header, comments left out, sectors around their day', () => {
  const row = (y, cells) => cells.map(([text, x]) => iw(text, x, y, text.length * 4));
  const items = [
    ...row(45, [['merlot.aero-Employee Roster Report', 41]]), ...row(70, [['1/Aug/2024 to 31/Aug/2024', 333]]),
    ...row(91, [['Scheduled', 266], ['Flight', 311], ['Rest', 416]]),
    ...row(95, [['Day', 51], ['Date', 79], ['Duty', 110], ['Property', 140], ['From', 169], ['Report', 190], ['To', 217], ['Release', 232], ['Duty Time', 341], ['TAFB Time', 377], ['Sector(s)/Event(s)', 455]]),
    ...row(98, [['Route Block', 264], ['Time', 312], ['Time', 416]]),
    ...row(110, [['01-', 77], ['09:00', 190], ['Security Course AAA 9:00 L AAA', 438]]),
    ...row(114, [['Thu', 42], ['SEC', 100], ['PP', 140], ['AAA', 169], ['13:00 L', 232], ['4:00', 339], ['4:00', 376], ['1:00', 413]]),
    ...row(117, [['Aug L', 77], ['L', 190], ['13:00 L', 438]]),
    ...row(136, [['Comment:', 42], ['[Pairing]: www.example.com', 100]]),
    ...row(142, [['[Training]: Course: SEC', 100]]),
    ...row(150, [['451 AAA 7:15 L BBB', 438]]), ...row(157, [['8:36 L', 438]]),
    ...row(164, [['02-', 77], ['451-', 100], ['06:20', 190], ['452 BBB 9:43 L AAA', 438]]),
    ...row(168, [['Fri', 42], ['AAA', 169], ['10:00 L', 232], ['2:21', 311], ['3:40', 339], ['3:40', 376], ['20:00', 413]]),
    ...row(171, [['Aug L', 77], ['1', 100], ['L', 190], ['9:45 L', 438]]),
  ];
  const r = parseNetlinePdf([{ page: 1, width: 595, height: 842, items }]);
  assert.equal(r.format, 'allegiant-roster');
  assert.deepEqual(r.published.map(x => [x.date, x.duty, x.dep, x.begin, x.end, x.arr, x.info]), [
    ['1 Aug 24', 'C/I', 'AAA', '09:00 L', '', '', '[Trip: SEC]'],
    ['1 Aug 24', 'SEC', 'AAA', '09:00 L', '13:00 L', 'AAA', 'Security Course'],
    ['1 Aug 24', 'C/O', '', '', '13:00 L', 'AAA', '[Duty: 04:00] [TAFB: 04:00] [Rest: 01:00]'],
    ['2 Aug 24', 'C/I', 'AAA', '06:20 L', '', '', '[Trip: 451-1]'],
    ['2 Aug 24', '451', 'AAA', '07:15 L', '08:36 L', 'BBB', ''],
    ['2 Aug 24', '452', 'BBB', '09:43 L', '09:45 L', 'AAA', ''],
    ['2 Aug 24', 'C/O', '', '', '10:00 L', 'AAA', '[Block: 02:21] [Duty: 03:40] [TAFB: 03:40] [Rest: 20:00]'],
  ]);
});

test('Emirates Crew Roster (Detailed Report) as PDF: read as the Excel export\'s grid, a day\'s second leg on its own line', () => {
  const row = (y, cells) => cells.map(([text, x]) => iw(text, x, y, text.length * 4));
  const items = [
    ...row(17, [['Emirates Crew Roster (Detailed Report)', 246]]), ...row(29, [['Staff :', 26], ['444123', 56], ['March 2025', 529]]),
    ...row(194, [['Duty/Trip', 71]]),
    ...row(197, [['Day/Date', 24], ['Label', 118], ['Report', 164], ['Time(Dep-Arv)', 207], ['Duty Details', 276], ['A/C', 390], ['End', 424], ['Block Hours', 480]]),
    ...row(203, [['Code', 73]]),
    ...row(269, [['04-TUE', 24], ['XX', 71], ['-', 207], ['Day Off', 276], ['-', 506]]),
    ...row(487, [['18-TUE', 24], ['59238', 71], ['M', 118], ['08:00', 164], ['09:25-11:15', 207], ['EK9238 [AAA-BBB]', 276], ['77X', 390], ['02: 20', 499]]),
    ...row(496, [['59238', 71], ['12:45-01:15(+)', 207], ['EK9238 [BBB-CCC]', 276], ['77X', 390], ['01:45 (+)', 424], ['08: 00', 499]]),
    ...row(716, [['Total Block Hours* :', 428], ['80:00', 502]]),
  ];
  const r = parseNetlinePdf([{ page: 1, width: 595, height: 841, items }]);
  assert.equal(r.format, 'table-emirates-detailed');
  assert.deepEqual(r.published.map(x => [x.date, x.duty, x.dep, x.begin, x.end, x.arr, x.ac, x.info]), [
    ['4 Mar 25', 'XX', '', '', '', '', '', '[XX: Day Off]'],
    ['18 Mar 25', 'C/I', 'AAA', '08:00 L', '', '', '', ''],
    ['18 Mar 25', 'EK9238', 'AAA', '09:25 L', '11:15 L', 'BBB', '77X', '[Block: 02:20] [Trip: 59238] [Label: M]'],
    ['18 Mar 25', 'EK9238', 'BBB', '12:45 L', '01:15 L +1', 'CCC', '77X', '[Block: 08:00]'],
    ['18 Mar 25', 'C/O', '', '', '01:45 L +1', 'CCC', '', ''],
  ]);
});

test('Crew Roster Report with headers printed as one text ("STD (L) STD (Z) To"): each header at its place', () => {
  const row = (y, cells) => cells.map(([text, x]) => iw(text, x, y, text.length * 3));
  const items = [
    ...row(142, [['Period: 01Aug25 - 31Aug25', 225]]),
    ...row(189, [['Date', 68], ['DC', 102], ['C/I (L)', 121], ['C/I (Z)', 145], ['C/O (L)', 169], ['C/O (Z)', 193], ['Activity', 217], ['From', 251],
      ['STD (L) STD (Z) To', 275], ['STA (L) STA (Z) AC/Hotel', 347], ['Blk Hrs', 499]]),
    ...row(261, [['08Aug25', 74], ['0625', 121], ['0225', 145], ['HM61', 217], ['AAA', 251], ['0725', 275], ['0325', 299], ['BBB', 323], ['1030', 347], ['0830', 371], ['32N', 395], ['5:05', 518]]),
  ];
  const r = parseNetlinePdf([{ page: 1, width: 598, height: 842, items }]);
  assert.equal(r.format, 'crew-roster-report');
  assert.deepEqual(r.published.map(x => [x.date, x.duty, x.dep, x.begin, x.end, x.arr, x.ac]), [
    ['8 Aug 25', 'C/I', 'AAA', '02:25 Z / 06:25 L', '', '', ''],
    ['8 Aug 25', 'HM61', 'AAA', '03:25 Z / 07:25 L', '08:30 Z / 10:30 L', 'BBB', '32N'],
  ]);
});

test('FLICA schedule as PDF: the calendar on the left left out, FLT / GR headers, values off their headers, layover in two texts, hotel phone', () => {
  const row = (y, cells) => cells.map(([text, x]) => iw(text, x, y, text.length * 4));
  const items = [
    ...row(40, [['April Schedule', 65]]), ...row(96, [['Last Updated May', 55]]), ...row(109, [['15, 2026', 75]]),
    ...row(58, [['M3555 : 03APR', 140], ['ONLY ON FRI', 222], ['BSE REPT: 1205L', 325]]),
    ...row(88, [['DY', 140], ['DD', 152], ['DH', 163], ['C', 175], ['FLT', 181], ['DPS-ARS', 207], ['DEPL', 245], ['ARRL', 265], ['BLKT', 288], ['GR', 309],
      ['TBLK', 365], ['TDHD', 386], ['TCRD', 424], ['TDUTY/FDP', 447], ['LAYOVER', 530]]),
    ...row(98, [['FR', 140], ['03', 152], ['2529', 181], ['AAA-BBB', 207], ['1253', 245], ['1539', 265], ['0246', 289], ['0049', 309]]),
    ...row(103, [['FR', 57], ['03', 74], ['M3555', 88], ['AAA', 113]]),
    ...row(119, [['FR', 140], ['03', 152], ['3507', 181], ['BBB-CCC', 207], ['2140', 245], ['2327', 265], ['0147', 289], ['0433', 365], ['0435', 424], ['1137/1122', 447],
      ['(', 482], ['tel:1137/1122', 484], [')', 528], ['CCC', 530], ['1317', 546]]),
    ...row(129, [['D-END: 2342L REPT: 1259L', 152], ['Grand Hotel', 309], ['(404)665-0309', 409], ['(', 458], ['tel:(404)665-0309', 460], [')', 517]]),
    ...row(140, [['Crew:', 140]]), ...row(150, [['CA', 160], ['427221', 174], ['Doe, Ann', 201], ['FO', 258], ['443406', 272], ['Lee, Bob', 299]]),
  ];
  const r = parseNetlinePdf([{ page: 1, width: 612, height: 792, items }]);
  assert.equal(r.format, 'flica-schedule');
  assert.equal(r.period, '01Apr26 - 30Apr26');
  const crew = '[CA - 427221 - Doe, Ann][FO - 443406 - Lee, Bob]';
  assert.deepEqual(r.published.map(x => [x.date, x.duty, x.dep, x.begin, x.end, x.arr, x.crew, x.info]), [
    ['3 Apr 26', 'C/I', 'AAA', '12:05 L', '', '', '', ''],
    ['3 Apr 26', '2529', 'AAA', '12:53 L', '15:39 L', 'BBB', crew, '[Block: 02:46]'],
    ['3 Apr 26', '3507', 'BBB', '21:40 L', '23:27 L', 'CCC', crew, '[Block: 01:47]'],
    ['3 Apr 26', 'C/O', '', '', '23:42 L', 'CCC', '', '[Block: 04:33] [Credit: 04:35] [Duty: 11:37] [FDP: 11:22]'],
    ['3 Apr 26', 'HT', 'CCC', '', '', '', '', 'Grand Hotel (404)665-0309 [Layover: 13:17]'],
  ]);
});

test('"Flt Dates | Dep LC | Arr LC | Flt No ..." flight list: the date on a day\'s first line, pages without the header, totals left out', () => {
  const row = (y, cells) => cells.map(([text, x]) => iw(text, x, y, text.length * 4));
  const page1 = [
    ...row(33, [['Flt Dates', 129], ['Dep LC', 301], ['Arr LC', 381], ['Flt No', 452], ['From', 517], ['To', 583], ['Tail', 632], ['Block', 685], ['Prg No', 755]]),
    ...row(57, [['10/11/2023', 125], ['16:10', 307], ['20:59', 384], ['2600', 454], ['AAA', 519], ['BBB', 577], ['346', 631], ['02:49', 686]]),
    ...row(81, [['13:45', 307], ['15:10', 384], ['2601', 454], ['BBB', 518], ['AAA', 578], ['346', 631], ['03:25', 686]]),
  ];
  const page2 = [
    ...row(33, [['09/11/2023', 125], ['23:28', 307], ['01:19', 384], ['1249', 454], ['CCC', 518], ['BBB', 577], ['710', 631], ['02:51', 686]]),
    ...row(80, [['TOTAL BLOCK HOURS', 90], ['119:00', 683]]),
  ];
  const r = parseNetlinePdf([{ page: 1, width: 842, height: 595, items: page1 }, { page: 2, width: 842, height: 595, items: page2 }]);
  assert.equal(r.format, 'flight-dates');
  assert.equal(r.period, '09Nov23 - 10Nov23');
  assert.deepEqual(r.published.map(x => [x.date, x.duty, x.dep, x.begin, x.end, x.arr, x.registration, x.info]), [
    ['10 Nov 23', '2600', 'AAA', '16:10 L', '20:59 L', 'BBB', '346', '[Block: 02:49]'],
    ['10 Nov 23', '2601', 'BBB', '13:45 L', '15:10 L', 'AAA', '346', '[Block: 03:25]'],
    ['9 Nov 23', '1249', 'CCC', '23:28 L', '01:19 L +1', 'BBB', '710', '[Block: 02:51]'],
  ]);
});

test('Airside Roster Export: checkin / checkout / NightStop as C/I, C/O, hotel; a positioning flight, meal and stop time', () => {
  const row = (y, cells) => cells.map(([text, x]) => iw(text, x, y, text.length * 4));
  const items = [
    ...row(9, [['Airside', 131], ['Roster', 171], ['Export', 209]]),
    ...row(41, [['Day', 70], ['Date', 104], ['Duty', 160], ['Meal', 194], ['Activity', 233], ['C/', 289], ['I', 299], ['From', 317], ['STD', 354], ['STA', 393], ['To', 431], ['C/', 467], ['O', 477], ['Stop', 499], ['time', 520]]),
    ...row(58, [['Sat', 70], ['01FEB25', 104], ['F', 233], ['00:00', 354], ['23:59', 393], ['00:00', 499]]),
    ...row(120, [['Wed', 70], ['05FEB25', 104], ['checkin', 233], ['17:40', 354], ['17:40', 393], ['00:00', 499]]),
    ...row(136, [['Wed', 70], ['05FEB25', 104], ['P', 160], ['VO', 194], ['SK1516', 233], ['AAA', 317], ['18:40', 354], ['21:35', 393], ['BBB', 431], ['10:55', 499]]),
    ...row(151, [['Wed', 70], ['05FEB25', 104], ['checkout', 233], ['21:47', 354], ['21:47', 393], ['00:00', 499]]),
    ...row(167, [['Wed', 70], ['05FEB25', 104], ['NightStop', 233], ['21:47', 354], ['08:30', 393], ['00:00', 499]]),
  ];
  const r = parseNetlinePdf([{ page: 1, width: 595, height: 842, items }]);
  assert.equal(r.format, 'airside-export');
  assert.deepEqual(r.published.map(x => [x.date, x.dc, x.duty, x.dep, x.begin, x.end, x.arr, x.info]), [
    ['1 Feb 25', '', 'F', '', '00:00 L', '23:59 L', '', ''],
    ['5 Feb 25', '', 'C/I', 'AAA', '17:40 L', '', '', ''],
    ['5 Feb 25', 'P', 'SK1516', 'AAA', '18:40 L', '21:35 L', 'BBB', '[Meal: VO] [Stop: 10:55]'],
    ['5 Feb 25', '', 'C/O', '', '', '21:47 L', 'BBB', ''],
    ['5 Feb 25', '', 'HT', 'BBB', '21:47 L', '08:30 L +1', '', ''],
  ]);
});

test('Crew Member Roster: a day\'s code, C/I and C/O left of Flight No, an activity by its Type with its duty time', () => {
  const row = (y, cells) => cells.map(([text, x]) => iw(text, x, y, text.length * 4));
  const items = [
    ...row(15, [['Crew Member Roster', 15]]), ...row(35, [['From: 2024-01-01 Until: 2024-02-29', 220]]),
    ...row(65, [['Date', 43], ['Flight No', 97], ['STD', 149], ['DEP', 189], ['ARR', 229], ['STA', 269], ['Type', 318], ['DP', 376], ['FDP', 424], ['Block TM', 472], ['Daily Lim.', 525]]),
    ...row(83, [['2024-01-01 Mo', 15], ['OFF(3)', 85]]),
    ...row(99, [['2024-02-13 Tu', 15], ['C/I', 85], ['09:00', 146], ['AAA', 189]]),
    ...row(115, [['09:00', 146], ['AAA', 189], ['AAA', 229], ['17:00', 266], ['TRN', 319], ['08:00', 371]]),
    ...row(131, [['C/O', 85], ['17:00', 146], ['AAA', 189]]),
  ];
  const r = parseNetlinePdf([{ page: 1, width: 595, height: 842, items }]);
  assert.equal(r.format, 'crew-member-roster');
  assert.equal(r.period, '01Jan24 - 29Feb24');
  assert.deepEqual(r.published.map(x => [x.date, x.duty, x.dep, x.begin, x.end, x.arr, x.info]), [
    ['1 Jan 24', 'OFF(3)', '', '', '', '', ''],
    ['13 Feb 24', 'C/I', 'AAA', '09:00 L', '', '', ''],
    ['13 Feb 24', 'TRN', 'AAA', '09:00 L', '17:00 L', 'AAA', '[Duty: 08:00]'],
    ['13 Feb 24', 'C/O', '', '', '17:00 L', 'AAA', ''],
  ]);
});

test('"Schedule : 01MAR2024 - 31MAR2024" duty times (Sky Express): report / release Z and L, flights in UTC, registration, crew over lines, standby, day off', () => {
  const row = (y, cells) => cells.map(([text, x]) => iw(text, x, y, text.length * 4));
  const items = [
    ...row(21, [['Schedule : 01MAR2024', 372], ['-', 489], ['31MAR2024', 496]]),
    ...row(91, [['Duty Times', 87], ['Description', 226], ['Block Hrs', 556]]),
    ...row(112, [['FRI 01MAR 14:05', 22], ['-', 103], ['01MAR', 110], ['16:39', 139], ['(Z)', 169], ['F/O', 191], ['GQ344', 217], ['AAA', 279], ['(01MAR', 298], ['15:15)', 332], ['Z', 365],
      ['-', 380], ['BBB', 389], ['(01MAR', 409], ['16:24)', 442], ['Z', 476], ['1.09', 561], ['B', 591]]),
    ...row(123, [['FRI 01MAR 16:05', 22], ['-', 104], ['01MAR', 110], ['18:39', 139], ['(L)', 169], ['(SX-TNO)', 217]]),
    ...row(133, [['(P)(CPT)Ann', 217], ['DOE', 293], ['(CCM)Bob', 341]]), ...row(144, [['LEE', 217]]),
    ...row(154, [['SAT 02MAR 10:00', 22], ['-', 103], ['02MAR', 110], ['19:00', 139], ['(Z)', 169], ['F/O', 191], ['R/S', 217], ['(STBY', 236], ['A)', 265], ['at', 279], ['AAA', 293]]),
    ...row(165, [['SAT 02MAR 12:00', 22], ['-', 104], ['02MAR', 110], ['21:00', 139], ['(L)', 169]]),
    ...row(514, [['TUE 05MAR 00:00', 22], ['-', 103], ['05MAR', 110], ['23:59', 139], ['(Z)', 169], ['F/O', 191], ['Day', 217], ['Off', 236], ['(OFF)', 337]]),
  ];
  const r = parseNetlinePdf([{ page: 1, width: 612, height: 792, items }]);
  assert.equal(r.format, 'duty-times-schedule');
  assert.equal(r.period, '01Mar24 - 31Mar24');
  assert.deepEqual(r.published.map(x => [x.date, x.duty, x.dep, x.begin, x.end, x.arr, x.registration, x.crew, x.info]), [
    ['1 Mar 24', 'C/I', 'AAA', '14:05 Z / 16:05 L', '', '', '', '', ''],
    ['1 Mar 24', 'GQ344', 'AAA', '15:15 Z', '16:24 Z', 'BBB', 'SX-TNO', '[CPT - Ann DOE][CCM - Bob LEE]', '[Block: 01:09]'],
    ['1 Mar 24', 'C/O', '', '', '16:39 Z / 18:39 L', 'BBB', '', '', ''],
    ['2 Mar 24', 'R/S', 'AAA', '10:00 Z / 12:00 L', '19:00 Z / 21:00 L', '', '', '', '[STBY A]'],
    ['5 Mar 24', 'OFF', '', '00:00 Z', '23:59 Z', '', '', '', '[OFF: Day Off]'],
  ]);
});

test('Flights by Crew Member: a logbook line per flight, header words over three lines, commander, landings, function, distance', () => {
  const row = (y, cells) => cells.map(([text, x]) => iw(text, x, y, text.length * 4));
  const items = [
    ...row(33, [['Flights by Crew Member', 196]]), ...row(94, [['01-01-2024 - 31-12-2024', 451]]),
    ...row(271, [['Aircraft', 68], ['Trip', 182], ['Flight', 375], ['Distance', 536]]),
    ...row(276, [['Date', 40], ['Reg.', 103], ['Flight No.', 131], ['OFF', 219], ['ADEP', 248], ['ADES', 280], ['ON', 316], ['Block', 344], ['Night', 407], ['LND Function', 433], ['COM', 499]]),
    ...row(281, [['Type', 73], ['number', 175], ['time', 377], ['[NM]', 542]]),
    ...row(295, [['07-02-2024', 30], ['PC12', 73], ['9H-OTI', 100], ['9HOTI', 138], ['A20508', 177], ['09:15', 217], ['AAA', 251], ['BBB', 283], ['13:00', 312], ['03:45', 344], ['03:24', 376],
      ['00:00', 408], ['1', 438], ['<CPT>', 452], ['Doe', 496], ['744', 545]]),
  ];
  const r = parseNetlinePdf([{ page: 1, width: 595, height: 842, items }]);
  assert.equal(r.format, 'flights-by-crew-member');
  assert.equal(r.period, '01Jan24 - 31Dec24');
  assert.deepEqual(r.published.map(x => [x.date, x.duty, x.dep, x.begin, x.end, x.arr, x.ac, x.registration, x.crew, x.info]), [
    ['7 Feb 24', '9HOTI', 'AAA', '09:15 Z', '13:00 Z', 'BBB', 'PC12', '9H-OTI', '[COM - Doe]', '[Trip: A20508] [Block: 03:45] [Flight: 03:24] [Landing Day/Night: 1] [Function: CPT] [NM: 744]'],
  ]);
});

test('KLC Cockpit Briefing: a standby before the C/I, flights with Eq type/registration and the crew (the next flight\'s line without names), C/O', () => {
  const row = (y, cells) => cells.map(([text, x]) => iw(text, x, y, text.length * 4));
  const items = [
    ...row(42, [['Cockpit Briefing for ANN DOE', 28], ['KLC AUTO BRIEFING printed at 05Jan25-1727 Page 1', 595]]),
    ...row(75, [['Flight Info', 31]]),
    ...row(87, [['Date', 34], ['Flt', 68], ['Callsign', 114], ['Dep', 159], ['Arr', 204], ['Blk', 250], ['Grd', 281], ['Eq', 371]]),
    ...row(98, [['05Jan', 34], ['SBY_C', 68], ['0900', 159], ['1725', 204], ['08:25', 250]]),
    ...row(105, [['05Jan', 34], ['KL995', 68], ['KL995', 114], ['AAA 1830', 159], ['BBB 1935', 204], ['01:05', 250], ['E90/PHEZF', 371]]),
    ...row(120, [['05Jan', 34], ['KL996', 68], ['KLM90N', 114], ['BBB 2005', 159], ['AAA 2115', 204], ['01:10', 250], ['E90/PHEZF', 371]]),
    ...row(148, [['Daily Summary', 31]]),
    ...row(160, [['Date', 34], ['C/I', 68], ['C/O', 119], ['L/O', 170], ['Blk', 204]]),
    ...row(175, [['05Jan', 34], ['-', 68], ['-', 119], ['08:25', 204]]),
    ...row(182, [['05Jan', 34], ['1725', 68], ['2145', 119], ['02:15', 204]]),
    ...row(209, [['Crew Info', 31]]),
    ...row(221, [['Date', 39], ['Flight', 73], ['CP', 128], ['FO', 298]]),
    ...row(244, [['05Jan', 39], ['KL995', 73], ['1', 128], ['DOE, ANN', 157], ['2 LEE, BOB', 298]]),
    ...row(254, [['05Jan', 39], ['KL996', 73]]),
    ...row(297, [['ADDITIONAL INFORMATION', 28]]),
  ];
  const r = parseNetlinePdf([{ page: 1, width: 842, height: 595, items }]);
  assert.equal(r.format, 'cockpit-briefing');
  const crew = '[CP - 1 - DOE, ANN][FO - 2 - LEE, BOB]';
  assert.deepEqual(r.published.map(x => [x.duty, x.dep, x.begin, x.end, x.arr, x.ac, x.registration, x.crew, x.info]), [
    ['SBY_C', '', '09:00 Z', '17:25 Z', '', '', '', '', ''],
    ['C/I', 'AAA', '17:25 Z', '', '', '', '', '', ''],
    ['KL995', 'AAA', '18:30 Z', '19:35 Z', 'BBB', 'E90', 'PHEZF', crew, '[Block: 01:05]'],
    ['KL996', 'BBB', '20:05 Z', '21:15 Z', 'AAA', 'E90', 'PHEZF', crew, '[Block: 01:10]'],
    ['C/O', '', '', '21:45 Z', 'AAA', '', '', '', ''],
  ]);
});

test('ARMS operations roster: three columns of days, a pattern\'s report and end, credit and detail, in date order', () => {
  const row = (y, cells) => cells.map(([text, x]) => iw(text, x, y, text.length * 4));
  const items = [
    ...row(40, [['ARMS (csRoster)', 83]]),
    ...row(215, [['Date', 38], ['Duty', 86], ['Detail', 138], ['Rept', 188], ['End', 225], ['Credit', 257], ['Date', 304], ['Duty', 352], ['Detail', 404], ['Rept', 454], ['End', 491], ['Credit', 523]]),
    ...row(229, [['15/07 M', 35], ['AL', 90], ['41:30', 260], ['04/08 S', 302], ['JX24', 353], ['AW01', 405], ['2100', 455], ['35:40', 526]]),
    ...row(242, [['16/07 T', 36], ['X', 92], ['05/08 M', 301], ['JX24', 353], ['0530', 492]]),
    ...row(565, [['25 Jul 2024 17:24', 34]]),
  ];
  const r = parseNetlinePdf([{ page: 1, width: 842, height: 595, items }]);
  assert.equal(r.format, 'arms-roster');
  assert.deepEqual(r.published.map(x => [x.date, x.duty, x.begin, x.end, x.info]), [
    ['15 Jul 24', 'AL', '', '', '[Credit: 41:30]'],
    ['16 Jul 24', 'X', '', '', ''],
    ['4 Aug 24', 'JX24', '21:00 L', '', '[Detail: AW01] [Credit: 35:40]'],
    ['5 Aug 24', 'JX24', '', '05:30 L', ''],
  ]);
});

test('Brazilian hours reports: the pay report (flights with stations and times, an activity) and the monthly logbook (right aligned decimal hours)', () => {
  const row = (y, cells) => cells.map(([text, x]) => iw(text, x, y, text.length * 4));
  const pay = [
    ...row(18, [['Relatório de Pagamento de Tripulantes (Horas)', 141]]),
    ...row(115, [['Data', 38], ['Prog', 79], ['Função', 103], ['Etapa', 145], ['Partida', 181], ['Cheg.', 211], ['Diário Bordo', 238], ['Tipo Atividade', 287], ['Diu.', 343], ['Not.', 365],
      ['E. D.', 386], ['E. N.', 408], ['Diu.', 433], ['Not.', 456], ['E. D.', 477], ['E. N.', 499], ['Total', 529]]),
    ...row(130, [['09/09/2019 [SEG]', 21], ['TREIN2', 73], ['08:15', 183], ['17:15', 212], ['TREIN', 299], ['9,00', 539]]),
    ...row(143, [['17/11/2019 [DOM]', 21], ['2273', 78], ['AAA', 135], ['BBB', 159], ['16:48', 183], ['18:10', 212], ['1,20', 347], ['0,17', 369], ['1,37', 539]]),
  ];
  const r = parseNetlinePdf([{ page: 1, width: 595, height: 842, items: pay }]);
  assert.equal(r.format, 'br-hours-report');
  assert.deepEqual(r.published.map(x => [x.date, x.duty, x.dep, x.begin, x.end, x.arr, x.info]), [
    ['9 Sep 19', 'TREIN2', '', '08:15 L', '17:15 L', '', '[Type: TREIN]'],
    ['17 Nov 19', '2273', 'AAA', '16:48 L', '18:10 L', 'BBB', '[Block: 01:22] [Night: 00:10]'],
  ]);
  const monthly = [
    ...row(19, [['Relatório de Registro Individual de Horas de Vôo - Mensal', 128]]),
    ...row(73, [['Nome da Empresa', 53], ['Mês', 270], ['Ano', 314]]), ...row(88, [['10', 272], ['2019', 312]]),
    ...row(130, [['Data', 38], ['Função', 74], ['Frota', 107], ['Aeronave', 139], ['Vôo', 187], ['Hotran', 214], ['Diário Bordo', 248], ['Simulador', 300], ['Noturna', 349],
      ['Diurna', 396], ['VFR', 444], ['IFR', 491], ['Total', 534]]),
    ...row(144, [['12/10', 36], ['0,0', 328], ['0,0', 373], ['0,0', 418], ['0,0', 463], ['0,0', 508], ['0,0', 553]]),
    ...row(278, [['25/10', 36], ['PIN', 80], ['AT72', 107], ['PP-PTP', 140], ['2273', 185], ['102191', 244], ['0,0', 328], ['0,3', 373], ['1,1', 418], ['0,0', 463], ['1,4', 508], ['1,4', 553]]),
  ];
  const m = parseNetlinePdf([{ page: 1, width: 595, height: 842, items: monthly }]);
  assert.deepEqual(m.published.map(x => [x.date, x.duty, x.ac, x.registration, x.info]), [
    ['25 Oct 19', '2273', 'AT72', 'PP-PTP', '[Flight: 01:24] [Night: 00:18] [IFR: 01:24] [Function: PIN]'],
  ]);
});

test('Brussels Airlines roster: an aircraft type "(A319/320/32N)" is a remark, not crew; a simulator\'s training code is its duty (no ac), its crew on its line and cut over two lines', () => {
  const row = (y, cells) => cells.map(([text, x]) => iw(text, x, y, text.length * 4));
  const items = [
    ...row(21, [['Roster : 13JUL2024', 374], ['-', 481], ['31AUG2024', 489]]),
    ...row(112, [['Sched. times', 86], ['Description', 151], ['Rest until (real)', 495]]),
    ...row(134, [['TUE', 24], ['09', 45], ['FO', 66], ['08:30-11:05', 84], ['SN3811', 144], ['BRU-OPO', 207], ['(CPT)P.CORTEN', 245], ['B', 478], ['10JUL 05:45', 490]]),
    ...row(145, [['A-LCFC-C', 144], ['-', 197], ['Line', 207], ['Check', 231], ['FCM', 259], ['(A319/320/32N)', 279]]),
    ...row(156, [['WED', 24], ['10', 45], ['TRI', 64], ['09:25-13:25', 84], ['Simulator', 144], ['at', 192], ['BRU-All', 207], ['(CPT)G.DE', 379], ['11JUL 02:25', 490]]),
    ...row(167, [['WAELE', 144], ['(FO)G.ANTONIOLI', 187]]),
    ...row(178, [['S-REC', 144], ['(A319/320/32N),S-SBT-M5', 173], ['-', 322], ['EBT', 331]]),
    ...row(190, [['THU', 24], ['11', 45], ['TRI', 64], ['17:55-21:55', 84], ['Simulator', 144], ['at', 192], ['BRU-All', 207], ['12JUL 10:55', 490]]),
    ...row(201, [['(TF)Q.VANDENABEELE', 144]]),
    ...row(212, [['FFS', 144], ['11', 163], ['ABini', 178], ['319', 207]]),
  ];
  const r = parseNetlinePdf([{ page: 1, width: 612, height: 792, items }]);
  assert.equal(r.format, 'sn-roster');
  assert.deepEqual(r.published.map(x => [x.date, x.duty, x.ac, x.crew, x.info]), [
    ['9 Jul 24', 'SN3811', '', '[CPT - P.CORTEN]', 'A-LCFC-C - Line Check FCM (A319/320/32N) [Rest until: 10JUL 05:45]'],
    ['10 Jul 24', 'S-REC', '', '[CPT - G.DE WAELE][FO - G.ANTONIOLI]', 'at BRU-All S-REC (A319/320/32N),S-SBT-M5 - EBT'],
    ['11 Jul 24', 'SIM', '', '[TF - Q.VANDENABEELE]', 'at BRU-All FFS 11 ABini 319'],
  ]);
});

test('Jeppesen Released Roster: report local -> C/I "Z / L" by its airport\'s offset, C/O = report + duty time, a leg over local midnight on one row, a day off, the month before\'s days', () => {
  const header = [['Date (LT)', 44], ['Trip ID', 78], ['Report (LT)', 106], ['Pos', 146], ['Activity', 163], ['From', 207], ['To', 229], ['Start (UTC)', 252], ['End (UTC)', 291],
    ['A/C', 327], ['Layover', 346], ['Timezone', 377], ['LSW', 415], ['BZW', 438], ['Tags', 460], ['Blocktime', 494], ['FDP', 532], ['FDP', 554], ['FDP', 577], ['duty', 599], ['work', 622],
    ['rest', 644], ['rest', 669], ['rest', 696]].map(([t, x]) => it(t, x, 100));
  const r = parseNetlinePdf([{ page: 1, width: 842, height: 595, items: [
    it('Released Roster', 44, 34), it('Month:', 44, 54), it('June 2026', 98, 54), ...header, it('Difference', 377, 110), it('LAW', 532, 110),
    it('31 Sun', 44, 120), it('143302', 78, 120), it('13:50', 106, 120), it('FO', 146, 120), it('1754', 163, 120), it('MUC', 207, 120), it('ATH', 229, 120), it('13:10', 252, 120), it('15:45', 291, 120), it('32Y', 327, 120), it('+03:00', 377, 120), it('02:35', 494, 120),
    it('FO', 146, 130), it('1755', 163, 130), it('ATH', 207, 130), it('MUC', 229, 130), it('16:35', 252, 130), it('19:20', 291, 130), it('32Y', 327, 130), it('+02:00', 377, 130), it('02:45', 494, 130),
    it('07:25', 532, 130), it('07:40', 599, 130), it('12:00', 644, 130), it('14:15', 669, 130),
    it('01 Mon', 44, 140), it('OFF', 163, 140), it('00:00', 415, 140), it('ORTSTAG', 460, 140),
    it('06 Sat', 44, 150), it('2466', 78, 150), it('20:30', 106, 150), it('FO', 146, 150), it('1672', 163, 150), it('MUC', 207, 150), it('19:50', 252, 150), it('32A', 327, 150),
    it('07 Sun', 44, 160), it('FO', 146, 160), it('1672', 163, 160), it('CLJ', 229, 160), it('(06) 21:30', 293, 160), it('32A', 327, 160), it('+03:00', 377, 160), it('01:40', 494, 160),
    it('03:00', 532, 160), it('03:15', 599, 160),
    it('08 Mon', 44, 170), it('Layover: CLJ', 423, 170),
    it('Created 21May2026 13:00 (UTC) by Jeppesen', 44, 547),
  ] }]);
  assert.equal(r.format, 'released-roster');
  assert.equal(r.period, '01Jun26 - 30Jun26');
  assert.deepEqual(r.published.map(x => [x.date, x.day, x.dc, x.duty, x.dep, x.begin, x.end, x.arr, x.ac, x.info]), [
    ['31 May 26', 'Sun', '', 'C/I', '', '11:50 Z / 13:50 L', '', '', '', '[Trip 143302]'],
    ['31 May 26', 'Sun', 'FO', '1754', 'MUC', '13:10 Z', '15:45 Z', 'ATH', '32Y', '[Block: 02:35]'],
    ['31 May 26', 'Sun', 'FO', '1755', 'ATH', '16:35 Z', '19:20 Z', 'MUC', '32Y', '[Block: 02:45]'],
    ['31 May 26', 'Sun', '', 'C/O', '', '', '19:30 Z', '', '', '[Duty: 07:40] [Rest: 14:15]'],
    ['1 Jun 26', 'Mon', '', 'OFF', '', '', '', '', '', '[ORTSTAG]'],
    ['6 Jun 26', 'Sat', '', 'C/I', '', '18:30 Z / 20:30 L', '', '', '', '[Trip 2466]'],
    ['6 Jun 26', 'Sat', 'FO', '1672', 'MUC', '19:50 Z', '21:30 Z', 'CLJ', '32A', '[Block: 01:40]'],
    ['6 Jun 26', 'Sat', '', 'C/O', '', '', '21:45 Z', '', '', '[Duty: 03:15]'],
    ['8 Jun 26', 'Mon', '', '', 'CLJ', '', '', '', '', '[Layover: CLJ]'],
  ]);
});

test('TUI week sheet: a column per day, the grid not the CHANGE box, a flight duty\'s C/I and its C/O from "duty FDP", ground activities, a remark', () => {
  const heads = [['Mon 6.', 66], ['Tue 7.', 135], ['Wed 8.', 202], ['Thur 9.', 279], ['Fri 10.', 358], ['Sat 11.', 426], ['Sun 12.', 492]];
  const r = parseNetlinePdf([{ page: 1, width: 595, height: 842, items: [
    it('Cabin - CCM X Y ACW 0/0 - BRU', 195, 71), it('CHA', 256, 95), it('N', 281, 95), it('GE (confirmed)', 289, 95),
    ...heads.map(([t, x]) => it(t, x, 170)), ...heads.map(([, x]) => it('May 2024', x - 5, 180)),
    it('1753', 249, 193), it('T38', 321, 193), it('BRU', 249, 201), it('TFS', 318, 201), it('09:00', 249, 219), it('13:30', 314, 219), // the box: as it was
    it('W', 73, 250), it('00:00', 46, 259), it('00:00', 91, 259), it('···', 73, 269), it('46:38', 91, 278),
    it('1753', 249, 242), it('T37', 319, 242), it('BRU', 249, 250), it('TFS', 318, 250), it('C/I 08:00 09.05.2024', 249, 259), it('09:00', 249, 269), it('13:30', 314, 269), it('···', 286, 278),
    it('1754', 249, 288), it('T37', 319, 288), it('TFS', 249, 296), it('BRU', 316, 296), it('14:25', 249, 305), it('18:45', 314, 305), it('···', 286, 315),
    it('8:50', 249, 324), it('50:06', 314, 324), it('11:15', 249, 333), it('10:45', 314, 333), it('30:25', 249, 342), it('44:05', 278, 342), it('85:05', 314, 342),
    it('PRC', 361, 250), it('09:00', 337, 259), it('15:00', 382, 259), it('···', 364, 269), it('50:06', 382, 278),
    it('6.5 Mon', 46, 440), it('-- -- --', 113, 440), it('10.5 Fri', 46, 488), it('-- \'hours TBD within 72h of PRC\'. -- --', 113, 488),
    it('printed at 3. May 2024', 373, 582),
  ] }]);
  assert.equal(r.format, 'tui-week-grid');
  assert.equal(r.period, '06May24 - 12May24');
  assert.deepEqual(r.published.map(x => [x.date, x.duty, x.dep, x.begin, x.end, x.arr, x.ac, x.info]), [
    ['6 May 24', 'W', '', '00:00 B', '00:00 B', '', '', ''],
    ['7 May 24', '', '', '', '', '', '', ''],
    ['8 May 24', '', '', '', '', '', '', ''],
    ['9 May 24', 'C/I', '', '08:00 B', '', '', '', ''],
    ['9 May 24', '1753', 'BRU', '09:00 B', '13:30 B', 'TFS', 'T37', ''],
    ['9 May 24', '1754', 'TFS', '14:25 B', '18:45 B', 'BRU', 'T37', ''],
    ['9 May 24', 'C/O', '', '', '19:15 B', '', '', '[Duty: 11:15]'],
    ['10 May 24', 'PRC', '', '09:00 B', '15:00 B', '', '', '[\'hours TBD within 72h of PRC\'.]'],
    ['11 May 24', '', '', '', '', '', '', ''],
    ['12 May 24', '', '', '', '', '', '', ''],
  ]);
});

test('Activity list printed letter by letter (web print): touching pieces make one word, "\\u0000" between digits is ":"', () => {
  // pieces side by side as the print has them (it() is 4 points a character)
  const word = (parts, x, y) => { const out = []; for (const p of parts) { out.push(it(p, x, y)); x += p.length * 4; } return out; };
  const items = [
    ...word(['A', 'ctivity'], 32, 88), ...word(['C', 'heckin'], 83, 88), ...word(['S', 'tart'], 138, 88), ...word(['D', 'ep'], 190, 88), ...word(['A', 'rr'], 226, 88),
    ...word(['E', 'nd'], 257, 88), ...word(['C', 'heck', 'out'], 309, 88), ...word(['A', 'c', 'V', 'er'], 371, 88), it('DD', 416, 88), it('CAT', 490, 88), ...word(['C', 'rew'], 526, 88),
    ...word(['AD', '2921'], 32, 107), ...word(['30', 'AGO', '21'], 83, 107), ...word(['30', 'AGO', '21'], 138, 107), ...word(['V', 'CP'], 190, 107), it('POA', 226, 107),
    ...word(['30', 'AGO', '21'], 257, 107), ...word(['30', 'AGO', '21'], 309, 107), ...word(['E', '95'], 371, 107), it('-', 416, 107), it('FO', 490, 107), it('-', 526, 107),
    ...word(['12', '\u0000', '10'], 83, 119), ...word(['12', '\u0000', '56'], 138, 119), ...word(['14', '\u0000', '31'], 257, 119), ...word(['15', '\u0000', '01'], 309, 119),
  ];
  const r = parseNetlinePdf([{ page: 1, width: 842, height: 1191, items }]);
  assert.equal(r.format, 'activity-list');
  assert.deepEqual(r.published.map(x => [x.date, x.duty, x.dep, x.begin, x.end, x.arr, x.ac]), [
    ['30 Aug 21', 'C/I', 'VCP', '12:10 Z', '', '', ''],
    ['30 Aug 21', 'AD2921', 'VCP', '12:56 Z', '14:31 Z', 'POA', 'E95'],
    ['30 Aug 21', 'C/O', '', '', '15:01 Z', 'POA', ''],
  ]);
});

test('FLICA print with run-together texts ("DY DD DH C FLTNO DPS-ARS", "0057 0147"): legs read by their order; an activity listed under each of its days once', () => {
  const r = parseNetlinePdf([{ page: 1, width: 612, height: 792, items: [
    it('May Schedule', 66, 28), it('Last Updated May 14,', 47, 70), it('2026 08:12:42 MDT', 51, 81),
    it('C4009 : 14MAY', 153, 49), it('ONLY ON THU', 236, 49), it('BSE REPT: 0820L', 340, 49),
    it('DY DD DH C FLTNO DPS-ARS', 153, 66), it('DEPL ARRL BLKT GRNT OA', 262, 66), it('TBLK TDHD', 403, 66), it('TCRD TDUTY/FDPLAYOVER', 471, 66),
    it('TH 14', 153, 86), it('8128', 198, 86), it('YYC-YEG', 223, 86), it('0920', 263, 86), it('1010', 286, 86), it('0050 0040', 311, 86),
    it('TH 14', 153, 96), it('*', 188, 96), it('8133', 198, 96), it('YEG-YYC 1050', 223, 96), it('1147', 286, 96), it('0057', 311, 96), it('0147', 402, 96), it('0150', 471, 96), it('0342/0327', 494, 96),
    it('D-END: 1202L', 165, 106), it('T.A.F.B.: 0342', 222, 106),
    it('Crew:', 153, 116), it('CA', 173, 126), it('724658', 188, 126), it('STEPIEN, DAVID', 219, 126), it('FO', 286, 126), it('813463', 300, 126), it('GAGNON, JON', 331, 126),
    it('VAC : 04MAY', 153, 150), it('ActivityStart DateStart TimeEnd DateEnd TimeCredit', 153, 160),
    it('VAC', 153, 170), it('04MAY', 180, 170), it('00:01', 216, 170), it('09MAY', 254, 170), it('00:00', 286, 170), it('2000', 323, 170),
    it('VAC : 05MAY', 153, 190), it('ActivityStart DateStart TimeEnd DateEnd TimeCredit', 153, 200),
    it('VAC', 153, 210), it('04MAY', 180, 210), it('00:01', 216, 210), it('09MAY', 254, 210), it('00:00', 286, 210), it('2000', 323, 210),
  ] }]);
  assert.equal(r.format, 'flica-schedule');
  assert.deepEqual(r.published.map(x => [x.date, x.duty, x.dep, x.begin, x.end, x.arr, x.crew, x.info]), [
    ['14 May 26', 'C/I', 'YYC', '08:20 L', '', '', '', ''],
    ['14 May 26', '8128', 'YYC', '09:20 L', '10:10 L', 'YEG', '[CA - 724658 - STEPIEN, DAVID][FO - 813463 - GAGNON, JON]', '[Block: 00:50]'],
    ['14 May 26', '8133', 'YEG', '10:50 L', '11:47 L', 'YYC', '[CA - 724658 - STEPIEN, DAVID][FO - 813463 - GAGNON, JON]', '[Block: 00:57]'],
    ['14 May 26', 'C/O', '', '', '12:02 L', 'YYC', '', '[Block: 01:47] [Credit: 01:50] [Duty: 03:42] [FDP: 03:27] [TAFB: 03:42]'],
    ['4 May 26', 'VAC', '', '00:01 L', '00:00 L +5', '', '', '[Credit: 20:00]'],
  ]);
});

test('Qantas pattern list: rows by weekday (no dates), report -> C/I, Duty Period -> C/O local at the arrival, a passenger leg', () => {
  const r = parseNetlinePdf([{ page: 1, width: 802, height: 555, items: [
    it('Pattern:', 8, 7), it('DB15', 35, 7), it('A/C Type:', 116, 7), it('A330', 147, 7), it('Route Code:', 8, 22), it('DMM03', 46, 22),
    ...[['Service', 28], ['T', 84], ['Pax', 103], ['Sectors', 159], ['Report Time', 231], ['Departure', 327], ['Arrival', 453], ['Free of Duty', 530], ['Flight Time', 615], ['Duty', 693], ['Period', 718], ['ADP Credit', 753]].map(([t, x]) => it(t, x, 36)),
    ...[['Day', 298], ['Lst', 340], ['Utc', 379], ['Day', 418], ['Lst', 460], ['Utc', 499], ['Total', 599], ['Night', 653]].map(([t, x]) => it(t, x, 51)),
    it('QFA0521', 31, 68), it('PAX', 107, 68), it('BNE', 145, 68), it('SYD', 176, 68), it('1030', 249, 68), it('TU', 303, 68), it('1115', 341, 68), it('0115', 381, 68),
    it('TU', 423, 68), it('1250', 460, 68), it('0250', 500, 68), it('1:40', 550, 68), it('( 1:35)', 600, 68),
    it('QFA0451', 31, 79), it('SYD', 145, 79), it('MEL', 176, 79), it('TU', 303, 79), it('1430', 341, 79), it('0430', 381, 79), it('TU', 423, 79), it('1605', 460, 79), it('0605', 500, 79),
    it('1:35', 605, 79), it('6:05', 714, 79),
    it('Elapsed Time:', 7, 98), it('Days Away:', 7, 123), it('Minimum Pattern Credit:', 264, 123),
  ] }]);
  assert.equal(r.format, 'qantas-patterns');
  assert.deepEqual(r.published.map(x => [x.date, x.day, x.dc, x.duty, x.dep, x.begin, x.end, x.arr, x.ac, x.info]), [
    ['', 'Tue', '', 'C/I', 'BNE', '10:30 L', '', '', '', '[Pattern DB15 DMM03]'],
    ['', 'Tue', 'PAX', 'QFA0521', 'BNE', '11:15 L', '12:50 L', 'SYD', 'A330', ''],
    ['', 'Tue', '', 'QFA0451', 'SYD', '14:30 L', '16:05 L', 'MEL', 'A330', '[Block: 01:35]'],
    ['', 'Tue', '', 'C/O', '', '', '16:35 L', 'MEL', '', '[Duty: 06:05]'],
  ]);
});

test('Qatar "Crew Schedule Report": a column per day, RPT as C/I (time on its own line too), flights with aircraft and indicators, DH, day codes, hotel stays', () => {
  const at = (text, cx, y) => iw(text, cx - text.length * 2, y, text.length * 4);
  const days = ['01Feb', '02Feb', '03Feb', '04Feb', '05Feb', '06Feb', '07Feb'];
  const cx = (n) => 40 + n * 45;
  const col = (n, texts) => texts.map((t, k) => at(t, cx(n), 186 + k * 10));
  const items = [
    at('Crew Schedule Report', 700, 71), at('Period: 01-Feb-2025 - 28-Feb-2025 | Published', 700, 100),
    ...days.map((d, n) => at(d, cx(n), 165)), ...['Sat', 'Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri'].map((d, n) => at(d, cx(n), 174)),
    ...col(0, ['OFF', 'DOH']),
    ...col(1, ['RPT:03:40', '729', 'DOH', '04:55', 'DFW', '21:10', '(351)', 'PA,PIC']),
    ...col(2, ['RPT:', '22:40', '730', 'DFW', '23:40', 'DOH', '14:05(+1)', 'DH', '(351)']),
    ...col(3, ['DOFF', '(LGW)']),
    iw('DH:00:00', 22, 384, 30),
    iw('STAY DATE', 32, 424, 40), iw('LOCATION', 92, 424, 40), iw('HOTEL NAME', 198, 424, 40), iw('HOTEL ADDRESS', 362, 424, 50),
    iw('CONTACT NAME', 497, 424, 50), iw('TELEPHONE', 604, 424, 40), iw('ACTIVITY CODE/INDICATOR', 694, 424, 90), iw('DESCRIPTION', 1020, 424, 40),
    iw('02-FEB-2025', 30, 437, 40), iw('DFW', 104, 437, 12), iw('Hotel X', 170, 437, 30), iw('1 Road,,', 325, 437, 30), iw('Ops', 509, 437, 12), iw('+1 2', 598, 437, 16),
    iw('OFF', 692, 437, 12), iw('Day Off', 1020, 437, 30),
    iw('PIC', 692, 451, 12), iw('Pilot in Command', 1020, 451, 60),
    iw('DOFF', 692, 465, 16), iw('Day Off Downroute', 1020, 465, 60),
  ];
  const r = parseNetlinePdf([{ page: 1, width: 1400, height: 800, items }]);
  assert.equal(r.format, 'qatar-schedule-report');
  assert.equal(r.period, '01Feb25 - 28Feb25');
  assert.deepEqual(r.published.map(x => [x.date, x.day, x.dc, x.duty, x.dep, x.begin, x.end, x.arr, x.ac, x.info]), [
    ['1 Feb 25', 'Sat', '', 'OFF', 'DOH', '', '', '', '', '[OFF: Day Off]'],
    ['2 Feb 25', 'Sun', '', 'C/I', 'DOH', '03:40 Z', '', '', '', ''],
    ['2 Feb 25', 'Sun', '', '729', 'DOH', '04:55 Z', '21:10 Z', 'DFW', '351', '[PA] [PIC: Pilot in Command]'],
    ['2 Feb 25', 'Sun', '', 'HT', 'DFW', '', '', '', '', 'Hotel X, 1 Road, Tel +1 2'],
    ['3 Feb 25', 'Mon', '', 'C/I', 'DFW', '22:40 Z', '', '', '', ''],
    ['3 Feb 25', 'Mon', 'DH', '730', 'DFW', '23:40 Z', '14:05 Z +1', 'DOH', '351', ''],
    ['4 Feb 25', 'Tue', '', 'DOFF', 'LGW', '', '', '', '', '[DOFF: Day Off Downroute]'],
  ]);
});

test('Swiss "Published roster": report as C/I, legs of a day, a flight landing the next day, layover line, day codes, Rest / local nights; Widerøe Check In / Check Out', () => {
  const row = (y, cells) => cells.map(([text, x]) => iw(text, x, y, text.length * 4));
  const swiss = [
    ...row(34, [['Published roster', 44]]), ...row(53, [['Period:', 44], ['December 2025', 85]]), ...row(91, [['All times local', 483]]),
    ...row(103, [['Date', 45], ['Report', 77], ['Tags', 116], ['Pos', 155], ['IFF', 184], ['Activity', 208], ['From', 255], ['To', 279], ['Dep', 303], ['Arr', 332],
      ['A/C', 371], ['Layover /', 400], ['LN*', 444], ['Flt hrs', 461], ['DP', 503]]),
    ...row(112, [['Rest at', 400], ['28d/12m', 461], ['hrs', 503]]), ...row(121, [['HB', 400], ['7d/28d', 503]]),
    ...row(133, [['01 Mon', 45], ['LTFD', 210]]),
    ...row(145, [['02 Tue', 45], ['SBY', 212], ['ZRH', 255], ['03:45', 303], ['15:45', 332]]),
    ...row(157, [['03 Wed', 45], ['16:35', 77], ['RP', 155], ['V', 184], ['LX180', 208], ['ZRH', 255], ['18:00', 303], ['77W', 371]]),
    ...row(168, [['04 Thu', 45], ['RP', 155], ['BKK', 279], ['10:45', 332], ['49:00', 400], ['71:30/684:34', 461]]),
    ...row(179, [['05 Fri', 45], ['Layover: BKK', 283]]),
    ...row(191, [['06 Sat', 45], ['12:15', 77], ['DH', 155], ['LX181', 208], ['BKK', 255], ['ZRH', 279], ['13:15', 303], ['19:25', 332], ['121:20', 400], ['3', 444]]),
    ...row(260, [['(*): Local nights', 45]]),
  ];
  const r = parseNetlinePdf([{ page: 1, width: 595, height: 842, items: swiss }]);
  assert.equal(r.format, 'swiss-roster');
  assert.equal(r.period, '01Dec25 - 31Dec25');
  assert.deepEqual(r.published.map(x => [x.date, x.dc, x.duty, x.dep, x.begin, x.end, x.arr, x.ac, x.info]), [
    ['1 Dec 25', '', 'LTFD', '', '', '', '', '', ''],
    ['2 Dec 25', '', 'SBY', 'ZRH', '03:45 L', '15:45 L', '', '', ''],
    ['3 Dec 25', '', 'C/I', 'ZRH', '16:35 L', '', '', '', ''],
    ['3 Dec 25', '', 'LX180', 'ZRH', '18:00 L', '10:45 L +1', 'BKK', '77W', '[IFF: V] [Rest: 49:00]'],
    ['5 Dec 25', '', 'HT', 'BKK', '', '', '', '', ''],
    ['6 Dec 25', '', 'C/I', 'BKK', '12:15 L', '', '', '', ''],
    ['6 Dec 25', 'DH', 'LX181', 'BKK', '13:15 L', '19:25 L', 'ZRH', '', '[Rest: 121:20] [Local nights: 3]'],
  ]);

  const wf = [
    ...row(34, [['Published roster', 44]]), ...row(54, [['Planning period:', 44], ['November 2025', 114], ['All times in Local Time', 178]]),
    ...row(126, [['Date', 46], ['Check In', 88], ['Training', 136], ['Pos', 183], ['Activity', 211], ['From', 256], ['To', 290], ['Start', 322], ['End', 356],
      ['Check Out', 390], ['A/C', 445], ['Layover', 476], ['Trip ID', 521]]),
    ...row(139, [['01 Sat', 46], ['11:20', 88], ['FO', 183], ['WF983', 211], ['LKL', 256], ['TOS', 290], ['12:04', 322], ['12:50', 356], ['DH1', 445]]),
    ...row(151, [['FO', 183], ['WF984', 211], ['TOS', 256], ['LKL', 290], ['14:56', 322], ['15:37', 356], ['16:43', 390], ['DH3', 445], ['16:50', 476]]),
    ...row(163, [['02 Sun', 46], ['F', 230]]),
    ...row(655, [['01Nov-30Nov2025', 211]]), ...row(667, [['Work Days', 44], ['14', 211]]),
  ];
  const w = parseNetlinePdf([{ page: 1, width: 595, height: 842, items: wf }]);
  assert.deepEqual(w.published.map(x => [x.date, x.duty, x.dep, x.begin, x.end, x.arr, x.ac, x.info]), [
    ['1 Nov 25', 'C/I', 'LKL', '11:20 L', '', '', '', ''],
    ['1 Nov 25', 'WF983', 'LKL', '12:04 L', '12:50 L', 'TOS', 'DH1', ''],
    ['1 Nov 25', 'WF984', 'TOS', '14:56 L', '15:37 L', 'LKL', 'DH3', '[Layover: 16:50]'],
    ['1 Nov 25', 'C/O', '', '', '16:43 L', 'LKL', '', ''],
    ['2 Nov 25', 'F', '', '', '', '', '', ''],
  ]);
});

test('"Planning navigant" (Air Corsica, GMT): day centred on its lines, C/I / flights / C/O with TSV and Rep. après, wrapped text, hotel, codes from the list; LOC print with UTC under local and a flight over midnight', () => {
  const row = (y, cells) => cells.map(([text, x]) => iw(text, x, y, text.length * 4));
  const head = (y) => row(y, [['Date', 32], ['Acti', 66], ['Depa', 149], ['Arri', 179], ['CheckIn', 208], ['Hdep', 255], ['Harr', 299], ['CheckOut', 333], ['BLH', 379], ['TSV', 414],
    ['TS', 451], ['TSV Max', 488], ['TpsEqF', 543], ['StdBy', 586], ['Rep. avant', 623], ['Rep. après', 674], ['Flags', 732], ['Fonc', 772], ['Part.*', 800]]);
  const gmt = [
    ...row(20, [['Planning navigant', 20]]), ...row(48, [['NOV. 2021', 20]]), ...row(82, [['Horaires en GMT', 20]]), ...head(124),
    ...row(142, [['lun.', 35]]),
    ...row(147, [['FLT - XK154 - 320', 65], ['AAA', 152], ['BBB', 179], ['14:00', 214], ['14:59', 257], ['15:47', 299], ['00:48', 380], ['01:00', 549], ['OPL', 774]]),
    ...row(153, [['01 nov.', 29]]), ...row(196, [['12:00', 683]]),
    ...row(200, [['FLT - XK155 - 320', 65], ['BBB', 151], ['AAA', 180], ['16:41', 257], ['17:30', 299], ['17:50', 342], ['00:49', 380], ['03:50', 414], ['04:10', 448], ['11:00', 496], ['OPL', 774]]),
    ...row(204, [['02/11 05:50', 674]]), ...row(221, [['04:00', 549], ['00:00', 588]]),
    ...row(236, [['mar.', 34]]),
    ...row(241, [['TXI - AAA GARE DU', 65]]), ...row(245, [['AAA', 151], ['CCC', 179], ['07:45', 257], ['09:45', 299]]), ...row(249, [['NOR', 65]]),
    ...row(247, [['02 nov.', 29]]),
    ...row(262, [['HOT - Grand', 65]]), ...row(266, [['CCC', 150], ['>', 185], ['09:45', 257]]), ...row(270, [['Hotel - HOTEL', 65]]),
    ...row(290, [['mer.', 34]]), ...row(295, [['JL', 65], ['AAA', 152], ['AAA', 180]]), ...row(300, [['03 nov.', 29]]),
    ...row(529, [['Part.*: C=Contrôle en ligne ,R=Desiderata', 20]]),
  ];
  const legend = [...row(20, [['Planning navigant', 20]]), ...row(124, [['Liste des codes activités', 21]]), ...row(147, [['Groupe', 31], ['Acti', 145], ['Description', 230]]),
    ...row(170, [['Ground', 31], ['JL', 145], ['JOUR LIBRE', 230]])];
  const r = parseNetlinePdf([{ page: 1, width: 842, height: 595, items: gmt }, { page: 2, width: 842, height: 595, items: legend }]);
  assert.equal(r.format, 'planning-navigant');
  assert.equal(r.period, '01Nov21 - 30Nov21');
  assert.deepEqual(r.published.map(x => [x.date, x.day, x.duty, x.dep, x.begin, x.end, x.arr, x.ac, x.info]), [
    ['1 Nov 21', 'Mon', 'C/I', 'AAA', '14:00 Z', '', '', '', ''],
    ['1 Nov 21', 'Mon', 'XK154', 'AAA', '14:59 Z', '15:47 Z', 'BBB', '320', '[Block: 00:48]'],
    ['1 Nov 21', 'Mon', 'XK155', 'BBB', '16:41 Z', '17:30 Z', 'AAA', '320', '[Block: 00:49]'],
    ['1 Nov 21', 'Mon', 'C/O', '', '', '17:50 Z', 'AAA', '', '[Duty: 03:50] [TS: 04:10] [TSV Max: 11:00] [Rest: 12:00]'],
    ['2 Nov 21', 'Tue', 'TXI', 'AAA', '07:45 Z', '09:45 Z', 'CCC', '', '[TXI: AAA GARE DU NOR]'],
    ['2 Nov 21', 'Tue', 'HT', 'CCC', '09:45 Z', '', '', '', 'Grand Hotel'],
    ['3 Nov 21', 'Wed', 'JL', 'AAA', '', '', 'AAA', '', '[JL: JOUR LIBRE]'],
  ]);

  const loc = [
    ...row(20, [['Planning navigant', 20]]), ...row(48, [['JUIL. 2024', 20]]), ...row(82, [['Horaires en LOC Escale', 20]]),
    ...row(124, [['Date', 32], ['Acti', 66], ['Depa', 160], ['Arri', 190], ['CheckIn', 224], ['Hdep', 283], ['Harr', 338], ['HDV', 382], ['TSV', 420], ['TS', 460], ['TSV Max', 486], ['Fonc', 527], ['Part.*', 554]]),
    ...row(164, [['mar. 02', 28], ['11:30', 229], ['13:30', 283]]), ...row(168, [['TN008', 66], ['LAX', 161], ['>', 195], ['OPL', 528]]),
    ...row(173, [['18:30 Z', 226], ['20:30 Z', 280]]),
    ...row(186, [['09:05', 337]]), ...row(189, [['mer. 03', 28], ['TN008', 66], ['<', 167], ['CDG', 189], ['10:35', 382], ['OPL', 528]]), ...row(195, [['07:05 Z', 333]]),
    ...row(529, [['Part.*: C=Contrôle en ligne ,R=Desiderata', 20]]),
  ];
  const l = parseNetlinePdf([{ page: 1, width: 842, height: 595, items: loc }]);
  assert.deepEqual(l.published.map(x => [x.date, x.duty, x.dep, x.begin, x.end, x.arr, x.info]), [
    ['2 Jul 24', 'C/I', 'LAX', '18:30 Z / 11:30 L', '', '', ''],
    ['2 Jul 24', 'TN008', 'LAX', '20:30 Z / 13:30 L', '07:05 Z +1 / 09:05 L +1', 'CDG', '[Block: 10:35]'],
  ]);
});

test('Iberia monthly roster letter: calendar (pairing, firma, end station, despedida; marks; code with times) joined with the UTC legs of "Etapas", DH, legs as one "||...||" item', () => {
  const row = (y, cells) => cells.map(([text, x]) => iw(text, x, y, text.length * 4));
  const xs = [48, 70, 92, 114, 136, 158, 180];
  const items = [
    ...row(255, [['Septiembre 2025', 111], ['(Hora local de firma y despedida)', 213]]),
    ...row(269, ['Lun', 'Mar', 'Mie', 'Jue', 'Vie', 'Sab', 'Dom'].map((d, k) => [d, xs[k] - 2])),
    ...row(278, ['01', '02', '03', '04', '05', '06', '07'].map((d, k) => [d, xs[k]])),
    ...row(297, [['3311', 66]]),
    ...row(302, [['D', 50], ['*', 138]]),
    ...row(306, [['X', 94], ['0615', 66], ['1330', 110], ['2020', 154]]),
    ...row(311, [['IM', 114]]),
    ...row(315, [['AAA', 68], ['AAA', 156]]),
    ...row(319, [['2359', 110]]),
    ...row(324, [['1120', 66], ['1100', 154]]),
    ...row(442, [['Etapas (Hora UTC)', 44]]),
    ...row(453, [['2', 112], ['Mar', 121], ['529', 169], ['AAA', 186], ['0515', 203], ['BBB', 224], ['0645', 241], ['DH', 284], ['530', 288], ['BBB', 305], ['0725', 322], ['AAA', 343], ['0850', 360]]),
    ...row(462, [['7', 112], ['Dom', 121], ['||346 BBB 0120 AAA 0830||', 165]]),
    ...row(506, [['Descripcion de codigos', 44]]), ...row(517, [['3 Jue', 48], ['IM - IMAGINARIA', 78]]),
    ...row(530, [['Mensajes', 44]]),
  ];
  const r = parseNetlinePdf([{ page: 1, width: 595, height: 842, items }]);
  assert.equal(r.format, 'iberia-monthly');
  assert.equal(r.period, '01Sep25 - 30Sep25');
  assert.deepEqual(r.published.map(x => [x.date, x.dc, x.duty, x.dep, x.begin, x.end, x.arr, x.info]), [
    ['1 Sep 25', '', 'D', '', '', '', '', ''],
    ['2 Sep 25', '', 'C/I', 'AAA', '06:15 L', '', '', '[Pairing: 3311]'],
    ['2 Sep 25', '', '529', 'AAA', '05:15 Z', '06:45 Z', 'BBB', ''],
    ['2 Sep 25', 'DH', '530', 'BBB', '07:25 Z', '08:50 Z', 'AAA', ''],
    ['2 Sep 25', '', 'C/O', '', '', '11:20 L', 'AAA', ''],
    ['3 Sep 25', '', 'X', '', '', '', '', ''],
    ['4 Sep 25', '', 'IM', '', '13:30 L', '23:59 L', '', '[IM: IMAGINARIA]'],
    ['5 Sep 25', '', '*', '', '', '', '', ''],
    ['6 Sep 25', '', 'C/I', 'BBB', '20:20 L', '', '', ''],
    ['7 Sep 25', '', '346', 'BBB', '01:20 Z', '08:30 Z', 'AAA', ''],
    ['6 Sep 25', '', 'C/O', '', '', '11:00 L +1', 'AAA', ''],
  ]);
});

test('OFP flight log (block times, take-off / landing, Crew Onboard) and flight plan headers (STD / STA, a values line under a notes line)', () => {
  const row = (y, cells) => cells.map(([text, x]) => iw(text, x, y, text.length * 4));
  const log = [
    ...row(54, [['FLIGHT', 46], ['DATE', 101], ['FROM', 163], ['TO', 199], ['REG', 236], ['TYPE', 285], ['COMMANDER', 359]]),
    ...row(65, [['TB7351', 46], ['20240307', 101], ['GMMN', 163], ['LFJL', 199], ['OOJAS', 236], ['B737-700W', 285], ['RHE', 359], ['HEYLEN', 383]]),
    ...row(87, [['OFF', 46], ['BLOCK', 71], ['15:11', 107], ['TAKE', 163], ['OFF', 193], ['15:24', 218]]),
    ...row(98, [['ON', 46], ['BLOCK', 64], ['18:17', 107], ['LANDING', 163], ['18:11', 218]]),
    ...row(109, [['BLOCK', 46], ['03:06', 107], ['FLIGHT', 163], ['02:47', 218]]),
  ];
  const crew = [...row(151, [['Crew Onboard', 51]]), ...row(174, [['CP Ann Doe [ADO], FO Bob Roe [BRO],', 51]]), ...row(219, [['Flight Times', 46]])];
  const r = parseNetlinePdf([{ page: 1, width: 595, height: 842, items: log }, { page: 2, width: 595, height: 842, items: crew }]);
  assert.equal(r.format, 'ofp');
  assert.deepEqual(r.published.map(x => [x.date, x.duty, x.registration, x.dep, x.begin, x.takeoff, x.landing, x.end, x.arr, x.ac, x.crew, x.info]), [
    ['7 Mar 24', 'TB7351', 'OOJAS', 'GMMN', '15:11 Z', '15:24 Z', '18:11 Z', '18:17 Z', 'LFJL', 'B737-700W', '[CP - ADO - Ann Doe][FO - BRO - Bob Roe]', '[Block: 03:06] [Flight: 02:47]'],
  ]);
  const plan = [
    ...row(223, [['TOM2313', 21], ['DATE', 70], ['DEP', 104], ['STD', 123], ['DES', 145], ['STA', 169], ['REG', 194], ['TYPE', 224], ['OFP REV', 264]]),
    ...row(232, [['DESTINATION ALTERNATE', 300]]),
    ...row(239, [['TOM9HM', 21], ['20240508', 70], ['LIPX', 104], ['2320', 123], ['EGCC', 145], ['0140', 169], ['G-TAWZ', 194], ['B737-800W', 224], ['3', 264]]),
  ];
  const p = parseNetlinePdf([{ page: 1, width: 595, height: 842, items: plan }]);
  assert.deepEqual(p.published.map(x => [x.date, x.duty, x.registration, x.dep, x.begin, x.end, x.arr, x.ac]), [
    ['8 May 24', 'TOM2313', 'G-TAWZ', 'LIPX', '23:20 Z', '01:40 Z +1', 'EGCC', 'B737-800W'],
  ]);
});

test('"Schedule Summary" (Crew Access): day headers, Report / Release as C/I / C/O, flights with position and flight time, deadheading, "Off (RDO)" codes, hotel', () => {
  const row = (y, cells) => cells.map(([text, x]) => iw(text, x, y, text.length * 4));
  const items = [
    ...row(9, [['Ann Doe Schedule Summary, 31 Jan - 29 Feb 2024', 14]]),
    ...row(39, [['Thu, 1', 21], ['st', 56], ['February 2024 (Local time)', 69]]),
    ...row(67, [['Off (RDO)', 17], ['00:00 - 00:00 +1', 104], ['AAA', 195]]),
    ...row(85, [['Fri, 2', 21], ['nd', 50], ['February 2024 (Local time)', 65]]),
    ...row(113, [['Report', 17], ['14:00 - 15:00', 104], ['AAA', 195]]),
    ...row(128, [['AB589', 17], ['15:00 - 17:20', 104], ['AAA - BBB', 195], ['CPT', 252], ['Trainee', 309], ['Flight Time: 2:20', 457]]),
    ...row(143, [['SV12 (Deadheading)', 17], ['18:00 - 19:00', 104], ['BBB - CCC', 195], ['FO', 252], ['Flight Time: 01:00', 457]]),
    ...row(158, [['Release', 17], ['19:00 - 19:15', 104], ['CCC', 195]]),
    ...row(173, [['Hotel', 17], ['19:45 - 08:00 +1', 104], ['CCC', 195]]),
  ];
  const r = parseNetlinePdf([{ page: 1, width: 595, height: 842, items }]);
  assert.equal(r.format, 'schedule-summary');
  assert.equal(r.period, '31Jan24 - 29Feb24');
  assert.deepEqual(r.published.map(x => [x.date, x.dc, x.duty, x.dep, x.begin, x.end, x.arr, x.info]), [
    ['1 Feb 24', '', 'RDO', 'AAA', '00:00 L', '00:00 L +1', '', '[RDO: Off]'],
    ['2 Feb 24', '', 'C/I', 'AAA', '14:00 L', '', '', ''],
    ['2 Feb 24', '', 'AB589', 'AAA', '15:00 L', '17:20 L', 'BBB', '[CPT] [Trainee] [Flight: 02:20]'],
    ['2 Feb 24', 'DH', 'SV12', 'BBB', '18:00 L', '19:00 L', 'CCC', '[FO] [Flight: 01:00]'],
    ['2 Feb 24', '', 'C/O', '', '', '19:15 L', 'CCC', ''],
    ['2 Feb 24', '', 'HT', 'CCC', '19:45 L', '08:00 L +1', '', ''],
  ]);
});

test('Crew Roster Report in port local times (SQ): Rpt as C/I, a flight reported one day and flown the next, layover lines, arrival on the next day, wrapped training codes, duty code list', () => {
  const row = (y, cells) => cells.map(([text, x]) => iw(text, x, y, text.length * 4));
  const items = [
    ...row(20, [['Crew Roster Report', 301]]), ...row(50, [['Personal Details', 60], ['From', 314], ['04Jul26', 356], ['--', 413], ['31Aug26', 433]]),
    ...row(66, [['(Times shown are in Port Local times)', 321]]),
    ...row(141, [['Start', 28], ['Day', 67], ['Flight', 99], ['Sector', 145], ['A/C', 189], ['Duty', 217], ['Pairing', 247], ['Crew', 290], ['Rpt', 328], ['STD', 356], ['STA', 387],
      ['Flight', 418], ['Duty', 458], ['Hotel', 507], ['INSTR/', 559], ['Training', 605], ['Remarks', 695]]),
    ...row(152, [['Date', 29], ['Number', 94], ['Duty', 252], ['Rank', 290], ['Time', 420], ['Time', 458], ['PUPIL', 561]]),
    ...row(171, [['07Jul26', 25], ['Tue', 67], ['SQ810', 97], ['AAA-BBB', 141], ['787', 190], ['FLY', 218], ['FO', 295], ['2330', 325], ['06:05', 419], ['7:35', 459]]),
    ...row(195, [['08Jul26', 25], ['Wed', 66], ['SQ810', 97], ['AAA-BBB', 141], ['787', 190], ['FLY', 218], ['FO', 295], ['0030', 355], ['0635', 385]]),
    ...row(219, [['BBB', 150], ['LO', 221], ['BBBHOTEL', 496]]),
    ...row(243, [['09Jul26', 25], ['Thu', 67], ['SQ811', 97], ['BBB-AAA', 141], ['787', 190], ['FLY', 218], ['FO', 295], ['2155', 325], ['2255', 355]]),
    ...row(267, [['10Jul26', 25], ['Fri', 66], ['BBB-AAA', 141], ['787', 190], ['FLY', 218], ['FO', 295], ['0525', 385]]),
    ...row(291, [['12Jul26', 25], ['Sun', 67], ['AAA', 152], ['BFTD', 212], ['FO', 295], ['0515', 325], ['0645', 355], ['1045', 385], ['6:00', 459], ['PUPIL', 561], ['737CONFP', 600]]),
    ...row(302, [['1', 230], ['T01', 615]]),
    ...row(445, [['Duty Codes', 39]]), ...row(465, [['Duty', 79], ['Duty Desc', 197]]), ...row(491, [['BFTD1', 81], ['737-FTD1', 203]]),
  ];
  const r = parseNetlinePdf([{ page: 1, width: 842, height: 595, items }]);
  assert.equal(r.format, 'port-crew-roster-report');
  assert.equal(r.period, '04Jul26 - 31Aug26');
  assert.deepEqual(r.published.map(x => [x.date, x.duty, x.dep, x.begin, x.end, x.arr, x.ac, x.info]), [
    ['7 Jul 26', 'C/I', 'AAA', '23:30 L', '', '', '', ''],
    ['8 Jul 26', 'SQ810', 'AAA', '00:30 L', '06:35 L', 'BBB', '787', '[Flight: 06:05] [Duty: 07:35]'],
    ['8 Jul 26', 'HT', 'BBB', '', '', '', '', 'BBBHOTEL'],
    ['9 Jul 26', 'C/I', 'BBB', '21:55 L', '', '', '', ''],
    ['9 Jul 26', 'SQ811', 'BBB', '22:55 L', '05:25 L +1', 'AAA', '787', ''],
    ['12 Jul 26', 'BFTD1', 'AAA', '06:45 L', '10:45 L', '', '', '[BFTD1: 737-FTD1] [Duty: 06:00] [PUPIL] [Training: 737CONFPT01]'],
  ]);
});

test('"FLIGHT LOG SUMMARY REPORT" (Jet Linx): a leg per line, aircraft from above the table, Out/Off/On/In, PIC/SIC, decimal hours and counts in info', () => {
  const row = (y, cells) => cells.map(([text, x]) => iw(text, x, y, text.length * 4));
  const items = [
    ...row(40, [['FLIGHT LOG SUMMARY REPORT', 156]]), ...row(61, [['9/15/2019 - 9/16/2019', 156]]), ...row(89, [['St. Louis', 18]]), ...row(109, [['N1JP', 18]]),
    ...row(128, [['Leg Date', 20], ['Trip #', 56], ['Reg', 88], ['PIC', 106], ['SIC', 131], ['DEP', 156], ['ARR', 179], ['Out', 210], ['Of', 233], ['On', 254], ['In', 279],
      ['Hobbs', 297], ['Flight', 322], ['Block', 345], ['Night', 367], ['IMC', 388], ['D', 407], ['N', 420], ['D', 434], ['N', 448], ['P', 463], ['N', 476], ['Pax', 522]]),
    ...row(141, [['9-15-19', 20], ['604344', 56], ['91', 88], ['JHAL', 106], ['CHUB', 131], ['KDAL', 156], ['KASE', 179], ['1422', 208], ['1428', 230], ['1616', 252], ['1622', 275],
      ['1.8', 302], ['1.8', 326], ['2.0', 349], ['0.1', 390], ['1', 408], ['1', 435], ['0', 525]]),
  ];
  const r = parseNetlinePdf([{ page: 1, width: 792, height: 612, items }]);
  assert.equal(r.format, 'flight-log-summary');
  assert.equal(r.period, '15Sep19 - 16Sep19');
  assert.deepEqual(r.published.map(x => [x.date, x.registration, x.dep, x.begin, x.takeoff, x.landing, x.end, x.arr, x.crew, x.info]), [
    ['15 Sep 19', 'N1JP', 'KDAL', '14:22 Z', '14:28 Z', '16:16 Z', '16:22 Z', 'KASE', '[PIC - JHAL][SIC - CHUB]',
      '[Trip: 604344] [FAR: 91] [Flight: 1.8] [Block: 2.0] [IMC: 0.1] [Takeoff Day: 1] [Landing Day: 1]'],
  ]);
});

test('"QATAR AIRWAYS LOGBOOK": records with wrapped PIC names (two names), "(+1)" arrival, counts and function times, an FSTD session, page totals left out', () => {
  const row = (y, cells) => cells.map(([text, x]) => iw(text, x, y, text.length * 4));
  const items = [
    ...row(35, [['QATAR AIRWAYS LOGBOOK', 633]]), ...row(69, [['01-Aug-2024 To 09-Sep-2024', 691]]),
    ...row(145, [['DATE', 41], ['DEPARTURE', 116], ['ARRIVAL', 241], ['AIRCRAFT', 347], ['MULTI', 521], ['TOTAL', 593], ['NAME(S) PIC', 656], ['TAKE OFF', 743], ['LANDINGS', 816],
      ['PILOT FUNCTION TIME', 1062], ['FSTD SESSION', 1317], ['REMARKS AND', 1475]]),
    ...row(157, [['(dd/mm/yy)', 33], ['TIME', 542]]),
    ...row(171, [['PLACE', 102], ['TIME', 165], ['PLACE', 219], ['TIME', 281], ['TYPE', 333], ['REG', 387], ['SE', 439], ['ME', 474], ['FLIGHT', 589], ['DAY', 741], ['NIGHT', 771],
      ['DAY', 814], ['NIGHT', 846], ['NIGHT', 892], ['IFR', 960], ['PIC', 1018], ['CO-PILOT', 1062], ['DUAL', 1136], ['INSTRUCTOR', 1182], ['DATE', 1275], ['TYPE', 1348], ['TOTAL', 1411]]),
    ...row(184, [['(dd/mm/yy)', 1268], ['TIME', 1414]]),
    ...row(199, [['20/08/24', 36], ['AAA', 108], ['23:04', 166], ['BBB', 225], ['13:37 (+1)', 272], ['77L', 338], ['A7-BBA', 370], ['14:33', 525], ['14:33', 598], ['DAL PONTE', 649],
      ['1', 776], ['1', 824], ['09:56', 898], ['14:33', 956], ['08:00', 1015]]),
    ...row(213, [['Nicola,DOE', 649]]), ...row(227, [['John', 649]]),
    ...row(260, [['04:00', 1205], ['21/08/24', 1271], ['B777,EU-', 1340], ['04:00', 1416]]), ...row(273, [['A0206', 1348]]),
    ...row(812, [['TOTAL', 370], ['14:33', 598], ['I certify that the', 1478]]),
  ];
  const r = parseNetlinePdf([{ page: 1, width: 1600, height: 950, items }]);
  assert.equal(r.format, 'qatar-logbook');
  assert.equal(r.period, '01Aug24 - 09Sep24');
  assert.deepEqual(r.published.map(x => [x.date, x.duty, x.dep, x.begin, x.end, x.arr, x.ac, x.registration, x.crew, x.info]), [
    ['20 Aug 24', '', 'AAA', '23:04 Z', '13:37 Z +1', 'BBB', '77L', 'A7-BBA', '[PIC - DAL PONTE Nicola][PIC - DOE John]',
      '[Flight: 14:33] [Takeoff Night: 1] [Landing Day: 1] [Night: 09:56] [IFR: 14:33] [PIC: 08:00]'],
    ['21 Aug 24', 'SIM', '', '', '', '', 'B777,EU-A0206', '', '', '[Sim: 04:00] [Instructor: 04:00]'],
  ]);
});

test('Aeromexico "ROL INDIVIDUAL DE SERVICIOS": day lines under DAY | DUTY | BLOCK DH, reserve codes from the code list, flights with pairing, terminal, next-day arrival', () => {
  const row = (y, cells) => cells.map(([text, x]) => iw(text, x, y, text.length * 4));
  const items = [
    ...row(50, [['ROL INDIVIDUAL DE SERVICIOS SEPTIEMBRE 2025', 44]]),
    ...row(192, [['DAY', 44], ['DUTY', 77], ['BLOCK DH', 371]]),
    ...row(202, [['01 Mon', 44], ['R4 AAA', 119], ['16:15', 175], ['23:59', 246]]),
    ...row(264, [['09 Tue 25002', 44], ['001 AAA', 114], ['(T2) 17:45 BBB', 152], ['04:35', 246], ['10:50 0:00', 371]]),
    ...row(274, [['12 Fri', 44], ['020 BBB', 114], ['01:00 AAA', 175], ['(T2) 12:45', 222], ['11:45 0:00', 371]]),
    ...row(419, [['LA NUEVA FECHA PARA', 44]]),
  ];
  const legend = row(90, [['R4 : RESERVA', 44]]);
  const r = parseNetlinePdf([{ page: 1, width: 842, height: 595, items }, { page: 2, width: 842, height: 595, items: legend }]);
  assert.equal(r.format, 'rol-individual');
  assert.deepEqual(r.published.map(x => [x.date, x.duty, x.dep, x.begin, x.end, x.arr, x.info]), [
    ['1 Sep 25', 'R4', 'AAA', '16:15 B', '23:59 B', '', '[R4: RESERVA]'],
    ['9 Sep 25', '001', 'AAA', '17:45 B', '04:35 B +1', 'BBB', '[Pairing: 25002] [Block: 10:50]'],
    ['12 Sep 25', '020', 'BBB', '01:00 B', '12:45 B', 'AAA', '[Block: 11:45]'],
  ]);
});

test('Ryanair flight sheet: "Key : value" records per flight, times split over items, pilot flying, captain remarks, flight deck crew on every flight', () => {
  const row = (y, cells) => cells.map(([text, x]) => iw(text, x, y, text.length * 4));
  const kv = (y, key, ...vals) => row(y, [[key, 67], [':', 140], ...vals.map((v, k) => [v, 160 + k * 6])]);
  const items = [
    ...row(136, [['2020/09/14', 67]]),
    ...kv(177, 'FlightNumber', 'FR 9141'), ...kv(198, 'Registration', 'EIEFX'), ...kv(219, 'City Pair', 'AAA - BBB'),
    ...kv(593, 'Airborne', '18', ':', '12'), ...kv(614, 'Landed', '20', ':', '20'), ...kv(635, 'Total flight', '02', ':', '08'),
    ...kv(656, 'Off Block', '18', ':', '04'), ...kv(677, 'On Block', '20', ':', '25'), ...kv(697, 'Total Block', '02', ':', '21'),
    ...kv(720, 'Take Off', 'DOEJ'), ...kv(740, 'Landing', 'DOEJ'), ...kv(760, 'Captain Remarks', 'GPU connected but no power.'),
  ];
  const crew = [...row(429, [['Flight Deck Crew', 67]]), ...row(449, [['ROEA', 67], [':', 132], ['CP', 150], [':', 182], ['ANN ROE', 200]]), ...row(533, [['E-MAIL DISCLAIMER', 67]])];
  const r = parseNetlinePdf([{ page: 1, width: 595, height: 842, items }, { page: 2, width: 595, height: 842, items: crew }]);
  assert.equal(r.format, 'flight-sheet');
  assert.deepEqual(r.published.map(x => [x.date, x.duty, x.registration, x.dep, x.begin, x.takeoff, x.landing, x.end, x.arr, x.crew, x.info]), [
    ['14 Sep 20', 'FR9141', 'EIEFX', 'AAA', '18:04 Z', '18:12 Z', '20:20 Z', '20:25 Z', 'BBB', '[CP - ROEA - ANN ROE]', '[Block: 02:21] [Flight: 02:08] [Pilot Flying: DOEJ] GPU connected but no power.'],
  ]);
});

test('Air Corsica "Programme du": three lines per event (UTC times above, local under), C/I / C/O from Checkin / Checkout, flight with registration, aircraft and crew, codes', () => {
  const at = (text, x, y) => iw(text, x, y, text.length * 4);
  const items = [
    at('Programme du 01/11/2024 au 31/01/2025', 202, 49), at('Friday 01 November 2024', 20, 79),
    ...[['Activité', 46], ['Dépar Arrivé', 101], ['Checkin', 157], ['Début', 206], ['Fin', 257], ['Checkout', 289], ['Durée', 352], ['TdV', 405], ['TdS', 450], ['Vol', 479], ['Equipe', 527]].map(([t, x]) => at(t, x, 101)),
    at('14:15', 164, 113.9), at('15:15', 208, 113.9), at('17:02', 254, 113.9), at('17:22', 299, 113.9), at('XK721', 477, 115.9), at('CDB:BRY - OPL:CAD -', 508, 114.6),
    at('FLT - XK721 - FHXKE', 24, 118.4), at('AAA', 106, 119.4), at('BBB', 131, 119.4), at('01:47', 357, 119.4), at('05:11', 402, 119.4), at('05:31', 447, 119.4), at('C/C:LWS - HST:ATL', 508, 120.6),
    at('(OPL)', 50, 125.4), at('(15:15 LOC)', 152, 123.9), at('(16:15 LOC)', 198, 123.9), at('(18:02 LOC)', 243, 123.9), at('(18:22 LOC)', 287, 123.9), at('(AT6)', 479, 122.9),
    at('23:00', 208, 155.9), at('23:59', 254, 155.9), at('BL ()', 51, 163.9), at('BBB', 106, 161.4), at('BBB', 131, 161.4), at('(00:00 LOC)', 198, 165.9),
  ];
  const r = parseNetlinePdf([{ page: 1, width: 595, height: 842, items }]);
  assert.equal(r.format, 'programme-du');
  assert.equal(r.period, '01Nov24 - 31Jan25');
  assert.deepEqual(r.published.map(x => [x.date, x.duty, x.registration, x.dep, x.begin, x.end, x.arr, x.ac, x.crew, x.info]), [
    ['1 Nov 24', 'C/I', '', 'AAA', '14:15 Z / 15:15 L', '', '', '', '', ''],
    ['1 Nov 24', 'XK721', 'FHXKE', 'AAA', '15:15 Z / 16:15 L', '17:02 Z / 18:02 L', 'BBB', 'AT6', '[CDB - BRY][OPL - CAD][C/C - LWS][HST - ATL]', '[Block: 01:47]'],
    ['1 Nov 24', 'C/O', '', '', '', '17:22 Z / 18:22 L', 'BBB', '', '', '[TdV: 05:11] [Duty: 05:31]'],
    ['1 Nov 24', 'BL', '', 'BBB', '23:00 Z / 00:00 L', '23:59 Z', '', '', '', ''],
  ]);
});

test('Month calendar print (Crew Access): days before the first month name, Report / Release, events "NCL 06:04 ~ 09:17 AGP", an event ending the next day, a wrapped end, codes', () => {
  const row = (y, cells) => cells.map(([text, x]) => iw(text, x, y, text.length * 4));
  const xs = [16, 133, 251, 369, 486, 604, 722];
  const items = [
    ...row(6, [['May 2025', 8]]),
    ...row(52, ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'].map((d, k) => [d, xs[k] + 4])),
    ...row(86, ['28', '29', 'Apr. 30', '1', '2', '3', '4'].map((d, k) => [d, xs[k]])),
    ...row(110, [['LV', 15], ['Report', 250], ['07:30', 274], ['AAA', 298], ['Report', 368], ['13:15', 392], ['AAA', 416]]),
    ...row(120, [['CFL', 250], ['AAA 07:30', 266], ['~ 09:30 AAA', 303], ['XX553', 368], ['AAA 14:15', 391], ['XX554', 486], ['BBB ~ 00:44 AAA', 509]]),
    ...row(128, [['~ 18:31 BBB', 368]]),
    ...row(136, [['Release', 250], ['09:30', 279], ['AAA', 303], ['XX554', 368], ['BBB 20:01 ~ AAA', 391], ['Release', 486], ['00:44', 515], ['AAA', 539]]),
  ];
  const r = parseNetlinePdf([{ page: 1, width: 842, height: 595, items }]);
  assert.equal(r.format, 'month-calendar');
  assert.deepEqual(r.published.map(x => [x.date, x.duty, x.dep, x.begin, x.end, x.arr]), [
    ['28 Apr 25', 'LV', '', '', '', ''],
    ['30 Apr 25', 'C/I', 'AAA', '07:30 L', '', ''],
    ['30 Apr 25', 'CFL', 'AAA', '07:30 L', '09:30 L', 'AAA'],
    ['30 Apr 25', 'C/O', '', '', '09:30 L', 'AAA'],
    ['1 May 25', 'C/I', 'AAA', '13:15 L', '', ''],
    ['1 May 25', 'XX553', 'AAA', '14:15 L', '18:31 L', 'BBB'],
    ['1 May 25', 'XX554', 'BBB', '20:01 L', '00:44 L +1', 'AAA'],
    ['2 May 25', 'C/O', '', '', '00:44 L', 'AAA'],
  ]);
});

test('a month as a line per day (Edelweiss): C/I, the day\'s flights as one row with route and block, C/O with duty time; CI: / CO: over midnight; day codes', () => {
  const row = (y, cells) => cells.map(([text, x]) => iw(text, x, y, text.length * 4));
  const items = [
    ...row(12, [['Ann Doe | 102732 | May - 2024', 28]]),
    ...row(31, [['DATE', 32], ['DUTY', 76], ['ROUTE', 136], ['DETAILS', 213], ['START/END (LT)', 313], ['STD / STA (UTC)', 363], ['POS', 413], ['POS TIME (LT)', 464], ['CHECK-IN /', 514],
      ['BLOCK OFF / ON', 564], ['A/C', 614], ['BLOCK', 637], ['BH 28', 667], ['DUTY', 697], ['DH 7', 727]]),
    ...row(55, [['01.05.2024', 32], ['OFF', 76], ['-', 363], ['-', 564], ['-', 637], ['37:38', 667], ['-', 697], ['22:30', 727]]),
    ...row(66, [['02.05.2024', 32], ['130-131', 76], ['AAA-BBB-AAA', 136], ['05:50-17:30', 313], ['04:50-15:00', 363], ['03:50-15:30', 514], ['-', 564], ['320', 614], ['09:20', 637],
      ['44:14', 667], ['11:40', 697], ['34:10', 727]]),
    ...row(77, [['03.05.2024', 32], ['OFF', 76], ['GAV', 213]]),
  ];
  const r = parseNetlinePdf([{ page: 1, width: 842, height: 595, items }]);
  assert.equal(r.format, 'day-line-roster');
  assert.equal(r.period, '01May24 - 31May24');
  assert.deepEqual(r.published.map(x => [x.date, x.duty, x.dep, x.begin, x.end, x.arr, x.ac, x.info]), [
    ['1 May 24', 'OFF', '', '', '', '', '', ''],
    ['2 May 24', 'C/I', 'AAA', '03:50 Z / 05:50 L', '', '', '', ''],
    ['2 May 24', '130-131', 'AAA', '04:50 Z', '15:00 Z', 'AAA', '320', '[Route: AAA-BBB-AAA] [Block: 09:20]'],
    ['2 May 24', 'C/O', '', '', '15:30 Z / 17:30 L', 'AAA', '', '[Duty: 11:40]'],
    ['3 May 24', 'OFF', '', '', '', '', '', '[GAV]'],
  ]);
});

test('"MONTH PLAN" detail duty plan: legs above the day with flight numbers under, a leg over midnight, standby and day-off texts', () => {
  const row = (y, cells) => cells.map(([text, x]) => iw(text, x, y, text.length * 4));
  const items = [
    ...row(31, [['MONTH', 182], ['PLAN', 231], ['01/09', 272], ['-', 309], ['30/09/2025', 316]]),
    ...row(206, [['Detail', 51], ['duty', 69], ['plan', 84]]),
    ...row(217, [['1135', 96], ['AAA', 112], ['==>', 127], ['1235', 139], ['BBB', 155], ['1310', 217], ['BBB', 232], ['==>', 245], ['1405', 257], ['AAA', 273]]),
    ...row(221, [['31.', 52]]), ...row(224, [['VN1806', 119], ['VN1807', 240]]),
    ...row(273, [['---', 113], ['Dayoff', 121], ['---', 142]]), ...row(276, [['1.', 54]]), ...row(279, [['Day', 77], ['OFF', 90]]),
    ...row(298, [['2305', 96], ['AAA', 112], ['==>', 127], ['BBB', 155], ['...', 170]]), ...row(302, [['2.', 54]]), ...row(305, [['VN0154', 119]]),
    ...row(317, [['...', 96], ['AAA', 112], ['==>', 127], ['0030', 139], ['BBB', 155]]), ...row(321, [['3.', 54]]), ...row(324, [['VN0154', 119]]),
    ...row(340, [['4.', 52], ['Standby', 94], ['C', 119], ['(0900', 124], ['--', 144], ['1700', 150], [')', 166]]),
  ];
  const r = parseNetlinePdf([{ page: 1, width: 595, height: 842, items }]);
  assert.equal(r.format, 'month-plan-detail');
  assert.deepEqual(r.published.map(x => [x.date, x.duty, x.dep, x.begin, x.end, x.arr, x.info]), [
    ['31 Aug 25', 'VN1806', 'AAA', '11:35 L', '12:35 L', 'BBB', ''],
    ['31 Aug 25', 'VN1807', 'BBB', '13:10 L', '14:05 L', 'AAA', ''],
    ['1 Sep 25', 'Dayoff', '', '', '', '', '[Day OFF]'],
    ['2 Sep 25', 'VN0154', 'AAA', '23:05 L', '00:30 L +1', 'BBB', ''],
    ['4 Sep 25', 'Standby C', '', '09:00 L', '17:00 L', '', ''],
  ]);
});

test('logbook prints: "Pilot Log Book Report" (wrapped co-pilot names), "Logbook" sequences ("Aug 6, 2024 09:34 AM"), a leg export with up to six crew', () => {
  const row = (y, cells) => cells.map(([text, x]) => iw(text, x, y, text.length * 4));
  const p = [
    ...row(34, [['Pilot Log Book Report', 436]]), ...row(59, [['From: 23-Feb-2019 To 02-Apr-2021', 443]]),
    ...row(163, [['#', 19], ['Date', 28], ['Flt No', 81], ['Dep Stn', 119], ['Dep Time', 157], ['Arr Stn', 202], ['Arr', 244], ['Time', 263], ['A/C', 289], ['Type', 308], ['A/C', 338], ['Reg', 357],
      ['Name', 376], ['Of PIC', 400], ['Co-Pilot', 435], ['Name', 479], ['Block', 509], ['PIC', 547], ['Night', 808], ['Take Off', 879], ['Landings', 971]]),
    ...row(172, [['Hrs', 509], ['Day', 846], ['Night', 898], ['Day', 951], ['Night', 989]]),
    ...row(213, [['4', 19], ['12-07-2019', 28], ['QR', 81], ['193', 95], ['AAA', 119], ['22:10', 157], ['BBB', 202], ['02:51', 244], ['77W', 289], ['A7-BAK', 339], ['Self', 377],
      ['DOE', 437], ['06:41', 511], ['06:41', 549], ['00:00', 810], ['1', 848], ['0', 900], ['1', 952], ['0', 990]]),
    ...row(222, [['(+1)', 244], ['Ann', 437]]), ...row(233, [['(60018', 437], ['-', 470], ['FO)', 480]]),
  ];
  const r = parseNetlinePdf([{ page: 1, width: 1100, height: 800, items: p }]);
  assert.equal(r.format, 'pilot-logbook-report');
  assert.deepEqual(r.published.map(x => [x.date, x.duty, x.dep, x.begin, x.end, x.arr, x.ac, x.registration, x.crew, x.info]), [
    ['12 Jul 19', 'QR193', 'AAA', '22:10 Z', '02:51 Z +1', 'BBB', '77W', 'A7-BAK', '[PIC - Self][FO - 60018 - DOE Ann]', '[Block: 06:41] [PIC: 06:41] [Takeoff Day: 1] [Landing Day: 1]'],
  ]);
  const s = [
    ...row(30, [['Logbook', 34]]),
    ...row(50, [['YEAR', 54], ['SeqDate', 97], ['Seq', 175], ['EmpSeat', 230], ['Eq', 297], ['EQCode', 340], ['Flt', 405], ['DepSta', 453], ['ArrSta', 513], ['Out Dt Time', 567], ['InDtTime', 701],
      ['DH', 835], ['AcNum', 874], ['FLY', 934], ['PAX', 1072], ['Distance', 1138]]),
    ...row(89, [['2024', 66], ['05Aug2024', 97], ['31082', 175], ['FO', 230], ['320', 297], ['92', 340], ['2205', 405], ['AAA', 453], ['BBB', 513], ['Aug 6, 2024 11:34 PM', 567],
      ['Aug 7, 2024 01:00 AM', 701], ['N809', 874], ['1:26', 934], ['84', 1080], ['337', 1162]]),
  ];
  const q = parseNetlinePdf([{ page: 1, width: 1200, height: 800, items: s }]);
  assert.equal(q.format, 'sequence-logbook');
  assert.deepEqual(q.published.map(x => [x.date, x.duty, x.registration, x.dep, x.begin, x.end, x.arr, x.ac, x.info]), [
    ['6 Aug 24', '2205', 'N809', 'AAA', '23:34 L', '01:00 L +1', 'BBB', '320', '[Seq: 31082] [Flight: 1:26] [Pax: 84] [Distance: 337]'],
  ]);
  const e = [
    ...row(294, [['938829.logbook_20260320-20260601', 1079]]),
    ...row(320, [['E', 292], ['ff', 299], ['ectivePeriod', 305], ['SequenceNumber', 374], ['OriginationDate', 469], ['Seat', 604], ['LegNumber', 634], ['FlightNumber', 699], ['CrewId1', 773],
      ['CrewSeat1', 821], ['CrewName1', 882], ['CrewId2', 1014], ['CrewSeat2', 1062], ['CrewName2', 1123], ['DepartureStation', 1915], ['ArrivalStation', 2006]]),
    ...row(340, [['202605', 332], ['9604', 439], ['26/05/2026 00:00:00 +00:00', 469], ['FO', 604], ['4', 685], ['2092', 743], ['772493', 779], ['CA', 821], ['Roe, Ann', 882],
      ['938829', 1020], ['FO', 1062], ['Doe, Bob', 1123], ['AAA', 1915], ['BBB', 2006]]),
  ];
  const x = parseNetlinePdf([{ page: 1, width: 2100, height: 800, items: e }]);
  assert.equal(x.format, 'crew-leg-export');
  assert.deepEqual(x.published.map(y => [y.date, y.duty, y.dep, y.arr, y.crew, y.info]), [
    ['26 May 26', '2092', 'AAA', 'BBB', '[CA - 772493 - Roe, Ann][FO - 938829 - Doe, Bob]', '[Seq: 9604] [Leg: 4]'],
  ]);
});

test('"Carnet de vol" (actual times, type - registration, decimal hours) and a START / END DATE logbook (three lines per flight)', () => {
  const row = (y, cells) => cells.map(([text, x]) => iw(text, x, y, text.length * 4));
  const carnet = [
    ...row(26, [['Carnet de vol', 20]]), ...row(48, [['Du 01 mai 22 Au 30 juin 25', 20]]), ...row(142, [['Programmé', 275], ['Réel', 550]]),
    ...row(152, [['Avion', 31], ['Vol', 102], ['Départ', 145], ['Arrivée', 187], ['Fonc.', 230]]),
    ...row(162, [['Début', 275], ['Fin', 359], ['Total', 445], ['Jour', 479], ['Nuit', 513], ['Début', 550], ['Fin', 634], ['Total', 720], ['Jour', 754], ['Nuit', 788]]),
    ...row(205, [['223 - FOTER', 31], ['UU612', 102], ['AAA', 145], ['BBB', 187], ['OBS', 230], ['08/07/2022 14:05', 275], ['08/07/2022 15:25', 359], ['1,33', 445], ['0,6', 479], ['0,73', 513],
      ['08/07/2022 23:04', 550], ['09/07/2022 00:33', 634], ['1,48', 720], ['0,61', 754], ['0,87', 788]]),
  ];
  const c = parseNetlinePdf([{ page: 1, width: 842, height: 595, items: carnet }]);
  assert.equal(c.format, 'carnet-de-vol');
  assert.equal(c.period, '01May22 - 30Jun25');
  assert.deepEqual(c.published.map(x => [x.date, x.duty, x.registration, x.dep, x.begin, x.end, x.arr, x.ac, x.info]), [
    ['8 Jul 22', 'UU612', 'FOTER', 'AAA', '23:04 Z', '00:33 Z +1', 'BBB', '223', '[Function: OBS] [Total: 1,48] [Night: 0,87]'],
  ]);
  const log = [
    ...row(34, [['START', 18], ['END', 51], ['AIRCRAFT', 113], ['DAY', 321], ['NIGHT', 352]]),
    ...row(37, [['MAKE AND', 76], ['FROM', 146], ['TO', 168], ['DURATION', 185], ['MULTI-', 266], ['JET', 297], ['OF FLIGHT', 386], ['FLIGHT ACTUAL', 427], ['FLIGHT CROSS', 480], ['CHECKIN', 526], ['CHECKOUT', 555]]),
    ...row(40, [['DATE', 19], ['DATE', 49], ['IDENT', 119], ['LANDINGS', 313], ['PILOT IN', 599], ['SECOND IN', 643], ['TIME DUAL', 688], ['FLIGHT', 740], ['REMARKS AND', 784]]),
    ...row(43, [['MODEL', 81], ['OF FLIGHT', 185], ['NIGHT', 391]]),
    ...row(56, [['26/02/2018', 15], ['27/02/2018', 44]]),
    ...row(59, [['E179', 85], ['PR-AZC', 118], ['AAA', 149], ['BBB', 167], ['02:06', 194], ['02:06', 270], ['02:06', 296], ['0', 325], ['1', 359], ['02:06', 394], ['02:06', 443], ['FO', 654], ['4455', 798]]),
    ...row(62, [['22:07', 21], ['00:13', 50]]),
  ];
  const l = parseNetlinePdf([{ page: 1, width: 842, height: 595, items: log }]);
  assert.equal(l.format, 'start-end-logbook');
  assert.deepEqual(l.published.map(x => [x.date, x.duty, x.registration, x.dep, x.begin, x.end, x.arr, x.ac, x.info]), [
    ['26 Feb 18', '4455', 'PR-AZC', 'AAA', '22:07 Z', '00:13 Z +1', 'BBB', 'E179', '[Total: 02:06] [Landing Night: 1] [Night: 02:06] [IFR: 02:06] [Function: FO]'],
  ]);
});

test('Crew Access schedule summary with crew lists (local times): Check-In / Release, flights with scheduled times above and actual under, "/ +1", deadhead (TVL), hotel', () => {
  const row = (y, cells) => cells.map(([text, x]) => iw(text, x, y, text.length * 4));
  const items = [
    ...row(17, [['Crew Access', 18]]), ...row(43, [['Crew Access', 18], ['All activities times are in their local time timezone', 343]]),
    ...row(306, [['Tue, 6th Aug 2024', 18], ['(AAA)', 145]]),
    ...row(334, [['Check-In', 27], ['23:00', 148], ['-', 180], ['00:23', 189], ['/', 215], ['+1', 220], ['AAA', 278]]),
    ...row(360, [['00:30', 148], ['/', 175], ['+1', 179], ['-', 197], ['02:25', 205], ['/', 232], ['+1', 236]]),
    ...row(367, [['SV', 27], ['323', 40], ['(', 67], ['TVL', 70], [')', 89], ['AAA > BBB', 278], ['Position:', 360], ['CA', 404], ['Flight Time:', 450], ['2h 27m', 509]]),
    ...row(373, [['(', 148], ['00:23', 152], ['/', 178], ['+1', 183], ['-', 200], ['01:50', 209], ['/', 235], ['+1', 240], [')', 252]]),
    ...row(520, [['Release', 27], ['01:50', 148], ['/', 175], ['+1', 179], ['-', 197], ['02:20', 205], ['/', 232], ['+1', 236], ['BBB', 278]]),
    ...row(560, [['Fri, 9th Aug 2024', 18], ['(BBB)', 137]]),
    ...row(588, [['Grand Hotel', 360]]),
    ...row(600, [['Hotel', 27], ['15:15', 148], ['-', 180], ['14:20', 189], ['/', 215], ['+1', 220]]),
  ];
  const r = parseNetlinePdf([{ page: 1, width: 595, height: 842, items }]);
  assert.equal(r.format, 'crew-access-detail');
  assert.deepEqual(r.published.map(x => [x.date, x.dc, x.duty, x.dep, x.begin, x.end, x.arr, x.info]), [
    ['6 Aug 24', '', 'C/I', 'AAA', '23:00 L', '', '', ''],
    ['6 Aug 24', 'DH', 'SV323', 'AAA', '00:30 L +1', '02:25 L +1', 'BBB', '[Position: CA] [Flight: 02:27] [Actual: 00:23 +1 - 01:50 +1]'],
    ['6 Aug 24', '', 'C/O', '', '', '02:20 L +1', 'BBB', ''],
    ['9 Aug 24', '', 'HT', 'BBB', '15:15 L', '14:20 L +1', '', 'Grand Hotel'],
  ]);
});

test('Flightworx table of days: Off Duty, a day of flights with the day and aircraft centred, crew over three lines, the duty line for C/I and C/O, standby', () => {
  const row = (y, cells) => cells.map(([text, x]) => iw(text, x, y, text.length * 4));
  const items = [
    ...row(14, [['All times in station local time', 29]]), ...row(109, [['MONTH', 66], ['AUGUST', 226], ['YEAR', 389], ['2020', 502]]),
    ...row(145, [['Check', 151], ['Check', 390]]),
    ...row(149, [['Day', 47], ['Aircraft Type', 86], ['Description', 259], ['Function', 425], ['Crew', 487], ['Block', 535]]),
    ...row(174, [['26 Aug Wed', 36], ['Off Duty', 238], ['MLA', 330]]),
    ...row(653, [['AMS-CGA-', 479]]),
    ...row(661, [['MMO030', 224], ['11:50', 265], ['MLA', 298], ['OTP', 330], ['15:20', 360], ['FO', 440], ['MRM / GMA-', 476], ['02:30', 538]]),
    ...row(669, [['SCE', 490]]), ...row(677, [['A320 9H-AEO', 90]]), ...row(685, [['27 Aug Thu', 36]]),
    ...row(693, [['MMO031', 224], ['16:20', 265], ['OTP', 298], ['MLA', 330], ['17:50', 360], ['18:20', 394], ['FO', 440], ['02:30', 538]]),
    ...row(718, [['10:20', 155], ['MMO030/MMO031', 204], ['10:20', 297], ['MLA', 330], ['18:20', 360]]),
    ...row(737, [['28 Aug Fri', 38], ['09:00', 155], ['Home STBY 1000-1600Z', 194], ['09:00', 297], ['MLA', 330], ['15:00', 360], ['15:00', 394]]),
  ];
  const r = parseNetlinePdf([{ page: 1, width: 595, height: 842, items }]);
  assert.equal(r.format, 'day-table-roster');
  assert.equal(r.period, '01Aug20 - 31Aug20');
  assert.deepEqual(r.published.map(x => [x.date, x.duty, x.registration, x.dep, x.begin, x.end, x.arr, x.ac, x.crew, x.info]), [
    ['26 Aug 20', 'Off Duty', '', 'MLA', '', '', '', '', '', ''],
    ['27 Aug 20', 'C/I', '', 'MLA', '10:20 L', '', '', '', '', ''],
    ['27 Aug 20', 'MMO030', '9H-AEO', 'MLA', '11:50 L', '15:20 L', 'OTP', 'A320', '[Crew - AMS-CGA-MRM / GMA-SCE]', '[Function: FO] [Block: 02:30]'],
    ['27 Aug 20', 'MMO031', '9H-AEO', 'OTP', '16:20 L', '17:50 L', 'MLA', 'A320', '', '[Function: FO] [Block: 02:30]'],
    ['27 Aug 20', 'C/O', '', '', '', '18:20 L', 'MLA', '', '', ''],
    ['28 Aug 20', 'Home STBY 1000-1600Z', '', 'MLA', '09:00 L', '15:00 L', '', '', '', ''],
  ]);
});

test('Crew Access print with a character an item ("/" printed as "7": "04:007+1"), OCR slips ("O1", "Wed1st", "SSALEC", "Oh 58m"), activities with their code', () => {
  // a line as single characters touching each other
  const chars = (y, x0, text) => [...text].map((c, k) => (c === ' ' ? null : iw(c, x0 + k * 4, y, 4))).filter(Boolean);
  const row = (y, cells) => cells.map(([text, x]) => iw(text, x, y, text.length * 4));
  const text = [
    ...row(14, [['CrewAccess', 39], ['All activties times are in ther Jocal time timeZone', 366]]),
    ...chars(60, 39, 'Sat, 11th Oct 2025 (CNF)'),
    ...chars(84, 47, 'Leave'), ...chars(84, 154, '04:00 - 04:007+1'), ...chars(84, 268, 'CNF'), ...chars(84, 341, 'Position: CA'), ...chars(84, 421, 'Activity Code: P-FER'),
  ];
  const ocr = [
    ...row(13, [['Wed1st', 39], ['Oct', 88], ['2025', 115], ['(CNF)', 150]]),
    ...row(107, [['14:30', 153], ['-', 181], ['15:40', 190]]),
    ...row(113, [['AD4950', 46], ['SSALEC', 269], ['Position:', 340], ['CA', 384], ['Flight', 421], ['Time:', 452], ['Oh', 478], ['58m', 491]]),
    ...row(120, [['(14:25-15:37)', 154]]),
  ];
  const r = parseNetlinePdf([{ page: 1, width: 612, height: 792, items: text }, { page: 2, width: 612, height: 792, items: ocr, ocr: true }]);
  assert.equal(r.format, 'crew-access-detail');
  assert.deepEqual(r.published.map(x => [x.date, x.duty, x.dep, x.begin, x.end, x.arr, x.info]), [
    ['11 Oct 25', 'P-FER', 'CNF', '04:00 L', '04:00 L +1', '', '[P-FER: Leave] [Position: CA]'],
    ['1 Oct 25', 'AD4950', 'SSA', '14:30 L', '15:40 L', 'LEC', '[Position: CA] [Flight: 00:58] [Actual: 14:25 - 15:37]'],
  ]);
});

test('Azul "Minha Escala" read by OCR: three-line date cells, C/I / flight / C/O, deadhead (DHD), crew names beside their function, layover', () => {
  const row = (y, cells) => cells.map(([text, x]) => iw(text, x, y, text.length * 8));
  const items = [
    ...row(84, [['Minha', 493], ['Escala', 635]]),
    ...row(171, [['Activty', 60], ['Checkin', 169], ['Start', 271], ['End', 364], ['Checkout', 433], ['Dep', 558], ['Arr', 646], ['AcVer', 713], ['DD/CAT', 791], ['CreWs', 1022]]),
    ...row(205, [['CreW', 972], ['Function', 1120]]),
    ...row(237, [['ROE', 936], ['CA', 1156]]), ...row(265, [['DOE', 963]]), ...row(269, [['FO', 1156]]),
    ...row(335, [['28', 176], ['JUN', 213], ['28JUN', 262], ['28', 346], ['JUN', 383], ['28', 446], ['JUN', 484]]),
    ...row(356, [['AD4505', 59], ['2024', 185], ['2024', 275], ['2024', 359], ['2024', 456], ['AAA', 561], ['BBB', 643], ['295', 728], ['DHD', 810]]),
    ...row(382, [['05:30', 183], ['06:06', 272], ['07:06', 355], ['07:36', 454]]),
    ...row(987, [['28', 264], ['JUN', 301], ['29', 347], ['JUN', 384]]),
    ...row(1012, [['Layover', 62], ['2024', 275], ['2024', 359], ['BBB', 561], ['BBB', 644]]),
    ...row(1033, [['07:36', 272], ['07:10', 353]]),
  ];
  const r = parseNetlinePdf([{ page: 1, width: 1275, height: 12314, items, ocr: true }]);
  assert.equal(r.format, 'minha-escala');
  assert.deepEqual(r.published.map(x => [x.date, x.dc, x.duty, x.dep, x.begin, x.end, x.arr, x.ac, x.crew]), [
    ['28 Jun 24', '', 'C/I', 'AAA', '05:30 Z', '', '', '', ''],
    ['28 Jun 24', 'DH', 'AD4505', 'AAA', '06:06 Z', '07:06 Z', 'BBB', '295', '[CA - ROE][FO - DOE]'],
    ['28 Jun 24', '', 'C/O', '', '', '07:36 Z', 'BBB', '', ''],
    ['28 Jun 24', '', 'HT', 'BBB', '07:36 Z', '07:10 Z +1', '', '', ''],
  ]);
});

test('LATAM "Roster Report": header over three lines, an arrival wrapped round its line, a day off over midnight, C/I / flights / C/O of a duty', () => {
  const row = (y, cells) => cells.map(([text, x]) => iw(text, x, y, text.length * 4));
  const items = [
    ...row(35, [['Roster Report', 35]]), ...row(38, [['01-Jul-2024 to 31-Jul-2024', 263]]),
    ...row(64, [['Duty', 246], ['Overridde', 351], ['Work', 409], ['Dep Stn / Dep', 492], ['Arr. Stn /', 576], ['Duty', 692], ['Flying', 738], ['Duty', 775], ['A/C', 884]]),
    ...row(69, [['Date', 40], ['Pairing/Activity', 140], ['Item', 306], ['ACY Rep', 440], ['ACY Deb', 630], ['SDC', 834], ['Hotel', 951]]),
    ...row(75, [['Report', 239], ['n Rank', 355], ['Type', 407], ['Time', 509], ['Arr. Time', 572], ['Debrief', 684], ['Hrs', 741], ['Hrs', 770], ['Type', 879]]),
    ...row(91, [['GIG', 566], ['11:44(+1)', 681]]),
    ...row(96, [['30-Jun-2024', 38], ['DO', 123], ['11:45', 233], ['GIG 11:45', 491], ['0:00', 778]]),
    ...row(102, [['11:44(+1)', 566]]),
    ...row(115, [['LA3349/030724/JJFC', 123]]),
    ...row(120, [['03-Jul-2024', 38], ['16:10', 233], ['LA3349', 291], ['OP', 406], ['GIG 16:55', 491], ['GRU 18:10', 566], ['01:15', 735], ['09:10', 778], ['319', 878]]),
    ...row(126, [['320-P', 123]]),
    ...row(202, [['LA4570', 291], ['OP', 406], ['GRU 20:35', 491], ['FLN 21:55', 566], ['01:20', 735], ['320', 878]]),
    ...row(221, [['GRU', 566], ['01:20(+1)', 681]]),
    ...row(226, [['LA4571', 291], ['OP', 406], ['FLN 23:30', 491], ['01:20', 735], ['320', 878]]),
    ...row(232, [['00:50(+1)', 566]]),
  ];
  const r = parseNetlinePdf([{ page: 1, width: 1500, height: 750, items }]);
  assert.equal(r.format, 'latam-roster-report');
  assert.equal(r.period, '01Jul24 - 31Jul24');
  assert.deepEqual(r.published.map(x => [x.date, x.duty, x.dep, x.begin, x.end, x.arr, x.ac, x.info]), [
    ['30 Jun 24', 'DO', 'GIG', '11:45 L', '11:44 L +1', '', '', ''],
    ['3 Jul 24', 'C/I', 'GIG', '16:10 L', '', '', '', '[Duty: 09:10]'],
    ['3 Jul 24', 'LA3349', 'GIG', '16:55 L', '18:10 L', 'GRU', '319', '[Block: 01:15]'],
    ['3 Jul 24', 'LA4570', 'GRU', '20:35 L', '21:55 L', 'FLN', '320', '[Block: 01:20]'],
    ['3 Jul 24', 'LA4571', 'FLN', '23:30 L', '00:50 L +1', 'GRU', '320', '[Block: 01:20]'],
    ['3 Jul 24', 'C/O', '', '', '01:20 L +1', 'GRU', '', ''],
  ]);
});

test('JAL "CREW SCHEDULE LIST": a simulator duty (briefing "---", SIM with the other crew, debriefing), a day of flights, a day off', () => {
  const row = (y, cells) => cells.map(([text, x]) => iw(text, x, y, text.length * 4));
  const items = [
    ...row(31, [['CREW SCHEDULE LIST（LATEST）', 339]]), ...row(59, [['PERIOD', 13], ['2025/04/01 - 2025/04/30', 102]]), ...row(85, [['STAFF NO.', 13], ['04241', 102]]),
    ...row(146, [['TIME', 303], ['CREW', 508], ['DETAIL INFO', 708]]), ...row(157, [['LOCAL', 36], ['FLT NO.', 133]]), ...row(160, [['DUTY', 93], ['PORT', 183]]),
    ...row(164, [['DATE', 38], ['FLEET', 136], ['REPORT', 225], ['DEP', 280], ['ARV', 330], ['DUTY END', 371], ['STAFF NO.', 422]]),
    ...row(169, [['NAME', 536], ['PLACE', 634], ['EVENT', 741]]),
    ...row(331, [['06APR', 33], ['NRT', 183], ['04:00', 224], ['04:00', 274], ['05:00', 324]]),
    ...row(335, [['---', 93], ['KZT/ROM', 627], ['INSTR', 679], ['BRFG', 715]]), ...row(340, [['(Sun)', 33], ['(19:00-1)', 215]]),
    ...row(354, [['NRT', 183], ['05:00', 274], ['07:00', 324], ['04241', 426]]),
    ...row(358, [['SIM', 93], ['NOBUYUKI HASEGAWA', 470], ['KZT/SIM2', 625], ['INSTR', 679], ['CBTA AM2 SBT', 715]]), ...row(363, [['(20:00-1)', 265], ['LAC/CAT3', 420]]),
    ...row(377, [['03694', 426]]), ...row(381, [['YUKITOSHI NAKAJIMA', 470], ['KZT/SIM2', 625], ['PUPIL', 679], ['CBTA AM2 SBT', 715]]),
    ...row(423, [['NRT', 183], ['09:00', 274], ['10:00', 324], ['10:00', 374]]), ...row(427, [['---', 93], ['KZT/ROM', 627], ['INSTR', 679], ['DE-BRFG', 715]]), ...row(432, [['(00:00)', 269]]),
    ...row(600, [['11APR', 33], ['KZ0225', 132], ['NRT', 183], ['08:50', 224], ['10:30', 274], ['12:50', 324], ['04241', 426]]),
    ...row(604, [['CAP', 93], ['NOBUYUKI HASEGAWA', 470]]), ...row(609, [['(Fri)', 33], ['748', 138], ['PVG', 183], ['(23:50-1)', 215]]),
    ...row(623, [['04080', 426]]), ...row(627, [['COP', 93], ['MISAKI ONISHI', 470]]),
    ...row(646, [['KZ0226', 132], ['PVG', 183], ['15:20', 274], ['19:20', 324], ['20:20', 374], ['04241', 426]]),
    ...row(650, [['CAP', 93], ['NOBUYUKI HASEGAWA', 470]]), ...row(655, [['748', 138], ['NRT', 183], ['(07:20)', 269]]),
    ...row(669, [['04080', 426]]), ...row(673, [['COP', 93], ['MISAKI ONISHI', 470]]),
    ...row(700, [['12APR', 33], ['NRT', 183]]), ...row(704, [['OFF', 93]]), ...row(709, [['(Sat)', 33]]),
  ];
  const r = parseNetlinePdf([{ page: 1, width: 842, height: 1190, items }]);
  assert.equal(r.format, 'crew-schedule-list');
  assert.equal(r.period, '01Apr25 - 30Apr25');
  assert.deepEqual(r.published.map(x => [x.date, x.duty, x.dep, x.begin, x.end, x.arr, x.ac, x.crew, x.info]), [
    ['6 Apr 25', 'C/I', 'NRT', '04:00 L', '', '', '', '', ''],
    ['6 Apr 25', 'BRFG', 'NRT', '04:00 L', '05:00 L', '', '', '', '[Place: KZT/ROM] [Part: INSTR]'],
    ['6 Apr 25', 'SIM', 'NRT', '05:00 L', '07:00 L', '', '', '[PUPIL - 03694 - YUKITOSHI NAKAJIMA]', '[Place: KZT/SIM2] [Part: INSTR] [Event: CBTA AM2 SBT]'],
    ['6 Apr 25', 'DE-BRFG', 'NRT', '09:00 L', '10:00 L', '', '', '', '[Place: KZT/ROM] [Part: INSTR]'],
    ['6 Apr 25', 'C/O', '', '', '10:00 L', 'NRT', '', '', ''],
    ['11 Apr 25', 'C/I', 'NRT', '08:50 L', '', '', '', '', ''],
    ['11 Apr 25', 'KZ0225', 'NRT', '10:30 L', '12:50 L', 'PVG', '748', '[COP - 04080 - MISAKI ONISHI]', '[Duty: CAP]'],
    ['11 Apr 25', 'KZ0226', 'PVG', '15:20 L', '19:20 L', 'NRT', '748', '[COP - 04080 - MISAKI ONISHI]', '[Duty: CAP]'],
    ['11 Apr 25', 'C/O', '', '', '20:20 L', 'NRT', '', '', ''],
    ['12 Apr 25', 'OFF', 'NRT', '', '', '', '', '', ''],
  ]);
});

test('Turkish "MONTHLY FLIGHT PROGRAM": the local-time details, flights put into the duty whose start and end take them in, the cockpit crew, a layover', () => {
  const row = (y, cells) => cells.map(([text, x]) => iw(text, x, y, text.length * 4));
  const p1 = [
    ...row(33, [['MONTHLY FLIGHT PROGRAM', 237]]), ...row(48, [['Period:', 44], ['01Jul2024 - 01Aug2024', 102]]),
    ...row(101, [['069210', 98]]), ...row(112, [['MIKO', 104]]), ...row(124, [['GYORGY', 98]]), ...row(136, [['C Typ/ Flt/Cls:', 47]]),
  ];
  const p3 = [
    ...row(33, [['MONTHLY FLIGHT PROGRAM', 237]]), ...row(48, [['Period:', 44], ['01Jul2024 - 01Aug2024', 102]]), ...row(95, [['LOCAL TIME ROSTER DETAILS', 46]]),
    ...row(128, [['Trip', 94], ['Duty', 273], ['Flight', 535], ['Dep/LT', 638], ['Arr/LT', 690], ['Cockpit', 742]]),
    ...row(142, [['DS:', 185], ['03Jul2024 12:45', 213]]),
    ...row(145, [['GYORGY MIKO (C1), LEVENT CANKAYA (C2), KUTAY', 719]]),
    ...row(150, [['DE:', 185], ['04Jul2024 03:35', 213], ['TK6397', 535], ['IST/13:45 ALG/15:15', 603]]),
    ...row(155, [['AYVALI (P6)', 719]]),
    ...row(171, [['TK6397', 535], ['ALG/18:00 MXP/20:55 -', 603]]),
    ...row(187, [['TK6397', 535], ['MXP/23:25 IST/3:05', 603], ['-', 719]]),
    ...row(214, [['DS:', 185], ['05Jul2024 08:00', 213]]), ...row(217, [['CFR', 535], ['IST/8:00 IST/23:59', 585]]), ...row(224, [['DE:', 185], ['05Jul2024 23:59', 213]]),
    ...row(342, [['DS:', 185], ['08Jul2024 00:20', 213]]),
    ...row(345, [['TK090', 535], ['IST/1:50', 597], ['ICN/17:40 BILGEHAN AKALIN (C2)', 655]]),
    ...row(352, [['DE:', 185], ['08Jul2024 18:10', 213]]),
    ...row(362, [['TK091', 535], ['ICN/23:20 IST/4:55', 597], ['-', 713]]),
    ...row(391, [['LS/LRT:', 283], ['ICN/52:10', 329]]),
    ...row(401, [['DS:', 185], ['10Jul2024 22:20', 213]]), ...row(411, [['DE:', 185], ['11Jul2024 05:25', 213]]),
  ];
  const r = parseNetlinePdf([{ page: 1, width: 1190, height: 842, items: p1 }, { page: 2, width: 1190, height: 842, items: p3 }]);
  assert.equal(r.format, 'monthly-flight-program');
  assert.equal(r.period, '01Jul24 - 01Aug24');
  assert.deepEqual(r.published.map(x => [x.date, x.duty, x.dep, x.begin, x.end, x.arr, x.crew, x.info]), [
    ['3 Jul 24', 'C/I', 'IST', '12:45 L', '', '', '', ''],
    ['3 Jul 24', 'TK6397', 'IST', '13:45 L', '15:15 L', 'ALG', '[C2 - LEVENT CANKAYA][P6 - KUTAY AYVALI]', ''],
    ['3 Jul 24', 'TK6397', 'ALG', '18:00 L', '20:55 L', 'MXP', '', ''],
    ['3 Jul 24', 'TK6397', 'MXP', '23:25 L', '03:05 L +1', 'IST', '', ''],
    ['3 Jul 24', 'C/O', '', '', '03:35 L +1', 'IST', '', ''],
    ['5 Jul 24', 'CFR', 'IST', '08:00 L', '23:59 L', '', '', ''],
    ['8 Jul 24', 'C/I', 'IST', '00:20 L', '', '', '', ''],
    ['8 Jul 24', 'TK090', 'IST', '01:50 L', '17:40 L', 'ICN', '[C2 - BILGEHAN AKALIN]', ''],
    ['8 Jul 24', 'C/O', '', '', '18:10 L', 'ICN', '', ''],
    ['8 Jul 24', 'HT', 'ICN', '', '', '', '', '[Layover: 52:10]'],
    ['10 Jul 24', 'C/I', 'ICN', '22:20 L', '', '', '', ''],
    ['10 Jul 24', 'TK091', 'ICN', '23:20 L', '04:55 L +1', 'IST', '', ''],
    ['10 Jul 24', 'C/O', '', '', '05:25 L +1', 'IST', '', ''],
  ]);
});

test('numbered pilot logbook (1 Date .. 14 Remarks): a simulator line, a flight with its type wrapped over two lines', () => {
  const row = (y, cells) => cells.map(([text, x]) => iw(text, x, y, text.length * 4));
  const items = [
    ...row(46, [['072905 JOHN DOE 14/07/2024 15:20', 32]]),
    ...row(67, [['1', 35], ['2', 81], ['13', 687], ['14', 795]]),
    ...row(82, [['AIRCRAFT', 81], ['DEPARTURE', 137], ['ARRIVAL', 191], ['SINGLE', 245], ['LANDING', 407], ['SYNTHETIC DEVICES', 687]]),
    ...row(97, [['Date', 35], ['Type', 81], ['Regist', 103], ['Dep.', 137], ['Dep.', 163], ['Arr.', 191], ['Arr.', 217], ['SE', 245], ['ME', 279], ['Multi', 310], ['Total', 341],
      ['Name of', 373], ['Landing', 407], ['Landing', 441], ['Operation', 475], ['Operation', 511], ['Function', 548], ['Function', 582], ['Function', 619], ['Instr', 653],
      ['STDS (Date)', 687], ['STDS', 733], ['STDS', 761], ['Remarks', 795]]),
    ...row(132, [['1', 18], ['09/07/2024', 35], ['IST', 137], ['11:00', 163], ['IST', 191], ['15:00', 217], ['09/07/2024', 687], ['04:00', 761]]),
    ...row(155, [['2', 18], ['10/07/2024', 35], ['O', 81], ['TCLOG', 103], ['IST', 137], ['15:56', 163], ['EWR', 191], ['03:00', 217], ['11:04', 310], ['11:04', 341], ['11:04', 511]]),
    ...row(163, [['7M', 81]]),
  ];
  const r = parseNetlinePdf([{ page: 1, width: 842, height: 595, items }]);
  assert.equal(r.format, 'numbered-logbook');
  assert.deepEqual(r.published.map(x => [x.date, x.duty, x.registration, x.dep, x.begin, x.end, x.arr, x.ac, x.info]), [
    ['9 Jul 24', 'SIM', '', 'IST', '11:00 Z', '15:00 Z', '', '', '[Sim: 04:00]'],
    ['10 Jul 24', '', 'TCLOG', 'IST', '15:56 Z', '03:00 Z +1', 'EWR', 'O7M', '[Flight: 11:04] [IFR: 11:04]'],
  ]);
});

test('day blocks in English ("Code Descr."): a day off, sign-in -> C/I, a flight with its captain, a positioning flight, a simulator with its report and release in brackets', () => {
  const row = (y, cells) => cells.map(([text, x]) => iw(text, x, y, text.length * 4));
  const items = [
    ...row(49, [['From 2024-05-01 to 2024-05-31 - UTC time', 349]]),
    ...row(102, [['Code Descr.', 12], ['Flight', 54], ['DEP-ARR', 83], ['STD - STA', 112], ['Crew', 144], ['Code Descr.', 216], ['Flight', 260], ['DEP-ARR', 287], ['STD - STA', 316], ['Crew', 349]]),
    ...row(110, [['Date:', 12], ['Wed 01-May-2024', 23]]),
    ...row(116, [['Day Off', 12], ['OFF', 54], ['0:00 -', 112], ['0:00', 126]]),
    ...row(123, [['Totals : Blq', 12], ['0:00:00', 33]]),
    ...row(133, [['Date:', 12], ['Thu 02-May-2024', 23], ['Signin:', 90], ['8:40', 104]]),
    ...row(139, [['ATM', 33], ['IB8262', 54], ['AGP-MLN', 84], ['9:40 - 10:40', 112], ['(C) BAIAO(c)', 144]]),
    ...row(146, [['UX5050', 54], ['AGP-MAD', 84], ['15:00 - 16:15', 110], ['Situación', 144]]),
    ...row(169, [['Date:', 12], ['Fri 03-May-2024', 23]]),
    ...row(176, [['ST Oper Conv Simulator', 12], ['SCOI', 54], ['[04:30]', 93], ['6:00 - 10:00', 112], ['[11:00]', 138]]),
  ];
  const r = parseNetlinePdf([{ page: 1, width: 841, height: 595, items }]);
  assert.equal(r.format, 'day-blocks');
  assert.equal(r.period, '01May24 - 31May24');
  assert.deepEqual(r.published.map(x => [x.date, x.dc, x.duty, x.dep, x.begin, x.end, x.arr, x.ac, x.crew]), [
    ['1 May 24', '', 'OFF', '', '', '', '', '', ''],
    ['2 May 24', '', 'C/I', 'AGP', '08:40 Z', '', '', '', ''],
    ['2 May 24', '', 'IB8262', 'AGP', '09:40 Z', '10:40 Z', 'MLN', 'ATM', '(C) BAIAO(c)'],
    ['2 May 24', 'DHD', 'UX5050', 'AGP', '15:00 Z', '16:15 Z', 'MAD', '', ''],
    ['3 May 24', '', 'C/I', '', '04:30 Z', '', '', '', ''],
    ['3 May 24', '', 'SCOI', '', '06:00 Z', '10:00 Z', '', '', ''],
    ['3 May 24', '', 'C/O', '', '', '11:00 Z', '', '', ''],
  ]);
});

test('fixed-width logbook text with a ruler of dashes (Cathay "Merged Logbook Records"): block / take-off / landing times, counts, commander', () => {
  const row = (y, cells) => cells.map(([text, x]) => iw(text, x, y, text.length * 6));
  const items = [
    ...row(20, [['Merged Logbook Records - from 2025-08-01 to 2025-09-01', 20]]),
    ...row(80, [['Date(UTC)', 20], ['No.', 92], ['Sector', 134], ['Reg', 194], ['Time', 230], ['Off-Blk', 272], ['Airborne', 326], ['Landing', 386], ['On-Blk Off', 446], ['Land', 518], ['Commander', 608]]),
    ...row(92, [['----------', 20], ['----', 92], ['--------', 128], ['-----', 188], ['-----', 230], ['-------', 272], ['--------', 326], ['--------', 386], ['-------', 446], ['---', 500], ['----', 530], ['----', 566], ['-------------------', 602]]),
    ...row(128, [['2025/08/01', 20], ['885', 92], ['LAX HKG', 128], ['B-HNR', 188], ['14:47', 230], ['20:17', 272], ['20:41', 326], ['10:43+1', 386], ['11:04+1', 446], ['1', 506], ['1', 542], ['N', 572], ['DOE JM', 608]]),
    ...row(140, [['2025/08/07', 20], ['882', 92], ['HKG LAX', 128], ['B-KQW', 188], ['13:03', 230], ['10:34', 272], ['10:54', 326], ['23:31', 386], ['23:37', 446], ['0', 506], ['0', 542], ['N', 572], ['ROE KJ', 608]]),
  ];
  const r = parseNetlinePdf([{ page: 1, width: 934, height: 208, items }]);
  assert.equal(r.format, 'ruler-logbook');
  assert.equal(r.period, '01Aug25 - 01Sep25');
  assert.deepEqual(r.published.map(x => [x.date, x.duty, x.registration, x.dep, x.begin, x.takeoff, x.landing, x.end, x.arr, x.crew, x.info]), [
    ['1 Aug 25', '885', 'B-HNR', 'LAX', '20:17 Z', '20:41 Z', '10:43 Z +1', '11:04 Z +1', 'HKG', '[Commander - DOE JM]', '[Block: 14:47] [Takeoff Day/Night: 1] [Landing Day/Night: 1]'],
    ['7 Aug 25', '882', 'B-KQW', 'HKG', '10:34 Z', '10:54 Z', '23:31 Z', '23:37 Z', 'LAX', '[Commander - ROE KJ]', '[Block: 13:03]'],
  ]);
});

test('Lufthansa "Acknowledged Roster": activities, a flight with report and layover, a flight over midnight printed on two days\' lines', () => {
  const row = (y, cells) => cells.map(([text, x]) => iw(text, x, y, text.length * 4));
  const items = [
    ...row(34, [['Acknowledged Roster', 44]]), ...row(54, [['Month:', 44], ['March 2026', 114]]),
    ...row(321, [['Date (LT)', 44], ['Trip ID', 77], ['Report (LT)', 105], ['Pos', 144], ['Activity', 161], ['From', 204], ['To', 226], ['Start (UTC)', 246], ['End (UTC)', 285],
      ['A/C', 320], ['Layover', 337], ['Timezone', 368], ['LSW', 406], ['BZW', 428], ['Tags', 450], ['Blocktime', 502], ['FDP', 539]]),
    ...row(372, [['01 Sun', 44], ['OFF', 168]]),
    ...row(493, [['09 Mon', 44], ['SB_F/35_FM', 161], ['MUC', 204], ['06:00', 257], ['16:00', 296]]),
    ...row(600, [['21 Sat', 44], ['103751', 77], ['14:20', 105], ['FO', 144], ['412', 168], ['MUC', 204], ['EWR', 226], ['15:10', 257], ['(22) 00:05', 285], ['35P', 320], ['24:15', 337],
      ['-04:00', 368], ['08:55', 406], ['08:55', 428], ['08:55', 502]]),
    ...row(611, [['22 Sun', 44], ['20:50', 105], ['FO', 144], ['413', 168], ['EWR', 204], ['(23) 01:50', 246], ['35P', 320]]),
    ...row(623, [['23 Mon', 44], ['FO', 144], ['413', 168], ['MUC', 226], ['09:25', 296], ['35P', 320], ['+01:00', 368], ['07:35', 406], ['07:35', 428], ['07:35', 502]]),
  ];
  const r = parseNetlinePdf([{ page: 1, width: 842, height: 595, items }]);
  assert.equal(r.format, 'acknowledged-roster');
  assert.equal(r.period, '01Mar26 - 31Mar26');
  assert.deepEqual(r.published.map(x => [x.date, x.duty, x.dep, x.begin, x.end, x.arr, x.ac, x.info]), [
    ['1 Mar 26', 'OFF', '', '', '', '', '', ''],
    ['9 Mar 26', 'SB_F/35_FM', 'MUC', '06:00 Z', '16:00 Z', '', '', ''],
    ['21 Mar 26', 'C/I', 'MUC', '14:20 L', '', '', '', ''],
    ['21 Mar 26', '412', 'MUC', '15:10 Z', '00:05 Z +1', 'EWR', '35P', '[Block: 08:55] [Pos: FO]'],
    ['21 Mar 26', 'HT', 'EWR', '', '', '', '', '[Layover: 24:15]'],
    ['22 Mar 26', 'C/I', 'EWR', '20:50 L', '', '', '', ''],
    ['23 Mar 26', '413', 'EWR', '01:50 Z', '09:25 Z', 'MUC', '35P', '[Pos: FO] [Block: 07:35]'],
  ]);
});

test('"Crew Briefing": a day off, a duty\'s start / end around its flights, the other crew from the crew lines, block hours', () => {
  const row = (y, cells) => cells.map(([text, x]) => iw(text, x, y, text.length * 4));
  const items = [
    ...row(30, [['Crew Briefing', 258]]), ...row(55, [['Doe,John', 14], ['Timed Mode:', 495], ['Local', 558]]),
    ...row(96, [['Duty : DOFF', 14]]), ...row(104, [['01-Jul-2026 00:00(L) ~ 01-Jul-2026 23:59(L)', 394]]), ...row(111, [['Duty Detail', 14]]),
    ...row(127, [['Assignment', 30], ['Location', 122], ['Date', 216], ['Start Time', 304], ['End Time', 420]]),
    ...row(140, [['DOFF', 42], ['MNL', 130], ['01-Jul-2026', 201], ['00:00', 314], ['23:59', 428], ['-', 539]]),
    ...row(188, [['Duty : 2P2043/2P2044', 14]]), ...row(202, [['Op : 10', 14], ['02-Jul-2026 14:20(L) ~ 03-Jul-2026 01:10(L)', 394]]), ...row(216, [['Duty Detail', 14]]),
    ...row(232, [['Assignment', 25], ['Flight No.', 99], ['DEP', 167], ['ARR', 218], ['STD', 269], ['STA', 320], ['Acting', 367], ['Reg No.', 420], ['Fleet', 483], ['Conx', 540]]),
    ...row(246, [['FLY', 41], ['2P2043', 103], ['MNL', 167], ['MPH', 217], ['15:50', 267], ['16:55', 317], ['CP', 373], ['RP-C8933', 415], ['320', 486], ['0:50', 542]]),
    ...row(259, [['Block Hours', 24], ['Pax Hours', 98]]), ...row(273, [['1:00', 41], ['0:00', 111]]),
    ...row(286, [['CP : Doe,John/100872/MNL/FLY', 14], ['FO : Roe,Alfe/103273/MNL/FLY', 300]]),
    ...row(334, [['Assignment', 25], ['Flight No.', 99], ['DEP', 167], ['ARR', 218], ['STD', 269], ['STA', 320]]),
    ...row(348, [['FLY', 41], ['2P2044', 103], ['MPH', 166], ['MNL', 218], ['23:05', 267], ['00:40', 317], ['CP', 373], ['RP-C8933', 415], ['320', 486]]),
    ...row(361, [['Block Hours', 24]]), ...row(375, [['1:05', 41]]), ...row(388, [['CP : Doe,John/100872/MNL/FLY', 14], ['FO : Roe,Alfe/103273/MNL/FLY', 300]]),
  ];
  const r = parseNetlinePdf([{ page: 1, width: 595, height: 842, items }]);
  assert.equal(r.format, 'crew-briefing');
  assert.deepEqual(r.published.map(x => [x.date, x.duty, x.registration, x.dep, x.begin, x.end, x.arr, x.ac, x.crew, x.info]), [
    ['1 Jul 26', 'DOFF', '', 'MNL', '00:00 L', '23:59 L', '', '', '', ''],
    ['2 Jul 26', 'C/I', '', 'MNL', '14:20 L', '', '', '', '', ''],
    ['2 Jul 26', '2P2043', 'RP-C8933', 'MNL', '15:50 L', '16:55 L', 'MPH', '320', '[FO - 103273 - Roe,Alfe]', '[Acting: CP] [Block: 1:00]'],
    ['2 Jul 26', '2P2044', 'RP-C8933', 'MPH', '23:05 L', '00:40 L +1', 'MNL', '320', '[FO - 103273 - Roe,Alfe]', '[Acting: CP] [Block: 1:05]'],
    ['2 Jul 26', 'C/O', '', '', '', '01:10 L +1', 'MNL', '', '', ''],
  ]);
});

test('LATAM "LEGAL_BR_Logbook", AIMS-converted day grid, Malaysia month roster with sectors', () => {
  const row = (y, cells) => cells.map(([text, x]) => iw(text, x, y, text.length * 4));
  const log = parseNetlinePdf([{ page: 1, width: 1000, height: 1000, items: [
    ...row(49, [['Crew ID', 12], ['is 1', 55], ['Vim Date', 133], ['is from 2024/06/01 until 2024/06/26', 185]]), ...row(244, [['LOGBOOK - LATAM Airlines', 315]]),
    ...row(443, [['Flight', 19], ['Dep', 106], ['Arr', 191], ['Reg', 277], ['Aircraft', 362], ['Function', 448], ['Vim Date', 533], ['Out Z', 619], ['In Z', 704], ['Day Time', 790], ['Night Time', 876], ['Block Time', 962]]),
    ...row(460, [['3557', 19], ['CNF', 105], ['GRU', 190], ['PT-MXC', 276], ['321', 361], ['PIC', 447], ['2024-06-04', 532], ['23:59', 618], ['01:09', 703], ['00:00', 789], ['01:10', 875], ['01:10', 961]]),
  ] }]);
  assert.equal(log.format, 'legal-br-logbook');
  assert.deepEqual(log.published.map(x => [x.date, x.duty, x.registration, x.dep, x.begin, x.end, x.arr, x.ac, x.info]), [
    ['4 Jun 24', '3557', 'PT-MXC', 'CNF', '23:59 Z', '01:09 Z +1', 'GRU', '321', '[Function: PIC] [Night: 01:10] [Block: 01:10]'],
  ]);
  const grid = parseNetlinePdf([{ page: 1, width: 842, height: 595, items: [
    ...row(28, [['Escala de Tripulante Convertida para padrão AIMS', 285]]), ...row(41, [['Tripulante: JOHN DOE - BP: 1 - Base: GRU - 01/06/2024 até 30/06/2024', 182]]),
    ...row(71, [['01Jun', 33], ['02Jun', 59]]), ...row(78, [['Sat', 37], ['Sun', 62]]),
    ...row(100, [['OFF', 35], ['MCK', 59]]), ...row(108, [['22:01', 33], ['09:00', 59]]), ...row(115, [['22:01', 33], ['09:00', 59]]), ...row(123, [['GRU', 34], ['CGH', 59]]),
    ...row(130, [['GRU', 34], ['CGH', 59]]), ...row(138, [['23:59', 33], ['13:00', 59]]), ...row(145, [['23:59', 33], ['13:00', 59]]),
    ...row(157, [['EMG', 59]]), ...row(165, [['14:00', 59]]), ...row(172, [['14:00', 59]]), ...row(180, [['GRU', 59]]), ...row(188, [['GRU', 59]]), ...row(195, [['18:00', 59]]), ...row(203, [['18:00', 59]]),
  ] }]);
  assert.equal(grid.format, 'aims-converted-grid');
  assert.deepEqual(grid.published.map(x => [x.date, x.duty, x.dep, x.begin, x.end]), [
    ['1 Jun 24', 'OFF', 'GRU', '22:01 L', '23:59 L'], ['2 Jun 24', 'MCK', 'CGH', '09:00 L', '13:00 L'], ['2 Jun 24', 'EMG', 'GRU', '14:00 L', '18:00 L'],
  ]);
  const mas = parseNetlinePdf([{ page: 1, width: 700, height: 842, items: [
    ...row(65, [['FEBRUARY 2026 ROSTER', 302]]),
    ...row(152, [['DATE', 27], ['DAY', 59], ['DUTY', 101], ['SECTOR', 210], ['REPORTING', 336], ['TIME', 411], ['BLOCK HOUR', 581], ['REMARKS', 634]]),
    ...row(167, [['1', 35], ['SUN', 59], ['STANDBY 4', 101], ['STANDBY HOME', 210], ['0:00', 336], ['16:00/23:59', 411], ['0:00', 581]]),
    ...row(196, [['3', 35], ['TUE', 59], ['3507', 101], ['KUL-HKG', 210], ['20:20', 336], ['21:20/01:30', 411], ['4:10', 581]]),
    ...row(210, [['4', 35], ['WED', 59], ['NS HKG', 101], ['NIGHTSTOP HKG', 210], ['0:00', 336], ['0:00', 411], ['0:00', 581]]),
    ...row(340, [['13', 33], ['FRI', 59], ['382/383', 101], ['KUL-SIN-KUL', 210], ['0:00', 336], ['00:50/02:00/06:15/07:25', 411], ['2:20', 581]]),
  ] }]);
  assert.equal(mas.format, 'month-roster-sectors');
  assert.deepEqual(mas.published.map(x => [x.date, x.duty, x.dep, x.begin, x.end, x.arr, x.info]), [
    ['1 Feb 26', 'STANDBY 4', '', '16:00 L', '23:59 L', '', 'STANDBY HOME'],
    ['3 Feb 26', 'C/I', 'KUL', '20:20 L', '', '', ''],
    ['3 Feb 26', '3507', 'KUL', '21:20 L', '01:30 L +1', 'HKG', '[Block: 4:10]'],
    ['4 Feb 26', 'HT', 'HKG', '', '', '', ''],
    ['13 Feb 26', '382', 'KUL', '00:50 L', '02:00 L', 'SIN', '[Block: 2:20]'],
    ['13 Feb 26', '383', 'SIN', '06:15 L', '07:25 L', 'KUL', ''],
  ]);
});

test('ROCS "Individual plan" (kind lines left out, the day\'s FT / DP / FDP), Korean Air roster report with NUL items, Mistral "Programmazione Individuale"', () => {
  const row = (y, cells) => cells.map(([text, x]) => iw(text, x, y, text.length * 4));
  const rocs = parseNetlinePdf([{ page: 1, width: 595, height: 842, items: [
    ...row(13, [['Individual plan', 50], ['ROCS', 494]]), ...row(75, [['01-01-2024 - 31-12-2024', 50]]),
    ...row(99, [['Date', 50], ['Duty', 122], ['Departure', 275], ['Arrival', 355], ['AC', 435], ['Info', 489]]),
    ...row(122, [['MON 2024', 50], ['OFF', 122]]), ...row(130, [['01 Jan', 50], ['OFF', 122], ['00:00', 307], ['21:00', 355]]),
    ...row(191, [['WED 2024', 50], ['FLIGHT DUTY', 122]]),
    ...row(199, [['03 Jan', 50], ['FR 5521', 122], ['MXP', 275], ['04:47', 307], ['09:20', 355], ['LPA', 387], ['73Q', 435], ['FT', 489], ['08:37', 515]]),
    ...row(213, [['DP', 489], ['10:19', 515]]), ...row(221, [['FLIGHT DUTY', 122]]), ...row(227, [['FDP', 489], ['09:49', 515]]),
    ...row(230, [['FR 5522', 122], ['LPA', 275], ['09:50', 307], ['13:54', 355], ['MXP', 387], ['73Q', 435]]),
  ] }]);
  assert.equal(rocs.format, 'rocs-individual-plan');
  assert.deepEqual(rocs.published.map(x => [x.date, x.duty, x.dep, x.begin, x.end, x.arr, x.ac, x.info]), [
    ['1 Jan 24', 'OFF', '', '00:00 Z', '21:00 Z', '', '', ''],
    ['3 Jan 24', 'FR5521', 'MXP', '04:47 Z', '09:20 Z', 'LPA', '73Q', '[FT: 08:37] [DP: 10:19] [FDP: 09:49]'],
    ['3 Jan 24', 'FR5522', 'LPA', '09:50 Z', '13:54 Z', 'MXP', '73Q', ''],
  ]);
  const nul = (x) => iw('\u0000', x, 272, 4);
  const kal = parseNetlinePdf([{ page: 1, width: 595, height: 842, items: [
    ...row(109, [['Roster', 184], ['Report', 225], ['from', 268], ['01JUN24', 299], ['30JUN24', 367]]),
    ...row(141, [['Times', 193], ['shown', 231], ['are', 273], ['in', 295], ['Port', 310], ['Local', 338], ['times', 372]]),
    ...row(243, [['Start', 36], ['DateDay', 55], ['Flight', 90], ['Number', 112], ['Sector', 139]]),
    ...row(257, [['01JUN24 SAT', 36], ['ICN', 139], ['DO', 190], ['0', 392]]),
    ...row(272, [['02JUN24 SUN', 36], ['KE', 90], ['0101', 100], ['ICN', 139], ['NKG 7MQ FLY', 153], ['F', 226], ['O', 233], ['F', 268], ['O', 275], ['0840 1012 1111 01', 306], ['59', 374], ['07', 392], ['41', 403]]),
    nul(230), nul(272), nul(371),
  ] }]);
  assert.equal(kal.format, 'port-local-roster-report');
  assert.equal(kal.period, '01Jun24 - 30Jun24');
  assert.deepEqual(kal.published.map(x => [x.date, x.duty, x.dep, x.begin, x.end, x.arr, x.ac, x.info]), [
    ['1 Jun 24', 'DO', 'ICN', '', '', '', '', ''],
    ['2 Jun 24', 'C/I', 'ICN', '08:40 L', '', '', '', ''],
    ['2 Jun 24', 'KE0101', 'ICN', '10:12 L', '11:11 L', 'NKG', '7MQ', '[Flight: 01:59] [Duty: 07:41]'],
  ]);
  const mistral = parseNetlinePdf([{ page: 1, width: 842, height: 595, items: [
    ...row(45, [['Data e Ora = UTC', 31]]), ...row(59, [['Stampato il 28-03-2022 by someone', 31]]), ...row(72, [['Programmazione Individuale', 31]]),
    ...row(115, [['Data', 59], ['Tipo', 133], ['Da', 197], ['A', 253], ['Descrizione', 371], ['Membri Equipaggio', 505]]),
    ...row(128, [['CHECKIN', 109], ['18:25', 178], ['000:00', 699]]),
    ...row(138, [['FLIGHT', 109], ['23:55', 178], ['==>>', 232], ['VBS(A)-CAG(B)', 286], ['FO', 353], ['001:30', 699]]), ...row(148, [['M4', 286], ['783', 300], ['EIGHA', 319]]),
    ...row(158, [['Tue-15-Mar', 31], ['<<==', 178], ['01:25', 232]]),
    ...row(189, [['23:00', 178], ['==>>', 232], ['FCO', 286]]), ...row(199, [['OFF', 286], ['RICHIESTO', 305]]),
    ...row(209, [['Wed-16-Mar', 31], ['<<==', 178], ['22:59', 232]]),
  ] }]);
  assert.equal(mistral.format, 'programmazione-individuale');
  assert.deepEqual(mistral.published.map(x => [x.date, x.duty, x.registration, x.dep, x.begin, x.end, x.arr, x.info]), [
    ['14 Mar 22', 'C/I', '', 'VBS', '18:25 Z', '', '', ''],
    ['14 Mar 22', 'M4783', 'EIGHA', 'VBS', '23:55 Z', '01:25 Z +1', 'CAG', '[Rank: FO] [Block: 01:30]'],
    ['15 Mar 22', 'OFF', '', 'FCO', '23:00 Z', '22:59 Z +1', '', 'OFF RICHIESTO'],
  ]);
});

test('papers about one flight: Icelandair "Flight Information", VistaJet journey log, NAVBLUE flight plan, RVSM report', () => {
  const row = (y, cells) => cells.map(([text, x]) => iw(text, x, y, text.length * 5));
  const info = parseNetlinePdf([{ page: 1, width: 595, height: 842, items: [
    ...row(42, [['Digitally Signed By:', 240], ['KGA', 319]]), ...row(83, [['Flight Information', 34]]),
    ...row(101, [['Flight No.:', 84], ['FI630(630)', 137], ['Origin:', 268], ['KBOS', 310]]), ...row(115, [['Date:', 104], ['10052022', 137], ['Destination:', 250], ['BIKF', 310]]),
    ...row(130, [['Registration:', 74], ['TF-ISO', 137]]), ...row(158, [['CMD:', 78], ['KGA (Konrad Doe)', 115], ['F/O:', 325], ['GRT (Grettir Roe)', 354]]),
    ...row(250, [['OFF Block Time:', 370], ['0043', 451]]), ...row(267, [['Take-Off Time:', 377], ['0055', 451]]), ...row(279, [['0555', 451]]), ...row(281, [['Landing Time:', 380]]),
    ...row(296, [['ON Block Time:', 375], ['0558', 451]]), ...row(318, [['Total Airborne Time:', 354], ['0500', 451]]), ...row(332, [['Total Block Time:', 368], ['0515', 451]]),
  ] }]);
  assert.equal(info.format, 'flight-information');
  assert.deepEqual(info.published.map(x => [x.date, x.duty, x.registration, x.dep, x.begin, x.takeoff, x.landing, x.end, x.arr, x.crew, x.info]), [
    ['10 May 22', 'FI630', 'TF-ISO', 'KBOS', '00:43 Z', '00:55 Z', '05:55 Z', '05:58 Z', 'BIKF', '[F/O - GRT - Grettir Roe]', '[Block: 05:15] [Flight: 05:00]'],
  ]);
  const jl = parseNetlinePdf([{ page: 1, width: 842, height: 595, items: [
    ...row(37, [['Journey Log', 223]]), ...row(59, [['Date of flight:', 38], ['Registration:', 110], ['A/C Type:', 163]]), ...row(69, [['05 Feb 24', 41], ['D-ASAP', 112], ['Legacy', 177]]),
    ...row(86, [['650', 187]]), ...row(127, [['PF', 110], ['Pax', 163], ['Routing', 181]]),
    ...row(166, [['1JSC', 88], ['1ERI', 122], ['LFSB', 198], ['10:00', 244], ['10:12', 309]]),
    ...row(177, [['1', 42], ['VJH727', 55], ['C', 149], ['3', 168], ['05:35', 278], ['05:19', 340], ['1', 373], ['ILS', 391]]),
    ...row(189, [['1JCH', 87], ['OBBI', 198], ['15:35', 244], ['15:31', 309]]),
  ] }]);
  assert.equal(jl.format, 'journey-log');
  assert.deepEqual(jl.published.map(x => [x.date, x.duty, x.registration, x.ac, x.dep, x.begin, x.takeoff, x.landing, x.end, x.arr, x.crew, x.info]), [
    ['5 Feb 24', 'VJH727', 'D-ASAP', 'Legacy 650', 'LFSB', '10:00 Z', '10:12 Z', '15:31 Z', '15:35 Z', 'OBBI', '[PIC - 1JSC][C/H - 1ERI][F/O - 1JCH]', '[Block: 05:35] [Flight: 05:19] [Pax: 3]'],
  ]);
  const plan = parseNetlinePdf([{ page: 1, width: 595, height: 842, items: [
    ...row(31, [['***NAVBLUE FLIGHT PLAN***', 196]]),
    ...row(103, [['LZB563', 30], ['-LBSF/LPPT 02MAY26', 83], ['M78:', 209], ['ACFT.', 355], ['LZROM', 395], ['/ A220-300S2', 441]]),
    ...row(139, [['STD', 30], ['UTC', 57], [': 16:40', 96], ['STA UTC', 163], [': 21:15', 229]]),
  ] }]);
  assert.deepEqual(plan.published.map(x => [plan.format, x.date, x.duty, x.registration, x.ac, x.dep, x.begin, x.end, x.arr]), [
    ['navblue-plan', '2 May 26', 'LZB563', 'LZROM', 'A220-300S2', 'LBSF', '16:40 Z', '21:15 Z', 'LPPT'],
  ]);
  const rvsm = parseNetlinePdf([{ page: 1, width: 595, height: 842, items: [
    ...row(6, [['RVSM Report - 02 May 2026 16:22:07Z', 168]]), ...row(34, [['FLT NBR', 2], ['FB0563', 120], ['SKD', 214], ['02 May 16:40', 261]]), ...row(48, [['FROM', 2], ['LBSF', 120], ['TO', 214], ['LPPT', 261]]),
  ] }]);
  assert.deepEqual(rvsm.published.map(x => [rvsm.format, x.date, x.duty, x.dep, x.begin, x.arr]), [['flight-report-sheet', '2 May 26', 'FB0563', 'LBSF', '16:40 Z', 'LPPT']]);
});

test('"Schedule Summary" in UTC ("14 - 31 Jan 2026") and "Roster Summary" with "Post Flt Duty" as the release', () => {
  const row = (y, cells) => cells.map(([text, x]) => iw(text, x, y, text.length * 4));
  const utc = parseNetlinePdf([{ page: 1, width: 595, height: 842, items: [
    ...row(9, [['JOHN DOE Schedule Summary, 14 - 31 Jan 2026', 14]]), ...row(42, [['Thu, 15', 21], ['January 2026 (UTC)', 76]]),
    ...row(113, [['Report', 17], ['11:55 - 12:55', 104], ['ESB', 195]]),
    ...row(128, [['TK2155 (Deadheading)', 17], ['12:55 - 14:10', 104], ['ESB - IST', 195], ['CP', 252], ['Flight Time: 01:15', 457]]),
    ...row(159, [['Release', 17], ['14:10 - 14:40', 104], ['IST', 195]]),
  ] }]);
  assert.equal(utc.period, '14Jan26 - 31Jan26');
  assert.deepEqual(utc.published.map(x => [x.date, x.dc, x.duty, x.dep, x.begin, x.end, x.arr]), [
    ['15 Jan 26', '', 'C/I', 'ESB', '11:55 Z', '', ''], ['15 Jan 26', 'DH', 'TK2155', 'ESB', '12:55 Z', '14:10 Z', 'IST'], ['15 Jan 26', '', 'C/O', '', '', '14:40 Z', 'IST'],
  ]);
  const sq = parseNetlinePdf([{ page: 1, width: 595, height: 842, items: [
    ...row(9, [['John Doe Roster Summary, 31 Jul - 31 Aug 2024', 14]]), ...row(42, [['Tue, 30', 21], ['July 2024 (Local time)', 75]]),
    ...row(67, [['Report', 17], ['19:20 - 20:20', 104], ['SIN', 195]]), ...row(82, [['SQ818', 17], ['20:20 - 01:15 +1', 104], ['SIN - CKG', 195], ['FO', 252]]),
    ...row(104, [['Wed, 31', 21], ['July 2024 (Local time)', 79]]), ...row(128, [['Post Flt Duty', 17], ['01:15 - 01:45', 104], ['CKG', 195]]),
  ] }]);
  assert.equal(sq.period, '31Jul24 - 31Aug24');
  assert.deepEqual(sq.published.map(x => [x.date, x.duty, x.begin, x.end, x.arr]), [
    ['30 Jul 24', 'C/I', '19:20 L', '', ''], ['30 Jul 24', 'SQ818', '20:20 L', '01:15 L +1', 'CKG'], ['31 Jul 24', 'C/O', '', '01:45 L', 'CKG'],
  ]);
});
