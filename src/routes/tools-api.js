// /routes/tools-api.js
// Public tools that the pages also run in the browser, as server endpoints for other apps
// (documented in docs/openapi.json, /api-docs). Same code as the pages:
//   POST /api/night-time/calc   night time of a flight along the great circle (views/assets/night.js + SunCalc)
//   POST /api/calendar/export   roster rows -> iCalendar (.ics) with duties / hotels (views/assets/ics.js)
//   POST /api/route-map         rosters -> their routes on a world map, and a /route-map link that shows them (views/assets/route-map.js)
import { Router } from 'express';
import { createRequire } from 'node:module';
import { findByCode, loadAirports } from './airports-api.js';
import '../views/assets/ics.js';
import '../views/assets/route-map.js';

globalThis.SunCalc = globalThis.SunCalc || createRequire(import.meta.url)('suncalc');
await import('../views/assets/night.js');
const { compute, airborne, RULES } = globalThis.NightTime;
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
 * POST /api/night-time/calc  { dep: "VIE", arr: "HAN", off: "2025-03-11T13:00Z", on: "2025-03-11T23:50Z", rule?: "civil"|"nautical"|"sunset"|"fixed",
 *   takeoff?: "2025-03-11T13:12Z", landing?: "2025-03-11T23:41Z", sunrise?: "06:00", sunset?: "18:00" (rule fixed: local time
 *   at the aircraft), track?: true }
 * dep / arr: an airport code (IATA, ICAO, FAA, ...) or "lat,lon"; off / on / takeoff / landing: ISO 8601 times (UTC with Z).
 * The night time is counted from take-off to landing; without them off-block + 10 min / on-block - 5 min (taxi).
 */
// the routes that look up airports load them first (from the site data bucket)
const withAirports = (req, res, next) => loadAirports().then(() => next(), (e) => res.status(e.status || 500).json({ error: e.message }));

router.post('/night-time/calc', withAirports, (req, res) => {
  const body = req.body || {};
  const { dep, arr, off, on, takeoff, landing, rule = 'civil', sunrise = '06:00', sunset = '18:00' } = body;
  if (!dep || !arr || !off || !on) return bad(res, 'dep, arr, off and on are required');
  if (!RULES[rule]) return bad(res, `rule must be one of: ${Object.keys(RULES).join(', ')}`);
  const from = placeOf(dep), to = placeOf(arr);
  if (!from) return res.status(404).json({ error: `Airport "${dep}" not found` });
  if (!to) return res.status(404).json({ error: `Airport "${arr}" not found` });
  const t0 = new Date(off), t1 = new Date(on);
  if (Number.isNaN(+t0) || Number.isNaN(+t1)) return bad(res, 'off and on must be ISO 8601 times, e.g. 2025-03-11T13:00Z');
  if (t1 <= t0) return bad(res, 'On-block must be after off-block.');
  if (t1 - t0 > 24 * 3600000) return bad(res, 'Block time over 24 hours.');
  for (const [k, v] of [['takeoff', takeoff], ['landing', landing]]) {
    if (v != null && v !== '' && Number.isNaN(+new Date(v))) return bad(res, `${k} must be an ISO 8601 time, e.g. 2025-03-11T13:12Z`);
  }
  const air = airborne({ off: t0, on: t1, takeoff, landing });
  if (air.takeoff < t0 || air.landing > t1) return bad(res, 'Take-off and landing must be within the block time.');
  if (!(air.landing > air.takeoff)) return bad(res, 'Landing must be after take-off.');
  if (rule === 'fixed' && (!/^\d{1,2}:\d{2}$/.test(String(sunrise)) || !/^\d{1,2}:\d{2}$/.test(String(sunset)))) return bad(res, 'sunrise and sunset must be times HH:MM, e.g. 06:00 and 18:00');
  let r;
  try { r = compute({ from, to, off: air.takeoff, on: air.landing, rule, sunrise, sunset }); } catch (e) { return bad(res, e.message); }
  const pos = (p) => ({ lat: round(p.lat, 5), lon: round(((p.lon + 540) % 360) - 180, 5) });
  const block = minutes(t1 - t0), flight = minutes(r.totalMs), night = minutes(r.nightMs);
  res.json({
    rule, sunAltitudeLimit: r.limit, ...(rule === 'fixed' ? { sunrise: r.sunrise, sunset: r.sunset } : {}),
    departure: from, arrival: to,
    offBlock: t0.toISOString(), onBlock: t1.toISOString(),
    takeoff: air.takeoff.toISOString(), landing: air.landing.toISOString(), estimated: air.estimated,
    blockMinutes: block, flightMinutes: flight, nightMinutes: night, dayMinutes: flight - night,
    block: hm(block), flight: hm(flight), night: hm(night), day: hm(flight - night),
    takeoffAtNight: r.takeoffNight, landingAtNight: r.landingNight,
    distanceKm: round(r.distanceKm, 1), distanceNm: round(r.distanceKm / 1.852, 1), initialCourseDeg: round(r.courseDeg, 1),
    segments: r.segments.map(s => ({
      night: s.night, from: s.from.toISOString(), to: s.to.toISOString(), minutes: minutes(s.to - s.from),
      fromPosition: pos(s.fromPos), toPosition: pos(s.toPos), fromSunAltitude: round(s.fromAlt, 2), toSunAltitude: round(s.toAlt, 2),
    })),
    ...([true, 1, '1', 'true'].includes(body.track)
      ? { track: r.samples.map(p => ({ time: new Date(p.t).toISOString(), ...pos(p), sunAltitude: round(p.alt, 2) })) }
      : {}),
  });
});

/**
 * POST /api/calendar/export  { name?, published: [row], planned: [row] }  -> text/calendar (a .ics file)
 * ?format=json -> { name, events, skipped, ics } instead.
 */
router.post('/calendar/export', (req, res) => {
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

/**
 * POST /api/route-map  { rosters: [roster], month?: "YYYY-MM", includePlanned?: true }   (or one roster's fields at the top)
 *   roster: { name?, color?: "#rrggbb", and its flights as any of:
 *             published / planned: roster rows (as POST /api/roster/upload gives them),
 *             ics: an iCalendar text (as POST /api/calendar/export gives it),
 *             flights: [{ dep, arr, flight?, date?: "YYYY-MM-DD" }] }
 * -> { rosters, stats, routes, airports, unknown, viewUrl }; ?format=geojson -> a GeoJSON FeatureCollection
 *   (one LineString per route and roster along the great circle, one Point per airport).
 * viewUrl opens /route-map with these routes drawn (append &embed=1 for an iframe, &view=globe for the globe).
 */
const RouteMap = globalThis.RouteMap;
const { flightsFromRows, flightsFromEvents, toParam, greatCircle } = RouteMap;
const { parseIcs } = globalThis.RosterIcs;
const MAX_ROSTERS = 20, MAX_FLIGHTS = 20000;
router.post('/route-map', withAirports, (req, res) => {
  const body = req.body || {};
  const given = Array.isArray(body.rosters) ? body.rosters : ['published', 'planned', 'ics', 'flights'].some(k => body[k]) ? [body] : [];
  if (!given.length) return bad(res, 'Send "rosters": [{ name, published / planned rows, ics, or flights: [{ dep, arr }] }]');
  if (given.length > MAX_ROSTERS) return bad(res, `At most ${MAX_ROSTERS} rosters`);
  const month = body.month == null || body.month === '' ? '' : String(body.month);
  if (month && !/^\d{4}-\d{2}$/.test(month)) return bad(res, 'month must be YYYY-MM');
  const includePlanned = body.includePlanned !== false;
  const rosters = [];
  for (const [i, r] of given.entries()) {
    if (!r || typeof r !== 'object') return bad(res, `rosters[${i}] must be an object`);
    const flights = [];
    if (Array.isArray(r.published) || Array.isArray(r.planned)) flights.push(...flightsFromRows({ published: r.published || [], planned: r.planned || [] }));
    if (typeof r.ics === 'string' && r.ics.trim()) {
      try { flights.push(...flightsFromEvents(parseIcs(r.ics).events)); } catch (e) { return bad(res, `rosters[${i}].ics: ${e.message}`); }
    }
    if (Array.isArray(r.flights)) {
      for (const [k, f] of r.flights.entries()) {
        const dep = String(f?.dep || '').trim().toUpperCase(), arr = String(f?.arr || '').trim().toUpperCase();
        if (!/^[A-Z0-9]{3,4}$/.test(dep) || !/^[A-Z0-9]{3,4}$/.test(arr)) return bad(res, `rosters[${i}].flights[${k}]: dep and arr must be airport codes`);
        if (dep === arr) continue;
        const d = /^(\d{4})-(\d{2})/.exec(String(f.date || ''));
        flights.push({ dep, arr, flight: String(f.flight || ''), month: d ? `${d[1]}-${d[2]}` : '', planned: f.planned === true });
      }
    }
    const color = /^#[0-9a-f]{6}$/i.test(r.color || '') ? r.color : RouteMap.COLORS[i % RouteMap.COLORS.length];
    rosters.push({ name: String(r.name || `Roster ${i + 1}`).slice(0, 100), color, on: true, flights });
  }
  if (rosters.reduce((n, r) => n + r.flights.length, 0) > MAX_FLIGHTS) return bad(res, `At most ${MAX_FLIGHTS} flights`);

  const airports = {};
  for (const code of new Set(rosters.flatMap(r => r.flights.flatMap(f => [f.dep, f.arr])))) {
    const hit = findByCode(code);
    if (hit) { const a = hit.airport; airports[code] = { code, iata: a.iata || null, icao: a.icao || null, name: a.name, city: a.city || null, country: a.country || null, lat: a.lat, lon: a.lon }; }
  }
  const r = RouteMap.routes(rosters, airports, { month, planned: includePlanned });
  const km1 = (v) => Math.round(v * 10) / 10;
  const shown = (f) => (!month || f.month === month) && (includePlanned || !f.planned) && airports[f.dep] && airports[f.arr];

  if (req.query.format === 'geojson') {
    return res.type('application/geo+json').json({
      type: 'FeatureCollection',
      features: [
        ...r.routes.map(x => ({ type: 'Feature', geometry: { type: 'LineString', coordinates: greatCircle(airports[x.a], airports[x.b]).map(([lat, lon]) => [round(lon, 4), round(lat, 4)]) },
          properties: { from: x.a, to: x.b, roster: rosters[x.ci].name, color: rosters[x.ci].color, flights: x.n, distanceKm: km1(x.km), directions: [...x.dirs] } })),
        ...r.used.map(c => ({ type: 'Feature', geometry: { type: 'Point', coordinates: [airports[c].lon, airports[c].lat] }, properties: { ...airports[c] } })),
      ],
    });
  }
  // one entry per airport pair, all rosters together, busiest first
  const pairs = new Map();
  for (const x of r.routes) {
    if (!pairs.has(x.pair)) pairs.set(x.pair, { from: x.a, to: x.b, flights: 0, distanceKm: km1(x.km), directions: new Set(), rosters: [] });
    const p = pairs.get(x.pair);
    p.flights += x.n;
    x.dirs.forEach(d => p.directions.add(d));
    p.rosters.push({ name: rosters[x.ci].name, color: rosters[x.ci].color, flights: x.n });
  }
  const view = new URLSearchParams();
  for (const ro of rosters) {
    const flights = ro.flights.filter(shown);
    if (flights.length) view.append('r', toParam({ ...ro, flights }));
  }
  res.json({
    rosters: rosters.map(ro => ({ name: ro.name, color: ro.color, flights: ro.flights.filter(shown).length, flightsGiven: ro.flights.length })),
    stats: { flights: r.flights, routes: pairs.size, airports: r.used.length, distanceKm: km1(r.km) },
    routes: [...pairs.values()].map(p => ({ ...p, directions: [...p.directions] })).sort((a, b) => b.flights - a.flights || b.distanceKm - a.distanceKm),
    airports: Object.fromEntries(r.used.map(c => [c, airports[c]])),
    unknown: r.unknown,
    viewUrl: `${req.protocol}://${req.get('host')}/route-map?${view}`,
  });
});

export default router;
