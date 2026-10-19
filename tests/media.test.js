import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

// The media library (media/) on a folder store instead of MinIO, and the app's client + local mirror.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'roster-media-test-'));
process.env.MEDIA_CACHE_DIR = path.join(tmp, 'mirror');
process.env.MEDIA_BACKEND = 'fs';
process.env.MEDIA_FS_DIR = path.join(tmp, 'store');
process.env.ROSTER_WORK_DIR = path.join(tmp, 'work');
const { createMedia } = await import('../src/services/storage/index.js');
const { createMinioStore } = await import('../src/services/storage/minio-store.js');
const media = await import('../src/services/media-client.js');
const { DATA_ROOT, LABELS_ROOT } = await import('../src/utils/data-files.js');
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const md5 = (b) => crypto.createHash('md5').update(b).digest('hex');

test('media: names are checked, health of the store', async () => {
  assert.deepEqual(await media.mediaHealth(), { ok: true, backend: 'fs', dir: path.join(tmp, 'store') });
  await assert.rejects(media.fileBytes('../../x.jpg'), { status: 400 });
  await assert.rejects(media.fileBytes('x.exe'), { status: 400 });
  assert.equal(await media.fileBytes('a.jpg'), null);
  assert.equal(await media.localFile('../x.jpg'), null);
});

test('store a file (deduplicated by content), label it, mirror it, delete it to the trash', async () => {
  const img = crypto.randomBytes(500);
  const a = await media.storeFile(img, 'IMG_1.JPG');
  assert.equal(a.isNew, true);
  assert.match(a.name, /^[0-9a-f-]{36}\.jpg$/);
  assert.deepEqual(await media.storeFile(img, 'copy.jpg'), { name: a.name, isNew: false });
  assert.ok(fs.existsSync(path.join(DATA_ROOT, 'jpg', a.name)));

  assert.equal(await media.readLabel(a.name), null);
  await media.saveLabel(a.name, { published: [{ date: '1 Mar 25' }], planned: [] });
  assert.deepEqual((await media.readLabel(a.name)).published, [{ date: '1 Mar 25' }]);
  // labels need their file
  await assert.rejects(media.saveLabel('00000000-0000-0000-0000-000000000000.jpg', { published: [] }), { status: 404 });

  // the mirror: wiped, then rebuilt by one sync; same bytes as the store
  fs.rmSync(path.join(tmp, 'mirror'), { recursive: true, force: true });
  const r = await media.syncMedia({ force: true });
  assert.equal(r.downloaded, 2);
  assert.equal(md5(fs.readFileSync(path.join(DATA_ROOT, 'jpg', a.name))), md5(img));
  assert.ok(fs.existsSync(path.join(LABELS_ROOT, 'jpg', `${a.name}.json`)));
  assert.equal((await media.syncMedia({ force: true })).downloaded, 0); // nothing changed: nothing downloaded

  // removed in the store (another process, the MinIO console): removed from the mirror by the next sync
  fs.rmSync(path.join(tmp, 'store', 'labels', 'jpg', `${a.name}.json`));
  assert.equal((await media.syncMedia({ force: true })).removed, 1);
  assert.ok(!fs.existsSync(path.join(LABELS_ROOT, 'jpg', `${a.name}.json`)));

  const del = await media.deleteFile(a.name);
  assert.equal(del.moved.length, 1);
  assert.match(del.moved[0], /^trash\/\d{4}-\d{2}-\d{2}\/files\/jpg\//);
  assert.ok(fs.existsSync(path.join(tmp, 'store', ...del.moved[0].split('/'))));
  assert.ok(!fs.existsSync(path.join(DATA_ROOT, 'jpg', a.name)));
  assert.equal(await media.localFile(a.name), null);
});

test('import keeps the given names and bytes', async () => {
  const name = '11111111-2222-3333-4444-555555555555.pdf';
  await media.importFile(name, Buffer.from('%PDF-1.4 test'));
  const label = Buffer.from('{\n  "published": []\n}');
  await media.importLabel(name, label);
  const index = await media.mediaIndex(true);
  assert.equal(index.files.find(f => f.name === name).md5, md5(Buffer.from('%PDF-1.4 test')));
  assert.equal(index.labels.find(l => l.name === name).md5, md5(label));
  await assert.rejects(media.importLabel(name, Buffer.from('[1]')), { status: 400 });
});

test('MinIO down: a clear 503 error', async () => {
  const down = createMedia(createMinioStore({ MINIO_ENDPOINT: '127.0.0.1', MINIO_PORT: '9', MINIO_ACCESS_KEY: 'x', MINIO_SECRET_KEY: 'y' }));
  await assert.rejects(down.index(), (e) => e.code === 'MEDIA_DOWN' && media.mediaErrorStatus(e) === 503 && /MinIO at http:\/\/127\.0\.0\.1:9/.test(e.message));
  const h = await down.health();
  assert.equal(h.ok, false);
  assert.match(h.error, /Cannot reach MinIO/);
});

test('AI models: kept in the store, mirrored to the work folder; activate, benchmark, delete to the trash', async () => {
  const ai = await import('../src/services/ai-models.js');
  const { WORK_DIR } = await import('../src/utils/paths.js');
  assert.equal(WORK_DIR, path.join(tmp, 'work'));
  assert.ok(ai.AI_DIR.startsWith(WORK_DIR));
  // two versions as a training run leaves them, published to the store
  for (const id of ['20261001-000000', '20261002-000000']) {
    const { dir } = ai.newVersionDir(`${id.slice(0, 4)}-${id.slice(4, 6)}-${id.slice(6, 8)}T00:00:00Z`);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'tagger.joblib'), `model ${id}`);
    fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({ trainedAt: id }));
    await ai.publishModel(id);
  }
  await ai.activateModel('20261001-000000');
  assert.equal(ai.listModels().find(m => m.active).id, '20261001-000000');

  // the mirror wiped: everything comes back from the store, with the active one
  fs.rmSync(ai.AI_DIR, { recursive: true, force: true });
  assert.deepEqual(ai.listModels(), []);
  assert.equal((await ai.syncModels({ force: true })).downloaded, 5);
  assert.deepEqual(ai.listModels().map(m => [m.id, m.active]), [['20261002-000000', false], ['20261001-000000', true]]);

  await ai.saveBenchmark(ai.activeModelDir(), { at: 'now', overall: { rowMatches: 1, rowTotal: 2 } });
  assert.ok(fs.existsSync(path.join(tmp, 'store', 'models', 'ai', '20261001-000000', 'benchmark.json')));

  await assert.rejects(ai.deleteModel('20261001-000000'), { status: 409 }); // the active one
  await ai.deleteModel('20261002-000000');
  assert.equal((await media.listModelObjects('models/ai/20261002-000000/')).length, 0);
  const trash = fs.readdirSync(path.join(tmp, 'store', 'trash'));
  assert.ok(fs.existsSync(path.join(tmp, 'store', 'trash', trash[0], 'models', 'ai', '20261002-000000', 'tagger.joblib')));
  assert.deepEqual(ai.listModels().map(m => m.id), ['20261001-000000']);
  await assert.rejects(media.putModelObject('models/../x', Buffer.from('x')), { status: 400 });
});

test('OCR models: versions in the store, active.json, statuses, delete to the trash; checkpoints never mirrored', async () => {
  const rec = await import('../src/services/rec-models.js');
  const store = path.join(tmp, 'store', 'models', 'rec');
  for (const v of ['stock', 'v1', 'v2']) {
    fs.mkdirSync(path.join(store, v, 'infer'), { recursive: true });
    fs.writeFileSync(path.join(store, v, 'infer', 'inference.pdiparams'), `weights ${v}`);
    fs.writeFileSync(path.join(store, v, 'model.json'), JSON.stringify({ status: v === 'v1' ? 'deployed' : 'rejected' }));
  }
  fs.mkdirSync(path.join(store, 'v1', 'checkpoint'), { recursive: true });
  fs.writeFileSync(path.join(store, 'v1', 'checkpoint', 'latest.pdparams'), 'big');
  fs.writeFileSync(path.join(store, 'active.json'), JSON.stringify({ id: 'v1' }));

  await rec.syncRecModels({ force: true });
  assert.ok(rec.REC_DIR.startsWith(path.join(tmp, 'work')));
  assert.ok(!fs.existsSync(path.join(rec.REC_DIR, 'v1', 'checkpoint'))); // ~750 MB in real life: left in MinIO
  assert.equal(rec.activeRecId(), 'v1');
  assert.deepEqual(rec.listRecModels().map(m => [m.id, m.active]), [['v2', false], ['v1', true], ['stock', false]]);

  await rec.activateRec('v2');
  assert.equal(JSON.parse(fs.readFileSync(path.join(store, 'active.json'), 'utf8')).id, 'v2');
  assert.equal(JSON.parse(fs.readFileSync(path.join(store, 'v2', 'model.json'), 'utf8')).status, 'deployed');
  assert.equal(JSON.parse(fs.readFileSync(path.join(store, 'v1', 'model.json'), 'utf8')).status, 'retired');

  await assert.rejects(rec.deleteRec('v2'), { status: 409 }); // in use
  await assert.rejects(rec.deleteRec('stock'), { status: 409 });
  await rec.deleteRec('v1');
  assert.equal((await media.listModelObjects('models/rec/v1/')).length, 0); // with its checkpoint
  assert.deepEqual(rec.listRecModels().map(m => m.id), ['v2', 'stock']);

  process.env.OCR_REC_VERSION = 'stock';
  try {
    assert.equal(rec.activeRecId(), 'stock');
    await assert.rejects(rec.activateRec('v2'), { status: 409 }); // pinned on this machine
  } finally {
    delete process.env.OCR_REC_VERSION;
  }
});
