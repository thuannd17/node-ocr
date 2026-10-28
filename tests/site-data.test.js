import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// The site data bucket on a folder store: published files reach the mirror, a missing one is a clear 503.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'roster-site-data-test-'));
process.env.MEDIA_BACKEND = 'fs';
process.env.MEDIA_FS_DIR = path.join(tmp, 'store');
process.env.ROSTER_WORK_DIR = path.join(tmp, 'work');
process.env.SITE_BUCKET = 'site-test';
const { siteFile, publishSiteFile } = await import('../src/services/site-data.js');
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

test('site data: not there yet -> 503; published -> on disk; only known names', async () => {
  await assert.rejects(siteFile('airports.json'), (e) => e.status === 503 && /npm run airports:update/.test(e.message));
  await assert.rejects(siteFile('../.env'), { status: 400 });

  const r = await publishSiteFile('airports.json', Buffer.from('{"fields":[],"rows":[1]}'));
  assert.deepEqual(r.where, { backend: 'fs', dir: path.join(tmp, 'store', '_site-test') });
  assert.ok(fs.existsSync(path.join(tmp, 'store', '_site-test', 'airports.json')));
  const local = await siteFile('airports.json');
  assert.equal(local, path.join(tmp, 'work', 'site', 'airports.json'));
  assert.equal(fs.readFileSync(local, 'utf8'), '{"fields":[],"rows":[1]}');
});

test('site data: the mirror is filled from the bucket when it is missing', async () => {
  fs.rmSync(path.join(tmp, 'work', 'site'), { recursive: true, force: true });
  assert.equal(fs.readFileSync(await siteFile('airports.json'), 'utf8'), '{"fields":[],"rows":[1]}');
});
