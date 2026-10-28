import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileStore, normalizeMemory, serializeMemory } from '../src/store.js';

const NOW = Date.UTC(2026, 9, 28, 10, 0, 0);

test('read back bounded: pause capped, future dates invalid, unknown keys dropped', () => {
  const m = normalizeMemory(
    {
      pausedUntil: NOW + 30 * 3600_000,
      lastReadAt: NOW + 1000,
      refused: true,
      fp: 'zz',
      extra: 'x',
      stop: { key: 'abc', phase: 'sent' },
    },
    NOW,
  );
  assert.equal(m.pausedUntil, NOW + 6 * 3600_000);
  assert.equal(m.lastReadAt, 0);
  assert.equal(m.refused, true, 'a refusal without a readable print is kept');
  assert.equal(m.fp, '');
  assert.equal(m.stop, null, 'a stop without a valid key is dropped');
  const stop = normalizeMemory(
    { stop: { key: '0123456789abcdef', phase: 'unsent', tries: 'x', resends: -1, starts: 5 } },
    NOW,
  ).stop;
  assert.deepEqual(
    stop,
    { key: '0123456789abcdef', phase: 'unsent', tries: 3, resends: 3, starts: 1 },
    'unreadable counts are spent',
  );
  assert.equal(normalizeMemory(JSON.parse('{"__proto__":{"refused":true}}'), NOW).refused, false);
  assert.deepEqual(Object.keys(serializeMemory(m)).sort(), [
    'fp',
    'lastReadAt',
    'pausedUntil',
    'refused',
    'salt',
    'stop',
  ]);
});

test('the file: 0600, written whole; unreadable is not empty', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'econet300-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'state.json');
  const store = fileStore(path);
  assert.equal(await store.load(), null, 'no file: empty');
  await Promise.all([store.save({ a: 1 }), store.save({ a: 2 })]);
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), { a: 2 });
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  await writeFile(path, '{broken');
  await assert.rejects(store.load());
  await writeFile(path, 'x'.repeat(5000));
  await assert.rejects(store.load());
});
