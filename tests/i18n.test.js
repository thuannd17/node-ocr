import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import i18n from '../src/utils/i18n.js';

const dict = globalThis.I18N_VI;
const reqWith = (cookie) => { const req = { headers: { cookie } }; i18n(req, { json() {} }, () => {}); return req; };

test('every Vietnamese text keeps the placeholders of its English key', () => {
  for (const [en, vi] of Object.entries(dict)) {
    const names = (s) => [...s.matchAll(/\{(\w+)\}/g)].map(m => m[1]).sort();
    assert.deepEqual(names(vi), names(en), en);
  }
});

test('English by default; Vietnamese from the lang cookie, also for finished messages', () => {
  assert.equal(reqWith('').__('{n} rows', { n: 2 }), '2 rows');
  assert.equal(reqWith('lang=xx').lang, 'en');
  const vi = reqWith('a=1; lang=vi').__;
  assert.equal(vi('{n} rows', { n: 2 }), '2 dòng');
  assert.equal(vi('Airport "QQQ" not found'), 'Không tìm thấy sân bay "QQQ"');
  assert.equal(vi('Not in the dictionary'), 'Not in the dictionary');
});

test('no Vietnamese left in the page code outside the dictionary', () => {
  const VN = /[ăâđêôơưạảấầẩẫậắằẳẵặẹẻẽếềểễệỉịọỏốồổỗộớờởỡợụủứừửữựỳỵỷỹĐ]/;
  const files = [...fs.readdirSync('src/views').filter(f => f.endsWith('.html')).map(f => `src/views/${f}`), 'src/views/assets/nav.js', 'src/views/assets/ics.js', 'src/views/assets/night.js'];
  for (const f of files) {
    const bad = fs.readFileSync(f, 'utf8').split('\n')
      .filter(l => VN.test(l) && !/^\s*(\/\/|\*|<!--)/.test(l) && !l.includes('Tiếng Việt'));
    assert.deepEqual(bad, [], f);
  }
});
