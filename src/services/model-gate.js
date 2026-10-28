/**
 * Checks of a training run (scripts/model-train.mjs) before a new AI model version is used:
 *
 *   suspectGrowth(before, after) -> { ok, total, grown: [{ file, before, after }] }
 *     before/after: { file: words tagged with a field whose value in their row does not hold them }
 *     (scripts/build-pdf-token-data.mjs, summary.suspect; the active version keeps its own in meta.json).
 *     Many more such words in the files trained before means the training words went wrong
 *     (a dash beside each flight number tagged "duty"): training stops before the tagger's hour.
 *     Files new since then are not counted: a new layout's labels are checked by hand on /label.
 *
 *   compareRuns(before, after) -> { ok, same, added, layouts, reasons }
 *     before: the active version's benchmark run, per file [rows right, rows] (benchmark-history summary.files)
 *     after:  the new version's run (model-benchmark result.files: { file, layout, rowMatches, rowTotal, error })
 *     Scored on the files both runs read: the new version is used only when it reads them about
 *     as well overall and no layout loses many rows (one model for every layout: a new one's
 *     words can pull another layout's down). Files new since then are reported, not gated.
 */

// Training words: a file may gain this many such words (a relabeled file), all files together this many.
export const SUSPECT_FILE_GROWTH = 200;
export const SUSPECT_TOTAL_GROWTH = 1000;
// Benchmark: rows right over the same files may drop by this share of their rows (retraining moves a few);
// a layout may lose this many rows, or this share of its rows when that is more.
export const OVERALL_DROP = 0.005;
export const LAYOUT_DROP_ROWS = 50;
export const LAYOUT_DROP_SHARE = 0.1;

export function suspectGrowth(before = {}, after = {}) {
  const grown = [];
  let total = 0;
  for (const [file, n] of Object.entries(after)) {
    if (!(file in before)) continue;
    const d = n - before[file];
    total += d;
    if (d >= SUSPECT_FILE_GROWTH) grown.push({ file, before: before[file], after: n });
  }
  // (a file whose words are all right now is missing from after)
  for (const [file, n] of Object.entries(before)) if (!(file in after)) total -= n;
  grown.sort((a, b) => (b.after - b.before) - (a.after - a.before));
  return { ok: !grown.length && total < SUSPECT_TOTAL_GROWTH, total, grown };
}

export function compareRuns(before, after) {
  const same = { files: 0, before: 0, after: 0, rows: 0 };
  const added = { files: 0, after: 0, rows: 0 };
  const layouts = {};
  for (const f0 of after) {
    const old = before[f0.file];
    // (a file the new version fails on reads no row right)
    const f = f0.error ? { ...f0, rowMatches: 0, rowTotal: old?.[1] ?? 0 } : f0;
    if (f0.error && !old) continue;
    if (!old) {
      if (!(f.file in before)) { added.files += 1; added.after += f.rowMatches; added.rows += f.rowTotal; }
      continue; // (null: the file failed in the earlier run)
    }
    same.files += 1; same.before += old[0]; same.after += f.rowMatches; same.rows += f.rowTotal;
    const l = layouts[f.layout || 'unknown'] ||= { layout: f.layout || 'unknown', files: 0, before: 0, after: 0, rows: 0 };
    l.files += 1; l.before += old[0]; l.after += f.rowMatches; l.rows += f.rowTotal;
  }
  const reasons = [];
  if (same.before - same.after > OVERALL_DROP * same.rows) {
    reasons.push(`rows right on the same ${same.files} files ${same.before} -> ${same.after} of ${same.rows}`);
  }
  const list = Object.values(layouts).sort((a, b) => (a.after - a.before) - (b.after - b.before));
  for (const l of list) {
    if (l.before - l.after > Math.max(LAYOUT_DROP_ROWS, LAYOUT_DROP_SHARE * l.rows)) {
      reasons.push(`layout ${l.layout} (${l.files} files) ${l.before} -> ${l.after} of ${l.rows} rows`);
    }
  }
  return { ok: !reasons.length, same, added, layouts: list, reasons };
}
