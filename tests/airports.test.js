import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import airportsApi from '../routes/airports-api.js';

const app = express().use('/api/airports', airportsApi);
const server = app.listen(0);
const base = `http://localhost:${server.address().port}/api/airports`;
const get = async (path) => { const r = await fetch(base + path); return { status: r.status, body: await r.json() }; };
test.after(() => server.close());

test('an airport by any of its codes', async () => {
  for (const code of ['VIE', 'loww', '11036']) {
    const { body } = await get(`/${code}`);
    assert.equal(body.icao, 'LOWW', code);
    assert.equal(body.iata, 'VIE');
    assert.equal(body.wmo, '11036');
    assert.equal(body.countryName, 'Austria');
  }
  const jfk = (await get('/JFK')).body;
  assert.equal(jfk.faa, 'JFK');
  assert.ok(Math.abs(jfk.lat - 40.64) < 0.01 && Math.abs(jfk.lon + 73.78) < 0.01);
  assert.equal((await get('/ZZZZ9')).status, 404);
});

test('search by name / city, and batch lookup of roster codes', async () => {
  const { body } = await get('/?q=noi%20bai');
  assert.equal(body.results[0].iata, 'HAN');
  assert.equal((await get('/?q=abu%20dhabi')).body.results[0].iata, 'AUH');
  const codes = (await get('/?codes=VIE,PRN,X1')).body;
  assert.deepEqual(Object.keys(codes), ['VIE', 'PRN']);
});
