import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
globalThis.SunCalc = createRequire(import.meta.url)('suncalc');
await import('../src/views/assets/night.js');

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
  // nautical twilight ends later still: less night, its edge with the sun at -12°
  const nautical = compute({ from: VIE, to: PRN, off: '2025-03-11T16:30:00Z', on: '2025-03-11T18:05:00Z', rule: 'nautical' });
  assert.equal(nautical.limit, -12);
  assert.ok(nautical.nightMs < civil.nightMs && nautical.nightMs > 0, `${nautical.nightMs} vs ${civil.nightMs}`);
  assert.ok(Math.abs(nautical.segments[1].fromAlt + 12) < 0.05, `sun at -12° at the edge, got ${nautical.segments[1].fromAlt}`);
});

test('fixed hours: night outside sunrise..sunset in local time at the aircraft (its longitude)', () => {
  const { localMinutes, fixedNightPolygon } = globalThis.NightTime;
  // VIE is at 16.57°E: local = UTC + 66 min; the flight leaves at 17:36 L and night starts at 18:00 L
  const r = compute({ from: VIE, to: PRN, off: '2025-03-11T16:30:00Z', on: '2025-03-11T18:05:00Z', rule: 'fixed' });
  assert.deepEqual([r.limit, r.sunrise, r.sunset, r.takeoffNight, r.landingNight], [null, '06:00', '18:00', false, true]);
  const edge = r.segments[1];
  assert.ok(Math.abs(localMinutes(+edge.from, edge.fromPos.lon) - 18 * 60) < 0.1);
  // other hours move the edge: night from 19:00 L leaves less of it
  const late = compute({ from: VIE, to: PRN, off: '2025-03-11T16:30:00Z', on: '2025-03-11T18:05:00Z', rule: 'fixed', sunrise: '07:00', sunset: '19:00' });
  assert.ok(late.nightMs < r.nightMs);
  assert.throws(() => compute({ from: VIE, to: PRN, off: '2025-03-11T16:30:00Z', on: '2025-03-11T18:05:00Z', rule: 'fixed', sunrise: '18:00', sunset: '18:00' }));
  // the night band at 12:00Z: from 90°E (18:00 L) to 270° (06:00 L)
  const xs = fixedNightPolygon(Date.parse('2026-10-20T12:00:00Z')).coordinates[0].map(p => p[0]);
  assert.deepEqual([Math.min(...xs), Math.max(...xs)], [90, 270]);
});

test('across the antimeridian the track stays continuous', () => {
  const r = compute({ from: HND, to: SFO, off: '2025-01-10T15:00:00Z', on: '2025-01-11T00:30:00Z' });
  for (let i = 1; i < r.samples.length; i++) assert.ok(Math.abs(r.samples[i].lon - r.samples[i - 1].lon) < 20);
  assert.ok(Math.abs(r.samples.at(-1).lon - (SFO.lon + 360)) < 1e-6);
});

test('subsolar point: on the equator at the equinox, on the tropics at the solstices; the sun is overhead there', () => {
  const { subsolarPoint, sunAltitude } = globalThis.NightTime;
  for (const [iso, lat] of [['2024-03-20T03:06:00Z', 0], ['2024-06-20T20:51:00Z', 23.44], ['2024-12-21T09:20:00Z', -23.44]]) {
    const t = Date.parse(iso), s = subsolarPoint(t);
    assert.ok(Math.abs(s.lat - lat) < 0.05, `${iso}: ${s.lat}`);
    assert.ok(sunAltitude(t, s) > 89.5, `${iso}: the sun at ${sunAltitude(t, s)}°`);
  }
});

test('night polygons: a point is inside exactly when the sun is below the altitude (with or without a pole inside)', () => {
  const { nightPolygon, sunAltitude } = globalThis.NightTime;
  const inside = (pt, ring) => {
    let c = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i], [xj, yj] = ring[j];
      if ((yi > pt[1]) !== (yj > pt[1]) && pt[0] < ((xj - xi) * (pt[1] - yi)) / (yj - yi) + xi) c = !c;
    }
    return c;
  };
  let seed = 7;
  const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  // June: the -18° cap holds the south pole; October: it does not (and its ring may pass ±180)
  for (const iso of ['2024-06-20T20:51:00Z', '2026-10-20T12:00:00Z']) {
    for (const h of [0, -6, -18]) {
      const t = Date.parse(iso), ring = nightPolygon(t, h).coordinates[0];
      for (let k = 0; k < 200; k += 1) {
        const lat = rnd() * 170 - 85, lon = rnd() * 360 - 180, alt = sunAltitude(t, { lat, lon });
        if (Math.abs(alt - h) < 0.5) continue; // too close to the edge for a 2° polygon
        const hit = [lon, lon + 360, lon - 360].some(x => inside([x, lat], ring));
        assert.equal(hit, alt < h, `${iso} ${h}° at ${lat.toFixed(1)}, ${lon.toFixed(1)}: sun ${alt.toFixed(1)}°`);
      }
    }
  }
});
