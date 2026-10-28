// -----------------------------------------------------------------------------
// The reads, the device, the failures, /data, the configuration, against the
// SDK's fake Gladys and a fake ecoNET300 on a virtual clock.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { memoryStore } from '../src/store.js';
import { identityKey } from '../src/model.js';
import { CONFIG, OTHER_UID, PASSWORD, SECRETS, UID, USER } from './fixtures/econet.js';
import { DEVICE, F, HOUR, KEY, MINUTE, SECOND, last, setup } from './helpers/app.js';

const statusText = (t) => t.gladys.fake.connectionStatus?.message?.fr ?? '';

test('discovery, then the states of the created device', async () => {
  const t = await setup();
  await t.connect();
  const device = t.gladys.fake.discoveredDevices.find((d) => d.external_id === DEVICE);
  assert.ok(device, 'discovered');
  assert.equal(device.model, 'ecoMAX860P2-N TOUCH');
  assert.equal(device.name, 'ecoMAX860P2-N TOUCH (ecoNET300)');
  const roles = device.features.map((f) => f.external_id.split(':').pop());
  assert.deepEqual(roles, [
    'boiler-control',
    'operation',
    'boiler-temperature',
    'boiler-setpoint',
    'dhw-temperature',
    'dhw-setpoint',
    'outdoor-temperature',
    'flue-gas-temperature',
    'buffer-upper-temperature',
    'mixer1-temperature',
    'fuel-level',
    'alarms',
    'status',
  ]);
  // No switch nor binary: a "turn everything off" never reaches the boiler.
  assert.ok(device.features.every((f) => !['switch', 'binary'].includes(f.category)));
  assert.ok(device.features.every((f) => f.type !== 'binary'));
  // The uid (econet24.com identifier) is never published.
  assert.ok(!JSON.stringify(t.gladys.fake.discoveredDevices).includes(UID));
  await t.create();
  assert.equal(last(t.gladys, 'boiler-temperature'), 62.6);
  assert.equal(last(t.gladys, 'dhw-setpoint'), 45);
  assert.equal(last(t.gladys, 'boiler-setpoint'), 63);
  assert.equal(last(t.gladys, 'fuel-level'), 66);
  assert.equal(last(t.gladys, 'operation'), 'Fonctionnement');
  assert.equal(last(t.gladys, 'boiler-control'), 'on');
  assert.equal(last(t.gladys, 'alarms'), 'Aucune alarme');
  assert.equal(last(t.gladys, 'status'), 'OK');
  // A sensor not fitted (null) is no measurement, and a text never a 0.
  assert.equal(last(t.gladys, 'return-temperature'), undefined);
  for (const s of t.gladys.fake.states) {
    if (/:(operation|boiler-control|alarms|status)$/.test(s.device_feature_external_id)) {
      assert.equal(typeof s.text, 'string');
      assert.equal(s.state, undefined);
    }
  }
  assert.equal(t.gladys.fake.connectionStatus.connected, true);
  assert.match(statusText(t), /Connecté à ecoMAX860P2-N TOUCH/);
  assert.equal(t.dev.peak, 1, 'one connection at a time');
  assert.deepEqual(t.gladys.fake.transports.at(-1), {
    device_external_id: DEVICE,
    transport: 'local',
  });
});

test('an alarm still running is shown by name; values outside their range are not measurements', async () => {
  const t = await setup();
  t.dev.alarms.unshift({ code: '7', fromDate: '2026-10-28 09:00:00', toDate: null });
  t.dev.curr.tempFlueGas = 3276.7;
  t.dev.curr.fuelLevel = 255;
  await t.connect();
  await t.create();
  assert.equal(last(t.gladys, 'alarms'), 'Alarme : échec de l’allumage, videz le cendrier');
  assert.equal(last(t.gladys, 'flue-gas-temperature'), undefined);
  assert.equal(last(t.gladys, 'fuel-level'), undefined);
});

test('reads every interval, measured from the start of the read before', async () => {
  const t = await setup({ latency: 300 });
  await t.connect();
  const reads = () => t.dev.count('/econet/sysParams');
  assert.equal(reads(), 1);
  await t.wait(59 * SECOND);
  assert.equal(reads(), 1, 'never sooner than the interval');
  await t.wait(2 * SECOND);
  assert.equal(reads(), 2);
  await t.wait(60 * SECOND);
  assert.equal(reads(), 3);
  assert.ok(t.clock.pending < 10, `${t.clock.pending} timers pending`);
});

test('a restart never reads sooner than the interval after the last read (in /data)', async () => {
  const store = memoryStore();
  const a = await setup({ store });
  await a.connect();
  assert.equal(a.dev.count('/econet/sysParams'), 1);
  assert.ok(store.data.lastReadAt > 0);
  await a.app.stop();
  // Restarted 20 s later.
  const clock = a.clock;
  await clock.advance(20 * SECOND);
  const b = await setup({ store, clock });
  await b.connect();
  assert.equal(b.dev.count('/econet/sysParams'), 0, 'not at once');
  assert.match(statusText(b), /Prochaine lecture dans 40 s/);
  await b.wait(39 * SECOND);
  assert.equal(b.dev.count('/econet/sysParams'), 0);
  await b.wait(2 * SECOND);
  assert.equal(b.dev.count('/econet/sysParams'), 1);
});

test('a date of /data in the future is invalid: read at once', async () => {
  const store = memoryStore({ lastReadAt: Date.UTC(2030, 0, 1), salt: 'a'.repeat(32) });
  const t = await setup({ store });
  await t.connect();
  assert.equal(t.dev.count('/econet/sysParams'), 1);
});

test('getConfig() failing at the start is tried again without end, then the reads begin', async () => {
  // Call 1 is the SDK's own resynchronization (it reconnects when that one
  // fails); calls 2 to 4 are those of the integration, made to fail.
  let calls = 0;
  const t = await setup({
    getConfig: async () => {
      calls += 1;
      if (calls >= 2 && calls <= 4) {
        throw new Error('HTTP 502');
      }
      return CONFIG;
    },
  });
  await t.connect();
  assert.equal(t.dev.requests.length, 0);
  assert.match(statusText(t), /Configuration non lue depuis Gladys ; nouvel essai dans 5 s/);
  await t.wait(5 * SECOND);
  assert.match(statusText(t), /nouvel essai dans 10 s/);
  await t.wait(10 * SECOND);
  assert.match(statusText(t), /nouvel essai dans 30 s/);
  assert.equal(t.dev.requests.length, 0);
  await t.wait(30 * SECOND);
  assert.equal(calls, 5);
  assert.equal(t.dev.count('/econet/sysParams'), 1);
  assert.equal(t.gladys.fake.connectionStatus.connected, true);
});

test('getConfig() failing in `connected` after a reconnection: the session goes on, retried, then resynced', async () => {
  // After the reconnection, the SDK's resynchronization reads the
  // configuration once (it must pass), then the integration's reads fail.
  let failFrom = Infinity;
  let calls = 0;
  const t = await setup({
    getConfig: async () => {
      calls += 1;
      if (calls >= failFrom) {
        throw new Error('timeout');
      }
      return CONFIG;
    },
  });
  await t.connect();
  await t.create();
  failFrom = calls + 2;
  await t.gladys.disconnect();
  await t.connect();
  assert.ok(calls >= failFrom, 'the integration read it and failed');
  // The reads go on meanwhile.
  await t.wait(61 * SECOND);
  assert.equal(t.dev.count('/econet/sysParams'), 2);
  const before = calls;
  failFrom = Infinity;
  await t.wait(MINUTE);
  assert.ok(calls > before, 'tried again');
  assert.equal(t.gladys.fake.connectionStatus.connected, true);
  assert.equal(last(t.gladys, 'status'), 'OK');
});

test('user name or password refused: stopped, persisted, no automatic retry; the button lifts it', async () => {
  const store = memoryStore();
  const t = await setup({ store, config: { ...CONFIG, password: 'wrong-pass' } });
  await t.connect();
  assert.equal(t.dev.count('/econet/sysParams'), 1);
  assert.equal(t.gladys.fake.connectionStatus.connected, false);
  assert.match(statusText(t), /a refusé le nom d’utilisateur ou le mot de passe/);
  assert.equal(store.data.refused, true);
  assert.match(store.data.fp, /^[0-9a-f]{2}$/, '8 bits only');
  await t.wait(2 * HOUR);
  assert.equal(t.dev.count('/econet/sysParams'), 1, 'no automatic retry');
  assert.equal(t.app.session.timer, undefined, 'no read scheduled');
  // A restart with the same credentials stays stopped.
  await t.app.stop();
  const b = await setup({ store, config: { ...CONFIG, password: 'wrong-pass' }, clock: t.clock });
  await b.connect();
  await b.wait(2 * HOUR);
  assert.equal(b.dev.count('/econet/sysParams'), 0);
  // The password fixed on the module: the button tries once and lifts it.
  b.dev.password = 'wrong-pass';
  const ack = await b.during(b.gladys.fake.action('test_connection', {}));
  assert.equal(ack.ok, true);
  assert.equal(store.data.refused, false);
  assert.equal(store.data.fp, '');
  assert.equal(b.gladys.fake.connectionStatus.connected, true);
});

test('other credentials saved lift the refusal at once', async () => {
  const store = memoryStore();
  const t = await setup({ store, config: { ...CONFIG, password: 'wrong-pass' } });
  await t.connect();
  assert.equal(store.data.refused, true);
  await t.during(t.gladys.fake.configUpdated(CONFIG));
  await t.wait(0);
  assert.equal(store.data.refused, false);
  assert.equal(t.dev.count('/econet/sysParams'), 2);
  assert.equal(t.gladys.fake.connectionStatus.connected, true);
});

test('the 8-bit print of refused credentials cannot test a password', async () => {
  const { refusalPrint } = await import('../src/store.js');
  const salt = '0123456789abcdef0123456789abcdef';
  const config = { host: '192.168.1.50', port: 80, username: USER, password: PASSWORD };
  const print = refusalPrint(salt, config);
  // 300 guesses for 256 possible prints: some look the same as the refused
  // password; the print says nothing of it.
  const prints = new Set();
  let matches = 0;
  for (let i = 0; i < 300; i += 1) {
    const guess = refusalPrint(salt, { ...config, password: `guess-${i}` });
    prints.add(guess);
    if (guess === print) {
      matches += 1;
    }
  }
  assert.ok(prints.size <= 256);
  assert.ok(matches <= 10, `${matches} guesses match`);
});

test('HTTP 429/5xx: a pause persisted in /data, no read during it', async () => {
  const store = memoryStore();
  const t = await setup({ store });
  await t.connect();
  t.dev.route = () => ({ status: 503, body: 'busy' });
  await t.wait(61 * SECOND);
  assert.equal(t.dev.count('/econet/sysParams'), 2);
  assert.match(statusText(t), /demande de ralentir/);
  assert.ok(store.data.pausedUntil > t.clock.now());
  t.dev.route = undefined;
  await t.wait(30 * SECOND);
  assert.equal(t.dev.count('/econet/sysParams'), 2, 'paused');
  await t.wait(MINUTE);
  assert.equal(t.dev.count('/econet/sysParams'), 3);
  assert.equal(t.gladys.fake.connectionStatus.connected, true);
});

test('the bounds (secondary) failing never blocks the values', async () => {
  const t = await setup();
  t.dev.route = (path) =>
    path === '/econet/rmCurrentDataParamsEdits' ? { status: 401, body: 'no' } : undefined;
  await t.connect();
  await t.create();
  assert.equal(last(t.gladys, 'boiler-temperature'), 62.6);
  assert.equal(t.gladys.fake.connectionStatus.connected, true);
  assert.equal(t.app.memory.refused, false, 'a 401 there is no refusal');
  assert.ok(!t.logger.lines.some((l) => /refused the user name/.test(l)));
  t.dev.route = (path) =>
    path === '/econet/rmCurrentDataParamsEdits' ? { status: 404, body: 'no' } : undefined;
  t.dev.curr.tempCO = 70.04;
  await t.wait(61 * SECOND);
  assert.equal(last(t.gladys, 'boiler-temperature'), 70);
});

test('unreachable: backoff never sooner than the interval; values kept, status says so', async () => {
  const t = await setup();
  await t.connect();
  await t.create();
  t.dev.route = () => 'refuse';
  await t.wait(61 * SECOND);
  assert.equal(t.dev.count('/econet/sysParams'), 1);
  assert.equal(t.dev.unsent, 1);
  assert.match(statusText(t), /non lu \(unreachable\) ; nouvel essai dans 60 s/);
  assert.equal(last(t.gladys, 'status'), 'ecoNET300 injoignable');
  assert.equal(t.gladys.fake.transports.at(-1).transport, 'unreachable');
  await t.wait(61 * SECOND);
  await t.wait(2 * MINUTE + SECOND);
  assert.equal(t.dev.unsent, 3, '1 min, then 2 min');
  // A device created meanwhile gets no stale value as new.
  const count = t.gladys.fake.states.length;
  await t.gladys.fake.deviceUpdated(t.gladys.fake.devices[0]);
  await t.wait(SECOND);
  const added = t.gladys.fake.states.slice(count);
  assert.ok(
    added.every((s) => s.device_feature_external_id === F('status')),
    'only the status',
  );
});

test('another module at the address: its values never go to the created device', async () => {
  const t = await setup();
  await t.connect();
  await t.create();
  t.dev.uid = OTHER_UID;
  t.dev.curr.tempCO = 20;
  await t.wait(61 * SECOND);
  assert.equal(last(t.gladys, 'boiler-temperature'), 62.6, 'not the other one');
  assert.equal(last(t.gladys, 'status'), 'Un autre ecoNET300 répond à cette adresse');
  const other = `ext:econet300-test:econet300:${identityKey(OTHER_UID)}`;
  assert.ok(t.gladys.fake.discoveredDevices.some((d) => d.external_id === other));
});

test('a module without its uid: nothing published as a device, status says so', async () => {
  const t = await setup();
  t.dev.uid = null;
  await t.connect();
  assert.equal(t.gladys.fake.discoveredDevices.length, 0);
  assert.match(statusText(t), /sans son identifiant/);
});

test('a controller without regParams values: connected, said, the stop still possible', async () => {
  const t = await setup();
  t.dev.route = (path) =>
    path === '/econet/regParams' ? { status: 200, body: '{"curr":{}}' } : undefined;
  await t.connect();
  const device = t.gladys.fake.discoveredDevices[0];
  assert.deepEqual(
    device.features.map((f) => f.external_id.split(':').pop()),
    ['alarms', 'status'],
  );
});

test('a feature once seen is never lost when republished', async () => {
  const t = await setup();
  await t.connect();
  await t.create();
  t.dev.curr.tempUpperBuffer = null;
  t.dev.curr.mixerTemp1 = null;
  await t.wait(61 * SECOND);
  await t.app.scan();
  const ids = t.gladys.fake.discoveredDevices[0].features.map((f) => f.external_id);
  assert.ok(ids.includes(F('buffer-upper-temperature')));
  assert.ok(ids.includes(F('mixer1-temperature')));
});

test('secrets: never in /data, the logs, the statuses, the states', async () => {
  const store = memoryStore();
  const t = await setup({ store, config: { ...CONFIG, password: PASSWORD } });
  await t.connect();
  await t.create();
  await t.command('boiler-control', 'off');
  t.dev.password = 'other';
  await t.wait(61 * SECOND);
  const everything = JSON.stringify([
    store.data,
    t.logger.lines,
    t.gladys.fake.connectionStatuses,
    t.gladys.fake.states,
    t.gladys.fake.discoveredDevices,
  ]);
  for (const secret of [
    PASSWORD,
    UID,
    SECRETS.key,
    SECRETS.ssid,
    Buffer.from(`${USER}:${PASSWORD}`).toString('base64'),
  ]) {
    assert.ok(!everything.includes(secret), `leaked ${secret}`);
  }
  assert.deepEqual(Object.keys(store.data).sort(), [
    'fp',
    'lastReadAt',
    'pausedUntil',
    'refused',
    'salt',
    'stop',
  ]);
});

test('/data unreadable: never written over; said in the status', async () => {
  const store = memoryStore({ lastReadAt: 1 }, { unreadable: true });
  const t = await setup({ store });
  await t.connect();
  await t.wait(2 * MINUTE);
  assert.equal(store.saves, 0);
  assert.deepEqual(store.data, { lastReadAt: 1 });
  assert.match(statusText(t), /\/data illisible/);
  assert.equal(t.dev.count('/econet/sysParams'), 3, 'the reads go on');
});

test('the configuration: problems shown, never a read', async () => {
  for (const [config, text] of [
    [{}, /Saisissez l’adresse/],
    [{ ...CONFIG, address: 'https://192.168.1.50' }, /sans https/],
    [{ ...CONFIG, address: '192.168.1.255' }, /diffusion/],
    [{ ...CONFIG, address: '0.0.0.0' }, /diffusion/],
    [{ ...CONFIG, address: '239.1.1.1' }, /diffusion/],
    [{ ...CONFIG, address: '192.168.1.50/econet' }, /Adresse non valide/],
    [{ ...CONFIG, address: 'user@192.168.1.50' }, /Adresse non valide/],
    [{ ...CONFIG, username: '' }, /un mot de passe seul est refusé/],
    [{ ...CONFIG, password: '' }, /Saisissez le mot de passe/],
    [{ ...CONFIG, password: 'a\r\nX-Evil: 1' }, /Mot de passe non valide/],
    [{ ...CONFIG, username: 'admin\u0000' }, /Nom d’utilisateur non valide/],
  ]) {
    const t = await setup({ config });
    await t.connect();
    assert.equal(t.dev.requests.length, 0, JSON.stringify(config));
    assert.match(statusText(t), text, JSON.stringify(config));
  }
});

test('configurations saved back to back apply one at a time, the last one wins', async () => {
  const t = await setup();
  await t.connect();
  const a = t.gladys.fake.configUpdated({ ...CONFIG, address: '192.168.1.51' });
  const b = t.gladys.fake.configUpdated({ ...CONFIG, address: '192.168.1.52' });
  const c = t.gladys.fake.configUpdated({ ...CONFIG, address: '192.168.1.53', poll_interval: 120 });
  await t.during(Promise.all([a, b, c]));
  await t.wait(0);
  assert.equal(t.app.config.host, '192.168.1.53');
  assert.equal(t.app.config.pollInterval, 120);
  assert.equal(t.app.session.client.host, '192.168.1.53');
  assert.equal(t.dev.peak, 1);
});

test('the button never reads sooner than the interval', async () => {
  const t = await setup();
  await t.connect();
  const ack = await t.during(t.gladys.fake.action('test_connection', {}));
  assert.match(ack.value.data.message, /prochain essai possible dans 60 s/);
  assert.equal(t.dev.count('/econet/sysParams'), 1);
  await t.wait(61 * SECOND);
  assert.equal(t.dev.count('/econet/sysParams'), 2);
  void KEY;
});

test('values older than two intervals are never published as new', async () => {
  const t = await setup();
  await t.connect();
  await t.create();
  t.app.session.data.at -= 10 * MINUTE;
  const count = t.gladys.fake.states.length;
  await t.gladys.fake.deviceUpdated(t.gladys.fake.devices[0]);
  await t.wait(SECOND);
  const added = t.gladys.fake.states.slice(count);
  assert.deepEqual(
    added.map((s) => [s.device_feature_external_id, s.text]),
    [[F('status'), 'État non lu']],
  );
});

test('with a 30 s interval, a restart still waits the interval after the last read', async () => {
  const store = memoryStore();
  const a = await setup({ store, config: { ...CONFIG, poll_interval: 30 } });
  await a.connect();
  await a.wait(31 * SECOND);
  assert.equal(a.dev.count('/econet/sysParams'), 2);
  await a.app.stop();
  await a.clock.advance(5 * SECOND);
  const b = await setup({ store, clock: a.clock, config: { ...CONFIG, poll_interval: 30 } });
  await b.connect();
  assert.equal(b.dev.count('/econet/sysParams'), 0);
  await b.wait(26 * SECOND);
  assert.equal(b.dev.count('/econet/sysParams'), 1);
});

test('the button during a pause reads nothing, even past the interval', async () => {
  const t = await setup();
  await t.connect();
  t.dev.route = () => ({ status: 503, body: 'busy' });
  // Two 503 in a row: the second pause (2 min) outlasts the interval.
  await t.wait(61 * SECOND);
  await t.wait(61 * SECOND);
  t.dev.route = undefined;
  const count = t.dev.count('/econet/sysParams');
  await t.wait(61 * SECOND);
  assert.ok(t.app.pauseLeft() > 0, 'still paused');
  const ack = await t.during(t.gladys.fake.action('test_connection', {}), 2 * SECOND);
  assert.ok(ack.ok);
  assert.match(ack.value.data.message, /demande de ralentir/);
  assert.equal(t.dev.count('/econet/sysParams'), count, 'nothing read during the pause');
});

test('a refusal kept without a readable print is never lifted by a restart', async () => {
  const store = memoryStore({ refused: true, fp: '', salt: 'a'.repeat(32) });
  const t = await setup({ store });
  await t.connect();
  await t.wait(2 * HOUR);
  assert.equal(t.dev.count('/econet/sysParams'), 0);
  assert.equal(store.data?.refused ?? true, true);
});
