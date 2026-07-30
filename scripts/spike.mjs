// Protocol spike: prove Philips CoAP handshake/decrypt/observe works in Node.
// Mirrors philips_airctrl coap/{encryption,client}.py.
import crypto from 'node:crypto'
import coap from 'coap'

const HOST = process.argv[2] ?? '192.168.20.151'
const PORT = 5683
const SECRET = 'JiangPan'

// --- encryption.py port ---
function cipherParts(key) {
  const kv = crypto.createHash('md5').update(SECRET + key).digest('hex').toUpperCase()
  return [Buffer.from(kv.slice(0, 16), 'ascii'), Buffer.from(kv.slice(16), 'ascii')]
}
function nextKey(key) {
  const n = (parseInt(key, 16) + 1) & 0xFFFFFFFF
  return n.toString(16).padStart(8, '0').toUpperCase()
}
function encrypt(key, payload) {
  const [k, iv] = cipherParts(key)
  const c = crypto.createCipheriv('aes-128-cbc', k, iv) // PKCS7 is the default
  const ct = Buffer.concat([c.update(payload, 'utf8'), c.final()]).toString('hex').toUpperCase()
  const digest = crypto.createHash('sha256').update(key + ct).digest('hex').toUpperCase()
  return key + ct + digest
}
function decrypt(blob) {
  const key = blob.slice(0, 8)
  const ct = blob.slice(8, -64)
  const digest = blob.slice(-64)
  const calc = crypto.createHash('sha256').update(key + ct).digest('hex').toUpperCase()
  if (digest !== calc) throw new Error(`digest mismatch: got ${digest} want ${calc}`)
  const [k, iv] = cipherParts(key)
  const d = crypto.createDecipheriv('aes-128-cbc', k, iv)
  return Buffer.concat([d.update(Buffer.from(ct, 'hex')), d.final()]).toString('utf8')
}

// --- client.py port ---
function req(opts, body) {
  return new Promise((resolve, reject) => {
    const r = coap.request({ hostname: HOST, port: PORT, confirmable: false, ...opts })
    const t = setTimeout(() => { r.destroy?.(); reject(new Error(`timeout ${opts.pathname}`)) }, 8000)
    r.on('response', res => { clearTimeout(t); resolve(res) })
    r.on('error', e => { clearTimeout(t); reject(e) })
    if (body !== undefined) r.write(Buffer.from(body))
    r.end()
  })
}

const log = (...a) => console.log(...a)

// 1. plaintext /sys/dev/info (no handshake needed)
try {
  const res = await req({ method: 'GET', pathname: '/sys/dev/info' })
  log('[1] info OK:', res.payload.toString().slice(0, 200))
} catch (e) { log('[1] info FAILED:', e.message) }

// 2. sync handshake
const syncReq = crypto.randomBytes(4).toString('hex').toUpperCase()
const syncRes = await req({ method: 'POST', pathname: '/sys/dev/sync' }, syncReq)
let clientKey = syncRes.payload.toString().trim()
log('[2] sync OK: clientKey =', clientKey)

// 3. one-shot status read (needs Observe option to elicit a response)
const statusRes = await req({ method: 'GET', pathname: '/sys/dev/status', observe: true })
log('[3] Max-Age header =', statusRes.headers['Max-Age'])
const first = statusRes.payload.toString()
const status = JSON.parse(decrypt(first)).state.reported
log('[3] decrypt OK, keys =', Object.keys(status).length)
log('    model:', status.D01S05 ?? status.modelid, '| name:', status.D01S03 ?? status.name)
log('    power:', status.D03102 ?? status.pwr, '| mode:', status.D0310C, '| pm25:', status.D03221 ?? status.pm25)
log('    full:', JSON.stringify(status))

// 4. can we tear the observation down? (node-coap has no proactive cancel)
log('[4] observe stream is a', statusRes.constructor.name, '| close():', typeof statusRes.close)
let pushes = 0
statusRes.on('data', () => { pushes++ })

// 5. control write round-trip: toggle beep (D03130) and put it straight back
const desired = v => JSON.stringify({
  state: { desired: { CommandType: 'app', DeviceId: '', EnduserId: '', D03130: v } },
})
const beep = status.D03130
if (!process.argv.includes('--write')) {
  log('[5] skipped control write (pass --write to test it)')
} else if (beep !== undefined) {
  const target = beep ? 0 : 1
  for (const v of [target, beep]) {
    clientKey = nextKey(clientKey)
    const res = await req({ method: 'POST', pathname: '/sys/dev/control' }, encrypt(clientKey, desired(v)))
    log(`[5] control D03130=${v} ->`, res.payload.toString())
  }
} else { log('[5] skipped: no D03130 key on this device') }

// 6. did observe push the change?
await new Promise(r => setTimeout(r, 6000))
log(`[6] observe pushes received in 6s: ${pushes}`)
statusRes.close?.()
log('[6] closed observation')
process.exit(0)
