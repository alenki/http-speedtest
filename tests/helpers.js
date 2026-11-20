/**
 * A local HTTP server for the tests: no internet needed, and any network condition
 * (slow, stalled, cut off, redirected, failing) can be reproduced on demand.
 */
import http from 'node:http';
import { once } from 'node:events';
import { setTimeout as sleep } from 'node:timers/promises';
import { gzipSync } from 'node:zlib';

/**
 * Routes:
 *   /file?size              `size` bytes in one go, with Content-Length
 *   /stream?size&chunks&gap&ttfb
 *                           headers after `ttfb` ms, then `size` bytes in `chunks` pieces
 *                           `gap` ms apart, without Content-Length (chunked encoding)
 *   /redirect?hops&size     redirects `hops` times (relative Location), then a /file
 *   /redirect-loop          redirects to itself forever
 *   /status?code            an error page with the given status
 *   /gzip?size              a gzip-compressed body, whatever the client asked for
 *   /hang                   never responds
 *   /stall                  sends the headers and a bit of the body, then goes silent
 *   /truncated              promises 1000 bytes, sends 500 and drops the connection
 *   /flaky?fail&size        the `fail`-th request to this route gets a 503, others a /file
 *
 * `stats` records what the server saw, including the peak number of requests in
 * flight at the same time: 1 means the client never overlapped its requests.
 */
export async function startTestServer() {
  const stats = { requests: 0, connections: 0, inFlight: 0, maxInFlight: 0, headers: [], flakyHits: 0 };
  const server = http.createServer((req, res) => {
    stats.requests++;
    stats.headers.push(req.headers);
    stats.inFlight++;
    stats.maxInFlight = Math.max(stats.maxInFlight, stats.inFlight);
    res.once('close', () => stats.inFlight--);
    handle(req, res, stats).catch((error) => res.destroy(error));
  });
  server.on('connection', () => stats.connections++);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');

  const origin = `http://127.0.0.1:${server.address().port}`;
  return {
    stats,
    url: (path) => new URL(path, origin),
    close: () => {
      server.closeAllConnections();
      server.close();
    },
  };
}

/** A URL on which nothing is listening: connecting to it is refused. */
export async function refusedUrl() {
  const server = http.createServer().listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();
  server.close();
  await once(server, 'close');
  return new URL(`http://127.0.0.1:${port}/file`);
}

async function handle(req, res, stats) {
  const url = new URL(req.url, 'http://localhost');
  const param = (name, fallback) => Number(url.searchParams.get(name) ?? fallback);
  const sendFile = (size) => {
    res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': size });
    res.end(Buffer.alloc(size, 'x'));
  };

  switch (url.pathname) {
    case '/file':
      return sendFile(param('size', 1000));

    case '/stream': {
      const size = param('size', 1000);
      const chunks = param('chunks', 1);
      await sleep(param('ttfb', 0));
      res.writeHead(200, { 'content-type': 'application/octet-stream' });
      for (let i = 0; i < chunks; i++) {
        if (i > 0) await sleep(param('gap', 0));
        const isLast = i === chunks - 1;
        res.write(Buffer.alloc(Math.floor(size / chunks) + (isLast ? size % chunks : 0), 'x'));
      }
      return res.end();
    }

    case '/redirect': {
      const hops = param('hops', 1);
      const size = param('size', 1000);
      const location = hops > 1 ? `/redirect?hops=${hops - 1}&size=${size}` : `/file?size=${size}`;
      res.writeHead(302, { location, 'content-type': 'text/plain' });
      return res.end('Redirecting...'); // a body the client has to read out
    }

    case '/redirect-loop':
      res.writeHead(302, { location: '/redirect-loop' });
      return res.end();

    case '/status':
      res.writeHead(param('code', 500), { 'content-type': 'text/plain' });
      return res.end('Error page');

    case '/gzip': {
      const body = gzipSync(Buffer.alloc(param('size', 100_000)));
      res.writeHead(200, { 'content-encoding': 'gzip', 'content-length': body.length });
      return res.end(body);
    }

    case '/hang':
      return;

    case '/stall':
      res.writeHead(200, { 'content-length': 1000 });
      res.write(Buffer.alloc(100));
      return;

    case '/truncated':
      res.writeHead(200, { 'content-length': 1000 });
      res.write(Buffer.alloc(500));
      await sleep(20);
      return res.socket.destroy();

    case '/flaky':
      if (++stats.flakyHits === param('fail', 1)) {
        res.writeHead(503, { 'content-type': 'text/plain' });
        return res.end('Try again later');
      }
      return sendFile(param('size', 1000));

    default:
      res.writeHead(404);
      return res.end('Not found');
  }
}
