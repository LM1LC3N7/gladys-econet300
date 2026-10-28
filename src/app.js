// -----------------------------------------------------------------------------
// The integration: the ecoNET300 typed in the configuration (address, local
// user name and password), one read of it every poll interval, one Gladys
// device for the module and its boiler, the transport badge, the "Test the
// connection" button, and three commands: the boiler on/off, the boiler
// setpoint and the hot water setpoint. "On" and the setpoints are refused
// unless the option allows them; "Off" (the boiler stopped) needs nothing.
// index.js only wires the SDK handlers.
//
// Two clocks: `monotonic` paces the reads, the pauses, the deadlines and the
// guards; `now` (wall) only dates what /data keeps (a restart).
//
// Failures:
//   - user name or password refused (HTTP 401/403 on a read): a stop
//     persisted in /data, never an automatic retry; other credentials, or
//     "Test the connection" (one try, never sooner than the interval), try
//     again, and only a success lifts the stop;
//   - HTTP 429/5xx: a pause of 1 min to 6 h persisted in /data, for every
//     path except the stop of the boiler;
//   - anything else: the next read after 1, 2, 5, 10 min, never sooner than
//     the interval;
//   - the time of the last read is kept in /data (before it leaves, at most
//     once a minute, or once an interval when shorter): a restart never
//     reads sooner than the interval;
//   - a reconnection to Gladys clears none of them; getConfig() failing is
//     tried again without end (5 s, 10 s, 30 s, then every minute).
//
// The stop ("Off", BOILER_CONTROL=0), protective, decided on nothing read:
//   - no option, no bounds, no pause, no refusal of the credentials stops it
//     (one try then), nor a read or a command under way (the Gate cuts the
//     request in flight and the stop leaves first), nor a device not read
//     yet. Refused only without a usable configuration, or when the last read
//     showed positively another ecoNET300 at the address (docs list it);
//   - a stop that could not connect is tried again for 250 ms, then kept in
//     /data and sent again first thing by every next read, without limit,
//     until it leaves (at a restart and on a new session too), never to
//     another module read at the address; refused 401/403 by the module:
//     sent again twice at most (never a refusal of the credentials);
//   - it cancels the commands not sent yet (an epoch checked right before
//     each one leaves): nothing begun before the stop leaves after it;
//   - its guard is never lifted by time: only by "On" leaving (with the
//     option), or by a running state read twice in a row after the stop
//     was seen taken (mode 0 off, or 7 burning off). Until then, a read
//     showing the boiler running sends it again, 3 times at most; once
//     taken, never again;
//   - success only when a read after it shows the boiler off (mode 0), or
//     burning off (mode 7) when the read before showed it running.
//
// The other commands: those arriving together (50 ms) form a batch that
// shares one fresh read (identity, values; the bounds of the controller
// from the last periodic read when recent, else read too), never the
// values in memory; then each leaves in order and one read confirms them;
// 4 waiting at most; the option and the epoch checked on arrival, after the
// read and right before the request leaves; sent by 4 s after the click or
// refused unsent; success only when a read before 4.5 s shows the value
// asked (equal to the value before = not applied yet); refused while /data
// cannot be read; a 401/403 refuses that command only. "On" lifts the guard
// of the stop only once that is saved in /data.
// -----------------------------------------------------------------------------

import { DEVICE_TRANSPORTS, createLogger } from '@gladysassistant/integration-sdk';
import { connectionKey, normalizeConfig, numberOf } from './config.js';
import {
  BOILER,
  CONTROL,
  DHW,
  FEATURES as F,
  LIMITS,
  MINUTE,
  MODE_BURNING_OFF,
  MODE_OFF,
  RUNNING_MODES,
  SECOND,
  SETPOINTS,
  TIMINGS,
} from './constants.js';
import {
  COMMAND_ROLES,
  buildDevice,
  deviceIds,
  deviceStates,
  parseDeviceId,
  parseFeatureId,
  reportedRoles,
} from './devices.js';
import { ERRORS, STATUS_TEXTS, T, age, join, word } from './i18n.js';
import { limitsOf, systemOf, valuesOf } from './model.js';
import { EconetClient } from './econet/client.js';
import { CODES, EconetError, isAuthRefused, isBusy, reasonOf } from './econet/errors.js';
import { PRIORITY } from './econet/gate.js';
import { StatePublisher } from './publisher.js';
import { memoryStore, normalizeMemory, refusalPrint, serializeMemory } from './store.js';

const FOLLOW_MAX = 16;

/** A running state of the boiler (firing up, operation, supervision...), not an alarm nor a service mode. */
const isRunning = (mode) => RUNNING_MODES.has(mode);

export class EconetApp {
  constructor({
    gladys,
    logger = createLogger({ name: 'econet300' }),
    store = memoryStore(),
    now = Date.now,
    monotonic = () => performance.now(),
    timers = globalThis,
    transport,
  }) {
    this.gladys = gladys;
    this.logger = logger;
    this.store = store;
    this.now = now;
    this.monotonic = monotonic;
    this.timers = timers;
    /** The HTTP transport (tests); node:http otherwise. */
    this.transport = transport;
    this.publisher = new StatePublisher({ gladys, logger, now: monotonic, timers });
    this.config = normalizeConfig();
    this.configRead = false;
    this.configChain = Promise.resolve();
    this.configRetry = { timer: undefined, step: 0, generation: 0 };
    this.memory = normalizeMemory(null, now());
    this.memoryLoaded = false;
    /** /data exists but cannot be read: never written over, the start refused. */
    this.memoryBroken = false;
    this.saveWarned = false;
    /** The end of a 429/5xx pause, on the monotonic clock (0: none). */
    this.pauseUntil = 0;
    /** key -> the roles seen during this run (a feature never disappears). */
    this.seen = new Map();
    this.generation = 0;
    this.started = false;
    this.session = undefined;
    this.lastStatus = undefined;
    this.published = undefined;
    this.badge = undefined;
    /** Counts the stops: a command begun before one is not sent. */
    this.stopEpoch = 0;
    /** When the last stop left (monotonic): only reads begun after it decide on it. */
    this.stopSentAt = -Infinity;
    /** The non-protective commands waiting (in order), the batch under way, their count. */
    this.pending = [];
    this.working = undefined;
    this.queued = 0;
    /** role -> { from, expected, moved, at } after a setpoint write. */
    this.guards = new Map();
    /** Increases at every write that may have left: a read begun before it is dropped. */
    this.writes = 0;
    /** Stops under way (a resend never doubles one). */
    this.stopping = 0;
  }

  // --- /data -------------------------------------------------------------------

  async loadMemory() {
    if (this.memoryLoaded && !this.memoryBroken) {
      return;
    }
    let raw = null;
    try {
      raw = await this.store.load();
      this.memoryBroken = false;
    } catch {
      // Unreadable is not empty: nothing is written over it.
      this.memoryBroken = true;
      if (!this.memoryLoaded) {
        this.logger.warn('/data/econet300-state.json cannot be read: nothing will be saved');
      }
    }
    this.memoryLoaded = true;
    if (this.memoryBroken) {
      return;
    }
    const now = this.now();
    this.memory = normalizeMemory(raw, now);
    const mono = this.monotonic();
    this.pauseUntil =
      this.memory.pausedUntil > now
        ? mono + Math.min(TIMINGS.pauseMax, this.memory.pausedUntil - now)
        : 0;
  }

  /** The state as /data keeps it (the pause back on the wall clock). */
  serialized() {
    const mono = this.monotonic();
    const left = this.pauseLeft(mono);
    this.memory.pausedUntil = left > 0 ? this.now() + left : 0;
    return serializeMemory(this.memory);
  }

  /** Saves, never throws; never over an unreadable file. */
  saveMemory() {
    if (this.memoryBroken) {
      return Promise.resolve(false);
    }
    return this.store.save(this.serialized()).then(
      () => true,
      (err) => {
        if (!this.saveWarned) {
          this.saveWarned = true;
          this.logger.warn(`The state could not be saved in /data: ${err?.code ?? 'error'}`);
        }
        return false;
      },
    );
  }

  /** Saves, or throws: what must be on disk before a command leaves. */
  async saveStrict() {
    if (this.memoryBroken || !(await this.saveMemory())) {
      throw this.refusal(ERRORS.unreadableData);
    }
  }

  /** The rest of the pause (ms), capped at its maximum at every use. */
  pauseLeft(mono = this.monotonic()) {
    return Math.max(0, Math.min(this.pauseUntil - mono, TIMINGS.pauseMax));
  }

  // --- Lifecycle -------------------------------------------------------------------

  freshSession(config) {
    return {
      client: new EconetClient({
        host: config.host,
        port: config.port,
        username: config.username,
        password: config.password,
        monotonic: this.monotonic,
        timers: this.timers,
        ...(this.transport ? { transport: this.transport } : {}),
      }),
      online: undefined,
      failures: 0,
      wait: undefined,
      /** 'auth', 'busy', or a short reason. */
      error: undefined,
      timer: undefined,
      running: undefined,
      /** When the last read of the polling began (monotonic). */
      lastAttemptAt: -Infinity,
      /** The follow-up reads after commands: one timer, the due times. */
      follow: { timer: undefined, due: [] },
      following: undefined,
      /** What the last read gave: { system, values, limits, at (monotonic) }. */
      data: undefined,
    };
  }

  /**
   * Connected to Gladys (also after every reconnection). The configuration
   * is read; when getConfig() fails it is tried again without end, the
   * session in place (if any) going on meanwhile.
   */
  async connected(getConfig) {
    const retry = this.configRetry;
    retry.generation += 1;
    if (retry.timer) {
      this.timers.clearTimeout(retry.timer);
      retry.timer = undefined;
    }
    const generation = retry.generation;
    let raw;
    try {
      raw = await getConfig();
    } catch (err) {
      if (generation !== retry.generation) {
        return;
      }
      const wait = TIMINGS.configRetry[Math.min(retry.step, TIMINGS.configRetry.length - 1)];
      retry.step += 1;
      this.logger.warn(
        `Reading the configuration failed (${err?.message ?? 'error'}): next try in ${wait / SECOND} s`,
      );
      if (!this.configRead) {
        const fallback = this.gladys.config;
        if (fallback && typeof fallback === 'object' && Object.keys(fallback).length > 0) {
          // The SDK read the configuration just before `connected`: used
          // meanwhile (a stop is never refused for want of it); ours is read
          // again below and applied when it comes.
          await this.applyConfig(fallback, { reconnected: false });
        } else {
          await this.loadMemory();
          this.lastStatus = undefined;
          await this.setStatus(false, T.configWait(age(wait)));
        }
      }
      retry.timer = this.timers.setTimeout(() => {
        retry.timer = undefined;
        if (generation === retry.generation) {
          void this.connected(getConfig);
        }
      }, wait);
      return;
    }
    if (generation !== retry.generation) {
      return;
    }
    retry.step = 0;
    await this.applyConfig(raw, { reconnected: true });
  }

  /** Saved by the user. */
  configUpdated(raw = {}) {
    return this.applyConfig(raw, { reconnected: false });
  }

  /** Configurations applied one at a time, in order: the last one wins. */
  applyConfig(raw, options) {
    const run = this.configChain.then(() => this.apply(raw, options));
    this.configChain = run.catch((err) => this.logger.error('Configuration failed', err));
    return this.configChain;
  }

  async apply(raw, { reconnected }) {
    const next = normalizeConfig(raw);
    if (!this.started || !this.configRead) {
      this.started = true;
      await this.start(raw);
      return;
    }
    if (connectionKey(next) !== connectionKey(this.config)) {
      // Other credentials or another address lift a refusal (never a pause).
      if (this.memory.refused && !reconnected) {
        this.liftRefusal();
        await this.saveMemory();
      }
      await this.start(raw, { changed: !reconnected });
      return;
    }
    const previous = this.config;
    this.config = next;
    if (next.pollInterval !== previous.pollInterval && this.session && !this.session.running) {
      // Only the interval: the session stays; the next read follows the new interval.
      this.schedule();
    }
    if (next.allowCommands !== previous.allowCommands) {
      this.logger.info(`ecoNET300 commands ${next.allowCommands ? 'allowed' : 'off'}`);
    }
    if (reconnected || next.language !== previous.language) {
      // Gladys restarted (or another language): what it keeps in memory again.
      this.published = undefined;
      this.badge = undefined;
      this.lastStatus = undefined;
      this.gladys.forgetPublishedStates?.();
      await this.publishAll();
    }
  }

  async start(raw = {}, { changed = false } = {}) {
    const previous = this.session;
    this.stopSession();
    // The old connection is closed before the new one opens.
    await previous?.client.gate.idle();
    await previous?.running?.catch(() => {});
    await this.loadMemory();
    this.config = normalizeConfig(raw);
    this.configRead = true;
    const lifted = await this.checkRefusal();
    this.session = this.config.problem ? undefined : this.freshSession(this.config);
    this.seen.clear();
    this.published = undefined;
    this.badge = undefined;
    this.lastStatus = undefined;
    this.publisher.start();
    const session = this.session;
    if (!session) {
      await this.publishAll();
      return;
    }
    await this.setStatus(false, T.connecting);
    // A stop kept in /data that never left goes first, without waiting for a read.
    if (this.stopToResend(session)) {
      void this.resendStop(session, 'restart');
    }
    // A restart never reads sooner than the interval after the last read
    // (other credentials are tried at once).
    const since = Math.max(0, this.now() - this.memory.lastReadAt);
    if (!changed && !lifted && this.memory.lastReadAt > 0 && since < this.interval) {
      session.lastAttemptAt = this.monotonic() - since;
      this.schedule();
      await this.publishAll();
      return;
    }
    await this.tick();
  }

  stopSession() {
    this.generation += 1;
    const session = this.session;
    if (session) {
      if (session.timer) {
        this.timers.clearTimeout(session.timer);
        session.timer = undefined;
      }
      if (session.follow.timer) {
        this.timers.clearTimeout(session.follow.timer);
        session.follow.timer = undefined;
      }
      session.client.close();
    }
    this.publisher.stop();
  }

  /** Clean shutdown: timers cleared, /data written. */
  async stop() {
    this.stopSession();
    const retry = this.configRetry;
    retry.generation += 1;
    if (retry.timer) {
      this.timers.clearTimeout(retry.timer);
      retry.timer = undefined;
    }
    await this.saveMemory();
  }

  /** For the tests: everything under way has ended. */
  async idle() {
    for (let i = 0; i < 20; i += 1) {
      const session = this.session;
      await this.configChain;
      await session?.running?.catch(() => {});
      await session?.following?.catch(() => {});
      await this.working;
      await session?.client.gate.idle();
      if (!session?.running && !session?.following && !session?.client.busy) {
        return;
      }
    }
  }

  /** The refusal of the credentials, lifted only for other ones. Returns true when lifted. */
  async checkRefusal() {
    if (!this.memory.refused || this.config.problem) {
      return false;
    }
    if (this.memory.fp !== '' && this.memory.fp !== refusalPrint(this.memory.salt, this.config)) {
      this.liftRefusal();
      await this.saveMemory();
      return true;
    }
    return false;
  }

  liftRefusal() {
    this.memory.refused = false;
    this.memory.fp = '';
  }

  async setStatus(connected, message) {
    const key = JSON.stringify([connected, message ?? null]);
    if (key === this.lastStatus) {
      return;
    }
    this.lastStatus = key;
    this.lastMessage = message;
    await this.gladys.setConnectionStatus(connected, message).catch((err) => {
      this.lastStatus = undefined;
      this.logger.warn(`setConnectionStatus failed: ${err.message}`);
    });
  }

  /** The last status text, in the language of the configuration. */
  lastText() {
    return this.lastMessage ? word(this.lastMessage, this.config.language) : undefined;
  }

  // --- Polling ---------------------------------------------------------------------

  get interval() {
    return this.config.pollInterval * SECOND;
  }

  /** The monotonic time from which the next read may start, from the caller's instant `mono`. */
  dueAt(mono) {
    const session = this.session;
    const base =
      session.online === false ? Math.max(this.interval, session.wait ?? 0) : this.interval;
    return Math.max(session.lastAttemptAt + base, mono + this.pauseLeft(mono));
  }

  /** The next read; never while refused (only the user tries again). */
  schedule() {
    const session = this.session;
    if (!session) {
      return;
    }
    if (session.timer) {
      this.timers.clearTimeout(session.timer);
      session.timer = undefined;
    }
    if (this.memory.refused) {
      return;
    }
    const mono = this.monotonic();
    const wait = Math.max(0, this.dueAt(mono) - mono);
    const generation = this.generation;
    session.timer = this.timers.setTimeout(() => {
      session.timer = undefined;
      if (generation === this.generation) {
        this.tick().catch(() => this.logger.error('ecoNET300 refresh failed'));
      }
    }, wait);
  }

  /** One read at a time: a tick during a read joins it. `force`: the user asked. */
  tick({ force = false } = {}) {
    const session = this.session;
    if (!session) {
      return Promise.resolve();
    }
    if (!session.running) {
      session.running = this.run(session, { force }).finally(() => {
        session.running = undefined;
      });
    }
    return session.running;
  }

  async run(session, { force }) {
    while (session.following) {
      await session.following.catch(() => {});
    }
    const generation = this.generation;
    // A stop that never left goes first, whatever holds the reads.
    if (this.stopToResend(session)) {
      await this.resendStop(session, 'read');
    }
    const mono = this.monotonic();
    if (this.pauseLeft(mono) > 0) {
      this.halted(session, 'busy', this.pauseLeft(mono));
    } else if (this.memory.refused && !force) {
      this.halted(session, 'auth', undefined);
    } else {
      session.lastAttemptAt = mono;
      const now = this.now();
      if (
        now - this.memory.lastReadAt >= Math.min(MINUTE, this.interval) ||
        this.memory.lastReadAt > now
      ) {
        // On disk before the read leaves (at most once a minute, or once an interval).
        this.memory.lastReadAt = now;
        await this.saveMemory();
      }
      try {
        await this.read(session, generation);
      } catch (err) {
        if (generation !== this.generation) {
          return;
        }
        // Cut by a stop: not a failure (the next read comes at the interval).
        if (err?.code !== CODES.ABORTED) {
          this.failed(session, err);
        }
      }
    }
    if (generation !== this.generation) {
      return;
    }
    await this.publishAll();
    if (generation === this.generation) {
      this.schedule();
    }
  }

  halted(session, error, wait) {
    session.online = false;
    session.error = error;
    session.wait = wait;
  }

  /**
   * One read: sysParams (identity, alarms), regParams (values), then the
   * bounds (secondary: a failure keeps the last ones and stops nothing).
   * `follow`: a follow-up read after a command, without the bounds.
   */
  async read(session, generation, { follow = false } = {}) {
    const { client } = session;
    const writes = this.writes;
    const startedAt = this.monotonic();
    const system = systemOf(await client.sysParams());
    if (!system) {
      throw new EconetError(CODES.BAD_ANSWER, { sent: true });
    }
    if (generation !== this.generation) {
      return;
    }
    const values = valuesOf(await client.regParams());
    if (generation !== this.generation) {
      return;
    }
    // The bounds of this read only (a follow-up read keeps those of the
    // periodic read before it): a module that stops giving them leaves none.
    let limits =
      follow && session.data?.system.key === system.key ? session.data?.limits : undefined;
    if (!follow && values) {
      try {
        limits = limitsOf(await client.edits());
      } catch (err) {
        // Secondary: never blocking, never a refusal (some modules answer 404).
        if (err?.code === CODES.ABORTED) {
          throw err;
        }
      }
      if (generation !== this.generation) {
        return;
      }
    }
    session.online = true;
    session.failures = 0;
    session.wait = undefined;
    session.error = undefined;
    if (this.memory.refused) {
      // The button tried and it went through: the stop is lifted.
      this.liftRefusal();
      await this.saveMemory();
    }
    if (this.writes !== writes) {
      // A command wrote meanwhile: these values may predate it; the follow-ups read again.
      return;
    }
    session.data = { system, values, limits, at: startedAt };
    if (system.key && values) {
      this.observe(session, startedAt);
    }
  }

  /** A read failed: the stop (credentials), the pause (429/5xx), or a backoff. */
  failed(session, err) {
    session.online = false;
    const blocked = this.block(err);
    if (blocked) {
      session.error = blocked.kind;
      session.wait = blocked.wait;
      session.failures += 1;
      return;
    }
    const reason = reasonOf(err);
    const wait = Math.max(
      this.interval,
      TIMINGS.backoff[Math.min(session.failures, TIMINGS.backoff.length - 1)],
    );
    session.failures += 1;
    session.wait = wait;
    session.error = reason;
    this.logger.warn(`ecoNET300: ${reason}; next try in ${Math.round(wait / 1000)} s`);
  }

  /** A refusal of the credentials or a 429/5xx: the stop or the pause, persisted. */
  block(err) {
    if (isAuthRefused(err)) {
      this.memory.refused = true;
      this.memory.fp = refusalPrint(this.memory.salt, this.config);
      void this.saveMemory();
      this.logger.warn(
        `The ecoNET300 refused the user name or the password (HTTP ${err.status}): stopped, no automatic retry`,
      );
      return { kind: 'auth', wait: undefined };
    }
    if (isBusy(err)) {
      const step =
        TIMINGS.backoff[Math.min(this.session?.failures ?? 0, TIMINGS.backoff.length - 1)];
      const wait = Math.min(TIMINGS.pauseMax, Math.max(TIMINGS.pauseMin, this.interval, step));
      const mono = this.monotonic();
      this.pauseUntil = Math.max(this.pauseUntil, mono + wait);
      void this.saveMemory();
      this.logger.warn(
        `ecoNET300 busy (HTTP ${err.status}): paused for ${Math.round(wait / 1000)} s`,
      );
      return { kind: 'busy', wait };
    }
    return undefined;
  }

  // --- Gladys ------------------------------------------------------------------------

  createdDevice(key) {
    const id = deviceIds(this.gladys, key).device;
    return (this.gladys.devices ?? []).find((d) => d?.external_id === id);
  }

  /** The keys of our created devices. */
  createdKeys() {
    const keys = [];
    for (const device of this.gladys.devices ?? []) {
      const key = parseDeviceId(device?.external_id);
      if (key !== undefined && deviceIds(this.gladys, key).device === device.external_id) {
        keys.push(key);
      }
    }
    return keys;
  }

  /** The last read, when it is recent enough to be shown (never a stale value as new). */
  freshData() {
    const data = this.session?.data;
    if (!data || this.session.online !== true) {
      return undefined;
    }
    const age = this.monotonic() - data.at;
    return age <= 2 * this.interval + 30 * SECOND ? data : undefined;
  }

  /**
   * How a device stands: 'online', 'foreign' (another module answers at the
   * address), 'unknown' (identity or values not read), 'offline'; undefined
   * while the first read is under way.
   */
  standing(key) {
    const session = this.session;
    if (!session || session.online === false) {
      return 'offline';
    }
    const data = session.data;
    if (!data) {
      return undefined;
    }
    if (!data.system.key) {
      return 'unknown';
    }
    if (data.system.key !== key) {
      return 'foreign';
    }
    return data.values && this.freshData() ? 'online' : 'unknown';
  }

  rolesFor(key) {
    const seen = this.seen.get(key) ?? new Set();
    const data = this.session?.data;
    if (data?.system.key === key) {
      for (const role of reportedRoles(data.values, data.system)) {
        seen.add(role);
      }
    }
    seen.add(F.STATUS);
    this.seen.set(key, seen);
    return seen;
  }

  async publishAll() {
    await this.publishDevices();
    this.queueStates();
    await this.flush();
    await this.publishBadge();
    await this.updateStatus();
  }

  async flush() {
    await this.publisher
      .flush()
      .catch((err) => this.logger.warn(`Sending to Gladys failed: ${err.message}`));
  }

  /** The Discovery list: the module read now (with its identity), and the devices already created. */
  async publishDevices() {
    const keys = new Set(this.createdKeys());
    const data = this.session?.data;
    if (data?.system.key && data.values) {
      keys.add(data.system.key);
    }
    const devices = [...keys].map((key) =>
      buildDevice(this.gladys, key, {
        roles: this.rolesFor(key),
        system: data?.system.key === key ? data.system : undefined,
        language: this.config.language,
        created: this.createdDevice(key),
      }),
    );
    if (devices.length === 0) {
      return;
    }
    const json = JSON.stringify(devices);
    if (json === this.published) {
      return;
    }
    try {
      await this.gladys.publishDiscoveredDevices(devices);
      this.published = json;
    } catch (err) {
      this.logger.warn(`Publishing the discovered devices failed: ${err.message}`);
    }
  }

  createdFeatures() {
    return new Set(
      (this.gladys.devices ?? []).flatMap((d) => (d.features ?? []).map((f) => f.external_id)),
    );
  }

  /** The text about a stop from Gladys on this device, if any. */
  stopNote(key) {
    const stop = this.memory.stop;
    if (!stop || stop.key !== key) {
      return undefined;
    }
    if (stop.phase === 'unsent') {
      return stop.tries >= TIMINGS.stopResends ? STATUS_TEXTS.stopRefused : STATUS_TEXTS.stopUnsent;
    }
    if (stop.phase === 'confirmed') {
      return STATUS_TEXTS.stopped;
    }
    const mode = this.session?.data?.values?.mode;
    const running = stop.phase === 'sent' && mode !== undefined && isRunning(mode);
    return running && stop.resends >= TIMINGS.stopResends
      ? STATUS_TEXTS.stopUnapplied
      : STATUS_TEXTS.stopPending;
  }

  queueStates(created = this.createdFeatures()) {
    const fresh = this.freshData();
    for (const key of this.createdKeys()) {
      const status = this.standing(key);
      if (status === undefined) {
        continue;
      }
      const states = deviceStates(deviceIds(this.gladys, key), {
        values: status === 'online' ? fresh.values : undefined,
        system: status === 'online' ? fresh.system : undefined,
        status,
        note: this.stopNote(key),
        language: this.config.language,
      });
      for (const { device_feature_external_id: id, ...value } of states) {
        if (created.has(id)) {
          this.publisher.push(id, value);
        }
      }
    }
  }

  async publishBadge() {
    const entries = [];
    for (const key of this.createdKeys()) {
      const status = this.standing(key);
      if (status === undefined) {
        continue;
      }
      entries.push({
        external_id: deviceIds(this.gladys, key).device,
        transport: status === 'online' ? DEVICE_TRANSPORTS.LOCAL : DEVICE_TRANSPORTS.UNREACHABLE,
      });
    }
    const json = JSON.stringify(entries);
    if (entries.length === 0 || json === this.badge) {
      return;
    }
    try {
      await this.gladys.publishTransports(entries);
      this.badge = json;
    } catch (err) {
      this.logger.warn(`Transport badge failed: ${err.message}`);
    }
  }

  async updateStatus() {
    const [connected, message] = this.status();
    await this.setStatus(connected, message);
  }

  status() {
    const [connected, message] = this.baseStatus();
    return this.memoryBroken ? [connected, join(message, T.unreadable)] : [connected, message];
  }

  baseStatus() {
    const session = this.session;
    if (!session) {
      return [false, T.problem(this.config.problem)];
    }
    if (this.memory.refused) {
      return [false, T.refused];
    }
    if (session.online === false) {
      const wait = age(session.wait ?? this.interval);
      return session.error === 'busy'
        ? [false, T.busy(wait)]
        : [false, T.unreachable(session.error ?? 'error', wait)];
    }
    const data = session.data;
    if (!data) {
      const mono = this.monotonic();
      const next = this.dueAt(mono) - mono;
      return [false, next > SECOND ? T.nextRead(age(next)) : T.connecting];
    }
    if (!data.system.key) {
      return [false, T.noIdentity];
    }
    if (!data.values) {
      return [true, T.noValues];
    }
    const note = this.stopNote(data.system.key);
    const text = T.connected(data.system.model);
    return [true, note ? T.withNote(text, note) : text];
  }

  /** A device was created (or updated): its last values, if recent, at once. */
  async deviceCreated(device) {
    this.badge = undefined;
    const created = this.createdFeatures();
    for (const f of device?.features ?? []) {
      created.add(f.external_id);
    }
    this.queueStates(created);
    await this.flush();
    await this.publishBadge();
    await this.updateStatus();
  }

  async deviceDeleted(device) {
    this.badge = undefined;
    if (typeof device?.external_id === 'string') {
      this.publisher.forget(device.external_id);
    }
  }

  /** The Discovery tab asks for a scan: the list again (never a read sooner than the interval). */
  async scan() {
    this.published = undefined;
    await this.publishDevices();
  }

  // --- Configuration button ------------------------------------------------------------

  /**
   * Reads now (even after a refusal of the credentials: the user asked, one
   * try), but never sooner than the interval (10 s at least) after the last
   * read; else the current state and when the next read may come.
   */
  async testConnection() {
    if (!this.session) {
      return word(this.status()[1], this.config.language);
    }
    const floor = Math.max(TIMINGS.testCooldown, this.interval);
    const since = this.monotonic() - this.session.lastAttemptAt;
    if (since < floor) {
      const next = word(T.test.next(age(floor - since)), this.config.language);
      const last = this.lastText();
      return last ? `${next} ${last}` : next;
    }
    let handle;
    const limit = new Promise((resolve) => {
      handle = this.timers.setTimeout(resolve, TIMINGS.testBudget);
    });
    await Promise.race([this.tick({ force: true }), limit]);
    this.timers.clearTimeout(handle);
    return this.lastText() ?? word(T.connecting, this.config.language);
  }

  // --- The commands ------------------------------------------------------------------------

  refusal(text) {
    return new Error(word(text, this.config.language));
  }

  /** The hard bounds of a setpoint role (before those of the controller), in °C. */
  hardBounds(role) {
    return role === F.BOILER_SETPOINT
      ? { low: BOILER.min, high: BOILER.max }
      : { low: DHW.min, high: Math.min(DHW.max, this.config.dhwCeiling) };
  }

  /** The bounds of the controller intersected with ours (whole degrees, high rounded down). */
  rangeOf(role, limit) {
    const { low, high } = this.hardBounds(role);
    return {
      low: Math.ceil(Math.max(low, limit.min)),
      high: Math.floor(Math.min(high, limit.max)),
    };
  }

  /** The value of a command, checked strictly: a whole number of °C within the hard bounds. */
  parseSetpoint(role, value) {
    const number = numberOf(value);
    if (number === undefined) {
      throw this.refusal(ERRORS.badNumber);
    }
    if (!Number.isInteger(number)) {
      throw this.refusal(ERRORS.badWhole);
    }
    const { low, high } = this.hardBounds(role);
    if (number < low || number > high) {
      throw this.refusal(ERRORS.outOfRange(low, high));
    }
    return number;
  }

  async setValue(device, feature, value) {
    // The deadlines count from the arrival of the command, before any wait.
    const received = this.monotonic();
    const target = parseFeatureId(feature?.external_id);
    if (!target || !COMMAND_ROLES.includes(target.role)) {
      throw this.refusal(ERRORS.readOnly);
    }
    let wanted;
    if (target.role === F.BOILER_CONTROL) {
      if (value === CONTROL.OFF) {
        return this.protect(target.key, received);
      }
      if (value !== CONTROL.ON) {
        throw this.refusal(ERRORS.badControl);
      }
      wanted = CONTROL.ON;
    } else {
      wanted = this.parseSetpoint(target.role, value);
    }
    if (!this.config.allowCommands) {
      throw this.refusal(ERRORS.disabled);
    }
    if (this.queued >= LIMITS.queue) {
      throw this.refusal(ERRORS.queueFull);
    }
    this.queued += 1;
    try {
      return await new Promise((resolve, reject) => {
        this.pending.push({ target, wanted, received, epoch: this.stopEpoch, resolve, reject });
        this.pump();
      });
    } finally {
      this.queued -= 1;
    }
  }

  /**
   * The commands, one batch at a time: those waiting together share one
   * fresh read (a scene setting several features of the boiler at once
   * fits in the ack budget of each), then leave one by one, in order, and
   * share the read that confirms them.
   */
  pump() {
    if (this.working) {
      return;
    }
    this.working = (async () => {
      // Commands arriving together (a scene: one WebSocket frame each) are
      // gathered first, so that they share one fresh read.
      await new Promise((resolve) => this.timers.setTimeout(resolve, TIMINGS.batchWindow));
      while (this.pending.length > 0) {
        const batch = this.pending.splice(0);
        try {
          await this.runBatch(batch);
        } catch (err) {
          for (const item of batch) {
            item.reject(err);
          }
        }
      }
    })().finally(() => {
      this.working = undefined;
    });
  }

  /** The checks of a non-protective command, on the latest configuration and state. */
  check({ generation, session, epoch, role, key }) {
    if (!this.config.allowCommands) {
      throw this.refusal(ERRORS.disabled);
    }
    if (epoch !== this.stopEpoch) {
      throw this.refusal(ERRORS.stopped);
    }
    if (this.memory.refused) {
      throw this.refusal(ERRORS.refusedAccount);
    }
    if (this.pauseLeft() > 0) {
      throw this.refusal(ERRORS.paused);
    }
    if (!session || generation !== this.generation || this.session !== session) {
      throw this.refusal(ERRORS.noConfig);
    }
    if (this.memoryBroken) {
      // A stop of Gladys kept there is unknown: unreadable is not empty.
      throw this.refusal(ERRORS.unreadableData);
    }
    if (role !== F.BOILER_CONTROL && this.memory.stop?.key === key) {
      // A setpoint may restart a boiler stopped from Gladys: "On" first.
      throw this.refusal(ERRORS.stopHolds);
    }
  }

  /** The refusal of a command after a failed fresh read (nothing written). */
  readRefusal(err) {
    if (!(err instanceof EconetError)) {
      return err;
    }
    if (err.code === CODES.LATE || err.code === CODES.TIMEOUT) {
      return this.refusal(ERRORS.tooSlow);
    }
    if (err.code === CODES.ABORTED) {
      return this.refusal(ERRORS.stopped);
    }
    if (isAuthRefused(err)) {
      this.block(err);
      return this.refusal(ERRORS.refusedAccount);
    }
    this.block(err);
    return this.refusal(ERRORS.notRead(reasonOf(err)));
  }

  /**
   * One batch: the fresh read (identity, values, bounds when a setpoint is
   * asked), then each command decided on it and written, then one read that
   * confirms them, within the ack budget of the first.
   */
  async runBatch(batch) {
    const session = this.session;
    const generation = this.generation;
    let live = [];
    for (const item of batch) {
      item.ctx = {
        generation,
        session,
        epoch: item.epoch,
        role: item.target.role,
        key: item.target.key,
      };
      item.sendBy = item.received + TIMINGS.commandSendBy;
      item.answerBy = item.received + TIMINGS.commandAnswerBy;
      try {
        this.check(item.ctx);
        if (item.sendBy - TIMINGS.commandMinSend <= this.monotonic()) {
          // Its budget went on the commands before it.
          throw this.refusal(ERRORS.queueLate);
        }
        live.push(item);
      } catch (err) {
        item.reject(err);
      }
    }
    if (live.length === 0) {
      return;
    }
    const earliest = Math.min(...live.map((item) => item.sendBy));
    // The read must end with time left for the first one to leave.
    const readBy = earliest - TIMINGS.commandMinSend;
    const { client } = session;
    const options = { priority: PRIORITY.COMMAND, sendBy: readBy, answerBy: readBy };
    let system;
    let values;
    let limits;
    try {
      system = systemOf(await client.sysParams(options));
      if (system?.key) {
        values = valuesOf(await client.regParams(options));
        // The bounds of the controller from the last periodic read of the
        // same module when recent (they are settings, not states), else read now.
        const recent = this.freshData();
        if (recent?.system.key === system.key && recent.limits) {
          limits = recent.limits;
        } else if (values && live.some((item) => item.target.role !== F.BOILER_CONTROL)) {
          try {
            limits = limitsOf(await client.edits(options));
          } catch (err) {
            // No bounds (some modules answer 404): the setpoints are refused, "On" goes on.
            if ([CODES.ABORTED, CODES.LATE, CODES.TIMEOUT].includes(err?.code)) {
              throw err;
            }
          }
        }
      }
    } catch (err) {
      const refusal = this.readRefusal(err);
      for (const item of live) {
        item.reject(refusal);
      }
      return;
    }
    const written = [];
    for (const item of live) {
      try {
        if (!system?.key) {
          throw this.refusal(ERRORS.noIdentity);
        }
        if (system.key !== item.target.key) {
          throw this.refusal(ERRORS.foreign);
        }
        if (!values) {
          throw this.refusal(ERRORS.missingValue);
        }
        const test =
          item.target.role === F.BOILER_CONTROL
            ? await this.turnOn(item, values)
            : await this.writeSetpoint(item, values, limits);
        if (test === undefined) {
          // Already so: nothing sent.
          item.resolve();
        } else {
          written.push({ item, test });
        }
      } catch (err) {
        item.reject(err);
      }
    }
    if (written.length > 0) {
      await this.confirm(session, written);
    }
  }

  /**
   * "On": lifts the guard of a stop from Gladys (saved first), then
   * BOILER_CONTROL=1. Resolves the test of the confirming read, or
   * undefined when already running (nothing sent).
   */
  async turnOn(item, values) {
    const { ctx, sendBy, answerBy } = item;
    const { key } = item.target;
    const mode = values.mode;
    if (mode === undefined) {
      throw this.refusal(ERRORS.missingValue);
    }
    const held = this.memory.stop?.key === key ? this.memory.stop : null;
    if (mode !== MODE_OFF && mode !== MODE_BURNING_OFF && !held) {
      return undefined;
    }
    this.check(ctx);
    if (this.memoryBroken) {
      throw this.refusal(ERRORS.unreadableData);
    }
    // The guard of the stop is lifted on disk before the start may leave.
    if (held) {
      this.memory.stop = null;
      try {
        await this.saveStrict();
      } catch (err) {
        this.restoreStop(held);
        throw err;
      }
    }
    const { client } = ctx.session;
    this.logger.info('ecoNET300: boiler on');
    try {
      await client.boilerControl(1, {
        sendBy,
        answerBy,
        // The very last check, once the connection is up, right before the request leaves.
        beforeSend: () => this.check(ctx),
      });
    } catch (err) {
      if (err.sent) {
        this.followUp(ctx.session);
      }
      // Not answered "OK" (not sent, refused, 4xx, 429, silence, 5xx): in
      // doubt the stop holds again, and its resends go on.
      this.restoreStop(held);
      await this.saveMemory();
      throw this.writeRefusal(err);
    }
    this.followUp(ctx.session);
    return (after) =>
      after.mode !== undefined && after.mode !== MODE_OFF && after.mode !== MODE_BURNING_OFF;
  }

  /** A stop of ours put back after a start that did not leave (unless a newer stop came). */
  restoreStop(held) {
    if (held && this.memory.stop === null) {
      this.memory.stop = held;
    }
  }

  /**
   * A setpoint within the bounds of the controller (read now) and ours.
   * Resolves the test of the confirming read, or undefined when already so.
   */
  async writeSetpoint(item, values, limits) {
    const { ctx, sendBy, answerBy, wanted } = item;
    const { role } = item.target;
    const spec = SETPOINTS[role];
    const current = values.setpoints.get(role);
    if (current === undefined) {
      throw this.refusal(ERRORS.missingValue);
    }
    const limit = limits?.get(spec.key);
    if (!limit) {
      throw this.refusal(ERRORS.noLimits);
    }
    const checkRange = () => {
      const range = this.rangeOf(role, limit);
      if (range.low > range.high) {
        throw this.refusal(ERRORS.noLimits);
      }
      if (wanted < range.low || wanted > range.high) {
        throw this.refusal(ERRORS.outOfRange(range.low, range.high));
      }
    };
    checkRange();
    if (current === wanted && !this.guardActive(role)) {
      return undefined;
    }
    this.check(ctx);
    const { client } = ctx.session;
    this.logger.info(`ecoNET300: ${role} ${wanted} °C`);
    try {
      await client.setpoint(spec.key, wanted, {
        sendBy,
        answerBy,
        beforeSend: () => {
          this.check(ctx);
          // The ceiling may have been lowered since the command arrived.
          checkRange();
        },
      });
    } catch (err) {
      if (err.sent) {
        this.followUp(ctx.session);
        if (err.code !== CODES.NOT_OK) {
          this.guard(role, current, wanted);
        }
      }
      throw this.writeRefusal(err);
    }
    this.followUp(ctx.session);
    this.guard(role, current, wanted);
    // Equal to the value before: not applied yet.
    return (after) => after.setpoints.get(role) === wanted && wanted !== current;
  }

  /** The refusal of a write that failed. */
  writeRefusal(err) {
    if (err.beforeSend || !(err instanceof EconetError)) {
      return err;
    }
    const reason = reasonOf(err);
    this.logger.warn(`ecoNET300: write failed (${reason})`);
    if (err.code === CODES.NOT_OK) {
      return this.refusal(ERRORS.rejected(err.result));
    }
    if (!err.sent) {
      // LATE here: the fresh read went through, the commands before it took the time.
      return err.code === CODES.LATE
        ? this.refusal(ERRORS.queueLate)
        : this.refusal(ERRORS.notSent(reason));
    }
    if (err.code === CODES.ABORTED) {
      return this.refusal(ERRORS.sentUnconfirmed(reason));
    }
    if (err.code === CODES.HTTP && err.status >= 400 && err.status <= 499 && err.status !== 429) {
      // Refused for this command only: a 401/403 of a write is no refusal of
      // the credentials (the reads go on, no print of a password that reads).
      return this.refusal(ERRORS.rejected(`HTTP ${err.status}`));
    }
    this.block(err);
    return this.refusal(ERRORS.sentUnconfirmed(reason));
  }

  /**
   * The read that confirms writes, within the ack budget of the first: each
   * resolved when its test passes, else "sent and accepted, not applied
   * yet" (the follow-up reads check it).
   */
  async confirm(session, written) {
    const answerBy = Math.min(...written.map((w) => w.item.answerBy));
    const after = await this.readAfter(session, answerBy);
    for (const { item, test } of written) {
      if (after && test(after) === true) {
        item.resolve();
      } else {
        item.reject(this.refusal(ERRORS.notYetApplied));
      }
    }
  }

  /** The values read now (a read leaving after the writes), or undefined. */
  async readAfter(session, answerBy) {
    if (answerBy - this.monotonic() <= 50) {
      return undefined;
    }
    try {
      return valuesOf(
        await session.client.regParams({ priority: PRIORITY.COMMAND, sendBy: answerBy, answerBy }),
      );
    } catch {
      return undefined;
    }
  }

  // --- The stop --------------------------------------------------------------------------

  /**
   * "Off": the protective command. No option, no bounds, no pause, no
   * refusal, no read nor command under way holds it. Refused only without a
   * usable configuration, or when the last read showed another module.
   */
  async protect(key, received) {
    // Cancels the commands not sent yet (checked right before each leaves).
    this.stopEpoch += 1;
    const session = this.session;
    if (!session || !this.configRead || this.config.problem) {
      throw this.refusal(ERRORS.noConfig);
    }
    const known = session.data?.system.key;
    if (known && known !== key) {
      throw this.refusal(ERRORS.foreign);
    }
    this.memory.stop = { key, phase: 'unsent', tries: 0, resends: 0, starts: 0 };
    // Never waited for: the stop does not depend on /data.
    void this.saveMemory();
    this.logger.info('ecoNET300: boiler off (stop from Gladys)');
    const outcome = await this.sendStop(session, {
      sendBy: received + TIMINGS.commandSendBy,
      answerBy: received + TIMINGS.commandAnswerBy,
    });
    // The status and the states say it (never waited for: the ack first).
    void this.publishAll();
    if (outcome.ok) {
      const before = session.data?.values?.mode;
      const after = await this.readAfter(session, received + TIMINGS.commandAnswerBy);
      const stop = this.memory.stop;
      const off = after?.mode === MODE_OFF;
      const burningOff =
        after?.mode === MODE_BURNING_OFF && before !== undefined && isRunning(before);
      if ((off || burningOff) && stop?.key === key && stop.phase === 'sent') {
        // A read that left after the stop shows it taken: no resend from now on.
        stop.phase = off ? 'confirmed' : 'stopping';
        void this.saveMemory();
      }
      if (!off && !burningOff) {
        throw this.refusal(ERRORS.stopNotYet);
      }
      return;
    }
    throw this.refusal(outcome.error);
  }

  /**
   * One stop, cut-through (the Gate takes the connection), tried again for
   * 250 ms when it could not connect. Updates the stop kept in /data and
   * arms the follow-up reads. Resolves { ok } or { error } (never throws).
   */
  async sendStop(session, options) {
    this.stopping = (this.stopping ?? 0) + 1;
    let outcome;
    try {
      outcome = await this.sendStopOnce(session, options);
      return outcome;
    } finally {
      this.stopping -= 1;
      if (!outcome?.ok && this.session && this.session !== session) {
        // The session changed meanwhile (other credentials saved): a stop
        // that never left goes on the new one at once.
        void this.resendStop(this.session, 'new session');
      }
    }
  }

  async sendStopOnce(session, { sendBy, answerBy }) {
    const stop = this.memory.stop;
    const retryEnd = this.monotonic() + TIMINGS.stopRetryBudget;
    let err;
    for (;;) {
      err = undefined;
      try {
        await session.client.boilerControl(0, {
          sendBy,
          answerBy,
          beforeSend: () => {
            this.stopSentAt = this.monotonic();
            this.writes += 1;
          },
        });
      } catch (failure) {
        err = failure;
      }
      const retry =
        err &&
        !err.sent &&
        err.code === CODES.UNREACHABLE &&
        this.monotonic() + TIMINGS.stopRetryStep < Math.min(retryEnd, sendBy);
      if (!retry) {
        break;
      }
      await new Promise((resolve) => this.timers.setTimeout(resolve, TIMINGS.stopRetryStep));
    }
    const current = this.memory.stop === stop ? stop : undefined;
    this.followUp(session);
    if (!err) {
      if (current && current.phase === 'unsent') {
        current.phase = 'sent';
      }
      await this.saveMemory();
      return { ok: true };
    }
    const reason = reasonOf(err);
    this.logger.warn(`ecoNET300: stop failed (${reason})`);
    if (err.code === CODES.NOT_OK) {
      // The module refuses BOILER_CONTROL: sending it again would change nothing.
      if (current) {
        this.memory.stop = null;
      }
      await this.saveMemory();
      return { error: ERRORS.rejected(err.result) };
    }
    if (isAuthRefused(err)) {
      // Refused by the module for this write (never a refusal of the
      // credentials, no print): counted, sent again twice at most.
      if (current) {
        current.tries += 1;
      }
      await this.saveMemory();
      return { error: ERRORS.stopUnsent(reason) };
    }
    if (!err.sent) {
      // Never left: kept, sent again at each read until it leaves.
      await this.saveMemory();
      return { error: ERRORS.stopUnsent(reason) };
    }
    if (isBusy(err)) {
      this.block(err);
    }
    if (current && current.phase === 'unsent') {
      current.phase = 'sent';
    }
    await this.saveMemory();
    return { error: ERRORS.stopUnconfirmed(reason) };
  }

  /** Whether a stop kept in /data that never left is to be sent again now. */
  stopToResend(session) {
    const stop = this.memory.stop;
    const known = session.data?.system.key;
    return Boolean(
      stop &&
      stop.phase === 'unsent' &&
      // Only refusals by the module (401/403) count; a stop that could not
      // connect is sent again at each read, without end.
      stop.tries < TIMINGS.stopResends &&
      !this.stopping &&
      // Never to another module read at the address (as a click).
      !(known && known !== stop.key),
    );
  }

  /** A stop kept in /data that never left: sent again, not waited for by a click. */
  async resendStop(session, why) {
    if (!this.stopToResend(session)) {
      return;
    }
    this.logger.warn(`ecoNET300: stop sent again (${why})`);
    const mono = this.monotonic();
    await this.sendStop(session, {
      sendBy: mono + TIMINGS.commandSendBy,
      answerBy: mono + TIMINGS.commandAnswerBy,
    });
  }

  /**
   * A read through the guards. The stop of Gladys (reads begun after it
   * left only): mode 0 = applied, mode 7 = taken (burning off): no resend
   * after either; once taken, a running state read twice in a row = started
   * elsewhere, the guard lifted; not taken yet and running = sent again,
   * 3 times at most. The setpoint guards: lifted when the value asked shows
   * after a move, or after 90 s.
   */
  observe(session, startedAt) {
    const { system, values } = session.data;
    const stop = this.memory.stop;
    if (
      stop &&
      stop.key === system.key &&
      values.mode !== undefined &&
      startedAt > this.stopSentAt
    ) {
      const mode = values.mode;
      const taken = stop.phase === 'confirmed' || stop.phase === 'stopping';
      if (mode === MODE_OFF) {
        if (stop.phase !== 'confirmed' || stop.starts !== 0) {
          stop.phase = 'confirmed';
          stop.starts = 0;
          void this.saveMemory();
        }
      } else if (mode === MODE_BURNING_OFF) {
        if (stop.phase === 'sent' || stop.starts !== 0) {
          stop.phase = stop.phase === 'sent' ? 'stopping' : stop.phase;
          stop.starts = 0;
          void this.saveMemory();
        }
      } else if (taken && isRunning(mode)) {
        stop.starts += 1;
        if (stop.starts >= 2) {
          this.logger.info('ecoNET300: boiler started elsewhere after the stop from Gladys');
          this.memory.stop = null;
        }
        void this.saveMemory();
      } else if (
        stop.phase === 'sent' &&
        isRunning(mode) &&
        stop.resends < TIMINGS.stopResends &&
        !this.stopping
      ) {
        stop.resends += 1;
        void this.saveMemory();
        this.logger.warn(
          `ecoNET300: the boiler still runs after the stop: sent again (${stop.resends}/${TIMINGS.stopResends})`,
        );
        const mono = this.monotonic();
        void this.sendStop(session, {
          sendBy: mono + TIMINGS.commandSendBy,
          answerBy: mono + TIMINGS.commandAnswerBy,
        });
      }
    }
    for (const [role, guard] of [...this.guards]) {
      if (!this.guardActive(role)) {
        continue;
      }
      const value = values.setpoints.get(role);
      if (value === undefined) {
        continue;
      }
      if (!guard.moved && value !== guard.from) {
        guard.moved = true;
      }
      if (guard.moved && value === guard.expected) {
        this.guards.delete(role);
      }
    }
  }

  /** After a setpoint write, until a read shows it: a new command is always sent. */
  guard(role, from, expected) {
    this.guards.set(role, {
      from,
      expected,
      moved: from === expected,
      at: this.monotonic(),
    });
  }

  guardActive(role) {
    const guard = this.guards.get(role);
    if (guard && this.monotonic() - guard.at >= TIMINGS.guard) {
      this.guards.delete(role);
      return false;
    }
    return Boolean(guard);
  }

  /** After a write: follow-up reads 5 s and 20 s later (one timer, grouped). */
  followUp(session) {
    this.writes += 1;
    const mono = this.monotonic();
    const { follow } = session;
    for (const delay of TIMINGS.followUps) {
      follow.due.push(mono + delay);
    }
    follow.due = follow.due.sort((a, b) => a - b).slice(-FOLLOW_MAX);
    this.armFollow(session);
  }

  armFollow(session) {
    const { follow } = session;
    if (follow.timer || follow.due.length === 0) {
      return;
    }
    const generation = this.generation;
    const mono = this.monotonic();
    follow.timer = this.timers.setTimeout(
      () => {
        follow.timer = undefined;
        if (generation !== this.generation) {
          return;
        }
        const at = this.monotonic();
        follow.due = follow.due.filter((d) => d > at + 100);
        this.followRead(session).finally(() => this.armFollow(session));
      },
      Math.max(0, follow.due[0] - mono),
    );
  }

  /** A follow-up read: never during a pause or a refusal; a periodic read under way first. */
  async followRead(session) {
    while (session.running || session.following) {
      await (session.running ?? session.following).catch(() => {});
    }
    if (session !== this.session || this.memory.refused || this.pauseLeft() > 0) {
      return;
    }
    const generation = this.generation;
    session.following = (async () => {
      try {
        await this.read(session, generation, { follow: true });
      } catch (err) {
        if (generation === this.generation) {
          // Only a pause or a stop is kept: the next poll tells the rest.
          this.block(err);
        }
        return;
      }
      if (generation === this.generation) {
        await this.publishAll();
      }
    })().finally(() => {
      session.following = undefined;
    });
    await session.following;
  }
}
