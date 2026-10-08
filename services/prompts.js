// /services/prompts.js
/*
 * Prompt templates + few-shot loader cho VLM roster extractor.
 *
 * Đây là "model" của training loop: chỉnh sửa SYSTEM_PROMPT, SCHEMA_INSTRUCTION
 * và FEW_SHOT_PICKS để cải thiện accuracy qua từng cycle benchmark.
 */

// Vai của model
export const SYSTEM_PROMPT = `You are a precise OCR extractor specialized in crew flight rosters.

You receive ONE roster image and must output a single JSON object that captures
all the rows in the two sections of the image:
  - "published": rows under the "Published Roster" / "Published" block
  - "planned":   rows under the "Planned Roster"  / "Planned"   block (if any)

Rules:
1. Output ONLY valid JSON. No markdown fences, no commentary, no trailing text.
2. Always include both keys "published" and "planned" even if one is empty.
3. Each row is an object with EXACTLY these string fields:
     date, day, duty, dep, begin, end, arr
   Use "" for any field that is not visible.
4. Do not invent data. If a row is a header / noise / footer, skip it.
5. Normalize common OCR mistakes:
     - "OFF(Z)" may appear as "0FF(Z)" -> write "OFF(Z)"
     - "CI9" may appear as "CIg"        -> write "CI9"
     - Times must look like "HH:MM Z" (zero-padded hour). "23:59 Z" not "23:59 2".
     - IATA airport codes are 3 uppercase Latin letters (e.g. "HAN", "SGN").
     - Weekday short names ("MON","TUE",...) go in "day", not "duty".
6. Keep original order top-to-bottom as in the image.`;

// Mô tả schema (kèm ví dụ JSON shape)
export const SCHEMA_INSTRUCTION = `Schema example (shape only, fill with real data from the image):

{
  "published": [
    { "date": "12 Jun 20", "day": "FRI", "duty": "OFF(Z)", "dep": "HAN", "begin": "00:00 Z", "end": "23:59 Z", "arr": "HAN" }
  ],
  "planned": [
    { "date": "13 Jun 20", "day": "SAT", "duty": "CI9",    "dep": "HAN", "begin": "08:00 Z", "end": "10:30 Z", "arr": "SGN" }
  ]
}

Notes:
- date format: "D MMM YY" (e.g. "5 Jul 20").
- begin/end format: "HH:MM Z" (UTC, zero-padded).
- dep/arr format: 3-letter IATA code, uppercase.`;

/**
 * Danh sách ảnh mẫu dùng làm few-shot examples.
 * Mỗi phần tử là tên file trong fake-data/ (đã có label ở labels/).
 * Để rỗng ở zero-shot; thêm 3-5 ảnh sau khi label ở M2.
 *
 * VD: export const FEW_SHOT_PICKS = ['1 (1).jpg', '1 (10).jpg', '1 (20).jpg'];
 */
export const FEW_SHOT_PICKS = [];

/**
 * Ghép prompt text部分 (không ảnh) gửi tới Gemini.
 * Ảnh few-shot sẽ được vlm.js đính kèm như inlineData ngay trước text example.
 *
 * @param {{ fewShotCount?: number }} _opts
 * @returns {string}
 */
export function buildTextPrompt(_opts = {}) {
  const parts = [
    SYSTEM_PROMPT,
    '',
    SCHEMA_INSTRUCTION,
    '',
    'Now extract the roster from the attached image. Output ONLY the JSON object.',
  ];
  return parts.join('\n');
}

/**
 * Tạo instruction cho một few-shot example kèm ground-truth JSON.
 * Được đặt NGAY sau ảnh example (vlm.js sẽ ráp image -> text theo thứ tự).
 *
 * @param {{ fileName: string, groundTruth: object }} ex
 * @returns {string}
 */
export function buildFewShotText(ex) {
  const json = JSON.stringify(ex.groundTruth, null, 2);
  return `Example label for "${ex.fileName}" (use this exact format):\n${json}`;
}
