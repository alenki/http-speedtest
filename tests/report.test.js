import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  createStyle,
  formatBytes,
  formatDuration,
  formatMBps,
  formatMbps,
  renderJson,
  renderResult,
  renderSummary,
} from '../src/report.js';
import { summarize } from '../src/stats.js';

const plain = createStyle(false);
const success = (index, bytes, durationMs, ttfbMs) => ({
  index,
  ok: true,
  status: 200,
  bytes,
  durationMs,
  ttfbMs,
  reusedConnection: index > 1,
  redirects: 0,
});

describe('units', () => {
  it('sizes are decimal: 1 kB = 1000 B', () => {
    assert.equal(formatBytes(0), '0 B');
    assert.equal(formatBytes(999), '999 B');
    assert.equal(formatBytes(1000), '1.00 kB');
    assert.equal(formatBytes(1536), '1.54 kB');
    assert.equal(formatBytes(10_485_760), '10.49 MB');
    assert.equal(formatBytes(2_500_000_000), '2.50 GB');
  });

  it('rounding never produces "1000.00" of a smaller unit', () => {
    assert.equal(formatBytes(999_999), '1.00 MB');
  });

  it('durations switch from ms to s at one second', () => {
    assert.equal(formatDuration(0.42), '0.4 ms');
    assert.equal(formatDuration(182.4), '182 ms');
    assert.equal(formatDuration(999.6), '1.00 s');
    assert.equal(formatDuration(1912), '1.91 s');
  });

  it('speed in Mbit/s (1 Mbit = 1,000,000 bits) and MB/s (1 MB = 1,000,000 bytes)', () => {
    assert.equal(formatMbps(125_000), '1.00 Mbit/s');
    assert.equal(formatMBps(125_000), '0.13 MB/s');
    assert.equal(formatMbps(12_500_000), '100.00 Mbit/s');
    assert.equal(formatMBps(12_500_000), '12.50 MB/s');
  });
});

describe('report', () => {
  it('a row per request: size, time, TTFB, speed, connection', () => {
    assert.equal(
      renderResult(success(1, 2_000_000, 400, 40), plain),
      '  1     200     2.00 MB    400 ms     40 ms     40.00 Mbit/s  new',
    );
    assert.equal(
      renderResult({ ...success(2, 1000, 10, 5), redirects: 2 }, plain),
      '  2     200     1.00 kB     10 ms    5.0 ms      0.80 Mbit/s  reused, 2 redirects',
    );
    assert.equal(
      renderResult({ index: 3, ok: false, error: 'HTTP 503 Service Unavailable', durationMs: 5 }, plain),
      '  3  FAILED  HTTP 503 Service Unavailable',
    );
  });

  it('the summary has the totals, the average time and the speed', () => {
    const summary = summarize([success(1, 5_000_000, 1000, 50), success(2, 5_000_000, 1000, 30)]);
    assert.equal(
      renderSummary(summary, { count: 2 }, plain),
      [
        '',
        'Requests        2 of 2 succeeded',
        'Downloaded      10.00 MB (10,000,000 bytes) in 2.00 s',
        'Average time    1.00 s per request (min 1.00 s, max 1.00 s)',
        'Average TTFB    40 ms (4% of the request time)',
        '',
        'Download speed  40.00 Mbit/s (5.00 MB/s)',
      ].join('\n'),
    );
  });

  it('warns when most of the time is latency rather than download', () => {
    const summary = summarize([success(1, 50_000, 60, 50)]);
    assert.match(renderSummary(summary, { count: 1 }, plain), /reflects latency more than bandwidth/);
  });

  it('explains a run that stopped after the first request failed', () => {
    const summary = summarize([{ index: 1, ok: false, error: 'HTTP 404 Not Found', durationMs: 3 }]);
    const text = renderSummary(summary, { count: 10 }, plain);
    assert.match(text, /0 of 10 succeeded, 1 failed, 9 skipped/);
    assert.match(text, /The first request failed, so the rest were skipped/);
  });

  it('adds ANSI colors only when they are enabled', () => {
    const summary = summarize([success(1, 1000, 10, 1)]);
    assert.doesNotMatch(renderSummary(summary, { count: 1 }, plain), /\x1b\[/);
    assert.match(renderSummary(summary, { count: 1 }, createStyle(true)), /\x1b\[32m/);
  });
});

describe('renderJson', () => {
  it('is valid JSON with the speed also in Mbit/s and numbers rounded to 3 decimals', () => {
    const results = [success(1, 1_000_000, 333.33333, 12.3456789)];
    const options = { url: new URL('https://example.com/a.jpg'), count: 1, keepAlive: true, timeoutMs: 30_000 };
    const report = JSON.parse(renderJson(options, summarize(results), results));
    assert.equal(report.url, 'https://example.com/a.jpg');
    assert.deepEqual(report.options, { count: 1, keepAlive: true, timeoutMs: 30_000 });
    assert.equal(report.summary.totalBytes, 1_000_000);
    assert.equal(report.summary.megabitsPerSecond, 24); // 1 MB in 1/3 s = 3 MB/s = 24 Mbit/s
    assert.equal(report.requests[0].ttfbMs, 12.346);
  });
});
