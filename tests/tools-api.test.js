import './helpers/site-data.js'; // first: airports from tests/fixtures in a temp store
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import express from 'express';
import toolsApi from '../src/routes/tools-api.js';
import rosterApi from '../src/routes/roster-api.js';
import i18n from '../src/utils/i18n.js';

const app = express().use(express.json()).use(i18n).use('/api', rosterApi).use('/api', toolsApi);
const server = app.listen(0);
const base = `http://localhost:${server.address().port}/api`;
const json = { 'content-type': 'application/json' };
const night = (body, headers = {}) => fetch(`${base}/night-time/calc`, { method: 'POST', headers: { ...json, ...headers }, body: JSON.stringify(body) });
test.after(() => server.close());

test('POST /api/night-time/calc: night, day and block minutes with the day / night segments', async () => {
  const r = await night({ dep: 'VIE', arr: 'HAN', off: '2025-03-11T13:00Z', on: '2025-03-11T23:50Z' });
  const b = await r.json();
  assert.equal(r.status, 200);
  assert.equal(b.night, '7:27');
  assert.equal(b.nightMinutes + b.dayMinutes, b.blockMinutes);
  assert.deepEqual(b.segments.map(s => s.night), [false, true, false]);
  assert.equal(b.track, undefined);
  const naut = await (await night({ dep: 'VIE', arr: 'HAN', off: '2025-03-11T13:00Z', on: '2025-03-11T23:50Z', rule: 'nautical' })).json();
  assert.deepEqual([naut.rule, naut.sunAltitudeLimit], ['nautical', -12]);
  assert.ok(naut.nightMinutes < b.nightMinutes);
  assert.equal((await night({ dep: 'VIE', arr: 'HAN', off: '2025-03-11T13:00Z', on: '2025-03-11T23:50Z', rule: 'astro' })).status, 400);
  const fixed = await (await night({ dep: 'VIE', arr: 'HAN', off: '2025-03-11T13:00Z', on: '2025-03-11T23:50Z', rule: 'fixed' })).json();
  assert.deepEqual([fixed.rule, fixed.sunAltitudeLimit, fixed.sunrise, fixed.sunset], ['fixed', null, '06:00', '18:00']);
  assert.ok(fixed.nightMinutes > 0 && fixed.nightMinutes < fixed.blockMinutes);
  assert.equal((await night({ dep: 'VIE', arr: 'HAN', off: '2025-03-11T13:00Z', on: '2025-03-11T23:50Z', rule: 'fixed', sunset: '6pm' })).status, 400);
  const track = await (await night({ dep: '48.11,16.57', arr: 'PRN', off: '2025-03-11T21:45Z', on: '2025-03-11T23:20Z', track: true })).json();
  assert.equal(track.nightMinutes, 95);
  assert.ok(track.track.length > 50);
  const bad = await night({ dep: 'VIE', arr: 'ZZZZ9', off: '2025-03-11T21:45Z', on: '2025-03-11T23:20Z' }, { cookie: 'lang=vi' });
  assert.equal(bad.status, 404);
  assert.equal((await bad.json()).error, 'Không tìm thấy sân bay "ZZZZ9"');
  assert.equal((await night({ dep: 'VIE' })).status, 400);
  assert.equal((await fetch(`${base}/night-time?dep=VIE&arr=HAN&off=2025-03-11T13:00Z&on=2025-03-11T23:50Z`)).status, 404); // the old GET is gone
});

test('POST /api/calendar/export: rows to an iCalendar file, or JSON', async () => {
  const body = JSON.stringify({ name: 'Test', published: [
    { date: '11 Mar 25', duty: 'OS 769', dep: 'VIE', arr: 'PRN', begin: '21:45 Z', end: '23:20 Z' },
    { date: 'nope', duty: 'OFF' },
  ] });
  const r = await fetch(`${base}/calendar/export`, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /text\/calendar/);
  assert.equal(r.headers.get('x-events'), '1');
  assert.equal(r.headers.get('x-skipped-rows'), '1');
  assert.match(await r.text(), /SUMMARY:OS 769 VIE → PRN/);
  const j = await (await fetch(`${base}/calendar/export?format=json`, { method: 'POST', headers: { 'content-type': 'application/json' }, body })).json();
  assert.equal(j.events, 1);
  assert.equal((await fetch(`${base}/calendar/export`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status, 400);
});

test('POST /api/roster/upload: one "file" field, any roster type; bad requests answered before reading', async () => {
  const none = await fetch(`${base}/roster/upload`, { method: 'POST', body: new FormData() });
  assert.equal(none.status, 400);
  assert.match((await none.json()).error, /"file"/);
  const form = new FormData();
  form.append('file', new Blob(['MZ']), 'tool.exe');
  const exe = await fetch(`${base}/roster/upload`, { method: 'POST', body: form });
  assert.equal(exe.status, 400);
  assert.match((await exe.json()).error, /JPG, JPEG, PNG.*PDF, CSV, XLS, XLSX, TXT/);
});

test('the OpenAPI spec documents every public route and every $ref resolves', () => {
  const spec = JSON.parse(fs.readFileSync('docs/openapi.json', 'utf8'));
  for (const p of ['/api/roster/upload', '/api/roster/suggestions', '/api/calendar/export', '/api/airports', '/api/airports/{code}', '/api/airports/{code}/weather', '/api/night-time/calc']) {
    assert.ok(spec.paths[p], p);
  }
  for (const old of ['/api/ocr/upload', '/api/pdf/upload', '/api/night-time', '/api/calendar/ics']) assert.equal(spec.paths[old], undefined, `${old} is deprecated / renamed`);
  const refs = JSON.stringify(spec).match(/"#\/components\/[^"]+"/g) || [];
  for (const ref of new Set(refs)) {
    const target = ref.slice(3, -1).split('/').reduce((o, k) => o?.[k], spec);
    assert.ok(target, `unresolved ${ref}`);
  }
});
