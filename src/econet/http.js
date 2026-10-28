// -----------------------------------------------------------------------------
// The only network access of the integration: one HTTP GET to the ecoNET300
// on node:http. A fresh connection per request (no keep-alive, no agent),
// `Connection: close`, a deadline for the whole exchange, a size cap checked
// on every chunk (and on Content-Length before the body), no redirect
// followed. HTTP Basic authentication, as the module and the reference use
// it. Resolves { status, body } for any status; rejects an EconetError for
// the transport failures, with `sent` true as soon as the request was
// written (it may then have reached the module). The promise settles only
// once the socket is closed: the next request never opens a second
// connection while one is still open.
//
// `beforeSend`: called once the connection is up, right before the request
// is written; if it throws, nothing is sent and its error is passed on with
// `beforeSend` set. `signal`: aborts the exchange (a stop takes the
// connection). `sendWithin`: the connection must be up within this many ms,
// else nothing is written (a command never leaves late).
// -----------------------------------------------------------------------------

import http from 'node:http';
import { CODES, EconetError } from './errors.js';

/**
 * @param {object} o
 * @param {string} o.host
 * @param {number} o.port
 * @param {string} o.path with its query, already encoded
 * @param {string} o.authorization the Authorization header value
 * @param {number} o.timeout ms for the whole exchange
 * @param {number} o.maxBytes
 * @param {number} [o.sendWithin]
 * @param {() => void} [o.beforeSend]
 * @param {AbortSignal} [o.signal]
 * @param {{ setTimeout: Function, clearTimeout: Function }} [o.timers]
 */
export function httpGet({
  host,
  port,
  path,
  authorization,
  timeout,
  maxBytes,
  sendWithin,
  beforeSend,
  signal,
  timers = globalThis,
}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let written = false;
    let req = null;
    let socket = null;
    const handles = [];

    const settle = (error, value) => {
      for (const h of handles) {
        timers.clearTimeout(h);
      }
      signal?.removeEventListener('abort', onAbort);
      if (error) {
        reject(error);
      } else {
        resolve(value);
      }
    };
    const finish = (error, value) => {
      if (settled) {
        return;
      }
      settled = true;
      // The socket closed before anything else happens.
      if (socket && !socket.destroyed) {
        socket.once('close', () => settle(error, value));
        socket.destroy();
        return;
      }
      if (socket && !socket.closed && socket.destroyed) {
        socket.once('close', () => settle(error, value));
        return;
      }
      req?.destroy();
      settle(error, value);
    };
    const onAbort = () => finish(new EconetError(CODES.ABORTED, { sent: written }));
    if (signal?.aborted) {
      reject(new EconetError(CODES.ABORTED));
      return;
    }
    signal?.addEventListener('abort', onAbort, { once: true });
    handles.push(
      timers.setTimeout(
        () => finish(new EconetError(CODES.TIMEOUT, { sent: written })),
        Math.max(1, timeout),
      ),
    );
    if (sendWithin !== undefined) {
      handles.push(
        timers.setTimeout(
          () => {
            if (!written) {
              finish(new EconetError(CODES.LATE));
            }
          },
          Math.max(0, sendWithin),
        ),
      );
    }

    const send = () => {
      if (written || settled) {
        return;
      }
      // The very last check of a command, once the connection is up and
      // right before the first byte is written.
      if (beforeSend) {
        try {
          beforeSend();
        } catch (err) {
          err.beforeSend = true;
          err.sent = false;
          finish(err);
          return;
        }
      }
      written = true;
      req.end();
    };

    try {
      req = http.request({
        host,
        port,
        path,
        method: 'GET',
        agent: false,
        headers: {
          accept: 'application/json',
          authorization,
          connection: 'close',
        },
      });
      req.on('socket', (s) => {
        socket = s;
        s.on('error', () => {});
        if (s.connecting) {
          s.once('connect', send);
        } else {
          send();
        }
      });
      req.on('response', (res) => {
        const declared = Number(res.headers['content-length']);
        if (Number.isFinite(declared) && declared > maxBytes) {
          finish(new EconetError(CODES.TOO_LARGE, { sent: true }));
          return;
        }
        const chunks = [];
        let size = 0;
        res.on('data', (chunk) => {
          size += chunk.length;
          if (size > maxBytes) {
            finish(new EconetError(CODES.TOO_LARGE, { sent: true }));
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () =>
          finish(null, { status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }),
        );
        res.on('error', () => finish(new EconetError(CODES.UNREACHABLE, { sent: true })));
      });
      req.on('error', () => finish(new EconetError(CODES.UNREACHABLE, { sent: written })));
    } catch {
      // A header Node refuses: a failure, never a crash.
      finish(new EconetError(CODES.UNREACHABLE));
    }
  });
}
