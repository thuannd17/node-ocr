// The flights of rosters on a world map: shared by /route-map (the page) and POST /api/route-map
// (routes/tools-api.js), like ics.js and night.js.
//   <script src="/assets/ics.js"></script><script src="/assets/route-map.js"></script>  ->  window.RouteMap
//
// RouteMap.flightsFromEvents(events)          calendar events (RosterIcs.parseIcs) -> flights
// RouteMap.flightsFromRows({ published, planned }) roster rows -> flights
//   A flight: "<flight no> DEP → ARR" (a duty with a digit, or none); ground duties ("GT LTN → STC") are not.
//   flight: { dep, arr, flight, month: "YYYY-MM" | "", planned }
// RouteMap.routes(rosters, airports, { month, planned }) -> { routes, used, unknown, flights, km }
//   rosters: [{ name, color, on, flights }], airports: { CODE: { lat, lon, ... } }
//   routes: one per airport pair and roster, both directions together: { pair, ci, a, b, n, km, dirs }
// RouteMap.greatCircle(a, b, n) -> [[lat, lon], ...] (longitudes continuous over the 180° line)
// RouteMap.distanceKm(a, b)
// RouteMap.toParam(roster) / fromParam(text)  a roster in a URL: "name|#color|AUH-GYD*3,GYD-AUH" (/route-map?r=...)
(function (root) {
  const COLORS = ['#4a90e2', '#e67e22', '#27ae60', '#8e44ad', '#c0392b', '#16a085', '#d35400', '#2c3e50'];
  const ROUTE_RE = /\b([A-Z]{3,4})\s*→\s*([A-Z]{3,4})\b/;
  const CODE_RE = /^[A-Z0-9]{3,4}$/;
  const pad = (n) => String(n).padStart(2, '0');

  /** A duty that is a flight: a flight number ("WAZ7015", "9016", "OS21"), or no duty at all. */
  const isFlightDuty = (duty) => !String(duty || '').trim() || /\d/.test(duty);

  function flightsFromEvents(events) {
    const out = [];
    for (const e of events || []) {
      const m = ROUTE_RE.exec(e.summary || '');
      if (!m || m[1] === m[2] || !(e.kind === 'flight' || !e.kind || e.kind === 'event')) continue;
      const duty = (e.summary || '').slice(0, m.index).trim();
      if (!isFlightDuty(duty)) continue;
      out.push({ dep: m[1], arr: m[2], flight: duty, month: e.start ? `${e.start.y}-${pad(e.start.mo)}` : '',
        planned: e.status === 'TENTATIVE' || /planned/i.test(e.categories || '') });
    }
    return out;
  }

  function flightsFromRows({ published = [], planned = [] } = {}) {
    const out = [];
    const parseDate = root.RosterIcs?.parseDate;
    for (const [section, rows] of [['published', published], ['planned', planned]]) {
      for (const r of Array.isArray(rows) ? rows : []) {
        const dep = String(r?.dep || '').trim().toUpperCase().replace(/^\*/, ''), arr = String(r?.arr || '').trim().toUpperCase().replace(/^\*/, '');
        if (!CODE_RE.test(dep) || !CODE_RE.test(arr) || dep === arr || !isFlightDuty(r.duty)) continue;
        const d = parseDate ? parseDate(String(r.date || '')) : null;
        out.push({ dep, arr, flight: String(r.duty || '').trim(), month: d ? `${d.y}-${pad(d.mo)}` : '', planned: section === 'planned' });
      }
    }
    return out;
  }

  // ---- geometry ----
  const toRad = (d) => d * Math.PI / 180, toDeg = (r) => r * 180 / Math.PI;
  function distanceKm(a, b) {
    const [p1, p2, dl] = [toRad(a.lat), toRad(b.lat), toRad(b.lon - a.lon)];
    const h = Math.sin((p2 - p1) / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
    return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(h)));
  }
  function greatCircle(a, b, n = 64) {
    const [lat1, lon1, lat2, lon2] = [toRad(a.lat), toRad(a.lon), toRad(b.lat), toRad(b.lon)];
    const d = 2 * Math.asin(Math.sqrt(Math.sin((lat2 - lat1) / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin((lon2 - lon1) / 2) ** 2));
    if (!d) return [[a.lat, a.lon], [b.lat, b.lon]];
    const pts = [];
    for (let i = 0; i <= n; i++) {
      const f = i / n, A = Math.sin((1 - f) * d) / Math.sin(d), B = Math.sin(f * d) / Math.sin(d);
      const x = A * Math.cos(lat1) * Math.cos(lon1) + B * Math.cos(lat2) * Math.cos(lon2);
      const y = A * Math.cos(lat1) * Math.sin(lon1) + B * Math.cos(lat2) * Math.sin(lon2);
      const z = A * Math.sin(lat1) + B * Math.sin(lat2);
      let lon = toDeg(Math.atan2(y, x));
      if (pts.length) { const prev = pts[pts.length - 1][1]; while (lon - prev > 180) lon -= 360; while (lon - prev < -180) lon += 360; }
      pts.push([toDeg(Math.atan2(z, Math.sqrt(x * x + y * y))), lon]);
    }
    return pts;
  }

  /** Routes of the shown rosters: one per airport pair and roster (both directions together). */
  function routes(rosters, airports, { month = '', planned = true } = {}) {
    const byKey = new Map(), unknown = new Set(), used = new Set();
    let flights = 0, km = 0;
    rosters.forEach((c, ci) => {
      if (c.on === false) return;
      for (const f of c.flights) {
        if ((month && f.month !== month) || (!planned && f.planned)) continue;
        const a = airports[f.dep], b = airports[f.arr];
        if (!a || !b) { if (!a) unknown.add(f.dep); if (!b) unknown.add(f.arr); continue; }
        const [x, y] = [f.dep, f.arr].sort();
        const key = `${x}-${y}|${ci}`;
        if (!byKey.has(key)) byKey.set(key, { pair: `${x}-${y}`, ci, a: x, b: y, n: 0, km: distanceKm(airports[x], airports[y]), dirs: new Set() });
        const r = byKey.get(key);
        r.n += f.count || 1; r.dirs.add(`${f.dep}-${f.arr}`);
        flights += f.count || 1; km += r.km * (f.count || 1);
        used.add(f.dep); used.add(f.arr);
      }
    });
    return { routes: [...byKey.values()], used: [...used], unknown: [...unknown].sort(), flights, km };
  }

  // ---- a roster in a URL ----
  /** "Jan 25|#4a90e2|AUH-GYD*3,GYD-AUH" (each direction once with its count; "|" and "," never in the name) */
  function toParam(roster) {
    const count = new Map();
    for (const f of roster.flights) count.set(`${f.dep}-${f.arr}`, (count.get(`${f.dep}-${f.arr}`) || 0) + (f.count || 1));
    const name = String(roster.name || '').replace(/[|,]/g, ' ').trim();
    return `${name}|${roster.color || ''}|${[...count].map(([k, n]) => (n > 1 ? `${k}*${n}` : k)).join(',')}`;
  }
  function fromParam(text, i = 0) {
    const [name, color, list = ''] = String(text || '').split('|');
    const flights = [];
    for (const item of list.split(',')) {
      const m = /^([A-Z0-9]{3,4})-([A-Z0-9]{3,4})(?:\*(\d{1,4}))?$/.exec(item.trim().toUpperCase());
      if (m && m[1] !== m[2]) flights.push({ dep: m[1], arr: m[2], flight: '', month: '', planned: false, count: Math.max(1, Number(m[3] || 1)) });
    }
    return { name: name || `Roster ${i + 1}`, color: /^#[0-9a-f]{3,8}$/i.test(color || '') ? color : COLORS[i % COLORS.length], on: true, flights };
  }

  root.RouteMap = { COLORS, flightsFromEvents, flightsFromRows, routes, greatCircle, distanceKm, toParam, fromParam };
})(typeof window !== 'undefined' ? window : globalThis);
