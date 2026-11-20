/**
 * Downloading a URL and timing it.
 *
 * node:http / node:https are used instead of fetch() on purpose:
 *  - the body is counted exactly as it comes off the socket. fetch() transparently
 *    decompresses gzip/brotli, so it would count unpacked bytes instead of traffic;
 *  - the socket inactivity timeout and connection reuse are visible and controllable.
 * The price is that redirects have to be followed by hand (see measureRequest).
 */
import http from 'node:http';
import https from 'node:https';
import { performance } from 'node:perf_hooks';
import { finished } from 'node:stream/promises';

const MAX_REDIRECTS = 10;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const DEFAULT_AGENTS = { 'http:': http.globalAgent, 'https:': https.globalAgent };

/**
 * @typedef {object} Measurement
 * @property {number} status            final HTTP status code
 * @property {number} bytes             body bytes received
 * @property {number} ttfbMs            time to first byte: until the final response headers arrived
 * @property {number} durationMs        full request time: until the last byte of the body arrived
 * @property {boolean} reusedConnection true if an already open keep-alive connection was used
 * @property {number} redirects         number of redirects followed
 *
 * @typedef {{ index: number, ok: true } & Measurement} Success
 * @typedef {{ index: number, ok: false, error: string, durationMs: number }} Failure
 * @typedef {Success | Failure} RequestResult
 */

/**
 * Downloads `url` once, reading the body to the very end, and measures it.
 * Rejects on network errors, timeouts, too many redirects and non-2xx responses.
 *
 * @param {URL} url
 * @param {object} [options]
 * @param {Record<string, http.Agent>} [options.agents] an agent per protocol, 'http:' and 'https:'
 * @param {Record<string, string>} [options.headers]
 * @param {number} [options.timeoutMs] abort when the socket has been idle for this long
 * @param {(bytes: number, totalBytes?: number) => void} [options.onProgress]
 * @returns {Promise<Measurement>}
 */
export async function measureRequest(url, { agents = DEFAULT_AGENTS, headers, timeoutMs, onProgress } = {}) {
  // performance.now() is monotonic: unlike Date.now(), it does not jump when the
  // system clock is adjusted, and it has sub-millisecond precision.
  const startedAt = performance.now();
  let target = url;
  let redirects = 0;

  while (true) {
    const agent = agents[target.protocol];
    if (!agent) throw new Error(`Unsupported protocol: ${target.protocol}`);

    const { res, reusedSocket } = await sendGet(target, { agent, headers, timeoutMs });
    const status = res.statusCode;

    if (REDIRECT_STATUSES.has(status) && res.headers.location) {
      await discardBody(res); // read it out, so that the connection can be reused
      if (++redirects > MAX_REDIRECTS) throw new Error(`Too many redirects (more than ${MAX_REDIRECTS})`);
      target = new URL(res.headers.location, target); // Location may be relative
      continue;
    }

    const ttfbMs = performance.now() - startedAt;
    if (status < 200 || status > 299) {
      await discardBody(res);
      throw new Error(`HTTP ${status} ${res.statusMessage ?? ''}`.trim());
    }

    // The body is counted chunk by chunk and thrown away, never buffered:
    // memory use stays flat however big the file is.
    const totalBytes = Number(res.headers['content-length']) || undefined;
    let bytes = 0;
    for await (const chunk of res) {
      bytes += chunk.length;
      onProgress?.(bytes, totalBytes);
    }
    const durationMs = performance.now() - startedAt;

    return { status, bytes, ttfbMs, durationMs, reusedConnection: reusedSocket, redirects };
  }
}

/**
 * Downloads `url` `count` times, strictly one after another: the next request
 * starts only once the previous response body has been received in full.
 *
 * A failed request is recorded and the run goes on: one network hiccup should not
 * throw away the other measurements. But if the very first request fails, the URL
 * is most likely wrong and repeating it makes no sense, so the run stops there.
 *
 * @param {URL} url
 * @param {object} [options]
 * @param {number} [options.count] number of requests
 * @param {boolean} [options.keepAlive] reuse one connection for all the requests
 * @param {number} [options.timeoutMs] inactivity timeout for each request
 * @param {string} [options.userAgent]
 * @param {(index: number) => void} [options.onRequestStart]
 * @param {(index: number, bytes: number, totalBytes?: number) => void} [options.onProgress]
 * @param {(result: RequestResult) => void} [options.onResult]
 * @returns {Promise<RequestResult[]>}
 */
export async function runSpeedTest(url, options = {}) {
  const {
    count = 10,
    keepAlive = true,
    timeoutMs,
    userAgent = 'http-speedtest',
    onRequestStart,
    onProgress,
    onResult,
  } = options;

  // Our own agents rather than the global ones, so that keep-alive is an explicit
  // choice and does not depend on the Node.js version (the global agent keeps
  // connections alive only since Node 19). One per protocol: a redirect may switch.
  const agents = { 'http:': new http.Agent({ keepAlive }), 'https:': new https.Agent({ keepAlive }) };
  const headers = {
    // Ask the server not to compress the body: we measure the bytes that actually
    // travel over the network. Servers rarely compress images, but text they do.
    'accept-encoding': 'identity',
    // Some servers and CDNs reject requests that have no User-Agent at all.
    'user-agent': userAgent,
  };

  /** @type {RequestResult[]} */
  const results = [];
  try {
    for (let index = 1; index <= count; index++) {
      onRequestStart?.(index);
      const startedAt = performance.now();
      /** @type {RequestResult} */
      let result;
      try {
        const measurement = await measureRequest(url, {
          agents,
          headers,
          timeoutMs,
          onProgress: onProgress && ((bytes, totalBytes) => onProgress(index, bytes, totalBytes)),
        });
        result = { index, ok: true, ...measurement };
      } catch (error) {
        result = { index, ok: false, error: describeError(error), durationMs: performance.now() - startedAt };
      }
      results.push(result);
      onResult?.(result);
      if (index === 1 && !result.ok) break;
    }
  } finally {
    // Close the idle keep-alive connections, so that the process can exit right away.
    agents['http:'].destroy();
    agents['https:'].destroy();
  }
  return results;
}

/** Turns an error into a one-line message for the report. */
export function describeError(error) {
  // For a response cut off in the middle of the body, Node only says "aborted".
  if (error?.code === 'ECONNRESET' && error.message === 'aborted') {
    return 'Connection closed before the whole body was received';
  }
  // When a host has several addresses (say, IPv6 and IPv4) and connecting to all of
  // them fails, Node throws an AggregateError with an empty message: details are inside.
  if (!error?.message && Array.isArray(error?.errors) && error.errors.length > 0) {
    return [...new Set(error.errors.map((e) => e.message))].join('; ');
  }
  return error?.message || String(error?.code ?? error);
}

/** Sends a GET request and resolves as soon as the response headers have arrived. */
function sendGet(url, { agent, headers, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const transport = url.protocol === 'https:' ? https : http;
    const req = transport.get(url, { agent, headers, timeout: timeoutMs });
    let response;

    req.once('response', (res) => {
      response = res;
      resolve({ res, reusedSocket: req.reusedSocket });
    });
    // Stays subscribed after the response arrives: an error while the body is being
    // read is also delivered to the body stream and handled there, but an 'error'
    // event with no listener at all would crash the process.
    req.on('error', reject);
    // 'timeout' only reports that the socket has been idle for timeoutMs; aborting
    // is up to us. Destroying the body stream (once we have it) makes the pending
    // read fail with this error instead of a generic "aborted".
    req.on('timeout', () => {
      const error = Object.assign(new Error(`Timeout: no data received for ${timeoutMs / 1000} s`), {
        code: 'ETIMEDOUT',
      });
      (response ?? req).destroy(error);
    });
  });
}

/** Reads a response body to the end and throws it away. */
async function discardBody(res) {
  res.resume();
  await finished(res);
}
