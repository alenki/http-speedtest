import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { refusedUrl, startTestServer } from './helpers.js';

const CLI = fileURLToPath(new URL('../speedtest.js', import.meta.url));
const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

/**
 * Runs the CLI as a separate process, the way a user would. Its stdout is a pipe, not a terminal.
 * With `closeStdoutEarly` the pipe is closed after the first chunk, like `| head -1` does.
 */
function run(...args) {
  const closeStdoutEarly = args[0]?.closeStdoutEarly;
  if (closeStdoutEarly) args.shift();
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args.map(String)]);
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk) => {
      stdout += chunk;
      if (closeStdoutEarly) child.stdout.destroy();
    });
    child.stderr.setEncoding('utf8').on('data', (chunk) => (stderr += chunk));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

describe('CLI', () => {
  let server;
  beforeEach(async () => {
    server = await startTestServer();
  });
  afterEach(() => server.close());

  it('makes 10 sequential requests by default and prints the report', async () => {
    const { code, stdout, stderr } = await run(server.url('/file?size=100000'));
    assert.equal(code, 0, stderr);
    assert.equal(server.stats.requests, 10);
    assert.equal(server.stats.maxInFlight, 1);
    assert.equal(stdout.match(/^ +\d+ +200 /gm).length, 10, 'a table row per request');
    assert.match(stdout, /Requests {8}10 of 10 succeeded\n/);
    assert.match(stdout, /Downloaded {6}1\.00 MB \(1,000,000 bytes\) in /);
    assert.match(stdout, /Average time {4}[\d.]+ m?s per request/);
    assert.match(stdout, /Download speed {2}\d+\.\d\d Mbit\/s \(\d+\.\d\d MB\/s\)/);
    assert.doesNotMatch(stdout, /\x1b\[/, 'no colors when the output is not a terminal');
  });

  it('--json prints a machine-readable report where speed = total bytes / total time', async () => {
    const { code, stdout } = await run(server.url('/file?size=250000'), '--json', '-n', 4);
    assert.equal(code, 0);
    const { summary, requests } = JSON.parse(stdout);
    assert.equal(requests.length, 4);
    assert.equal(summary.succeeded, 4);
    assert.equal(summary.totalBytes, 1_000_000);
    const expected = summary.totalBytes / (summary.totalDurationMs / 1000);
    assert.ok(Math.abs(summary.bytesPerSecond - expected) / expected < 1e-3);
    assert.ok(Math.abs(summary.megabitsPerSecond - (summary.bytesPerSecond * 8) / 1e6) < 0.01);
  });

  it('--count and --no-keep-alive', async () => {
    const { code, stdout } = await run(server.url('/file'), '--count', 3, '--no-keep-alive');
    assert.equal(code, 0);
    assert.match(stdout, /3 sequential requests, keep-alive off/);
    assert.equal(server.stats.requests, 3);
    assert.equal(server.stats.connections, 3);
  });

  it('exits with 1 when a request fails, but still reports the others', async () => {
    const { code, stdout } = await run(server.url('/flaky?fail=2&size=1000'), '-n', 3);
    assert.equal(code, 1);
    assert.match(stdout, / 2 {2}FAILED {2}HTTP 503 Service Unavailable\n/);
    assert.match(stdout, /2 of 3 succeeded, 1 failed\n/);
    assert.match(stdout, /Download speed/);
  });

  it('exits with 1 and a clear message, not a stack trace, when the host refuses connections', async () => {
    const { code, stdout, stderr } = await run(await refusedUrl());
    assert.equal(code, 1);
    assert.match(stdout, /ECONNREFUSED/);
    assert.match(stdout, /0 of 10 succeeded, 1 failed, 9 skipped/);
    assert.doesNotMatch(stdout + stderr, /\n\s+at /);
  });

  it('gives up on a request after --timeout seconds without data', async () => {
    const { code, stdout } = await run(server.url('/hang'), '--timeout', 0.2);
    assert.equal(code, 1);
    assert.match(stdout, /Timeout: no data received for 0\.2 s/);
  });

  const usageErrors = [
    ['no URL', [], /Missing URL/],
    ['a URL without a scheme', ['example.com/image.jpg'], /is not an absolute URL/],
    ['an unsupported protocol', ['ftp://example.com/file'], /Unsupported protocol "ftp:"/],
    ['a malformed URL', ['http://exa mple.com/'], /Invalid URL/],
    ['two URLs', ['http://a.test/', 'http://b.test/'], /Expected a single URL/],
    ['a zero count', ['http://a.test/', '-n', '0'], /--count must be a positive integer/],
    ['a fractional count', ['http://a.test/', '-n', '2.5'], /--count must be a positive integer/],
    ['a negative timeout', ['http://a.test/', '--timeout=-1'], /--timeout must be a positive number/],
    ['an unknown option', ['http://a.test/', '--fast'], /Unknown option '--fast'/],
  ];
  for (const [what, args, message] of usageErrors) {
    it(`exits with 2 on ${what}`, async () => {
      const { code, stdout, stderr } = await run(...args);
      assert.equal(code, 2);
      assert.match(stderr, message);
      assert.equal(stdout, '');
    });
  }

  it('exits quietly when the reader of its output goes away (| head)', {
    skip: process.platform === 'win32' && 'closing a pipe early is a Unix scenario',
  }, async () => {
    // Each request takes 50+ ms, so the table rows are written after the pipe is closed.
    const { code, stderr } = await run({ closeStdoutEarly: true }, server.url('/stream?chunks=2&gap=50'), '-n', 3);
    assert.equal(code, 0);
    assert.equal(stderr, '');
  });

  it('--help and --version', async () => {
    const help = await run('--help');
    assert.equal(help.code, 0);
    assert.match(help.stdout, /^Usage: node speedtest\.js <url> \[options\]/);
    const versionRun = await run('-v');
    assert.equal(versionRun.code, 0);
    assert.equal(versionRun.stdout, `${version}\n`);
  });
});
