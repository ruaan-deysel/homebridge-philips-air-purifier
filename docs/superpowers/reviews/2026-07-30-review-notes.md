# Adversarial review notes — homebridge-philips-air

Task 12 of `docs/superpowers/plans/2026-07-30-homebridge-philips-air.md`.

Branch `worktree-philips-air-impl`. Reviewed range: `main..1017708`.

## Reviewer status

| Reviewer | Status | Evidence |
| --- | --- | --- |
| CodeRabbit CLI 0.7.1 | **Complete** | `coderabbit review --base main`, exit 0, 47 files, 41 findings (1 critical, 15 major, 7 minor, 18 trivial). Note: 0.7.1 has no `--plain` flag; plain text is the default mode. |
| Codex | **Dropped from the gate by user decision (2026-07-31)** | Usage limit reached (retry 2026-08-05 14:09). The user ruled CodeRabbit alone satisfies this task. Codex was **not run and not substituted** — no other reviewer's output is presented as Codex's, and the plan's original two-reviewer criterion is superseded by this ruling. |
| Controller audit (opus) | Complete | Independent audit of Tasks 4/6/7/8/9, which had shipped with no review artifacts. 1 Critical + 4 Important, all verified against source before dispatch. |

**Task 12 is closed on CodeRabbit alone**, per the user's 2026-07-31 ruling. The plan's original criterion ("CodeRabbit and Codex both review") is superseded. Every CodeRabbit finding below carries a disposition, and the controller audit of the five unreviewed tasks is recorded alongside it.

## Protocol-invariant re-check

Required by the plan's acceptance criteria; verified directly by the controller at `1017708`:

| Invariant | Status | Evidence |
| --- | --- | --- |
| `nextKey` uses `>>> 0`, never `& 0xFFFFFFFF` | PASS | `src/airctrl/crypto.ts:49`. The only `& 0xFFFFFFFF` in `src/` is the explanatory comment at `crypto.ts:44`; `discovery.ts:59` uses `0xFFFFFFFF` as a mask with a correct `>>> 0`. |
| Beep writes 100, not 1 | PASS | `src/homekit/mapping.ts:31` (`value ? 100 : 0`); Gen1 writes `'1'`/`'0'` via `src/accessory.ts:289`. |
| Light targets `D03135`, not the read-only `D03105` | PASS | `src/device/keys.ts:141` (`LAMP_MODE: 'D03135'`), read-only warning at `keys.ts:112`. All `D03105` write paths removed. |
| `RotationSpeed` 0 never writes mode 0 | PASS | `src/homekit/mapping.ts:15-17` returns `null` for `speed <= 0` and clamps to a floor of 1. |
| No secret or credential in the tracked tree | PASS | Only `'JiangPan'` (a firmware-dictated protocol constant, expected in source) and `randomBytes` token generation. `.env` is untracked and gitignored; it does not exist in the worktree at all. |

The plan's own invariant gate **failed open** and was rewritten (finding F20 below).

## Controller audit findings — Tasks 4, 6, 7, 8, 9

These five tasks were implemented outside the review loop and had no briefs, reports, or review packages. Audited independently; every finding was verified against source before any fix was dispatched.

| # | Finding | Disposition |
| --- | --- | --- |
| A1 | **Critical.** `src/platform.ts` — a device failing its *first* `coordinator.start()` was discarded permanently and never retried; the coordinator's backoff was only reachable after a successful start. With CoAP NON (no retransmission), one lost datagram at startup dropped the device until Homebridge restarted. A cached accessory stayed registered with no `onGet`/`onSet`, so HAP served stale values and accepted writes with success. | **Fixed** (`3c5646f`). Conflicted with the plan's own Task 9 criterion ("logs an error and is skipped") — escalated; **user ruled retry-with-backoff governs**. Plan and `.tasks.json` corrected in `95f28fd`. |
| A2 | **Important.** `src/airctrl/client.ts` — `setControl` retry budget reached ~50s inside a single `onSet`; HAP-NodeJS abandons a write at 10s. | **Fixed** (`0bbce40`). `timeoutMs: 2000`, `budgetMs: 6000`, deadline enforced at three points. |
| A3 | **Important.** `src/accessory.ts` — `RotationSpeed` reported 0 while `Active` was ACTIVE in Auto/Sleep. Reproduced on the real hardware fixture (`D03102:1`, `D0310C:0`, `D0310D:1`). | **Fixed** (`aa89b90`). Falls back to the reported fan speed `D0310D` mapped onto the ladder. Gen3 only — see D3. |
| A4 | **Important.** `src/accessory.ts:349` — magic `on: 123` written to `D03105`, the read-only mirror. Writes ACKed and ignored; HomeKit reported success while the lamp never moved. | **Fixed** (`aa89b90`). All `D03105` write paths removed; `LAMP_MODE` promoted to `lights` for six models that already declared it. Four models (AC0950, CX7550, AC3737, CX5120) intentionally have no writable light — no correct write value exists. |
| A5 | **Important.** `src/accessory.ts` — `Gen1Key.BEEP === Gen1Key.DISPLAY_BACKLIGHT === 'uil'`; AC2729 listed it in both `switches` and `lights`, so two HomeKit tiles fought over one device setting. | **Fixed** (`aa89b90`). Beep switch skipped when its key collides with the light control. |

## CodeRabbit findings

All 41 triaged. Fixed in `a8de52e`, `ad6b69d`, `4c076fd`, `12378bb`, `1017708`.

### Fixed

| # | Location | Finding | Disposition |
| --- | --- | --- | --- |
| F2 | `src/device/models.ts` | `resolveModel` indexed a plain object with a wire-supplied `modelid`; `constructor`/`toString`/`__proto__` returned inherited members and the `??` fallback never fired. | Fixed — new `findModel()` using `Object.hasOwn`; the same raw-index bug in `platform.ts` fixed too. |
| F3 | `src/airctrl/discovery.ts` | One oversized interface (docker0 `/16`, APIPA link-local) made `hostsInSubnet` throw and aborted the entire no-argument scan — the UI Scan button failed outright. | Fixed — per-CIDR `try/catch`, warns and skips. |
| F4 | `src/airctrl/discovery.ts` | A non-IPv4 entry in `options.hosts` threw from the sort comparator, rejecting *after* all probing work. | Fixed — hosts filtered by `isIpv4` up front. |
| F5 | `src/airctrl/coap/socket.ts` | The unconnected socket accepted datagrams from any source whose 4-byte token matched (`rinfo` ignored). | Fixed — source filter added. Introduced a hostname regression; see R2. |
| F6 | `src/airctrl/client.ts` | A single failed `connect()` resync aborted all remaining retries. | Fixed — falls through to the next attempt, still bounded by the deadline. |
| F7 | `src/accessory.ts` | **Highest user-visible risk.** Optional services were gated on the *first* status snapshot and cached services were `removeService`d on that basis — a partial first report permanently dropped sensors and **destroyed HomeKit room assignments and automations**. | Fixed — `syncOptionalServices()` re-evaluates on every status; `removeService` only on model-level absence. See D1/D2 for accepted trade-offs. |
| F8 | `src/platform.ts` | `markOffline` poisoned every characteristic; recovery relied on `attach()` re-registering the same set, so stray characteristics threw `SERVICE_COMMUNICATION_FAILURE` forever. | Fixed — poisoned characteristics and prior values recorded, restored by `clearOffline`. Introduced a placement regression; see R1. |
| F10 | `scripts/explore.mjs` | A failing restore aborted the remaining hardware restores (including power) and `process.exit(0)` in `finally` swallowed the code — the "restores every value it touched" guarantee was not held. | Fixed — every restore attempted; `process.exitCode` set on failure. |
| F17 | `config.schema.json` | `model` was persisted and rendered but undeclared, so `showSchemaForm()` could drop it. | Fixed — declared. |
| F18 | `homebridge-ui/public/index.html` | A toggle checkbox kept its new visual state when the save threw. | Fixed — reverts on failure. |
| F19 | design spec | Spec promised Lightbulb `Brightness` that was never implemented. | Fixed in the **doc** — the scope cut was intentional; spec now says so. |
| F20 | plan | **The protocol-invariant grep gate failed open**: `grep` without `-r` errored on a directory and `\|\| echo` reported success, so the gate guarding `nextKey`'s `>>> 0` and read-only `D03105` could never fail. | Fixed — rewritten to fail closed. Verified by executing it against an injected violation. |
| F21 | `scripts/README.md` | An `&&` chain skipped `npm uninstall coap` on non-zero exit, risking a stray CoAP devDependency in a repo that deliberately has none. | Fixed. |
| F22 | `scripts/gen-tasks.mjs` | A missing `process.argv[2]` silently dropped `lastUpdated`. | Fixed — throws. |
| F23 | `src/device/coordinator.ts` | Rated *trivial* by CodeRabbit; **treated as major**. A throwing listener escaped `ingest()` via synchronous `emit()`, marking the device unavailable, cycling the connection, or aborting a successful reconnect. The accessory layer throws `HapStatusError`, so this was live. | Fixed — `safeEmit` over `rawListeners` with per-listener `try/catch` and an error log. `once` semantics verified preserved. |
| F24 | `src/platform.ts` | A UUID collision discarded a coordinator with no log; a configured device silently never appeared. | Fixed — warning names both hosts and the UUID. |
| F26 | `src/airctrl/coap/socket.ts` | `Buffer.from(payload as string)` cast lied about a `string \| Buffer`. | Fixed — `Buffer.isBuffer` narrowing. |
| F27 | `homebridge-ui/public/index.html` | `devices.length` threw when `/scan` returned no array, hiding the cause behind a generic "Scan failed." | Fixed — defaults to `[]`. |
| F28 | `homebridge-ui/server.js` | A bare `catch` discarded the probe error, so a decrypt fault looked identical to a wrong IP — the exact path where a crypto bug would surface. | Fixed — reason included. |
| F32 | `test/ui.test.ts` | No test for the `port` range validation branch. | Fixed — test added. |
| F35 | `test/coap-message.test.ts` | The CoAP option **delta** extension nibble (>= 13) was never exercised — hand-written codec with no third-party fallback. | Fixed — round-trip coverage added. |
| F36 | `test/coap-socket.test.ts` | Fixed `setTimeout(100)` instead of `vi.waitFor` (CI flake risk). | Fixed for the positive case only; the negative case correctly keeps a settle delay, since `waitFor` on "nothing arrived" proves nothing. |
| F37 | `test/crypto.test.ts` | No malformed/truncated-blob case for `decrypt`; only digest tampering was covered. | Fixed — `decrypt()` now validates blob shape and throws a typed `MalformedPayloadError` instead of leaking a raw OpenSSL error. Crypto algorithm untouched. |
| F38 | `test/schema.test.ts` | Hard-coded `toHaveLength(59)` broke on fixture regeneration. | Fixed — asserts key-set equality (strictly stronger: catches both dropped and invented keys). |
| F39 | `test/discovery.test.ts` | No coverage of the default interface-derived `discover()` path. | Fixed — test added; it fails without F3. |
| F40 | `test/coordinator.test.ts` | `retryStart()` — the API added for the corrected startup-availability requirement — had no test at all. | Fixed — covers backoff arming, no-double-arm, and no-retry-after-shutdown. |

### Regressions introduced by the fixes, then fixed

| # | Finding | Disposition |
| --- | --- | --- |
| R1 | **Important.** `src/platform.ts` — F8's `clearOffline()` ran before two paths that abandon the accessory (duplicate device id, and the `catch`), leaving a still-registered cached accessory serving restored stale values with no handlers. Hazard did not exist before F8, because nothing ever un-poisoned. | Fixed (`1017708`) — `clearOffline` moved after the claim check, `markOffline` added to the `catch`. |
| R2 | F5's source filter dropped every reply for a hostname-configured `host` (e.g. `purifier.local`), which `dgram.send` resolves fine. `PluginConfigSchema` only requires a non-empty string, so a hand-edited `config.json` would time out forever with nothing logged. | Fixed (`1017708`) — address check applied only for literal-IP hosts (`node:net`'s `isIP`); port check retained; `debuglog` added so a drop is never silent. |

### Dismissed — false positives or stale

| # | Location | Finding | Reason for dismissal |
| --- | --- | --- | --- |
| F1 | `test/platform.test.ts` | *Critical:* `toHaveLength` on a `Set` "cannot pass". | **False positive, verified empirically.** Vitest 3 / chai support `.length` on `Set`/`Map` via `.size`. `expect(new Set([1])).toHaveLength(1)` passes; `toHaveLength(0)` throws. The assertion is live. |
| F12 | `src/device/keys.ts` | `BEEP` aliases `DISPLAY_BACKLIGHT` (`uil`), so AC2729 exposes two controls writing the same field. | **Already fixed** in `aa89b90` (audit finding A5). CodeRabbit read the registry but not the accessory wiring. |
| F14 | plan (doc) | Discovery responses injected into `innerHTML` — LAN host could XSS the Homebridge admin UI. | **Stale plan text; implementation is safe.** `homebridge-ui/public/index.html` builds nodes with `createElement`/`textContent`. Verified: no `innerHTML`/`outerHTML`/`insertAdjacentHTML` anywhere under `homebridge-ui/`. Only the plan document was wrong. |
| F15 | plan (doc) | `setUpDevice()` awaits `start()`, so a failed initial connect prunes the accessory and never reconnects. | **Stale plan text; implementation is correct** as of `3c5646f`/`95f28fd`. This was real — see audit finding A1 — and the plan has since been corrected. |
| F13 | `src/device/models.ts` | `powerValues`/`detectGeneration` hardcode `'D03102'`, `'D03-02'`, `'pwr'` instead of importing `keys.ts` constants. | **Declined.** These are firmware-dictated protocol constants, the same class as `JiangPan`. The indirection buys no safety — the literals cannot change without the device changing. |
| F16 | plan (doc) | `StrictHostKeyChecking=no` with `sshpass` in the deploy snippet. | **Real as written, but scoped to a local dev deploy recipe in a plan document**, not shipped plugin code. No runtime exposure. Recorded; SSH keys with pinned `known_hosts` is the better practice if that script is ever generalised. |
| F25 | `src/platform.ts` | Serial device setup means N offline hosts add N connect timeouts to startup; suggested `Promise.all`. | **Declined.** With retry-on-failure now in place the startup path no longer blocks on a full timeout chain as described, and CodeRabbit itself notes `Promise.all` makes the duplicate-UUID claim test non-deterministic. Not worth the concurrency for a handful of purifiers. |
| F30, F31 | `scripts/coap-spike.mjs` | Duplicated option building; a leaked handler entry in an uncalled branch; `0.01 * 100` float. | **Declined.** Spike script, superseded by `src/airctrl/coap/`. |
| F33 | `test/ui.test.ts` | Source-text assertions against `index.html` are brittle. | **Declined** — acknowledged by the reviewer as an acceptable cheap guardrail. Behavioural coverage now lives in `config-ops.js` tests. |
| F9, F11, F29, F34 | scripts / tests | `gen-tasks.mjs` section scanning; duplicate fake device in `coap-socket.test.ts`; `push` throwing synchronously in the fake device; weak `toMatchObject({ constructor: … })`. | **Deferred as minor.** Local tooling and test-only ergonomics; no shipped-code impact. |

## Deferred — accepted trade-offs and known gaps

These are real, understood, and not blocking. Recorded so they are not rediscovered as surprises.

| # | Item | Why deferred |
| --- | --- | --- |
| D1 | F7's fix widened behaviour: `CHILD_LOCK` and `BEEP` are now **registry-gated**, while sensors, filters and the lamp remain **payload-gated** for creation. A model whose registry over-claims `CHILD_LOCK` yields a characteristic reporting a *false* unlocked state and writing a key the device ignores. | Defensible — the registry is hardware-derived, and the payload-gated alternative is exactly the bug F7 fixed. Recorded as an accepted trade-off, not as "no behaviour change". A comment explaining the asymmetry would stop someone "harmonising" the two paths and reintroducing F7. |
| D2 | A cached optional service kept because the model supports it, but whose keys have not yet been reported, serves its last cached value indefinitely rather than "No Response". | One lie traded for a smaller one — the previous behaviour destroyed room assignments irreversibly; a stale reading is recoverable. Clean completion: a throwing `onGet` until the key first appears. |
| D3 | A3's `RotationSpeed` fix is **Gen3 only**. Gen1/Gen2 models in Auto still report `RotationSpeed` 0 while `Active` is ACTIVE. | The only hardware available is the Gen3 AC4220. `Gen1Key.SPEED` (`om`) reports the real running speed even in Auto, so a symmetrical fallback exists. Untestable here. |
| D4 | `safeEmit` catches synchronous throws only; an `async` listener returning a rejected promise still escapes. | Latent, not live — no current listener is async. |
| D5 | `discovery.ts` silently drops non-IPv4 entries from `options.hosts`. | A one-line warning matching the subnet path's style would close it. |
| D6 | The rewritten invariant gate's comment filter (`grep -vE ':\s*(//\|\*)'`) is unanchored; a violation on a line also containing a later `: //` could be suppressed. | Contrived. Anchoring to `^[^:]*:[0-9]+:\s*(//\|\*)` would close it. |
| D7 | `platform.ts`'s `offlined` map is never pruned on `discard`/`shutdown`. | Bounded by device count; cosmetic. |
| D8 | `decrypt()` does no length check before slicing in some paths; `PluginConfigSchema` uses `looseObject` where the others use `object`; no non-string-host test. | Carried from earlier task reviews; low impact. |

## Verification at `1017708`

Run by the controller, not taken from an implementer's report:

- `npx tsc --noEmit` — clean
- `npm run lint` (`eslint .`) — clean
- `npm test` (`vitest run`) — 13 files, **226 tests, all passing**, output pristine
- `npm run build` (`tsc`) — clean

## Outstanding

1. ~~Codex adversarial review~~ — **resolved by user ruling 2026-07-31: dropped from the gate.** CodeRabbit alone satisfies Task 12.
2. **Task 11, hardware verification** — was blocked. `192.168.20.21` (Homebridge/unraid) and `192.168.20.151` (AC4220) are both unreachable: no ICMP, TCP 22/8581 refused, `curl` returns `000`, and the CoAP spike times out on `/sys/dev/info`. Gateway responds; ARP entries are present but stale.
