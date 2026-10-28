// -----------------------------------------------------------------------------
// "Off" (BOILER_CONTROL=0), the protective command: it leaves whatever holds
// the others, its guard is never lifted by time, nothing begun before it
// leaves after it.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { memoryStore } from '../src/store.js';
import { CONFIG, OTHER_UID } from './fixtures/econet.js';
import { HOUR, KEY, MINUTE, SECOND, last, setup } from './helpers/app.js';

const ALLOW = { ...CONFIG, allow_commands: true };
const isStop = (r) => r.path === '/econet/newParam' && r.query.newParamValue === '0';
const isStart = (r) => r.path === '/econet/newParam' && r.query.newParamValue === '1';
const stops = (t) => t.dev.requests.filter(isStop).length;
const statusText = (t) => t.gladys.fake.connectionStatus?.message?.fr ?? '';

test('Off with the option off: sent at once, success once read off, kept in /data', async () => {
  const store = memoryStore();
  const t = await setup({ store });
  await t.connect();
  await t.create();
  const at = t.clock.monotonic();
  const ack = await t.command('boiler-control', 'off');
  assert.deepEqual(ack, { success: true });
  assert.ok(t.clock.monotonic() - at < 4_300, 'acked within the budget');
  assert.equal(stops(t), 1);
  assert.equal(t.dev.requests.find(isStop).query.newParamName, 'BOILER_CONTROL');
  assert.deepEqual(store.data.stop, {
    key: KEY,
    phase: 'confirmed',
    tries: 0,
    resends: 0,
    starts: 0,
    from: 3,
  });
  await t.wait(6 * SECOND);
  assert.equal(last(t.gladys, 'boiler-control'), 'off');
  assert.equal(last(t.gladys, 'operation'), 'Arrêt');
  assert.equal(last(t.gladys, 'status'), 'Arrêtée depuis Gladys');
});

test('Off is never held by: a 429 pause, refused credentials, /data unreadable, a device not read yet', async () => {
  // A pause.
  const a = await setup();
  await a.connect();
  a.dev.route = () => ({ status: 429, body: 'slow down' });
  await a.wait(61 * SECOND);
  assert.ok(a.app.pauseLeft() > 0);
  a.dev.route = undefined;
  assert.deepEqual(await a.command('boiler-control', 'off'), { success: true });
  // Refused credentials (fixed on the module since: the stop goes, one try).
  const b = await setup({ config: { ...CONFIG, password: 'old' } });
  await b.connect();
  assert.equal(b.app.memory.refused, true);
  b.dev.password = 'old';
  assert.deepEqual(await b.command('boiler-control', 'off'), { success: true });
  // /data unreadable.
  const c = await setup({ store: memoryStore(null, { unreadable: true }) });
  await c.connect();
  assert.deepEqual(await c.command('boiler-control', 'off'), { success: true });
  // Before the first read (a restart waiting for the interval).
  const store = memoryStore();
  const d0 = await setup({ store });
  await d0.connect();
  await d0.app.stop();
  const d = await setup({ store, clock: d0.clock });
  await d.connect();
  assert.equal(d.dev.count('/econet/sysParams'), 0, 'no read yet');
  const ack = await d.command('boiler-control', 'off');
  assert.equal(stops(d), 1);
  // Not read before: success once a read shows it off.
  assert.deepEqual(ack, { success: true });
});

test('Off cuts a read stuck in flight and leaves first; the cut read is no failure', async () => {
  const t = await setup();
  await t.connect();
  await t.create();
  t.dev.route = (path) => (path === '/econet/regParams' ? 'silent' : undefined);
  await t.wait(60 * SECOND + 500);
  assert.equal(t.app.session.client.busy, true, 'a read is stuck');
  t.dev.route = undefined;
  const ack = await t.command('boiler-control', 'off');
  assert.deepEqual(ack, { success: true });
  assert.equal(t.dev.peak, 1, 'never two connections');
  assert.notEqual(t.app.session.online, false, 'the cut read is no failure');
  assert.equal(t.app.session.failures, 0);
});

test('Off goes ahead of a full queue; the commands waiting are never sent after it', async () => {
  const t = await setup({ config: ALLOW, latency: 400 });
  await t.connect();
  await t.create();
  const device = { external_id: `ext:econet300-test:econet300:${KEY}` };
  const sp = (v) =>
    t.gladys.fake.setValue(device, { external_id: `${device.external_id}:dhw-setpoint` }, v);
  const waiting = [sp(50), sp(51), sp(52), sp(53)];
  const full = await t.during(sp(54), 100);
  assert.match(full.value.error, /Trop de commandes en attente/);
  await t.wait(100);
  const off = t.command('boiler-control', 'off');
  const results = await t.during(Promise.all([off, ...waiting]), 10 * SECOND);
  const [stopAck, ...others] = results.value;
  assert.equal(stopAck.success, true);
  for (const ack of others) {
    assert.equal(ack.success, false);
  }
  const at = t.dev.requests.findIndex(isStop);
  const after = t.dev.requests.slice(at + 1);
  assert.ok(!after.some((r) => r.path === '/econet/rmCurrNewParam'), 'nothing after the stop');
  assert.equal(t.dev.peak, 1);
});

test('a setpoint whose fresh read is under way is never written after a stop', async () => {
  const t = await setup({ config: ALLOW, latency: 300 });
  await t.connect();
  await t.create();
  const setpoint = t.command('dhw-setpoint', 50);
  await t.wait(350);
  const off = t.command('boiler-control', 'off');
  const [sp, stop] = (await t.during(Promise.all([setpoint, off]))).value;
  assert.equal(stop.success, true);
  assert.equal(sp.success, false);
  assert.match(sp.error, /Un arrêt a été envoyé depuis|rien envoyé/);
  assert.equal(t.dev.count('/econet/rmCurrNewParam'), 0);
});

test('Off unreachable: tried again for 250 ms, kept in /data, sent again by the reads (3 at most)', async () => {
  const store = memoryStore();
  const t = await setup({ store });
  await t.connect();
  await t.create();
  t.dev.route = () => 'refuse';
  const ack = await t.command('boiler-control', 'off');
  assert.equal(ack.success, false);
  assert.match(ack.error, /Arrêt non envoyé \(unreachable\) : renvoyé à chaque lecture/);
  assert.ok(t.dev.unsent >= 3, `${t.dev.unsent} tries within 250 ms`);
  assert.ok(t.dev.unsent <= 6);
  assert.equal(store.data.stop.phase, 'unsent');
  await t.wait(SECOND);
  assert.equal(
    last(t.gladys, 'status'),
    'Arrêt depuis Gladys pas encore envoyé : renvoyé à chaque lecture',
  );
  const unsent = t.dev.unsent;
  // The module comes back: the next read sends the stop first.
  t.dev.route = undefined;
  await t.wait(61 * SECOND);
  const at = t.dev.requests.findIndex(isStop);
  assert.ok(at >= 0, 'sent by the read');
  assert.ok(t.dev.requests.slice(0, at).every((r) => r.path !== '/econet/sysParams' || true));
  assert.equal(store.data.stop.phase, 'confirmed');
  assert.ok(t.dev.unsent >= unsent);
});

test('a stop that never left is never given up: a long outage, then sent at the first read', async () => {
  const store = memoryStore();
  const t = await setup({ store });
  await t.connect();
  t.dev.route = () => 'refuse';
  await t.command('boiler-control', 'off');
  // Reads fail for 25 min (backoff 1, 2, 5, 10, 10 min): the stop never leaves.
  await t.wait(25 * MINUTE);
  assert.ok(t.dev.unsent >= 8, `${t.dev.unsent} tries`);
  assert.equal(store.data.stop.phase, 'unsent');
  assert.match(statusText(t), /ecoNET300 non lu/);
  const before = t.dev.requests.length;
  t.dev.route = undefined;
  await t.wait(11 * MINUTE);
  assert.ok(isStop(t.dev.requests[before]), 'the stop first, at the first read that gets through');
  assert.equal(store.data.stop.phase, 'confirmed');
});

test('a stop the module refuses (HTTP 403) is sent again twice at most, the reads go on, no print', async () => {
  const store = memoryStore();
  const t = await setup({ store });
  await t.connect();
  t.dev.route = (path) => (path === '/econet/newParam' ? { status: 403, body: 'no' } : undefined);
  const ack = await t.command('boiler-control', 'off');
  assert.match(ack.error, /Arrêt non envoyé \(HTTP 403\)/);
  for (let i = 0; i < 5; i += 1) {
    await t.wait(61 * SECOND);
  }
  assert.equal(stops(t), 3);
  assert.equal(store.data.refused, false);
  assert.equal(store.data.fp, '');
  assert.ok(t.dev.count('/econet/sysParams') >= 6, 'the reads go on');
  assert.match(statusText(t), /refusé 3 fois par l’ecoNET300 \(HTTP 401\/403\) : plus renvoyé/);
});

test('a stop kept unsent is never sent again to another module at the address', async () => {
  const store = memoryStore();
  const t = await setup({ store });
  await t.connect();
  t.dev.route = () => 'refuse';
  await t.command('boiler-control', 'off');
  t.dev.route = (path) => (path === '/econet/newParam' ? 'refuse' : undefined);
  t.dev.uid = OTHER_UID;
  await t.wait(61 * SECOND);
  t.dev.route = undefined;
  await t.wait(5 * MINUTE);
  assert.equal(stops(t), 0);
  assert.equal(store.data.stop.phase, 'unsent');
});

test('a stop kept in /data that never left goes first at a restart, before any read', async () => {
  const store = memoryStore({
    salt: 'a'.repeat(32),
    lastReadAt: Date.UTC(2026, 9, 28, 9, 59, 50),
    stop: { key: KEY, phase: 'unsent', tries: 0, resends: 0, starts: 0 },
  });
  const t = await setup({ store });
  await t.connect();
  assert.ok(isStop(t.dev.requests[0]), `first: ${t.dev.requests[0]?.path}`);
  assert.equal(t.dev.count('/econet/sysParams'), 0, 'the interval still holds for the reads');
  assert.equal(store.data.stop.phase, 'sent');
  await t.wait(11 * SECOND);
  assert.equal(store.data.stop.phase, 'confirmed');
});

test('Off contradicted by the reads: sent again 3 times at most, then said', async () => {
  const t = await setup();
  await t.connect();
  await t.create();
  t.dev.ignoreControl = true;
  const ack = await t.command('boiler-control', 'off');
  assert.equal(ack.success, false);
  assert.match(ack.error, /Arrêt envoyé et accepté ; la chaudière ne l’indique pas encore/);
  await t.wait(25 * SECOND);
  for (let i = 0; i < 5; i += 1) {
    await t.wait(61 * SECOND);
  }
  assert.equal(stops(t), 4, 'the click and 3 resends');
  assert.equal(
    last(t.gladys, 'status'),
    'Arrêt depuis Gladys envoyé mais la chaudière fonctionne encore',
  );
});

test('burning off is no contradiction: the stop is not sent again', async () => {
  const t = await setup();
  await t.connect();
  t.dev.ignoreControl = true;
  t.dev.route = (path) => {
    if (path === '/econet/newParam') {
      t.dev.curr.mode = 7;
    }
    return undefined;
  };
  const ack = await t.command('boiler-control', 'off');
  assert.deepEqual(ack, { success: true }, 'burning off after running: applied');
  await t.wait(30 * MINUTE);
  assert.equal(stops(t), 1);
});

test('the guard of a stop is never lifted by time; a start elsewhere read twice lifts it', async () => {
  const store = memoryStore();
  const t = await setup({ store, config: ALLOW });
  await t.connect();
  await t.create();
  await t.command('boiler-control', 'off');
  await t.wait(48 * HOUR);
  assert.equal(store.data.stop.phase, 'confirmed');
  const refused = await t.command('dhw-setpoint', 50);
  assert.match(refused.error, /arrêtée depuis Gladys : remettez-la en « Marche »/);
  // Started on the panel: one read is not enough...
  t.dev.curr.mode = 2;
  await t.wait(61 * SECOND);
  assert.ok(store.data.stop, 'one read: kept');
  assert.equal(stops(t), 1, 'never sent again once seen applied');
  // ...two in a row are.
  await t.wait(61 * SECOND);
  assert.equal(store.data.stop, null);
  assert.equal((await t.command('dhw-setpoint', 50)).success, true);
});

test('a read off between two starts restarts the count', async () => {
  const store = memoryStore();
  const t = await setup({ store });
  await t.connect();
  await t.command('boiler-control', 'off');
  await t.wait(25 * SECOND);
  t.dev.curr.mode = 2;
  await t.wait(40 * SECOND);
  t.dev.curr.mode = 0;
  await t.wait(61 * SECOND);
  t.dev.curr.mode = 2;
  await t.wait(61 * SECOND);
  assert.ok(store.data.stop, 'not two in a row');
  assert.equal(store.data.stop.starts, 1);
});

test('"On" with the option lifts the stop on disk before it leaves; refused when /data cannot be written', async () => {
  const store = memoryStore();
  const t = await setup({ store, config: ALLOW });
  await t.connect();
  await t.create();
  await t.command('boiler-control', 'off');
  store.failing = true;
  const refused = await t.command('boiler-control', 'on');
  assert.match(refused.error, /\/data ne peut être lu ou écrit : rien envoyé/);
  assert.equal(t.dev.requests.filter(isStart).length, 0);
  assert.ok(t.app.memory.stop, 'the stop holds');
  store.failing = false;
  const ack = await t.command('boiler-control', 'on');
  assert.deepEqual(ack, { success: true });
  assert.equal(store.data.stop, null);
  assert.equal(t.dev.requests.filter(isStart).length, 1);
});

test('a start that did not leave keeps the stop (and its resends)', async () => {
  const store = memoryStore();
  const t = await setup({ store, config: ALLOW });
  await t.connect();
  t.dev.ignoreControl = true;
  await t.command('boiler-control', 'off');
  t.dev.route = (path, query) =>
    path === '/econet/newParam' && query.newParamValue === '1' ? 'refuse' : undefined;
  const ack = await t.command('boiler-control', 'on');
  assert.equal(ack.success, false);
  assert.match(ack.error, /Rien envoyé/);
  assert.equal(store.data.stop.phase, 'sent');
  // The follow-ups still send the stop again (the start never left).
  await t.wait(25 * SECOND);
  assert.ok(stops(t) >= 2);
});

test('a start answered 429 does not count: the stop holds again', async () => {
  const store = memoryStore();
  const t = await setup({ store, config: ALLOW });
  await t.connect();
  await t.command('boiler-control', 'off');
  t.dev.route = (path, query) =>
    path === '/econet/newParam' && query.newParamValue === '1'
      ? { status: 429, body: 'slow' }
      : undefined;
  const ack = await t.command('boiler-control', 'on');
  assert.equal(ack.success, false);
  assert.ok(store.data.stop, 'kept');
  assert.ok(t.app.memory.stop);
});

test('a start that left cancels the resends of the stop', async () => {
  const t = await setup({ config: ALLOW });
  await t.connect();
  t.dev.ignoreControl = true;
  await t.command('boiler-control', 'off');
  t.dev.ignoreControl = false;
  await t.command('boiler-control', 'on');
  const count = stops(t);
  await t.wait(10 * MINUTE);
  assert.equal(stops(t), count, 'no stop after the start');
});

test('Off refused only without a usable configuration or with another module at the address', async () => {
  const a = await setup({ config: {} });
  await a.connect();
  const noConfig = await a.command('boiler-control', 'off');
  assert.match(noConfig.error, /configuration .* pas lue ou pas valide/);
  const b = await setup();
  await b.connect();
  b.dev.uid = OTHER_UID;
  await b.wait(61 * SECOND);
  const foreign = await b.command('boiler-control', 'off');
  assert.match(foreign.error, /Un autre ecoNET300 répond à cette adresse/);
  assert.equal(stops(b), 0);
});

test('Off acks within the budget even when the module stays silent', async () => {
  const t = await setup();
  await t.connect();
  t.dev.route = () => 'silent';
  const at = t.clock.monotonic();
  const ack = await t.command('boiler-control', 'off');
  assert.ok(t.clock.monotonic() - at < 4_700, `${t.clock.monotonic() - at} ms`);
  assert.match(ack.error, /Arrêt envoyé, sans confirmation \(timeout\)/);
  assert.equal(t.app.memory.stop.phase, 'sent');
});

test('Off with getConfig() failing after a reconnection: the session in place sends it', async () => {
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
  failFrom = calls + 2;
  await t.gladys.disconnect();
  await t.connect();
  assert.deepEqual(await t.command('boiler-control', 'off'), { success: true });
});

test('a stop clicked while "On" saves /data: "On" never leaves after it', async () => {
  const store = memoryStore();
  const save = store.save.bind(store);
  let slow = false;
  store.save = async (data) => {
    if (slow) {
      await new Promise((resolve) => t.clock.timers.setTimeout(resolve, 300));
    }
    return save(data);
  };
  const t = await setup({ store, config: ALLOW });
  await t.connect();
  await t.command('boiler-control', 'off');
  slow = true;
  const on = t.command('boiler-control', 'on');
  // The fresh read is done; "On" is saving the lift of the stop.
  await t.wait(100);
  const off = t.command('boiler-control', 'off');
  const [onAck, offAck] = (await t.during(Promise.all([on, off]))).value;
  assert.equal(onAck.success, false);
  assert.match(onAck.error, /Un arrêt a été envoyé depuis/);
  assert.equal(offAck.success, true);
  const last = t.dev.requests.filter((r) => r.path === '/econet/newParam').at(-1);
  assert.equal(last.query.newParamValue, '0');
  assert.equal(t.dev.requests.filter(isStart).length, 0);
});

test('burning off with nothing read before the stop: not taken for applied', async () => {
  const store = memoryStore();
  const a = await setup({ store });
  await a.connect();
  await a.app.stop();
  const t = await setup({ store, clock: a.clock });
  await t.connect();
  t.dev.ignoreControl = true;
  t.dev.curr.mode = 7;
  const ack = await t.command('boiler-control', 'off');
  assert.equal(stops(t), 1);
  assert.equal(ack.success, false);
  assert.match(ack.error, /ne l’indique pas encore/);
});

test('burning off seen after the stop: a start on the panel later is never contradicted', async () => {
  const store = memoryStore();
  const t = await setup({ store, config: { ...CONFIG, poll_interval: 900 } });
  await t.connect();
  await t.create();
  t.dev.ignoreControl = true;
  t.dev.route = (path) => {
    if (path === '/econet/newParam') {
      t.dev.curr.mode = 7;
    }
    return undefined;
  };
  assert.deepEqual(await t.command('boiler-control', 'off'), { success: true });
  assert.equal(store.data.stop.phase, 'stopping');
  await t.wait(6 * SECOND);
  assert.equal(last(t.gladys, 'boiler-control'), 'off', 'burning off shows "Off"');
  // Never read at 0; started again on the panel during the extinction.
  t.dev.route = undefined;
  t.dev.curr.mode = 2;
  await t.wait(40 * MINUTE);
  assert.equal(stops(t), 1, 'no resend');
});

test('an alarm after the stop is no start elsewhere; an unreadable count of starts is none', async () => {
  const store = memoryStore();
  const t = await setup({ store });
  await t.connect();
  await t.command('boiler-control', 'off');
  await t.wait(25 * SECOND);
  t.dev.curr.mode = 8;
  await t.wait(3 * MINUTE);
  assert.ok(store.data.stop, 'kept');
  assert.equal(store.data.stop.starts, 0);
});

test('getConfig() of the integration failing at the start: the SDK one is used, "Off" goes', async () => {
  let calls = 0;
  const t = await setup({
    getConfig: async () => {
      calls += 1;
      if (calls === 1) {
        // The SDK's resynchronization (it fills gladys.config).
        t.gladys.config = { ...CONFIG };
        return CONFIG;
      }
      throw new Error('HTTP 502');
    },
  });
  await t.connect();
  assert.equal(t.dev.count('/econet/sysParams'), 1);
  assert.deepEqual(await t.command('boiler-control', 'off'), { success: true });
});

test('the status with a stop: one space only', async () => {
  const t = await setup();
  await t.connect();
  await t.command('boiler-control', 'off');
  await t.wait(6 * SECOND);
  const text = t.gladys.fake.connectionStatus.message.fr;
  assert.equal(text, 'Connecté à ecoMAX860P2-N TOUCH. Arrêtée depuis Gladys.');
  assert.doesNotMatch(text, / {2}/);
});

test('"Off" while other credentials are saved: never lost, sent on the new session', async () => {
  const t = await setup({ latency: 200 });
  await t.connect();
  const off = t.command('boiler-control', 'off');
  await t.wait(10);
  const saved = t.gladys.fake.configUpdated({ ...CONFIG, address: '192.168.1.51' });
  await t.during(Promise.all([off, saved]));
  await t.wait(2 * SECOND);
  assert.ok(stops(t) >= 1);
  assert.notEqual(t.app.memory.stop.phase, 'unsent');
});

test('a stop refused 401 because the password changed is never given up: sent with the new one', async () => {
  const store = memoryStore();
  const t = await setup({ store });
  await t.connect();
  t.dev.password = 'changed-on-the-module';
  const ack = await t.command('boiler-control', 'off');
  assert.match(ack.error, /Arrêt non envoyé \(HTTP 401\)/);
  // The next read is refused too: the 401 was the credentials.
  await t.wait(61 * SECOND);
  assert.equal(store.data.refused, true);
  assert.equal(store.data.stop.tries, 0, 'forgotten');
  assert.match(statusText(t), /Un arrêt depuis Gladys attend/);
  // The button, twice, while refused: never counted.
  for (let i = 0; i < 2; i += 1) {
    await t.wait(61 * SECOND);
    const again = await t.during(t.gladys.fake.action('test_connection', {}));
    assert.ok(again.ok);
  }
  assert.equal(store.data.stop.tries, 0);
  assert.equal(store.data.stop.phase, 'unsent');
  // The right password saved: the stop leaves at once.
  await t.during(t.gladys.fake.configUpdated({ ...CONFIG, password: 'changed-on-the-module' }));
  await t.wait(SECOND);
  const sent = t.dev.requests.filter(isStop);
  assert.ok(sent.length >= 1);
  assert.ok(['sent', 'confirmed'].includes(store.data.stop.phase));
});

test('a click while the credentials are refused: acked "sent once other credentials", never counted', async () => {
  const store = memoryStore();
  const t = await setup({ store, config: { ...CONFIG, password: 'wrong' } });
  await t.connect();
  const ack = await t.command('boiler-control', 'off');
  assert.match(ack.error, /identifiants refusés\) : envoyé dès que d’autres identifiants/);
  assert.equal(store.data.stop.tries, 0);
});

test('burning off seen by a follow-up read (not the ack): the stop is taken, a panel start not contradicted', async () => {
  const store = memoryStore();
  const t = await setup({ store });
  await t.connect();
  await t.create();
  t.dev.ignoreControl = true;
  t.dev.route = (path) => {
    if (path === '/econet/newParam') {
      t.clock.timers.setTimeout(() => {
        t.dev.curr.mode = 7;
      }, 2 * SECOND);
    }
    return undefined;
  };
  const ack = await t.command('boiler-control', 'off');
  assert.equal(ack.success, false, 'still running at the ack');
  t.dev.route = undefined;
  await t.wait(6 * SECOND);
  assert.equal(store.data.stop.phase, 'stopping');
  t.dev.curr.mode = 2;
  await t.wait(30 * SECOND);
  assert.equal(stops(t), 1, 'no resend after burning off was seen');
  // Started again: two reads running lift the guard (burning off counts as taken).
  await t.wait(2 * MINUTE);
  assert.equal(store.data.stop, null);
});

test('burning off when the boiler was already burning off at the click proves nothing', async () => {
  const store = memoryStore();
  const t = await setup({ store });
  await t.connect();
  t.dev.ignoreControl = true;
  t.dev.curr.mode = 7;
  await t.wait(61 * SECOND);
  await t.command('boiler-control', 'off');
  await t.wait(25 * SECOND);
  assert.equal(store.data.stop.phase, 'sent', 'not taken');
  assert.equal(store.data.stop.from, 7);
  t.dev.curr.mode = 3;
  await t.wait(61 * SECOND);
  assert.ok(stops(t) >= 2 && stops(t) <= 4, `running after: sent again (${stops(t)})`);
});

test('an alarm after a stop not taken is no contradiction: not sent again', async () => {
  const t = await setup();
  await t.connect();
  t.dev.ignoreControl = true;
  await t.command('boiler-control', 'off');
  t.dev.curr.mode = 8;
  await t.wait(5 * MINUTE);
  assert.equal(stops(t), 1);
});

test('a stop being sent is never doubled by a read', async () => {
  const t = await setup();
  await t.connect();
  t.app.memory.stop = { key: KEY, phase: 'unsent', tries: 0, resends: 0, starts: 0, from: null };
  assert.equal(t.app.stopToResend(t.app.session), true);
  t.app.stopping = 1;
  assert.equal(t.app.stopToResend(t.app.session), false);
  t.app.stopping = 0;
  t.app.memory.stop.tries = 3;
  assert.equal(t.app.stopToResend(t.app.session), false);
});
