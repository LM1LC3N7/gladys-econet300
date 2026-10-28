import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  identityKey,
  limitsOf,
  parseJson,
  systemOf,
  valuesOf,
  writeResultOf,
} from '../src/model.js';
import { CURR, EDITS, UID } from './fixtures/econet.js';

test('sysParams: identity hashed, alarms running only, secrets never kept', () => {
  const system = systemOf({
    uid: UID,
    controllerID: 'ecoMAX810P-L TOUCH',
    softVer: '3.2.3879',
    password: 'p',
    key: 'k',
    ssid: 'wifi',
    alarms: [
      { code: '7', fromDate: '2026-10-28 09:00:00', toDate: null },
      { code: 2, fromDate: '2026-10-27 09:00:00', toDate: '2026-10-27 09:05:00' },
      { code: 'x', toDate: null },
    ],
  });
  assert.deepEqual(system, {
    key: identityKey(UID),
    model: 'ecoMAX810P-L TOUCH',
    softVer: '3.2.3879',
    alarms: [{ code: 7, from: '2026-10-28 09:00:00' }],
  });
  assert.match(system.key, /^[0-9a-f]{16}$/);
  assert.equal(systemOf({ uid: null }).key, undefined, 'a uid not given is unknown');
  assert.equal(systemOf({ uid: 'a b' }).key, undefined);
  assert.equal(systemOf({ uid: UID }).alarms, undefined, 'no list: no alarm feature');
  assert.equal(systemOf([]), undefined);
  assert.equal(systemOf({ controllerID: 'x\u0000y\u2028z' }).model, 'x y z');
});

test('regParams: numbers only, plausible only, never a text as 0', () => {
  const values = valuesOf({
    curr: { ...CURR, tempCO: '62', tempCWU: true, tempFlueGas: 900, mode: 3.5 },
  });
  assert.equal(values.temperatures.has('boiler-temperature'), false);
  assert.equal(values.temperatures.has('dhw-temperature'), false);
  assert.equal(values.temperatures.has('flue-gas-temperature'), false);
  assert.equal(values.mode, undefined);
  assert.equal(values.setpoints.get('dhw-setpoint'), 45);
  assert.equal(values.fuel, 66);
  assert.equal(valuesOf({}), undefined);
  assert.equal(valuesOf({ curr: [] }), undefined);
  const proto = valuesOf(JSON.parse('{"curr":{"__proto__":{"tempCO":50}}}'));
  assert.equal(proto.temperatures.size, 0, 'no inherited key');
});

test('the bounds: whole numbers of the setpoint keys only', () => {
  const limits = limitsOf({ data: EDITS });
  assert.deepEqual(
    [...limits],
    [
      ['1280', { min: 55, max: 80 }],
      ['1281', { min: 20, max: 70 }],
    ],
  );
  assert.equal(limitsOf({ data: { 1281: { min: 20.5, max: 60 } } }).size, 0);
  assert.equal(limitsOf({ data: { 1281: { min: 70, max: 60 } } }).size, 0);
  assert.equal(limitsOf({}), undefined);
});

test('JSON: plain, repaired when the module doubles the quotes, else nothing', () => {
  assert.deepEqual(parseJson('{"a":1}'), { a: 1 });
  assert.deepEqual(parseJson('{"name":""Pellet""}'), { name: 'Pellet' });
  assert.equal(parseJson('<html>'), undefined);
  assert.equal(parseJson(''), undefined);
  assert.equal(writeResultOf({ result: 'OK' }), true);
  assert.equal(writeResultOf({ result: 'NOTYPE' }), 'NOTYPE');
  assert.equal(writeResultOf({}), 'none');
});
