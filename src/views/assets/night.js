// Night time of a flight: the aircraft flies the great circle from the departure to the arrival
// at a constant speed between off-block and on-block; at each moment the sun's altitude is taken
// at the aircraft's position (SunCalc). Night = the sun below the rule's altitude.
//   <script src="/assets/suncalc/suncalc.js"></script><script src="/assets/night.js"></script>  ->  window.NightTime
//
// NightTime.compute({ from: {lat, lon}, to: {lat, lon}, off: Date, on: Date, rule: 'civil' | 'sunset' })
//   -> { totalMs, nightMs, dayMs, distanceKm, segments: [{ night, from, to, fromPos, toPos }],
//        takeoffNight, landingNight, samples: [{ t, lat, lon, alt }] }
//   Segment edges are found to the second. Longitudes in `samples` / positions are unwrapped
//   (may pass ±180) so a line drawn through them does not jump across the map.
(function (root) {
  const RULES = {
    // ICAO Annex 1 / EASA FCL / FAA 14 CFR 1.1: from the end of evening civil twilight to the
    // beginning of morning civil twilight, i.e. the sun's centre 6° below the horizon.
    civil: { altitude: -6, label: 'Civil twilight (−6°): ICAO / EASA / FAA' },
    // Sunset to sunrise: the top of the sun on the horizon, with refraction.
    sunset: { altitude: -0.833, label: 'Sunset → sunrise (−0.833°)' },
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

  /** Keep a longitude within 180° of the previous one (for lines across the antimeridian). */
  const unwrap = (lon, prev) => (prev == null ? lon : lon + 360 * Math.round((prev - lon) / 360));

  function compute({ from, to, off, on, rule = 'civil' }) {
    const t0 = +new Date(off), t1 = +new Date(on);
    const __ = root.__ || ((s) => s);
    if (!(t1 > t0)) throw new Error(__('On-block must be after off-block.'));
    if (!sunCalc()) throw new Error(__('Missing the SunCalc library'));
    const limit = (RULES[rule] || RULES.civil).altitude;
    const span = t1 - t0;
    const posAt = (t) => pointAt(from, to, (t - t0) / span);
    const nightAt = (t) => sunAltitude(t, posAt(t)) < limit;

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
      rule, limit, totalMs: span, nightMs, dayMs: span - nightMs,
      distanceKm: distanceKm(from, to), courseDeg: courseDeg(from, to),
      segments, samples,
      takeoffNight: segments[0].night, landingNight: segments[segments.length - 1].night,
    };
  }

  /** ms -> "h:mm" (rounded to the minute) */
  const hmm = (ms) => { const m = Math.round(ms / 60000); return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}`; };

  root.NightTime = { RULES, compute, distanceKm, pointAt, courseDeg, sunAltitude, hmm };
})(typeof window !== 'undefined' ? window : globalThis);
