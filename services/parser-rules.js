/**
 * Parser patterns (known duty codes, column zones) from models/parser-patterns.json.
 *
 * The file is a fixed config: it was produced by the old calibration step,
 * which was removed 2026-10-06 because it rewrote the file on every label save
 * and so silently changed results for every image. Edit it deliberately and
 * re-run the benchmark if it ever needs to change. Reloaded when its mtime changes.
 */
import fs from 'node:fs';
import path from 'node:path';

const PATTERNS_FILE = process.env.PARSER_PATTERNS_FILE
  ? path.resolve(process.env.PARSER_PATTERNS_FILE)
  : path.resolve(process.cwd(), 'models', 'parser-patterns.json');

let cachedPatterns = null;
let lastLoaded = 0;

function clampRate(value) {
  return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
}

function normalizeDutyCode(raw) {
  let duty = String(raw || '').trim().toUpperCase();
  if (!duty) return '';
  duty = duty.replace(/\s+/g, ' ');
  duty = duty.replace(/^0FF\b/g, 'OFF');
  duty = duty.replace(/\bOFF\s*\(\s*[0O2Z]\s*\)/g, 'OFF(Z)');
  duty = duty.replace(/\bA\/L\s*\.\s*\(\s*([A-Z0-9])\s*\)/g, 'A/L($1)');
  duty = duty.replace(/\bA\/L\s*\(\s*Z\s*\)/g, 'A/L(Z)');
  duty = duty.replace(/\bA\/L\s*\(\s*T\s*\)/g, 'A/L(T)');
  duty = duty.replace(/\bFR(?=\d{2,5}\b)/g, 'FR ');
  duty = duty.replace(/\bSBYD(?=\d{3,4}\b)/g, 'SBY0');
  return duty.trim();
}

function isLikelyDutyNoise(raw) {
  const t = normalizeDutyCode(raw);
  if (!t) return true;
  if (/\bCHECK[- ]?(IN|OUT)\b/.test(t)) return true;
  if (/\bREST OF THIS ROSTER IS PLANNED\b/.test(t)) return true;
  if (/\d{2,}\s+\d{2,}/.test(t)) return true;
  if (/\bFR\s+\d{3,}\s+FR\s+\d{3,}\b/.test(t)) return true;
  if (/^\d{1,2}\s+OFF\b/.test(t)) return true;
  if (/^OFF\s+\d{1,2}\b/.test(t)) return true;
  if (/^[A-Z]{2,}\d{4,}\s+[A-Z]{2,}\d{4,}\b/.test(t)) return true;
  if (/^\w+\s+\w+\s+\w+\s+\w+/.test(t) && !/^(OFF|SBY|RST|SIM|TRG|A\/L|F\/D|FR\s|DH\d)/.test(t)) return true;
  return false;
}

/**
 * Trả về patterns hiện tại. Auto-reload khi file thay đổi (mtime check).
 */
export function getParserPatterns() {
  try {
    if (!fs.existsSync(PATTERNS_FILE)) return cachedPatterns || null;
    const fileToUse = PATTERNS_FILE;
    const stats = fs.statSync(fileToUse);
    const mtime = stats.mtimeMs;

    if (cachedPatterns === null || mtime > lastLoaded) {
      const raw = fs.readFileSync(fileToUse, 'utf8');
      cachedPatterns = JSON.parse(raw);
      if (cachedPatterns && 'ocrSuccessRate' in cachedPatterns) {
        cachedPatterns.ocrSuccessRate = clampRate(cachedPatterns.ocrSuccessRate);
      }
      if (cachedPatterns && 'headerDetectionRate' in cachedPatterns) {
        cachedPatterns.headerDetectionRate = clampRate(cachedPatterns.headerDetectionRate);
      }
      if (cachedPatterns?.dutyPatterns?.known) {
        const filteredKnown = cachedPatterns.dutyPatterns.known.filter(d => !isLikelyDutyNoise(d));
        cachedPatterns.dutyPatterns.known = [...new Set(filteredKnown)].sort();
        if (cachedPatterns.dutyPatterns.categories) {
          for (const key of Object.keys(cachedPatterns.dutyPatterns.categories)) {
            const list = cachedPatterns.dutyPatterns.categories[key];
            if (Array.isArray(list)) {
              cachedPatterns.dutyPatterns.categories[key] = list.filter(d => !isLikelyDutyNoise(d));
            }
          }
        }
      }
      lastLoaded = mtime;

      const acc = cachedPatterns?.ocrSuccessRate;
      const hdr = cachedPatterns?.headerDetectionRate;
      const trainedOn = cachedPatterns?.trainedOn;
      console.log(
        `[ParserRules] ✅ Reloaded patterns: ${cachedPatterns?.dutyPatterns?.known?.length || 0} duty codes, `
        + `${Object.keys(cachedPatterns?.columnZones || {}).length} column zones, `
        + `ocr=${Number.isFinite(acc) ? (acc * 100).toFixed(1) + '%' : 'N/A'}, `
        + `header=${Number.isFinite(hdr) ? (hdr * 100).toFixed(1) + '%' : 'N/A'}, `
        + `trainedOn=${trainedOn || 'N/A'}`
      );
    }
    return cachedPatterns;
  } catch (err) {
    console.warn(`[ParserRules] Failed to load patterns: ${err.message}, using cached/defaults`);
    return cachedPatterns;
  }
}

export { PATTERNS_FILE };
