// /services/benchmark.js
import fs from 'node:fs';
import { extractWithPaddleOCR } from './paddle-ocr.js';
import { groupByContent, pickCanonicalLabels, splitByGroup, rosterClusters, assignFolds } from '../utils/content-groups.js';
import { listData, dataFile, labelFile as labelPathOf } from '../utils/data-files.js';

const FIELDS = ['date', 'day', 'duty', 'dep', 'begin', 'end', 'arr'];

/**
 * Levenshtein distance (классический dp) cho đo sai khác text nhẹ.
 */
export function levenshtein(a, b) {
  a = String(a || '');
  b = String(b || '');
  const m = a.length, n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  const dp = new Array(n + 1);
  for (let j = 0; j <= n; j++) dp[j] = j;
  for (let i = 1; i <= m; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= n; j++) {
      const tmp = dp[j];
      dp[j] = Math.min(
        dp[j] + 1,            // deletion
        dp[j - 1] + 1,        // insertion
        prev + (a[i - 1] === b[j - 1] ? 0 : 1) // substitution
      );
      prev = tmp;
    }
  }
  return dp[n];
}

export function normalizeField(field, value) {
  const raw = String(value || '').trim().replace(/\s+/g, ' ');
  if (!raw) return '';

  if (field === 'day') return raw.slice(0, 3).toUpperCase();
  if (field === 'dep' || field === 'arr') return raw.toUpperCase();

  if (field === 'duty') {
    return raw
      .toUpperCase()
      .replace(/^0FF\b/g, 'OFF')
      .replace(/\bOFF\s*\(\s*[0O2Z]\s*\)/g, 'OFF(Z)')
      .replace(/\bA\/L\s*\.\s*\(/g, 'A/L(');
  }

  if (field === 'begin' || field === 'end') {
    const m = raw.toUpperCase().match(/(\d{1,2})[:.]?(\d{2})\s*([Z])?/);
    if (!m) return raw.toUpperCase();
    const hh = String(Number(m[1])).padStart(2, '0');
    const mm = String(Number(m[2])).padStart(2, '0');
    return `${hh}:${mm} Z`;
  }

  if (field === 'date') {
    return raw
      .replace(/\s+/g, ' ')
      .replace(/\b([A-Za-z]{3})[A-Za-z]*\b/g, (_m, mon) => mon[0].toUpperCase() + mon.slice(1).toLowerCase());
  }

  return raw;
}

function rowMismatchCost(pred, exp) {
  if (!pred && !exp) return 0;
  if (!pred || !exp) return FIELDS.length;
  let miss = 0;
  for (const f of FIELDS) {
    const pv = normalizeField(f, pred[f]);
    const ev = normalizeField(f, exp[f]);
    if (pv !== ev) miss++;
  }
  return miss;
}

/**
 * Align predicted and expected rows using sequence alignment.
 * This avoids catastrophic score drops when one inserted/missed row shifts all indexes.
 * The rows the two lists start and end with alike are paired as they are, the alignment
 * (rows normalized once, typed arrays) runs on what lies between: a 10 000-row file read
 * right takes milliseconds, not the minutes and gigabyte of a full n x m table.
 */
export function alignRows(predRows = [], expRows = []) {
  const gap = FIELDS.length;
  const norm = (r) => FIELDS.map(f => normalizeField(f, r?.[f]));
  const P = predRows.map(norm), E = expRows.map(norm);
  const cost = (a, b) => { let miss = 0; for (let f = 0; f < gap; f++) if (a[f] !== b[f]) miss++; return miss; };
  let head = 0;
  while (head < P.length && head < E.length && cost(P[head], E[head]) === 0) head++;
  let tail = 0;
  while (tail < P.length - head && tail < E.length - head && cost(P[P.length - 1 - tail], E[E.length - 1 - tail]) === 0) tail++;
  const n = P.length - head - tail;
  const m = E.length - head - tail;
  const W = m + 1;

  const dp = new Int32Array((n + 1) * W);
  const bt = new Uint8Array((n + 1) * W); // 1 diag, 2 up, 3 left
  for (let i = 1; i <= n; i++) { dp[i * W] = i * gap; bt[i * W] = 2; }
  for (let j = 1; j <= m; j++) { dp[j] = j * gap; bt[j] = 3; }

  for (let i = 1; i <= n; i++) {
    const a = P[head + i - 1];
    for (let j = 1; j <= m; j++) {
      const diag = dp[(i - 1) * W + j - 1] + cost(a, E[head + j - 1]);
      const up = dp[(i - 1) * W + j] + gap;
      const left = dp[i * W + j - 1] + gap;
      const best = Math.min(diag, up, left);
      dp[i * W + j] = best;
      bt[i * W + j] = best === diag ? 1 : (best === up ? 2 : 3);
    }
  }

  const aligned = [];
  for (let k = predRows.length - 1; k >= predRows.length - tail; k--) aligned.push({ pred: predRows[k], exp: expRows[k - predRows.length + expRows.length] });
  let i = n, j = m;
  while (i > 0 || j > 0) {
    const move = bt[i * W + j] || (i > 0 ? 2 : 3);
    if (move === 1) {
      aligned.push({ pred: predRows[head + i - 1], exp: expRows[head + j - 1] });
      i--; j--;
    } else if (move === 2) {
      aligned.push({ pred: predRows[head + i - 1], exp: null });
      i--;
    } else {
      aligned.push({ pred: null, exp: expRows[head + j - 1] });
      j--;
    }
  }
  for (let k = head - 1; k >= 0; k--) aligned.push({ pred: predRows[k], exp: expRows[k] });
  return aligned.reverse().map((r, idx) => ({ ...r, idx }));
}

 /**
  * Categorize extraction errors for better diagnostics.
  */
 function categorizeError(pred, exp, field) {
   if (!exp) return 'missing_expected';
   if (!pred) return 'missing_extracted';
   
   const expVal = String(exp || '');
   const predVal = String(pred || '');
   
   if (predVal === '') return 'empty_extraction';
   
   // For duty codes, check pattern mismatch
   if (field === 'duty') {
     const isValidDuty = /^(OFF|SBY|RST|FR|DH|A\/L|F\/D|SIM|TRG|C\d|IDP)/.test(predVal);
     if (!isValidDuty && expVal.length > 2) return 'pattern_mismatch';
   }
   
   // For times, check format mismatch
   if (field === 'begin' || field === 'end') {
     const validTimeFormat = /^\d{2}:\d{2}\s+Z$/.test(predVal);
     if (!validTimeFormat && predVal.length > 0) return 'format_mismatch';
   }
   
   // For airports, check length
   if (field === 'dep' || field === 'arr') {
     if (predVal.length !== 3) return 'format_mismatch';
   }
   
   return 'value_mismatch';
 }

/**
 * Đoán ý compare per-section (published / planned).
 */
export function compareSection(predSection = [], expSection = []) {
   const zipped = alignRows(predSection, expSection);
   const perField = {};
   for (const f of FIELDS) perField[f] = { matches: 0, total: 0, levSum: 0 };

   const errorsByType = {};
   let rowMatches = 0;
   const rowErrors = [];
   for (const { pred, exp, idx } of zipped) {
     // Một row được coi là match nếu cả pred & exp tồn tại + mọi field bằng nhau
     let rowOk = !!pred && !!exp;
     for (const f of FIELDS) {
       const pv = pred ? normalizeField(f, pred[f]) : '';
       const ev = exp ? normalizeField(f, exp[f]) : '';
       const fieldMatch = pv === ev;
       if (!fieldMatch) rowOk = false;
       perField[f].total += 1;
       if (fieldMatch) perField[f].matches += 1;
       perField[f].levSum += levenshtein(pv, ev);
       if (!fieldMatch && pred && exp) {
         const errorType = categorizeError(pv, ev, f);
         rowErrors.push({ rowIdx: idx, field: f, expected: ev, actual: pv, errorType });
         
         // Track error types
         if (!errorsByType[f]) errorsByType[f] = {};
         if (!errorsByType[f][errorType]) errorsByType[f][errorType] = 0;
         errorsByType[f][errorType]++;
       }
     }
     if (rowOk) rowMatches += 1;
   }

   return {
     predCount: predSection.length,
     expCount: expSection.length,
     rowMatches,
     rowTotal: zipped.length,
     perField,
     rowErrors,
     errorsByType,
   };
 }

function aggregatePerField(fileResults) {
   const agg = {};
   for (const f of FIELDS) {
     agg[f] = { matches: 0, total: 0, levSum: 0 };
   }
   for (const r of fileResults) {
     for (const secKey of ['published', 'planned']) {
       const sec = r.sections?.[secKey];
       if (!sec) continue;
       for (const f of FIELDS) {
         agg[f].matches += sec.perField[f].matches;
         agg[f].total += sec.perField[f].total;
         agg[f].levSum += sec.perField[f].levSum;
       }
     }
   }
   return agg;
 }

function buildFinalResult({ strategy, split, labeled, allFiles, fileResults, completed, stopped }) {
  const processed = fileResults.filter(Boolean);
  const successRows = processed.filter((r) => !r.error);
  const aggPerField = aggregatePerField(successRows);

  let totalRowMatches = 0;
  let totalRowTotal = 0;
  for (const r of successRows) {
    for (const secKey of ['published', 'planned']) {
      totalRowMatches += r.sections[secKey].rowMatches;
      totalRowTotal += r.sections[secKey].rowTotal;
    }
  }

  const errorAnalysis = aggregateErrorAnalysis(processed);
  const errorInsights = [];

  for (const [field, errors] of Object.entries(errorAnalysis)) {
    const total = Object.values(errors).reduce((s, c) => s + c, 0);
    if (total === 0) continue;

    const sorted = Object.entries(errors)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3);

    const topErrors = sorted.map(([type, count]) =>
      `${type}: ${count} (${Math.round(count / total * 100)}%)`
    ).join(', ');

    errorInsights.push(`${field}: ${topErrors}`);
  }

  // Per table: row exact match plus how many rows were found vs labeled —
  // a table that isn't located (predCount 0) or loses rows shows up here
  // even when the rows that were found read correctly.
  const perSection = {};
  for (const secKey of ['published', 'planned']) {
    const s = { rowMatches: 0, rowTotal: 0, predRows: 0, expRows: 0, filesWithTable: 0, filesTableMissed: 0 };
    for (const r of successRows) {
      const sec = r.sections[secKey];
      s.rowMatches += sec.rowMatches;
      s.rowTotal += sec.rowTotal;
      s.predRows += sec.predCount;
      s.expRows += sec.expCount;
      if (sec.expCount > 0) {
        s.filesWithTable += 1;
        if (sec.predCount === 0) s.filesTableMissed += 1;
      }
    }
    s.rowExactMatchRate = s.rowTotal > 0 ? s.rowMatches / s.rowTotal : 0;
    perSection[secKey] = s;
  }

  return {
    strategy: strategy || 'auto',
    split,
    labeledCount: labeled.length,
    processedCount: completed,
    stopped,
    skipped: allFiles.length - labeled.length,
    files: processed,
    aggregate: {
      rowExactMatchRate: totalRowTotal > 0 ? totalRowMatches / totalRowTotal : 0,
      rowMatches: totalRowMatches,
      rowTotal: totalRowTotal,
      perField: aggPerField,
      perSection,
    },
    errorAnalysis,
    errorInsights: errorInsights.slice(0, 5),
  };
}

 /**
  * Aggregate error types across all files.
  */
 function aggregateErrorAnalysis(fileResults) {
   const errorSummary = {};
   
   for (const r of fileResults) {
     if (r.error) continue;
     for (const secKey of ['published', 'planned']) {
       const sec = r.sections?.[secKey];
       if (!sec?.errorsByType) continue;
       for (const [field, errors] of Object.entries(sec.errorsByType)) {
         if (!errorSummary[field]) errorSummary[field] = {};
         for (const [errorType, count] of Object.entries(errors)) {
           if (!errorSummary[field][errorType]) errorSummary[field][errorType] = 0;
           errorSummary[field][errorType] += count;
         }
       }
     }
   }
   
   return errorSummary;
 }

/**
 * dedupe: score each byte-identical image once (using its most plausible label copy) instead of once per file.
 * split: 'train' | 'val' scores only that side of the recognition dataset's
 *   content-group split (scripts/ocr-groundtruth.mjs, same
 *   splitByGroup + trainRatio) — 'val' is the only honest score for a
 *   fine-tuned model, since it never saw those images. Default 'all'.
 * folds/fold: with folds=K, split picks fold `fold` ('val') or the rest
 *   ('train') of the roster-cluster K-fold split the dataset builder uses
 *   with --folds/--fold. Requires dedupe.
 * @param {{ strategy?: string, folderPath: string, labelsPath: string, onEvent?: Function, shouldStop?: Function, dedupe?: boolean, split?: 'all'|'train'|'val', trainRatio?: number }} opts
 * @returns {Promise<object>}
 */
export async function runBenchmark({ strategy, folderPath, labelsPath, onEvent, shouldStop, dedupe = false, split = 'all', trainRatio = 0.8, folds = 0, fold = 0, foldMap = null }) {
  if (!fs.existsSync(folderPath)) throw new Error('Roster files folder not found: ' + folderPath);
  if (!fs.existsSync(labelsPath)) throw new Error('Labels folder not found: ' + labelsPath);

  // Lấy tất cả ảnh trong fake-data/<ext>/
  const allFiles = listData(folderPath, 'image');

  // Chỉ giữ lại những ảnh đã có label
  let labeled = allFiles.filter((name) => fs.existsSync(labelPathOf(labelsPath, name)));
  if (dedupe) {
    const { canonical } = pickCanonicalLabels(groupByContent(folderPath, labeled), labelsPath);
    const keep = new Set(canonical.values());
    labeled = labeled.filter(name => keep.has(name));
  }
  if (split !== 'all') {
    const groupOf = new Map();
    for (const [id, members] of groupByContent(folderPath, labeled)) for (const m of members) groupOf.set(m, id);
    let sideOf = (name) => splitByGroup(groupOf.get(name), trainRatio);
    if (foldMap) {
      // Explicit image -> fold map, the same file the dataset builder used
      // (ocr-kfold.mjs). Recomputing clusters here picked duplicate
      // copies differently from the builder (members[0] vs
      // pickCanonicalLabels), so ~half of each "held-out" fold had been
      // trained on (found 2026-10-01).
      sideOf = (name) => (foldMap[name] === fold ? 'val' : 'train');
    } else if (folds) {
      const canonical = new Map();
      for (const [id, members] of groupByContent(folderPath, labeled)) canonical.set(id, members[0]);
      const foldOf = assignFolds(rosterClusters(canonical, labelsPath), folds);
      sideOf = (name) => (foldOf.get(groupOf.get(name)) === fold ? 'val' : 'train');
    }
    labeled = labeled.filter(name => sideOf(name) === split);
  }

  if (labeled.length === 0) {
    onEvent?.({ type: 'done', progress: { current: 0, total: 0 } });
    return {
      strategy: strategy || 'auto',
      labeledCount: 0,
      processedCount: 0,
      stopped: false,
      files: [],
      skipped: allFiles.length,
      message: 'No labels yet. Visit /label and create some labels/<file>.json first.',
    };
  }

  onEvent?.({
    type: 'start',
    strategy: strategy || 'auto',
    labeledCount: labeled.length,
    skipped: allFiles.length - labeled.length,
    progress: { current: 0, total: labeled.length },
  });

  const fileResults = [];
  // Stability mode: always process sequentially to avoid CPU/RAM spikes.
  let completed = 0;

  const runOne = async ({ name, idx }) => {
    const filePath = dataFile(folderPath, name);
    const labelFile = labelPathOf(labelsPath, name);

    let expData;
    try {
      expData = JSON.parse(fs.readFileSync(labelFile, 'utf8'));
    } catch (e) {
      const row = { file: name, error: 'Invalid label JSON: ' + e.message };
      fileResults[idx] = row;
      completed += 1;
      onEvent?.({ type: 'file', file: row, progress: { current: completed, total: labeled.length } });
      return;
    }

    let predData;
    try {
      predData = await extractWithPaddleOCR(filePath);
    } catch (e) {
      const row = { file: name, error: 'Extraction failed: ' + e.message };
      fileResults[idx] = row;
      completed += 1;
      onEvent?.({ type: 'file', file: row, progress: { current: completed, total: labeled.length } });
      return;
    }

    const pubCmp = compareSection(predData.published || [], expData.published || []);
    const planCmp = compareSection(predData.planned || [], expData.planned || []);

    fileResults[idx] = { file: name, sections: { published: pubCmp, planned: planCmp } };

    const rowMatch = pubCmp.rowMatches + planCmp.rowMatches;
    const rowTotal = pubCmp.rowTotal + planCmp.rowTotal;
    completed += 1;
    onEvent?.({
      type: 'file',
      file: {
        file: name,
        rowMatch,
        rowTotal,
        fieldErrors: pubCmp.rowErrors.length + planCmp.rowErrors.length,
        published: { predCount: pubCmp.predCount, expCount: pubCmp.expCount },
        planned: { predCount: planCmp.predCount, expCount: planCmp.expCount },
      },
      progress: { current: completed, total: labeled.length },
    });
  };

  for (let idx = 0; idx < labeled.length; idx += 1) {
    if (shouldStop?.()) break;
    await runOne({ name: labeled[idx], idx });
  }

  const stopped = completed < labeled.length;
  const finalResult = buildFinalResult({
    strategy,
    split,
    labeled,
    allFiles,
    fileResults,
    completed,
    stopped,
  });

  onEvent?.({
    type: 'done',
    progress: { current: completed, total: labeled.length },
    result: finalResult,
  });

  return finalResult;
}
