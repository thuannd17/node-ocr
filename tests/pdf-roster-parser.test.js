import test from 'node:test';
import assert from 'node:assert/strict';
import { parseNetlinePdf, formatTime } from '../services/pdf-roster-parser.js';

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
