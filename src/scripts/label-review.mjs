#!/usr/bin/env node
/**
 * Labels waiting for a person's review (`_review` in the label, utils/data-files.js reviewOf): a correction a
 * user submitted on /roster or /acars, or a label a script / Claude changed. /label shows them ("Only files to
 * review"); saving one there marks it reviewed. Until then they are left out of training, benchmarks and checks.
 *
 *   npm run label:review                                   list them
 *   npm run label:review -- --mark <name> [<name> ...] [--note "what changed"] [--acars]
 *                                                          mark labels as changed by Claude, to be reviewed
 *   npm run label:review -- --clear <name> [...] [--acars] reviewed without opening /label (rarely: Save there instead)
 */
import { syncForScript, readLabel, saveLabel, acars } from '../services/media-client.js';
import { listLabels, reviewOf, LABELS_ROOT, ACARS_LABELS_ROOT } from '../utils/data-files.js';

const args = process.argv.slice(2);
const isAcars = args.includes('--acars');
const noteAt = args.indexOf('--note');
const note = noteAt >= 0 ? String(args[noteAt + 1] || '').trim() : '';
const names = args.filter((a, i) => !a.startsWith('--') && i !== noteAt + 1);
const store = isAcars ? acars : { readLabel, saveLabel, syncForScript };

await store.syncForScript();

if (args.includes('--mark') || args.includes('--clear')) {
  const mark = args.includes('--mark');
  if (!names.length) { console.error('Name the labels: --mark <name> [<name> ...]'); process.exit(1); }
  for (const name of names) {
    const label = await store.readLabel(name);
    if (!label) { console.log(`${name}: no label`); continue; }
    const { _review, ...rest } = label;
    const next = mark ? { ...rest, _review: { by: 'claude', at: new Date().toISOString(), ...(note ? { note } : {}) } } : rest;
    await store.saveLabel(name, next);
    console.log(`${name}: ${mark ? 'to review' : 'reviewed'}`);
  }
} else {
  const lists = [['roster', LABELS_ROOT, listLabels(LABELS_ROOT)], ['acars', ACARS_LABELS_ROOT, listLabels(ACARS_LABELS_ROOT, 'image')]];
  let n = 0;
  for (const [what, root, all] of lists) {
    for (const name of all) {
      const r = reviewOf(root, name);
      if (!r) continue;
      n++;
      console.log(`${what}  ${name}  by ${r.by || 'user'} at ${r.at || '?'}${r.suggestion ? `  suggestion ${r.suggestion}` : ''}${r.proposed ? '  (proposed version)' : ''}${r.note ? `  — ${r.note}` : ''}`);
    }
  }
  console.log(`${n} label(s) to review`);
}
