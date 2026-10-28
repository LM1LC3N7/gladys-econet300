# Third-party notices

This integration is licensed under the Apache License 2.0 (see `LICENSE`). It
contains logic ported to JavaScript from the project below. The ported parts
were rewritten, not copied; the changes are described below.

## ecoNET-300-Home-Assistant-Integration

<https://github.com/jontofront/ecoNET-300-Home-Assistant-Integration> (the
active fork of pblxptr's project), by jontofront and contributors. MIT License
(`LICENSE` of the repository, version 1.3.6 of 2026-10-11, read at commit
a53ef87). Its notice, as the license asks:

```
MIT License

Copyright (c) 2023-2026 jontofront and contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

What was ported, and how it was changed:

- `api.py`: the local endpoints (`/econet/sysParams`, `/econet/regParams`,
  `/econet/rmCurrentDataParamsEdits`, `/econet/newParam`,
  `/econet/rmCurrNewParam`), HTTP Basic in Latin-1, the repair of doubled
  quotes in a JSON answer (`src/econet/client.js`, `src/econet/http.js`,
  `src/model.js`). Changed: one request at a time with a stop first (the
  reference uses a semaphore and 5 retries), no retry of a read, answers
  bounded in size and parsed without prototype keys, deadlines on writes, a
  refused password is a stop.
- `const/params.py` and `const/core.py`: the keys of the setpoints (1280,
  1281), `BOILER_CONTROL`, the fields of `regParams` and `sysParams` read
  here (`src/constants.js`), a subset only.
- `const/value_maps.py` (`SENSOR_STATUS_CO_MAPPING`): the names of the
  operating states 0 to 26 (`src/i18n.js`), translated.
- `switch.py`: "on" is any operating state but 0, as the reference reads it
  (`src/devices.js`). Changed: never a switch (a select, "Off" protective).
- `tests/fixtures/ecoMAX860P2-N`: the values of the fake module of the
  tests (`test/fixtures/econet.js`), identifiers replaced; the alarm names of
  `tests/fixtures/ecoMAX810P-L/rmAlarmsNames.json` (`src/i18n.js`).
