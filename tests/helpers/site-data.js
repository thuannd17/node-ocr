// Import first in a test that looks up airports: a folder store (MEDIA_BACKEND=fs) in a temp folder whose
// site data bucket holds tests/fixtures/airports.json (a few airports), and a temp work folder.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'roster-site-test-'));
process.env.MEDIA_BACKEND = 'fs';
process.env.MEDIA_FS_DIR = path.join(tmp, 'store');
process.env.ROSTER_WORK_DIR = path.join(tmp, 'work');
delete process.env.SITE_BUCKET;
fs.mkdirSync(path.join(tmp, 'store', '_site-data'), { recursive: true });
fs.copyFileSync(new URL('../fixtures/airports.json', import.meta.url), path.join(tmp, 'store', '_site-data', 'airports.json'));
process.on('exit', () => fs.rmSync(tmp, { recursive: true, force: true }));
