// -----------------------------------------------------------------------------
// "On" and the setpoints: behind the option, decided on a fresh read, bounded
// (hot water 65 °C at most), success only on a read showing the value.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { memoryStore } from '../src/store.js';
import { CONFIG, OTHER_UID } from './fixtures/econet.js';
import { DEVICE, F, MINUTE, SECOND, last, setup } from './helpers/app.js';

const ALLOW = { ...CONFIG, allow_commands: true };
const writes = (t, path) => t.dev.requests.filter((r) => r.path === path);
const setpoints = (t) => writes(t, '/econet/rmCurrNewParam');

test('the option is off by default: "On" and the setpoints refused, nothing sent', async () => {
  const t = await setup();
  await t.connect();
  await t.create();
  t.dev.curr.mode = 0;
  for (const [role, value] of [
    ['boiler-control', 'on'],
    ['dhw-setpoint', 50],
    ['boiler-setpoint', 70],
  ]) {
    const ack = await t.command(role, value);
    assert.equal(ack.success, false);
    assert.match(ack.error, /Les commandes sont désactivées/);
  }
  assert.equal(t.dev.writes().length, 0);
  assert.equal(t.dev.count('/econet/sysParams'), 1, 'not even a read');
});

test('read-only features refuse any command', async () => {
  const t = await setup({ config: ALLOW });
  await t.connect();
  for (const role of ['boiler-temperature', 'operation', 'alarms', 'status', 'fuel-level']) {
    const ack = await t.command(role, 1);
    assert.match(ack.error, /lecture seule/);
  }
  const bad = await t.command('boiler-control', 'toggle');
  assert.match(bad.error, /Choisissez « Marche » ou « Arrêt »/);
});

test('"On" with the option: a fresh read, BOILER_CONTROL=1, success once read running', async () => {
  const t = await setup({ config: ALLOW });
  await t.connect();
  await t.create();
  t.dev.curr.mode = 0;
  const before = t.dev.requests.length;
  const ack = await t.command('boiler-control', 'on');
  assert.deepEqual(ack, { success: true });
  const sent = t.dev.requests.slice(before).map((r) => r.path);
  assert.deepEqual(sent, [
    '/econet/sysParams',
    '/econet/regParams',
    '/econet/newParam',
    '/econet/regParams',
  ]);
  assert.equal(t.dev.requests.at(-2).query.newParamValue, '1');
  await t.wait(6 * SECOND);
  assert.equal(last(t.gladys, 'boiler-control'), 'on');
});

test('"On" while running and no stop of ours: nothing sent', async () => {
  const t = await setup({ config: ALLOW });
  await t.connect();
  assert.deepEqual(await t.command('boiler-control', 'on'), { success: true });
  assert.equal(t.dev.writes().length, 0);
});

test('hot water: 65 °C at most whatever the controller allows (70 here), whole degrees', async () => {
  const t = await setup({ config: ALLOW });
  await t.connect();
  await t.create();
  for (const [value, error] of [
    [66, /Hors limites : de 20 à 65 °C/],
    [70, /Hors limites : de 20 à 65 °C/],
    [55.5, /Degrés entiers/],
    ['abc', /Ce n’est pas un nombre/],
    ['', /Ce n’est pas un nombre/],
    [10, /Hors limites/],
  ]) {
    const ack = await t.command('dhw-setpoint', value);
    assert.match(ack.error, error, String(value));
  }
  assert.equal(setpoints(t).length, 0);
  assert.deepEqual(await t.command('dhw-setpoint', 65), { success: true });
  assert.deepEqual(setpoints(t).at(-1).query, { newParamKey: '1281', newParamValue: '65' });
  await t.wait(6 * SECOND);
  assert.equal(last(t.gladys, 'dhw-setpoint'), 65);
});

test('hot water: the configured ceiling and a lower maximum of the controller win', async () => {
  const t = await setup({ config: { ...ALLOW, max_dhw: 55 } });
  await t.connect();
  assert.match((await t.command('dhw-setpoint', 56)).error, /de 20 à 55 °C/);
  // A ceiling typed above 65 °C is 65 °C.
  await t.during(t.gladys.fake.configUpdated({ ...ALLOW, max_dhw: 90 }));
  t.dev.edits[1281].max = 60;
  // The bounds come from the last periodic read (settings, not states).
  await t.wait(61 * SECOND);
  assert.match((await t.command('dhw-setpoint', 62)).error, /de 20 à 60 °C/);
  assert.equal(setpoints(t).length, 0);
  t.dev.edits[1281].max = 99;
  await t.wait(61 * SECOND);
  assert.match((await t.command('dhw-setpoint', 66)).error, /de 20 à 65 °C/);
});

test('boiler setpoint: within the bounds of the controller read now', async () => {
  const t = await setup({ config: ALLOW });
  await t.connect();
  await t.create();
  assert.match((await t.command('boiler-setpoint', 50)).error, /de 55 à 80 °C/);
  assert.match((await t.command('boiler-setpoint', 95)).error, /de 20 à 90 °C/);
  assert.deepEqual(await t.command('boiler-setpoint', 70), { success: true });
  assert.deepEqual(setpoints(t).at(-1).query, { newParamKey: '1280', newParamValue: '70' });
});

test('no bounds from the controller: refused, nothing sent', async () => {
  const t = await setup({ config: ALLOW });
  await t.connect();
  t.dev.route = (path) =>
    path === '/econet/rmCurrentDataParamsEdits' ? { status: 404, body: 'no' } : undefined;
  await t.wait(61 * SECOND);
  const ack = await t.command('dhw-setpoint', 50);
  assert.match(ack.error, /ne donne pas les bornes de cette consigne/);
  delete t.dev.edits[1281];
  t.dev.route = undefined;
  await t.wait(61 * SECOND);
  assert.match((await t.command('dhw-setpoint', 50)).error, /ne donne pas les bornes/);
  assert.equal(setpoints(t).length, 0);
});

test('the same value: nothing sent; again under the guard of a write not yet seen: sent', async () => {
  const t = await setup({ config: ALLOW });
  await t.connect();
  assert.deepEqual(await t.command('dhw-setpoint', 45), { success: true });
  assert.equal(setpoints(t).length, 0);
  t.dev.applyDelay = 30 * SECOND;
  const first = await t.command('dhw-setpoint', 50);
  assert.match(first.error, /Envoyée et acceptée, pas encore appliquée/);
  // Back to 45 before 50 shows: the read still says 45, but it is sent.
  const back = await t.command('dhw-setpoint', 45);
  assert.equal(back.success, false, 'equal to the value before: not confirmed');
  assert.equal(setpoints(t).length, 2);
});

test('applied late: "not applied yet", then the follow-up reads publish it', async () => {
  const t = await setup({ config: ALLOW });
  await t.connect();
  await t.create();
  t.dev.applyDelay = 8 * SECOND;
  const ack = await t.command('dhw-setpoint', 55);
  assert.match(ack.error, /pas encore appliquée/);
  await t.wait(25 * SECOND);
  assert.equal(last(t.gladys, 'dhw-setpoint'), 55);
  assert.ok(t.dev.count('/econet/regParams') >= 4, 'follow-up reads at 5 s and 20 s');
});

test('the option turned off while the command waits: nothing sent', async () => {
  const t = await setup({ config: ALLOW, latency: 400 });
  await t.connect();
  const pending = t.command('dhw-setpoint', 50);
  await t.wait(500);
  await t.gladys.fake.configUpdated({ ...CONFIG, allow_commands: false });
  const ack = await pending;
  assert.match(ack.error, /désactivées/);
  assert.equal(setpoints(t).length, 0);
});

test('the ceiling lowered during the fresh read: checked right before the request leaves', async () => {
  const t = await setup({ config: ALLOW, latency: 300 });
  await t.connect();
  const pending = t.command('dhw-setpoint', 60);
  await t.wait(400);
  await t.gladys.fake.configUpdated({ ...ALLOW, max_dhw: 50 });
  const ack = await pending;
  assert.match(ack.error, /de 20 à 50 °C/);
  assert.equal(setpoints(t).length, 0);
});

test('a scene: "On", boiler and hot water setpoints at once, all set within their budget', async () => {
  const t = await setup({ config: ALLOW, latency: 150 });
  await t.connect();
  t.dev.curr.mode = 0;
  const device = { external_id: DEVICE };
  const send = (role, value) => t.gladys.fake.setValue(device, { external_id: F(role) }, value);
  const all = Promise.all([
    send('boiler-control', 'on'),
    send('boiler-setpoint', 70),
    send('dhw-setpoint', 55),
  ]);
  const outcome = await t.during(all, 6 * SECOND, 10);
  assert.deepEqual(outcome.value, [{ success: true }, { success: true }, { success: true }]);
  assert.equal(t.dev.peak, 1);
});

test('a 5xx on a write: sent, without confirmation; the pause holds the next ones', async () => {
  const t = await setup({ config: ALLOW });
  await t.connect();
  t.dev.route = (path) =>
    path === '/econet/rmCurrNewParam' ? { status: 500, body: 'x' } : undefined;
  const ack = await t.command('dhw-setpoint', 50);
  assert.match(ack.error, /Envoyée, sans confirmation \(HTTP 500\)/);
  t.dev.route = undefined;
  assert.match((await t.command('dhw-setpoint', 51)).error, /rien envoyé pendant la pause/);
});

test('a write the module refuses (result not OK): said, no guard', async () => {
  const t = await setup({ config: ALLOW });
  await t.connect();
  t.dev.route = (path) =>
    path === '/econet/rmCurrNewParam' ? { status: 200, body: '{"result":"NOTYPE"}' } : undefined;
  const ack = await t.command('dhw-setpoint', 50);
  assert.match(ack.error, /a refusé la commande \(NOTYPE\)/);
  assert.equal(t.app.guards.size, 0);
});

test('a silent module: "nothing sent" when the fresh read does not answer, ack within 5 s', async () => {
  const t = await setup({ config: ALLOW });
  await t.connect();
  t.dev.route = () => 'silent';
  const at = t.clock.monotonic();
  const ack = await t.command('dhw-setpoint', 50);
  assert.ok(t.clock.monotonic() - at < 4_500);
  assert.match(ack.error, /n’a pas répondu à temps : rien envoyé/);
  assert.equal(setpoints(t).length, 0);
});

test('another module answers at the address: refused, nothing written', async () => {
  const t = await setup({ config: ALLOW });
  await t.connect();
  t.dev.uid = OTHER_UID;
  const ack = await t.command('dhw-setpoint', 50);
  assert.match(ack.error, /Un autre ecoNET300 répond à cette adresse/);
  t.dev.uid = null;
  assert.match(
    (await t.command('dhw-setpoint', 50)).error,
    /identité de l’ecoNET300 n’a pas pu être lue/,
  );
  assert.equal(setpoints(t).length, 0);
});

test('refused credentials: commands refused at once (only "Off" tries)', async () => {
  const t = await setup({ config: { ...ALLOW, password: 'bad' } });
  await t.connect();
  const ack = await t.command('dhw-setpoint', 50);
  assert.match(ack.error, /a refusé le nom d’utilisateur ou le mot de passe/);
  assert.equal(t.dev.count('/econet/sysParams'), 1);
  void MINUTE;
});

test('the ceiling lowered while the connection opens: checked right before the request leaves', async () => {
  const t = await setup({ config: ALLOW });
  await t.connect();
  t.dev.connectDelay = 300;
  // The ceiling lowered once the write starts to connect, before it leaves.
  t.dev.onConnect = (path) => {
    if (path === '/econet/rmCurrNewParam') {
      void t.gladys.fake.configUpdated({ ...ALLOW, max_dhw: 50 });
    }
  };
  const ack = await t.command('dhw-setpoint', 60);
  assert.match(ack.error, /de 20 à 50 °C/);
  assert.equal(setpoints(t).length, 0);
});

test('bounds of the controller not whole: the high bound rounded down', async () => {
  const t = await setup({ config: ALLOW });
  await t.connect();
  assert.deepEqual(t.app.rangeOf('dhw-setpoint', { min: 20.2, max: 60.9 }), { low: 21, high: 60 });
  assert.deepEqual(t.app.rangeOf('dhw-setpoint', { min: 0, max: 99.9 }), { low: 20, high: 65 });
});

test('a 403 on a write refuses that command only: the reads go on, no print in /data', async () => {
  const store = memoryStore();
  const t = await setup({ store, config: ALLOW });
  await t.connect();
  t.dev.route = (path) =>
    path === '/econet/rmCurrNewParam' ? { status: 403, body: 'no' } : undefined;
  const ack = await t.command('dhw-setpoint', 50);
  assert.match(ack.error, /a refusé la commande \(HTTP 403\)/);
  await t.wait(10 * MINUTE);
  assert.ok(t.dev.count('/econet/sysParams') >= 10);
  assert.equal(store.data.refused, false);
  assert.equal(store.data.fp, '');
  assert.equal(t.gladys.fake.connectionStatus.connected, true);
});

test('/data unreadable: "On" and the setpoints refused, nothing written', async () => {
  const t = await setup({ config: ALLOW, store: memoryStore(null, { unreadable: true }) });
  await t.connect();
  t.dev.curr.mode = 0;
  for (const [role, value] of [
    ['dhw-setpoint', 50],
    ['boiler-setpoint', 70],
    ['boiler-control', 'on'],
  ]) {
    const ack = await t.command(role, value);
    assert.match(ack.error, /\/data ne peut être lu ou écrit/, role);
  }
  assert.equal(t.dev.writes().length, 0);
});

test('the option turned off while the write connects: checked right before it leaves', async () => {
  const t = await setup({ config: ALLOW });
  await t.connect();
  t.dev.connectDelay = 300;
  t.dev.onConnect = (path) => {
    if (path === '/econet/rmCurrNewParam') {
      void t.gladys.fake.configUpdated({ ...CONFIG, allow_commands: false });
    }
  };
  const ack = await t.command('dhw-setpoint', 50);
  assert.match(ack.error, /désactivées/);
  assert.equal(setpoints(t).length, 0);
});

for (const latency of [500, 700, 900]) {
  test(`a scene of 3 commands on a module answering in ${latency} ms: all sent`, async () => {
    const t = await setup({ config: ALLOW });
    await t.connect();
    t.dev.curr.mode = 0;
    t.dev.latency = latency;
    const device = { external_id: DEVICE };
    const send = (role, value) => t.gladys.fake.setValue(device, { external_id: F(role) }, value);
    const acks = [send('boiler-control', 'on')];
    await new Promise((resolve) => setImmediate(resolve));
    acks.push(send('boiler-setpoint', 70));
    await new Promise((resolve) => setImmediate(resolve));
    acks.push(send('dhw-setpoint', 55));
    const outcome = await t.during(Promise.all(acks), 6 * SECOND, 10);
    assert.equal(t.dev.requests.filter((r) => r.path === '/econet/newParam').length, 1);
    assert.equal(setpoints(t).length, 2);
    if (latency <= 700) {
      assert.deepEqual(outcome.value, [{ success: true }, { success: true }, { success: true }]);
    }
    assert.equal(t.dev.peak, 1);
  });
}

test('a setpoint alone on a module answering in 900 ms: set and confirmed', async () => {
  const t = await setup({ config: ALLOW });
  await t.connect();
  t.dev.latency = 900;
  assert.deepEqual(await t.command('dhw-setpoint', 50), { success: true });
});
