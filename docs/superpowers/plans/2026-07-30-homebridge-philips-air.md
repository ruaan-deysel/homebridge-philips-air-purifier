# homebridge-philips-air Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers-extended-cc:subagent-driven-development (recommended) or superpowers-extended-cc:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a Homebridge dynamic platform plugin that exposes Philips air purifiers to HomeKit over encrypted CoAP, with the device protocol ported from Python to TypeScript inside this package.

**Architecture:** Four layers with one-way dependencies: `crypto` (pure functions) → `client` (one device's CoAP conversation) → `coordinator` (liveness, observe stream, change detection) → `accessory` (HomeKit characteristic translation). Device capabilities live in flat data tables ported from the Home Assistant integration. A custom Homebridge UI handles discovery and configuration so no JSON is ever hand-edited.

**Tech Stack:** TypeScript (ESM), Node 22/24, Homebridge 2.x, `zod` 4.x, Vitest, `@homebridge/plugin-ui-utils`. CoAP is implemented in-package over `node:dgram` — there is no third-party protocol dependency.

**Global Constraints:**
- **ESM only.** `"type": "module"` in package.json. Homebridge 2 dropped CommonJS; a CJS plugin will not load. All relative imports need explicit `.js` extensions.
- **HAP types come from `homebridge`**, never from `@homebridge/hap-nodejs` directly.
- `engines`: `homebridge: "^2.0.0"`, `node: "^22.12.0 || ^24.0.0"`.
- **`nextKey` must use `>>> 0`, never `& 0xFFFFFFFF`.** JS `&` is signed 32-bit; the direct Python transliteration corrupts keys above `0x7FFFFFFF`.
- **CoAP is ours, and stays minimal.** NON messages only (`type = 1`), `GET`/`POST`
  only, three options (`Uri-Path` 11, `Observe` 6, `Max-Age` 14). No CON/ACK
  retransmission, no block-wise transfer, no DTLS, no server mode, no multicast.
  Do not add protocol surface that no endpoint in this plugin uses.
- **Responses are matched to requests by token, not message ID.** Observe
  notifications reuse the original request's token; matching on message ID would
  drop every push.
- **A `status: "success"` ACK from `/sys/dev/control` means accepted, not applied.** Verified on hardware: ignored writes still ACK. Never apply writes optimistically — the observe stream is the only source of truth.
- **Never publish a characteristic update unless the value actually changed.** The device pushes ~2×/second.
- **The device key is the part before `#`.** Registry keys like `D03105#1` are variant discriminators, not device keys.
- No analytics. No unhandled exceptions. Any files written go in the Homebridge storage dir.
- `.env` holds live credentials, is gitignored, and must never be committed.

**User decisions (already made):**
- Presets map to **discrete `RotationSpeed` steps**, not one switch per preset and not a Television input selector.
- v1 ports the full 62-model registry but claims **verified support only for AC4220/12** plus a generation-based generic fallback.
- Setup is **network scan with manual-IP fallback** in a custom UI, not manual-only and not a plain generated form.
- Development uses a **local spike for the inner loop, then deploy to Unraid** — not deploy-every-iteration, not mock-first.
- Code review uses **CodeRabbit CLI plus a Codex adversarial pass**.

**Reference material** (read before starting, all verified against hardware):
- `docs/superpowers/specs/2026-07-30-homebridge-philips-air-design.md` — the design
- `test/fixtures/ac4220-12-status.json` — real 59-key device payload
- `scripts/README.md` — what each probe script is and how to run it
- `scripts/explore.mjs`, `scripts/explore2.mjs` — the probes that produced the hardware findings. They predate the `coap` dependency being dropped and need a throwaway `npm i -D coap` to run again; their findings are already in the spec.
- `scripts/coap-spike.mjs` — **the working reference implementation of Tasks 2 and 4.** Contains a passing RFC 7252 codec, a `node:dgram` transport with token matching, and verified observe registration and cancellation against the real device. Port from this rather than writing from scratch.
- Python source to port: clone `https://github.com/ruaan-deysel/philips-airctrl` and `https://github.com/ruaan-deysel/ha-philips-airpurifier`

**Deployment target** (verified by inspection):
- Homebridge 2.2.1, Node 24.18.0, in Docker container `homebridge` from `homebridge/homebridge:latest`
- Container `/var/lib/homebridge` → `/homebridge`; host path `/mnt/cache/appdata/homebridge`
- Plugins install to `/mnt/cache/appdata/homebridge/node_modules`
- UI at `192.168.20.21:8581`, credentials in `.env`
- Test device: AC4220/12 at `192.168.20.151`, firmware `AWS_Philips_AIR_Combo@86`

---

### Task 0: Scaffold the ESM plugin package

**Goal:** A buildable, testable, lintable Homebridge 2 plugin skeleton that registers an empty platform.

**Files:**
- Create: `package.json`, `tsconfig.json`, `eslint.config.js`, `vitest.config.ts`
- Create: `src/settings.ts`, `src/index.ts`
- Create: `test/scaffold.test.ts`

**Acceptance Criteria:**
- [ ] `npm run build` emits `dist/index.js` as ESM with no TypeScript errors
- [ ] `npm test` passes
- [ ] `npm run lint` passes
- [ ] `package.json` has `"type": "module"`, correct `engines`, and `homebridge-plugin` in `keywords`
- [ ] `files` includes `dist`, `config.schema.json`, and `homebridge-ui` so the custom UI ships

**Verify:** `npm run build && npm test && npm run lint` → all exit 0, `dist/index.js` exists

**Steps:**

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "homebridge-philips-air",
  "displayName": "Philips Air Purifier",
  "version": "0.1.0",
  "description": "HomeKit support for Philips air purifiers over encrypted CoAP, with no Python dependency.",
  "author": "Ruaan Deysel",
  "license": "MIT",
  "type": "module",
  "main": "dist/index.js",
  "engines": {
    "homebridge": "^2.0.0",
    "node": "^22.12.0 || ^24.0.0"
  },
  "keywords": [
    "homebridge-plugin",
    "philips",
    "air-purifier",
    "airpurifier",
    "coap"
  ],
  "files": [
    "dist",
    "config.schema.json",
    "homebridge-ui"
  ],
  "scripts": {
    "build": "tsc",
    "watch": "tsc --watch",
    "test": "vitest run",
    "lint": "eslint .",
    "prepublishOnly": "npm run build"
  },
  "dependencies": {
    "@homebridge/plugin-ui-utils": "^2.0.0",
    "zod": "^4.4.3"
  },
  "devDependencies": {
    "@eslint/js": "^9.0.0",
    "@types/node": "^24.0.0",
    "@typescript-eslint/eslint-plugin": "^8.0.0",
    "@typescript-eslint/parser": "^8.0.0",
    "eslint": "^9.0.0",
    "homebridge": "^2.2.1",
    "typescript": "^5.6.0",
    "vitest": "^3.0.0"
  }
}
```

- [ ] **Step 2: Create `tsconfig.json`**

`module: nodenext` is required — it makes TypeScript emit real ESM and enforce explicit `.js` import extensions, which is what Node needs at runtime.

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "nodenext",
    "moduleResolution": "nodenext",
    "outDir": "./dist",
    "rootDir": "./src",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "declaration": true,
    "sourceMap": true
  },
  "include": ["src/**/*.ts"],
  "exclude": ["node_modules", "dist", "test"]
}
```

- [ ] **Step 3: Create `vitest.config.ts` and `eslint.config.js`**

```typescript
// vitest.config.ts
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
  },
})
```

`js.configs.recommended` alone cannot parse TypeScript — type annotations are
syntax errors to the default parser — so the TS parser and its `no-unused-vars`
replacement are both required. The base rule must be switched off, or it
double-reports on type-only references.

```javascript
// eslint.config.js
import js from '@eslint/js'
import tsPlugin from '@typescript-eslint/eslint-plugin'
import tsParser from '@typescript-eslint/parser'

export default [
  js.configs.recommended,
  {
    files: ['**/*.ts'],
    languageOptions: {
      parser: tsParser,
      ecmaVersion: 2022,
      sourceType: 'module',
    },
    plugins: {
      '@typescript-eslint': tsPlugin,
    },
    rules: {
      // The base rule cannot see type-only usages; the TS-aware one replaces it.
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
  // scripts/ holds standalone hardware probes, outside the build and the suite.
  { ignores: ['dist/**', 'node_modules/**', 'scripts/**'] },
]
```

- [ ] **Step 4: Create `src/settings.ts`**

```typescript
/** Must match `pluginAlias` in config.schema.json. */
export const PLATFORM_NAME = 'PhilipsAir'

/** Must match the `name` field in package.json. */
export const PLUGIN_NAME = 'homebridge-philips-air'
```

- [ ] **Step 5: Create `src/index.ts`**

```typescript
import type { API } from 'homebridge'
import { PLATFORM_NAME } from './settings.js'

export default (api: API): void => {
  // PhilipsAirPlatform is registered here in Task 8. Registering a no-op
  // placeholder now keeps the package loadable and the build honest.
  api.registerPlatform(PLATFORM_NAME, class {
    constructor() {}
    configureAccessory(): void {}
  } as never)
}
```

- [ ] **Step 6: Create `test/scaffold.test.ts`**

```typescript
import { describe, expect, it } from 'vitest'
import { PLATFORM_NAME, PLUGIN_NAME } from '../src/settings.js'

describe('scaffold', () => {
  it('exposes the platform and plugin names', () => {
    expect(PLATFORM_NAME).toBe('PhilipsAir')
    expect(PLUGIN_NAME).toBe('homebridge-philips-air')
  })
})
```

- [ ] **Step 7: Install and verify**

```bash
npm install
npm run build && npm test && npm run lint
ls dist/index.js
```

Expected: build emits `dist/index.js`, one test passes, lint clean.

- [ ] **Step 8: Commit**

```bash
git add package.json package-lock.json tsconfig.json eslint.config.js vitest.config.ts src test
git commit -m "Scaffold ESM Homebridge 2 plugin package"
```

---

### Task 1: Port the encryption layer

**Goal:** `src/airctrl/crypto.ts` — pure functions for the Philips AES-CBC scheme, with a regression test for the signed-32-bit hazard.

**Files:**
- Create: `src/airctrl/crypto.ts`
- Create: `test/crypto.test.ts`

**Acceptance Criteria:**
- [ ] `encrypt`/`decrypt` round-trip arbitrary JSON strings
- [ ] `decrypt` throws `DigestMismatchError` on a tampered digest
- [ ] `nextKey` matches Python's unsigned semantics at `7FFFFFFF`, `80000000`, and `FFFFFFFF`
- [ ] Key/IV derivation matches the recorded vector for key `0DC377BA`
- [ ] Zero runtime dependencies — `node:crypto` only

**Verify:** `npx vitest run test/crypto.test.ts` → 5 tests pass

**Steps:**

- [ ] **Step 1: Write the failing tests**

The `nextKey` vectors come from running the Python expression directly; they are
the authority. `& 0xFFFFFFFF` in JS returns `-80000000` for the first case, which
is why this test exists.

```typescript
// test/crypto.test.ts
import { describe, expect, it } from 'vitest'
import { DigestMismatchError, decrypt, deriveKeyAndIv, encrypt, nextKey } from '../src/airctrl/crypto.js'

describe('nextKey', () => {
  // Python: (int(k, 16) + 1) & 0xFFFFFFFF, formatted as 4 big-endian bytes.
  // JS `&` is SIGNED 32-bit and returns -80000000 for the first case.
  it.each([
    ['0DC377BA', '0DC377BB'],
    ['0000000F', '00000010'],
    ['7FFFFFFF', '80000000'], // regression: signed AND breaks here
    ['80000000', '80000001'], // regression: signed AND breaks here
    ['FFFFFFFF', '00000000'], // wraps to zero
  ])('increments %s to %s', (input, expected) => {
    expect(nextKey(input)).toBe(expected)
  })
})

describe('deriveKeyAndIv', () => {
  it('derives key and IV from MD5("JiangPan" + clientKey)', () => {
    const { key, iv } = deriveKeyAndIv('0DC377BA')
    // MD5("JiangPan0DC377BA") = 58C810828608D8F6E4C37DBC8DAC1FC9
    expect(key.toString('ascii')).toBe('58C810828608D8F6')
    expect(iv.toString('ascii')).toBe('E4C37DBC8DAC1FC9')
  })
})

describe('encrypt / decrypt', () => {
  it('round-trips a JSON payload', () => {
    const payload = JSON.stringify({ state: { desired: { D03102: 1 } } })
    expect(decrypt(encrypt('0DC377BA', payload))).toBe(payload)
  })

  it('produces key + ciphertext + 64-char digest, all uppercase hex', () => {
    const blob = encrypt('0DC377BA', '{"test":1}')
    expect(blob.slice(0, 8)).toBe('0DC377BA')
    expect(blob).toHaveLength(8 + 32 + 64) // 10 bytes padded to 32 hex chars
    expect(blob).toBe(blob.toUpperCase())
  })

  it('throws DigestMismatchError when the digest is tampered with', () => {
    const blob = encrypt('0DC377BA', '{"test":1}')
    const tampered = `${blob.slice(0, -1)}${blob.at(-1) === '0' ? '1' : '0'}`
    expect(() => decrypt(tampered)).toThrow(DigestMismatchError)
  })
})
```

- [ ] **Step 2: Run to verify it fails**

```bash
npx vitest run test/crypto.test.ts
```

Expected: FAIL — `Cannot find module '../src/airctrl/crypto.js'`

- [ ] **Step 3: Implement `src/airctrl/crypto.ts`**

```typescript
import { createCipheriv, createDecipheriv, createHash } from 'node:crypto'

/**
 * Fixed secret baked into Philips firmware. Not a security choice this plugin
 * makes — the device will not talk to us without it.
 */
const SECRET_KEY = 'JiangPan'

export class DigestMismatchError extends Error {
  constructor(expected: string, actual: string) {
    super(`payload digest mismatch: expected ${expected}, computed ${actual}`)
    this.name = 'DigestMismatchError'
  }
}

/**
 * The device derives both key and IV from one MD5 hash, then uses the ASCII
 * bytes of the hex digits (not the raw hash bytes) as AES material.
 */
export function deriveKeyAndIv(clientKey: string): { key: Buffer, iv: Buffer } {
  const digest = createHash('md5').update(SECRET_KEY + clientKey).digest('hex').toUpperCase()
  return {
    key: Buffer.from(digest.slice(0, 16), 'ascii'),
    iv: Buffer.from(digest.slice(16), 'ascii'),
  }
}

/**
 * Increment the rolling client key, wrapping at 32 bits.
 *
 * Uses `>>> 0`, NOT `& 0xFFFFFFFF`. JavaScript's bitwise AND operates on SIGNED
 * 32-bit integers, so `0x80000000 & 0xFFFFFFFF` is -2147483648 and formats as
 * "-80000000". Since sync keys are random, roughly half of all sessions would
 * eventually cross this boundary and corrupt every later control write.
 */
export function nextKey(clientKey: string): string {
  const incremented = (Number.parseInt(clientKey, 16) + 1) >>> 0
  return incremented.toString(16).padStart(8, '0').toUpperCase()
}

/** Build the wire payload: clientKey + ciphertextHex + sha256(clientKey + ciphertextHex). */
export function encrypt(clientKey: string, payload: string): string {
  const { key, iv } = deriveKeyAndIv(clientKey)
  const cipher = createCipheriv('aes-128-cbc', key, iv) // PKCS7 padding is the default
  const ciphertext = Buffer
    .concat([cipher.update(payload, 'utf8'), cipher.final()])
    .toString('hex')
    .toUpperCase()
  const digest = createHash('sha256').update(clientKey + ciphertext).digest('hex').toUpperCase()
  return clientKey + ciphertext + digest
}

/** Verify the digest and decrypt. The key travels in the payload's first 8 chars. */
export function decrypt(blob: string): string {
  const clientKey = blob.slice(0, 8)
  const ciphertext = blob.slice(8, -64)
  const digest = blob.slice(-64)
  const computed = createHash('sha256').update(clientKey + ciphertext).digest('hex').toUpperCase()
  if (digest !== computed) throw new DigestMismatchError(digest, computed)

  const { key, iv } = deriveKeyAndIv(clientKey)
  const decipher = createDecipheriv('aes-128-cbc', key, iv)
  return Buffer.concat([decipher.update(Buffer.from(ciphertext, 'hex')), decipher.final()]).toString('utf8')
}
```

- [ ] **Step 4: Run to verify it passes**

```bash
npx vitest run test/crypto.test.ts
```

Expected: PASS, 8 assertions across 5 test blocks.

- [ ] **Step 5: Cross-check against real hardware output**

This proves the port matches the device, not just itself.

```bash
node scripts/coap-spike.mjs 192.168.20.151
```

Expected: `[4] decrypted 59 keys | model AC4220/12` — a digest mismatch throws
instead. This script is dependency-free (it carries its own CoAP codec), so it
runs before Task 2 exists.

- [ ] **Step 6: Commit**

```bash
git add src/airctrl/crypto.ts test/crypto.test.ts
git commit -m "Port Philips AES-CBC encryption to node:crypto

Uses >>> 0 for the client-key increment rather than & 0xFFFFFFFF: JS
bitwise AND is signed 32-bit and corrupts keys above 0x7FFFFFFF, which
random sync keys reach about half the time. Regression tested."
```

---

### Task 2: Implement minimal CoAP over node:dgram

**Goal:** `src/airctrl/coap/message.ts` and `src/airctrl/coap/socket.ts` — just
enough RFC 7252 to talk to Philips firmware, with no third-party dependency.

**Files:**
- Create: `src/airctrl/coap/message.ts`
- Create: `src/airctrl/coap/socket.ts`
- Create: `test/coap-message.test.ts`
- Create: `test/coap-socket.test.ts`
- Reference: `scripts/coap-spike.mjs` — a working, hardware-verified version of both files. Port from it.

**Acceptance Criteria:**
- [ ] `encode` produces the exact golden bytes for `GET /sys/dev/status` with Observe: `54011234deadbeef60537379730364657606737461747573`
- [ ] `encode` produces the exact golden bytes for `POST /sys/dev/sync` with payload `ABCD1234`: `5402000101020304b3737973036465760473796e63ff4142434431323334`
- [ ] `decode(encode(m))` round-trips type, code, messageId, token, options and payload
- [ ] Option lengths ≥ 13 and ≥ 269 use the 13/14 extension nibbles correctly in both directions
- [ ] `uintToBuffer` emits shortest-form big-endian: `0` → empty, `60` → `3c`, `900` → `0384`
- [ ] `decode` rejects a message shorter than 4 bytes, an unsupported version, a token length > 8, and the reserved nibble 15
- [ ] Options are emitted sorted by number, so a caller passing Uri-Path before Observe still produces a valid delta chain
- [ ] `CoapSocket.request()` resolves the matching response, matched **by token**
- [ ] `CoapSocket.observe()` resolves the first response and invokes `onNotify` for each later push
- [ ] `observe().cancel()` sends the same token with `Observe: 1` and stops notifications
- [ ] A response with an unknown token is ignored rather than throwing
- [ ] A malformed datagram is ignored rather than crashing the socket
- [ ] `request()` rejects on timeout and cleans up its handler (no leak)
- [ ] Only `node:dgram` and `node:crypto` are imported — no third-party packages

**Verify:** `npx vitest run test/coap-message.test.ts test/coap-socket.test.ts` → all tests pass; then `node scripts/coap-spike.mjs 192.168.20.151` prints `codec self-check: PASS`, `Max-Age 60`, `59 keys`, and `after proactive cancel, further pushes: 0`

**Steps:**

- [ ] **Step 1: Write the failing codec tests**

The golden byte strings below were produced by the working spike and verified
against the real device. They are the authority — if the implementation disagrees,
the implementation is wrong.

```typescript
// test/coap-message.test.ts
import { describe, expect, it } from 'vitest'
import {
  CoapCode,
  CoapOption,
  CoapType,
  bufferToUint,
  decode,
  encode,
  uintToBuffer,
} from '../src/airctrl/coap/message.js'

const uriPath = (path: string) =>
  path.split('/').filter(Boolean).map(segment => ({ number: CoapOption.UriPath, value: Buffer.from(segment) }))

describe('uintToBuffer / bufferToUint', () => {
  it.each([
    [0, ''],
    [60, '3c'],
    [900, '0384'],
    [0xFFFFFF, 'ffffff'],
  ])('encodes %i as shortest-form big-endian %s', (value, hex) => {
    expect(uintToBuffer(value).toString('hex')).toBe(hex)
  })

  it('round-trips', () => {
    for (const value of [0, 1, 60, 900, 0xFFFF, 0xFFFFFF]) {
      expect(bufferToUint(uintToBuffer(value))).toBe(value)
    }
  })
})

describe('encode golden vectors', () => {
  it('encodes GET /sys/dev/status with Observe', () => {
    const bytes = encode({
      type: CoapType.NonConfirmable,
      code: CoapCode.GET,
      messageId: 0x1234,
      token: Buffer.from('deadbeef', 'hex'),
      options: [...uriPath('/sys/dev/status'), { number: CoapOption.Observe, value: uintToBuffer(0) }],
    })
    expect(bytes.toString('hex')).toBe('54011234deadbeef60537379730364657606737461747573')
  })

  it('encodes POST /sys/dev/sync with a payload', () => {
    const bytes = encode({
      type: CoapType.NonConfirmable,
      code: CoapCode.POST,
      messageId: 1,
      token: Buffer.from('01020304', 'hex'),
      options: uriPath('/sys/dev/sync'),
      payload: Buffer.from('ABCD1234'),
    })
    expect(bytes.toString('hex')).toBe('5402000101020304b3737973036465760473796e63ff4142434431323334')
  })

  it('sorts options by number regardless of caller order', () => {
    const observeFirst = encode({
      code: CoapCode.GET,
      messageId: 0x1234,
      token: Buffer.from('deadbeef', 'hex'),
      options: [{ number: CoapOption.Observe, value: uintToBuffer(0) }, ...uriPath('/sys/dev/status')],
    })
    expect(observeFirst.toString('hex')).toBe('54011234deadbeef60537379730364657606737461747573')
  })
})

describe('decode', () => {
  it('round-trips a full message', () => {
    const original = {
      type: CoapType.NonConfirmable,
      code: CoapCode.POST,
      messageId: 0xBEEF,
      token: Buffer.from('0a0b0c0d', 'hex'),
      options: [...uriPath('/sys/dev/control'), { number: CoapOption.MaxAge, value: uintToBuffer(60) }],
      payload: Buffer.from('{"a":1}'),
    }
    const decoded = decode(encode(original))
    expect(decoded.type).toBe(CoapType.NonConfirmable)
    expect(decoded.code).toBe(CoapCode.POST)
    expect(decoded.messageId).toBe(0xBEEF)
    expect(decoded.token.toString('hex')).toBe('0a0b0c0d')
    expect(decoded.payload.toString()).toBe('{"a":1}')
    expect(decoded.options.filter(o => o.number === CoapOption.UriPath).map(o => o.value.toString()))
      .toEqual(['sys', 'dev', 'control'])
    expect(bufferToUint(decoded.options.find(o => o.number === CoapOption.MaxAge)!.value)).toBe(60)
  })

  it.each([13, 268, 269, 1000])('round-trips an option of length %i via the extension nibbles', (length) => {
    const decoded = decode(encode({
      code: CoapCode.GET,
      messageId: 1,
      options: [{ number: CoapOption.UriPath, value: Buffer.alloc(length, 0x61) }],
    }))
    expect(decoded.options[0]!.value.length).toBe(length)
  })

  it('parses a 2.05 Content response code', () => {
    const decoded = decode(encode({ code: 69, messageId: 1 })) // 2.05 = (2 << 5) | 5
    expect(decoded.code).toBe(69)
    expect(decoded.code >> 5).toBe(2)
    expect(decoded.code & 0x1F).toBe(5)
  })

  it('rejects malformed input', () => {
    expect(() => decode(Buffer.alloc(3))).toThrow(/4 bytes/)
    expect(() => decode(Buffer.from([0x00, 0x01, 0x00, 0x01]))).toThrow(/version/) // version 0
    expect(() => decode(Buffer.from([0x4F, 0x01, 0x00, 0x01]))).toThrow(/token length/) // TKL 15
    expect(() => decode(Buffer.from([0x40, 0x01, 0x00, 0x01, 0xF0]))).toThrow(/reserved/) // nibble 15
  })

  it('handles a message with no options and no payload', () => {
    const decoded = decode(encode({ code: CoapCode.GET, messageId: 7 }))
    expect(decoded.options).toEqual([])
    expect(decoded.payload.length).toBe(0)
  })
})
```

- [ ] **Step 2: Run to verify it fails**

```bash
npx vitest run test/coap-message.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/airctrl/coap/message.ts`**

```typescript
/**
 * Minimal RFC 7252 codec — only what Philips firmware needs.
 *
 * Deliberately absent: CON/ACK retransmission, block-wise transfer, DTLS,
 * server mode, multicast. Do not add protocol surface no endpoint uses.
 * Pure functions, no I/O, so this is fully testable on byte arrays.
 */

export const CoapType = {
  Confirmable: 0,
  NonConfirmable: 1,
  Acknowledgement: 2,
  Reset: 3,
} as const

export const CoapCode = {
  GET: 1, // 0.01
  POST: 2, // 0.02
} as const

export const CoapOption = {
  Observe: 6,
  UriPath: 11,
  ContentFormat: 12,
  MaxAge: 14,
} as const

export interface CoapOptionEntry {
  number: number
  value: Buffer
}

export interface CoapMessage {
  type?: number
  code: number
  messageId: number
  token?: Buffer
  options?: CoapOptionEntry[]
  payload?: Buffer
}

export interface DecodedCoapMessage {
  type: number
  code: number
  messageId: number
  token: Buffer
  options: CoapOptionEntry[]
  payload: Buffer
}

const PAYLOAD_MARKER = 0xFF

/** Shortest-form big-endian unsigned integer, as CoAP option values require. */
export function uintToBuffer(value: number): Buffer {
  if (value === 0) return Buffer.alloc(0)
  const bytes: number[] = []
  let remaining = value
  while (remaining > 0) {
    bytes.unshift(remaining & 0xFF)
    remaining = Math.floor(remaining / 256)
  }
  return Buffer.from(bytes)
}

export function bufferToUint(buffer: Buffer): number {
  return buffer.reduce((acc, byte) => acc * 256 + byte, 0)
}

/** Option deltas and lengths use 13/14 as escapes for 1- and 2-byte extensions. */
function nibbleFor(value: number): number {
  if (value < 13) return value
  if (value < 269) return 13
  return 14
}

function extensionFor(value: number): Buffer {
  if (value < 13) return Buffer.alloc(0)
  if (value < 269) return Buffer.from([value - 13])
  const buffer = Buffer.alloc(2)
  buffer.writeUInt16BE(value - 269)
  return buffer
}

export function encode(message: CoapMessage): Buffer {
  const token = message.token ?? Buffer.alloc(0)
  if (token.length > 8) throw new Error(`token too long: ${token.length} bytes (max 8)`)

  const header = Buffer.alloc(4)
  header[0] = (1 << 6) | ((message.type ?? CoapType.NonConfirmable) << 4) | token.length
  header[1] = message.code
  header.writeUInt16BE(message.messageId, 2)

  // Deltas are relative to the previous option number, so options must be sorted.
  const sorted = [...(message.options ?? [])].sort((a, b) => a.number - b.number)
  const parts: Buffer[] = [header, token]
  let previous = 0
  for (const { number, value } of sorted) {
    const delta = number - previous
    parts.push(
      Buffer.from([(nibbleFor(delta) << 4) | nibbleFor(value.length)]),
      extensionFor(delta),
      extensionFor(value.length),
      value,
    )
    previous = number
  }

  if (message.payload?.length) parts.push(Buffer.from([PAYLOAD_MARKER]), message.payload)
  return Buffer.concat(parts)
}

export function decode(buffer: Buffer): DecodedCoapMessage {
  if (buffer.length < 4) throw new Error('CoAP message shorter than 4 bytes')

  const version = buffer[0]! >> 6
  if (version !== 1) throw new Error(`unsupported CoAP version ${version}`)

  const type = (buffer[0]! >> 4) & 0x03
  const tokenLength = buffer[0]! & 0x0F
  if (tokenLength > 8) throw new Error(`invalid token length ${tokenLength}`)

  const code = buffer[1]!
  const messageId = buffer.readUInt16BE(2)

  let offset = 4
  const token = buffer.subarray(offset, offset + tokenLength)
  offset += tokenLength

  const options: CoapOptionEntry[] = []
  let number = 0
  while (offset < buffer.length && buffer[offset] !== PAYLOAD_MARKER) {
    const byte = buffer[offset++]!
    const readExtension = (nibble: number): number => {
      if (nibble === 13) return buffer[offset++]! + 13
      if (nibble === 14) {
        const value = buffer.readUInt16BE(offset) + 269
        offset += 2
        return value
      }
      if (nibble === 15) throw new Error('reserved option nibble 15')
      return nibble
    }
    const delta = readExtension(byte >> 4)
    const length = readExtension(byte & 0x0F)
    number += delta
    options.push({ number, value: buffer.subarray(offset, offset + length) })
    offset += length
  }

  const payload = buffer[offset] === PAYLOAD_MARKER ? buffer.subarray(offset + 1) : Buffer.alloc(0)
  return { type, code, messageId, token, options, payload }
}

/** Find the first option with the given number, or undefined. */
export function findOption(options: CoapOptionEntry[], number: number): CoapOptionEntry | undefined {
  return options.find(option => option.number === number)
}

/** Build the repeated Uri-Path options for a path like "/sys/dev/status". */
export function uriPathOptions(path: string): CoapOptionEntry[] {
  return path.split('/').filter(Boolean).map(segment => ({
    number: CoapOption.UriPath,
    value: Buffer.from(segment, 'utf8'),
  }))
}

/** Human-readable code, e.g. 69 -> "2.05". Used in log messages only. */
export function codeToString(code: number): string {
  return `${code >> 5}.${String(code & 0x1F).padStart(2, '0')}`
}
```

- [ ] **Step 4: Run the codec tests**

```bash
npx vitest run test/coap-message.test.ts
```

Expected: PASS, including both golden-byte assertions.

- [ ] **Step 5: Write the failing socket tests**

The fake device is built with our own `encode`, which keeps the test independent
of any library and lets us script exact responses.

```typescript
// test/coap-socket.test.ts
import dgram from 'node:dgram'
import { afterEach, describe, expect, it } from 'vitest'
import { CoapOption, decode, encode, findOption, uintToBuffer } from '../src/airctrl/coap/message.js'
import { CoapSocket } from '../src/airctrl/coap/socket.js'

const CONTENT_2_05 = 69

/** A scriptable fake CoAP device on localhost. */
function fakeDevice(handler: (request: ReturnType<typeof decode>, reply: (m: Parameters<typeof encode>[0]) => void) => void) {
  const server = dgram.createSocket('udp4')
  server.on('message', (buffer, remote) => {
    let request
    try { request = decode(buffer) } catch { return }
    handler(request, message => server.send(encode(message), remote.port, remote.address))
  })
  return {
    server,
    listen: () => new Promise<number>(resolve => server.bind(0, () => resolve(server.address().port))),
    close: () => new Promise<void>(resolve => server.close(() => resolve())),
  }
}

let device: ReturnType<typeof fakeDevice> | null = null
let socket: CoapSocket | null = null

afterEach(async () => {
  socket?.close()
  socket = null
  await device?.close()
  device = null
})

describe('CoapSocket.request', () => {
  it('resolves the response matched by token', async () => {
    device = fakeDevice((request, reply) => {
      reply({ code: CONTENT_2_05, messageId: request.messageId, token: request.token, payload: Buffer.from('pong') })
    })
    const port = await device.listen()
    socket = new CoapSocket('127.0.0.1', port)

    const response = await socket.request({ method: 'GET', path: '/sys/dev/info' })
    expect(response.payload.toString()).toBe('pong')
    expect(response.code).toBe(CONTENT_2_05)
  })

  it('sends the path as repeated Uri-Path options and type NON', async () => {
    let seen: ReturnType<typeof decode> | null = null
    device = fakeDevice((request, reply) => {
      seen = request
      reply({ code: CONTENT_2_05, messageId: request.messageId, token: request.token, payload: Buffer.from('ok') })
    })
    const port = await device.listen()
    socket = new CoapSocket('127.0.0.1', port)

    await socket.request({ method: 'POST', path: '/sys/dev/sync', payload: 'NONCE' })
    expect(seen!.type).toBe(1) // NON
    expect(seen!.options.filter(o => o.number === CoapOption.UriPath).map(o => o.value.toString()))
      .toEqual(['sys', 'dev', 'sync'])
    expect(seen!.payload.toString()).toBe('NONCE')
  })

  it('ignores a response bearing an unknown token, then still resolves the right one', async () => {
    device = fakeDevice((request, reply) => {
      reply({ code: CONTENT_2_05, messageId: 1, token: Buffer.from('ffffffff', 'hex'), payload: Buffer.from('wrong') })
      reply({ code: CONTENT_2_05, messageId: request.messageId, token: request.token, payload: Buffer.from('right') })
    })
    const port = await device.listen()
    socket = new CoapSocket('127.0.0.1', port)

    expect((await socket.request({ method: 'GET', path: '/x' })).payload.toString()).toBe('right')
  })

  it('survives a malformed datagram', async () => {
    device = fakeDevice((request, reply) => {
      device!.server.send(Buffer.from([0x00]), 0, 1, 0, '127.0.0.1') // garbage, ignored
      reply({ code: CONTENT_2_05, messageId: request.messageId, token: request.token, payload: Buffer.from('ok') })
    })
    const port = await device.listen()
    socket = new CoapSocket('127.0.0.1', port)

    expect((await socket.request({ method: 'GET', path: '/x' })).payload.toString()).toBe('ok')
  })

  it('rejects on timeout and leaves no pending handler', async () => {
    device = fakeDevice(() => { /* never replies */ })
    const port = await device.listen()
    socket = new CoapSocket('127.0.0.1', port)

    await expect(socket.request({ method: 'GET', path: '/x', timeoutMs: 100 })).rejects.toThrow(/timeout/)
    expect(socket.pendingCount).toBe(0)
  })
})

describe('CoapSocket.observe', () => {
  it('resolves the first response and streams later pushes', async () => {
    let saved: { token: Buffer, reply: (m: Parameters<typeof encode>[0]) => void } | null = null
    device = fakeDevice((request, reply) => {
      saved = { token: request.token, reply }
      reply({
        code: CONTENT_2_05,
        messageId: request.messageId,
        token: request.token,
        options: [{ number: CoapOption.Observe, value: uintToBuffer(1) }, { number: CoapOption.MaxAge, value: uintToBuffer(60) }],
        payload: Buffer.from('first'),
      })
    })
    const port = await device.listen()
    socket = new CoapSocket('127.0.0.1', port)

    const pushes: string[] = []
    const observation = await socket.observe({ path: '/sys/dev/status', onNotify: m => pushes.push(m.payload.toString()) })

    expect(observation.first.payload.toString()).toBe('first')
    expect(findOption(observation.first.options, CoapOption.MaxAge)).toBeDefined()

    saved!.reply({ code: CONTENT_2_05, messageId: 99, token: saved!.token, payload: Buffer.from('second') })
    await new Promise(resolve => setTimeout(resolve, 100))
    expect(pushes).toEqual(['second'])
  })

  it('cancel() sends the same token with Observe=1 and stops notifications', async () => {
    const requests: ReturnType<typeof decode>[] = []
    let saved: { token: Buffer, reply: (m: Parameters<typeof encode>[0]) => void } | null = null
    device = fakeDevice((request, reply) => {
      requests.push(request)
      const observe = findOption(request.options, CoapOption.Observe)
      if (observe && observe.value.length > 0) return // cancellation, no reply
      saved = { token: request.token, reply }
      reply({ code: CONTENT_2_05, messageId: request.messageId, token: request.token, payload: Buffer.from('first') })
    })
    const port = await device.listen()
    socket = new CoapSocket('127.0.0.1', port)

    const pushes: string[] = []
    const observation = await socket.observe({ path: '/sys/dev/status', onNotify: m => pushes.push(m.payload.toString()) })
    observation.cancel()
    await new Promise(resolve => setTimeout(resolve, 50))

    // The cancellation carries the same token and Observe = 1.
    const cancellation = requests.at(-1)!
    expect(cancellation.token.toString('hex')).toBe(observation.first.token.toString('hex'))
    expect(findOption(cancellation.options, CoapOption.Observe)!.value.toString('hex')).toBe('01')

    // A push arriving after cancellation must be dropped.
    saved!.reply({ code: CONTENT_2_05, messageId: 100, token: saved!.token, payload: Buffer.from('late') })
    await new Promise(resolve => setTimeout(resolve, 100))
    expect(pushes).toEqual([])
    expect(socket.pendingCount).toBe(0)
  })
})
```

- [ ] **Step 6: Run to verify it fails**

```bash
npx vitest run test/coap-socket.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 7: Implement `src/airctrl/coap/socket.ts`**

```typescript
import { createSocket, type Socket } from 'node:dgram'
import { randomBytes, randomInt } from 'node:crypto'
import {
  CoapCode,
  CoapOption,
  CoapType,
  type DecodedCoapMessage,
  decode,
  encode,
  uintToBuffer,
  uriPathOptions,
} from './message.js'

const DEFAULT_TIMEOUT_MS = 8000

export interface RequestOptions {
  method: 'GET' | 'POST'
  path: string
  payload?: string | Buffer
  /** Send the Observe option. Status reads need this even when one-shot. */
  observe?: boolean
  timeoutMs?: number
}

export interface ObserveOptions {
  path: string
  onNotify: (message: DecodedCoapMessage) => void
  onError?: (error: Error) => void
  timeoutMs?: number
}

export interface Observation {
  first: DecodedCoapMessage
  /** Proactively deregister: same token, Observe = 1. */
  cancel: () => void
}

/**
 * A UDP socket speaking just enough CoAP for Philips devices.
 *
 * Responses are matched to requests by TOKEN, not message ID. Observe
 * notifications reuse the original request's token but carry fresh message IDs,
 * so message-ID matching would drop every push.
 */
export class CoapSocket {
  private readonly socket: Socket
  private readonly handlers = new Map<string, (message: DecodedCoapMessage) => void>()
  private messageId: number
  private closed = false

  constructor(
    private readonly host: string,
    private readonly port: number = 5683,
  ) {
    this.messageId = randomInt(0, 0x10000)
    this.socket = createSocket('udp4')
    this.socket.on('message', buffer => this.dispatch(buffer))
    // A socket-level error must not become an unhandled exception; pending
    // requests fail via their own timeouts.
    this.socket.on('error', () => {})
    this.socket.unref()
  }

  /** Number of outstanding requests and live observations. Used by tests. */
  get pendingCount(): number {
    return this.handlers.size
  }

  private dispatch(buffer: Buffer): void {
    let message: DecodedCoapMessage
    try {
      message = decode(buffer)
    } catch {
      return // malformed datagram: ignore, never crash the socket
    }
    this.handlers.get(message.token.toString('hex'))?.(message)
  }

  private nextMessageId(): number {
    this.messageId = (this.messageId + 1) & 0xFFFF
    return this.messageId
  }

  private transmit(
    method: 'GET' | 'POST',
    path: string,
    token: Buffer,
    observeValue?: number,
    payload?: string | Buffer,
  ): void {
    if (this.closed) throw new Error('socket is closed')
    const options = uriPathOptions(path)
    if (observeValue !== undefined) {
      options.push({ number: CoapOption.Observe, value: uintToBuffer(observeValue) })
    }
    this.socket.send(encode({
      type: CoapType.NonConfirmable,
      code: method === 'POST' ? CoapCode.POST : CoapCode.GET,
      messageId: this.nextMessageId(),
      token,
      options,
      payload: payload === undefined ? undefined : Buffer.from(payload as string),
    }), this.port, this.host)
  }

  /** One request, one response. */
  request(options: RequestOptions): Promise<DecodedCoapMessage> {
    const { method, path, payload, observe = false, timeoutMs = DEFAULT_TIMEOUT_MS } = options
    return new Promise((resolve, reject) => {
      const token = randomBytes(4)
      const key = token.toString('hex')

      const timer = setTimeout(() => {
        this.handlers.delete(key)
        reject(new Error(`CoAP timeout after ${timeoutMs}ms for ${method} ${path}`))
      }, timeoutMs)

      this.handlers.set(key, message => {
        clearTimeout(timer)
        this.handlers.delete(key)
        resolve(message)
      })

      try {
        this.transmit(method, path, token, observe ? 0 : undefined, payload)
      } catch (error) {
        clearTimeout(timer)
        this.handlers.delete(key)
        reject(error as Error)
      }
    })
  }

  /** Register an observation. `onNotify` fires for every push after the first. */
  async observe(options: ObserveOptions): Promise<Observation> {
    const { path, onNotify, timeoutMs = DEFAULT_TIMEOUT_MS } = options
    const token = randomBytes(4)
    const key = token.toString('hex')

    const first = await new Promise<DecodedCoapMessage>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.handlers.delete(key)
        reject(new Error(`CoAP observe timeout after ${timeoutMs}ms for ${path}`))
      }, timeoutMs)

      let settled = false
      this.handlers.set(key, message => {
        if (!settled) {
          settled = true
          clearTimeout(timer)
          resolve(message)
          return
        }
        onNotify(message)
      })

      try {
        this.transmit('GET', path, token, 0)
      } catch (error) {
        clearTimeout(timer)
        this.handlers.delete(key)
        reject(error as Error)
      }
    })

    return {
      first,
      cancel: () => {
        // Deregister the handler first so a push racing the cancellation is
        // dropped rather than delivered after the caller has stopped listening.
        this.handlers.delete(key)
        if (!this.closed) {
          try {
            this.transmit('GET', path, token, 1)
          } catch {
            // Socket already gone; the handler is removed either way.
          }
        }
      },
    }
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.handlers.clear()
    try {
      this.socket.close()
    } catch {
      // Already closed.
    }
  }
}
```

- [ ] **Step 8: Run both test files**

```bash
npx vitest run test/coap-message.test.ts test/coap-socket.test.ts
```

Expected: PASS.

- [ ] **Step 9: Confirm against real hardware**

```bash
node scripts/coap-spike.mjs 192.168.20.151
```

Expected: `codec self-check: PASS`, `[3] status code 2.05 | Max-Age 60`,
`[4] decrypted 59 keys`, and `[6] after proactive cancel, further pushes: 0`.

- [ ] **Step 10: Confirm no third-party imports crept in**

```bash
grep -rnE "from '(?!node:|\./|\.\./)" src/airctrl/coap/ || echo 'only node: and relative imports — good'
```

- [ ] **Step 11: Commit**

```bash
git add src/airctrl/coap test/coap-message.test.ts test/coap-socket.test.ts
git commit -m "Implement minimal CoAP over node:dgram

Replaces the coap npm package. Only what Philips firmware needs: NON
messages, GET/POST, Uri-Path, Observe and Max-Age. No CON/ACK, no
block-wise transfer, no server mode, no multicast, and no dependencies.

Responses are matched by token rather than message ID, because observe
notifications reuse the request token with fresh message IDs.

Gains proactive observe cancellation, which the coap package cannot do
(coapjs/node-coap#195) and which single-observer-slot firmware needs.

Codec tests assert golden bytes captured from a hardware-verified spike."
```

---

### Task 3: Define the zod trust boundaries

**Goal:** `src/airctrl/schema.ts` — validation for the two places untrusted data enters: decrypted device payloads and the plugin config block.

**Files:**
- Create: `src/airctrl/schema.ts`
- Create: `test/schema.test.ts`

**Acceptance Criteria:**
- [ ] `parseStatusPayload` extracts `state.reported` from the real fixture and returns all 59 keys
- [ ] Unknown device keys pass through rather than failing validation
- [ ] A payload missing `state.reported` throws an error mentioning `reported`
- [ ] `PluginConfigSchema` accepts a minimal config, defaults `devices` to `[]`, and rejects a device with no `host`
- [ ] Switch opt-ins default to `false`; `exposeLight` defaults to `true`
- [ ] `DeviceInfoSchema` parses the plaintext `/sys/dev/info` shape
- [ ] `DeviceConfigSchema` declares optional `model` so the UI's value is not stripped

**Verify:** `npx vitest run test/schema.test.ts` → all tests pass

**Steps:**

- [ ] **Step 1: Write the failing tests**

```typescript
// test/schema.test.ts
import { describe, expect, it } from 'vitest'
import fixture from './fixtures/ac4220-12-status.json'
import { DeviceInfoSchema, PluginConfigSchema, parseStatusPayload } from '../src/airctrl/schema.js'

describe('parseStatusPayload', () => {
  it('extracts state.reported and preserves every key', () => {
    const reported = parseStatusPayload(JSON.stringify({ state: { reported: fixture } }))
    expect(Object.keys(reported)).toHaveLength(59)
    expect(reported.D01S05).toBe('AC4220/12')
    expect(reported.D03224).toBe(284)
  })

  it('passes through keys it has never seen', () => {
    const reported = parseStatusPayload(JSON.stringify({ state: { reported: { ZZ9999: 'plural-z-alpha' } } }))
    expect(reported.ZZ9999).toBe('plural-z-alpha')
  })

  it('throws when state.reported is absent', () => {
    expect(() => parseStatusPayload(JSON.stringify({ state: {} }))).toThrow(/reported/)
  })

  it('throws on malformed JSON', () => {
    expect(() => parseStatusPayload('not json')).toThrow()
  })
})

describe('DeviceInfoSchema', () => {
  it('parses the plaintext /sys/dev/info payload', () => {
    const info = DeviceInfoSchema.parse({
      product_id: 'c8167180b50111ee899806d016384e4a',
      device_id: '96868ce0a7cb11ef9fbda30d1cde3e50',
      name: 'Office 1',
      type: 'Unicorn',
      modelid: 'AC4220/12',
      swversion: '0.0.0',
    })
    expect(info.modelid).toBe('AC4220/12')
  })
})

describe('PluginConfigSchema', () => {
  it('accepts a minimal config and defaults the switch opt-ins to false', () => {
    const config = PluginConfigSchema.parse({
      platform: 'PhilipsAir',
      devices: [{ host: '192.168.20.151' }],
    })
    expect(config.devices[0]!.host).toBe('192.168.20.151')
    expect(config.devices[0]!.exposeSleepSwitch).toBe(false)
    expect(config.devices[0]!.exposeBeepSwitch).toBe(false)
  })

  it('rejects a device with no host', () => {
    expect(() => PluginConfigSchema.parse({ platform: 'PhilipsAir', devices: [{}] })).toThrow()
  })

  it('defaults devices to an empty list so an unconfigured plugin is inert', () => {
    expect(PluginConfigSchema.parse({ platform: 'PhilipsAir' }).devices).toEqual([])
  })
})
```

- [ ] **Step 2: Run to verify it fails**

```bash
npx vitest run test/schema.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/airctrl/schema.ts`**

```typescript
import { z } from 'zod'

/**
 * Device status is a flat bag of opaque keys whose meaning depends on the model.
 * Validating individual keys here would reject every device whose key set differs
 * from the one we tested, so this only asserts the envelope shape. Interpreting
 * keys is device/keys.ts and device/models.ts's job.
 */
export const StatusPayloadSchema = z.object({
  state: z.object({
    reported: z.record(z.string(), z.unknown()),
  }),
})

export type DeviceStatus = Record<string, unknown>

/** Parse a decrypted status payload and return the reported state. */
export function parseStatusPayload(json: string): DeviceStatus {
  const parsed = StatusPayloadSchema.safeParse(JSON.parse(json))
  if (!parsed.success) {
    throw new Error(`unexpected status payload shape (no state.reported): ${parsed.error.message}`)
  }
  return parsed.data.state.reported
}

/** The plaintext /sys/dev/info response. Only modelid is load-bearing. */
export const DeviceInfoSchema = z.looseObject({
  modelid: z.string().optional(),
  name: z.string().optional(),
  device_id: z.string().optional(),
  product_id: z.string().optional(),
  swversion: z.string().optional(),
  type: z.string().optional(),
})

export type DeviceInfo = z.infer<typeof DeviceInfoSchema>

export const DeviceConfigSchema = z.object({
  host: z.string().min(1, 'host is required'),
  /** Optional display-name override; otherwise the device's own name is used. */
  name: z.string().optional(),
  /**
   * Model recorded by the setup UI, for display only. Declared so zod's default
   * key-stripping does not silently drop what the UI wrote.
   */
  model: z.string().optional(),
  port: z.number().int().positive().default(5683),
  /** Sleep is a distinct device mode, so it is offered separately from the speed slider. */
  exposeSleepSwitch: z.boolean().default(false),
  /** Auto+ AI (D03180). */
  exposeAutoPlusSwitch: z.boolean().default(false),
  /** Beep (D03130). On writes 100, not 1 — see device/keys.ts. */
  exposeBeepSwitch: z.boolean().default(false),
  /** Lamp mode (D03135) as a Lightbulb. */
  exposeLight: z.boolean().default(true),
})

export type DeviceConfig = z.infer<typeof DeviceConfigSchema>

export const PluginConfigSchema = z.looseObject({
  platform: z.string(),
  name: z.string().optional(),
  devices: z.array(DeviceConfigSchema).default([]),
})

export type PluginConfig = z.infer<typeof PluginConfigSchema>
```

- [ ] **Step 4: Run to verify it passes**

```bash
npx vitest run test/schema.test.ts
```

Expected: PASS. If `z.looseObject` is unavailable, the installed zod is v3 — check
`npm ls zod` and use `.passthrough()` instead.

- [ ] **Step 5: Commit**

```bash
git add src/airctrl/schema.ts test/schema.test.ts
git commit -m "Add zod schemas for device payload and plugin config

Device keys deliberately pass through unvalidated: asserting individual
keys would reject any device whose key set differs from the tested one."
```

---

### Task 4: Port the Philips CoAP client

**Goal:** `src/airctrl/client.ts` — the Philips protocol on top of `CoapSocket`: sync handshake, status read, observe stream, control writes, plaintext info.

**Files:**
- Create: `src/airctrl/client.ts`
- Create: `test/client.test.ts`
- Create: `test/helpers/fake-device.ts` (shared scriptable CoAP device, also usable by Task 7)

**Acceptance Criteria:**
- [ ] `getInfo()` reads plaintext `/sys/dev/info` with no handshake
- [ ] `connect()` performs the sync handshake and stores the returned client key
- [ ] `getStatus()` sends the Observe option (required — the device will not answer a plain GET), returns decrypted state plus `maxAge`, and **cancels the observation** so no lingering registration is left behind
- [ ] `observe()` yields decrypted status objects as the device pushes them
- [ ] `setControl()` retries up to 5 times by default, resyncing between attempts, and resolves `false` after exhausting them
- [ ] `setControl()` increments the client key before each attempt
- [ ] Tests run against a local fake device built from our own `encode`, not against the real hardware
- [ ] `close()` cancels every open observation and closes the socket
- [ ] The only transport dependency is `CoapSocket` — `client.ts` never imports `node:dgram` directly

**Verify:** `npx vitest run test/client.test.ts` → all tests pass

**Steps:**

- [ ] **Step 1: Create the shared fake device helper**

Built from our own `encode`, so the test suite has no third-party transport and
full control over what the "device" replies.

```typescript
// test/helpers/fake-device.ts
import dgram from 'node:dgram'
import { type CoapMessage, type DecodedCoapMessage, decode, encode } from '../../src/airctrl/coap/message.js'

export const CONTENT_2_05 = 69 // (2 << 5) | 5

export type Reply = (message: CoapMessage) => void
export type Handler = (request: DecodedCoapMessage, reply: Reply) => void

export interface FakeDevice {
  port: number
  requests: DecodedCoapMessage[]
  /** Replay a push to the last observer, e.g. to simulate a state change. */
  push: (payload: string) => void
  close: () => Promise<void>
}

/** A scriptable CoAP device on localhost. */
export async function startFakeDevice(handler: Handler): Promise<FakeDevice> {
  const server = dgram.createSocket('udp4')
  const requests: DecodedCoapMessage[] = []
  let lastObserver: { token: Buffer, reply: Reply } | null = null

  server.on('message', (buffer, remote) => {
    let request: DecodedCoapMessage
    try {
      request = decode(buffer)
    } catch {
      return
    }
    requests.push(request)
    const reply: Reply = message => server.send(encode(message), remote.port, remote.address)
    lastObserver = { token: request.token, reply }
    handler(request, reply)
  })

  const port = await new Promise<number>(resolve => {
    server.bind(0, () => resolve((server.address() as { port: number }).port))
  })

  return {
    port,
    requests,
    push: (payload: string) => {
      if (!lastObserver) throw new Error('no observer registered yet')
      lastObserver.reply({
        code: CONTENT_2_05,
        messageId: 0xABCD,
        token: lastObserver.token,
        payload: Buffer.from(payload),
      })
    },
    close: () => new Promise<void>(resolve => server.close(() => resolve())),
  }
}

/** Uri-Path of a decoded request, e.g. "/sys/dev/status". */
export function pathOf(request: DecodedCoapMessage): string {
  return `/${request.options.filter(o => o.number === 11).map(o => o.value.toString()).join('/')}`
}
```

- [ ] **Step 2: Write the failing client tests**

```typescript
// test/client.test.ts
import { afterEach, describe, expect, it } from 'vitest'
import { CoapOption, findOption, uintToBuffer } from '../src/airctrl/coap/message.js'
import { encrypt } from '../src/airctrl/crypto.js'
import { PhilipsCoapClient } from '../src/airctrl/client.js'
import { CONTENT_2_05, type FakeDevice, pathOf, startFakeDevice } from './helpers/fake-device.js'

const CLIENT_KEY = '0DC377BA'
const statusBody = (reported: Record<string, unknown>) =>
  encrypt(CLIENT_KEY, JSON.stringify({ state: { reported } }))

let device: FakeDevice | null = null
let client: PhilipsCoapClient | null = null

afterEach(async () => {
  client?.close()
  client = null
  await device?.close()
  device = null
})

describe('PhilipsCoapClient', () => {
  it('reads plaintext /sys/dev/info without a handshake', async () => {
    device = await startFakeDevice((request, reply) => {
      if (pathOf(request) === '/sys/dev/info') {
        reply({ code: CONTENT_2_05, messageId: request.messageId, token: request.token, payload: Buffer.from(JSON.stringify({ modelid: 'AC4220/12', name: 'Office 1' })) })
      }
    })
    client = new PhilipsCoapClient('127.0.0.1', device.port)

    expect((await client.getInfo()).modelid).toBe('AC4220/12')
    // No handshake was needed.
    expect(device.requests.map(pathOf)).toEqual(['/sys/dev/info'])
  })

  it('performs the sync handshake, then decrypts status and reads Max-Age', async () => {
    device = await startFakeDevice((request, reply) => {
      const path = pathOf(request)
      if (path === '/sys/dev/sync') {
        return reply({ code: CONTENT_2_05, messageId: request.messageId, token: request.token, payload: Buffer.from(CLIENT_KEY) })
      }
      if (path === '/sys/dev/status') {
        return reply({
          code: CONTENT_2_05,
          messageId: request.messageId,
          token: request.token,
          options: [{ number: CoapOption.MaxAge, value: uintToBuffer(60) }],
          payload: Buffer.from(statusBody({ D03102: 1, D01S05: 'AC4220/12' })),
        })
      }
    })
    client = new PhilipsCoapClient('127.0.0.1', device.port)
    await client.connect()

    const { status, maxAge } = await client.getStatus()
    expect(status.D03102).toBe(1)
    expect(status.D01S05).toBe('AC4220/12')
    expect(maxAge).toBe(60)
  })

  it('sends the Observe option on a status read and cancels it afterwards', async () => {
    device = await startFakeDevice((request, reply) => {
      const path = pathOf(request)
      if (path === '/sys/dev/sync') {
        return reply({ code: CONTENT_2_05, messageId: request.messageId, token: request.token, payload: Buffer.from(CLIENT_KEY) })
      }
      const observe = findOption(request.options, CoapOption.Observe)
      if (path === '/sys/dev/status' && observe?.value.length === 0) {
        return reply({ code: CONTENT_2_05, messageId: request.messageId, token: request.token, payload: Buffer.from(statusBody({ D03102: 1 })) })
      }
    })
    client = new PhilipsCoapClient('127.0.0.1', device.port)
    await client.connect()
    await client.getStatus()
    await new Promise(resolve => setTimeout(resolve, 50))

    const statusRequests = device.requests.filter(r => pathOf(r) === '/sys/dev/status')
    // First registers (Observe = 0, empty value), then deregisters (Observe = 1).
    expect(findOption(statusRequests[0]!.options, CoapOption.Observe)!.value.length).toBe(0)
    expect(findOption(statusRequests.at(-1)!.options, CoapOption.Observe)!.value.toString('hex')).toBe('01')
  })

  it('falls back to a 60s maxAge when the device omits Max-Age', async () => {
    device = await startFakeDevice((request, reply) => {
      const path = pathOf(request)
      if (path === '/sys/dev/sync') return reply({ code: CONTENT_2_05, messageId: request.messageId, token: request.token, payload: Buffer.from(CLIENT_KEY) })
      if (path === '/sys/dev/status') return reply({ code: CONTENT_2_05, messageId: request.messageId, token: request.token, payload: Buffer.from(statusBody({ D03102: 1 })) })
    })
    client = new PhilipsCoapClient('127.0.0.1', device.port)
    await client.connect()
    expect((await client.getStatus()).maxAge).toBe(60)
  })

  it('yields pushed updates from the observe stream', async () => {
    device = await startFakeDevice((request, reply) => {
      const path = pathOf(request)
      if (path === '/sys/dev/sync') return reply({ code: CONTENT_2_05, messageId: request.messageId, token: request.token, payload: Buffer.from(CLIENT_KEY) })
      if (path === '/sys/dev/status') return reply({ code: CONTENT_2_05, messageId: request.messageId, token: request.token, payload: Buffer.from(statusBody({ D03102: 1 })) })
    })
    client = new PhilipsCoapClient('127.0.0.1', device.port)
    await client.connect()

    const seen: unknown[] = []
    const iterator = client.observe()
    const firstResult = await iterator.next()
    seen.push((firstResult.value as Record<string, unknown>).D03102)

    device.push(statusBody({ D03102: 0 }))
    const secondResult = await iterator.next()
    seen.push((secondResult.value as Record<string, unknown>).D03102)

    expect(seen).toEqual([1, 0])
    await iterator.return?.(undefined)
  })

  it('resolves true when the device reports success', async () => {
    device = await startFakeDevice((request, reply) => {
      const path = pathOf(request)
      if (path === '/sys/dev/sync') return reply({ code: CONTENT_2_05, messageId: request.messageId, token: request.token, payload: Buffer.from(CLIENT_KEY) })
      if (path === '/sys/dev/control') return reply({ code: CONTENT_2_05, messageId: request.messageId, token: request.token, payload: Buffer.from(JSON.stringify({ status: 'success' })) })
    })
    client = new PhilipsCoapClient('127.0.0.1', device.port)
    await client.connect()
    expect(await client.setControl({ D03102: 1 })).toBe(true)
  })

  it('resolves false after exhausting retries', async () => {
    let controlAttempts = 0
    device = await startFakeDevice((request, reply) => {
      const path = pathOf(request)
      if (path === '/sys/dev/sync') return reply({ code: CONTENT_2_05, messageId: request.messageId, token: request.token, payload: Buffer.from(CLIENT_KEY) })
      if (path === '/sys/dev/control') {
        controlAttempts++
        return reply({ code: CONTENT_2_05, messageId: request.messageId, token: request.token, payload: Buffer.from(JSON.stringify({ status: 'failed' })) })
      }
    })
    client = new PhilipsCoapClient('127.0.0.1', device.port)
    await client.connect()

    expect(await client.setControl({ D03102: 1 }, { retries: 2, retryDelayMs: 1 })).toBe(false)
    expect(controlAttempts).toBe(3) // initial + 2 retries
  }, 15_000)

  it('increments the client key on each control attempt', async () => {
    const keysSeen: string[] = []
    device = await startFakeDevice((request, reply) => {
      const path = pathOf(request)
      if (path === '/sys/dev/sync') return reply({ code: CONTENT_2_05, messageId: request.messageId, token: request.token, payload: Buffer.from(CLIENT_KEY) })
      if (path === '/sys/dev/control') {
        keysSeen.push(request.payload.toString().slice(0, 8))
        return reply({ code: CONTENT_2_05, messageId: request.messageId, token: request.token, payload: Buffer.from(JSON.stringify({ status: 'success' })) })
      }
    })
    client = new PhilipsCoapClient('127.0.0.1', device.port)
    await client.connect()

    await client.setControl({ D03102: 1 })
    await client.setControl({ D03102: 0 })
    // 0DC377BA -> 0DC377BB, then 0DC377BC
    expect(keysSeen).toEqual(['0DC377BB', '0DC377BC'])
  })

  it('throws NotConnectedError when a handshake has not happened', async () => {
    device = await startFakeDevice(() => {})
    client = new PhilipsCoapClient('127.0.0.1', device.port)
    await expect(client.getStatus()).rejects.toThrow(/connect\(\)/)
  })
})
```

- [ ] **Step 3: Run to verify it fails**

```bash
npx vitest run test/client.test.ts
```

Expected: FAIL — `Cannot find module '../src/airctrl/client.js'`

- [ ] **Step 4: Implement `src/airctrl/client.ts`**

```typescript
import { randomBytes } from 'node:crypto'
import { CoapOption, bufferToUint, findOption } from './coap/message.js'
import { CoapSocket, type Observation } from './coap/socket.js'
import { decrypt, encrypt, nextKey } from './crypto.js'
import { DeviceInfoSchema, parseStatusPayload, type DeviceInfo, type DeviceStatus } from './schema.js'

const STATUS_PATH = '/sys/dev/status'
const CONTROL_PATH = '/sys/dev/control'
const SYNC_PATH = '/sys/dev/sync'
const INFO_PATH = '/sys/dev/info'

const DEFAULT_MAX_AGE_S = 60

export class NotConnectedError extends Error {
  constructor() {
    super('client key not initialised; call connect() first')
    this.name = 'NotConnectedError'
  }
}

export interface SetControlOptions {
  retries?: number
  retryDelayMs?: number
  resync?: boolean
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

/**
 * The Philips protocol on top of a plain CoAP socket.
 *
 * This class owns the encryption handshake and payload shapes; it knows nothing
 * about UDP. Swapping the transport means touching only CoapSocket.
 */
export class PhilipsCoapClient {
  private readonly socket: CoapSocket
  private clientKey: string | null = null
  private observations = new Set<Observation>()

  constructor(host: string, port = 5683) {
    this.socket = new CoapSocket(host, port)
  }

  /** Plaintext device identity. No handshake, so this doubles as a discovery probe. */
  async getInfo(): Promise<DeviceInfo> {
    const response = await this.socket.request({ method: 'GET', path: INFO_PATH })
    return DeviceInfoSchema.parse(JSON.parse(response.payload.toString()))
  }

  /** Exchange a random nonce for the rolling client key. */
  async connect(): Promise<void> {
    // Four random bytes as uppercase hex, matching the Python client's os.urandom(4).
    const nonce = randomBytes(4).toString('hex').toUpperCase()
    const response = await this.socket.request({ method: 'POST', path: SYNC_PATH, payload: nonce })
    this.clientKey = response.payload.toString().trim()
  }

  private requireKey(): string {
    if (!this.clientKey) throw new NotConnectedError()
    return this.clientKey
  }

  /**
   * Read status once.
   *
   * The Observe option is mandatory even here: Philips devices only serve this
   * resource through Observe and will not answer a plain GET. The registration is
   * cancelled immediately so no server-side observer slot is left occupied —
   * which matters on firmware that only supports one observer.
   */
  async getStatus(): Promise<{ status: DeviceStatus, maxAge: number }> {
    this.requireKey()
    const observation = await this.socket.observe({ path: STATUS_PATH, onNotify: () => {} })
    try {
      const status = parseStatusPayload(decrypt(observation.first.payload.toString()))
      const maxAgeOption = findOption(observation.first.options, CoapOption.MaxAge)
      const maxAge = maxAgeOption ? bufferToUint(maxAgeOption.value) : DEFAULT_MAX_AGE_S
      return { status, maxAge: maxAge > 0 ? maxAge : DEFAULT_MAX_AGE_S }
    } finally {
      observation.cancel()
    }
  }

  /** Long-lived push stream. Yields the first response, then every notification. */
  async *observe(): AsyncGenerator<DeviceStatus> {
    this.requireKey()

    const queue: DeviceStatus[] = []
    let notify: (() => void) | null = null
    let failure: Error | null = null

    const observation = await this.socket.observe({
      path: STATUS_PATH,
      onNotify: message => {
        try {
          queue.push(parseStatusPayload(decrypt(message.payload.toString())))
        } catch (error) {
          failure = error as Error
        }
        notify?.()
      },
    })
    this.observations.add(observation)

    try {
      yield parseStatusPayload(decrypt(observation.first.payload.toString()))

      while (true) {
        if (queue.length > 0) {
          yield queue.shift()!
          continue
        }
        if (failure) throw failure
        await new Promise<void>(resolve => { notify = resolve })
        notify = null
      }
    } finally {
      // Runs on break, return() and throw, so an abandoned stream always
      // deregisters rather than leaving the device pushing into nothing.
      this.observations.delete(observation)
      observation.cancel()
    }
  }

  /**
   * Write control values.
   *
   * A `success` response means the device ACCEPTED the command, not that it
   * applied it — verified on hardware, where writes to read-only keys still
   * report success. Callers must confirm real changes via the observe stream.
   */
  async setControl(values: Record<string, unknown>, options: SetControlOptions = {}): Promise<boolean> {
    const { retries = 5, retryDelayMs = 500, resync = true } = options
    const payload = JSON.stringify({
      state: { desired: { CommandType: 'app', DeviceId: '', EnduserId: '', ...values } },
    })

    for (let attempt = 0; attempt <= retries; attempt++) {
      this.clientKey = nextKey(this.requireKey())
      const response = await this.socket.request({
        method: 'POST',
        path: CONTROL_PATH,
        payload: encrypt(this.clientKey, payload),
      })

      let accepted = false
      try {
        accepted = JSON.parse(response.payload.toString()).status === 'success'
      } catch {
        accepted = false
      }
      if (accepted) return true

      if (resync) await this.connect()
      if (attempt < retries) await sleep(retryDelayMs)
    }
    return false
  }

  /** Cancel every observation and close the socket. */
  close(): void {
    for (const observation of this.observations) observation.cancel()
    this.observations.clear()
    this.socket.close()
  }
}
```

- [ ] **Step 5: Run to verify it passes**

```bash
npx vitest run test/client.test.ts
```

Expected: PASS, 9 tests.

- [ ] **Step 6: Verify against real hardware**

```bash
npm run build
node scripts/coap-spike.mjs 192.168.20.151
```

Expected: `codec self-check: PASS`, `[3] status code 2.05 | Max-Age 60`,
`[4] decrypted 59 keys`, `[6] after proactive cancel, further pushes: 0`.

- [ ] **Step 7: Commit**

```bash
git add src/airctrl/client.ts test/client.test.ts test/helpers/fake-device.ts
git commit -m "Port the Philips protocol onto our own CoAP socket

client.ts owns the handshake, encryption and payload shapes; CoapSocket
owns UDP. Swapping the transport would touch only the latter.

getStatus() cancels its observation once the reply arrives. The Observe
option is mandatory even for a one-shot read because Philips firmware
does not answer a plain GET of /sys/dev/status, but leaving the
registration open would occupy an observer slot on firmware that has
only one.

Tests script a fake device built from our own encode(), so the suite has
no third-party transport."
```


---

### Task 5: Port the device key and model tables

**Goal:** `src/device/keys.ts` and `src/device/models.ts` — the capability registry, plus model resolution with family-prefix fallback.

**Files:**
- Create: `src/device/keys.ts`
- Create: `src/device/models.ts`
- Create: `test/models.test.ts`

**Acceptance Criteria:**
- [ ] `powerValues` drives per-generation power keys: gen1 `pwr`/`"1"`/`"0"`, gen2 `D03-02`/`"ON"`/`"OFF"`, gen3 `D03102`/`1`/`0`
- [ ] `resolveModel('AC4220/12')` resolves via the 6-character family prefix `AC4220`
- [ ] `resolveModel` prefers an exact match over the family prefix (asserted by identity on `AC0850/81`)
- [ ] `resolveModel` on an unknown string returns a generic config for the given generation
- [ ] `deviceKey('D03105#1')` returns `'D03105'`
- [ ] All 62 models from the HA registry are present in `DEVICE_MODELS`
- [ ] AC4220's config lists 5 speeds and the auto/sleep presets ONLY — turbo (`D0310C=18`) and medium (`19`) are deliberately excluded as hardware-verified duplicates of speed 5 and speed 3
- [ ] `keys.ts` documents the four hardware-verified quirks: `D03105` read-only, `D03130` is 0/100, `D03135` is the real light control, `D03137` is not writable

**Verify:** `npx vitest run test/models.test.ts` → all tests pass

**Steps:**

- [ ] **Step 1: Clone the reference and extract the registry**

Port from data, not from memory.

```bash
git clone --depth 1 https://github.com/ruaan-deysel/ha-philips-airpurifier /tmp/ha-ref
wc -l /tmp/ha-ref/custom_components/philips_airpurifier/{const.py,device_models.py}
grep -n 'NEW2_\|^    [A-Z_]* = ' /tmp/ha-ref/custom_components/philips_airpurifier/const.py | head -80
```

Source of truth: `const.py` class `PhilipsApi` (keys) and `device_models.py` dict
`DEVICE_MODELS` (62 entries).

- [ ] **Step 2: Write the failing tests**

```typescript
// test/models.test.ts
import { describe, expect, it } from 'vitest'
import { ApiGeneration, DEVICE_MODELS, deviceKey, powerValues, resolveModel } from '../src/device/models.js'

describe('deviceKey', () => {
  it.each([
    ['D03105#1', 'D03105'],
    ['D0310A#2', 'D0310A'],
    ['D03102', 'D03102'],
  ])('strips the variant suffix from %s', (input, expected) => {
    expect(deviceKey(input)).toBe(expected)
  })
})

describe('powerValues', () => {
  it.each([
    [ApiGeneration.Gen1, 'pwr', '1', '0'],
    [ApiGeneration.Gen2, 'D03-02', 'ON', 'OFF'],
    [ApiGeneration.Gen3, 'D03102', 1, 0],
  ])('maps %s to the right power key and values', (generation, key, on, off) => {
    expect(powerValues(generation)).toEqual({ key, on, off })
  })
})

describe('resolveModel', () => {
  it('resolves AC4220/12 via the AC4220 family prefix', () => {
    const config = resolveModel('AC4220/12')
    expect(config.apiGeneration).toBe(ApiGeneration.Gen3)
    expect(Object.keys(config.speeds)).toHaveLength(5)
    expect(config.presetModes.auto).toEqual({ D03102: 1, D0310C: 0 })
    expect(config.presetModes.sleep).toEqual({ D03102: 1, D0310C: 17 })
  })

  it('prefers an exact match over the family prefix', () => {
    // 'AC0850/81' is an exact registry key, while its 6-char prefix 'AC0850' is
    // not — so this asserts the exact branch is taken, by identity.
    expect(DEVICE_MODELS['AC0850/81']).toBeDefined()
    expect(resolveModel('AC0850/81')).toBe(DEVICE_MODELS['AC0850/81'])
  })

  it('falls back to a generic config for an unknown model', () => {
    const config = resolveModel('XX9999/99', ApiGeneration.Gen3)
    expect(config.apiGeneration).toBe(ApiGeneration.Gen3)
    expect(config.speeds).toEqual({})
  })

  it('has all 62 models from the HA registry', () => {
    expect(Object.keys(DEVICE_MODELS)).toHaveLength(62)
  })
})
```

- [ ] **Step 3: Run to verify it fails**

```bash
npx vitest run test/models.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 4: Implement `src/device/keys.ts`**

The gen3 keys the AC4220 uses are given in full below. Also port two more groups
from the same source class, `PhilipsApi` in
`/tmp/ha-ref/custom_components/philips_airpurifier/const.py` (around lines
309-450), following the identical shape:

- `export const Gen1Key` — the unprefixed constants (`POWER: 'pwr'`, `MODE: 'mode'`,
  `SPEED: 'om'`, `PM25: 'pm25'`, `TEMPERATURE: 'temp'`, `HUMIDITY: 'rh'`, the
  `FILTER_*` keys, etc.)
- `export const Gen2Key` — the constants named `NEW_*` in the source
  (`NEW_POWER: 'D03-02'`, `NEW_MODE`, `NEW_NAME`, `NEW_MODEL_ID`, …), dropping the
  `NEW_` prefix in the TypeScript name

The gen3 group below corresponds to the source's `NEW2_*` constants.

```typescript
/**
 * Device status keys, ported from PhilipsApi in the HA integration's const.py.
 *
 * Keys are grouped by API generation. Gen1 uses readable names, gen2 and gen3
 * use opaque D-codes. Some registry entries carry a `#N` variant suffix — see
 * deviceKey() in models.ts.
 */
export const Gen3Key = {
  NAME: 'D01S03',
  MODEL_ID: 'D01S05',
  SERIAL: 'D01S0D',
  SOFTWARE_VERSION: 'D01S12',
  POWER: 'D03102',
  CHILD_LOCK: 'D03103',
  /**
   * Display backlight. READ-ONLY on AC4220/12 firmware: writes are ACKed and
   * ignored, and it reads 101 when the lamp is on. Use LAMP_MODE to control it.
   */
  DISPLAY_BACKLIGHT: 'D03105',
  MODE_A: 'D0310A',
  /** Mode and speed selector: 0 auto, 1-5 speeds (5 == turbo), 17 sleep, 18 turbo, 19 medium. */
  MODE_B: 'D0310C',
  /** Reported fan speed. Read-only. */
  FAN_SPEED: 'D0310D',
  TIMER: 'D03110',
  INDOOR_ALLERGEN_INDEX: 'D03120',
  PM25: 'D03221',
  GAS: 'D03122',
  HUMIDITY: 'D03125',
  TEMPERATURE: 'D03224',
  PREFERRED_INDEX: 'D0312A',
  /** Beep. Boolean, but stored as 0/100 — writing 1 reads back 100. */
  BEEP: 'D03130',
  STANDBY_SENSORS: 'D03134',
  /** Lamp mode: 0 off, 1 on, 2 on (dim). 3 clamps to 2. The real light control. */
  LAMP_MODE: 'D03135',
  /** Ambient light mode. NOT writable on AC4220/12 — reads back 1 regardless. */
  AMBIENT_LIGHT_MODE: 'D03137',
  ERROR_CODE: 'D03240',
  AUTO_PLUS_AI: 'D03180',
  FILTER_PREFILTER: 'D0520D',
  FILTER_PREFILTER_TOTAL: 'D05207',
  FILTER_NANOPROTECT: 'D0540E',
  FILTER_NANOPROTECT_TOTAL: 'D05408',
} as const
```

Per-key write values (including the beep's 0/100 quirk) live in
`src/homekit/mapping.ts` in Task 7, so they stay next to the other HomeKit
conversions rather than being split across two files.

- [ ] **Step 5: Implement `src/device/models.ts`**

```typescript
import { Gen3Key } from './keys.js'

export enum ApiGeneration {
  Gen1 = 'gen1',
  Gen2 = 'gen2',
  Gen3 = 'gen3',
}

/** Ordered map from a preset/speed name to the control writes that select it. */
export type ControlWrites = Record<string, string | number>

export interface DeviceModelConfig {
  apiGeneration: ApiGeneration
  /** Named modes not on the speed ladder, e.g. auto, sleep. */
  presetModes: Record<string, ControlWrites>
  /** The speed ladder, in ascending order. Key order defines RotationSpeed steps. */
  speeds: Record<string, ControlWrites>
  switches: string[]
  lights: string[]
  selects: string[]
  numbers: string[]
  unavailableFilters: string[]
  unavailableSensors: string[]
  createFan: boolean
}

function config(partial: Partial<DeviceModelConfig> & { apiGeneration: ApiGeneration }): DeviceModelConfig {
  return {
    presetModes: {},
    speeds: {},
    switches: [],
    lights: [],
    selects: [],
    numbers: [],
    unavailableFilters: [],
    unavailableSensors: [],
    createFan: true,
    ...partial,
  }
}

/**
 * Strip the variant suffix from a registry key.
 *
 * Registry entries like `D03105#1` are not device keys — the `#N` distinguishes
 * variants that share one device key but differ in options. Mirrors the HA
 * integration's `kind.partition("#")[0]`.
 */
export function deviceKey(registryKey: string): string {
  const hash = registryKey.indexOf('#')
  return hash === -1 ? registryKey : registryKey.slice(0, hash)
}

/** The power key and its on/off values differ per API generation. */
export function powerValues(generation: ApiGeneration): { key: string, on: string | number, off: string | number } {
  switch (generation) {
    case ApiGeneration.Gen2: return { key: 'D03-02', on: 'ON', off: 'OFF' }
    case ApiGeneration.Gen3: return { key: 'D03102', on: 1, off: 0 }
    default: return { key: 'pwr', on: '1', off: '0' }
  }
}

// --- shared family configs -------------------------------------------------
// Port every family from device_models.py. AC32XX (which AC4220 shares) is
// given in full as the worked example.

/**
 * AC32xx / AC4220 / AC4221 modes.
 *
 * Verified on hardware: D0310C 1-4 report fan speeds 1-4, and 5 reports 18 —
 * so speed 5 IS turbo. Turbo (18) and medium (19) are therefore NOT listed as
 * presets: they duplicate speed 5 and speed 3 respectively.
 */
const AC32XX_PRESETS: Record<string, ControlWrites> = {
  auto: { [Gen3Key.POWER]: 1, [Gen3Key.MODE_B]: 0 },
  sleep: { [Gen3Key.POWER]: 1, [Gen3Key.MODE_B]: 17 },
}

const AC32XX_SPEEDS: Record<string, ControlWrites> = {
  speed1: { [Gen3Key.POWER]: 1, [Gen3Key.MODE_B]: 1 },
  speed2: { [Gen3Key.POWER]: 1, [Gen3Key.MODE_B]: 2 },
  speed3: { [Gen3Key.POWER]: 1, [Gen3Key.MODE_B]: 3 },
  speed4: { [Gen3Key.POWER]: 1, [Gen3Key.MODE_B]: 4 },
  speed5: { [Gen3Key.POWER]: 1, [Gen3Key.MODE_B]: 5 },
}

const CONFIG_AC4220 = config({
  apiGeneration: ApiGeneration.Gen3,
  presetModes: AC32XX_PRESETS,
  speeds: AC32XX_SPEEDS,
  lights: [Gen3Key.LAMP_MODE],
  switches: [Gen3Key.CHILD_LOCK, Gen3Key.BEEP, Gen3Key.AUTO_PLUS_AI],
  selects: [`${Gen3Key.PREFERRED_INDEX}#1`],
})

/**
 * All 62 models from DEVICE_MODELS in device_models.py.
 *
 * Port every remaining entry using the same shape. Keys are the registry's model
 * strings (e.g. 'AC0850/11 AWS_Philips_AIR', 'AC2889', 'CX7550'). Only AC4220 is
 * hardware-verified; the rest are transcribed from the HA registry.
 */
export const DEVICE_MODELS: Record<string, DeviceModelConfig> = {
  AC4220: CONFIG_AC4220,
  AC4221: CONFIG_AC4220,
  // ... port the other 60 entries from device_models.py here
}

/**
 * Resolve a reported model string to its capability config.
 *
 * Mirrors the HA integration: exact match, then 6-character family prefix, then
 * a bare generic config. The tested device exercises the middle path —
 * 'AC4220/12' is not a registry key but 'AC4220' is.
 */
export function resolveModel(
  model: string,
  fallbackGeneration: ApiGeneration = ApiGeneration.Gen1,
): DeviceModelConfig {
  return DEVICE_MODELS[model]
    ?? DEVICE_MODELS[model.slice(0, 6)]
    ?? config({ apiGeneration: fallbackGeneration })
}

/**
 * Guess the API generation from the keys a device actually reports. Used when the
 * model is unknown, so a new device still gets basic control.
 */
export function detectGeneration(status: Record<string, unknown>): ApiGeneration {
  if ('D03102' in status) return ApiGeneration.Gen3
  if ('D03-02' in status) return ApiGeneration.Gen2
  return ApiGeneration.Gen1
}
```

- [ ] **Step 6: Port the remaining 59 model entries**

Work through `DEVICE_MODELS` in `/tmp/ha-ref/custom_components/philips_airpurifier/device_models.py`
top to bottom. For each entry transcribe `api_generation`, `preset_modes`,
`speeds`, `switches`, `lights`, `selects`, `numbers`, `unavailable_filters`, and
`unavailable_sensors`. Skip `status_nudge` (out of scope) and `requires_mode_cycling`
(AC1214 only, out of scope). Confirm the count:

```bash
npx vitest run test/models.test.ts -t 'all 62 models'
```

- [ ] **Step 7: Run the full test file**

```bash
npx vitest run test/models.test.ts
```

Expected: PASS, all tests.

- [ ] **Step 8: Commit**

```bash
git add src/device/keys.ts src/device/models.ts test/models.test.ts
git commit -m "Port device key and model capability tables

62 models transcribed from the HA integration's DEVICE_MODELS registry.
Resolution is exact match, then 6-char family prefix, then a generic
config — AC4220/12 resolves via the AC4220 prefix.

Turbo (D0310C=18) and medium (19) are deliberately absent from AC32xx
presets: hardware probing showed 18 is identical to speed 5 and 19 to
speed 3, so exposing them would duplicate the speed ladder."
```

---

### Task 6: Build the device coordinator

**Goal:** `src/device/coordinator.ts` — owns liveness for one device: connect, observe, detect loss, reconnect with backoff, and emit only real changes.

**Files:**
- Create: `src/device/coordinator.ts`
- Create: `test/coordinator.test.ts`

**Acceptance Criteria:**
- [ ] Emits `status` on the first read and thereafter only when at least one key's value changed
- [ ] Emits `availability` transitions once per change, not per failed attempt
- [ ] Watchdog fires after `maxAge × 3` of silence and triggers a reconnect
- [ ] Reconnect backoff doubles from 5s to a 60s ceiling and resets after success
- [ ] `shutdown()` stops all timers and closes the client, and no reconnect is scheduled afterwards
- [ ] Uses injected fake timers in tests — no real waiting

**Verify:** `npx vitest run test/coordinator.test.ts` → all tests pass in under 5 seconds

**Steps:**

- [ ] **Step 1: Write the failing tests**

```typescript
// test/coordinator.test.ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DeviceCoordinator } from '../src/device/coordinator.js'

function fakeClient(overrides: Partial<any> = {}) {
  return {
    connect: vi.fn().mockResolvedValue(undefined),
    getStatus: vi.fn().mockResolvedValue({ status: { D03102: 1 }, maxAge: 60 }),
    observe: vi.fn(async function* () { /* stays open */ await new Promise(() => {}) }),
    setControl: vi.fn().mockResolvedValue(true),
    close: vi.fn(),
    ...overrides,
  }
}

const log = { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() }

beforeEach(() => vi.useFakeTimers())
afterEach(() => { vi.useRealTimers(); vi.clearAllMocks() })

describe('DeviceCoordinator', () => {
  it('emits the first status and marks the device available', async () => {
    const client = fakeClient()
    const coordinator = new DeviceCoordinator(client as never, log as never, 'host')
    const statuses: unknown[] = []
    coordinator.on('status', s => statuses.push(s))

    await coordinator.start()
    expect(statuses).toEqual([{ D03102: 1 }])
    expect(coordinator.available).toBe(true)
    await coordinator.shutdown()
  })

  it('suppresses an identical status but emits a changed one', async () => {
    const client = fakeClient()
    const coordinator = new DeviceCoordinator(client as never, log as never, 'host')
    await coordinator.start()

    const seen: unknown[] = []
    coordinator.on('status', s => seen.push(s))

    coordinator.ingest({ D03102: 1 }) // identical — suppressed
    coordinator.ingest({ D03102: 1 }) // identical — suppressed
    coordinator.ingest({ D03102: 0 }) // changed — emitted
    expect(seen).toEqual([{ D03102: 0 }])
    await coordinator.shutdown()
  })

  it('emits availability transitions once each way', async () => {
    const client = fakeClient()
    const coordinator = new DeviceCoordinator(client as never, log as never, 'host')
    const events: boolean[] = []
    coordinator.on('availability', a => events.push(a))

    await coordinator.start()
    coordinator.markUnavailable('test')
    coordinator.markUnavailable('test again') // no duplicate event
    coordinator.markAvailable()
    coordinator.markAvailable() // no duplicate event
    expect(events).toEqual([true, false, true])
    await coordinator.shutdown()
  })

  it('marks the device unavailable after maxAge x 3 of silence', async () => {
    const client = fakeClient()
    const coordinator = new DeviceCoordinator(client as never, log as never, 'host')
    await coordinator.start()
    expect(coordinator.available).toBe(true)

    await vi.advanceTimersByTimeAsync(180_001) // 60s maxAge x 3
    expect(coordinator.available).toBe(false)
    await coordinator.shutdown()
  })

  it('doubles reconnect backoff to a 60s ceiling', () => {
    const coordinator = new DeviceCoordinator(fakeClient() as never, log as never, 'host')
    expect([1, 2, 3, 4, 5, 6].map(() => coordinator.nextBackoffMs())).toEqual([
      5000, 10_000, 20_000, 40_000, 60_000, 60_000,
    ])
    coordinator.resetBackoff()
    expect(coordinator.nextBackoffMs()).toBe(5000)
  })

  it('schedules nothing after shutdown', async () => {
    const client = fakeClient()
    const coordinator = new DeviceCoordinator(client as never, log as never, 'host')
    await coordinator.start()
    await coordinator.shutdown()

    expect(client.close).toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })
})
```

- [ ] **Step 2: Run to verify it fails**

```bash
npx vitest run test/coordinator.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/device/coordinator.ts`**

```typescript
import { EventEmitter } from 'node:events'
import type { Logging } from 'homebridge'
import type { PhilipsCoapClient } from '../airctrl/client.js'
import type { DeviceStatus } from '../airctrl/schema.js'

const MISSED_PUSH_ALLOWANCE = 3
const DEFAULT_MAX_AGE_S = 60
const BACKOFF_INITIAL_MS = 5_000
const BACKOFF_CEILING_MS = 60_000

/**
 * Owns liveness for a single device.
 *
 * Emits:
 *  - `status` (DeviceStatus)   only when a value actually changed
 *  - `availability` (boolean)  only on transitions
 */
export class DeviceCoordinator extends EventEmitter {
  private lastStatus: DeviceStatus | null = null
  private maxAgeS = DEFAULT_MAX_AGE_S
  private isAvailable = false
  private backoffMs = BACKOFF_INITIAL_MS
  private watchdog: NodeJS.Timeout | null = null
  private reconnectTimer: NodeJS.Timeout | null = null
  private observeAbort: AbortController | null = null
  private shuttingDown = false

  constructor(
    private client: PhilipsCoapClient,
    private readonly log: Logging,
    private readonly host: string,
    private readonly reconnectClient?: () => Promise<PhilipsCoapClient>,
  ) {
    super()
  }

  get available(): boolean {
    return this.isAvailable
  }

  get status(): DeviceStatus | null {
    return this.lastStatus
  }

  async start(): Promise<void> {
    await this.client.connect()
    const { status, maxAge } = await this.client.getStatus()
    this.maxAgeS = maxAge || DEFAULT_MAX_AGE_S
    this.markAvailable()
    this.ingest(status)
    this.resetBackoff()
    this.beginObserving()
    this.armWatchdog()
  }

  /**
   * Accept a status snapshot and publish it only if something changed.
   *
   * The device pushes roughly twice a second, so forwarding every push would
   * flood HomeKit with redundant characteristic updates.
   */
  ingest(status: DeviceStatus): void {
    this.armWatchdog()
    if (this.lastStatus && !this.hasChanged(this.lastStatus, status)) return
    this.lastStatus = status
    this.emit('status', status)
  }

  private hasChanged(previous: DeviceStatus, next: DeviceStatus): boolean {
    const keys = new Set([...Object.keys(previous), ...Object.keys(next)])
    for (const key of keys) {
      if (previous[key] !== next[key]) return true
    }
    return false
  }

  markAvailable(): void {
    if (this.isAvailable) return
    this.isAvailable = true
    this.log.info(`Device at ${this.host} is online`)
    this.emit('availability', true)
  }

  markUnavailable(reason: string): void {
    if (!this.isAvailable) return
    this.isAvailable = false
    this.log.warn(`Device at ${this.host} became unavailable: ${reason}`)
    this.emit('availability', false)
  }

  nextBackoffMs(): number {
    const current = this.backoffMs
    this.backoffMs = Math.min(this.backoffMs * 2, BACKOFF_CEILING_MS)
    return current
  }

  resetBackoff(): void {
    this.backoffMs = BACKOFF_INITIAL_MS
  }

  async setControl(values: Record<string, unknown>): Promise<boolean> {
    return this.client.setControl(values)
  }

  private beginObserving(): void {
    this.observeAbort?.abort()
    const abort = new AbortController()
    this.observeAbort = abort

    void (async () => {
      try {
        for await (const status of this.client.observe()) {
          if (abort.signal.aborted) return
          this.markAvailable()
          this.ingest(status)
        }
      } catch (error) {
        if (abort.signal.aborted) return
        this.log.debug(`Observe stream for ${this.host} ended: ${(error as Error).message}`)
      }
      if (!abort.signal.aborted && !this.shuttingDown) this.scheduleReconnect()
    })()
  }

  private armWatchdog(): void {
    if (this.shuttingDown) return
    if (this.watchdog) clearTimeout(this.watchdog)
    this.watchdog = setTimeout(() => {
      this.markUnavailable('watchdog timeout')
      this.scheduleReconnect()
    }, this.maxAgeS * MISSED_PUSH_ALLOWANCE * 1000)
  }

  private scheduleReconnect(): void {
    if (this.shuttingDown || this.reconnectTimer) return
    const delay = this.nextBackoffMs()
    this.log.debug(`Reconnecting to ${this.host} in ${delay / 1000}s`)
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      void this.reconnect()
    }, delay)
  }

  private async reconnect(): Promise<void> {
    if (this.shuttingDown) return
    try {
      this.client.close()
      if (this.reconnectClient) this.client = await this.reconnectClient()
      await this.client.connect()
      const { status, maxAge } = await this.client.getStatus()
      this.maxAgeS = maxAge || DEFAULT_MAX_AGE_S
      this.markAvailable()
      this.ingest(status)
      this.resetBackoff()
      this.beginObserving()
      this.log.info(`Reconnected to ${this.host}`)
    } catch (error) {
      this.markUnavailable(`reconnect failed: ${(error as Error).message}`)
      this.scheduleReconnect()
    }
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true
    this.observeAbort?.abort()
    if (this.watchdog) clearTimeout(this.watchdog)
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.watchdog = null
    this.reconnectTimer = null
    this.client.close()
    this.removeAllListeners()
  }
}
```

- [ ] **Step 4: Run to verify it passes**

```bash
npx vitest run test/coordinator.test.ts
```

Expected: PASS, 6 tests, under 5 seconds thanks to fake timers.

- [ ] **Step 5: Commit**

```bash
git add src/device/coordinator.ts test/coordinator.test.ts
git commit -m "Add device coordinator with change detection and backoff

Publishes status only when a value actually changed — the device pushes
about twice a second, so forwarding every push would flood HomeKit.

Availability is emitted on transitions only, so a device that is down
for an hour logs twice rather than hundreds of times."
```

---

### Task 7: Implement network discovery

**Goal:** `src/airctrl/discovery.ts` — sweep a subnet for Philips devices using the plaintext info endpoint.

**Files:**
- Create: `src/airctrl/discovery.ts`
- Create: `test/discovery.test.ts`

**Acceptance Criteria:**
- [ ] `localSubnets()` returns CIDR strings normalised to the network address, excluding loopback and internal interfaces
- [ ] `hostsInSubnet('192.168.20.0/24')` yields 254 hosts, first `192.168.20.1`, last `192.168.20.254`, excluding network and broadcast
- [ ] `hostsInSubnet('10.0.0.0/30')` yields exactly `['10.0.0.1', '10.0.0.2']`
- [ ] `probeHost()` resolves device identity for a responder and `null` for a non-responder
- [ ] `probeHost()` resolves `null` for a CoAP responder that reports no `modelid` (some other device on the network)
- [ ] `discover()` returns only successful probes, sorted by host
- [ ] `discover()` never exceeds the requested concurrency
- [ ] Probing issues exactly one request, to `/sys/dev/info` — no handshake, no decryption

**Verify:** `npx vitest run test/discovery.test.ts` → all tests pass

**Steps:**

- [ ] **Step 1: Write the failing tests**

```typescript
// test/discovery.test.ts
import { afterEach, describe, expect, it } from 'vitest'
import { discover, hostsInSubnet, localSubnets, probeHost } from '../src/airctrl/discovery.js'
import { CONTENT_2_05, type FakeDevice, pathOf, startFakeDevice } from './helpers/fake-device.js'

let device: FakeDevice | null = null

afterEach(async () => {
  await device?.close()
  device = null
})

/** A fake that answers /sys/dev/info with the given identity. */
async function deviceReporting(info: Record<string, unknown>): Promise<FakeDevice> {
  return startFakeDevice((request, reply) => {
    if (pathOf(request) === '/sys/dev/info') {
      reply({ code: CONTENT_2_05, messageId: request.messageId, token: request.token, payload: Buffer.from(JSON.stringify(info)) })
    }
  })
}

describe('hostsInSubnet', () => {
  it('yields 254 usable hosts for a /24, excluding network and broadcast', () => {
    const hosts = [...hostsInSubnet('192.168.20.0/24')]
    expect(hosts).toHaveLength(254)
    expect(hosts[0]).toBe('192.168.20.1')
    expect(hosts.at(-1)).toBe('192.168.20.254')
    expect(hosts).not.toContain('192.168.20.0')
    expect(hosts).not.toContain('192.168.20.255')
  })

  it('handles a /30', () => {
    expect([...hostsInSubnet('10.0.0.0/30')]).toEqual(['10.0.0.1', '10.0.0.2'])
  })
})

describe('localSubnets', () => {
  it('returns CIDRs and never includes loopback', () => {
    const subnets = localSubnets()
    expect(Array.isArray(subnets)).toBe(true)
    expect(subnets.some(s => s.startsWith('127.'))).toBe(false)
  })
})

describe('probeHost', () => {
  it('identifies a responding Philips device', async () => {
    device = await deviceReporting({ modelid: 'AC4220/12', name: 'Office 1', device_id: 'abc', swversion: '0.2.3' })

    const found = await probeHost('127.0.0.1', device.port, 2000)
    expect(found).toMatchObject({ host: '127.0.0.1', model: 'AC4220/12', name: 'Office 1', firmware: '0.2.3' })
  })

  it('resolves null for a host that does not answer', async () => {
    expect(await probeHost('127.0.0.1', 15699, 300)).toBeNull()
  })

  it('resolves null for a CoAP responder that is not a Philips device', async () => {
    // Answers, but reports no modelid — some other CoAP device on the network.
    device = await deviceReporting({ hello: 'not a purifier' })
    expect(await probeHost('127.0.0.1', device.port, 2000)).toBeNull()
  })

  it('probes only /sys/dev/info — no handshake, no decryption', async () => {
    device = await deviceReporting({ modelid: 'AC4220/12', name: 'Office 1' })
    await probeHost('127.0.0.1', device.port, 2000)
    expect(device.requests.map(pathOf)).toEqual(['/sys/dev/info'])
  })
})

describe('discover', () => {
  it('returns only hosts that responded', async () => {
    device = await deviceReporting({ modelid: 'AC4220/12', name: 'Office 1' })

    const found = await discover({ hosts: ['127.0.0.1', '127.0.0.2'], port: device.port, timeoutMs: 500, concurrency: 2 })
    expect(found).toHaveLength(1)
    expect(found[0]!.model).toBe('AC4220/12')
  })

  it('caps concurrency at the requested level', async () => {
    let inFlight = 0
    let peak = 0
    device = await startFakeDevice((request, reply) => {
      if (pathOf(request) !== '/sys/dev/info') return
      inFlight++
      peak = Math.max(peak, inFlight)
      setTimeout(() => {
        inFlight--
        reply({ code: CONTENT_2_05, messageId: request.messageId, token: request.token, payload: Buffer.from(JSON.stringify({ modelid: 'AC4220/12' })) })
      }, 30)
    })

    const hosts = Array.from({ length: 12 }, () => '127.0.0.1')
    await discover({ hosts, port: device.port, timeoutMs: 2000, concurrency: 4 })
    expect(peak).toBeLessThanOrEqual(4)
  })
})
```

- [ ] **Step 2: Run to verify it fails**

```bash
npx vitest run test/discovery.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/airctrl/discovery.ts`**

```typescript
import { networkInterfaces } from 'node:os'
import { PhilipsCoapClient } from './client.js'

export interface DiscoveredDevice {
  host: string
  model: string
  name: string
  deviceId?: string
  firmware?: string
}

/** Local IPv4 subnets in CIDR form, excluding loopback and internal interfaces. */
export function localSubnets(): string[] {
  const subnets: string[] = []
  for (const addresses of Object.values(networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family !== 'IPv4' || address.internal || !address.cidr) continue
      // os reports the interface's own address (192.168.20.5/24); normalise it to
      // the network address so the same subnet is not scanned twice.
      subnets.push(networkCidr(address.cidr))
    }
  }
  return [...new Set(subnets)]
}

function networkCidr(cidr: string): string {
  const [ip, bitsRaw] = cidr.split('/')
  const bits = Number(bitsRaw)
  const mask = bits === 0 ? 0 : (0xFFFFFFFF << (32 - bits)) >>> 0
  return `${intToIp((ipToInt(ip!) & mask) >>> 0)}/${bits}`
}

const ipToInt = (ip: string): number =>
  ip.split('.').reduce((acc, octet) => ((acc << 8) | Number(octet)) >>> 0, 0) >>> 0

const intToIp = (value: number): string =>
  [24, 16, 8, 0].map(shift => (value >>> shift) & 0xFF).join('.')

/** Usable host addresses in a CIDR block, excluding network and broadcast. */
export function* hostsInSubnet(cidr: string): Generator<string> {
  const [ip, bitsRaw] = cidr.split('/')
  const bits = Number(bitsRaw)
  if (bits >= 31) return // no usable hosts in /31 or /32
  const mask = (0xFFFFFFFF << (32 - bits)) >>> 0
  const network = (ipToInt(ip!) & mask) >>> 0
  const broadcast = (network | (~mask >>> 0)) >>> 0
  for (let address = network + 1; address < broadcast; address++) yield intToIp(address >>> 0)
}

/**
 * Ask a single host to identify itself.
 *
 * Uses plaintext /sys/dev/info, which needs no sync handshake and no decryption,
 * so a whole-subnet sweep stays cheap. Returns null for anything that does not
 * answer or does not look like a Philips device.
 */
export async function probeHost(host: string, port = 5683, timeoutMs = 2000): Promise<DiscoveredDevice | null> {
  const client = new PhilipsCoapClient(host, port)
  try {
    const info = await Promise.race([
      client.getInfo(),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('probe timeout')), timeoutMs)),
    ])
    if (!info.modelid) return null
    return {
      host,
      model: info.modelid,
      name: info.name ?? info.modelid,
      deviceId: info.device_id,
      firmware: info.swversion,
    }
  } catch {
    return null
  } finally {
    client.close()
  }
}

export interface DiscoverOptions {
  hosts?: string[]
  subnet?: string
  port?: number
  timeoutMs?: number
  /** Bounded so a /24 sweep does not open 254 sockets at once. */
  concurrency?: number
}

/** Probe many hosts with bounded concurrency and return the ones that answered. */
export async function discover(options: DiscoverOptions = {}): Promise<DiscoveredDevice[]> {
  const { port = 5683, timeoutMs = 2000, concurrency = 32 } = options
  const hosts = options.hosts
    ?? (options.subnet ? [...hostsInSubnet(options.subnet)] : localSubnets().flatMap(s => [...hostsInSubnet(s)]))

  const found: DiscoveredDevice[] = []
  const queue = [...hosts]

  async function worker(): Promise<void> {
    while (queue.length > 0) {
      const host = queue.shift()
      if (!host) return
      const device = await probeHost(host, port, timeoutMs)
      if (device) found.push(device)
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, hosts.length) }, worker))
  return found.sort((a, b) => a.host.localeCompare(b.host))
}
```

- [ ] **Step 4: Run to verify it passes**

```bash
npx vitest run test/discovery.test.ts
```

Expected: PASS.

- [ ] **Step 5: Verify a real sweep finds the device**

```bash
node --input-type=module -e "
import { discover } from './dist/airctrl/discovery.js'
console.log(await discover({ subnet: '192.168.20.0/24', timeoutMs: 1500 }))
"
```

Expected: finds `192.168.20.151` reporting `AC4220/12`. Run `npm run build` first.

- [ ] **Step 6: Commit**

```bash
git add src/airctrl/discovery.ts test/discovery.test.ts
git commit -m "Add subnet discovery via the plaintext info endpoint

Probes /sys/dev/info, which needs no handshake and no decryption, so a
/24 sweep is cheap. The Python implementation did a full sync plus
status read per IP."
```

---

### Task 8: Map device state to HomeKit services

**Goal:** `src/accessory.ts` — translate device status into HomeKit characteristics and HomeKit writes into device keys.

**Files:**
- Create: `src/accessory.ts`
- Create: `src/homekit/mapping.ts`
- Create: `test/mapping.test.ts`

**Acceptance Criteria:**
- [ ] `airQualityFromPm25` maps breakpoints exactly: 0-12→1, 13-35→2, 36-55→3, 56-150→4, 151+→5, `undefined`→0
- [ ] `rotationSpeedFromMode` and `modeFromRotationSpeed` round-trip across all 5 speeds with `minStep` 20 (20/40/60/80/100 ↔ 1/2/3/4/5)
- [ ] `modeFromRotationSpeed(0, 5)` returns `null` so `D0310C=0` (which means Auto, not off) is NEVER written; 0% routes to a power-off write instead
- [ ] `rotationSpeedFromMode` returns 0 for off-ladder modes 0 (auto) and 17 (sleep)
- [ ] `MANUAL` with no observed manual speed selects `D0310C = 1`
- [ ] `filterLifePercent` computes 24 for 175/720 and 14 for 1374/9600; clamps to 0-100; tolerates a zero total
- [ ] `beepWriteValue(true)` is **100** not 1 (hardware-verified: writing 1 reads back 100); `beepStateFromValue` is true for any non-zero value
- [ ] Lightbulb maps to `D03135` (lamp mode) and NEVER to the read-only `D03105`
- [ ] `temperatureFromRaw(284)` is 28.4
- [ ] Mapping functions are pure and HAP-free so they test without a Homebridge runtime, against the real fixture
- [ ] Offline reads throw `HapStatusError(SERVICE_COMMUNICATION_FAILURE)` rather than returning a stale value

**Verify:** `npx vitest run test/mapping.test.ts` → all tests pass

**Steps:**

- [ ] **Step 1: Write the failing tests**

```typescript
// test/mapping.test.ts
import { describe, expect, it } from 'vitest'
import fixture from './fixtures/ac4220-12-status.json'
import {
  airQualityFromPm25,
  beepStateFromValue,
  beepWriteValue,
  filterLifePercent,
  lampOnFromValue,
  lampWriteValue,
  modeFromRotationSpeed,
  rotationSpeedFromMode,
  temperatureFromRaw,
} from '../src/homekit/mapping.js'

describe('airQualityFromPm25', () => {
  it.each([
    [0, 1], [12, 1], // EXCELLENT
    [13, 2], [35, 2], // GOOD
    [36, 3], [55, 3], // FAIR
    [56, 4], [150, 4], // INFERIOR
    [151, 5], [999, 5], // POOR
  ])('maps PM2.5 %i to AirQuality %i', (pm25, expected) => {
    expect(airQualityFromPm25(pm25)).toBe(expected)
  })

  it('returns UNKNOWN (0) for a missing reading', () => {
    expect(airQualityFromPm25(undefined)).toBe(0)
  })
})

describe('rotation speed and mode', () => {
  it.each([[1, 20], [2, 40], [3, 60], [4, 80], [5, 100]])(
    'maps D0310C %i to RotationSpeed %i',
    (mode, speed) => expect(rotationSpeedFromMode(mode, 5)).toBe(speed),
  )

  it.each([[20, 1], [40, 2], [60, 3], [80, 4], [100, 5]])(
    'maps RotationSpeed %i back to D0310C %i',
    (speed, mode) => expect(modeFromRotationSpeed(speed, 5)).toBe(mode),
  )

  it('rounds an off-step slider value to the nearest speed', () => {
    expect(modeFromRotationSpeed(45, 5)).toBe(2)
    expect(modeFromRotationSpeed(91, 5)).toBe(5)
  })

  it('returns null at 0 so the device is never sent mode 0 (which means Auto)', () => {
    expect(modeFromRotationSpeed(0, 5)).toBeNull()
  })

  it('reports 0 for auto and sleep modes, which are not on the ladder', () => {
    expect(rotationSpeedFromMode(0, 5)).toBe(0)
    expect(rotationSpeedFromMode(17, 5)).toBe(0)
  })
})

describe('filterLifePercent', () => {
  it('computes life from the real fixture values', () => {
    expect(filterLifePercent(fixture.D0520D, fixture.D05207)).toBe(24)
    expect(filterLifePercent(fixture.D0540E, fixture.D05408)).toBe(14)
  })

  it('clamps to 0-100 and tolerates a zero total', () => {
    expect(filterLifePercent(0, 720)).toBe(0)
    expect(filterLifePercent(900, 720)).toBe(100)
    expect(filterLifePercent(100, 0)).toBe(0)
  })
})

describe('beep', () => {
  // Verified on hardware: writing 1 reads back 100, so on MUST write 100.
  it('writes 100 for on and 0 for off', () => {
    expect(beepWriteValue(true)).toBe(100)
    expect(beepWriteValue(false)).toBe(0)
  })

  it('treats any non-zero value as on', () => {
    expect(beepStateFromValue(100)).toBe(true)
    expect(beepStateFromValue(50)).toBe(true)
    expect(beepStateFromValue(0)).toBe(false)
    expect(beepStateFromValue(undefined)).toBe(false)
  })
})

describe('lamp', () => {
  it('is on for 1 and 2, off for 0', () => {
    expect(lampOnFromValue(0)).toBe(false)
    expect(lampOnFromValue(1)).toBe(true)
    expect(lampOnFromValue(2)).toBe(true)
  })

  it('writes 1 for on and 0 for off', () => {
    expect(lampWriteValue(true)).toBe(1)
    expect(lampWriteValue(false)).toBe(0)
  })
})

describe('temperatureFromRaw', () => {
  it('divides the raw decidegree reading by ten', () => {
    expect(temperatureFromRaw(fixture.D03224)).toBe(28.4)
  })
})
```

- [ ] **Step 2: Run to verify it fails**

```bash
npx vitest run test/mapping.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/homekit/mapping.ts`**

```typescript
/**
 * Pure device-value to HomeKit-value conversions.
 *
 * Kept free of HAP imports so they can be tested without a Homebridge runtime.
 * Every non-obvious rule here was verified against an AC4220/12 — see the design
 * doc's "Key domains verified on hardware" table.
 */

/** HomeKit AirQuality: 0 UNKNOWN, 1 EXCELLENT … 5 POOR. */
export function airQualityFromPm25(pm25: unknown): number {
  if (typeof pm25 !== 'number' || !Number.isFinite(pm25)) return 0
  if (pm25 <= 12) return 1
  if (pm25 <= 35) return 2
  if (pm25 <= 55) return 3
  if (pm25 <= 150) return 4
  return 5
}

/**
 * Device mode to RotationSpeed percentage.
 *
 * Only the speed ladder (1..speedCount) maps onto the slider. Auto (0), sleep
 * (17), turbo (18) and medium (19) are off-ladder and report 0 so the slider does
 * not display a misleading value.
 */
export function rotationSpeedFromMode(mode: unknown, speedCount: number): number {
  if (typeof mode !== 'number' || mode < 1 || mode > speedCount) return 0
  return Math.round((mode / speedCount) * 100)
}

/**
 * RotationSpeed percentage back to a device mode.
 *
 * Returns null at 0: on the device mode 0 means Auto, so writing it would
 * silently switch to automatic instead of turning off. Off is handled by Active.
 */
export function modeFromRotationSpeed(speed: number, speedCount: number): number | null {
  if (speed <= 0) return null
  const step = 100 / speedCount
  return Math.min(speedCount, Math.max(1, Math.round(speed / step)))
}

/** Remaining filter life as a 0-100 percentage. */
export function filterLifePercent(remaining: unknown, total: unknown): number {
  if (typeof remaining !== 'number' || typeof total !== 'number' || total <= 0) return 0
  return Math.max(0, Math.min(100, Math.round((remaining / total) * 100)))
}

/** Beep is boolean but stored as 0/100 — writing 1 reads back 100. */
export const beepWriteValue = (on: boolean): number => (on ? 100 : 0)
export const beepStateFromValue = (value: unknown): boolean => typeof value === 'number' && value !== 0

/** Lamp mode: 0 off, 1 on, 2 on (dim). */
export const lampOnFromValue = (value: unknown): boolean => typeof value === 'number' && value !== 0
export const lampWriteValue = (on: boolean): number => (on ? 1 : 0)

/** Temperature is reported in decidegrees Celsius. */
export function temperatureFromRaw(raw: unknown): number {
  return typeof raw === 'number' ? raw / 10 : 0
}

/** Child lock and Auto+ AI are plain 0/1 booleans. */
export const boolWriteValue = (on: boolean): number => (on ? 1 : 0)
export const boolStateFromValue = (value: unknown): boolean => value === 1 || value === true
```

- [ ] **Step 4: Run to verify it passes**

```bash
npx vitest run test/mapping.test.ts
```

Expected: PASS.

- [ ] **Step 5: Implement `src/accessory.ts`**

```typescript
import type { CharacteristicValue, PlatformAccessory, Service } from 'homebridge'
import type { PhilipsAirPlatform } from './platform.js'
import type { DeviceConfig } from './airctrl/schema.js'
import type { DeviceCoordinator } from './device/coordinator.js'
import type { DeviceModelConfig } from './device/models.js'
import { Gen3Key } from './device/keys.js'
import {
  airQualityFromPm25,
  beepStateFromValue,
  beepWriteValue,
  boolStateFromValue,
  boolWriteValue,
  filterLifePercent,
  lampOnFromValue,
  lampWriteValue,
  modeFromRotationSpeed,
  rotationSpeedFromMode,
  temperatureFromRaw,
} from './homekit/mapping.js'

export class PhilipsAirAccessory {
  private readonly purifier: Service
  private readonly speedCount: number
  /** Remembered so TargetAirPurifierState=MANUAL can restore a sensible speed. */
  private lastManualMode: number | null = null

  constructor(
    private readonly platform: PhilipsAirPlatform,
    private readonly accessory: PlatformAccessory,
    private readonly coordinator: DeviceCoordinator,
    private readonly model: DeviceModelConfig,
    private readonly config: DeviceConfig,
  ) {
    const { Service: S, Characteristic: C } = this.platform
    this.speedCount = Object.keys(model.speeds).length || 1

    const status = coordinator.status ?? {}
    this.accessory.getService(S.AccessoryInformation)!
      .setCharacteristic(C.Manufacturer, 'Philips')
      .setCharacteristic(C.Model, String(status[Gen3Key.MODEL_ID] ?? 'Unknown'))
      .setCharacteristic(C.SerialNumber, String(status[Gen3Key.SERIAL] ?? 'Unknown'))
      .setCharacteristic(C.FirmwareRevision, String(status[Gen3Key.SOFTWARE_VERSION] ?? '0.0.0'))

    this.purifier = this.accessory.getService(S.AirPurifier)
      ?? this.accessory.addService(S.AirPurifier)

    this.purifier.getCharacteristic(C.Active)
      .onGet(() => this.read(() => (this.value(Gen3Key.POWER) === 1 ? 1 : 0)))
      .onSet(value => this.write({ [Gen3Key.POWER]: value === 1 ? 1 : 0 }))

    this.purifier.getCharacteristic(C.CurrentAirPurifierState)
      .onGet(() => this.read(() => (this.value(Gen3Key.POWER) === 1 ? 2 : 0))) // PURIFYING_AIR : INACTIVE

    this.purifier.getCharacteristic(C.TargetAirPurifierState)
      .onGet(() => this.read(() => (this.value(Gen3Key.MODE_B) === 0 ? 1 : 0))) // AUTO : MANUAL
      .onSet(value => this.setTargetState(value))

    this.purifier.getCharacteristic(C.RotationSpeed)
      .setProps({ minValue: 0, maxValue: 100, minStep: Math.round(100 / this.speedCount) })
      .onGet(() => this.read(() => rotationSpeedFromMode(this.value(Gen3Key.MODE_B), this.speedCount)))
      .onSet(value => this.setRotationSpeed(value))

    this.purifier.getCharacteristic(C.LockPhysicalControls)
      .onGet(() => this.read(() => (boolStateFromValue(this.value(Gen3Key.CHILD_LOCK)) ? 1 : 0)))
      .onSet(value => this.write({ [Gen3Key.CHILD_LOCK]: boolWriteValue(value === 1) }))

    this.setupSensors()
    this.setupFilters()
    this.setupLight()
    this.setupSwitches()

    coordinator.on('status', () => this.pushUpdates())
    coordinator.on('availability', () => this.pushUpdates())
  }

  // --- helpers -------------------------------------------------------------

  private value(key: string): unknown {
    return this.coordinator.status?.[key]
  }

  /**
   * Wrap a read so an offline device reports "No Response" in the Home app
   * instead of a stale value silently presented as current.
   */
  private read<T>(getter: () => T): T {
    if (!this.coordinator.available) {
      throw new this.platform.api.hap.HapStatusError(
        this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE,
      )
    }
    return getter()
  }

  private async write(values: Record<string, unknown>): Promise<void> {
    const ok = await this.coordinator.setControl(values)
    if (!ok) {
      this.platform.log.warn(`Device rejected write ${JSON.stringify(values)}`)
      throw new this.platform.api.hap.HapStatusError(
        this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE,
      )
    }
  }

  private async setTargetState(value: CharacteristicValue): Promise<void> {
    if (value === 1) {
      await this.write({ [Gen3Key.POWER]: 1, [Gen3Key.MODE_B]: 0 }) // AUTO
      return
    }
    // MANUAL: restore the last speed we saw, defaulting to the lowest real speed
    // rather than guessing higher.
    await this.write({ [Gen3Key.POWER]: 1, [Gen3Key.MODE_B]: this.lastManualMode ?? 1 })
  }

  private async setRotationSpeed(value: CharacteristicValue): Promise<void> {
    const mode = modeFromRotationSpeed(Number(value), this.speedCount)
    if (mode === null) {
      // 0% means off. Writing mode 0 would select Auto instead.
      await this.write({ [Gen3Key.POWER]: 0 })
      return
    }
    this.lastManualMode = mode
    await this.write({ [Gen3Key.POWER]: 1, [Gen3Key.MODE_B]: mode })
  }

  private setupSensors(): void {
    const { Service: S, Characteristic: C } = this.platform

    const air = this.accessory.getService(S.AirQualitySensor) ?? this.accessory.addService(S.AirQualitySensor)
    air.getCharacteristic(C.AirQuality).onGet(() => this.read(() => airQualityFromPm25(this.value(Gen3Key.PM25))))
    air.getCharacteristic(C.PM2_5Density)
      .onGet(() => this.read(() => Math.max(0, Math.min(1000, Number(this.value(Gen3Key.PM25)) || 0))))
    this.purifier.addLinkedService(air)

    if (this.value(Gen3Key.TEMPERATURE) !== undefined) {
      const temp = this.accessory.getService(S.TemperatureSensor) ?? this.accessory.addService(S.TemperatureSensor)
      temp.getCharacteristic(C.CurrentTemperature)
        .onGet(() => this.read(() => temperatureFromRaw(this.value(Gen3Key.TEMPERATURE))))
      this.purifier.addLinkedService(temp)
    }

    if (this.value(Gen3Key.HUMIDITY) !== undefined) {
      const humidity = this.accessory.getService(S.HumiditySensor) ?? this.accessory.addService(S.HumiditySensor)
      humidity.getCharacteristic(C.CurrentRelativeHumidity)
        .onGet(() => this.read(() => Math.max(0, Math.min(100, Number(this.value(Gen3Key.HUMIDITY)) || 0))))
      this.purifier.addLinkedService(humidity)
    }
  }

  private setupFilters(): void {
    const { Service: S, Characteristic: C } = this.platform
    const filters: Array<[string, string, string, string]> = [
      ['prefilter', 'Pre-filter', Gen3Key.FILTER_PREFILTER, Gen3Key.FILTER_PREFILTER_TOTAL],
      ['hepa', 'NanoProtect Filter', Gen3Key.FILTER_NANOPROTECT, Gen3Key.FILTER_NANOPROTECT_TOTAL],
    ]

    for (const [id, name, remainingKey, totalKey] of filters) {
      if (this.value(remainingKey) === undefined) continue
      const service = this.accessory.getServiceById(S.FilterMaintenance, id)
        ?? this.accessory.addService(S.FilterMaintenance, name, id)

      service.getCharacteristic(C.FilterLifeLevel)
        .onGet(() => this.read(() => filterLifePercent(this.value(remainingKey), this.value(totalKey))))
      service.getCharacteristic(C.FilterChangeIndication)
        .onGet(() => this.read(() =>
          filterLifePercent(this.value(remainingKey), this.value(totalKey)) <= 5 ? 1 : 0,
        ))
      this.purifier.addLinkedService(service)
    }
  }

  /**
   * Lamp mode (D03135) is the light control. D03105 looks like a backlight
   * setting but is read-only on this firmware — writes ACK and are discarded.
   */
  private setupLight(): void {
    const { Service: S, Characteristic: C } = this.platform
    if (!this.config.exposeLight || this.value(Gen3Key.LAMP_MODE) === undefined) return

    const light = this.accessory.getService(S.Lightbulb) ?? this.accessory.addService(S.Lightbulb, 'Display')
    light.getCharacteristic(C.On)
      .onGet(() => this.read(() => lampOnFromValue(this.value(Gen3Key.LAMP_MODE))))
      .onSet(value => this.write({ [Gen3Key.LAMP_MODE]: lampWriteValue(Boolean(value)) }))
    this.purifier.addLinkedService(light)
  }

  private setupSwitches(): void {
    const { Service: S, Characteristic: C } = this.platform

    const switches: Array<[boolean, string, string, () => boolean, (on: boolean) => Record<string, unknown>]> = [
      [
        this.config.exposeSleepSwitch, 'sleep', 'Sleep Mode',
        () => this.value(Gen3Key.MODE_B) === 17,
        on => (on ? { [Gen3Key.POWER]: 1, [Gen3Key.MODE_B]: 17 } : { [Gen3Key.POWER]: 1, [Gen3Key.MODE_B]: 0 }),
      ],
      [
        this.config.exposeAutoPlusSwitch, 'autoplus', 'Auto+ AI',
        () => boolStateFromValue(this.value(Gen3Key.AUTO_PLUS_AI)),
        on => ({ [Gen3Key.AUTO_PLUS_AI]: boolWriteValue(on) }),
      ],
      [
        this.config.exposeBeepSwitch, 'beep', 'Beep',
        () => beepStateFromValue(this.value(Gen3Key.BEEP)),
        on => ({ [Gen3Key.BEEP]: beepWriteValue(on) }),
      ],
    ]

    for (const [enabled, id, name, getter, writer] of switches) {
      const existing = this.accessory.getServiceById(S.Switch, id)
      if (!enabled) {
        if (existing) this.accessory.removeService(existing)
        continue
      }
      const service = existing ?? this.accessory.addService(S.Switch, name, id)
      service.getCharacteristic(C.On)
        .onGet(() => this.read(getter))
        .onSet(value => this.write(writer(Boolean(value))))
      this.purifier.addLinkedService(service)
    }
  }

  /** Re-read every characteristic from cached state after a device push. */
  private pushUpdates(): void {
    if (!this.coordinator.available) return
    const { Characteristic: C } = this.platform
    const mode = this.value(Gen3Key.MODE_B)
    if (typeof mode === 'number' && mode >= 1 && mode <= this.speedCount) this.lastManualMode = mode

    this.purifier.updateCharacteristic(C.Active, this.value(Gen3Key.POWER) === 1 ? 1 : 0)
    this.purifier.updateCharacteristic(C.CurrentAirPurifierState, this.value(Gen3Key.POWER) === 1 ? 2 : 0)
    this.purifier.updateCharacteristic(C.TargetAirPurifierState, mode === 0 ? 1 : 0)
    this.purifier.updateCharacteristic(C.RotationSpeed, rotationSpeedFromMode(mode, this.speedCount))
  }
}
```

- [ ] **Step 6: Build and verify types**

```bash
npm run build && npx vitest run
```

Expected: build clean, all tests pass. If `setProps` is unavailable on the
characteristic, use `.setProps({...})` from HAP's `Characteristic` — confirm
against `node_modules/homebridge/dist/index.d.ts`.

- [ ] **Step 7: Commit**

```bash
git add src/accessory.ts src/homekit/mapping.ts test/mapping.test.ts
git commit -m "Map device state to HomeKit services

Mapping functions are pure and HAP-free so they test without a
Homebridge runtime, against the real captured device payload.

Three rules come from hardware probing, not the HA registry:
- Lightbulb targets D03135 (lamp mode); D03105 is read-only
- Beep writes 100 for on, since writing 1 reads back 100
- RotationSpeed 0 never writes D0310C=0, which means Auto not off"
```

---

### Task 9: Wire up the dynamic platform

**Goal:** `src/platform.ts` — discover configured devices, create or restore one accessory each, and prune accessories whose config was removed.

**Files:**
- Create: `src/platform.ts`
- Modify: `src/index.ts`
- Create: `test/platform.test.ts`

**Acceptance Criteria:**
- [ ] Implements `DynamicPlatformPlugin` and registers on `didFinishLaunching`
- [ ] Generates a stable accessory UUID from the device id, falling back to the host
- [ ] Restores cached accessories via `configureAccessory` instead of duplicating them
- [ ] Unregisters cached accessories no longer present in config
- [ ] A device that fails to connect at startup logs an error and is skipped — it never crashes Homebridge or takes down the platform
- [ ] With no `devices` configured the platform logs once and creates nothing
- [ ] An unknown model logs once at info and uses a generation-detected generic profile
- [ ] `shutdown` tears down every coordinator

**Verify:** `npx vitest run test/platform.test.ts && npm run build` → tests pass, build clean

**Steps:**

- [ ] **Step 1: Write the failing tests**

```typescript
// test/platform.test.ts
import { describe, expect, it, vi } from 'vitest'
import { accessoryUuidSeed, devicesToPrune } from '../src/platform.js'

describe('accessoryUuidSeed', () => {
  it('prefers a stable device id so a DHCP change keeps the accessory', () => {
    expect(accessoryUuidSeed({ host: '192.168.20.151' }, '96868ce0')).toBe('96868ce0')
  })

  it('falls back to the host when the device id is unknown', () => {
    expect(accessoryUuidSeed({ host: '192.168.20.151' }, undefined)).toBe('192.168.20.151')
  })
})

describe('devicesToPrune', () => {
  it('returns cached accessories whose UUID is no longer configured', () => {
    const cached = [{ UUID: 'a' }, { UUID: 'b' }, { UUID: 'c' }] as never[]
    expect(devicesToPrune(cached, new Set(['a', 'c']))).toEqual([{ UUID: 'b' }])
  })

  it('returns nothing when every cached accessory is still configured', () => {
    const cached = [{ UUID: 'a' }] as never[]
    expect(devicesToPrune(cached, new Set(['a']))).toEqual([])
  })
})
```

- [ ] **Step 2: Run to verify it fails**

```bash
npx vitest run test/platform.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/platform.ts`**

```typescript
import type {
  API,
  Characteristic as CharacteristicClass,
  DynamicPlatformPlugin,
  Logging,
  PlatformAccessory,
  PlatformConfig,
  Service as ServiceClass,
} from 'homebridge'
import { PhilipsAirAccessory } from './accessory.js'
import { PhilipsCoapClient } from './airctrl/client.js'
import { PluginConfigSchema, type DeviceConfig } from './airctrl/schema.js'
import { DeviceCoordinator } from './device/coordinator.js'
import { detectGeneration, resolveModel } from './device/models.js'
import { Gen3Key } from './device/keys.js'
import { PLATFORM_NAME, PLUGIN_NAME } from './settings.js'

/** Stable seed for the accessory UUID: device id if known, else host. */
export function accessoryUuidSeed(device: Pick<DeviceConfig, 'host'>, deviceId: string | undefined): string {
  return deviceId ?? device.host
}

/** Cached accessories no longer represented in the config. */
export function devicesToPrune<T extends { UUID: string }>(cached: T[], configured: Set<string>): T[] {
  return cached.filter(accessory => !configured.has(accessory.UUID))
}

export class PhilipsAirPlatform implements DynamicPlatformPlugin {
  public readonly Service: typeof ServiceClass
  public readonly Characteristic: typeof CharacteristicClass
  private readonly cached: PlatformAccessory[] = []
  private readonly coordinators = new Set<DeviceCoordinator>()

  constructor(
    public readonly log: Logging,
    public readonly config: PlatformConfig,
    public readonly api: API,
  ) {
    this.Service = api.hap.Service
    this.Characteristic = api.hap.Characteristic

    api.on('didFinishLaunching', () => void this.discoverDevices())
    api.on('shutdown', () => void this.shutdown())
  }

  /** Called for every accessory restored from disk, before didFinishLaunching. */
  configureAccessory(accessory: PlatformAccessory): void {
    this.log.debug(`Restoring cached accessory ${accessory.displayName}`)
    this.cached.push(accessory)
  }

  private async discoverDevices(): Promise<void> {
    const parsed = PluginConfigSchema.safeParse(this.config)
    if (!parsed.success) {
      this.log.error(`Invalid plugin configuration, doing nothing: ${parsed.error.message}`)
      return
    }

    const devices = parsed.data.devices
    if (devices.length === 0) {
      this.log.info('No devices configured. Add one in the Homebridge UI to get started.')
      return
    }

    const configuredUuids = new Set<string>()
    for (const device of devices) {
      try {
        const uuid = await this.setUpDevice(device)
        if (uuid) configuredUuids.add(uuid)
      } catch (error) {
        // A single unreachable device must never take down the platform.
        this.log.error(`Failed to set up device at ${device.host}: ${(error as Error).message}`)
      }
    }

    const stale = devicesToPrune(this.cached, configuredUuids)
    if (stale.length > 0) {
      this.log.info(`Removing ${stale.length} accessory/accessories no longer in config`)
      this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, stale)
    }
  }

  private async setUpDevice(device: DeviceConfig): Promise<string | null> {
    const makeClient = async () => new PhilipsCoapClient(device.host, device.port)
    const client = await makeClient()

    const coordinator = new DeviceCoordinator(client, this.log, device.host, makeClient)
    this.coordinators.add(coordinator)
    await coordinator.start()

    const status = coordinator.status ?? {}
    const deviceId = typeof status.DeviceId === 'string' ? status.DeviceId : undefined
    const uuid = this.api.hap.uuid.generate(accessoryUuidSeed(device, deviceId))

    const modelId = String(status[Gen3Key.MODEL_ID] ?? '')
    const model = resolveModel(modelId, detectGeneration(status))
    const displayName = device.name
      ?? (typeof status[Gen3Key.NAME] === 'string' ? String(status[Gen3Key.NAME]) : modelId)
      || device.host

    if (!modelId) {
      this.log.info(`Device at ${device.host} reported no model id; using a generic profile`)
    }

    const existing = this.cached.find(accessory => accessory.UUID === uuid)
    if (existing) {
      existing.displayName = displayName
      existing.context.device = device
      this.api.updatePlatformAccessories([existing])
      new PhilipsAirAccessory(this, existing, coordinator, model, device)
      this.log.info(`Restored ${displayName} (${modelId || 'unknown model'}) at ${device.host}`)
      return uuid
    }

    const accessory = new this.api.platformAccessory(displayName, uuid)
    accessory.context.device = device
    new PhilipsAirAccessory(this, accessory, coordinator, model, device)
    this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory])
    this.log.info(`Added ${displayName} (${modelId || 'unknown model'}) at ${device.host}`)
    return uuid
  }

  private async shutdown(): Promise<void> {
    for (const coordinator of this.coordinators) await coordinator.shutdown()
    this.coordinators.clear()
  }
}
```

- [ ] **Step 4: Replace `src/index.ts` with the real registration**

```typescript
import type { API } from 'homebridge'
import { PhilipsAirPlatform } from './platform.js'
import { PLATFORM_NAME } from './settings.js'

export default (api: API): void => {
  api.registerPlatform(PLATFORM_NAME, PhilipsAirPlatform)
}
```

- [ ] **Step 5: Run tests and build**

```bash
npx vitest run && npm run build
```

Expected: all tests pass, build clean.

- [ ] **Step 6: Commit**

```bash
git add src/platform.ts src/index.ts test/platform.test.ts
git commit -m "Wire up the dynamic platform

Accessory UUIDs seed from the device id rather than the host, so a DHCP
lease change does not orphan the accessory and duplicate it.

A device that fails to connect logs an error and is skipped; it never
takes down the platform or crashes Homebridge."
```

---

### Task 10: Build the custom configuration UI

**Goal:** `config.schema.json` plus a custom UI that scans the network, probes a manual IP, and manages the device list — so nothing is ever configured by editing JSON.

**Files:**
- Create: `config.schema.json`
- Create: `homebridge-ui/server.js`
- Create: `homebridge-ui/public/index.html`

**Acceptance Criteria:**
- [ ] `config.schema.json` sets `pluginAlias: "PhilipsAir"`, `pluginType: "platform"`, `singular: true`, `customUiPath: "./homebridge-ui"`
- [ ] The UI lists configured devices and supports remove
- [ ] "Scan network" returns discovered devices with model, name, and firmware
- [ ] Manual IP entry validates the address format, probes the host, and rejects one that is not a Philips device with a clear message
- [ ] Adding a device writes it via `homebridge.updatePluginConfig` + `savePluginConfig`, and refuses a duplicate host
- [ ] Per-device toggles for the Sleep, Auto+ AI, and Beep switches and the Lightbulb
- [ ] `server.js` throws `RequestError` for user-facing failures and never leaves an unhandled rejection
- [ ] A subnet larger than 1024 addresses is refused with a message rather than scanned
- [ ] `npm pack --dry-run` lists `config.schema.json` and the `homebridge-ui` files

**Verify:** `npm run build`, deploy, then open the plugin's Settings in the Homebridge UI: scan finds `192.168.20.151` as `AC4220/12` and adding it writes a `devices` entry.

**Steps:**

- [ ] **Step 1: Create `config.schema.json`**

The schema stays minimal because the custom UI owns the real editing experience.

```json
{
  "pluginAlias": "PhilipsAir",
  "pluginType": "platform",
  "singular": true,
  "customUiPath": "./homebridge-ui",
  "headerDisplay": "Philips air purifiers over encrypted CoAP. Use the panel above to scan for devices — no JSON editing required.",
  "schema": {
    "type": "object",
    "properties": {
      "name": {
        "title": "Platform Name",
        "type": "string",
        "default": "Philips Air",
        "required": true
      },
      "devices": {
        "type": "array",
        "items": {
          "type": "object",
          "properties": {
            "host": { "title": "IP Address", "type": "string", "required": true },
            "name": { "title": "Name", "type": "string" },
            "port": { "title": "CoAP Port", "type": "integer", "default": 5683 },
            "exposeLight": { "title": "Expose display light", "type": "boolean", "default": true },
            "exposeSleepSwitch": { "title": "Expose Sleep switch", "type": "boolean", "default": false },
            "exposeAutoPlusSwitch": { "title": "Expose Auto+ AI switch", "type": "boolean", "default": false },
            "exposeBeepSwitch": { "title": "Expose Beep switch", "type": "boolean", "default": false }
          }
        }
      }
    }
  }
}
```

- [ ] **Step 2: Create `homebridge-ui/server.js`**

This runs in the Homebridge UI's Node process, so it imports the built plugin
code from `dist/`.

```javascript
import { HomebridgePluginUiServer, RequestError } from '@homebridge/plugin-ui-utils'
import { discover, hostsInSubnet, localSubnets, probeHost } from '../dist/airctrl/discovery.js'

class PhilipsAirUiServer extends HomebridgePluginUiServer {
  constructor() {
    super()

    this.onRequest('/subnets', async () => {
      return { subnets: localSubnets() }
    })

    this.onRequest('/scan', async (payload = {}) => {
      const subnet = payload.subnet || localSubnets()[0]
      if (!subnet) throw new RequestError('No local IPv4 network detected. Enter an IP address manually.')

      const hosts = [...hostsInSubnet(subnet)]
      if (hosts.length > 1024) {
        throw new RequestError(`Subnet ${subnet} has ${hosts.length} addresses, which is too many to scan. Enter an IP manually.`)
      }
      const devices = await discover({ hosts, timeoutMs: 1500, concurrency: 48 })
      return { subnet, scanned: hosts.length, devices }
    })

    this.onRequest('/probe', async (payload = {}) => {
      const host = String(payload.host || '').trim()
      if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) throw new RequestError(`"${host}" is not a valid IPv4 address.`)

      const device = await probeHost(host, Number(payload.port) || 5683, 4000)
      if (!device) throw new RequestError(`No Philips air purifier answered at ${host}. Check the IP and that the device is on this network.`)
      return { device }
    })

    this.ready()
  }
}

// eslint-disable-next-line no-new
new PhilipsAirUiServer()
```

- [ ] **Step 3: Create `homebridge-ui/public/index.html`**

```html
<style>
  .pa-row { display: flex; align-items: center; gap: .5rem; flex-wrap: wrap; margin-bottom: .5rem; }
  .pa-card { border: 1px solid rgba(128,128,128,.3); border-radius: 6px; padding: .75rem; margin-bottom: .5rem; }
  .pa-muted { opacity: .7; font-size: .85rem; }
  .pa-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: .25rem .75rem; }
  .pa-status { min-height: 1.4rem; }
</style>

<div class="pa-row">
  <button class="btn btn-primary" id="scan">Scan network</button>
  <span class="pa-muted" id="subnet"></span>
</div>

<div class="pa-row">
  <input class="form-control" id="manual-host" placeholder="Or enter an IP, e.g. 192.168.20.151" style="max-width:22rem">
  <button class="btn btn-secondary" id="add-manual">Add</button>
</div>

<div class="pa-status" id="status"></div>
<div id="found"></div>

<h5 class="mt-3">Configured devices</h5>
<div id="configured"></div>

<script>
  const statusEl = document.getElementById('status')
  const foundEl = document.getElementById('found')
  const configuredEl = document.getElementById('configured')

  const say = (message, kind = 'muted') => {
    statusEl.innerHTML = message ? `<span class="text-${kind}">${message}</span>` : ''
  }

  async function currentConfig() {
    const blocks = await homebridge.getPluginConfig()
    if (blocks.length === 0) {
      blocks.push({ platform: 'PhilipsAir', name: 'Philips Air', devices: [] })
      await homebridge.updatePluginConfig(blocks)
    }
    blocks[0].devices ||= []
    return blocks
  }

  async function renderConfigured() {
    const blocks = await currentConfig()
    const devices = blocks[0].devices
    if (devices.length === 0) {
      configuredEl.innerHTML = '<p class="pa-muted">None yet. Scan the network or add an IP above.</p>'
      return
    }

    configuredEl.innerHTML = devices.map((device, index) => `
      <div class="pa-card">
        <div class="pa-row" style="justify-content:space-between">
          <strong>${device.name || device.host}</strong>
          <button class="btn btn-sm btn-danger" data-remove="${index}">Remove</button>
        </div>
        <div class="pa-muted">${device.host}${device.model ? ` &middot; ${device.model}` : ''}</div>
        <div class="pa-grid mt-2">
          ${checkbox(index, 'exposeLight', 'Display light', device.exposeLight !== false)}
          ${checkbox(index, 'exposeSleepSwitch', 'Sleep switch', !!device.exposeSleepSwitch)}
          ${checkbox(index, 'exposeAutoPlusSwitch', 'Auto+ AI switch', !!device.exposeAutoPlusSwitch)}
          ${checkbox(index, 'exposeBeepSwitch', 'Beep switch', !!device.exposeBeepSwitch)}
        </div>
      </div>
    `).join('')
  }

  const checkbox = (index, key, label, checked) => `
    <label><input type="checkbox" data-index="${index}" data-key="${key}" ${checked ? 'checked' : ''}> ${label}</label>
  `

  async function addDevice(device) {
    const blocks = await currentConfig()
    if (blocks[0].devices.some(existing => existing.host === device.host)) {
      say(`${device.host} is already configured.`, 'warning')
      return
    }
    blocks[0].devices.push({
      host: device.host,
      name: device.name || device.model,
      model: device.model,
      exposeLight: true,
      exposeSleepSwitch: false,
      exposeAutoPlusSwitch: false,
      exposeBeepSwitch: false,
    })
    await homebridge.updatePluginConfig(blocks)
    await homebridge.savePluginConfig()
    say(`Added ${device.name || device.host}. Restart Homebridge to apply.`, 'success')
    await renderConfigured()
  }

  document.getElementById('scan').addEventListener('click', async () => {
    foundEl.innerHTML = ''
    say('Scanning…')
    homebridge.showSpinner()
    try {
      const { subnet, scanned, devices } = await homebridge.request('/scan')
      document.getElementById('subnet').textContent = `${subnet} (${scanned} addresses)`
      if (devices.length === 0) {
        say('No devices found. Try adding the IP manually.', 'warning')
        return
      }
      say(`Found ${devices.length} device(s).`, 'success')
      foundEl.innerHTML = devices.map(device => `
        <div class="pa-card pa-row" style="justify-content:space-between">
          <span>
            <strong>${device.model}</strong> &ldquo;${device.name}&rdquo;<br>
            <span class="pa-muted">${device.host}${device.firmware ? ` &middot; fw ${device.firmware}` : ''}</span>
          </span>
          <button class="btn btn-sm btn-primary" data-add='${JSON.stringify(device)}'>Add</button>
        </div>
      `).join('')
    } catch (error) {
      say(error.message || 'Scan failed.', 'danger')
    } finally {
      homebridge.hideSpinner()
    }
  })

  document.getElementById('add-manual').addEventListener('click', async () => {
    const host = document.getElementById('manual-host').value.trim()
    say('Probing…')
    homebridge.showSpinner()
    try {
      const { device } = await homebridge.request('/probe', { host })
      await addDevice(device)
    } catch (error) {
      say(error.message || 'Probe failed.', 'danger')
    } finally {
      homebridge.hideSpinner()
    }
  })

  document.addEventListener('click', async event => {
    const addTarget = event.target.closest('[data-add]')
    if (addTarget) await addDevice(JSON.parse(addTarget.dataset.add))

    const removeTarget = event.target.closest('[data-remove]')
    if (removeTarget) {
      const blocks = await currentConfig()
      blocks[0].devices.splice(Number(removeTarget.dataset.remove), 1)
      await homebridge.updatePluginConfig(blocks)
      await homebridge.savePluginConfig()
      say('Removed. Restart Homebridge to apply.', 'success')
      await renderConfigured()
    }
  })

  document.addEventListener('change', async event => {
    const input = event.target.closest('input[type=checkbox][data-key]')
    if (!input) return
    const blocks = await currentConfig()
    blocks[0].devices[Number(input.dataset.index)][input.dataset.key] = input.checked
    await homebridge.updatePluginConfig(blocks)
    await homebridge.savePluginConfig()
    say('Saved. Restart Homebridge to apply.', 'success')
  })

  renderConfigured().then(() => homebridge.showSchemaForm())
</script>
```

- [ ] **Step 4: Verify the schema is valid JSON and the UI ships**

```bash
node -e "JSON.parse(require('fs').readFileSync('config.schema.json','utf8')); console.log('schema OK')"
npm pack --dry-run 2>&1 | grep -E 'homebridge-ui|config.schema'
```

Expected: schema OK, and both `config.schema.json` and the `homebridge-ui` files appear in the pack listing.

- [ ] **Step 5: Commit**

```bash
git add config.schema.json homebridge-ui
git commit -m "Add custom configuration UI with network discovery

config.schema.json stays minimal because the custom UI owns the editing
experience: scan, manual-IP probe with validation, per-device service
toggles, and remove."
```

---

### Task 11: Deploy to Homebridge and verify on real hardware

**Goal:** The plugin runs on the live Homebridge instance and the AC4220/12 appears and responds correctly in HomeKit.

> **USER-ORDERED GATE — NON-SKIPPABLE.** This task was requested by the user in the current conversation. It MUST NOT be closed by walking around it, by declaring it "verified inline", or by substituting a cheaper check. Close only after every item in `acceptanceCriteria` has been re-validated independently, with output captured.

**Files:**
- Create: `scripts/deploy.sh`
- Create: `.env.example`
- Modify: `.env` (reformat to `KEY=VALUE`; never commit)

**Acceptance Criteria:**
- [ ] `scripts/deploy.sh` builds, packs, ships, installs, and restarts without manual steps
- [ ] Homebridge debug log shows the plugin loading with no unhandled exceptions
- [ ] Log shows the device added with model `AC4220/12` and its real name
- [ ] The accessory appears in the Homebridge UI's Accessories tab
- [ ] Toggling `Active` off then on in the UI is reflected on the physical device
- [ ] Setting `RotationSpeed` to 40% sets device speed 2; 100% engages turbo
- [ ] Changing the speed on the physical device updates the UI within seconds (proves the observe stream works in the inbound direction)
- [ ] Reported temperature, humidity, PM2.5, and both filter percentages match the device's own display
- [ ] Powering the device off makes the accessory show "No Response" within ~180s, and the unavailable transition is logged exactly ONCE, not repeatedly
- [ ] Restoring power reconnects automatically with a `Reconnected to` log line
- [ ] Every device setting touched during verification is returned to its original value

**Verify:** `bash scripts/deploy.sh` exits 0, then `ssh root@192.168.20.21 'docker logs --tail 200 homebridge'` shows the device added with no exceptions

**Steps:**

- [ ] **Step 1: Reformat `.env` to `KEY=VALUE` and add `.env.example`**

The current `.env` is six bare lines and cannot be sourced. Preserve the values;
only add keys.

```bash
# .env.example — commit this one
HOMEBRIDGE_URL=192.168.20.21:8581
HOMEBRIDGE_USER=your-ui-username
HOMEBRIDGE_PASS=your-ui-password
UNRAID_HOST=192.168.20.21
UNRAID_USER=root
UNRAID_PASS=your-root-password
PURIFIER_HOST=192.168.20.151
```

Rewrite `.env` with the same keys and the real values already in it. Confirm it
stays untracked:

```bash
git check-ignore -v .env   # must print a .gitignore match
```

- [ ] **Step 2: Create `scripts/deploy.sh`**

Verified layout: Homebridge runs in Docker container `homebridge`, and
`/var/lib/homebridge` is a symlink to `/homebridge`, which is the host directory
`/mnt/cache/appdata/homebridge`.

```bash
#!/usr/bin/env bash
# Build, ship, install, and restart. Requires sshpass and a .env with the keys
# listed in .env.example.
set -euo pipefail

cd "$(dirname "$0")/.."
set -a; source .env; set +a

: "${UNRAID_HOST:?}" "${UNRAID_PASS:?}" "${HOMEBRIDGE_URL:?}" "${HOMEBRIDGE_USER:?}" "${HOMEBRIDGE_PASS:?}"

CONTAINER=homebridge
HOST_DIR=/mnt/cache/appdata/homebridge

echo "==> Building"
npm run build
npm test

echo "==> Packing"
TARBALL=$(npm pack --silent | tail -1)
trap 'rm -f "$TARBALL"' EXIT

echo "==> Copying $TARBALL to $UNRAID_HOST:$HOST_DIR"
sshpass -p "$UNRAID_PASS" scp -o StrictHostKeyChecking=no "$TARBALL" \
  "${UNRAID_USER:-root}@$UNRAID_HOST:$HOST_DIR/$TARBALL"

echo "==> Installing inside the container"
sshpass -p "$UNRAID_PASS" ssh -o StrictHostKeyChecking=no "${UNRAID_USER:-root}@$UNRAID_HOST" \
  "docker exec $CONTAINER npm install --prefix /var/lib/homebridge '/homebridge/$TARBALL' && rm -f '$HOST_DIR/$TARBALL'"

echo "==> Restarting Homebridge"
TOKEN=$(curl -fsS -X POST "http://$HOMEBRIDGE_URL/api/auth/login" \
  -H 'Content-Type: application/json' \
  -d "{\"username\":\"$HOMEBRIDGE_USER\",\"password\":\"$HOMEBRIDGE_PASS\"}" \
  | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>console.log(JSON.parse(d).access_token))')
curl -fsS -X PUT "http://$HOMEBRIDGE_URL/api/server/restart" -H "Authorization: Bearer $TOKEN" >/dev/null

echo "==> Done. Tailing logs (Ctrl-C to stop)"
sleep 8
sshpass -p "$UNRAID_PASS" ssh -o StrictHostKeyChecking=no "${UNRAID_USER:-root}@$UNRAID_HOST" \
  "docker logs --tail 120 $CONTAINER" | grep -iE 'philips|error|warn' || true
```

```bash
chmod +x scripts/deploy.sh
```

- [ ] **Step 3: Deploy**

```bash
bash scripts/deploy.sh
```

Expected: exits 0, and the log tail shows the platform initialising.

- [ ] **Step 4: Confirm the plugin loaded and the device was added**

```bash
set -a; source .env; set +a
sshpass -p "$UNRAID_PASS" ssh -o StrictHostKeyChecking=no root@"$UNRAID_HOST" \
  "docker logs --tail 300 homebridge" | grep -iE 'philips|AC4220|unhandled|exception'
```

Expected: a line like `Added Office 1 (AC4220/12) at 192.168.20.151`. No
`unhandled`, no stack traces.

- [ ] **Step 5: Verify readings match the device**

Open `http://192.168.20.21:8581`, go to Accessories, and compare against the
device's own panel and against a direct read:

```bash
node scripts/coap-spike.mjs 192.168.20.151 | grep -E 'power:|prefilter:|decrypted'
```

Check temperature (`D03224 ÷ 10`), humidity (`D03125`), PM2.5 (`D03221`),
pre-filter (`D0520D / D05207`), and NanoProtect (`D0540E / D05408`).

- [ ] **Step 6: Verify control in both directions**

From the Homebridge UI Accessories tab:
1. Toggle the purifier off, confirm the physical device stops, toggle it back on.
2. Set speed to 40%, confirm the device shows speed 2.
3. Set speed to 100%, confirm the device engages turbo.
4. Change the speed on the physical device and confirm the UI follows within a few seconds (this exercises the observe stream).

Record the original power state and speed first, and restore them at the end.

- [ ] **Step 7: Verify offline behaviour and recovery**

Power the purifier off at the wall (or block its IP). Within roughly three
minutes (`Max-Age 60 × 3`) the accessory must show "No Response", and the log
must show the unavailable transition exactly once, not repeatedly. Restore power
and confirm automatic reconnection with a `Reconnected to` log line.

- [ ] **Step 8: Restore the device and commit**

Confirm every setting touched is back to its original value, then:

```bash
git add scripts/deploy.sh .env.example
git commit -m "Add deploy script and verify on real hardware

Deploys into the homebridge Docker container: /var/lib/homebridge is a
symlink to /homebridge, mounted from /mnt/cache/appdata/homebridge on
the host, so the tarball is copied there and installed with
npm --prefix /var/lib/homebridge.

.env.example documents the required keys; .env stays untracked."
```

---

### Task 12: Adversarial code review and fixes

**Goal:** CodeRabbit and Codex both review the full implementation, and every valid finding is fixed or explicitly dismissed with a reason.

> **USER-ORDERED GATE — NON-SKIPPABLE.** This task was requested by the user in the current conversation. It MUST NOT be closed by walking around it, by declaring it "verified inline", or by substituting a cheaper check. Close only after every item in `acceptanceCriteria` has been re-validated independently, with output captured.

**Files:**
- Modify: whatever the reviews identify
- Create: `docs/superpowers/reviews/2026-07-30-review-notes.md`

**Acceptance Criteria:**
- [ ] CodeRabbit CLI has reviewed the branch and its output is captured
- [ ] Codex has performed an independent adversarial review and its output is captured
- [ ] Every finding is recorded with a disposition: fixed, or dismissed with a stated reason
- [ ] All tests still pass and the build is clean after the fixes
- [ ] The protocol-critical invariants are explicitly re-checked: `>>> 0` in `nextKey`, beep writing 100, the light targeting `D03135`, and `RotationSpeed` 0 never writing mode 0
- [ ] No secret or credential appears anywhere in the tracked tree

**Verify:** `npm test && npm run build && npm run lint` all exit 0, and the review notes list every finding with a disposition

**Steps:**

- [ ] **Step 1: Run CodeRabbit**

```bash
coderabbit review --plain 2>&1 | tee /tmp/coderabbit-review.txt
```

Use the `coderabbit:coderabbit-review` skill if the CLI is not on `PATH`.

- [ ] **Step 2: Run an independent Codex adversarial review**

Invoke the `codex:rescue` skill, or the CLI directly, with a brief that names the
specific hazards rather than asking for a generic review:

```
Adversarially review this Homebridge plugin for correctness bugs. Assume the
author is overconfident. Focus on:
  1. src/airctrl/crypto.ts — is the AES/MD5/SHA-256 port exactly equivalent to
     the Python original? Check padding, encoding, and the 32-bit key wrap.
  2. src/airctrl/client.ts — resource leaks in the observe generator, unhandled
     rejections, retry logic that could loop forever, missing timeouts.
  3. src/device/coordinator.ts — races between shutdown, reconnect and the
     watchdog. Can two reconnect chains run at once? Can a timer outlive
     shutdown?
  4. src/accessory.ts — can a HomeKit write ever send a value the device
     rejects? Is RotationSpeed 0 handled without ever writing D0310C=0?
  5. homebridge-ui/server.js — input validation on the probe and scan handlers.
Report concrete failure scenarios with inputs, not style opinions.
```

- [ ] **Step 3: Triage into review notes**

Create `docs/superpowers/reviews/2026-07-30-review-notes.md` with one row per
finding: source, severity, claim, disposition, and reasoning. Verify each claim
against the code before acting — use the
`superpowers-extended-cc:receiving-code-review` skill. Reviewers are wrong
sometimes; a finding that contradicts hardware-verified behaviour (the beep 0/100
value, `D03105` being read-only) should be dismissed with that evidence cited.

- [ ] **Step 4: Fix the valid findings**

Fix each accepted finding, adding a regression test where the bug was
behavioural. Commit fixes in small related batches rather than one large commit.

- [ ] **Step 5: Re-check the protocol invariants explicitly**

```bash
grep -n '>>> 0' src/airctrl/crypto.ts                       # must be present
grep -n '& 0xFFFFFFFF' src/ || echo 'no signed AND — good'  # must find nothing
grep -n 'beepWriteValue' src/homekit/mapping.ts             # on must be 100
grep -n 'D03105' src/accessory.ts || echo 'light does not use the read-only key — good'
npx vitest run test/mapping.test.ts test/crypto.test.ts
```

- [ ] **Step 6: Confirm no secrets are tracked**

```bash
git ls-files | xargs grep -lniE 'password|secret|token|gIrpit|tasvyh' || echo 'no credentials tracked'
git check-ignore -v .env
```

`JiangPan` in `crypto.ts` is the firmware constant and is expected.

- [ ] **Step 7: Full verification and commit**

```bash
npm test && npm run build && npm run lint
bash scripts/deploy.sh   # confirm the reviewed build still works on hardware
```

```bash
git add docs/superpowers/reviews src test
git commit -m "Apply code review findings from CodeRabbit and Codex

Review notes record every finding with its disposition. Findings that
contradicted hardware-verified behaviour were dismissed with the probe
evidence cited rather than applied."
```

---

## Deferred to a follow-up plan

Recorded here so they are not silently lost:

| Item | Why deferred |
|---|---|
| CX7550 `status_nudge` path | Untestable without the hardware; entangles reconnect logic |
| `HumidifierDehumidifier` service | AC2729 / HU / CX models not owned |
| `HeaterCooler` service | AMF765 / AMF870 / CX heater models not owned |
| Oscillation / `SwingMode` | AMF models only |
| AC1214 mode cycling | Model-specific quirk, untestable |
| Allergen index characteristic | No HomeKit characteristic exists; needs a custom one |
| Matter export | HAP is the requirement for v1 |
| Homebridge Verified submission | Wants a published npm release and a GitHub release per version |
