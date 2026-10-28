// -----------------------------------------------------------------------------
// What must survive a restart, in /data (the only writable place of the
// container), in econet300-state.json, readable by the container user only
// (0600):
//   - `pausedUntil`: the end of a pause after an HTTP 429 or 5xx;
//   - `refused`: the module refused the user name or the password (HTTP 401
//     or 403): a stop, no automatic retry. Saving other credentials or a
//     successful "Test the connection" lifts it;
//   - `fp`: while refused only, 8 bits of a salted scrypt fingerprint of the
//     refused address, user name and password: enough for a restart to tell
//     (almost always) whether other credentials were typed meanwhile, far
//     too little to test a password with. Erased by the first success;
//   - `lastReadAt`: when the last read began (written before it leaves, at
//     most once a minute, or once an interval when shorter), so that a
//     restart loop never reads faster than the interval;
//   - `stop`: the stop of the boiler sent from Gladys, until a click on
//     "On" (with the option) or a start seen twice in a row after the stop
//     was seen taken (see src/app.js): { key (the module), phase
//     ('unsent', 'sent', 'stopping' = burning off seen, 'confirmed' = off
//     seen), tries (refusals 401/403 of the stop with credentials the reads
//     accept), resends, starts, from (the state read at the click) }.
// Never a secret in clear. Read back bounded (a clock moved or a file edited
// by hand never gives a pause longer than its maximum; a date in the future
// is invalid), only known keys of the expected shape (never an inherited or
// `__proto__` key).
// -----------------------------------------------------------------------------

import { randomBytes, scryptSync } from 'node:crypto';
import { readFile, rename, writeFile } from 'node:fs/promises';
import { TIMINGS } from './constants.js';

export const STATE_FILE = '/data/econet300-state.json';

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const own = (object, key) =>
  isObject(object) && Object.hasOwn(object, key) ? object[key] : undefined;

/**
 * The file store. `load()` resolves the parsed file, null when there is no
 * file, and rejects when the file exists but cannot be read or parsed (an
 * unreadable /data is never taken for an empty one).
 */
export function fileStore(path = STATE_FILE) {
  // One write at a time: two saves never share the temporary file.
  let chain = Promise.resolve();
  return {
    async load() {
      let text;
      try {
        text = await readFile(path, 'utf8');
      } catch (err) {
        if (err?.code === 'ENOENT') {
          return null;
        }
        throw new Error('unreadable', { cause: err });
      }
      if (text.length > 4096) {
        throw new Error('unreadable');
      }
      return JSON.parse(text);
    },
    save(data) {
      const text = JSON.stringify(data);
      const write = chain.then(async () => {
        const temporary = `${path}.tmp`;
        await writeFile(temporary, text, { mode: 0o600 });
        await rename(temporary, path);
      });
      chain = write.catch(() => {});
      return write;
    },
  };
}

/** For the tests: the same JSON round trip as the file; `failing` refuses every save. */
export function memoryStore(initial = null, { failing = false, unreadable = false } = {}) {
  return {
    data: initial === null ? null : JSON.parse(JSON.stringify(initial)),
    saves: 0,
    failing,
    unreadable,
    async load() {
      if (this.unreadable) {
        throw new Error('unreadable');
      }
      return this.data === null ? null : JSON.parse(JSON.stringify(this.data));
    },
    async save(data) {
      if (this.failing) {
        throw new Error('EROFS');
      }
      this.data = JSON.parse(JSON.stringify(data));
      this.saves += 1;
    },
  };
}

const KEY = /^[0-9a-f]{16}$/;
const PHASES = new Set(['unsent', 'sent', 'stopping', 'confirmed']);
const count = (value, max) =>
  Number.isSafeInteger(value) && value >= 0 ? Math.min(value, max) : max;

/** A past time, else 0: a time ahead of the clock is invalid. */
const readTime = (value, now) => (Number.isFinite(value) && value > 0 && value <= now ? value : 0);

function readStop(raw) {
  const key = own(raw, 'key');
  const phase = own(raw, 'phase');
  if (typeof key !== 'string' || !KEY.test(key) || !PHASES.has(phase)) {
    return null;
  }
  return {
    key,
    phase,
    // A count that cannot be read counts as spent: never more sends than allowed.
    // An unreadable count of refusals is none: a stop never left is never
    // given up on a guess.
    tries:
      Number.isSafeInteger(own(raw, 'tries')) && own(raw, 'tries') >= 0
        ? Math.min(own(raw, 'tries'), TIMINGS.stopResends)
        : 0,
    resends: count(own(raw, 'resends'), TIMINGS.stopResends),
    // An unreadable count of starts is none (one read never lifts the guard).
    starts: Number.isSafeInteger(own(raw, 'starts')) && own(raw, 'starts') === 1 ? 1 : 0,
    // The state read recently before it left, or running since (0 to 26),
    // else unknown.
    from:
      Number.isSafeInteger(own(raw, 'from')) && own(raw, 'from') >= 0 && own(raw, 'from') <= 26
        ? own(raw, 'from')
        : null,
  };
}

/** The persisted state, repaired and bounded against `now` (wall clock). */
export function normalizeMemory(raw, now) {
  const pausedUntil = own(raw, 'pausedUntil');
  const salt = own(raw, 'salt');
  const refused = own(raw, 'refused') === true;
  const fp = own(raw, 'fp');
  return {
    pausedUntil:
      Number.isFinite(pausedUntil) && pausedUntil > now
        ? Math.min(pausedUntil, now + TIMINGS.pauseMax)
        : 0,
    salt:
      typeof salt === 'string' && /^[0-9a-f]{32}$/.test(salt)
        ? salt
        : randomBytes(16).toString('hex'),
    refused,
    // A refusal without a readable fingerprint is kept (never lifted by guess).
    fp: refused && typeof fp === 'string' && /^[0-9a-f]{2}$/.test(fp) ? fp : '',
    lastReadAt: readTime(own(raw, 'lastReadAt'), now),
    stop: readStop(own(raw, 'stop')),
  };
}

export const serializeMemory = ({ pausedUntil, salt, refused, fp, lastReadAt, stop }) => ({
  pausedUntil,
  salt,
  refused,
  fp: refused ? fp : '',
  lastReadAt,
  stop: stop
    ? {
        key: stop.key,
        phase: stop.phase,
        tries: stop.tries,
        resends: stop.resends,
        starts: stop.starts,
        from: stop.from ?? null,
      }
    : null,
});

/**
 * 8 bits of the salted fingerprint of refused credentials: one chance in
 * 256 that other credentials look the same (then the button lifts it),
 * and no way to test a password against it.
 */
export const refusalPrint = (salt, config) =>
  scryptSync(
    `${config.host}:${config.port}\n${config.username}\n${config.password}`,
    `${salt}:econet300`,
    16,
  )
    .toString('hex')
    .slice(0, 2);
