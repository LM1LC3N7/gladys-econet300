// -----------------------------------------------------------------------------
// The local API of one ecoNET300: the reads and the writes the integration
// uses (src/constants.js lists them), through the Gate (one request at a
// time, a stop first). The user name and the password live here, in the
// Authorization header only: never in a URL, a log, an error.
//
// Deadlines are on the monotonic clock given (`sendBy`: the request must be
// written by then, else nothing leaves; `answerBy`: the answer by then).
// -----------------------------------------------------------------------------

import { BOILER_CONTROL, LIMITS, PATHS, TIMINGS } from '../constants.js';
import { CODES, EconetError } from './errors.js';
import { Gate, PRIORITY } from './gate.js';
import { httpGet } from './http.js';
import { parseJson, writeResultOf } from '../model.js';

export class EconetClient {
  constructor({
    host,
    port,
    username,
    password,
    transport = httpGet,
    monotonic = () => performance.now(),
    timers = globalThis,
  }) {
    this.host = host;
    this.port = port;
    this.transport = transport;
    this.monotonic = monotonic;
    this.timers = timers;
    this.gate = new Gate();
    // Latin-1, as the reference (aiohttp BasicAuth) sends it.
    const token = Buffer.from(`${username}:${password}`, 'latin1').toString('base64');
    Object.defineProperty(this, 'authorization', { value: `Basic ${token}`, enumerable: false });
  }

  /**
   * One GET in its turn. Resolves the parsed JSON of a 200; rejects an
   * EconetError (HTTP for another status, BAD_ANSWER for no JSON).
   */
  request(path, { priority = PRIORITY.POLL, sendBy, answerBy, beforeSend } = {}) {
    if (this.gate.closed) {
      return Promise.reject(new EconetError(CODES.ABORTED));
    }
    return this.gate.run(priority, async (signal) => {
      const now = this.monotonic();
      if (sendBy !== undefined && now >= sendBy) {
        throw new EconetError(CODES.LATE);
      }
      const timeout = answerBy === undefined ? TIMINGS.requestTimeout : Math.max(1, answerBy - now);
      const { status, body } = await this.transport({
        host: this.host,
        port: this.port,
        path,
        authorization: this.authorization,
        timeout,
        maxBytes: LIMITS.responseBytes,
        ...(sendBy === undefined ? {} : { sendWithin: Math.max(0, sendBy - now) }),
        beforeSend,
        signal,
        timers: this.timers,
      });
      if (status !== 200) {
        throw new EconetError(CODES.HTTP, { sent: true, status });
      }
      const data = parseJson(body);
      if (data === undefined) {
        throw new EconetError(CODES.BAD_ANSWER, { sent: true });
      }
      return data;
    });
  }

  sysParams(options) {
    return this.request(PATHS.sysParams, options);
  }

  regParams(options) {
    return this.request(PATHS.regParams, options);
  }

  edits(options) {
    return this.request(PATHS.edits, options);
  }

  /** A write: resolves when the module answers "OK"; NOT_OK (sent) otherwise. */
  async write(path, options) {
    const data = await this.request(path, options);
    const result = writeResultOf(data);
    if (result !== true) {
      throw new EconetError(CODES.NOT_OK, { sent: true, result });
    }
  }

  /** The boiler on (1) or off (0). An off takes the connection (see the Gate). */
  boilerControl(value, options = {}) {
    const query = new URLSearchParams({
      newParamName: BOILER_CONTROL,
      newParamValue: String(value),
    });
    if (value === 0) {
      this.gate.preempt();
      return this.write(`${PATHS.newParam}?${query}`, { ...options, priority: PRIORITY.STOP });
    }
    return this.write(`${PATHS.newParam}?${query}`, { ...options, priority: PRIORITY.COMMAND });
  }

  /** A setpoint (`key` of rmCurrNewParam, a whole value). */
  setpoint(key, value, options = {}) {
    const query = new URLSearchParams({ newParamKey: key, newParamValue: String(value) });
    return this.write(`${PATHS.currNewParam}?${query}`, {
      ...options,
      priority: PRIORITY.COMMAND,
    });
  }

  /** Whether a request is in flight or waiting. */
  get busy() {
    return this.gate.busy;
  }

  close() {
    this.gate.close(new EconetError(CODES.ABORTED));
  }
}
