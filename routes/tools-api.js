// /routes/tools-api.js
// Public tools that the pages also run in the browser, as server endpoints for other apps
// (documented in docs/openapi.json, /api-docs). Same code as the pages:
//   GET  /api/night-time     night time of a flight along the great circle (views/assets/night.js + SunCalc)
//   POST /api/calendar/ics   roster rows -> iCalendar (.ics) with duties / hotels (views/assets/ics.js)
import { Router } from 'express';
import { createRequire } from 'node:module';
import { findByCode } from './airports-api.js';
import '../views/assets/ics.js';

globalThis.SunCalc = globalThis.SunCalc || createRequire(import.meta.url)('suncalc');
await import('../views/assets/night.js');
const { compute, RULES } = globalThis.NightTime;
const { rowsToIcs } = globalThis.RosterIcs;

const router = Router();
const COORD_RE = /^\s*(-?\d{1,2}(?:\.\d+)?)\s*,\s*(-?\d{1,3}(?:\.\d+)?)\s*$/;
const bad = (res, error) => res.status(400).json({ error });

/** "VIE" / "LOWW" / "48.11,16.57" -> { code, name, lat, lon } or null */
function placeOf(text) {
  const m = COORD_RE.exec(String(text || ''));
  if (m) {
    const lat = Number(m[1]), lon = Number(m[2]);
    return Math.abs(lat) <= 90 && Math.abs(lon) <= 180 ? { code: `${lat},${lon}`, name: null, lat, lon } : null;
  }
  const hit = text && findByCode(text);
  if (!hit) return null;
  const a = hit.airport;
  return { code: a.iata || a.icao || a.id, icao: a.icao || null, name: a.name, lat: a.lat, lon: a.lon };
}

const round = (v, d) => Math.round(v * 10 ** d) / 10 ** d;
const minutes = (ms) => Math.round(ms / 60000);
const hm = (min) => `${Math.floor(min / 60)}:${String(min % 60).padStart(2, '0')}`;

/**
 * GET /api/night-time?dep=VIE&arr=HAN&off=2025-03-11T13:00Z&on=2025-03-11T23:50Z[&rule=civil|sunset][&track=1]
 * dep / arr: an airport code (IATA, ICAO, FAA, ...) or "lat,lon"; off / on: ISO 8601 times (UTC with Z).
 */
router.get('/night-time', (req, res) => {
  const { dep, arr, off, on, rule = 'civil' } = req.query;
  if (!dep || !arr || !off || !on) return bad(res, 'dep, arr, off and on are required');
  if (!RULES[rule]) return bad(res, `rule must be one of: ${Object.keys(RULES).join(', ')}`);
  const from = placeOf(dep), to = placeOf(arr);
  if (!from) return res.status(404).json({ error: `Airport "${dep}" not found` });
  if (!to) return res.status(404).json({ error: `Airport "${arr}" not found` });
  const t0 = new Date(off), t1 = new Date(on);
  if (Number.isNaN(+t0) || Number.isNaN(+t1)) return bad(res, 'off and on must be ISO 8601 times, e.g. 2025-03-11T13:00Z');
  if (t1 <= t0) return bad(res, 'On-block must be after off-block.');
  if (t1 - t0 > 24 * 3600000) return bad(res, 'Block time over 24 hours.');
  const r = compute({ from, to, off: t0, on: t1, rule });
  const pos = (p) => ({ lat: round(p.lat, 5), lon: round(((p.lon + 540) % 360) - 180, 5) });
  const block = minutes(r.totalMs), night = minutes(r.nightMs);
  res.json({
    rule, sunAltitudeLimit: r.limit,
    departure: from, arrival: to,
    offBlock: t0.toISOString(), onBlock: t1.toISOString(),
    blockMinutes: block, nightMinutes: night, dayMinutes: block - night,
    block: hm(block), night: hm(night), day: hm(block - night),
    takeoffAtNight: r.takeoffNight, landingAtNight: r.landingNight,
    distanceKm: round(r.distanceKm, 1), distanceNm: round(r.distanceKm / 1.852, 1), initialCourseDeg: round(r.courseDeg, 1),
    segments: r.segments.map(s => ({
      night: s.night, from: s.from.toISOString(), to: s.to.toISOString(), minutes: minutes(s.to - s.from),
      fromPosition: pos(s.fromPos), toPosition: pos(s.toPos), fromSunAltitude: round(s.fromAlt, 2), toSunAltitude: round(s.toAlt, 2),
    })),
    ...(req.query.track === '1' || req.query.track === 'true'
      ? { track: r.samples.map(p => ({ time: new Date(p.t).toISOString(), ...pos(p), sunAltitude: round(p.alt, 2) })) }
      : {}),
  });
});

/**
 * POST /api/calendar/ics  { name?, published: [row], planned: [row] }  -> text/calendar (a .ics file)
 * ?format=json -> { name, events, skipped, ics } instead.
 */
router.post('/calendar/ics', (req, res) => {
  const body = req.body || {};
  const published = Array.isArray(body.published) ? body.published : [];
  const planned = Array.isArray(body.planned) ? body.planned : [];
  if (!published.length && !planned.length) return bad(res, 'Send roster rows in "published" and / or "planned"');
  const name = String(body.name || 'Roster').slice(0, 200);
  const { ics, events, skipped } = rowsToIcs({ published, planned }, { name });
  if (req.query.format === 'json') return res.json({ name, events, skipped, ics });
  const file = `${name.replace(/[^\w.-]+/g, '_').replace(/^_+|_+$/g, '') || 'roster'}.ics`;
  res.set({ 'Content-Type': 'text/calendar; charset=utf-8', 'Content-Disposition': `attachment; filename="${file}"`, 'X-Events': String(events), 'X-Skipped-Rows': String(skipped.length) });
  res.send(ics);
});

export default router;
