# Changelog

All notable changes to this integration are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses [semantic versioning](https://semver.org/).

Describe each change under `## [Unreleased]` as you make it. The Release
workflow moves that section under the version it ships, and the section becomes
the notes of the version's GitHub Release.

## [Unreleased]

## [0.1.1] - 2026-10-28

### Added

- First version: pellet boilers with a Plum ecoMAX controller through the
  local API of their ecoNET300 module (HTTP Basic, the local user of the
  module): temperatures, boiler and hot water setpoints, operating state,
  fuel level, alarms running, one Gladys device per module.
- Boiler "On" and the boiler and hot water setpoints behind one option, off
  by default, within the bounds of the controller; hot water 65 °C at most
  (ceiling 40 to 65 °C, 65 °C by default).
- "Off" (boiler stopped) needs no option and is held by nothing but a
  missing configuration or another module at the address; kept in `/data`
  and sent again by the reads when it could not leave.
- "Off" that could not leave is sent again at every read until it leaves;
  a boiler burning off after a stop is never stopped again; a scene setting
  several features of a slow module shares its reads; a 401/403 on a command
  no longer stops the reads (review r1).
- Commands acked within 4.3 s again (sent by 3.5 s): a scene of three
  commands is set up to 700 ms per request. Burning off proves a stop taken
  only after a running state read recently before it left or since
  (review r3).
- Refused credentials stop the reads (no automatic retry); HTTP 429/5xx
  pause them; "Test the connection" button. English and French.

[Unreleased]: https://github.com/LM1LC3N7/gladys-econet300/compare/v0.1.1...HEAD
[0.1.1]: https://github.com/LM1LC3N7/gladys-econet300/releases/tag/v0.1.1
