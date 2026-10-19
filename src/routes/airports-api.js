// /routes/airports-api.js
// Airport lookup for /airport (and the airport links on /calendar), mounted at /api/airports.
// Data: data/airports.json, built by `npm run airports:update` (OurAirports + NOAA WMO numbers).
// Weather: Open-Meteo forecast (free, no key), fetched by the server and cached.
import { Router } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataFile = path.resolve(__dirname, '..', '..', 'data', 'airports.json');

const router = Router();
const CODE_FIELDS = ['iata', 'icao', 'faa', 'gps', 'local', 'id', 'wmo'];
const TYPE_RANK = { large: 0, medium: 1, small: 2, seaplane: 3 };
const countryNames = new Intl.DisplayNames(['en'], { type: 'region' });
const countryName = (cc) => { try { return countryNames.of(cc) || cc; } catch { return cc; } };
const fold = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

let db = null; // { list, byCode: Map<code, airport[]> }, loaded on first use
function airports() {
  if (db) return db;
  if (!fs.existsSync(dataFile)) throw Object.assign(new Error('data/airports.json is missing: run `npm run airports:update`'), { status: 503 });
  const { fields, rows } = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
  const list = rows.map((r) => {
    const a = Object.fromEntries(fields.map((f, i) => [f, r[i]]));
    a.countryName = countryName(a.country);
    a.text = fold(`${a.name} ${a.city} ${a.region} ${a.countryName}`);
    return a;
  });
  const byCode = new Map();
  for (const a of list) for (const f of CODE_FIELDS) {
    const code = a[f] && String(a[f]).toUpperCase();
    if (!code) continue;
    if (!byCode.has(code)) byCode.set(code, []);
    if (!byCode.get(code).includes(a)) byCode.get(code).push(a);
  }
  db = { list, byCode };
  return db;
}

// Bigger, scheduled airports first: "VIE" should be Vienna, not a strip somewhere that reuses it as a local code.
const rank = (a) => (a.scheduled ? 0 : 10) + (TYPE_RANK[a.type] ?? 5);
const byRank = (x, y) => rank(x) - rank(y) || x.name.localeCompare(y.name);

/** The airport a code means: IATA first, then ICAO, FAA, GPS, ... (the order of CODE_FIELDS). */
export function findByCode(code) {
  const hits = airports().byCode.get(String(code || '').trim().toUpperCase()) || [];
  for (const f of CODE_FIELDS) {
    const same = hits.filter(a => String(a[f]).toUpperCase() === String(code).trim().toUpperCase()).sort(byRank);
    if (same.length) return { airport: same[0], matchedBy: f };
  }
  return null;
}

export const brief = ({ text, ...a }) => a;

/**
 * GET /api/airports?q=vienna        -> up to `limit` airports matching a code, name, city or country
 * GET /api/airports?codes=VIE,PRN   -> { VIE: airport, PRN: airport } for the codes that are airports
 */
router.get('/', (req, res, next) => {
  try {
    if (req.query.codes) {
      const out = {};
      for (const c of String(req.query.codes).split(',').map(s => s.trim()).filter(Boolean).slice(0, 50)) {
        const hit = findByCode(c);
        if (hit) out[c.toUpperCase()] = brief(hit.airport);
      }
      return res.json(out);
    }
    const q = String(req.query.q || '').trim();
    const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 20));
    if (!q) return res.json({ q, results: [] });
    const { list, byCode } = airports();
    const exact = (byCode.get(q.toUpperCase()) || []).slice().sort(byRank);
    const words = fold(q).split(/\s+/).filter(Boolean);
    const named = [];
    if (q.length >= 2) {
      for (const a of list) {
        if (exact.includes(a) || !words.every(w => a.text.includes(w))) continue;
        named.push(a);
      }
      // Name or city starting with the query before ones that only contain it.
      const starts = (a) => (fold(a.name).startsWith(words[0]) || fold(a.city).startsWith(words[0]) ? 0 : 1);
      named.sort((x, y) => starts(x) - starts(y) || byRank(x, y));
    }
    const results = [...exact, ...named].slice(0, limit).map(brief);
    res.json({ q, total: exact.length + named.length, results });
  } catch (err) { next(err); }
});

/** GET /api/airports/:code -> one airport by IATA, ICAO, FAA, GPS, local, ident or WMO code. */
router.get('/:code', (req, res, next) => {
  try {
    const hit = findByCode(req.params.code);
    if (!hit) return res.status(404).json({ error: `Airport "${req.params.code}" not found` });
    const others = (airports().byCode.get(req.params.code.toUpperCase()) || []).filter(a => a !== hit.airport).map(brief);
    res.json({ ...brief(hit.airport), matchedBy: hit.matchedBy, others });
  } catch (err) { next(err); }
});

// 7-day forecast at the airport. Cached per airport for 30 min so a busy page does not hammer the free API.
const WEATHER_TTL_MS = 30 * 60 * 1000;
const weatherCache = new Map();
const DAILY = ['weather_code', 'temperature_2m_max', 'temperature_2m_min', 'precipitation_sum', 'precipitation_probability_max',
  'wind_speed_10m_max', 'wind_gusts_10m_max', 'wind_direction_10m_dominant', 'sunrise', 'sunset'];
const CURRENT = ['temperature_2m', 'relative_humidity_2m', 'weather_code', 'wind_speed_10m', 'wind_direction_10m', 'pressure_msl', 'visibility', 'cloud_cover'];

/** GET /api/airports/:code/weather -> { timezone, current, daily: [{ date, code, tmax, tmin, ... }] } */
router.get('/:code/weather', async (req, res, next) => {
  try {
    const hit = findByCode(req.params.code);
    if (!hit) return res.status(404).json({ error: `Airport "${req.params.code}" not found` });
    const a = hit.airport;
    const cached = weatherCache.get(a.id);
    if (cached && Date.now() - cached.at < WEATHER_TTL_MS) return res.json(cached.data);
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${a.lat}&longitude=${a.lon}&timezone=auto&forecast_days=7`
      + `&wind_speed_unit=kn&daily=${DAILY.join(',')}&current=${CURRENT.join(',')}`;
    const r = await fetch(url, { signal: AbortSignal.timeout(15000) });
    if (!r.ok) return res.status(502).json({ error: `Open-Meteo returned HTTP ${r.status}` });
    const w = await r.json();
    const d = w.daily || {};
    const data = {
      source: 'Open-Meteo.com',
      timezone: w.timezone, utcOffsetSeconds: w.utc_offset_seconds,
      current: w.current ? {
        time: w.current.time, temp: w.current.temperature_2m, humidity: w.current.relative_humidity_2m,
        code: w.current.weather_code, wind: w.current.wind_speed_10m, windDir: w.current.wind_direction_10m,
        pressure: w.current.pressure_msl, visibility: w.current.visibility, cloud: w.current.cloud_cover,
      } : null,
      daily: (d.time || []).map((date, i) => ({
        date, code: d.weather_code[i], tmax: d.temperature_2m_max[i], tmin: d.temperature_2m_min[i],
        rain: d.precipitation_sum[i], rainChance: d.precipitation_probability_max[i],
        wind: d.wind_speed_10m_max[i], gust: d.wind_gusts_10m_max[i], windDir: d.wind_direction_10m_dominant[i],
        sunrise: d.sunrise[i], sunset: d.sunset[i],
      })),
    };
    weatherCache.set(a.id, { at: Date.now(), data });
    res.json(data);
  } catch (err) {
    if (err.name === 'TimeoutError' || err.cause) return res.status(502).json({ error: `Could not get the weather: ${err.message}` });
    next(err);
  }
});

router.use((err, req, res, next) => res.status(err.status || 500).json({ error: err.message }));

export default router;
