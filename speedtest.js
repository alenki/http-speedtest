#!/usr/bin/env node
/**
 * http-speedtest: measures download speed by fetching a URL several times in a row.
 *
 *   node speedtest.js <url> [--count 10] [--timeout 30] [--no-keep-alive] [--json]
 *
 * This file is the shell around the measurement: it parses the arguments, prints
 * progress and the report, and sets the exit code. The work itself is in src/.
 */
import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { parseArgs } from 'node:util';
import { runSpeedTest } from './src/measure.js';
import { summarize } from './src/stats.js';
import { createStyle, renderHeader, renderJson, renderProgress, renderResult, renderSummary } from './src/report.js';

const { version } = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));

const EXIT_OK = 0; // every request succeeded
const EXIT_REQUEST_FAILED = 1; // at least one request failed
const EXIT_USAGE = 2; // invalid command line

// Node timers cannot wait longer than ~24.8 days and silently turn bigger values into 1 ms.
const MAX_TIMEOUT_SEC = 24 * 60 * 60;

const HELP = `Usage: node speedtest.js <url> [options]

Downloads <url> several times, strictly one request after another, waiting for
each response to arrive in full. Prints the average request time, the total
amount of data downloaded and the download speed.

Options:
  -n, --count <n>       number of requests (default: 10)
  -t, --timeout <sec>   abort a request after <sec> seconds without data (default: 30)
      --no-keep-alive   open a new connection for every request
      --json            print the results as JSON
  -h, --help            show this help
  -v, --version         show the version

Units: speed in Mbit/s (1 Mbit = 1,000,000 bits), also in MB/s (1 MB = 1,000,000 bytes).
Exit codes: 0 - all requests succeeded, 1 - some failed, 2 - invalid arguments.

Example:
  node speedtest.js https://speedtest.selectel.ru/10MB
`;

// If whoever reads our output goes away (say, "... | head -3"), stop quietly instead
// of crashing with an EPIPE stack trace: there is nobody left to report to.
process.stdout.on('error', (error) => {
  if (error.code !== 'EPIPE') throw error;
  process.exit();
});

process.exitCode = await main(process.argv.slice(2));

async function main(argv) {
  let options;
  try {
    options = parseOptions(argv);
  } catch (error) {
    process.stderr.write(`Error: ${error.message}\nRun "node speedtest.js --help" for usage.\n`);
    return EXIT_USAGE;
  }
  if (options.help) {
    process.stdout.write(HELP);
    return EXIT_OK;
  }
  if (options.version) {
    process.stdout.write(`${version}\n`);
    return EXIT_OK;
  }

  // Colors and the live progress line only for a person looking at a terminal;
  // when the output is piped or redirected to a file, it stays plain text.
  const interactive = Boolean(process.stdout.isTTY) && !options.json;
  const style = createStyle(interactive && !process.env.NO_COLOR);
  const progress = interactive ? createProgressLine(style) : undefined;
  const print = (text) => process.stdout.write(`${text}\n`);

  if (!options.json) print(renderHeader(options, style));

  const results = await runSpeedTest(options.url, {
    count: options.count,
    keepAlive: options.keepAlive,
    timeoutMs: options.timeoutMs,
    userAgent: `http-speedtest/${version}`,
    onRequestStart: progress?.start,
    onProgress: progress?.update,
    onResult: options.json
      ? undefined
      : (result) => {
          progress?.clear();
          print(renderResult(result, style));
        },
  });

  const summary = summarize(results);
  print(options.json ? renderJson(options, summary, results) : renderSummary(summary, options, style));
  return summary.failed === 0 ? EXIT_OK : EXIT_REQUEST_FAILED;
}

function parseOptions(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      count: { type: 'string', short: 'n', default: '10' },
      timeout: { type: 'string', short: 't', default: '30' },
      'no-keep-alive': { type: 'boolean', default: false },
      json: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
      version: { type: 'boolean', short: 'v', default: false },
    },
  });
  // --help and --version need no URL, so they skip the validation below.
  if (values.help || values.version) return { help: values.help, version: values.version };

  if (positionals.length === 0) throw new Error('Missing URL');
  if (positionals.length > 1) throw new Error(`Expected a single URL, got ${positionals.length}`);

  const count = Number(values.count);
  if (!Number.isInteger(count) || count < 1) {
    throw new Error(`--count must be a positive integer, got "${values.count}"`);
  }
  const timeoutSec = Number(values.timeout);
  if (!(timeoutSec > 0 && timeoutSec <= MAX_TIMEOUT_SEC)) {
    throw new Error(`--timeout must be a positive number of seconds, at most ${MAX_TIMEOUT_SEC}, got "${values.timeout}"`);
  }

  return {
    url: parseUrl(positionals[0]),
    count,
    timeoutMs: timeoutSec * 1000,
    keepAlive: !values['no-keep-alive'],
    json: values.json,
  };
}

function parseUrl(input) {
  // Checked before new URL(), which would happily read "localhost:8080/file"
  // as a URL with the scheme "localhost:".
  if (!/^[a-z][a-z\d+.-]*:\/\//i.test(input)) {
    throw new Error(`"${input}" is not an absolute URL, expected something like https://example.com/image.jpg`);
  }
  let url;
  try {
    url = new URL(input);
  } catch {
    throw new Error(`Invalid URL: "${input}"`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`Unsupported protocol "${url.protocol}", only http:// and https:// URLs are supported`);
  }
  return url;
}

/**
 * A status line redrawn in place ("\r" + "erase line"), so that a long download
 * shows signs of life. Redrawn at most 10 times a second: often enough for the
 * eye, rarely enough to cost nothing.
 */
function createProgressLine(style) {
  const CLEAR_LINE = '\r\x1b[2K';
  let drawnAt = 0;
  const draw = (index, bytes, totalBytes) => {
    drawnAt = performance.now();
    process.stdout.write(CLEAR_LINE + renderProgress(index, bytes, totalBytes, style));
  };
  return {
    start: (index) => draw(index, 0),
    update: (index, bytes, totalBytes) => {
      if (performance.now() - drawnAt >= 100) draw(index, bytes, totalBytes);
    },
    clear: () => process.stdout.write(CLEAR_LINE),
  };
}
