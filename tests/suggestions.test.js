import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';

// A folder store in a temp dir (instead of MinIO) and a temp mirror: nothing real touched.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'roster-suggestions-test-'));
process.env.MEDIA_CACHE_DIR = path.join(tmp, 'mirror');
process.env.MEDIA_BACKEND = 'fs';
process.env.MEDIA_FS_DIR = path.join(tmp, 'store');

const { default: rosterApi } = await import('../src/routes/roster-api.js');
const { default: suggestionsApi } = await import('../src/routes/suggestions-api.js');
const { default: i18n } = await import('../src/utils/i18n.js');

const app = express().use(express.json()).use(i18n).use('/api', rosterApi).use('/api', suggestionsApi);
const server = app.listen(0);
const base = `http://localhost:${server.address().port}/api`;
test.after(() => {
  server.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

const roster = (text, note) => {
  const form = new FormData();
  form.append('file', new Blob([text]), 'my roster.txt');
  if (note !== undefined) form.append('note', note);
  form.append('rows', JSON.stringify({ published: [{ date: '01 Mar 25', duty: 'OFF' }], planned: [] }));
  return fetch(`${base}/roster/suggestions`, { method: 'POST', body: form });
};

test('a suggestion: sent from /upload, listed for the admins, dismissed (file deleted, record kept)', async () => {
  const sent = await roster(`suggestion test ${Date.now()}`, 'the duty is wrong');
  assert.equal(sent.status, 201);
  const { id, status } = await sent.json();
  assert.equal(status, 'pending');

  const list = await (await fetch(`${base}/suggestions`)).json();
  const item = list.items.find(x => x.id === id);
  assert.ok(item);
  assert.equal(item.fileName, 'my roster.txt');
  assert.equal(item.note, 'the duty is wrong');
  assert.equal(item.rowCount, 1);
  assert.equal(item.hasFile, true);
  assert.equal(item.rows, undefined); // the list leaves the rows out
  assert.deepEqual((await (await fetch(`${base}/suggestions/${id}`)).json()).rows.published, [{ date: '01 Mar 25', duty: 'OFF' }]);
  assert.equal((await fetch(`${base}/suggestions/${id}/file`)).status, 200);

  assert.equal((await fetch(`${base}/suggestions/${id}/dismiss`, { method: 'POST' })).status, 200);
  assert.equal((await fetch(`${base}/suggestions/${id}/file`)).status, 410);
  assert.equal((await fetch(`${base}/suggestions/${id}/accept`, { method: 'POST' })).status, 409);
  const after = await (await fetch(`${base}/suggestions?status=dismissed`)).json();
  assert.equal(after.items.find(x => x.id === id)?.status, 'dismissed');
});

test('accepting a suggestion adds the file to the data (MinIO + local mirror), deduplicated', async () => {
  const text = `accept test ${Date.now()} ${Math.random()}`;
  const { id } = await (await roster(text)).json();
  const res = await fetch(`${base}/suggestions/${id}/accept`, { method: 'POST' });
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.isNew, true);
  assert.match(body.name, /^[0-9a-f-]{36}\.txt$/);
  assert.equal(fs.readFileSync(path.join(tmp, 'store', 'files', 'txt', body.name), 'utf8'), text);
  assert.equal(fs.readFileSync(path.join(tmp, 'mirror', 'files', 'txt', body.name), 'utf8'), text);
  const meta = await (await fetch(`${base}/suggestions/${id}`)).json();
  assert.equal(meta.status, 'accepted');
  assert.equal(meta.dataName, body.name);
  assert.equal(meta.hasFile, false);

  // the same roster again: the file already in the data is reused
  const again = await (await roster(text)).json();
  const second = await (await fetch(`${base}/suggestions/${again.id}/accept`, { method: 'POST' })).json();
  assert.deepEqual([second.name, second.isNew], [body.name, false]);
});

test('suggestions: bad requests', async () => {
  assert.equal((await fetch(`${base}/roster/suggestions`, { method: 'POST', body: new FormData() })).status, 400);
  assert.equal((await roster('x', 'n'.repeat(2001))).status, 400);
  const bad = new FormData();
  bad.append('file', new Blob(['x']), 'a.txt');
  bad.append('rows', '{nope');
  assert.equal((await fetch(`${base}/roster/suggestions`, { method: 'POST', body: bad })).status, 400);
  assert.equal((await fetch(`${base}/suggestions/../../etc/accept`, { method: 'POST' })).status, 404);
  assert.equal((await fetch(`${base}/suggestions/20990101-000000-abcdef`)).status, 404);
  assert.equal((await fetch(`${base}/suggestions?status=nope`)).status, 400);
});
