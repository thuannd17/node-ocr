/**
 * Runs fn over items, up to n at a time, starting them in the list's order; once shouldStop() is true
 * no new one starts (the running ones finish). fn should not throw (a benchmark notes a file's error
 * in its entry). onDone(result, doneCount) after each one.
 *   -> the results in the items' order (the ones never started left out)
 */
export async function eachInPool(items, n, fn, { shouldStop, onDone } = {}) {
  const out = new Array(items.length);
  let next = 0, done = 0;
  async function lane() {
    while (next < items.length && !shouldStop?.()) {
      const i = next++;
      out[i] = await fn(items[i], i);
      onDone?.(out[i], ++done);
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(n, items.length)) }, lane));
  return out.filter(x => x !== undefined);
}

/**
 * Files a benchmark reads at once (BENCHMARK_CONCURRENCY, default 2): the OCR on the GPU and the tagging on
 * the CPU overlap. The OCR server reads one image at a time, so 3 was measured no faster than 2 (2026-10-23).
 */
export const benchmarkConcurrency = () => Math.max(1, Number(process.env.BENCHMARK_CONCURRENCY) || 2);
