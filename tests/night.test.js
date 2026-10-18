import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
globalThis.SunCalc = createRequire(import.meta.url)('suncalc');
await import('../views/assets/night.js');

const { compute, pointAt, distanceKm, hmm } = globalThis.NightTime;
const VIE = { lat: 48.1103, lon: 16.5697 }, PRN = { lat: 42.5728, lon: 21.0358 };
const LHR = { lat: 51.4706, lon: -0.46194 }, JFK = { lat: 40.63945, lon: -73.77932 };
const HND = { lat: 35.5523, lon: 139.78 }, SFO = { lat: 37.619, lon: -122.375 };

test('great circle: distance, midpoint, ends', () => {
  assert.ok(Math.abs(distanceKm(LHR, JFK) - 5540) < 10); // spherical earth (5555 km on the ellipsoid)
  const mid = pointAt(LHR, JFK, 0.5);
  assert.ok(mid.lat > 52, 'the great circle bows north of both ends'); // ~52.2N
  const start = pointAt(LHR, JFK, 0);
  assert.ok(Math.abs(start.lat - LHR.lat) < 1e-9 && Math.abs(start.lon - LHR.lon) < 1e-9);
});

test('a flight all in the dark, all in daylight', () => {
  const night = compute({ from: VIE, to: PRN, off: '2025-03-11T21:45:00Z', on: '2025-03-11T23:20:00Z' });
  assert.equal(hmm(night.nightMs), '1:35');
  assert.equal(night.segments.length, 1);
  assert.ok(night.takeoffNight && night.landingNight);
  const day = compute({ from: VIE, to: PRN, off: '2025-06-21T10:00:00Z', on: '2025-06-21T11:35:00Z' });
  assert.equal(day.nightMs, 0);
});

test('flying into the night: edges to the second, civil twilight later than sunset', () => {
  // VIE -> PRN in the evening of 11 Mar 2025: sunset ~16:40Z, civil dusk ~17:10Z at Vienna
  const civil = compute({ from: VIE, to: PRN, off: '2025-03-11T16:30:00Z', on: '2025-03-11T18:05:00Z' });
  assert.equal(civil.segments.length, 2);
  assert.equal(civil.takeoffNight, false);
  assert.equal(civil.landingNight, true);
  const edge = civil.segments[1].from;
  assert.equal(edge.getUTCSeconds() + edge.getUTCMilliseconds(), edge.getUTCSeconds(), 'whole seconds');
  assert.ok(Math.abs(civil.segments[1].fromAlt + 6) < 0.05, `sun at -6° at the edge, got ${civil.segments[1].fromAlt}`);
  const sunset = compute({ from: VIE, to: PRN, off: '2025-03-11T16:30:00Z', on: '2025-03-11T18:05:00Z', rule: 'sunset' });
  assert.ok(sunset.nightMs > civil.nightMs);
  assert.equal(civil.nightMs + civil.dayMs, civil.totalMs);
});

test('across the antimeridian the track stays continuous', () => {
  const r = compute({ from: HND, to: SFO, off: '2025-01-10T15:00:00Z', on: '2025-01-11T00:30:00Z' });
  for (let i = 1; i < r.samples.length; i++) assert.ok(Math.abs(r.samples[i].lon - r.samples[i - 1].lon) < 20);
  assert.ok(Math.abs(r.samples.at(-1).lon - (SFO.lon + 360)) < 1e-6);
});
