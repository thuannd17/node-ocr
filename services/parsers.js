import { extractWithVLM } from './vlm.js';
import { extractWithPaddleOCR } from './paddle-ocr.js';

/**
 * Chạy extraction theo strategy đã chọn. Trả về { published: [], planned:[] }.
 * PaddleOCR là strategy mặc định.
 */
export async function extractRaw(filePath, opts = {}) {
  const strategy = opts?.strategy || process.env.STRATEGY || 'paddleocr';

  switch (strategy) {
    case 'paddleocr':
      return extractWithPaddleOCR(filePath, opts);

    case 'vlm':
    default:
      return extractWithVLM(filePath, opts);
  }
}

