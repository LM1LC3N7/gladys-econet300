// -----------------------------------------------------------------------------
// The real transport (node:http) and the client against local servers: Basic
// authentication, nothing written when beforeSend refuses, size cap before
// the end, deadlines, one connection at a time, a stop that cuts a stuck read.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { httpGet } from '../src/econet/http.js';
import { EconetClient } from '../src/econet/client.js';
import { CODES } from '../src/econet/errors.js';
import { PASSWORD, USER, basic } from './fixtures/econet.js';
import { blackhole, httpServer, refusePort, reply } from './kit/index.mjs';

const base = (port, extra = {}) => ({
  host: '127.0.0.1',
  port,
  path: '/econet/regParams',
  authorization: basic(USER, PASSWORD),
  timeout: 2000,
  maxBytes: 64 * 1024,
  ...extra,
});

const failure = async (promise) => {
  try {
    await promise;
  } catch (err) {
    return err;
  }
  throw new Error('resolved');
};

test('a GET with HTTP Basic, JSON accepted, no keep-alive; the query kept as is', async (t) => {
  const srv = await httpServer({ routes: { '/econet/newParam': { result: 'OK' } } });
  t.after(() => srv.close());
  const answer = await httpGet(
    base(srv.port, { path: '/econet/newParam?newParamName=BOILER_CONTROL&newParamValue=0' }),
  );
  assert.equal(answer.status, 200);
  assert.deepEqual(JSON.parse(answer.body), { result: 'OK' });
  const [request] = srv.requests;
  assert.equal(request.headers.authorization, basic(USER, PASSWORD));
  assert.equal(request.headers.accept, 'application/json');
  assert.equal(request.headers.connection, 'close');
  assert.deepEqual(request.query, { newParamName: 'BOILER_CONTROL', newParamValue: '0' });
});

test('beforeSend refusing: not one byte written', async (t) => {
  const hole = await blackhole();
  t.after(() => hole.close());
  const err = await failure(
    httpGet(
      base(hole.port, {
        beforeSend: () => {
          throw new Error('option off');
        },
      }),
    ),
  );
  assert.equal(err.message, 'option off');
  assert.equal(err.beforeSend, true);
  assert.equal(err.sent, false);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(hole.received, 0);
  assert.equal(hole.open, 0, 'the socket closed');
});

test('an answer larger than allowed is cut before its end', async (t) => {
  const srv = await httpServer({ routes: { '/econet/regParams': { curr: {} } }, bigBody: 200_000 });
  t.after(() => srv.close());
  const err = await failure(httpGet(base(srv.port)));
  assert.equal(err.code, CODES.TOO_LARGE);
  assert.equal(err.sent, true);
  const declared = await httpServer({
    routes: { '/econet/regParams': reply(200, 'x', { 'content-length': '999999' }) },
  });
  t.after(() => declared.close());
  assert.equal((await failure(httpGet(base(declared.port)))).code, CODES.TOO_LARGE);
});

test('a silent module: timeout, sent; a refused port: unreachable, not sent', async (t) => {
  const hole = await blackhole();
  t.after(() => hole.close());
  const err = await failure(httpGet(base(hole.port, { timeout: 200 })));
  assert.equal(err.code, CODES.TIMEOUT);
  assert.equal(err.sent, true);
  assert.equal(hole.open, 0, 'closed before settling');
  const port = await refusePort();
  const refused = await failure(httpGet(base(port)));
  assert.equal(refused.code, CODES.UNREACHABLE);
  assert.equal(refused.sent, false);
});

test('an abort settles once the socket is closed', async (t) => {
  const hole = await blackhole();
  t.after(() => hole.close());
  const controller = new AbortController();
  const pending = failure(httpGet(base(hole.port, { signal: controller.signal })));
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(hole.open, 1);
  controller.abort();
  const err = await pending;
  assert.equal(err.code, CODES.ABORTED);
  assert.equal(err.sent, true);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(hole.open, 0);
});

test('the client: one connection at a time, the stop first, a stuck read cut', async (t) => {
  let open = 0;
  let peak = 0;
  const seen = [];
  const server = createServer((req, res) => {
    open += 1;
    peak = Math.max(peak, open);
    res.on('close', () => {
      open -= 1;
    });
    seen.push(req.url);
    if (req.url === '/econet/regParams') {
      return; // stuck: never answers
    }
    setTimeout(() => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ result: 'OK', uid: 'x' }));
    }, 20);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  server.on('connection', (socket) => t.after(() => socket.destroy()));
  const client = new EconetClient({
    host: '127.0.0.1',
    port: server.address().port,
    username: USER,
    password: PASSWORD,
  });
  const a = client.sysParams();
  const b = failure(client.regParams());
  const c = client.sysParams();
  await a;
  await new Promise((resolve) => setTimeout(resolve, 50));
  // The read is stuck; c waits behind it; the stop cuts it and leaves first.
  const stop = client.boilerControl(0);
  await stop;
  assert.equal((await b).code, CODES.ABORTED);
  await c;
  assert.deepEqual(seen, [
    '/econet/sysParams',
    '/econet/regParams',
    '/econet/newParam?newParamName=BOILER_CONTROL&newParamValue=0',
    '/econet/sysParams',
  ]);
  assert.equal(peak, 1, 'never two connections');
  // The credentials never appear in an error.
  assert.ok(!JSON.stringify(await b).includes(PASSWORD));
  client.close();
});

test('the client: an HTTP 401 and an answer that is not JSON', async (t) => {
  const srv = await httpServer({
    routes: {
      '/econet/sysParams': reply(401, 'Unauthorized'),
      '/econet/regParams': reply(200, '<html>'),
    },
  });
  t.after(() => srv.close());
  const client = new EconetClient({
    host: '127.0.0.1',
    port: srv.port,
    username: USER,
    password: PASSWORD,
  });
  const denied = await failure(client.sysParams());
  assert.equal(denied.code, CODES.HTTP);
  assert.equal(denied.status, 401);
  assert.equal((await failure(client.regParams())).code, CODES.BAD_ANSWER);
  assert.ok(!Object.keys(client).includes('authorization'), 'the header is not enumerable');
});
