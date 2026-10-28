// -----------------------------------------------------------------------------
// The ecoNET300 and its boiler -> one Gladys device and its states (pure).
//
// `ext:<selector>:econet300:<key>`: the key is a hash of the uid of the
// module (src/model.js identityKey), stable across addresses and renames;
// the uid itself is never published. The feature roles (the last part of
// their external ids) are published forever: never rename them.
//
// A feature appears once its value was read; a device published again never
// loses a feature: those of the device already created in Gladys are kept as
// they are (the core would mark it `structure_changed`, and "Update" would
// delete the missing feature and its history).
//
// No switch, no writable binary: a "turn everything off" (Google Home,
// Alexa, HomeKit, MCP, `switch.*` scenes) must never reach the boiler. The
// commands are the boiler on/off (`text/select`, "off" protective), the
// boiler setpoint (`thermostat/target-temperature`) and the hot water
// setpoint (`water-heater/target-temperature`, whole degrees), refused unless
// the configuration allows them, except "off" (src/app.js).
//
// Units are those the core lists (DEVICE_FEATURE_UNITS_BY_CATEGORY): °C on
// `temperature-sensor`, `thermostat` and `water-heater`, % on `level-sensor`.
// -----------------------------------------------------------------------------

import {
  DEVICE_FEATURE_CATEGORIES as C,
  DEVICE_FEATURE_TYPES as T,
  DEVICE_FEATURE_UNITS as U,
} from '@gladysassistant/integration-sdk';
import {
  BOILER,
  CONTROL,
  DHW,
  FEATURES as F,
  LIMITS,
  MODE_BURNING_OFF,
  MODE_OFF,
  SELECTOR_TYPE,
  TEMPERATURES,
} from './constants.js';
import {
  ALARM_TEXTS,
  CONTROL_NAMES,
  FEATURE_NAMES,
  MODE_NAMES,
  STATUS_TEXTS,
  deviceName,
  word,
} from './i18n.js';

const sensor = (definition) => ({
  read_only: true,
  has_feedback: false,
  keep_history: true,
  ...definition,
});
const text = sensor({ category: C.TEXT, type: T.TEXT.TEXT, min: 0, max: 0, keep_history: false });
const temperature = sensor({
  category: C.TEMPERATURE_SENSOR,
  type: T.SENSOR.DECIMAL,
  unit: U.CELSIUS,
  min: -60,
  max: 500,
});
const target = (bounds, category, type) => ({
  category,
  type,
  unit: U.CELSIUS,
  // The slider stops at the hard bounds; those of the controller and the
  // configured ceiling refuse within them.
  min: bounds.min,
  max: bounds.max,
  read_only: false,
  has_feedback: true,
  keep_history: true,
});

const TEMPERATURE_ROLES = TEMPERATURES.map((t) => t.role);

/** The features, by role. */
export function definitionOf(role) {
  if (TEMPERATURE_ROLES.includes(role)) {
    return temperature;
  }
  switch (role) {
    case F.BOILER_CONTROL:
      return {
        category: C.TEXT,
        type: T.TEXT.SELECT,
        min: 0,
        max: 0,
        read_only: false,
        has_feedback: true,
        keep_history: false,
      };
    case F.BOILER_SETPOINT:
      return target(BOILER, C.THERMOSTAT, T.THERMOSTAT.TARGET_TEMPERATURE);
    case F.DHW_SETPOINT:
      // The core's hot water setpoint, never a room thermostat: "set every
      // thermostat to 21" must not reach the hot water.
      return target(DHW, C.WATER_HEATER, T.WATER_HEATER.TARGET_TEMPERATURE);
    case F.FUEL:
      return sensor({
        category: C.LEVEL_SENSOR,
        type: T.LEVEL_SENSOR.LIQUID_LEVEL_PERCENT,
        unit: U.PERCENT,
        min: 0,
        max: 100,
      });
    case F.OPERATION:
    case F.ALARMS:
    case F.STATUS:
      return text;
    default:
      throw new Error(`unknown role ${role}`);
  }
}

/** Display order. */
export const ROLES = [
  F.BOILER_CONTROL,
  F.OPERATION,
  F.BOILER_TEMPERATURE,
  F.BOILER_SETPOINT,
  F.DHW_TEMPERATURE,
  F.DHW_SETPOINT,
  F.OUTDOOR,
  F.FLUE_GAS,
  F.FEEDER,
  F.RETURN,
  F.BUFFER_UPPER,
  F.BUFFER_LOWER,
  F.MIXER1,
  F.MIXER2,
  F.MIXER3,
  F.MIXER4,
  F.FUEL,
  F.ALARMS,
  F.STATUS,
];
export const COMMAND_ROLES = [F.BOILER_CONTROL, F.BOILER_SETPOINT, F.DHW_SETPOINT];

/** The fields of a feature Gladys stores (what is kept of a created feature). */
const DECLARED = [
  'name',
  'external_id',
  'category',
  'type',
  'unit',
  'min',
  'max',
  'read_only',
  'has_feedback',
  'keep_history',
  'supported_options',
];

export const deviceIds = (gladys, key) => gladys.externalIds(SELECTOR_TYPE, key);

const KEY = new RegExp(`:${SELECTOR_TYPE}:([0-9a-f]{16})`);

/** The key and the role of one of our feature external ids, else undefined. */
export function parseFeatureId(externalId) {
  if (typeof externalId !== 'string') {
    return undefined;
  }
  const match = new RegExp(`${KEY.source}:([a-z0-9-]{1,40})$`).exec(externalId);
  if (!match || !ROLES.includes(match[2])) {
    return undefined;
  }
  return { key: match[1], role: match[2] };
}

/** The key of one of our device external ids, else undefined. */
export function parseDeviceId(externalId) {
  const match = new RegExp(`${KEY.source}$`).exec(String(externalId ?? ''));
  return match ? match[1] : undefined;
}

/**
 * The on/off of the boiler from its operating state: 0 (off) and 7 (burning
 * off, after a stop) are off, anything else on (as the reference reads it).
 */
export const controlOf = (mode) =>
  mode === undefined
    ? undefined
    : mode === MODE_OFF || mode === MODE_BURNING_OFF
      ? CONTROL.OFF
      : CONTROL.ON;

/** The roles the values of one read report. */
export function reportedRoles(values, system) {
  const roles = new Set([F.STATUS]);
  if (!values) {
    return roles;
  }
  for (const role of values.temperatures.keys()) {
    roles.add(role);
  }
  for (const role of values.setpoints.keys()) {
    roles.add(role);
  }
  if (values.mode !== undefined) {
    roles.add(F.OPERATION);
    roles.add(F.BOILER_CONTROL);
  }
  if (values.fuel !== undefined) {
    roles.add(F.FUEL);
  }
  if (system?.alarms !== undefined) {
    roles.add(F.ALARMS);
  }
  return roles;
}

/** The options of the on/off select: plain labels, unique values (the core's rules). */
export function controlOptions(language) {
  return [CONTROL.ON, CONTROL.OFF].map((value, i) => ({
    value,
    label: word(CONTROL_NAMES[value], language),
    sort_order: i,
  }));
}

/**
 * The Gladys device of a module. `roles`: those seen; `system`: what
 * sysParams gave (model, version) or undefined; `created`: the device
 * already created in Gladys, whose features are kept when the new build
 * lacks them.
 */
export function buildDevice(gladys, key, { roles, system, language, created }) {
  const ids = deviceIds(gladys, key);
  const params = [];
  if (system?.softVer) {
    params.push({ name: 'software', value: system.softVer });
  }
  const model = system?.model ?? 'ecoMAX';
  const built = {
    name: created?.name ?? word(deviceName(system?.model), language),
    external_id: ids.device,
    model,
    should_poll: false,
    features: ROLES.filter((role) => roles.has(role)).map((role) => ({
      name: word(FEATURE_NAMES[role], language),
      external_id: ids.feature(role),
      ...definitionOf(role),
      ...(role === F.BOILER_CONTROL ? { supported_options: controlOptions(language) } : {}),
    })),
    params,
  };
  return keepCreatedFeatures(built, created);
}

/** The features of the created device that the new build lacks, kept as they are. */
export function keepCreatedFeatures(built, created) {
  if (!created) {
    return built;
  }
  const have = new Set(built.features.map((f) => f.external_id));
  const kept = (created.features ?? [])
    .filter((f) => typeof f?.external_id === 'string' && !have.has(f.external_id))
    .map((f) =>
      Object.fromEntries(
        DECLARED.filter((k) => f[k] !== undefined && f[k] !== null).map((k) => [k, f[k]]),
      ),
    );
  const params = built.params.length > 0 ? built.params : (created.params ?? []);
  return { ...built, features: [...built.features, ...kept], params };
}

/**
 * The current states of a device. `status`: 'online' with `values` and
 * `system`; otherwise ('offline', 'foreign', 'unknown') only the status
 * text changes, Gladys keeps the last value of the others. `note`: a text
 * about a stop from Gladys, replacing "OK".
 */
export function deviceStates(ids, { values, system, status = 'online', note, language }) {
  const statusText =
    status === 'online' && note ? note : (STATUS_TEXTS[status] ?? STATUS_TEXTS.unknown);
  const states = [{ role: F.STATUS, text: word(statusText, language) }];
  if (status === 'online' && values) {
    for (const [role, value] of values.temperatures) {
      states.push({ role, state: value });
    }
    for (const [role, value] of values.setpoints) {
      states.push({ role, state: value });
    }
    if (values.fuel !== undefined) {
      states.push({ role: F.FUEL, state: values.fuel });
    }
    if (values.mode !== undefined) {
      states.push({ role: F.OPERATION, text: word(MODE_NAMES[values.mode], language) });
      states.push({ role: F.BOILER_CONTROL, text: controlOf(values.mode) });
    }
    const alarms = system?.alarms;
    if (alarms !== undefined) {
      const shown = alarms.slice(0, LIMITS.alarmsShown).map((a) => a.code);
      states.push({
        role: F.ALARMS,
        text: word(
          alarms.length === 0
            ? ALARM_TEXTS.none
            : ALARM_TEXTS.list(shown, alarms.length - shown.length),
          language,
        ),
      });
    }
  }
  return states.map(({ role, ...value }) => ({
    device_feature_external_id: ids.feature(role),
    ...value,
  }));
}
