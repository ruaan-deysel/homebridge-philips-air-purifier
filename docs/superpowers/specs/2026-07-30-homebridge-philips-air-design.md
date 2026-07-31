# homebridge-philips-air-purifier — Design

**Date:** 2026-07-30
**Status:** Approved, ready for implementation planning

## Purpose

A Homebridge dynamic platform plugin that exposes Philips air purifiers to HomeKit
over the encrypted CoAP protocol, with the device protocol implemented in
TypeScript inside this package. No Python, no external protocol library.

It is the HomeKit counterpart to two existing projects by the same author:

- [`ha-philips-airpurifier`](https://github.com/ruaan-deysel/ha-philips-airpurifier) — Home Assistant integration (entity model, 62-model registry)
- [`philips-airctrl`](https://github.com/ruaan-deysel/philips-airctrl) — Python CoAP library (protocol, discovery)

Existing Homebridge plugins for these devices shell out to the Python
`aioairctrl` library. This plugin deliberately does not: the protocol is ported
to TypeScript and hosted here, so the plugin has no runtime outside Node.

## Differentiation

The closest existing plugin is
[`homebridge-philips-air-purifier-complete`](https://github.com/MaddogWarner/homebridge-philips-air-purifier-complete)
(v3.3.1). It vendors the Python `aioairctrl` package inside the npm tarball —
including `aioairctrl/coap/client.py` and an `aiocoap_monkeypatch.py` — and drives
it from a single CommonJS `index.js` through a `philips_air_api.py` bridge.

This plugin is a different thing, not a reskin:

| | `…-purifier-complete` v3.3.1 | This plugin |
|---|---|---|
| Runtime requirements | Node **and Python 3.11+** | Node only |
| Protocol implementation | vendored Python `aioairctrl`, called out-of-process | native TypeScript, in-process |
| CoAP layer | `aiocoap` plus a monkeypatch module | ~200 own lines over `node:dgram`, no patching |
| Third-party protocol deps | `aiocoap`, `pycryptodomex` (via Python) | none |
| Install scripts | `preinstall.sh` + `postinstall.sh` | **none** |
| Language / structure | one CommonJS `index.js` | TypeScript ESM, layered modules |
| Tests | Python `unittest` | Vitest against payloads captured from real hardware |

Two of those rows are correctness matters, not taste:

- **Install scripts.** Homebridge Verified requires that a plugin *"must not
  execute post-install scripts that modify the users' system in any way."* A
  plugin shipping `preinstall.sh`/`postinstall.sh` to provision Python cannot
  satisfy that. This plugin runs no install scripts at all.
- **No out-of-process bridge.** Spawning a Python interpreter per operation adds
  startup latency, a second failure domain, and a dependency on whatever Python
  the user's Homebridge host happens to have. Keeping the protocol in-process
  removes all three, and lets the CoAP observe stream stay open as a long-lived
  socket rather than being marshalled across a process boundary.

Because the observe stream is what makes state updates push-driven rather than
polled, owning the transport in-process is what makes the HomeKit experience
responsive.

## Target environment

Fixed by the deployment target (Homebridge on Unraid at `192.168.20.21:8581`):

| | |
|---|---|
| Homebridge | 2.2.1 |
| Node.js | 24.18 |
| Module format | **ESM only** (`"type": "module"`) — Homebridge 2 is ESM |
| `engines.homebridge` | `^2.0.0` |
| `engines.node` | `^22.12.0 \|\| ^24.0.0` |
| HAP types | imported from `homebridge`, never from `@homebridge/hap-nodejs` |

Homebridge 2 removed CommonJS support, renamed `hap-nodejs` to
`@homebridge/hap-nodejs`, and moved its output from `lib/` to `dist/`. A CJS
plugin will not load.

## Protocol findings (verified against hardware)

A throwaway spike ran against the author's device at `192.168.20.151` before any
design was committed. Every protocol claim below is observed, not inferred.

```
[1] info OK: {"product_id":"c8167180…","device_id":"96868ce0…","name":"Office 1",
              "type":"Unicorn","modelid":"AC4220/12","swversion":"0.0.0","option":"119"}
[2] sync OK: clientKey = 0DC377BA
[3] Max-Age = 60 · decrypt OK, 59 keys · power=1 mode=0 pm25=1
[4] observe stream = ObserveReadStream, close() available
[6] observe pushes received in 6s: 3
```

Three findings shaped the design:

1. **`/sys/dev/info` is plaintext and requires no handshake.** Discovery probes it
   directly rather than performing the Python version's full sync + decrypt per
   IP. `discovery.ts` therefore needs no crypto at all, and a /24 sweep is a few
   seconds of concurrent plain GETs.

2. **The device runs `AWS_Philips_AIR_Combo@86` (Gen3) yet answers a direct status
   read.** The `status_nudge` workaround in the HA integration is specific to
   CX7550, not to Combo firmware generally. It is out of scope for v1.

3. **The device pushes observations roughly twice per second.** The coordinator
   must publish only on actual value change, or every characteristic update
   floods HomeKit.

### Encryption

Ported from `philips_airctrl/coap/encryption.py` to `node:crypto` with no
dependency:

- `keyAndIv = MD5("JiangPan" + clientKey).hex().toUpperCase()` → 32 chars
- AES-128-CBC, key = `keyAndIv[0:16]` as **ASCII bytes**, IV = `keyAndIv[16:32]` as ASCII bytes
- PKCS7 padding (Node's default, so no manual padding)
- Wire format: `clientKey(8) + ciphertextHex + sha256(clientKey + ciphertextHex)(64)`, all uppercase
- Client key increments per encrypted write: `(parseInt(key,16) + 1) & 0xFFFFFFFF`, 8 uppercase hex

The digest verified byte-exact on the first attempt, confirming the port is
correct.

### CoAP transport

CoAP is implemented in this package over `node:dgram`, with **no third-party
dependency**. The `coap` npm package was evaluated and rejected.

The needed protocol surface is tiny — non-confirmable messages, `GET` and `POST`,
three options (`Uri-Path`, `Observe`, `Max-Age`), and four URIs. `coap` 1.5.0 also
carries CON/ACK retransmission, block-wise transfer, server mode, and multicast,
none of which this plugin uses, plus eight transitive dependencies including
`coap-packet`, last published 2022-02-03.

Writing it ourselves is roughly 200 lines, and it removes a real limitation
rather than merely trading one cost for another:

| | `coap` 1.5.0 | Own implementation |
|---|---|---|
| Runtime dependencies | 8 transitive | 0 |
| Proactive observe cancellation | **not supported** ([#195](https://github.com/coapjs/node-coap/issues/195)) | supported |
| Observe sequence number | not exposed | available |
| Unused protocol surface | CON/ACK, block-wise, server, multicast | none |

Verified against the real device with a hand-written codec:

```
codec self-check: PASS
[1] info code 2.05 -> {"modelid":"AC4220/12","name":"Office 1",…}
[2] sync code 2.05 -> clientKey 6624FB8E
[3] status code 2.05 | Max-Age 60 | Observe seq 900
[4] decrypted 59 keys | model AC4220/12
[5] pushes in 6s: 2
[6] after proactive cancel, further pushes: 0
```

Scope, deliberately minimal:

- **Message type NON only** (`type = 1`). Philips firmware uses non-confirmable
  messages, which is what the Python client's `Unreliable` transport tuning
  selects. No retransmission or ACK state machine is needed.
- **Methods `GET` (0.01) and `POST` (0.02)** only.
- **Options** `Uri-Path` (11, repeatable), `Observe` (6), `Max-Age` (14). Option
  deltas and lengths use the standard 13/14 extension nibbles.
- **Responses** are matched to requests by token, not message ID, which is what
  makes observe notifications work — every notification carries the original
  request's token.
- **Observe registration** sends `Observe: 0`; **cancellation** sends the same
  token with `Observe: 1`. Confirmed to stop notifications on real hardware.
- **Not implemented:** CON/ACK, RST handling beyond ignoring it, block-wise
  transfer (`Block1`/`Block2`), DTLS, server mode, multicast discovery. If a
  device ever needs block-wise transfer for a large status payload, that is the
  one likely extension point — the AC4220's 59-key payload fits in a single
  datagram.

Status is only served through Observe, so even a one-shot read must send the
Observe option; the registration is then cancelled immediately.

### Endpoints

| Path | Method | Encrypted | Use |
|---|---|---|---|
| `/sys/dev/info` | GET | no | discovery probe, device identity |
| `/sys/dev/sync` | POST | no | handshake, returns client key |
| `/sys/dev/status` | GET + Observe | yes | state read and push stream |
| `/sys/dev/control` | POST | yes | writes |

## Architecture

```
src/
  index.ts            default export → api.registerPlatform(...)
  settings.ts         PLATFORM_NAME, PLUGIN_NAME
  platform.ts         DynamicPlatformPlugin — reconcile config ↔ cached accessories
  accessory.ts        one device → AirPurifier + linked services
  airctrl/
    coap/
      message.ts      RFC 7252 encode/decode — pure, no I/O
      socket.ts       node:dgram transport, token matching, observe
    crypto.ts         encryption.py port — node:crypto only, zero deps
    client.ts         client.py port — sync / status / observe / control / info
    discovery.ts      subnet sweep via plaintext /sys/dev/info
    schema.ts         zod schemas for the two trust boundaries
  device/
    keys.ts           const.py PhilipsApi keys + sensor/filter/light tables
    models.ts         device_models.py → DEVICE_MODELS (62 entries, pure data)
    coordinator.ts    coordinator.py port — observe + watchdog + backoff reconnect
homebridge-ui/
  public/index.html   scan / manual add / configured device list
  server.js           HomebridgePluginUiServer — discovery + probe endpoints
test/
  fixtures/           golden payloads captured from real hardware
  *.test.ts           vitest
scripts/
  spike.mjs           standalone hardware probe (written, passing)
  coap-spike.mjs      own-CoAP proof: codec self-check + live device (passing)
  explore.mjs         key-domain probes (written, passing)
  explore2.mjs        display/light control probes (written, passing)
  deploy.sh           npm pack → ssh Unraid → install → restart Homebridge
```

Each unit has one job and a narrow interface:

- `coap/message.ts` — pure `encode`/`decode` of CoAP datagrams. No sockets, no
  Philips knowledge, fully testable on byte arrays.
- `coap/socket.ts` — a UDP socket that maps requests to responses by token and
  exposes `request()` and `observe()`. Knows nothing about Philips either, so it
  is the only place `node:dgram` appears.
- `crypto.ts` — pure functions, no I/O. `encrypt(key, text)`, `decrypt(blob)`, `nextKey(key)`.
- `client.ts` — one device's CoAP conversation. Knows nothing about HomeKit or models.
- `coordinator.ts` — owns liveness for one device: connect, observe, detect loss,
  reconnect, publish changes. Knows nothing about HomeKit.
- `accessory.ts` — translates a status object into HomeKit characteristics and
  HomeKit writes into device keys. Knows nothing about CoAP.
- `models.ts` / `keys.ts` — data only, no behaviour.

`accessory.ts` depends on the coordinator through a change-event subscription and
a `setControl(key, value)` call. Swapping the transport would not touch it.

### Where zod is used

Only where untrusted data enters the process:

1. The decrypted status payload — `{ state: { reported: Record<string, unknown> } }`,
   with passthrough so unknown keys on unfamiliar firmware do not fail validation.
2. The plugin config block from `config.json`.

The 59 device keys are **not** individually schema'd. Interpreting them is the
model table's job, and strict validation there would break every device whose key
set differs from the author's.

### Data flow

```
config.json devices[]
  → platform.ts creates/restores one accessory per device
    → coordinator.ts: sync → status read → observe stream
      → on changed value only → accessory.updateCharacteristic(...)

Home app write
  → accessory.ts maps characteristic → device key/value via models.ts
    → coordinator.setControl() → client.ts encrypted POST /sys/dev/control
      → device pushes new status → observe stream confirms
```

Writes are not optimistically applied; the observe stream is the source of truth.

## Device support scope

The full 62-model registry is ported (it is pure data, so the cost is mechanical),
but v1 claims **verified** support only for the AC4220/12 that could be tested.
All other models run through the same data-driven path and are documented as
untested.

Model lookup follows the HA integration: exact match on the reported model
string, then a 6-character family prefix fallback, then a bare generic config for
the detected API generation. The tested device exercises the fallback —
`AC4220/12` is not a registry key, but `AC4220` is.

### API generations

| Generation | Power key | On / Off | Example |
|---|---|---|---|
| gen1 | `pwr` | `"1"` / `"0"` | AC2889 |
| gen2 | `D03-02` | `"ON"` / `"OFF"` | AC0850 `AWS_Philips_AIR` |
| gen3 | `D03102` | `1` / `0` | AC4220, AC0950 |

### Sub-key notation

Registry keys such as `D03105#1` and `D0310A#2` are not device keys. The `#N`
suffix distinguishes variants that share one device key but differ in options or
behaviour. The device key is the part before `#`, matching the HA integration's
`kind.partition("#")[0]`.

## HomeKit mapping

HomeKit has no preset-mode concept — only `TargetAirPurifierState = MANUAL | AUTO`
plus a 0-100 `RotationSpeed`. The model's speed list is mapped onto discrete
`RotationSpeed` steps so the Home app slider snaps to real device speeds.
Presets outside that ladder become opt-in switches.

One accessory per device, `AirPurifier` as the primary service with the rest
linked:

```
AirPurifier "Office 1"                    primary
  Active                     D03102
  CurrentAirPurifierState    derived from D03102 + D0310C
  TargetAirPurifierState     AUTO → D0310C=0 · MANUAL → last manual speed
  RotationSpeed              minStep 20 → 20/40/60/80/100 = D0310C 1…5
  LockPhysicalControls       D03103            boolean 0/1
AirQualitySensor             D03221 → PM2_5Density and derived AirQuality
FilterMaintenance (pre)      D0520D / D05207  → FilterLifeLevel
FilterMaintenance (HEPA)     D0540E / D05408  → FilterLifeLevel
TemperatureSensor            D03224 ÷ 10
HumiditySensor               D03125
Lightbulb                    D03135  lamp mode — On = 1, Off = 0
                                     (Brightness is not exposed; scope cut, see plan)
Switch (opt-in, default off) Sleep  D0310C = 17
Switch (opt-in, default off) Auto+ AI  D03180
Switch (opt-in, default off) Beep   D03130 — On writes 100, not 1
```

### Key domains verified on hardware

Every write below was probed on the real AC4220/12 and the original value
restored. Two of these contradict the HA registry and would have shipped broken.

| Key | Probed | Result | Conclusion |
|---|---|---|---|
| `D03130` | 0, 50, 1, 100 | reads back 0, 100, 100, 100 | Boolean stored as **0 / 100**. Writing `1` reads back `100`, so a switch that echoes its written value would appear stuck off. **On must write 100.** |
| `D03105` | 1, 2, 3 | ACKed, always reads back 0 | **Read-only status mirror.** Goes to `101` when the lamp is on. The HA registry maps `D03105#1` as the light entity; on this firmware that is a dead control. |
| `D03135` | 1, 2, 3, 0 | 1, 2, 2, 0 — and `D03105` follows to 101 | **The real light control.** Domain `{0, 1, 2}`; 3 clamps to 2. |
| `D0310C` | 1, 2, 3, 4, 5 | `D0310D` = 1, 2, 3, 4, **18** | **Speed 5 is Turbo.** Mode 18 and mode 5 are the same physical state. |
| `D0310C` | 17, 19, 0 | `D0310D` = 1, 3, 1 | Sleep ≡ speed 1, Medium ≡ speed 3, Auto ≡ speed 1 |
| `D03103` | 1, 0 | 1, 0 | Boolean, as expected |
| `D03137` | 0 | reads back 1 | **Not writable.** Not exposed. |
| `D0313B` | 50, 100, 20 | 50, 100, 20 | Freely writable, semantics unknown. Not exposed. |

Consequences for the switch list:

- **Turbo is dropped.** `D0310C = 18` is the same state as speed 5, which is
  already `RotationSpeed = 100`. A Turbo switch would be a duplicate control that
  fights the slider.
- **Medium is dropped.** `D0310C = 19` reports the same fan speed as speed 3
  (`RotationSpeed = 60`).
- **Sleep is kept.** It reports speed 1 but is a distinct device mode, so it is
  not assumed equivalent to `RotationSpeed = 20`.

Because writes are ACKed even when ignored, `status === "success"` from
`/sys/dev/control` means "command accepted", **not** "value applied". Only the
observe stream confirms a real change. This is why writes are never applied
optimistically.

Switches are off by default so the default Home app tile stays uncluttered.

### Two mappings that are this plugin's decision, not inherited

**`AirQuality`** is a 1-5 HomeKit enum. The HA integration reports the Philips
allergen index (`D03120`) raw and never buckets it, so there is no mapping to
inherit. Rather than invent a scale for a vendor-specific index, `AirQuality` is
derived from **PM2.5** (`D03221`), which has standard breakpoints in µg/m³:

| `AirQuality` | PM2.5 |
|---|---|
| 1 `EXCELLENT` | 0 – 12 |
| 2 `GOOD` | 13 – 35 |
| 3 `FAIR` | 36 – 55 |
| 4 `INFERIOR` | 56 – 150 |
| 5 `POOR` | > 150 |

The allergen index has no HomeKit characteristic and is not exposed in v1. If it
is wanted later, a custom characteristic would surface it in Eve but not in the
Home app.

**`RotationSpeed` and `TargetAirPurifierState`** interact, so both edges are
pinned down explicitly:

- `RotationSpeed = 0` is not a device speed. It means off, and is handled by
  `Active`, so the plugin does not write `D0310C = 0` (which is Auto).
- Setting `RotationSpeed` while in Auto implies a mode change and also sets
  `TargetAirPurifierState` to `MANUAL`.
- `TargetAirPurifierState = MANUAL` restores the last manual speed observed for
  this device. When none has been seen yet — first run, or the device has only
  ever been in Auto — it defaults to speed 1 (`D0310C = 1`), the lowest real
  speed, rather than guessing higher.
- The last manual speed is held in memory only. It is not persisted, so a
  Homebridge restart resets it to the speed-1 default.

Verified live state from the test device, for reference:

| Key | Value | Meaning |
|---|---|---|
| `D03102` | 1 | power on |
| `D0310C` | 0 | mode = Auto |
| `D0310D` | 1 | reported fan speed |
| `D03221` / `D03120` / `D03122` | 1 / 1 / 1 | PM2.5 µg/m³ · allergen index · gas |
| `D03224` / `D03125` | 284 / 40 | 28.4 °C · 40 % RH |
| `D0520D` ÷ `D05207` | 175 / 720 | pre-filter 24 % life |
| `D0540E` ÷ `D05408` | 1374 / 9600 | NanoProtect 14 % life |
| `D03103` | 0 | child lock off |
| `D03240` | 0 | no error |
| `D01S12` | `"0.2.3"` | firmware — use this, not `swversion` from `/sys/dev/info`, which reports `"0.0.0"` |

### Porting hazard: signed 32-bit AND

The client-key increment is `(int(key, 16) + 1) & 0xFFFFFFFF` in Python, which is
unsigned. JavaScript's `&` is **signed** 32-bit, so the direct transliteration is
wrong above `0x7FFFFFFF`:

| key | Python | JS `& 0xFFFFFFFF` | JS `>>> 0` |
|---|---|---|---|
| `7FFFFFFF` | `80000000` | `-80000000` ✗ | `80000000` ✓ |
| `80000000` | `80000001` | `-7FFFFFFF` ✗ | `80000001` ✓ |
| `FFFFFFFF` | `00000000` | `00000000` ✓ | `00000000` ✓ |

`nextKey` must use `>>> 0`. Sync keys are random, so roughly half of all sessions
would eventually cross the boundary and silently corrupt every subsequent control
write — an intermittent failure that only appears after a device has been running
a while. This has a mandatory regression test.

## Configuration

All configuration happens in the Homebridge UI. Homebridge always persists to
`config.json`, but the user never edits it by hand.

A custom UI built on `@homebridge/plugin-ui-utils`:

```
┌─ Philips Air ──────────────────────┐
│  [ Scan network ]  192.168.20.0/24 │
│                                    │
│  ✓ AC4220/12  "Office 1"           │
│    192.168.20.151 · fw 0.2.3 [Add] │
│                                    │
│  or  IP: [______________]   [Add]  │
│                                    │
│  Configured devices                │
│  • Office 1  AC4220/12   [⚙] [✕]   │
└────────────────────────────────────┘
```

- **Scan** sweeps the detected subnet concurrently, probing plaintext
  `/sys/dev/info`, and lists model, name, and firmware for one-click add.
- **Manual IP** is always available for devices the sweep misses — other VLANs,
  slow responders, single-observer firmware.
- Model and device ID are probed and stored automatically. The only thing a user
  may type is an optional display name.
- `config.schema.json` sets `customUiPath`, `pluginType: platform`, and
  `singular: true`.

The UI server exposes two request handlers: `/scan` (subnet sweep) and `/probe`
(single-IP identity check).

## Error handling

| Condition | Behaviour |
|---|---|
| Device offline, HomeKit read | throw `HapStatusError(SERVICE_COMMUNICATION_FAILURE)` → Home app shows "No Response" rather than a stale value |
| No push within `Max-Age × 3` (180 s) | watchdog marks unavailable, triggers reconnect |
| Observe stream error or end | reconnect |
| Reconnect failure | exponential backoff 5 s → 60 s |
| Digest mismatch on decrypt | resync — the device rotated its key |
| Control write returns non-success | resync and retry, up to 5 attempts, 0.5 s apart |
| Unknown model | fall back to generic config for the detected API generation, log once at info |

Availability transitions are logged once each way, not per failed poll.
No unhandled exceptions escape the plugin, per Homebridge Verified requirements.

## Testing

Vitest, matching Homebridge 2's own migration off jest.

The 59-key status payload captured from the real device is committed as a golden
fixture, which makes several tests free and genuinely representative:

- **crypto** — round-trip encrypt/decrypt, digest verification, key increment
  including the `0xFFFFFFFF` wrap, and decryption of the real recorded blob
- **model lookup** — `AC4220/12` resolves via the `AC4220` family prefix;
  unknown models fall back by generation; `#N` sub-keys strip correctly
- **mapping** — the fixture status produces the expected characteristic values
  (28.4 °C, 40 % RH, 24 % and 14 % filter life, Auto state, speed → 20 %)
- **coordinator** — change detection suppresses no-op updates; watchdog and
  backoff behaviour against a fake clock

Hardware verification uses a local spike script for the inner loop, then
`scripts/deploy.sh` to install onto the Unraid Homebridge instance, which is
running in debug mode for log inspection.

Code review runs CodeRabbit CLI plus a Codex adversarial pass for a second
opinion, per the author's standing workflow.

## Explicitly out of scope for v1

| Deferred | Why | Add when |
|---|---|---|
| CX7550 `status_nudge` path | untestable without the hardware, and it entangles the reconnect logic | a Combo-firmware user reports a device that never answers a status read |
| `HumidifierDehumidifier` service | AC2729 / HU / CX models not owned | a humidifier model needs support |
| `HeaterCooler` service | AMF765 / AMF870 / CX heater models not owned | a heater model needs support |
| Oscillation / `SwingMode` | AMF models only | as above |
| Turbo and Medium switches | verified redundant — Turbo ≡ speed 5 ≡ 100 %, Medium ≡ speed 3 | never, unless a model is found where they differ |
| Allergen index (`D03120`) | no HomeKit characteristic exists for it | a custom characteristic is wanted for Eve |
| `D03137`, `D0313B` | `D03137` is not writable; `D0313B` semantics unknown | their meaning is established |
| Matter export | Homebridge 2 supports it, but HAP is the requirement | HAP path is stable and Matter is asked for |

## Security notes

- `.env` in this repo holds live Homebridge and Unraid credentials. It is now
  covered by `.gitignore` and is not tracked. It must never be committed.
- The `"JiangPan"` constant and MD5/AES-CBC scheme are dictated by the device
  firmware. They are not a security choice this plugin makes and cannot be
  strengthened without breaking the protocol.
- No analytics or telemetry, per Homebridge Verified requirements.
- Any cached state is written inside the Homebridge storage directory.
