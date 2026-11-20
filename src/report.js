/**
 * Presentation: unit formatting and the human-readable report. Pure functions,
 * they return strings and leave printing to the caller.
 *
 * All prefixes are decimal (SI), as is customary for network speeds:
 * 1 kB = 1000 B, 1 MB = 1000^2 B, 1 Mbit = 1000^2 bits.
 */
import { bytesPerSecond } from './stats.js';

const BYTE_UNITS = ['B', 'kB', 'MB', 'GB', 'TB'];

/** Above this share of time-to-first-byte the result is about latency, not bandwidth. */
const LATENCY_DOMINATES = 0.5;

/** 10485760 -> "10.49 MB" */
export function formatBytes(bytes) {
  let value = bytes;
  let unit = 0;
  // Compare the rounded value, so that 999 999 B is "1.00 MB" and not "1000.00 kB".
  while (unit < BYTE_UNITS.length - 1 && Number(value.toFixed(2)) >= 1000) {
    value /= 1000;
    unit++;
  }
  return unit === 0 ? `${value} B` : `${value.toFixed(2)} ${BYTE_UNITS[unit]}`;
}

/** 0.42 -> "0.4 ms", 182.4 -> "182 ms", 1912 -> "1.91 s" */
export function formatDuration(ms) {
  if (Math.round(ms) >= 1000) return `${(ms / 1000).toFixed(2)} s`;
  return ms < 10 ? `${ms.toFixed(1)} ms` : `${Math.round(ms)} ms`;
}

/** The main unit: megabits per second, the one ISPs and Speedtest use. */
export function formatMbps(bytesPerSec) {
  return `${((bytesPerSec * 8) / 1e6).toFixed(2)} Mbit/s`;
}

/** The secondary unit: megabytes per second, handy to estimate how long a file takes. */
export function formatMBps(bytesPerSec) {
  return `${(bytesPerSec / 1e6).toFixed(2)} MB/s`;
}

/** ANSI text styles. With `enabled` false they return the text unchanged. */
export function createStyle(enabled) {
  const sgr = (on, off) => (text) => (enabled ? `\x1b[${on}m${text}\x1b[${off}m` : String(text));
  return { bold: sgr(1, 22), dim: sgr(2, 22), red: sgr(31, 39), green: sgr(32, 39), yellow: sgr(33, 39) };
}

/** A table row: each cell is [text, width to right-align to, style]. */
function tableRow(cells) {
  return cells.map(([text, width = 0, paint = String]) => paint(String(text).padStart(width))).join('  ');
}

export function renderHeader({ url, count, keepAlive, timeoutMs }, style) {
  const requests = count === 1 ? '1 request' : `${count} sequential requests`;
  return [
    `${style.bold('Speed test:')} ${url.href}`,
    style.dim(`${requests}, keep-alive ${keepAlive ? 'on' : 'off'}, timeout ${timeoutMs / 1000} s`),
    '',
    style.dim(
      tableRow([['#', 3], ['status', 6], ['size', 10], ['time', 8], ['ttfb', 8], ['speed', 15], ['connection']]),
    ),
  ].join('\n');
}

/** One line of the table for a finished request. */
export function renderResult(result, style) {
  if (!result.ok) {
    return tableRow([[result.index, 3], ['FAILED', 6, style.red], [result.error]]);
  }
  const { redirects } = result;
  const connection =
    (result.reusedConnection ? 'reused' : 'new') +
    (redirects ? `, ${redirects} redirect${redirects === 1 ? '' : 's'}` : '');
  return tableRow([
    [result.index, 3],
    [result.status, 6, style.green],
    [formatBytes(result.bytes), 10],
    [formatDuration(result.durationMs), 8],
    [formatDuration(result.ttfbMs), 8],
    [formatMbps(bytesPerSecond(result.bytes, result.durationMs)), 15],
    [connection, 0, style.dim],
  ]);
}

/** The line shown while a request is still in progress. */
export function renderProgress(index, bytes, totalBytes, style) {
  let status = 'waiting for the response...';
  if (bytes > 0) {
    status = totalBytes
      ? `downloading ${formatBytes(bytes)} of ${formatBytes(totalBytes)} (${Math.floor((bytes / totalBytes) * 100)}%)`
      : `downloading ${formatBytes(bytes)}`;
  }
  return style.dim(tableRow([[index, 3], ['...', 6], [status]]));
}

export function renderSummary(summary, { count }, style) {
  const s = summary;
  const skipped = count - s.attempted;
  const line = (label, value) => `${label.padEnd(16)}${value}`;
  const lines = [
    '',
    line(
      'Requests',
      `${s.succeeded} of ${count} succeeded` +
        (s.failed ? style.red(`, ${s.failed} failed`) : '') +
        (skipped ? `, ${skipped} skipped` : ''),
    ),
  ];

  if (s.succeeded === 0) {
    lines.push('', style.red('No successful requests, nothing to measure.'));
    if (skipped) lines.push('The first request failed, so the rest were skipped. Check the URL.');
    return lines.join('\n');
  }

  lines.push(
    line(
      'Downloaded',
      `${formatBytes(s.totalBytes)} (${s.totalBytes.toLocaleString('en-US')} bytes) in ${formatDuration(s.totalDurationMs)}`,
    ),
    line(
      'Average time',
      `${formatDuration(s.avgDurationMs)} per request ` +
        `(min ${formatDuration(s.minDurationMs)}, max ${formatDuration(s.maxDurationMs)})`,
    ),
    line('Average TTFB', `${formatDuration(s.avgTtfbMs)} (${Math.round(s.ttfbShare * 100)}% of the request time)`),
    '',
    line('Download speed', `${style.bold(style.green(formatMbps(s.bytesPerSecond)))} (${formatMBps(s.bytesPerSecond)})`),
  );

  if (s.ttfbShare > LATENCY_DOMINATES) {
    lines.push(
      '',
      style.yellow(
        'Note: most of the time went into waiting for the response rather than downloading,\n' +
          'so the speed reflects latency more than bandwidth. Try a bigger file (10 MB or more).',
      ),
    );
  }
  return lines.join('\n');
}

/** Machine-readable report for --json. Times are in ms, sizes in bytes. */
export function renderJson({ url, count, keepAlive, timeoutMs }, summary, results) {
  const { bytesPerSecond: speed } = summary;
  const report = {
    url: url.href,
    options: { count, keepAlive, timeoutMs },
    summary: { ...summary, megabitsPerSecond: speed === null ? null : (speed * 8) / 1e6 },
    requests: results,
  };
  // Digits beyond the third decimal (i.e. below a microsecond) are just noise.
  const round = (key, value) =>
    typeof value === 'number' && !Number.isInteger(value) ? Math.round(value * 1000) / 1000 : value;
  return JSON.stringify(report, round, 2);
}
