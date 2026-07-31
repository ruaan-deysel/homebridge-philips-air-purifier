# Hardware probe scripts

Standalone Node scripts for talking to a real Philips purifier. They are not part
of the plugin build or test suite (`tsconfig.json` only includes `src/`, and
`eslint.config.js` ignores this directory).

## `coap-spike.mjs` — the canonical probe

**Zero dependencies.** Carries its own RFC 7252 codec and `node:dgram`
transport, so it runs on a bare checkout.

```bash
node scripts/coap-spike.mjs 192.168.20.151          # read-only
node scripts/coap-spike.mjs 192.168.20.151 --write  # also round-trips the beep key
```

Runs a codec self-check, then live: `/sys/dev/info`, the sync handshake,
an observed status read with `Max-Age` and full decrypted payload, push
counting, and proactive observe cancellation. `--write` toggles `D03130`
and restores the original value.

This is the script referenced by the implementation plan's verification steps.
It replaced an earlier `spike.mjs` that depended on the `coap` npm package.

## `explore.mjs`, `explore2.mjs` — historical key-domain probes

These produced the hardware findings recorded in
`docs/superpowers/specs/2026-07-30-homebridge-philips-air-design.md` (that
`D03105` is read-only, that `D03130` is stored as 0/100, that `D0310C=5` is
Turbo, that `D03137` is not writable).

**They still import the `coap` npm package, which is no longer a dependency**, so
they will not run as-is. Their findings are already captured in the spec and
encoded as tests, so re-running them is rarely needed. To do so anyway:

```bash
npm i -D coap; node scripts/explore.mjs 192.168.20.151; npm uninstall coap
```

Semicolons, not `&&` — `npm uninstall coap` must run even if the probe script
exits non-zero, or the repo is left with a stray devDependency it deliberately
does not carry.

Both restore every value they touch.

## `gen-tasks.mjs`

Regenerates `<plan>.tasks.json` from the plan document so task descriptions
cannot drift from the plan. Run from the repo root:

```bash
node scripts/gen-tasks.mjs "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
```
