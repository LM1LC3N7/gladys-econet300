import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  connectionKey,
  dhwCeilingOf,
  normalizeConfig,
  numberOf,
  parseAddress,
} from '../src/config.js';

test('addresses: host or host:port, http only, no special address', () => {
  assert.deepEqual(parseAddress('192.168.1.50'), { host: '192.168.1.50', port: 80 });
  assert.deepEqual(parseAddress(' http://192.168.1.50:8080/ '), {
    host: '192.168.1.50',
    port: 8080,
  });
  assert.deepEqual(parseAddress('ECONET.local'), { host: 'econet.local', port: 80 });
  for (const [raw, problem] of [
    ['', 'noAddress'],
    [undefined, 'noAddress'],
    ['https://192.168.1.50', 'https'],
    ['192.168.1.50:0', 'badAddress'],
    ['192.168.1.50:70000', 'badAddress'],
    ['192.168.001.50', 'badAddress'],
    ['192.168.1', 'badAddress'],
    ['[::1]', 'badAddress'],
    ['a b', 'badAddress'],
    ['host/path', 'badAddress'],
    ['u:p@host', 'badAddress'],
    ['0.0.0.0', 'specialAddress'],
    ['255.255.255.255', 'specialAddress'],
    ['192.168.1.255', 'specialAddress'],
    ['192.168.1.0', 'specialAddress'],
    ['224.0.0.1', 'specialAddress'],
    ['host\r\nx', 'badAddress'],
  ]) {
    assert.equal(parseAddress(raw).problem, problem, String(raw));
  }
});

test('numbers are strict; the hot water ceiling never above 65 °C', () => {
  assert.equal(numberOf(''), undefined);
  assert.equal(numberOf(null), undefined);
  assert.equal(numberOf('12abc'), undefined);
  assert.equal(numberOf(Number.NaN), undefined);
  assert.equal(numberOf(' 55 '), 55);
  assert.equal(dhwCeilingOf(90), 65);
  assert.equal(dhwCeilingOf('70'), 65);
  assert.equal(dhwCeilingOf(10), 40);
  assert.equal(dhwCeilingOf(55.9), 55);
  assert.equal(dhwCeilingOf(''), 65);
});

test('the configuration: defaults, options off unless strictly true', () => {
  const c = normalizeConfig({
    address: '192.168.1.50',
    username: 'admin',
    password: 'x',
    allow_commands: 'yes',
  });
  assert.equal(c.problem, undefined);
  assert.equal(c.allowCommands, false);
  assert.equal(c.pollInterval, 60);
  assert.equal(c.dhwCeiling, 65);
  assert.equal(c.language, 'fr');
  assert.equal(
    normalizeConfig({ address: '192.168.1.50', username: 'a', password: 'x', allow_commands: true })
      .allowCommands,
    true,
  );
  assert.equal(normalizeConfig({ poll_interval: 5 }).pollInterval, 30);
  assert.equal(normalizeConfig({ poll_interval: 99999 }).pollInterval, 900);
  assert.equal(normalizeConfig({ address: '192.168.1.50', password: 'x' }).problem, 'noUsername');
  assert.equal(
    normalizeConfig({ address: '192.168.1.50', username: 'a', password: 'é€' }).problem,
    'badPassword',
  );
  assert.equal(
    normalizeConfig({ address: '192.168.1.50', username: 'a', password: 'éè' }).problem,
    undefined,
    'Latin-1 is fine',
  );
  const bad = normalizeConfig({ address: 'x y', username: 'a', password: 'secret' });
  assert.equal(bad.password, '', 'never kept when unusable');
  assert.notEqual(
    connectionKey(normalizeConfig({ address: '1.2.3.4', username: 'a', password: 'b' })),
    connectionKey(normalizeConfig({ address: '1.2.3.4', username: 'a', password: 'c' })),
  );
});
