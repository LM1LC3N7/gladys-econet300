// -----------------------------------------------------------------------------
// The answers of the module, checked and reduced (pure). Only the fields used
// are kept: sysParams also holds the Wi-Fi name, the econet24.com key and
// passwords, which are never kept, logged nor published. Untrusted input:
// own keys only (`Object.hasOwn`), strict types, bounded lists.
// -----------------------------------------------------------------------------

import { createHash } from 'node:crypto';
import { LIMITS, MODE_MAX, SETPOINTS, TEMPERATURES } from './constants.js';

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const own = (object, key) =>
  isObject(object) && Object.hasOwn(object, key) ? object[key] : undefined;

/**
 * The JSON of an answer. Some modules double the quotes inside texts
 * (`""text""`): the reference repairs them; here too, only when the plain
 * parse fails.
 */
export function parseJson(text) {
  if (typeof text !== 'string' || text.length === 0) {
    return undefined;
  }
  try {
    return JSON.parse(text);
  } catch {
    try {
      return JSON.parse(text.replace(/""([^"\n]{1,200})""/g, '"$1"'));
    } catch {
      return undefined;
    }
  }
}

/** A printable text of at most `max` characters, else undefined. */
function textOf(value, max = LIMITS.nameLength) {
  if (typeof value !== 'string') {
    return undefined;
  }
  // eslint-disable-next-line no-control-regex
  const clean = value.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, ' ').trim();
  return clean === '' ? undefined : clean.slice(0, max);
}

const UID = /^[\x21-\x7e]{1,64}$/;

/**
 * The stable key of a module, from its uid: a hash (the uid itself is also
 * the identifier of the module on econet24.com, never published).
 */
export const identityKey = (uid) =>
  createHash('sha256').update(`econet300:${uid}`).digest('hex').slice(0, 16);

/**
 * sysParams -> { key, model, softVer, alarms } where `key` is undefined when
 * the uid is missing or unreadable (a module still starting reports null):
 * the identity is then unknown, never "another module". `alarms`: the codes
 * of the alarms still running (toDate null), newest first; undefined when
 * the log is not a list.
 */
export function systemOf(data) {
  if (!isObject(data)) {
    return undefined;
  }
  const uid = own(data, 'uid');
  const key = typeof uid === 'string' && UID.test(uid) ? identityKey(uid) : undefined;
  const log = own(data, 'alarms');
  let alarms;
  if (Array.isArray(log)) {
    alarms = [];
    for (const entry of log.slice(0, LIMITS.alarms)) {
      const code = own(entry, 'code');
      const number = typeof code === 'string' && /^\d{1,4}$/.test(code) ? Number(code) : code;
      if (!Number.isSafeInteger(number) || number < 0 || number > 9999) {
        continue;
      }
      const to = own(entry, 'toDate');
      if (to === null || to === undefined || to === '') {
        alarms.push({ code: number, from: textOf(own(entry, 'fromDate'), 19) });
      }
    }
  }
  return {
    key,
    model: textOf(own(data, 'controllerID')),
    softVer: textOf(own(data, 'softVer'), 30),
    alarms,
  };
}

/** A finite number of the answer (never a text, a boolean, null or ''). */
const finite = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : undefined);

/**
 * regParams -> { temperatures: Map(role -> °C), setpoints: Map(role -> °C),
 * mode, fuel } (only the values present and plausible), or undefined when
 * the answer has no `curr` object.
 */
export function valuesOf(data) {
  const curr = own(data, 'curr');
  if (!isObject(curr)) {
    return undefined;
  }
  const temperatures = new Map();
  for (const { role, field, min, max } of TEMPERATURES) {
    const value = finite(own(curr, field));
    if (value !== undefined && value >= min && value <= max) {
      temperatures.set(role, Math.round(value * 10) / 10);
    }
  }
  const setpoints = new Map();
  for (const [role, { field }] of Object.entries(SETPOINTS)) {
    const value = finite(own(curr, field));
    if (value !== undefined && value >= 0 && value <= 100) {
      setpoints.set(role, value);
    }
  }
  const mode = own(curr, 'mode');
  const fuel = finite(own(curr, 'fuelLevel'));
  return {
    temperatures,
    setpoints,
    mode: Number.isSafeInteger(mode) && mode >= 0 && mode <= MODE_MAX ? mode : undefined,
    fuel: fuel !== undefined && fuel >= 0 && fuel <= 100 ? Math.round(fuel) : undefined,
  };
}

/**
 * rmCurrentDataParamsEdits -> Map(key -> { min, max }) of the setpoint keys
 * with whole bounds, or undefined when the answer has no `data` object.
 */
export function limitsOf(data) {
  const list = own(data, 'data');
  if (!isObject(list)) {
    return undefined;
  }
  const limits = new Map();
  for (const { key } of Object.values(SETPOINTS)) {
    const entry = own(list, key);
    const min = own(entry, 'min');
    const max = own(entry, 'max');
    if (Number.isSafeInteger(min) && Number.isSafeInteger(max) && min <= max) {
      limits.set(key, { min, max });
    }
  }
  return limits;
}

/** The answer of a write: true for "OK", else the result text (bounded). */
export function writeResultOf(data) {
  const result = own(data, 'result');
  if (result === 'OK') {
    return true;
  }
  return textOf(result, 30) ?? 'none';
}
