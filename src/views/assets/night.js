// Night time of a flight: the aircraft flies the great circle from the departure to the arrival
// at a constant speed between off-block and on-block; at each moment the sun's altitude is taken
// at the aircraft's position (SunCalc). Night = the sun below the rule's altitude.
//   <script src="/assets/suncalc/suncalc.js"></script><script src="/assets/night.js"></script>  ->  window.NightTime
//
// NightTime.compute({ from: {lat, lon}, to: {lat, lon}, off: Date, on: Date, rule: 'civil' | 'nautical' | 'sunset' | 'fixed',
//                      sunrise?: 'HH:MM', sunset?: 'HH:MM' })   (fixed: night outside sunrise..sunset local time, 06:00 / 18:00)
//   -> { totalMs, nightMs, dayMs, distanceKm, segments: [{ night, from, to, fromPos, toPos }],
//        takeoffNight, landingNight, samples: [{ t, lat, lon, alt }] }
//   Segment edges are found to the second. Longitudes in `samples` / positions are unwrapped
//   (may pass ±180) so a line drawn through them does not jump across the map.
//   The night time is that of the flight itself: call it with off = take-off, on = landing (NightTime.airborne).
//
// NightTime.airborne({ off, on, takeoff?, landing? }) -> { takeoff: Date, landing: Date, estimated: { takeoff, landing } }
//   A take-off / landing time of the roster is used as it is; without one the taxi is taken off the block
//   time: take-off = off-block + 10 min (taxi-out), landing = on-block - 5 min (taxi-in).
(function (root) {
  const RULES = {
    // ICAO Annex 1 / EASA FCL / FAA 14 CFR 1.1: from the end of evening civil twilight to the
    // beginning of morning civil twilight, i.e. the sun's centre 6° below the horizon.
    civil: { altitude: -6, label: 'Civil twilight (−6°): ICAO / EASA / FAA' },
    // Sunset to sunrise: the top of the sun on the horizon, with refraction.
    sunset: { altitude: -0.833, label: 'Sunset → sunrise (−0.833°)' },
    // From the end of evening nautical twilight to the beginning of morning nautical twilight: the
    // sun's centre 12° below the horizon (the horizon at sea no longer visible).
    nautical: { altitude: -12, label: 'Nautical twilight (−12°)' },
    // Fixed hours: night before `sunrise` and from `sunset` on, in local time at the aircraft. Local time is
    // the mean solar time of its longitude (UTC + 4 min per degree east): no time zone data is needed and it
    // is defined over the sea too; it can differ from a country's clock time by some tens of minutes.
    fixed: { altitude: null, label: 'Fixed hours: sunrise {sunrise} L, sunset {sunset} L' },
  };
  const RAD = Math.PI / 180;
  const EARTH_KM = 6371.0088;
  const SAMPLE_MS = 30 * 1000;

  const sunCalc = () => root.SunCalc || (typeof require === 'function' ? require('suncalc') : null);

  /** Great-circle distance in km. */
  function distanceKm(a, b) {
    const dLat = (b.lat - a.lat) * RAD, dLon = (b.lon - a.lon) * RAD;
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * RAD) * Math.cos(b.lat * RAD) * Math.sin(dLon / 2) ** 2;
    return 2 * EARTH_KM * Math.asin(Math.min(1, Math.sqrt(h)));
  }

  /** The point a fraction f (0..1) of the way along the great circle from a to b. */
  function pointAt(a, b, f) {
    const φ1 = a.lat * RAD, λ1 = a.lon * RAD, φ2 = b.lat * RAD, λ2 = b.lon * RAD;
    const δ = distanceKm(a, b) / EARTH_KM;
    if (δ < 1e-9) return { lat: a.lat, lon: a.lon };
    const A = Math.sin((1 - f) * δ) / Math.sin(δ), B = Math.sin(f * δ) / Math.sin(δ);
    const x = A * Math.cos(φ1) * Math.cos(λ1) + B * Math.cos(φ2) * Math.cos(λ2);
    const y = A * Math.cos(φ1) * Math.sin(λ1) + B * Math.cos(φ2) * Math.sin(λ2);
    const z = A * Math.sin(φ1) + B * Math.sin(φ2);
    return { lat: Math.atan2(z, Math.hypot(x, y)) / RAD, lon: Math.atan2(y, x) / RAD };
  }

  /** Initial true course from a to b, degrees 0..360. */
  function courseDeg(a, b) {
    const φ1 = a.lat * RAD, φ2 = b.lat * RAD, Δλ = (b.lon - a.lon) * RAD;
    const y = Math.sin(Δλ) * Math.cos(φ2);
    const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
    return (Math.atan2(y, x) / RAD + 360) % 360;
  }

  /** Sun altitude in degrees at a place and time. */
  function sunAltitude(t, pos) {
    return sunCalc().getPosition(new Date(t), pos.lat, pos.lon).altitude / RAD;
  }

  /** "06:00" -> 360 (minutes); null when not a time. */
  function clockMinutes(text) {
    const m = /^(\d{1,2}):(\d{2})$/.exec(String(text || '').trim());
    return m && Number(m[1]) < 24 && Number(m[2]) < 60 ? Number(m[1]) * 60 + Number(m[2]) : null;
  }
  /** Local mean time at a longitude, minutes after midnight (0..1440). */
  const localMinutes = (t, lon) => ((((t / 60000) + lon * 4) % 1440) + 1440) % 1440;
  /** Night by fixed hours: before sunrise or from sunset on (a window across midnight works too). */
  const fixedNight = (t, lon, sr, ss) => {
    const m = localMinutes(t, lon);
    return sr < ss ? (m < sr || m >= ss) : (m >= ss && m < sr);
  };

  /** Keep a longitude within 180° of the previous one (for lines across the antimeridian). */
  const unwrap = (lon, prev) => (prev == null ? lon : lon + 360 * Math.round((prev - lon) / 360));

  function compute({ from, to, off, on, rule = 'civil', sunrise = '06:00', sunset = '18:00' }) {
    const t0 = +new Date(off), t1 = +new Date(on);
    const __ = root.__ || ((s) => s);
    if (!(t1 > t0)) throw new Error(__('On-block must be after off-block.'));
    if (!sunCalc()) throw new Error(__('Missing the SunCalc library'));
    if (!RULES[rule]) rule = 'civil';
    const fixed = rule === 'fixed';
    const sr = clockMinutes(sunrise), ss = clockMinutes(sunset);
    if (fixed && (sr == null || ss == null || sr === ss)) throw new Error(__('Sunrise and sunset must be two different times, HH:MM.'));
    const limit = RULES[rule].altitude;
    const span = t1 - t0;
    const posAt = (t) => pointAt(from, to, (t - t0) / span);
    /** Night at a moment and place, by the rule. */
    const isNight = fixed ? (t, p) => fixedNight(t, p.lon, sr, ss) : (t, p) => sunAltitude(t, p) < limit;
    const nightAt = (t) => isNight(t, posAt(t));

    // Sample every 30 s; where night/day flips between two samples, bisect to the second.
    const times = [];
    for (let t = t0; t < t1; t += SAMPLE_MS) times.push(t);
    times.push(t1);
    const edges = [];
    let prevNight = nightAt(t0);
    for (let i = 1; i < times.length; i++) {
      const n = nightAt(times[i]);
      if (n === prevNight) continue;
      let lo = times[i - 1], hi = times[i];
      while (hi - lo > 1000) { const mid = (lo + hi) / 2; if (nightAt(mid) === prevNight) lo = mid; else hi = mid; }
      edges.push(Math.round(hi / 1000) * 1000);
      prevNight = n;
    }

    const bounds = [t0, ...edges, t1];
    const segments = [];
    let night = nightAt(t0), nightMs = 0;
    for (let i = 0; i < bounds.length - 1; i++) {
      const s = { night, from: new Date(bounds[i]), to: new Date(bounds[i + 1]), fromPos: posAt(bounds[i]), toPos: posAt(bounds[i + 1]) };
      s.fromAlt = sunAltitude(bounds[i], s.fromPos);
      s.toAlt = sunAltitude(bounds[i + 1], s.toPos);
      if (night) nightMs += bounds[i + 1] - bounds[i];
      segments.push(s);
      night = !night;
    }

    // Track for the map and the altitude chart (about 300 points), plus the segment edges.
    const n = Math.max(2, Math.min(300, Math.ceil(span / 60000)));
    const sampleTimes = [...new Set([...Array.from({ length: n + 1 }, (_, i) => Math.round(t0 + (span * i) / n)), ...edges])].sort((a, b) => a - b);
    let prevLon = null;
    const samples = sampleTimes.map((t) => {
      const p = posAt(t);
      prevLon = unwrap(p.lon, prevLon);
      return { t, lat: p.lat, lon: prevLon, alt: sunAltitude(t, p) };
    });
    // Positions of the segments on the same unwrapped track
    const lonOn = (t, lon) => { const near = samples.reduce((a, b) => (Math.abs(b.t - t) < Math.abs(a.t - t) ? b : a)); return unwrap(lon, near.lon); };
    for (const s of segments) { s.fromPos.lon = lonOn(+s.from, s.fromPos.lon); s.toPos.lon = lonOn(+s.to, s.toPos.lon); }

    return {
      rule, limit, isNight, ...(fixed ? { sunrise: hhmm(sr), sunset: hhmm(ss) } : {}), totalMs: span, nightMs, dayMs: span - nightMs,
      distanceKm: distanceKm(from, to), courseDeg: courseDeg(from, to),
      segments, samples,
      takeoffNight: segments[0].night, landingNight: segments[segments.length - 1].night,
    };
  }

  // taxi-out / taxi-in of a flight without take-off / landing times
  const TAXI_OUT_MS = 10 * 60000, TAXI_IN_MS = 5 * 60000;
  function airborne({ off, on, takeoff, landing }) {
    const t = (v) => { const d = v == null || v === '' ? null : new Date(v); return d && !Number.isNaN(+d) ? d : null; };
    const offT = t(off), onT = t(on);
    let up = t(takeoff), down = t(landing);
    const estimated = { takeoff: !up, landing: !down };
    if (!up && offT) up = new Date(+offT + TAXI_OUT_MS);
    if (!down && onT) down = new Date(+onT - TAXI_IN_MS);
    // a block too short for the taxi times: the whole block time
    if (up && down && !(down > up) && (estimated.takeoff || estimated.landing)) {
      if (estimated.takeoff) up = offT;
      if (estimated.landing) down = onT;
    }
    return { takeoff: up, landing: down, estimated };
  }

  const hhmm = (min) => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;

  /**
   * Night by fixed hours at time t as a GeoJSON Polygon: the band of longitudes whose local mean time is
   * outside sunrise..sunset (continuous longitudes, may pass ±180). null when there is none.
   */
  function fixedNightPolygon(t, sunrise = '06:00', sunset = '18:00') {
    const sr = clockMinutes(sunrise), ss = clockMinutes(sunset);
    if (sr == null || ss == null || sr === ss) return null;
    // local time m at longitude lon: m = utc + 4 lon; night from ss to sr (next day)
    const utc = ((t / 60000) % 1440 + 1440) % 1440;
    const nightLen = (((sr - ss) % 1440) + 1440) % 1440; // minutes of night
    let west = (ss - utc) / 4; // where local time is `sunset` now: night lies east of it
    west = ((west + 540) % 360) - 180;
    const east = west + nightLen / 4;
    const lat = 89.9, ring = [];
    for (let x = west; x <= east; x += 2) ring.push([x, -lat]);
    ring.push([east, -lat]);
    for (let y = -lat; y <= lat; y += 10) ring.push([east, y]);
    ring.push([east, lat]);
    for (let x = east; x >= west; x -= 2) ring.push([x, lat]);
    ring.push([west, lat]);
    for (let y = lat; y >= -lat; y -= 10) ring.push([west, y]);
    ring.push([west, -lat]);
    return { type: 'Polygon', coordinates: [ring] };
  }

  /** ms -> "h:mm" (rounded to the minute) */
  const hmm = (ms) => { const m = Math.round(ms / 60000); return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}`; };

  /**
   * Where the sun is overhead at time t (ms): { lat, lon } (lon -180..180). Low-precision solar
   * coordinates (Astronomical Almanac), good to about 0.01°: plenty for shading day and night.
   */
  function subsolarPoint(t) {
    const n = t / 86400000 + 2440587.5 - 2451545.0; // days since J2000.0
    const L = (280.460 + 0.9856474 * n) % 360;
    const g = ((357.528 + 0.9856003 * n) % 360) * RAD;
    const λ = (L + 1.915 * Math.sin(g) + 0.020 * Math.sin(2 * g)) * RAD; // ecliptic longitude
    const ε = (23.439 - 0.0000004 * n) * RAD;
    const dec = Math.asin(Math.sin(ε) * Math.sin(λ));
    const ra = Math.atan2(Math.cos(ε) * Math.sin(λ), Math.cos(λ));
    const gmst = (280.46061837 + 360.98564736629 * n) % 360;
    const lon = ((((ra / RAD - gmst) % 360) + 540) % 360) - 180;
    return { lat: dec / RAD, lon };
  }

  /** The point at `distDeg` degrees of arc from `c` in direction `bearingDeg`. */
  function destination(c, bearingDeg, distDeg) {
    const φ1 = c.lat * RAD, λ1 = c.lon * RAD, θ = bearingDeg * RAD, δ = distDeg * RAD;
    const φ2 = Math.asin(Math.sin(φ1) * Math.cos(δ) + Math.cos(φ1) * Math.sin(δ) * Math.cos(θ));
    const λ2 = λ1 + Math.atan2(Math.sin(θ) * Math.sin(δ) * Math.cos(φ1), Math.cos(δ) - Math.sin(φ1) * Math.sin(φ2));
    return { lat: φ2 / RAD, lon: λ2 / RAD };
  }

  /**
   * The part of the Earth where the sun is below `altitude` degrees at time t, as a GeoJSON Polygon
   * ring ([lon, lat] pairs): a circle of radius 90° + altitude around the point opposite the sun.
   * When it holds a pole, it is given as a band from -180° to 180° closed along that pole (a map or
   * globe draws it without a seam); otherwise as a ring with continuous longitudes (they may pass ±180).
   */
  function nightPolygon(t, altitude = 0, steps = 180) {
    const sun = subsolarPoint(t);
    const anti = { lat: -sun.lat, lon: sun.lon + 180 };
    const radius = 90 + altitude;
    const ring = [];
    let prev = null;
    for (let i = 0; i <= steps; i += 1) {
      const p = destination(anti, (360 * i) / steps, radius);
      prev = unwrap(p.lon, prev);
      ring.push([prev, p.lat]);
    }
    // the pole on the night side lies inside when it is no farther from the anti-sun point than the radius
    if (90 - Math.abs(anti.lat) > radius) return { type: 'Polygon', coordinates: [ring] };
    const pole = anti.lat >= 0 ? 90 : -90;
    const pts = ring.slice(0, -1).map(([lon, lat]) => [((((lon + 180) % 360) + 360) % 360) - 180, lat]).sort((a, b) => a[0] - b[0]);
    // the boundary at exactly -180 / 180: from the points either side of the seam
    const first = pts[0], last = pts[pts.length - 1];
    const span = first[0] + 360 - last[0];
    const edgeLat = span > 0 ? last[1] + ((180 - last[0]) / span) * (first[1] - last[1]) : first[1];
    const band = [[-180, edgeLat], ...pts, [180, edgeLat], [180, pole], [-180, pole], [-180, edgeLat]];
    return { type: 'Polygon', coordinates: [band] };
  }

  root.NightTime = { RULES, compute, airborne, TAXI_OUT_MS, TAXI_IN_MS, distanceKm, pointAt, courseDeg, sunAltitude, hmm, subsolarPoint, nightPolygon, fixedNightPolygon, localMinutes, clockMinutes };
})(typeof window !== 'undefined' ? window : globalThis);
