// -----------------------------------------------------------------------------
// A fake ecoNET300 behind the transport of src/econet/http.js: the answers of
// an ecoMAX860P2-N TOUCH as captured in the fixtures of the reference
// (ecoNET-300-Home-Assistant-Integration, tests/fixtures/ecoMAX860P2-N,
// identifiers replaced), HTTP Basic checked, the writes applied, every
// request recorded, one connection at a time counted. Its delays run on the
// clock of the test (`timers`), the connection itself is immediate.
// -----------------------------------------------------------------------------

import { CODES, EconetError } from '../../src/econet/errors.js';

export const USER = 'admin';
export const PASSWORD = 'pa55-W0rd-test';
export const UID = 'UID-TEST-860P2-0001';
export const OTHER_UID = 'UID-TEST-OTHER-0002';
export const CONFIG = { address: '192.168.1.50', username: USER, password: PASSWORD };

/** `regParams.curr` of the reference fixture (ecoMAX860P2-N). */
export const CURR = {
  thermostat: 1,
  pumpCOWorks: true,
  statusCWU: 0,
  fuelLevel: 66,
  fanPower: 17,
  tempBack: null,
  mixerTemp1: 49.1240234375,
  mixerTemp2: null,
  mixerTemp3: null,
  mixerTemp4: null,
  statusCO: 0,
  boilerPower: 25,
  tempCOSet: 63,
  pumpCWU: true,
  tempUpperBuffer: 44.0706481933594,
  mode: 3,
  tempExternalSensor: 2.9952392578125,
  tempCO: 62.5988540649414,
  mixerSetTemp1: 49,
  tempCWU: 40.063777923584,
  boilerPowerKW: 5.30522203445435,
  tempCWUSet: 45,
  tempFlueGas: 73.7073135375977,
  transmission: 0,
};

/** `rmCurrentDataParamsEdits.data` of the same fixture: hot water up to 70 °C there. */
export const EDITS = {
  1798: { type: 10 },
  1281: { max: 70, type: 4, value: 45, min: 20 },
  1280: { max: 80, type: 4, value: 63, min: 55 },
  2048: { max: 2, type: 4, value: 2, min: 0 },
  2049: { max: 2, type: 4, value: 0, min: 0 },
};

/** sysParams: the fields read, and secrets that must never come out. */
export const SECRETS = { key: '070428061812', ssid: 'MyHomeWifi', servicePassword: '0000' };

const json = (status, body) => ({ status, body: JSON.stringify(body) });

/**
 * The fake module. `timers`: the clock of the test. Options and state may
 * be changed at any time: `latency` (ms per answer), `route(path, query)`
 * to override an answer ('silent', 'refuse', 'drop', or { status, body }),
 * `ignoreControl` (BOILER_CONTROL answered OK but not applied),
 * `applyDelay` (ms before a write shows), `connectDelay` (ms before the
 * connection is up: beforeSend runs then).
 */
export function fakeEconet({ timers, latency = 0 } = {}) {
  const dev = {
    uid: UID,
    model: 'ecoMAX860P2-N TOUCH',
    softVer: '3.2.3819',
    curr: structuredClone(CURR),
    edits: structuredClone(EDITS),
    alarms: [
      { code: '0', fromDate: '2024-05-24 22:05:16', toDate: '2024-05-24 22:05:29' },
      { code: '7', fromDate: '2024-05-24 21:00:00', toDate: '2024-05-24 21:01:00' },
    ],
    user: USER,
    password: PASSWORD,
    latency,
    applyDelay: 0,
    connectDelay: 0,
    ignoreControl: false,
    route: undefined,
    /** { path, query, sent } of every request that reached the module. */
    requests: [],
    /** Requests refused unsent (beforeSend, late, refused port). */
    unsent: 0,
    open: 0,
    peak: 0,
    paths: () => dev.requests.map((r) => r.path),
    count: (path) => dev.requests.filter((r) => r.path === path).length,
    writes: () => dev.requests.filter((r) => /NewParam|newParam/.test(r.path)),
    later(fn) {
      if (dev.applyDelay > 0) {
        timers.setTimeout(fn, dev.applyDelay);
      } else {
        fn();
      }
    },
    answer(path, query) {
      switch (path) {
        case '/econet/sysParams':
          return json(200, {
            uid: dev.uid,
            controllerID: dev.model,
            softVer: dev.softVer,
            password: '*****',
            ...SECRETS,
            alarms: dev.alarms,
          });
        case '/econet/regParams':
          return json(200, { settingsVer: 1, curr: dev.curr });
        case '/econet/rmCurrentDataParamsEdits':
          return json(200, { currentDataParamsEditsVer: 2, data: dev.edits });
        case '/econet/newParam': {
          if (query.newParamName !== 'BOILER_CONTROL') {
            return json(200, { result: 'NOTYPE' });
          }
          const value = Number(query.newParamValue);
          if (!dev.ignoreControl) {
            dev.later(() => {
              dev.curr.mode = value === 0 ? 0 : 2;
            });
          }
          return json(200, { paramName: 'BOILER_CONTROL', paramValue: value, result: 'OK' });
        }
        case '/econet/rmCurrNewParam': {
          const field = { 1280: 'tempCOSet', 1281: 'tempCWUSet' }[query.newParamKey];
          if (!field) {
            return json(200, { result: 'NOTYPE' });
          }
          const value = Number(query.newParamValue);
          dev.later(() => {
            dev.curr[field] = value;
          });
          return json(200, { result: 'OK' });
        }
        default:
          return { status: 404, body: 'not found' };
      }
    },
  };

  dev.transport = ({ path, authorization, timeout, sendWithin, beforeSend, signal, maxBytes }) =>
    new Promise((resolve, reject) => {
      const url = new URL(path, 'http://module');
      const query = Object.fromEntries(url.searchParams);
      const route = dev.route?.(url.pathname, query);
      let settled = false;
      let written = false;
      const handles = [];
      const finish = (err, value) => {
        if (settled) {
          return;
        }
        settled = true;
        for (const h of handles) {
          timers.clearTimeout(h);
        }
        signal?.removeEventListener('abort', onAbort);
        dev.open -= 1;
        if (err) {
          if (!written) {
            dev.unsent += 1;
          }
          reject(err);
        } else {
          resolve(value);
        }
      };
      const onAbort = () => finish(new EconetError(CODES.ABORTED, { sent: written }));
      dev.open += 1;
      dev.peak = Math.max(dev.peak, dev.open);
      if (signal?.aborted) {
        finish(new EconetError(CODES.ABORTED));
        return;
      }
      signal?.addEventListener('abort', onAbort, { once: true });
      if (route === 'refuse') {
        // ECONNREFUSED: nothing sent.
        queueMicrotask(() => finish(new EconetError(CODES.UNREACHABLE)));
        return;
      }
      if (sendWithin !== undefined && sendWithin <= 0) {
        finish(new EconetError(CODES.LATE));
        return;
      }
      handles.push(
        timers.setTimeout(
          () => finish(new EconetError(CODES.TIMEOUT, { sent: written })),
          Math.max(1, timeout),
        ),
      );
      const reply = () => {
        if (settled) {
          return;
        }
        if (route === 'silent') {
          return;
        }
        if (route === 'drop') {
          finish(new EconetError(CODES.UNREACHABLE, { sent: true }));
          return;
        }
        let answer;
        if (route && typeof route === 'object') {
          answer = route;
        } else if (authorization !== basic(dev.user, dev.password)) {
          answer = { status: 401, body: 'Unauthorized' };
        } else {
          answer = dev.answer(url.pathname, query);
        }
        if (Buffer.byteLength(answer.body) > maxBytes) {
          finish(new EconetError(CODES.TOO_LARGE, { sent: true }));
          return;
        }
        finish(null, answer);
      };
      const connected = () => {
        if (settled) {
          return;
        }
        if (beforeSend) {
          try {
            beforeSend();
          } catch (err) {
            err.beforeSend = true;
            err.sent = false;
            finish(err);
            return;
          }
        }
        written = true;
        dev.requests.push({ path: url.pathname, query, authorization });
        if (dev.latency > 0) {
          handles.push(timers.setTimeout(reply, dev.latency));
        } else {
          queueMicrotask(reply);
        }
      };
      if (dev.connectDelay > 0) {
        handles.push(timers.setTimeout(connected, dev.connectDelay));
      } else {
        connected();
      }
    });
  return dev;
}

export const basic = (user, password) =>
  `Basic ${Buffer.from(`${user}:${password}`, 'latin1').toString('base64')}`;
