import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';

// A folder store in a temp dir (instead of MinIO) and a temp mirror: nothing real touched.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'roster-suggestions-test-'));
process.env.MEDIA_CACHE_DIR = path.join(tmp, 'mirror');
process.env.ROSTER_WORK_DIR = path.join(tmp, 'work'); // the ACARS mirror and uploads too: never the real work folder
process.env.ACARS_CACHE_DIR = path.join(tmp, 'acars-mirror');
process.env.MEDIA_BACKEND = 'fs';
process.env.MEDIA_FS_DIR = path.join(tmp, 'store');

const { default: rosterApi } = await import('../src/routes/roster-api.js');
const { default: suggestionsApi } = await import('../src/routes/suggestions-api.js');
const { default: acarsApi } = await import('../src/routes/acars-api.js');
const { default: i18n } = await import('../src/utils/i18n.js');

const app = express().use(express.json()).use(i18n).use('/api', rosterApi).use('/api', acarsApi).use('/api', suggestionsApi);
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

test('a suggestion: sent from /roster, listed for the admins, dismissed (file deleted, record kept)', async () => {
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

  const dismiss = (body) => fetch(`${base}/suggestions/${id}/dismiss`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal((await dismiss({})).status, 400); // a reason is needed
  assert.equal((await dismiss({ reason: 'not a roster' })).status, 200);
  assert.equal((await fetch(`${base}/suggestions/${id}/file`)).status, 410);
  assert.equal((await fetch(`${base}/suggestions/${id}/accept`, { method: 'POST' })).status, 409);
  const after = await (await fetch(`${base}/suggestions?status=dismissed`)).json();
  const gone = after.items.find(x => x.id === id);
  assert.deepEqual([gone?.status, gone?.ticket, gone?.dismissReason], ['dismissed', 'resolved', 'not a roster']);
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

test('/helpdesk: the sender\'s email, the ticket state and a reply (no mail server: mailto, then recorded)', async () => {
  delete process.env.SMTP_HOST; delete process.env.MAIL_FROM; // never a real email from the tests
  const form = new FormData();
  form.append('file', new Blob([`helpdesk test ${Date.now()}`]), 'r.txt');
  form.append('email', 'not an email');
  assert.equal((await fetch(`${base}/roster/suggestions`, { method: 'POST', body: form })).status, 400);
  form.set('email', ' crew@example.com ');
  const { id } = await (await fetch(`${base}/roster/suggestions`, { method: 'POST', body: form })).json();

  const list = await (await fetch(`${base}/suggestions?ticket=open`)).json();
  const item = list.items.find(x => x.id === id);
  assert.deepEqual([item.email, item.ticket, item.replies], ['crew@example.com', 'open', []]);
  assert.ok(list.tickets.open >= 1);

  const json = (method, body) => ({ method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal((await fetch(`${base}/suggestions/${id}`, json('PATCH', { ticket: 'nope' }))).status, 400);
  const patched = await (await fetch(`${base}/suggestions/${id}`, json('PATCH', { ticket: 'in_progress', adminNote: 'fixing' }))).json();
  assert.deepEqual([patched.ticket, patched.adminNote], ['in_progress', 'fixing']);

  assert.deepEqual(await (await fetch(`${base}/helpdesk/mail`)).json(), { configured: false, from: null });
  const reply = { subject: 'Done', message: 'Thank you', resolve: true };
  const noServer = await fetch(`${base}/suggestions/${id}/reply`, json('POST', reply));
  assert.equal(noServer.status, 501);
  assert.match((await noServer.json()).mailto, /^mailto:crew%40example\.com\?subject=Done&body=Thank%20you$/);
  const sent = await (await fetch(`${base}/suggestions/${id}/reply`, json('POST', { ...reply, via: 'mailto' }))).json();
  assert.equal(sent.ticket, 'resolved');
  assert.deepEqual(sent.replies.map(r => [r.to, r.subject, r.via]), [['crew@example.com', 'Done', 'mailto']]);

  // dismissing it (with a reason) leaves it resolved
  await fetch(`${base}/suggestions/${id}/dismiss`, json('POST', { reason: 'done' }));
  assert.equal((await (await fetch(`${base}/suggestions?status=all`)).json()).items.find(x => x.id === id).ticket, 'resolved');
});

test('an ACARS suggestion: sent from /acars with the fields read; Label it puts the picture in the ACARS bucket', async () => {
  const png = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex'); // any bytes: only stored
  const form = new FormData();
  form.append('file', new Blob([png, Buffer.from(String(Date.now()))]), 'cockpit.png');
  form.append('email', 'pilot@example.com');
  form.append('fields', JSON.stringify({ flt: 'SA0558', out: '12:32', bogus: 'x' }));
  assert.equal((await fetch(`${base}/acars/suggestions`, { method: 'POST', body: new FormData() })).status, 400);
  const sent = await fetch(`${base}/acars/suggestions`, { method: 'POST', body: form });
  assert.equal(sent.status, 201);
  const { id } = await sent.json();
  const item = (await (await fetch(`${base}/suggestions?ticket=all`)).json()).items.find(x => x.id === id);
  assert.deepEqual([item.kind, item.email, item.fieldCount], ['acars', 'pilot@example.com', 2]);
  const meta = await (await fetch(`${base}/suggestions/${id}`)).json();
  assert.equal(meta.fields.flt, 'SA0558');
  assert.equal(meta.fields.bogus, undefined);
  const acc = await (await fetch(`${base}/suggestions/${id}/accept`, { method: 'POST' })).json();
  assert.match(acc.name, /^[0-9a-f-]{36}\.png$/);
  assert.ok(fs.existsSync(path.join(tmp, 'store', '_acars-ocr', 'files', acc.name))); // the ACARS bucket, flat
  assert.ok(!fs.existsSync(path.join(tmp, 'store', 'files', 'png', acc.name)));      // not the roster data
});

test('download a suggestion\'s file under its original name, also after Label it (from the data)', async () => {
  const text = `download test ${Date.now()} ${Math.random()}`;
  const { id } = await (await roster(text)).json();
  const get = () => fetch(`${base}/suggestions/${id}/download`);
  let res = await get();
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-disposition'), /attachment; filename="my roster\.txt"/);
  assert.equal(await res.text(), text);
  await fetch(`${base}/suggestions/${id}/accept`, { method: 'POST' });
  res = await get();
  assert.equal(res.status, 200);
  assert.equal(await res.text(), text);
});
