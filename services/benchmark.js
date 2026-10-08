// /services/benchmark.js
import fs from 'node:fs';
import path from 'node:path';
import { extractRaw } from './parsers.js';
import { groupByContent, pickCanonicalLabels, splitByGroup, rosterClusters, assignFolds } from '../utils/content-groups.js';

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
 */
export function alignRows(predRows = [], expRows = []) {
  const n = predRows.length;
  const m = expRows.length;
  const gap = FIELDS.length;

  const dp = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  const bt = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(''));

  for (let i = 1; i <= n; i++) {
    dp[i][0] = i * gap;
    bt[i][0] = 'up';
  }
  for (let j = 1; j <= m; j++) {
    dp[0][j] = j * gap;
    bt[0][j] = 'left';
  }

  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      const diag = dp[i - 1][j - 1] + rowMismatchCost(predRows[i - 1], expRows[j - 1]);
      const up = dp[i - 1][j] + gap;
      const left = dp[i][j - 1] + gap;
      const best = Math.min(diag, up, left);
      dp[i][j] = best;
      bt[i][j] = best === diag ? 'diag' : (best === up ? 'up' : 'left');
    }
  }

  const aligned = [];
  let i = n, j = m;
  while (i > 0 || j > 0) {
    const move = bt[i][j] || (i > 0 ? 'up' : 'left');
    if (move === 'diag') {
      aligned.push({ pred: predRows[i - 1], exp: expRows[j - 1], idx: aligned.length });
      i--; j--;
    } else if (move === 'up') {
      aligned.push({ pred: predRows[i - 1], exp: null, idx: aligned.length });
      i--;
    } else {
      aligned.push({ pred: null, exp: expRows[j - 1], idx: aligned.length });
      j--;
    }
  }
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
 *   content-group split (scripts/build-recognition-groundtruth.mjs, same
 *   splitByGroup + trainRatio) — 'val' is the only honest score for a
 *   fine-tuned model, since it never saw those images. Default 'all'.
 * folds/fold: with folds=K, split picks fold `fold` ('val') or the rest
 *   ('train') of the roster-cluster K-fold split the dataset builder uses
 *   with --folds/--fold. Requires dedupe.
 * @param {{ strategy?: string, folderPath: string, labelsPath: string, onEvent?: Function, shouldStop?: Function, dedupe?: boolean, split?: 'all'|'train'|'val', trainRatio?: number }} opts
 * @returns {Promise<object>}
 */
export async function runBenchmark({ strategy, folderPath, labelsPath, onEvent, shouldStop, dedupe = false, split = 'all', trainRatio = 0.8, folds = 0, fold = 0, foldMap = null }) {
  if (!fs.existsSync(folderPath)) throw new Error('fake-data folder not found: ' + folderPath);
  if (!fs.existsSync(labelsPath)) throw new Error('labels/ folder not found: ' + labelsPath);

  // Lấy tất cả ảnh trong fake-data
  const allFiles = fs.readdirSync(folderPath, { withFileTypes: true })
    .filter(d => d.isFile() && /\.(jpe?g|png|jfif)$/i.test(d.name))
    .map(d => d.name);

  // Chỉ giữ lại những ảnh đã có label
  let labeled = allFiles.filter((name) => {
    const labelFile = path.join(labelsPath, `${name}.json`);
    return fs.existsSync(labelFile);
  });
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
      // (kfold-recognition.mjs). Recomputing clusters here picked duplicate
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
    const filePath = path.join(folderPath, name);
    const labelFile = path.join(labelsPath, `${name}.json`);

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
      // No Gemini fallback while scoring: the benchmark measures our OCR + parser.
      predData = await extractRaw(filePath, { ...(strategy ? { strategy } : {}), allowVlmFallback: false });
    } catch (e) {
      const row = { file: name, error: 'Extraction failed: ' + e.message };
      fileResults[idx] = row;
      completed += 1;
      onEvent?.({ type: 'file', file: row, progress: { current: completed, total: labeled.length } });
      return;
    }

    const pubCmp = compareSection(predData.published || [], expData.published || []);
    const planCmp = compareSection(predData.planned || [], expData.planned || []);

    const row = { file: name, sections: { published: pubCmp, planned: planCmp } };
    fileResults[idx] = row;

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
