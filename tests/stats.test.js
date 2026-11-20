import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { bytesPerSecond, summarize } from '../src/stats.js';

const success = (index, bytes, durationMs, ttfbMs = 0) => ({
  index,
  ok: true,
  status: 200,
  bytes,
  durationMs,
  ttfbMs,
  reusedConnection: index > 1,
  redirects: 0,
});
const failure = (index) => ({ index, ok: false, error: 'HTTP 503 Service Unavailable', durationMs: 5 });

describe('summarize', () => {
  it('speed is total bytes over total time, not the mean of per-request speeds', () => {
    // 1 MB in 1 s and 1 MB in 3 s: 2 MB in 4 s = 0.5 MB/s = 4 Mbit/s.
    // The mean of the per-request speeds (8 and 2.67 Mbit/s) would be 5.33 Mbit/s.
    const summary = summarize([success(1, 1_000_000, 1000), success(2, 1_000_000, 3000)]);
    assert.equal(summary.bytesPerSecond, 500_000);
  });

  it('computes totals, averages and extremes', () => {
    const summary = summarize([success(1, 100, 30, 10), success(2, 300, 10, 5), success(3, 200, 20, 5)]);
    assert.deepEqual(summary, {
      attempted: 3,
      succeeded: 3,
      failed: 0,
      totalBytes: 600,
      totalDurationMs: 60,
      avgDurationMs: 20,
      minDurationMs: 10,
      maxDurationMs: 30,
      avgTtfbMs: 20 / 3,
      ttfbShare: 20 / 60,
      bytesPerSecond: 10_000,
    });
  });

  it('counts failed requests but leaves them out of the numbers', () => {
    const summary = summarize([success(1, 1000, 100), failure(2), success(3, 1000, 100)]);
    assert.equal(summary.attempted, 3);
    assert.equal(summary.succeeded, 2);
    assert.equal(summary.failed, 1);
    assert.equal(summary.totalBytes, 2000);
    assert.equal(summary.totalDurationMs, 200);
    assert.equal(summary.bytesPerSecond, 10_000);
  });

  it('has no numbers to report when nothing succeeded', () => {
    const summary = summarize([failure(1)]);
    assert.equal(summary.succeeded, 0);
    assert.equal(summary.failed, 1);
    assert.equal(summary.totalBytes, 0);
    assert.equal(summary.avgDurationMs, null);
    assert.equal(summary.ttfbShare, null);
    assert.equal(summary.bytesPerSecond, null);
  });
});

describe('bytesPerSecond', () => {
  it('turns bytes per millisecond into bytes per second', () => {
    assert.equal(bytesPerSecond(5000, 250), 20_000);
  });

  it('is 0 when no time has passed instead of Infinity', () => {
    assert.equal(bytesPerSecond(100, 0), 0);
  });
});
