# TODO — ecoNET300 v1

Handoff document: what is done, what was decided, what comes next. Keep it up
to date at the end of every milestone.

## Status

- [x] **Milestone 1 — read, bounded commands, protective stop** (2026-10-28):
      sysParams/regParams/rmCurrentDataParamsEdits read one request at a
      time, one device per module (hashed uid), temperatures, setpoints,
      operating state, fuel level, alarms running, link status; "On" and the
      boiler and hot water setpoints behind `allow_commands`; "Off"
      protective with its guard in /data; refused credentials stop, 429/5xx
      pause, getConfig() retried without end; en/fr, docs, cover. Tested
      against a fake module (fixtures of the reference) and servers on
      127.0.0.1, virtual and real clock (x20), Node 22 and 24.
- [x] **Review 1 fixes** (2026-10-28, review r1 of 5a1caea): B1 a stop that
      never left is sent again at each read without limit (only 401/403
      refusals count, 3 at most), never to another module, also on a new
      session; I1 burning off (or off) seen after the stop ends the resends
      (phase `stopping`); I2 batches gathered for 50 ms, fresh read bounded by
      the budget only, bounds from the last periodic read, 4 s / 4.5 s, motive
      "not sent in time"; I3 a 401/403 of a write refuses that command only
      (no stop of the reads, no print); I4 /data unreadable refuses the
      setpoints too; I5 tests for the four guards; m1 resend deadlines as a
      click; m2 only running modes count for a start elsewhere, unreadable
      count = 0; m3 the SDK's configuration used when ours fails at the start;
      m4 burning off shows "Off"; m5 status punctuation.
- [x] **Review 2 fixes** (2026-10-28, review r2 of fdacb0a): B1 a 401/403 of
      the stop counts only while the reads are accepted with the same
      credentials; a refusal of the reads, a lifted refusal or other
      credentials reset the count; the ack and the status say a stop waits
      for credentials; I6 tests (burning off seen by a follow-up read, bounds
      of the same module and of a recent read only, a read using the whole
      budget); m7 status punctuation; m8 this file; m9 tests of the minor
      guards; m10 burning off is the stop taken only when the boiler was
      running at the click (`from` kept with the stop).
- [x] **Review 3 fixes** (2026-10-28, review r3 of a824705): I7 test of
      other credentials resetting the count of a stop refused to an account
      that reads (403 on BOILER_CONTROL); m6 back to 3.5 s / 4.3 s; m11 the
      state before a stop is the last read when it leaves (recent only), or
      a running state read after it; unknown and burning off at once: no
      proof, a running state later gets the stop again; m12 tests of the
      freshness of that state and of the 401 of a stop before any read.
- [ ] **Review r4**.
- [ ] **Milestone 2 — real module**: run against a real ecoNET300 (see
      "To check"); turn its answers (anonymized) into fixtures.

## To check on a real module

- Whether `newParam?newParamName=BOILER_CONTROL` answers `{"result":"OK"}`
  on every ecoMAX (the reference documents it for the 810P-L) and how fast
  `mode` shows 0 after it (burning off first, minutes).
- Whether `regParams.mode` 7 (burning off) also shows during normal
  operation: a stop counts it as "applied" only after a running state.
- Whether a setpoint written by `rmCurrNewParam` shows at once in
  `regParams` (confirmation by the read right after, then 5 s and 20 s).
- What a wrong password answers (401 assumed, as the reference) and whether
  the module answers 429 or 5xx when busy.
- The real latency of sysParams (~25 KB): a command reads it before each
  write (identity), within 2 s.
- Whether https exists on some firmwares (the reference accepts an https://
  address; refused here).

## Decisions

- **Version 0.1.0 set by hand** in `package.json`, `package-lock.json`, the
  manifest and the `docker_image` tag
  (`ghcr.io/lm1lc3n7/gladys-econet300:0.1.0`): the first patch release gives
  0.1.1.
- **Not a duplicate**: line 1 of `_lots/lot18/candidats-europe.md`, absent
  from the tracker; reservation at n° 413 of topic 10385 (main session).
- **Reference**: ecoNET-300-Home-Assistant-Integration 1.3.6 (MIT,
  "jontofront and contributors", the active fork of pblxptr's project), read
  at commit a53ef87 in `~/code/ref/lot18/econet300` (license checked in its
  `LICENSE`). Ported, not copied; its MIT notice is in
  `THIRD_PARTY_NOTICES.md`, shipped in the image. pyplumio (MIT) left aside:
  it needs an RS485 gateway.
- **Neighbours** read only: gladys-compit (heating commands behind options,
  a protective season, guards), gladys-oekofen (local pellet boilers),
  gladys-bsblan (local heating with bounded commands); the clock model of
  gladys-iskra; the shared test kit copied into `test/kit`.
- **Endpoints**: only `sysParams` (identity, alarms), `regParams` (values),
  `rmCurrentDataParamsEdits` (bounds, secondary) and the two writes. No
  `rm*` menu parameters (165 "mergedData" parameters): no generic write, a
  whitelist of two setpoint keys (1280, 1281) and `BOILER_CONTROL`.
- **Identity**: `sha256("econet300:" + uid)`, 16 hex digits; the uid is also
  the econet24.com identifier of the module, never published. A uid missing
  = unknown (values not shown, commands refused, "Off" still sent); another
  uid = another module (values never on the created device, "Off" refused).
- **One request at a time** (the Gate), by priority: a stop, a command, the
  polling; a stop cuts the request in flight (a read cut is no failure), the
  transport settles only once its socket is closed (never two connections).
- **"Off"**: no option, no bounds; through a pause (one try), a refused
  password (one try), /data unreadable, a device not read yet; cancels the
  commands not sent yet (epoch checked in beforeSend); tried again 250 ms
  when it cannot connect, then kept `unsent` in /data and sent again first
  by the next reads without limit (only 401/403 refusals count, 3 at most;
  review B1), at a restart before any read and on a new session. Taken
  (success) when a read after it shows mode 0, or mode 7 after a running
  state: the last read when the stop leaves (`from`, only when less than two
  intervals old, so unknown after an outage, a restart or refused
  credentials), or a running state read after it left. Unknown before and
  burning off at the first read after it proves nothing: a running state
  read later is no start elsewhere (an unknown state before never is), and
  the stop, never seen taken, is sent again; a start on the panel during
  that extinction may be contradicted, the next burning off is then the
  stop taken (review r3 m11). Its guard (`stop` in /data) is never lifted
  by time: "On" leaving (saved in /data first, refused when /data cannot be
  written), or a running state (RUNNING_MODES: not alarm nor service modes)
  read twice in a row once the stop was taken. Not taken yet and read
  running: sent again, 3 times at most; once taken, never (review I1). A
  module answering other than "OK" drops it (resending would change
  nothing).
- **Setpoints while a stop of Gladys holds**: refused (a setpoint could
  restart the boiler); "On" first.
- **Commands**: one option (`allow_commands`) for "On" and both setpoints,
  as the brief asks. Batches: the commands waiting together share one fresh
  read and one confirming read (a scene setting the three at once fits).
  Gathered for 50 ms; sent by 3.5 s after the click, answer and
  confirmation by 4.3 s (see "Ack budget"); success
  only when a read shows the value (equal to the value before = not applied
  yet); setpoint guards (90 s or until seen) make a new command always leave.
- **Bounds**: those of `rmCurrentDataParamsEdits` from the last periodic read
  of the same module when it is less than two intervals (+30 s) old, else
  read in the fresh read (missing = refused); they are settings of the
  controller, not states (review r2 accepted it; identity and age tested).
  Boiler 20–90 °C hard; hot water 20 °C to the ceiling `max_dhw` (65 °C by
  default, 40–65, never above 65 °C, Louis's rule of 2026-10-28), high bound
  rounded down; whole degrees; all checked again in `beforeSend`.
- **Ack budget**: sent by 3.5 s, answer and confirming read by 4.3 s, the
  stop included. Gladys arms its 5 s timer when it sends the command and
  drops a later ack: 0.7 s left for both event loops and the WebSocket.
  Measured on a local HTTP server (review r3, scenario s3): a scene of three
  commands at 700 ms per request sent and confirmed; at 900 ms the first two
  leave (confirmed by the follow-up reads), the third is refused unsent
  ("not sent in time"); a setpoint alone confirmed at 900 ms. The 4 s /
  4.5 s of review r1 gave nothing more at 700 ms (review r3 m6).
- **Refused credentials**: 401/403 of a read (never of the secondary
  bounds); stop persisted with 8 bits of a salted scrypt print of address,
  user and password (tells "other credentials" at a restart, cannot test a
  password); lifted by other credentials saved or a successful button.
- **getConfig()**: the SDK reads the configuration itself before
  `connected`; ours failing is tried again after 5, 10, 30 s then every
  minute, without end; the session in place goes on meanwhile.
- **Polling 60 s by default** (30 to 900 s), three requests per read; the
  period measured from the start of the read before.
- **No energy feature**: `boilerPowerKW` and `fuelStream` are instant
  values, no cumulative counter is given.
- **No burner output, pumps, summer/winter mode, mixer setpoints**: left for
  a v2 (mode 55/2049 through `rmNewParam` is a heating mode: behind the
  option, "summer" protective).

- **Manifest**: `categories: ["climate"]`, `transports: ["local"]`; no
  `keywords` nor `countries` (left out on purpose; would be PL and the EU
  countries where ecoMAX boilers sell).
- **One module, one pause**: the features share the module; a 429/5xx on
  one write pauses the module, so the commands of the same batch after it
  are refused "paused" (not sent).
- **Mutation checks**: 35 mutants of milestone 1 (all killed), then the 39,
  59 and 69 mutants of reviews r1 to r3 replayed in a temporary folder of
  the agent, and 15 more on the r3 fixes (`departed`, `ranAfter`, the ack's
  state before, the 401 of a stop before any read, the reset of the count
  by other credentials, the ack budget): all killed. Equivalent survivors,
  kept as they are: the /data check of `turnOn` (also in `check()`, called
  just before), the pair `startedAt > stopSentAt` / `writes !== writes`
  (each covers the other for the stop), `before !== undefined` in the
  stop's ack (`isRunning(undefined)` is false), the reset of the count in
  `liftRefusal` (nothing is counted during a refusal, `block()` reset it).
  Near equivalent: the resend on a new session in `sendStop` (the first read
  of the new session sends it too).

## Next

- Summer/winter/auto heating mode as a select ("summer" protective).
- Mixing circuit setpoints when the module gives their bounds.
- Controllers without `regParams` values (ecoMAX360i, ecoSOL, some ecoMAX860
  and 920): read `rmCurrentDataParams`/`rmParamsData` like the reference.

## Next patch

- r4 m13: at 700 ms per request a scene of 3 commands is confirmed with only 35 ms to spare (4.265 s for a
  4.3 s deadline); on a real module it will often end as "sent, without confirmation". Say "about 700 ms" in
  the docs.
