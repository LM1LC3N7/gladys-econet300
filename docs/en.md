# ecoNET300 (Plum ecoMAX pellet boilers)

This integration shows in Gladys a pellet boiler run by a **Plum ecoMAX**
controller (Kostrzewa, Hydro-Vacuum, Pereko and other makers), through the
local API of its **ecoNET300** network module, on your network, without
econet24.com.

**Never tested with a real module**: Plum does not document the local API;
the integration follows ecoNET-300-Home-Assistant-Integration (the project
Home Assistant users run) and its captures of real modules. Not affiliated
with Plum nor with the boiler makers. Your feedback is welcome.

## What you get

One Gladys device per ecoNET300 module, read every 60 s by default:

- temperatures: boiler, hot water, outdoor, flue gas, feeder, return, buffer
  tank (top and bottom), mixing circuits 1 to 4;
- boiler and hot water setpoints;
- operating state (Off, Firing up, Operation, Supervision, Burning off,
  Alarm...) and the boiler on/off;
- fuel level (%);
- alarms running (the name of the best known ones, the code of the others);
- link status ("OK", "ecoNET300 unreachable", a stop from Gladys under
  way...).

A feature appears as soon as the controller gives its value (a sensor not
fitted creates none) and never disappears afterwards.

## Setup

1. Find the address of the ecoNET300 on your network (in your router, or on
   the screen of the controller), for example `192.168.1.50`. Reserve it if
   you can (DHCP reservation).
2. In Gladys, open the configuration of the integration and enter the
   address (with `:port` if not 80), the **local user name** and **password
   of the module** (those of its local web interface, not those of your
   econet24.com account). A password without a user name is refused.
3. Save, then add the device from the **Discovery** tab.

The password is kept by Gladys in its database, never shown again, and sent
only to the ecoNET300 (HTTP Basic, plain http on your network; https is not
supported in this version).

The **Test the connection** button reads the module once, but never sooner
than the refresh interval after the previous read.

## Commands

By default Gladys only reads. The option **Allow "On" and the setpoints**
(off by default) lets the dashboard, the scenes and the voice assistants:

- switch the boiler **On**;
- change the **boiler setpoint**, within the bounds the controller gives
  (those of the last read when less than two intervals old, else read again
  before the write) and between 20 and 90 °C;
- change the **hot water setpoint**, in whole degrees, within the bounds of
  the controller, between 20 °C and the configured ceiling: **65 °C by
  default, 40 to 65 °C, never more than 65 °C** whatever is typed or the
  controller allows (scalding risk).

They are neither switches nor binaries: a "turn everything off" of a scene or
a voice assistant does not reach the boiler.

Each command first reads the module again (its identity and its values) and
decides on that read, never on the values kept in memory; commands arriving
together (a scene) share that read and the read that confirms them, then
leave one by one. A command leaves 4 s after the click at the latest, else
it is refused with nothing sent ("not sent in time" when the commands before
it took the time). It is reported successful only when a read made after it,
before 4.5 s, shows the value asked; otherwise Gladys shows "sent and
accepted, not applied yet" (or "sent, without confirmation" when the module
did not answer), and the follow-up reads, 5 s and 20 s later, publish the
value as soon as it shows. Beyond 4 commands waiting, they are refused. An
HTTP 401/403 refusing a command concerns it only: the reads go on.

A setpoint is refused while a stop sent from Gladys holds (see below): switch
the boiler "On" first. When /data cannot be read, "On" and the setpoints are
refused (a stop kept there would be unknown).

## The stop

**"Off"** (the boiler stopped, `BOILER_CONTROL=0`) needs no option. It
leaves without waiting for a read, ahead of any other request: a read under
way is cut, the commands not sent yet are cancelled (nothing asked before the
stop leaves after it). Neither the option, nor the bounds, nor a pause asked
by the module (HTTP 429/5xx), nor a password refused before (one try), nor
an unreadable /data, nor a device not read yet holds it.

It is refused in these two cases only:

- the configuration of the integration is not valid, or could not be read
  yet since the integration started (without an address and a password,
  nothing can leave);
- the last read showed **another** ecoNET300 at this address (a different
  identifier).

When it cannot leave (module unreachable, an outage), it is tried again for
250 ms, then kept in /data and sent again first thing at each next read,
without limit, until it leaves: it goes at the first read that reaches the
module (after a pause asked by the module, or new credentials when they were
refused, as the reads wait then), and as soon as the integration restarts or the configuration
changes. It is never sent again to another ecoNET300 read at the address.
When the module refuses it with HTTP 401/403, it is sent again twice at
most, then the status says so. When it leaves without an answer, Gladys
shows "stop sent, without confirmation". When the module answers something
other than "OK", Gladys shows it and it is not sent again.

It is reported successful when a read made after it shows the boiler off,
or burning off while it was running just before. A pellet boiler takes
several minutes to go out; the select shows "Off" while it burns off. Once a
read made after the stop shows it off or burning off, nothing is sent again.
If a read made after the stop shows it running while it has been seen
neither off nor burning off yet, the stop is sent again, 3 times at most.

The stop from Gladys is kept in /data, with no time limit. It is lifted only
by a click on "On" (with the option), or when, after being seen off or
burning off, the boiler is read running (firing up, operation,
supervision..., not an alarm nor a service mode) twice in a row (started
again on the panel or from the app).

## Status and errors

- **User name or password refused** (HTTP 401/403 of a read): the reads stop, no
  automatic retry; save other credentials or use "Test the connection".
- **The module asks to slow down** (HTTP 429 or 5xx): a pause of 1 min to
  6 h, kept in /data, for everything but the stop.
- **Module unreachable**: tried again after 1, 2, 5 then 10 min, never sooner
  than the interval; the last values stay shown, the link status says so.
- **Another ecoNET300 answers at the address**: its values never go to the
  created device; it shows as a new device in Discovery.
- **Bounds not read**: some modules do not give the bounds of the setpoints
  (`rmCurrentDataParamsEdits`); the reads go on, the setpoints are refused.

The identity of the device is a print of the identifier (`uid`) of the
module; the identifier itself, the econet24.com key and the Wi-Fi name the
module gives are never published nor kept.

## What /data keeps

`econet300-state.json`: a pause under way, a refusal of the credentials (with
8 bits of a salted print, enough to tell whether they changed, not enough to
find a password), the time of the last read (a restart never reads sooner
than the interval), the stop sent from Gladys. No secret.

## Known limits

- Only the controllers giving their values in `regParams` are read (in the
  captures of the reference: ecoMAX810P-L, ecoMAX850R2-X, ecoMAX860P2-N,
  ecoMAX860P3-V; other ecoMAX860 and 920, the ecoMAX360i, the ecoSOL give
  nothing there); the others only show their alarms: the link status says
  so.
- Summer/winter mode, mixing circuit setpoints, burner output, pumps: not in
  this version.
- Slow module, measured on a local server: a scene "On" + two setpoints is
  sent and confirmed up to 700 ms per request; at 900 ms the three leave but
  the confirmation comes from the follow-up reads ("not applied yet" on
  screen). A setpoint alone is confirmed up to 900 ms.

## Credits

The local protocol is ported from
[ecoNET-300-Home-Assistant-Integration](https://github.com/jontofront/ecoNET-300-Home-Assistant-Integration)
(jontofront and contributors, MIT License); see THIRD_PARTY_NOTICES.md.
