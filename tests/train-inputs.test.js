import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { trainingInputs, inputChanges } from '../src/services/train-inputs.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'train-inputs-test-'));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const put = (rel, text) => { const p = path.join(tmp, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, text); };
const inputs = (env = {}) => trainingInputs({
  collections: [{ labelsRoot: path.join(tmp, 'labels'), dataRoot: path.join(tmp, 'files'), kinds: ['pdf', 'image'] }],
  codeDirs: [path.join(tmp, 'code')], env,
});

test('training inputs: the same labels, files and code give the same hashes; any change of them shows', () => {
  put('files/pdf/a.pdf', 'PDF a');
  put('labels/pdf/a.pdf.json', '{"rows":[]}');
  put('files/png/b.png', 'PNG b');
  put('labels/png/b.png.json', '{"rows":[1]}');
  put('files/pdf/unlabeled.pdf', 'not trained on');
  put('code/tagger.py', 'x = 1');
  const first = inputs();
  assert.equal(first.files, 2);
  assert.deepEqual(inputChanges(first, inputs()), []);
  // a file without a label, or code that is not training code, changes nothing
  put('files/pdf/other.pdf', 'still unlabeled');
  put('code/notes.txt', 'not code');
  assert.deepEqual(inputChanges(first, inputs()), []);

  put('labels/pdf/a.pdf.json', '{"rows":[{"date":"01"}]}');
  const edited = inputs();
  assert.deepEqual(inputChanges(first, edited), ['labels or their files edited (2 files)']);

  put('labels/pdf/other.pdf.json', '{"rows":[]}');
  assert.deepEqual(inputChanges(edited, inputs()), ['labels: 2 -> 3 files']);

  const now = inputs();
  put('code/tagger.py', 'x = 2');
  assert.deepEqual(inputChanges(now, inputs()), ['training code or PDF_TAGGER_ settings']);
  assert.deepEqual(inputChanges(inputs(), inputs({ PDF_TAGGER_C: '0.5' })), ['training code or PDF_TAGGER_ settings']);
  assert.deepEqual(inputChanges(inputs(), inputs({ PDF_TAGGER_JOBS: '2' })), [], 'threads do not change the model');
});

test('training inputs: a label waiting for review is not trained on, so it changes nothing', () => {
  const before = inputs();
  put('files/pdf/c.pdf', 'PDF c');
  put('labels/pdf/c.pdf.json', '{"rows":[],"_review":{"by":"user"}}');
  assert.deepEqual(inputChanges(before, inputs()), []);
});

test('training inputs: a version trained before they were recorded has no record (null: train)', () => {
  assert.equal(inputChanges(undefined, inputs()), null);
  assert.equal(inputChanges({}, inputs()), null);
});
