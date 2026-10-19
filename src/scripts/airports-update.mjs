/**
 * Build data/airports.json (used by /airport and /api/airports) from public-domain lists:
 *   - OurAirports airports.csv + regions.csv  (names, ICAO / IATA / GPS / local (FAA) codes, coordinates, city, country)
 *   - NOAA ISD station history                (WMO station number of the weather station at an airport, by ICAO)
 *
 * Usage:
 *   npm run airports:update                  # download the lists, then build
 *   npm run airports:update -- --from=<dir>  # use airports.csv, regions.csv, isd-history.csv already in <dir>
 */
import fs from 'node:fs';
import path from 'node:path';

const SOURCES = {
  'airports.csv': 'https://davidmegginson.github.io/ourairports-data/airports.csv',
  'regions.csv': 'https://davidmegginson.github.io/ourairports-data/regions.csv',
  'isd-history.csv': 'https://www.ncei.noaa.gov/pub/data/noaa/isd-history.csv',
};
// Airports only: no heliports, balloon ports or closed fields.
const TYPES = ['large_airport', 'medium_airport', 'small_airport', 'seaplane_base'];
const OUT = path.resolve(process.cwd(), 'data', 'airports.json');

const from = process.argv.slice(2).find(a => a.startsWith('--from='))?.split('=')[1];

/** RFC 4180 CSV -> array of objects keyed by the header row. */
function parseCsv(text) {
  const rows = [];
  let row = [], field = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.length > 1 || row[0]) rows.push(row);
      row = [];
    } else field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  const [head, ...body] = rows;
  return body.map(r => Object.fromEntries(head.map((h, i) => [h, r[i] ?? ''])));
}

async function load(name) {
  if (from) return fs.readFileSync(path.join(from, name), 'utf8');
  console.log(`Downloading ${SOURCES[name]}`);
  const res = await fetch(SOURCES[name]);
  if (!res.ok) throw new Error(`${SOURCES[name]}: HTTP ${res.status}`);
  return res.text();
}

const [airportsCsv, regionsCsv, isdCsv] = await Promise.all(Object.keys(SOURCES).map(load));

const regions = new Map(parseCsv(regionsCsv).map(r => [r.code, r.name]));

// WMO block + station number = the first 5 digits of a USAF id ending in 0 (e.g. 110360 -> 11036).
// Several stations can carry one ICAO over time: keep the one reporting most recently.
const wmoByIcao = new Map();
for (const s of parseCsv(isdCsv)) {
  const icao = s.ICAO?.trim();
  if (!/^[A-Z0-9]{4}$/.test(icao) || !/^\d{5}0$/.test(s.USAF) || s.USAF.startsWith('99')) continue;
  const prev = wmoByIcao.get(icao);
  if (!prev || s.END > prev.end) wmoByIcao.set(icao, { wmo: s.USAF.slice(0, 5), end: s.END });
}

const num = (v, digits) => (v === '' ? null : Number(Number(v).toFixed(digits)));
const airports = [];
for (const a of parseCsv(airportsCsv)) {
  if (!TYPES.includes(a.type)) continue;
  const icao = a.icao_code || (/^[A-Z]{4}$/.test(a.gps_code) ? a.gps_code : '');
  if (!icao && !a.iata_code && !a.gps_code && !a.local_code) continue;
  airports.push({
    id: a.ident, // OurAirports ident: the ICAO code when there is one, else a local / generated code
    icao,
    iata: a.iata_code,
    faa: a.iso_country === 'US' ? a.local_code : '', // US local code = FAA location identifier
    local: a.iso_country === 'US' ? '' : a.local_code,
    gps: a.gps_code,
    wmo: wmoByIcao.get(icao)?.wmo || '',
    name: a.name,
    type: a.type.replace('_airport', '').replace('_base', ''),
    lat: num(a.latitude_deg, 5),
    lon: num(a.longitude_deg, 5),
    elev: a.elevation_ft === '' ? null : Number(a.elevation_ft),
    city: a.municipality,
    region: regions.get(a.iso_region) || '',
    country: a.iso_country,
    scheduled: a.scheduled_service === 'yes',
    web: a.home_link,
    wiki: a.wikipedia_link,
  });
}

// Compact: one header + rows of values, ~half the size of an array of objects.
const fields = Object.keys(airports[0]);
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify({
  source: 'OurAirports (public domain), NOAA ISD station history (WMO numbers)',
  built: new Date().toISOString().slice(0, 10),
  fields,
  rows: airports.map(a => fields.map(f => a[f])),
}));
const count = (f) => airports.filter(a => a[f]).length;
console.log(`${airports.length} airports -> ${path.relative(process.cwd(), OUT)} (${(fs.statSync(OUT).size / 1e6).toFixed(1)} MB): ` +
  `ICAO ${count('icao')}, IATA ${count('iata')}, FAA ${count('faa')}, WMO ${count('wmo')}`);
