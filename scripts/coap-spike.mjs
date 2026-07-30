// Spike: our own minimal CoAP over node:dgram, replacing the `coap` package.
// Scope is deliberately tiny — NON messages, GET/POST, Uri-Path, Observe,
// Max-Age. No CON/ACK retransmission, no block-wise transfer, no server mode.
import crypto from 'node:crypto'
import dgram from 'node:dgram'

// --- RFC 7252 message codec ------------------------------------------------

const TYPE_NON = 1
const TYPE_ACK = 2
const TYPE_RST = 3
const CODE_GET = 0.01 * 100 // 1
const CODE_POST = 2

const OPT_OBSERVE = 6
const OPT_URI_PATH = 11
const OPT_MAX_AGE = 14

/** Encode an unsigned integer in the shortest big-endian form CoAP allows. */
function uintToBuffer(value) {
  if (value === 0) return Buffer.alloc(0)
  const bytes = []
  let remaining = value
  while (remaining > 0) {
    bytes.unshift(remaining & 0xFF)
    remaining = Math.floor(remaining / 256)
  }
  return Buffer.from(bytes)
}

const bufferToUint = buf => buf.reduce((acc, byte) => acc * 256 + byte, 0)

/** Write one option's delta/length nibble pair plus any extension bytes. */
function encodeOptionHeader(delta, length) {
  const nibble = value => (value < 13 ? value : value < 269 ? 13 : 14)
  const extension = value => {
    if (value < 13) return Buffer.alloc(0)
    if (value < 269) return Buffer.from([value - 13])
    const buf = Buffer.alloc(2)
    buf.writeUInt16BE(value - 269)
    return buf
  }
  return Buffer.concat([
    Buffer.from([(nibble(delta) << 4) | nibble(length)]),
    extension(delta),
    extension(length),
  ])
}

export function encode({ type = TYPE_NON, code, messageId, token = Buffer.alloc(0), options = [], payload }) {
  const header = Buffer.alloc(4)
  header[0] = (1 << 6) | (type << 4) | token.length
  header[1] = code
  header.writeUInt16BE(messageId, 2)

  const sorted = [...options].sort((a, b) => a.number - b.number)
  const parts = [header, token]
  let previous = 0
  for (const { number, value } of sorted) {
    parts.push(encodeOptionHeader(number - previous, value.length), value)
    previous = number
  }
  if (payload?.length) parts.push(Buffer.from([0xFF]), payload)
  return Buffer.concat(parts)
}

export function decode(buffer) {
  if (buffer.length < 4) throw new Error('CoAP message shorter than 4 bytes')
  const version = buffer[0] >> 6
  if (version !== 1) throw new Error(`unsupported CoAP version ${version}`)

  const type = (buffer[0] >> 4) & 0x03
  const tokenLength = buffer[0] & 0x0F
  if (tokenLength > 8) throw new Error(`invalid token length ${tokenLength}`)

  const code = buffer[1]
  const messageId = buffer.readUInt16BE(2)
  let offset = 4
  const token = buffer.subarray(offset, offset + tokenLength)
  offset += tokenLength

  const options = []
  let number = 0
  while (offset < buffer.length && buffer[offset] !== 0xFF) {
    const byte = buffer[offset++]
    let delta = byte >> 4
    let length = byte & 0x0F
    const readExtension = nibble => {
      if (nibble === 13) return buffer[offset++] + 13
      if (nibble === 14) { const v = buffer.readUInt16BE(offset) + 269; offset += 2; return v }
      if (nibble === 15) throw new Error('reserved option nibble 15')
      return nibble
    }
    delta = readExtension(delta)
    length = readExtension(length)
    number += delta
    options.push({ number, value: buffer.subarray(offset, offset + length) })
    offset += length
  }

  const payload = buffer[offset] === 0xFF ? buffer.subarray(offset + 1) : Buffer.alloc(0)
  return { type, code, messageId, token, options, payload }
}

const findOption = (options, number) => options.find(o => o.number === number)
const codeToString = code => `${code >> 5}.${String(code & 0x1F).padStart(2, '0')}`

// --- transport --------------------------------------------------------------

class CoapSocket {
  constructor(host, port = 5683) {
    this.host = host
    this.port = port
    this.socket = dgram.createSocket('udp4')
    this.messageId = crypto.randomInt(0, 0xFFFF)
    this.handlers = new Map() // token hex -> callback
    this.socket.on('message', buf => {
      let message
      try { message = decode(buf) } catch { return }
      const handler = this.handlers.get(message.token.toString('hex'))
      handler?.(message)
    })
    this.socket.on('error', () => {})
  }

  nextMessageId() {
    this.messageId = (this.messageId + 1) & 0xFFFF
    return this.messageId
  }

  send(message) {
    const buf = encode(message)
    this.socket.send(buf, this.port, this.host)
  }

  /** One request, one response. */
  request({ method, path, payload, observe = false, timeoutMs = 8000 }) {
    return new Promise((resolve, reject) => {
      const token = crypto.randomBytes(4)
      const key = token.toString('hex')
      const options = path.split('/').filter(Boolean)
        .map(segment => ({ number: OPT_URI_PATH, value: Buffer.from(segment, 'utf8') }))
      if (observe) options.push({ number: OPT_OBSERVE, value: uintToBuffer(0) })

      const timer = setTimeout(() => {
        this.handlers.delete(key)
        reject(new Error(`CoAP timeout for ${path}`))
      }, timeoutMs)

      this.handlers.set(key, message => {
        clearTimeout(timer)
        if (!observe) this.handlers.delete(key)
        resolve(message)
      })

      this.send({
        type: TYPE_NON,
        code: method === 'POST' ? CODE_POST : CODE_GET,
        messageId: this.nextMessageId(),
        token,
        options,
        payload: payload === undefined ? undefined : Buffer.from(payload),
      })
    })
  }

  /** Register an observation; onNotify fires for every push including the first. */
  async observe({ path, onNotify, timeoutMs = 8000 }) {
    const token = crypto.randomBytes(4)
    const key = token.toString('hex')
    const options = path.split('/').filter(Boolean)
      .map(segment => ({ number: OPT_URI_PATH, value: Buffer.from(segment, 'utf8') }))
    options.push({ number: OPT_OBSERVE, value: uintToBuffer(0) })

    const first = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.handlers.delete(key); reject(new Error(`observe timeout for ${path}`)) }, timeoutMs)
      let settled = false
      this.handlers.set(key, message => {
        if (!settled) { settled = true; clearTimeout(timer); resolve(message); return }
        onNotify(message)
      })
      this.send({ type: TYPE_NON, code: CODE_GET, messageId: this.nextMessageId(), token, options, payload: undefined })
    })

    return {
      first,
      // Proactive cancellation: the `coap` package cannot do this (issue #195).
      cancel: () => {
        const cancelOptions = [...options.filter(o => o.number !== OPT_OBSERVE),
          { number: OPT_OBSERVE, value: uintToBuffer(1) }]
        this.send({ type: TYPE_NON, code: CODE_GET, messageId: this.nextMessageId(), token, options: cancelOptions })
        this.handlers.delete(key)
      },
    }
  }

  close() {
    this.handlers.clear()
    try { this.socket.close() } catch {}
  }
}

// --- self-check on the codec before touching the network --------------------

function assert(condition, message) {
  if (!condition) throw new Error(`codec self-check failed: ${message}`)
}
{
  // Round-trip with a multi-segment path, Observe, and a payload.
  const original = {
    type: TYPE_NON, code: CODE_GET, messageId: 0x1234, token: Buffer.from('deadbeef', 'hex'),
    options: [
      { number: OPT_URI_PATH, value: Buffer.from('sys') },
      { number: OPT_URI_PATH, value: Buffer.from('dev') },
      { number: OPT_URI_PATH, value: Buffer.from('status') },
      { number: OPT_OBSERVE, value: uintToBuffer(0) },
    ],
    payload: Buffer.from('hi'),
  }
  const back = decode(encode(original))
  assert(back.messageId === 0x1234, 'messageId')
  assert(back.token.toString('hex') === 'deadbeef', 'token')
  assert(back.payload.toString() === 'hi', 'payload')
  assert(back.options.filter(o => o.number === OPT_URI_PATH).map(o => o.value.toString()).join('/') === 'sys/dev/status', 'uri-path')
  // Option length >= 13 must use the extended nibble.
  const long = decode(encode({ code: CODE_POST, messageId: 1, options: [{ number: OPT_URI_PATH, value: Buffer.alloc(200, 0x61) }] }))
  assert(long.options[0].value.length === 200, 'extended option length')
  // Max-Age as an integer.
  assert(bufferToUint(uintToBuffer(60)) === 60, 'uint round-trip 60')
  assert(bufferToUint(uintToBuffer(0xFFFFFF)) === 0xFFFFFF, 'uint round-trip 0xFFFFFF')
  console.log('codec self-check: PASS')
}

// --- live test against the device ------------------------------------------

const HOST = process.argv[2] ?? '192.168.20.151'
const SECRET = 'JiangPan'
const parts = k => {
  const x = crypto.createHash('md5').update(SECRET + k).digest('hex').toUpperCase()
  return [Buffer.from(x.slice(0, 16), 'ascii'), Buffer.from(x.slice(16), 'ascii')]
}
const decrypt = blob => {
  const [k, iv] = parts(blob.slice(0, 8))
  const d = crypto.createDecipheriv('aes-128-cbc', k, iv)
  return Buffer.concat([d.update(Buffer.from(blob.slice(8, -64), 'hex')), d.final()]).toString('utf8')
}

const sock = new CoapSocket(HOST)
try {
  const info = await sock.request({ method: 'GET', path: '/sys/dev/info' })
  console.log('[1] info code', codeToString(info.code), '->', info.payload.toString().slice(0, 120))

  const sync = await sock.request({ method: 'POST', path: '/sys/dev/sync', payload: crypto.randomBytes(4).toString('hex').toUpperCase() })
  console.log('[2] sync code', codeToString(sync.code), '-> clientKey', sync.payload.toString().trim())

  let pushes = 0
  const observation = await sock.observe({ path: '/sys/dev/status', onNotify: () => { pushes++ } })
  const maxAge = findOption(observation.first.options, OPT_MAX_AGE)
  const observeSeq = findOption(observation.first.options, OPT_OBSERVE)
  console.log('[3] status code', codeToString(observation.first.code),
    '| Max-Age', maxAge ? bufferToUint(maxAge.value) : '(absent)',
    '| Observe seq', observeSeq ? bufferToUint(observeSeq.value) : '(absent)')

  const status = JSON.parse(decrypt(observation.first.payload.toString())).state.reported
  console.log('[4] decrypted', Object.keys(status).length, 'keys | model', status.D01S05, '| temp', status.D03224 / 10, 'C | pm25', status.D03221)

  await new Promise(r => setTimeout(r, 6000))
  console.log(`[5] pushes in 6s: ${pushes}`)

  observation.cancel()
  const before = pushes
  await new Promise(r => setTimeout(r, 5000))
  console.log(`[6] after proactive cancel, further pushes: ${pushes - before} (0 means cancellation worked)`)
} finally {
  sock.close()
}
