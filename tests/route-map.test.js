import test from 'node:test';
import assert from 'node:assert/strict';
import '../src/views/assets/ics.js';
import '../src/views/assets/route-map.js';

const { flightsFromRows, flightsFromEvents, routes, greatCircle, distanceKm, toParam, fromParam } = globalThis.RouteMap;
const { rowsToIcs, parseIcs } = globalThis.RosterIcs;

const ROWS = {
  published: [
    { date: '7 Jan 25', duty: 'C/I', begin: '00:55 Z' },
    { date: '7 Jan 25', duty: 'WAZ7015', dep: 'AUH', begin: 'A02:00 Z', end: 'A05:00 Z', arr: 'GYD' },
    { date: '7 Jan 25', duty: 'WAZ7016', dep: 'GYD', begin: 'A05:55 Z', end: '09:15 Z', arr: 'AUH' },
    { date: '8 Jan 25', duty: 'GT', dep: 'LTN', begin: '12:00 Z', end: '13:00 Z', arr: 'STC' }, // ground duty: not a flight
    { date: '9 Jan 25', duty: 'SBY', dep: 'AUH', arr: 'AUH' },
  ],
  planned: [{ date: '2 Feb 25', duty: '9016', dep: 'AUH', begin: '06:47 Z', end: '11:00 Z', arr: 'LUX' }],
};
const AIRPORTS = { AUH: { lat: 24.43, lon: 54.65 }, GYD: { lat: 40.47, lon: 50.05 }, LUX: { lat: 49.63, lon: 6.21 } };

test('flights: rows with a flight number from one airport to another; the same from the .ics', () => {
  const f = flightsFromRows(ROWS);
  assert.deepEqual(f.map(x => `${x.dep}-${x.arr} ${x.month}${x.planned ? ' planned' : ''}`), ['AUH-GYD 2025-01', 'GYD-AUH 2025-01', 'AUH-LUX 2025-02 planned']);
  const fromIcs = flightsFromEvents(parseIcs(rowsToIcs(ROWS, { name: 'R' }).ics).events);
  assert.deepEqual(fromIcs.map(x => `${x.dep}-${x.arr} ${x.month}`), f.map(x => `${x.dep}-${x.arr} ${x.month}`));
});

test('routes: one per airport pair and roster, both directions together; month and planned filters', () => {
  const rosters = [{ name: 'A', color: '#111111', flights: flightsFromRows(ROWS) }];
  const all = routes(rosters, AIRPORTS);
  assert.equal(all.flights, 3);
  assert.deepEqual(all.routes.map(r => `${r.pair} x${r.n}`).sort(), ['AUH-GYD x2', 'AUH-LUX x1']);
  assert.equal(routes(rosters, AIRPORTS, { planned: false }).flights, 2);
  assert.equal(routes(rosters, AIRPORTS, { month: '2025-02' }).flights, 1);
  assert.deepEqual(routes([{ name: 'B', flights: [{ dep: 'AUH', arr: 'XXX' }] }], AIRPORTS).unknown, ['XXX']);
});

test('a roster in a URL and back', () => {
  const p = toParam({ name: 'Jan, 25', color: '#c0392b', flights: [{ dep: 'VIE', arr: 'HAN' }, { dep: 'VIE', arr: 'HAN' }, { dep: 'HAN', arr: 'VIE' }] });
  assert.equal(p, 'Jan  25|#c0392b|VIE-HAN*2,HAN-VIE');
  const r = fromParam(p);
  assert.equal(r.color, '#c0392b');
  assert.deepEqual(r.flights.map(f => `${f.dep}-${f.arr}*${f.count}`), ['VIE-HAN*2', 'HAN-VIE*1']);
  assert.equal(fromParam('x||VIE-HAN', 2).color, globalThis.RouteMap.COLORS[2]); // no colour: the palette's
});

test('great circle: the right distance, one unbroken line over the 180° meridian', () => {
  assert.ok(Math.abs(distanceKm({ lat: 48.11, lon: 16.57 }, { lat: 21.22, lon: 105.81 }) - 8214) < 5); // VIE - HAN
  const pts = greatCircle({ lat: 35.55, lon: 139.78 }, { lat: 21.32, lon: -157.92 }); // HND - HNL
  for (let i = 1; i < pts.length; i++) assert.ok(Math.abs(pts[i][1] - pts[i - 1][1]) < 10, 'no jump across the map');
  assert.ok(pts[pts.length - 1][1] > 180, 'continues past 180 instead of wrapping to -158');
});
