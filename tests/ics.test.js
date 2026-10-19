import test from 'node:test';
import assert from 'node:assert/strict';
import '../src/views/assets/ics.js';

const { rowsToIcs, parseIcs, timesOf } = globalThis.RosterIcs;
const at = (t) => `${t.y}-${t.mo}-${t.d} ${t.h}:${t.mi}${t.utc ? 'Z' : ''}`;

test('roster times: UTC, local, actual prefix, day offsets, end past midnight', () => {
  assert.equal(at(timesOf({ date: '7 Jan 25', begin: 'A02:00 Z', end: 'A05:00 Z' }).start), '2025-1-7 2:0Z');
  const sby = timesOf({ date: '3 Jan 25', begin: '19:50 Z', end: '05:50 Z +1' });
  assert.equal(at(sby.end), '2025-1-4 5:50Z');
  assert.equal(at(timesOf({ date: '31 Dec 24', begin: '23:10 Z', end: '01:20 Z' }).end), '2025-1-1 1:20Z');
  assert.equal(at(timesOf({ date: '4 Jun 24', begin: '21:00 Z -1', end: '20:59 Z' }).start), '2024-6-3 21:0Z');
  const local = timesOf({ date: '1 Jul 25', begin: '09:00 LB', end: '17:00 LB' });
  assert.equal(at(local.start), '2025-7-1 9:0');
  assert.equal(at(timesOf({ date: '1 Jul 25', begin: '08:00 Z / 10:00 L' }).start), '2025-7-1 8:0Z');
});

test('rows without times are all-day, one time is a moment, no date is skipped', () => {
  assert.equal(timesOf({ date: '2 Jan 25', duty: 'OFF' }).allDay, true);
  const ci = timesOf({ date: '7 Jan 25', duty: 'C/I', begin: '00:55 Z' });
  assert.equal(ci.allDay, false);
  assert.equal(ci.end, null);
  assert.equal(timesOf({ date: '', duty: 'OFF' }), null);
});

test('.ics export reads back the same events, with escaping and folding', () => {
  const crew = '[CP - 26861 - OTTHOFF Robert Herbert Josef][SF - 37423 - GOMEZ VIVAS Hernan Francisco]';
  const { ics, events, skipped } = rowsToIcs({
    published: [
      { date: '2 Jan 25', day: 'Thu', duty: 'OFF', info: '[OFF: Day off]' },
      { date: '7 Jan 25', day: 'Tue', duty: 'WAZ7015', dep: 'AUH', arr: 'GYD', begin: 'A02:00 Z', end: 'A05:00 Z', ac: '321', crew },
      { date: 'bad', duty: 'X' },
    ],
    planned: [{ date: '9 Jan 25', duty: 'SBY', begin: '04:00 Z', end: '12:00 Z', info: 'a, b; c' }],
  }, { name: 'Test, roster', now: new Date(Date.UTC(2026, 0, 1)) });
  assert.equal(events, 3);
  assert.equal(skipped.length, 1);
  for (const line of ics.split('\r\n')) assert.ok(new TextEncoder().encode(line).length <= 75, line);
  const back = parseIcs(ics);
  assert.equal(back.name, 'Test, roster');
  assert.equal(back.events.length, 3);
  const [off, flight, sby] = back.events;
  assert.equal(off.allDay, true);
  assert.equal(off.summary, 'OFF');
  assert.equal(flight.summary, 'WAZ7015 AUH → GYD');
  assert.equal(flight.location, 'AUH');
  assert.equal(at(flight.end), '2025-1-7 5:0Z');
  assert.match(flight.description, /OTTHOFF Robert Herbert Josef/);
  assert.equal(sby.status, 'TENTATIVE');
  assert.match(sby.description, /Info: a, b; c/);
  assert.notEqual(off.uid, flight.uid);
});

const brief = (e) => `${e.parent ? '  ' : ''}${e.kind} ${e.allDay ? `all-day ${e.start.mo}/${e.start.d}` : `${at(e.start)} - ${e.end ? at(e.end) : ''}`} ${e.summary}`;

test('a check-in .. check-out is a duty holding its flights; a hotel lasts from the event before to the event after', () => {
  const { events } = globalThis.RosterIcs.rosterEvents({
    published: [
      { date: '10 Mar 25', duty: 'OS 528', dep: 'VCE', arr: 'VIE', begin: '05:45 Z', end: '06:55 Z' }, // no check-in: on its own
      { date: '11 Mar 25', duty: 'C/I', dep: 'VIE', begin: '20:35 Z' },
      { date: '11 Mar 25', duty: 'OS 769', dep: 'VIE', arr: 'PRN', begin: '21:45 Z', end: '23:20 Z' },
      { date: '11 Mar 25', duty: 'FDP_EXT' }, // no time: in the duty's description
      { date: '11 Mar 25', duty: 'H3', dep: 'PRN', info: 'Hotel Prishtina' }, // a hotel inside the duty
      { date: '12 Mar 25', duty: 'SIM', dep: 'PRN', begin: '02:30 Z', end: '03:00 Z' },
      { date: '12 Mar 25', duty: 'OS 770', dep: 'PRN', arr: 'VIE', begin: '03:50 Z', end: '05:30 Z' },
      { date: '12 Mar 25', duty: 'C/O', end: '06:00 Z', arr: 'VIE' },
      { date: '12 Mar 25', duty: 'HT', dep: 'VIE' }, // nights in a row at one hotel: one event
      { date: '13 Mar 25', duty: 'HT', dep: 'VIE' },
      { date: '14 Mar 25', duty: 'CHFCK-IN', begin: '08:00 Z' }, // misread check-in
      { date: '14 Mar 25', duty: 'OS 100', dep: 'VIE', arr: 'LHR', begin: '09:00 Z', end: '11:00 Z' },
      { date: '15 Mar 25', duty: 'OFF' }, // no check-out: the duty ends with its last flight
    ],
  });
  assert.deepEqual(events.map(brief), [
    'flight 2025-3-10 5:45Z - 2025-3-10 6:55Z OS 528 VCE → VIE',
    'duty 2025-3-11 20:35Z - 2025-3-12 6:0Z Duty VIE → PRN → VIE',
    '  flight 2025-3-11 21:45Z - 2025-3-11 23:20Z OS 769 VIE → PRN',
    '  hotel 2025-3-11 23:20Z - 2025-3-12 2:30Z H3 PRN',
    '  sim 2025-3-12 2:30Z - 2025-3-12 3:0Z SIM PRN',
    '  flight 2025-3-12 3:50Z - 2025-3-12 5:30Z OS 770 PRN → VIE',
    'hotel 2025-3-12 6:0Z - 2025-3-14 8:0Z HT VIE',
    'duty 2025-3-14 8:0Z - 2025-3-14 11:0Z Duty VIE → LHR',
    '  flight 2025-3-14 9:0Z - 2025-3-14 11:0Z OS 100 VIE → LHR',
    'event all-day 3/15 OFF',
  ]);
  assert.match(events[1].description, /Also: FDP_EXT/);
  const parsed = parseIcs(rowsToIcs({ published: [
    { date: '11 Mar 25', duty: 'C/I', begin: '20:35 Z' },
    { date: '11 Mar 25', duty: 'OS 769', dep: 'VIE', arr: 'PRN', begin: '21:45 Z', end: '23:20 Z' },
    { date: '11 Mar 25', duty: 'C/O', end: '23:50 Z' },
  ] }).ics).events;
  assert.equal(parsed[0].kind, 'duty');
  assert.equal(parsed[1].parent, parsed[0].uid);
});

test('.ics from other calendars: DURATION, TZID, date-only, nested alarms', () => {
  const text = [
    'BEGIN:VCALENDAR', 'X-WR-CALNAME:Other',
    'BEGIN:VEVENT', 'DTSTART;TZID=Europe/Berlin:20250301T090000', 'DURATION:PT1H30M', 'SUMMARY:Meeting',
    'BEGIN:VALARM', 'SUMMARY:alarm text', 'END:VALARM', 'END:VEVENT',
    'BEGIN:VEVENT', 'DTSTART;VALUE=DATE:20250302', 'SUMMARY:Holiday', 'END:VEVENT',
    'END:VCALENDAR',
  ].join('\n');
  const { name, events } = parseIcs(text);
  assert.equal(name, 'Other');
  assert.equal(events[0].summary, 'Meeting');
  assert.equal(at(events[0].end), '2025-3-1 10:30');
  assert.equal(events[0].tzid, 'Europe/Berlin');
  assert.equal(events[1].allDay, true);
  assert.equal(at(events[1].end), '2025-3-3 0:0');
});
