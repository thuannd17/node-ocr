/**
 * Words of a PDF's text layer with positions: what the learned extractor
 * (scripts/train_pdf_tagger.py + services/pdf-row-assembler.js) works on.
 * A PDF item ("2220 !0054+1 OSL", "Blk Hrs") is split at spaces; the words get
 * x positions from the item's width (the plans use monospace-like fonts).
 *
 *   wordsOf(pages) -> [{ width, height, tokens: [{ t, x, y, w, h, item, off }] }]
 * `item` / `off` (the PDF item and the word's offset in it) are for building
 * training data; they are not written out.
 */
export function wordsOf(pages) {
  return pages.map((page) => {
    const tokens = [];
    for (const it of page.items) {
      const charW = it.text.length ? it.w / it.text.length : 0;
      for (const m of it.text.matchAll(/\S+/g)) {
        tokens.push({
          t: m[0],
          x: +(it.x + m.index * charW).toFixed(1),
          y: +it.y.toFixed(1),
          w: +(m[0].length * charW).toFixed(1),
          h: +(it.h || 0).toFixed(1),
          item: it,
          off: m.index,
        });
      }
    }
    return { width: page.width, height: page.height, tokens };
  });
}

/** Tokens as written to JSON (no PDF item references). */
export const plainTokens = (tagPages) => tagPages.map(p => ({ width: p.width, height: p.height, tokens: p.tokens.map(({ item, off, ...t }) => t) }));
