import dgram from 'node:dgram'
import { afterEach, describe, expect, it } from 'vitest'
import { CoapOption, decode, encode, findOption, uintToBuffer } from '../src/airctrl/coap/message.js'
import { CoapSocket } from '../src/airctrl/coap/socket.js'

const CONTENT_2_05 = 69

/** A scriptable fake CoAP device on localhost. */
function fakeDevice(handler: (request: ReturnType<typeof decode>, reply: (m: Parameters<typeof encode>[0]) => void, remote: dgram.RemoteInfo) => void) {
  const server = dgram.createSocket('udp4')
  server.on('message', (buffer, remote) => {
    let request
    try { request = decode(buffer) } catch { return }
    handler(request, message => server.send(encode(message), remote.port, remote.address), remote)
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
    device = fakeDevice((request, reply, remote) => {
      device!.server.send(Buffer.from([0x00]), remote.port, remote.address) // garbage, ignored
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
