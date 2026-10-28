# gladys-econet300

A [Gladys Assistant](https://gladysassistant.com) external integration for
**pellet boilers with a Plum ecoMAX controller** (Kostrzewa, Hydro-Vacuum,
Pereko...), through the local API of their **ecoNET300** network module, with
the local user name and password of the module (never econet24.com).
Unofficial, not affiliated with Plum.

**Never tested with a real module**: Plum does not document the local API;
this integration follows
[ecoNET-300-Home-Assistant-Integration](https://github.com/jontofront/ecoNET-300-Home-Assistant-Integration)
and the captures of real modules in its repository.

User guides: [English](docs/en.md), [français](docs/fr.md).

## How it works

- One Gladys device per module (`ext:<selector>:econet300:<key>`, the key a
  hash of the uid of the module, never published itself), read every 60 s by
  default (`sysParams`, `regParams`, `rmCurrentDataParamsEdits`, one request
  at a time): boiler, hot water, outdoor, flue gas, feeder, return, buffer
  and mixing circuit temperatures, boiler and hot water setpoints, operating
  state, fuel level, alarms running, link status.
- **"On" and the setpoints behind one option, off by default**: the boiler
  setpoint (bounds of the controller, 20 to 90 °C), the hot water setpoint
  (a water heater in whole degrees, bounds of the controller, 20 °C to a
  ceiling of 65 °C by default, 65 °C at most). Decided on a fresh read
  (identity, values; bounds of the last read), checked again right before
  the request leaves, refused after 4 s, successful only when a read shows
  the value; commands arriving together share the reads.
- **"Off" is the protective command**: no option; it cuts a read under way
  and leaves first, cancels the commands not sent yet, goes through a pause
  or a refused password (one try); kept in `/data` and sent again by the
  reads until it leaves (no limit when it could not connect; 3 times at most
  when refused 401/403 while the reads go through, or when the boiler still runs before it was seen off
  or burning off). Its guard is lifted only by "On" or by a running state
  read twice after the stop was seen taken. Its two
  refusal cases are listed in the guides.
- **No switch, no writable binary**: a "turn everything off" never reaches the
  boiler (the on/off is a select).
- **Refused credentials**: the reads stop, kept in `/data`, never an
  automatic retry; other credentials or the "Test the connection" button try
  again. 429/5xx: a bounded pause kept in `/data`. Nothing secret in logs,
  statuses or `/data`.

## Credits

The local API, the setpoint keys, `BOILER_CONTROL`, the operating states and
the captures used by the tests come from
[ecoNET-300-Home-Assistant-Integration](https://github.com/jontofront/ecoNET-300-Home-Assistant-Integration)
(jontofront and contributors, MIT, 1.3.6). See
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). Modelled on the sibling
integrations [gladys-compit](https://github.com/LM1LC3N7/gladys-compit)
(heating commands behind options) and
[gladys-oekofen](https://github.com/LM1LC3N7/gladys-oekofen) (local pellet
boilers).

## Development

```bash
npm install
npm test                                        # node --test, loopback only
npm run lint && npm run format:check
npm run audit                                   # npm audit --omit=dev
npm run cover                                   # cover.png, plain Node
npx github:GladysAssistant/integration-store .  # store admission checks
```

Tests never leave the machine: the module is a fake behind the injected
transport (`test/fixtures/econet.js`) or a server on 127.0.0.1 (`test/kit`,
copied from the shared test kit), Gladys is the SDK's fake.

## Releasing

**Actions → Release → Run workflow** (patch / minor / major): bumps the
version in `package.json` and the manifest, rolls `CHANGELOG.md`, tags,
builds the multi-arch image to GHCR and publishes the GitHub Release.

## License

Apache-2.0 (`LICENSE`). The ported logic comes from an MIT project, credited
with its notice in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) (also
shipped in the Docker image).
