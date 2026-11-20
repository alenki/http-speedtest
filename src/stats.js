/**
 * Aggregating per-request results into the final numbers. Pure functions, no I/O.
 */

/** Average speed, in bytes per second, of `bytes` received in `ms` milliseconds. */
export function bytesPerSecond(bytes, ms) {
  return ms > 0 ? (bytes * 1000) / ms : 0;
}

/**
 * Summarizes a run. Only successful requests count towards sizes, times and speed.
 *
 * Speed = total bytes / total time, which is exactly "total downloaded divided by
 * (average time x number of requests)". It is NOT the mean of per-request speeds:
 * averaging ratios gives fast requests too much weight. 1 MB in 1 s plus 1 MB in 3 s
 * is 2 MB in 4 s = 4 Mbit/s, whereas the mean of 8 and 2.67 Mbit/s is 5.33 Mbit/s.
 *
 * @param {import('./measure.js').RequestResult[]} results
 */
export function summarize(results) {
  const ok = results.filter((r) => r.ok);
  const n = ok.length;
  const durations = ok.map((r) => r.durationMs);
  const totalBytes = sum(ok.map((r) => r.bytes));
  const totalDurationMs = sum(durations);
  const totalTtfbMs = sum(ok.map((r) => r.ttfbMs));
  const none = n === 0;

  return {
    attempted: results.length,
    succeeded: n,
    failed: results.length - n,
    totalBytes,
    totalDurationMs,
    avgDurationMs: none ? null : totalDurationMs / n,
    // reduce() rather than Math.min(...durations): spreading a huge array overflows the stack.
    minDurationMs: none ? null : durations.reduce((a, b) => Math.min(a, b)),
    maxDurationMs: none ? null : durations.reduce((a, b) => Math.max(a, b)),
    avgTtfbMs: none ? null : totalTtfbMs / n,
    // Share of the time spent before the first byte of the response arrived:
    // connection setup plus server latency. When it is large, the result says
    // more about latency than about bandwidth.
    ttfbShare: totalDurationMs > 0 ? totalTtfbMs / totalDurationMs : null,
    bytesPerSecond: none ? null : bytesPerSecond(totalBytes, totalDurationMs),
  };
}

function sum(numbers) {
  return numbers.reduce((total, x) => total + x, 0);
}
