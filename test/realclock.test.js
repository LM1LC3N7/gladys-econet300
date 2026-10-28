// -----------------------------------------------------------------------------
// The app on the REAL clock (sped up 20 times: performance.now, Date.now and
// the timers move by themselves) and a real local HTTP server playing the
// ecoNET300: the reads come at the measured interval, never sooner; a stop
// cuts a stuck read and leaves at once.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { EconetApp } from '../src/app.js';
import { registerHandlers } from '../src/handlers.js';
import { memoryStore } from '../src/store.js';
import { identityKey } from '../src/model.js';
import { CURR, EDITS, PASSWORD, UID, USER } from './fixtures/econet.js';
import { httpServer, measurePeriod, realClock, spyOn } from './kit/index.mjs';

const SPEED = 20;
const INTERVAL = 30_000;
const quiet = { debug() {}, info() {}, warn() {}, error() {} };

async function boot(t, routes = {}) {
  const srv = await httpServer({
    latencyMs: 5,
    routes: {
      '/econet/sysParams': { uid: UID, controllerID: 'ecoMAX860P2-N TOUCH', alarms: [] },
      '/econet/regParams': { curr: { ...CURR } },
      '/econet/rmCurrentDataParamsEdits': { data: EDITS },
      '/econet/newParam': { result: 'OK' },
      ...routes,
    },
  });
  const clock = realClock({ speed: SPEED });
  const gladys = createFakeGladys({ selector: 'econet300-test', config: {} });
  await gladys.connect();
  const app = new EconetApp({
    gladys,
    logger: quiet,
    store: memoryStore(),
    now: clock.now,
    monotonic: clock.monotonic,
    timers: clock.timers,
  });
  // After connect(): the commands reach the app, the start is the test's.
  registerHandlers(gladys, app, quiet);
  t.after(async () => {
    await app.stop();
    clock.close();
    await srv.close();
  });
  const config = {
    address: `127.0.0.1:${srv.port}`,
    username: USER,
    password: PASSWORD,
    poll_interval: INTERVAL / 1000,
  };
  return { srv, clock, gladys, app, config };
}

test('real clock x20: a read at once, then every interval (measured), timers bounded', async (t) => {
  const { clock, app, config, gladys } = await boot(t);
  const spy = spyOn(app, 'read', clock);
  await app.connected(async () => config);
  const gaps = await measurePeriod(spy, { count: 4, period: INTERVAL });
  assert.equal(gaps.length, 3);
  assert.ok(clock.timersSet < 40, `${clock.timersSet} timers`);
  assert.equal(gladys.fake.connectionStatus.connected, true);
});

test('real clock x20: "Off" cuts a stuck read and is sent at once', async (t) => {
  let stuck = false;
  const { srv, clock, app, config, gladys } = await boot(t, {
    '/econet/regParams': () => (stuck ? 'silent' : { curr: { ...CURR } }),
  });
  await app.connected(async () => config);
  stuck = true;
  // The next read gets stuck on regParams.
  await clock.sleep(INTERVAL + 1000);
  assert.equal(app.session.client.busy, true);
  stuck = false;
  const key = identityKey(UID);
  const started = performance.now();
  const ack = await gladys.fake.setValue(
    { external_id: `ext:econet300-test:econet300:${key}` },
    { external_id: `ext:econet300-test:econet300:${key}:boiler-control` },
    'off',
  );
  const elapsed = (performance.now() - started) * SPEED;
  assert.equal(srv.count('/econet/newParam'), 1, JSON.stringify(ack));
  assert.ok(elapsed < 4500, `acked after ${Math.round(elapsed)} ms (simulated)`);
  // The fake keeps mode 3: sent and accepted, not shown yet.
  assert.equal(ack.success, false);
  assert.match(ack.error, /Arrêt envoyé et accepté/);
  assert.equal(app.session.failures, 0, 'the cut read is no failure');
});
