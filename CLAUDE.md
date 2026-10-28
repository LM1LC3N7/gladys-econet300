# CLAUDE.md

Project rules for coding assistants (Claude Code reads this file) and for human
contributors. Read **[TODO.md](./TODO.md) first**: status, decisions already
taken and what comes next.

## What this is

A Gladys Assistant **external integration** for pellet boilers with a Plum
ecoMAX controller, through the local API of their ecoNET300 module (plain
http, HTTP Basic with the local user of the module): a Node.js service (Node
22+, ESM, no build step) that runs in its own sandboxed Docker container and
talks to Gladys through
[`@gladysassistant/integration-sdk`](https://github.com/GladysAssistant/integration-sdk-js),
its only runtime dependency. It started from the official JavaScript template.
Never tested with a real module.

## Commands

```bash
npm install
npm test                                  # node --test --test-timeout=60000
node --test test/stop.test.js             # one file
node --test --test-name-pattern "Off"     # tests whose name matches
npm run lint                              # ESLint
npm run format:check                      # Prettier, as the CI runs it
npm run format                            # Prettier, fix in place
npm run audit                             # npm audit --omit=dev
npm run cover                             # cover.png (800x534), plain Node
npx github:GladysAssistant/integration-store .   # store admission checks
```

The CI (`.github/workflows/ci.yml`) runs `format:check`, `lint` and `test` on
Node 22 and 24, and builds the Docker image: run the three commands before
pushing.

## Architecture

```
index.js                          SDK wiring only
src/handlers.js                   SDK handlers -> EconetApp (shared with the tests)
src/app.js                        lifecycle, getConfig retries, polling, failures, device,
                                  badges, status, commands (batches), the stop and its guard
src/econet/client.js              the local API: paths, Basic header, JSON, writes
src/econet/gate.js                one request at a time, by priority; a stop cuts the request in flight
src/econet/http.js                node:http GET: deadline, size cap, beforeSend, settles once closed
src/econet/errors.js              error codes
src/model.js                      the answers checked and reduced (pure): identity, values, bounds
src/devices.js                    the Gladys device and its states (pure)
src/config.js                     config_schema normalized (address, credentials, ceiling)
src/store.js                      /data: pause, refusal (8-bit print), last read, the stop
src/publisher.js                  states within Gladys' limits
src/constants.js                  endpoints, roles, bounds, timings
src/i18n.js                       runtime texts (en/fr)
gladys-assistant-integration.json manifest
docs/en.md, docs/fr.md            user documentation, re-hosted by Gladys (mandatory)
test/                             node --test: the SDK's fake Gladys, a fake module
                                  (test/fixtures/econet.js), servers on 127.0.0.1 (test/kit)
.github/scripts/release.mjs       release helpers (manifest bump, changelog), tested in test/
```

## Rules

- **External ids are forever**: device `econet300:<16 hex>` (a hash of the
  uid, never the uid), features `boiler-control`, `operation`,
  `boiler-temperature`, `boiler-setpoint`, `dhw-temperature`, `dhw-setpoint`,
  `outdoor-temperature`, `flue-gas-temperature`, `feeder-temperature`,
  `return-temperature`, `buffer-upper-temperature`,
  `buffer-lower-temperature`, `mixer1-temperature` to `mixer4-temperature`,
  `fuel-level`, `alarms`, `status`. A republished device never loses a
  feature (`keepCreatedFeatures`).
- Manifest keys (`address`, `username`, `password`, `allow_commands`,
  `max_dhw`, `poll_interval`, `language`, the action `test_connection`) are
  frozen.
- **No switch, no writable binary.** The on/off is a `text/select`; the
  setpoints are `thermostat/target-temperature` (boiler) and
  `water-heater/target-temperature` (hot water, whole degrees). "On" and the
  setpoints are behind `allow_commands`, off by default.
- **"Off" is protective**: no option, no bounds, no pause, no refusal, no
  read nor command under way holds it (the Gate cuts the request in flight).
  Its exact refusal cases are listed in the docs: keep `protect()` and the
  docs in sync. Its guard is never lifted by time.
- **Bounds**: always those the controller gives (read before each write),
  intersected with ours: boiler 20 to 90 °C, hot water 20 °C to the ceiling
  (65 °C by default, never above 65 °C).
- **Secrets**: the user name and the password live in the Authorization
  header of the client only (not enumerable); never in a log, a status, an
  error, `/data`. sysParams also holds the econet24.com key, the Wi-Fi name
  and passwords: never kept. A secret field is "kept by Gladys in its
  database, never shown again", never said to be protected by a cipher.
- **Clocks**: decisions, pauses, guards and deadlines on the monotonic clock;
  the wall clock only for `/data`. One read of the clock per decision.
- **Failures**: refused credentials stop the reads (no automatic retry); 429/
  5xx a bounded pause persisted; the periodic read never sooner than the
  interval (restart and test button included; the follow-up reads after a
  command excepted); a secondary endpoint (`rmCurrentDataParamsEdits`) never
  blocks the reads; getConfig() failing is tried again without end.
- Units only from the core's `DEVICE_FEATURE_UNITS_BY_CATEGORY`.
- **The container rootfs is read-only.** Write only under `/data`.
- **Versions belong to the Release workflow** (Actions → Release). Never edit
  `version` in `package.json` or in the manifest, nor the `docker_image` tag,
  by hand (0.1.0 was set once by hand, see `TODO.md`).
- **Changelog.** Every user-visible change adds a line under `## [Unreleased]`
  in `CHANGELOG.md`. Never write a version heading.
- **Files** are UTF-8 without BOM (`test/encoding.test.js`); invisible
  characters are written as escapes in the source, never as such.
- **Style.** Prettier formats, ESLint catches mistakes. Comments explain why,
  in English. Tests never leave 127.0.0.1.
