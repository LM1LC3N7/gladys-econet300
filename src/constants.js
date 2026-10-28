// -----------------------------------------------------------------------------
// Constants: the local API of the ecoNET300 module, feature roles, manifest
// keys, limits and timings.
//
// The ecoNET300 (Plum, Poland) is the network module of the ecoMAX boiler
// controllers fitted to many pellet boilers (Kostrzewa, Hydro-Vacuum,
// Pereko...). It answers on the local network, plain HTTP with HTTP Basic
// authentication (the local user of the module, not the econet24.com
// account), as ecoNET-300-Home-Assistant-Integration v1.3.6 (MIT,
// "jontofront and contributors") uses it:
//   - GET /econet/sysParams: the module and the controller (uid,
//     controllerID, softVer, the alarm log);
//   - GET /econet/regParams: the current values (`curr`: temperatures,
//     setpoints, operating state `mode`, fuel level...);
//   - GET /econet/rmCurrentDataParamsEdits: the bounds of the editable
//     current values (1280 boiler setpoint, 1281 hot water setpoint);
//   - GET /econet/newParam?newParamName=BOILER_CONTROL&newParamValue=0|1:
//     the boiler off or on;
//   - GET /econet/rmCurrNewParam?newParamKey=<key>&newParamValue=<value>:
//     a setpoint.
// A write answers { "result": "OK" } when the module took it.
// -----------------------------------------------------------------------------

export const SELECTOR_TYPE = 'econet300';

export const PATHS = {
  sysParams: '/econet/sysParams',
  regParams: '/econet/regParams',
  edits: '/econet/rmCurrentDataParamsEdits',
  newParam: '/econet/newParam',
  currNewParam: '/econet/rmCurrNewParam',
};

/** Feature roles (the last part of the feature external ids): frozen. */
export const FEATURES = {
  BOILER_CONTROL: 'boiler-control',
  OPERATION: 'operation',
  BOILER_TEMPERATURE: 'boiler-temperature',
  BOILER_SETPOINT: 'boiler-setpoint',
  DHW_TEMPERATURE: 'dhw-temperature',
  DHW_SETPOINT: 'dhw-setpoint',
  OUTDOOR: 'outdoor-temperature',
  FLUE_GAS: 'flue-gas-temperature',
  FEEDER: 'feeder-temperature',
  RETURN: 'return-temperature',
  BUFFER_UPPER: 'buffer-upper-temperature',
  BUFFER_LOWER: 'buffer-lower-temperature',
  MIXER1: 'mixer1-temperature',
  MIXER2: 'mixer2-temperature',
  MIXER3: 'mixer3-temperature',
  MIXER4: 'mixer4-temperature',
  FUEL: 'fuel-level',
  ALARMS: 'alarms',
  STATUS: 'status',
};

/**
 * The temperature roles and their field in `regParams.curr`, with the range
 * a reading must fall in to be a measurement (a sensor not fitted reads
 * null, a broken one far outside).
 */
export const TEMPERATURES = [
  { role: FEATURES.BOILER_TEMPERATURE, field: 'tempCO', min: -20, max: 130 },
  { role: FEATURES.DHW_TEMPERATURE, field: 'tempCWU', min: -20, max: 130 },
  { role: FEATURES.OUTDOOR, field: 'tempExternalSensor', min: -60, max: 70 },
  { role: FEATURES.FLUE_GAS, field: 'tempFlueGas', min: -20, max: 500 },
  { role: FEATURES.FEEDER, field: 'tempFeeder', min: -20, max: 200 },
  { role: FEATURES.RETURN, field: 'tempBack', min: -20, max: 130 },
  { role: FEATURES.BUFFER_UPPER, field: 'tempUpperBuffer', min: -20, max: 130 },
  { role: FEATURES.BUFFER_LOWER, field: 'tempLowerBuffer', min: -20, max: 130 },
  { role: FEATURES.MIXER1, field: 'mixerTemp1', min: -20, max: 130 },
  { role: FEATURES.MIXER2, field: 'mixerTemp2', min: -20, max: 130 },
  { role: FEATURES.MIXER3, field: 'mixerTemp3', min: -20, max: 130 },
  { role: FEATURES.MIXER4, field: 'mixerTemp4', min: -20, max: 130 },
];

/** The writable setpoints: the field read, the key written, the key of their bounds. */
export const SETPOINTS = {
  [FEATURES.BOILER_SETPOINT]: { field: 'tempCOSet', key: '1280' },
  [FEATURES.DHW_SETPOINT]: { field: 'tempCWUSet', key: '1281' },
};

/** The boiler on/off command (`newParam`), and the options of its select. */
export const BOILER_CONTROL = 'BOILER_CONTROL';
export const CONTROL = { ON: 'on', OFF: 'off' };

/**
 * `regParams.curr.mode`, the operating state of the controller (the Mode
 * table of the ecoNET cloud, as the reference maps it): 0 is "off", every
 * other known state is "on" for the boiler control (as the reference does);
 * 7 is "burning off", the extinction a stop starts.
 */
export const MODE_OFF = 0;
export const MODE_BURNING_OFF = 7;
export const MODE_MAX = 26;
/**
 * The states of a boiler switched on (standby, firing up, operation,
 * supervision, pause, cleaning, stabilization, purge, flame checks,
 * prevention, grate, afterburning, heating): what "started elsewhere" and a
 * stop contradicted mean. Alarm, manual and service states are none of them.
 */
export const RUNNING_MODES = new Set([1, 2, 3, 4, 5, 6, 12, 13, 14, 15, 16, 17, 18, 21, 23]);

export const ACTIONS = {
  TEST_CONNECTION: 'test_connection',
};

/** The poll interval of the configuration, in seconds. */
export const POLL_INTERVAL = {
  min: 30,
  max: 900,
  default: 60,
};

/**
 * Boiler (central heating water) setpoint, in °C: never outside the bounds
 * the controller gives (rmCurrentDataParamsEdits, read before each write),
 * nor outside 20 to 90 °C whatever it gives.
 */
export const BOILER = {
  min: 20,
  max: 90,
};

/**
 * Hot water setpoints, in °C: from 20 °C to the configured ceiling (65 °C by
 * default, 40 to 65 °C, never above 65 °C whatever is typed: scalding), and
 * within the bounds the controller gives (its lower maximum wins).
 */
export const DHW = {
  min: 20,
  max: 65,
  ceilingMin: 40,
  ceilingDefault: 65,
};

export const LIMITS = {
  /** Gladys: 300 states per minute; a margin is kept. */
  statesPerMinute: 250,
  statesPerRequest: 100,
  /** An answer is read up to this size, then dropped (sysParams: ~25 KB). */
  responseBytes: 256 * 1024,
  /** Alarms kept from the log of sysParams (the newest first). */
  alarms: 100,
  /** Active alarms shown in the text (the others counted). */
  alarmsShown: 3,
  /** Names (model, version) are cut to this length. */
  nameLength: 60,
  /** Non-protective commands waiting for their turn: more are refused. */
  queue: 4,
};

export const SECOND = 1_000;
export const MINUTE = 60 * SECOND;
export const HOUR = 60 * MINUTE;

export const TIMINGS = {
  /** One request of the polling. */
  requestTimeout: 8 * SECOND,
  /** Failed polls: 1, 2, 5, then 10 minutes, never shorter than the interval. */
  backoff: [MINUTE, 2 * MINUTE, 5 * MINUTE, 10 * MINUTE],
  /** An HTTP 429 or 5xx: a pause of 1 min to 6 h, persisted in /data. */
  pauseMin: MINUTE,
  pauseMax: 6 * HOUR,
  /** The publisher sends what is pending every second; unchanged states again every 30 min. */
  flushInterval: SECOND,
  stateHeartbeat: 30 * MINUTE,
  /** The "Test the connection" button reads at most this often. */
  testCooldown: 10 * SECOND,
  /** The button waits 30 s in Gladys: it answers by 25 s. */
  testBudget: 25 * SECOND,
  /** getConfig() failed: tried again after 5, 10, 30 s, then every minute, without end. */
  configRetry: [5 * SECOND, 10 * SECOND, 30 * SECOND, MINUTE],
  /**
   * Commands (Gladys waits 5 s for the ack, its timer armed when it sends):
   * the request must leave by 3.5 s after the click, or the command is
   * refused unsent; its answer and the read that confirms it are awaited
   * until 4.3 s ("sent, without confirmation" after that), the rest left
   * for the event loops and the WebSocket.
   */
  commandSendBy: 3_500,
  commandAnswerBy: 4_300,
  /** At least 0.3 s left to send after the fresh read. */
  commandMinSend: 300,
  /** Commands arriving within this window share one batch (one fresh read). */
  batchWindow: 50,
  /** A stop that could not connect is tried again within this budget. */
  stopRetryBudget: 250,
  stopRetryStep: 50,
  /** A stop not sent (or contradicted by a read) is sent again by the reads, 3 times at most. */
  stopResends: 3,
  /** Reads after a command, spaced: its effect, then a check. */
  followUps: [5 * SECOND, 20 * SECOND],
  /** A sent setpoint keeps its guard until a read shows it, or 90 s. */
  guard: 90 * SECOND,
};
