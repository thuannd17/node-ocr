import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import express from 'express';
import toolsApi from '../routes/tools-api.js';
import i18n from '../utils/i18n.js';

const app = express().use(express.json()).use(i18n).use('/api', toolsApi);
const server = app.listen(0);
const base = `http://localhost:${server.address().port}/api`;
test.after(() => server.close());

test('GET /api/night-time: night, day and block minutes with the day / night segments', async () => {
  const r = await fetch(`${base}/night-time?dep=VIE&arr=HAN&off=2025-03-11T13:00Z&on=2025-03-11T23:50Z`);
  const b = await r.json();
  assert.equal(r.status, 200);
  assert.equal(b.night, '7:27');
  assert.equal(b.nightMinutes + b.dayMinutes, b.blockMinutes);
  assert.deepEqual(b.segments.map(s => s.night), [false, true, false]);
  assert.equal(b.track, undefined);
  const track = await (await fetch(`${base}/night-time?dep=48.11,16.57&arr=PRN&off=2025-03-11T21:45Z&on=2025-03-11T23:20Z&track=1`)).json();
  assert.equal(track.nightMinutes, 95);
  assert.ok(track.track.length > 50);
  const bad = await fetch(`${base}/night-time?dep=VIE&arr=ZZZZ9&off=2025-03-11T21:45Z&on=2025-03-11T23:20Z`, { headers: { cookie: 'lang=vi' } });
  assert.equal(bad.status, 404);
  assert.equal((await bad.json()).error, 'Không tìm thấy sân bay "ZZZZ9"');
  assert.equal((await fetch(`${base}/night-time?dep=VIE`)).status, 400);
});

test('POST /api/calendar/ics: rows to an iCalendar file, or JSON', async () => {
  const body = JSON.stringify({ name: 'Test', published: [
    { date: '11 Mar 25', duty: 'OS 769', dep: 'VIE', arr: 'PRN', begin: '21:45 Z', end: '23:20 Z' },
    { date: 'nope', duty: 'OFF' },
  ] });
  const r = await fetch(`${base}/calendar/ics`, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /text\/calendar/);
  assert.equal(r.headers.get('x-events'), '1');
  assert.equal(r.headers.get('x-skipped-rows'), '1');
  assert.match(await r.text(), /SUMMARY:OS 769 VIE → PRN/);
  const j = await (await fetch(`${base}/calendar/ics?format=json`, { method: 'POST', headers: { 'content-type': 'application/json' }, body })).json();
  assert.equal(j.events, 1);
  assert.equal((await fetch(`${base}/calendar/ics`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status, 400);
});

test('the OpenAPI spec documents every public route and every $ref resolves', () => {
  const spec = JSON.parse(fs.readFileSync('docs/openapi.json', 'utf8'));
  for (const p of ['/api/ocr/upload', '/api/pdf/upload', '/api/calendar/ics', '/api/airports', '/api/airports/{code}', '/api/airports/{code}/weather', '/api/night-time']) {
    assert.ok(spec.paths[p], p);
  }
  const refs = JSON.stringify(spec).match(/"#\/components\/[^"]+"/g) || [];
  for (const ref of new Set(refs)) {
    const target = ref.slice(3, -1).split('/').reduce((o, k) => o?.[k], spec);
    assert.ok(target, `unresolved ${ref}`);
  }
});
