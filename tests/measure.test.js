import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import { describeError, measureRequest, runSpeedTest } from '../src/measure.js';
import { refusedUrl, startTestServer } from './helpers.js';

describe('measureRequest', () => {
  let server;
  before(async () => {
    server = await startTestServer();
  });
  after(() => server.close());

  const measure = (path, options) => measureRequest(server.url(path), options);

  it('reads the whole body and counts every byte', async () => {
    const result = await measure('/file?size=1000000');
    assert.equal(result.status, 200);
    assert.equal(result.bytes, 1_000_000);
    assert.equal(result.redirects, 0);
  });

  it('counts a body that comes without Content-Length (chunked encoding)', async () => {
    const result = await measure('/stream?size=300001&chunks=3');
    assert.equal(result.bytes, 300_001);
  });

  it('counts the bytes that came over the network and does not decompress them', async () => {
    const result = await measure('/gzip?size=1000000');
    assert.equal(result.bytes, gzipSync(Buffer.alloc(1_000_000)).length);
  });

  it('measures the time to first byte and the full time of a slow response', async () => {
    // Headers after 100 ms, then 5 chunks 60 ms apart: at least 100 + 4 * 60 = 340 ms in total.
    // A few ms of slack below the bounds: timers are allowed to fire slightly early.
    const result = await measure('/stream?size=50000&chunks=5&gap=60&ttfb=100');
    assert.ok(result.ttfbMs >= 90, `ttfb was ${result.ttfbMs} ms`);
    assert.ok(result.durationMs >= 330, `duration was ${result.durationMs} ms`);
    assert.ok(result.durationMs - result.ttfbMs >= 230, 'the body took 4 gaps of 60 ms');
    assert.ok(result.durationMs < 5000, 'sanity upper bound');
  });

  it('follows redirects, relative ones included, and counts only the final body', async () => {
    const result = await measure('/redirect?hops=3&size=5000');
    assert.equal(result.status, 200);
    assert.equal(result.redirects, 3);
    assert.equal(result.bytes, 5000);
  });

  it('gives up after 10 redirects', async () => {
    await assert.rejects(measure('/redirect-loop'), { message: 'Too many redirects (more than 10)' });
  });

  it('fails on a non-2xx response', async () => {
    await assert.rejects(measure('/status?code=404'), { message: 'HTTP 404 Not Found' });
    await assert.rejects(measure('/status?code=500'), { message: 'HTTP 500 Internal Server Error' });
  });

  it('times out when the server does not respond', async () => {
    await assert.rejects(measure('/hang', { timeoutMs: 150 }), {
      code: 'ETIMEDOUT',
      message: 'Timeout: no data received for 0.15 s',
    });
  });

  it('times out when the body stops arriving halfway', async () => {
    await assert.rejects(measure('/stall', { timeoutMs: 150 }), { code: 'ETIMEDOUT' });
  });

  it('fails when the connection drops before the body is complete', async () => {
    await assert.rejects(measure('/truncated'), { code: 'ECONNRESET' });
  });

  it('reports progress as the body arrives', async () => {
    const progress = [];
    await measure('/file?size=200000', { onProgress: (bytes, total) => progress.push([bytes, total]) });
    assert.ok(progress.length > 0);
    assert.deepEqual(progress.at(-1), [200_000, 200_000]);
    assert.ok(progress.every(([bytes], i) => i === 0 || bytes > progress[i - 1][0]), 'grows monotonically');
  });

  it('rejects protocols other than http and https', async () => {
    await assert.rejects(measureRequest(new URL('ftp://example.com/file')), {
      message: 'Unsupported protocol: ftp:',
    });
  });
});

describe('runSpeedTest', () => {
  let server;
  beforeEach(async () => {
    server = await startTestServer();
  });
  afterEach(() => server.close());

  it('makes exactly `count` requests, strictly one after another', async () => {
    // Every response takes ~10 ms to stream, so overlapping requests would be caught.
    const results = await runSpeedTest(server.url('/stream?size=30000&chunks=3&gap=5'), { count: 7 });
    assert.deepEqual(
      results.map((r) => r.index),
      [1, 2, 3, 4, 5, 6, 7],
    );
    assert.ok(results.every((r) => r.ok && r.bytes === 30_000));
    assert.equal(server.stats.requests, 7);
    assert.equal(server.stats.maxInFlight, 1);
  });

  it('makes 10 requests by default', async () => {
    const results = await runSpeedTest(server.url('/file?size=100'));
    assert.equal(results.length, 10);
    assert.equal(server.stats.requests, 10);
  });

  it('reuses a single connection with keep-alive', async () => {
    const results = await runSpeedTest(server.url('/file?size=1000'), { count: 5 });
    assert.equal(server.stats.connections, 1);
    assert.deepEqual(
      results.map((r) => r.reusedConnection),
      [false, true, true, true, true],
    );
  });

  it('opens a new connection for every request without keep-alive', async () => {
    const results = await runSpeedTest(server.url('/file?size=1000'), { count: 5, keepAlive: false });
    assert.equal(server.stats.connections, 5);
    assert.ok(results.every((r) => r.reusedConnection === false));
  });

  it('asks for an uncompressed body and sends a User-Agent', async () => {
    await runSpeedTest(server.url('/file'), { count: 1, userAgent: 'test-agent/1.0' });
    assert.equal(server.stats.headers[0]['accept-encoding'], 'identity');
    assert.equal(server.stats.headers[0]['user-agent'], 'test-agent/1.0');
  });

  it('records a failed request and keeps going', async () => {
    const results = await runSpeedTest(server.url('/flaky?fail=3&size=1000'), { count: 5 });
    assert.deepEqual(
      results.map((r) => r.ok),
      [true, true, false, true, true],
    );
    assert.equal(results[2].error, 'HTTP 503 Service Unavailable');
  });

  it('stops right away if the very first request fails', async () => {
    const results = await runSpeedTest(server.url('/status?code=404'), { count: 5 });
    assert.equal(results.length, 1);
    assert.equal(server.stats.requests, 1);
    assert.equal(results[0].error, 'HTTP 404 Not Found');
  });

  it('turns network errors into readable messages', async () => {
    const [refused] = await runSpeedTest(await refusedUrl(), { count: 1 });
    assert.match(refused.error, /ECONNREFUSED/);
    const [truncated] = await runSpeedTest(server.url('/truncated'), { count: 1 });
    // Depending on the OS, a dropped connection surfaces as "aborted" (mapped to the
    // friendly message, see describeError) or as a plain socket reset.
    assert.match(truncated.error, /Connection closed before the whole body was received|ECONNRESET/);
  });

  it('calls the hooks in order', async () => {
    const events = [];
    await runSpeedTest(server.url('/stream?size=3000&chunks=3&gap=5'), {
      count: 2,
      onRequestStart: (index) => events.push(['start', index]),
      onProgress: (index, bytes) => events.push(['progress', index, bytes]),
      onResult: (result) => events.push(['result', result.index]),
    });
    // How the body is split into chunks is up to TCP, so check only the order of
    // events and that the progress of each request ends with the whole body.
    const milestones = events.filter(([type]) => type !== 'progress');
    assert.deepEqual(milestones, [
      ['start', 1],
      ['result', 1],
      ['start', 2],
      ['result', 2],
    ]);
    for (const index of [1, 2]) {
      const start = events.findIndex(([type, i]) => type === 'start' && i === index);
      const end = events.findIndex(([type, i]) => type === 'result' && i === index);
      const progress = events.slice(start + 1, end);
      assert.ok(progress.length > 0 && progress.every(([type, i]) => type === 'progress' && i === index));
      assert.equal(progress.at(-1)[2], 3000);
    }
  });
});

describe('describeError', () => {
  it('explains a body cut off halfway', () => {
    const error = Object.assign(new Error('aborted'), { code: 'ECONNRESET' });
    assert.equal(describeError(error), 'Connection closed before the whole body was received');
  });

  it('unpacks an AggregateError with an empty message (all addresses of a host failed)', () => {
    const error = new AggregateError(
      [new Error('connect ECONNREFUSED ::1:80'), new Error('connect ECONNREFUSED 127.0.0.1:80')],
      '',
    );
    assert.equal(describeError(error), 'connect ECONNREFUSED ::1:80; connect ECONNREFUSED 127.0.0.1:80');
  });

  it('uses the message of any other error', () => {
    assert.equal(describeError(new Error('getaddrinfo ENOTFOUND example.invalid')), 'getaddrinfo ENOTFOUND example.invalid');
  });
});
