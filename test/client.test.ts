import { afterEach, describe, expect, it } from 'vitest'
import { PhilipsCoapClient, NotConnectedError } from '../src/airctrl/client.js'
import { decrypt, encrypt } from '../src/airctrl/crypto.js'
import { CoapOption, bufferToUint } from '../src/airctrl/coap/message.js'
import { startFakeDevice, pathOf, type FakeDevice } from './helpers/fake-device.js'

describe('PhilipsCoapClient', () => {
  const devices: FakeDevice[] = []
  const clients: PhilipsCoapClient[] = []

  afterEach(async () => {
    for (const client of clients) client.close()
    await Promise.all(devices.map(device => device.close()))
    clients.length = 0
    devices.length = 0
  })

  async function start(
    handler: Parameters<typeof startFakeDevice>[0],
  ): Promise<{ device: FakeDevice, client: PhilipsCoapClient }> {
    const device = await startFakeDevice(handler)
    const client = new PhilipsCoapClient('127.0.0.1', device.port)
    devices.push(device)
    clients.push(client)
    return { device, client }
  }

  it('reads plaintext device info without syncing', async () => {
    const { device, client } = await start(request => {
      if (pathOf(request) === '/sys/dev/info') {
        return { payload: JSON.stringify({ modelid: 'AC4220/12', name: 'Office' }) }
      }
    })

    expect((await client.getInfo()).modelid).toBe('AC4220/12')
    expect(device.requests.map(pathOf)).toEqual(['/sys/dev/info'])
  })

  it('syncs, decrypts status, and reads Max-Age', async () => {
    const { client } = await start(request => {
      switch (pathOf(request)) {
        case '/sys/dev/sync': return { payload: '0DC377BA\n' }
        case '/sys/dev/status': return {
          payload: encrypt('0DC377BA', JSON.stringify({ state: { reported: { D03102: 1 } } })),
          options: [{ number: CoapOption.MaxAge, value: Buffer.from([30]) }],
        }
      }
    })

    await client.connect()
    await expect(client.getStatus()).resolves.toEqual({
      status: { D03102: 1 },
      maxAge: 30,
    })
  })

  it('uses Observe 0 for status then cancels with Observe 1 on the same token', async () => {
    const { device, client } = await start(request => {
      if (pathOf(request) === '/sys/dev/sync') return { payload: '0DC377BA' }
      if (pathOf(request) === '/sys/dev/status') {
        return { payload: encrypt('0DC377BA', JSON.stringify({ state: { reported: {} } })) }
      }
    })
    await client.connect()

    await client.getStatus()
    await waitFor(() => device.requests.filter(request => pathOf(request) === '/sys/dev/status').length === 2)

    const statusRequests = device.requests.filter(request => pathOf(request) === '/sys/dev/status')
    expect(statusRequests.map(observeValue)).toEqual([0, 1])
    expect(statusRequests[0]!.token.equals(statusRequests[1]!.token)).toBe(true)
  })

  it.each([
    ['missing', undefined],
    ['zero', Buffer.alloc(0)],
  ])('defaults %s Max-Age to 60', async (_name, maxAge) => {
    const { client } = await start(request => {
      if (pathOf(request) === '/sys/dev/sync') return { payload: '0DC377BA' }
      if (pathOf(request) === '/sys/dev/status') {
        return {
          payload: encrypt('0DC377BA', JSON.stringify({ state: { reported: {} } })),
          options: maxAge === undefined ? [] : [{ number: CoapOption.MaxAge, value: maxAge }],
        }
      }
    })

    await client.connect()
    expect((await client.getStatus()).maxAge).toBe(60)
  })

  it('yields the initial status and queued pushes, then cancels on return', async () => {
    const { device, client } = await start(request => {
      if (pathOf(request) === '/sys/dev/sync') return { payload: '0DC377BA' }
      if (pathOf(request) === '/sys/dev/status') {
        return {
          payload: encrypt('0DC377BA', JSON.stringify({ state: { reported: { D03102: 0 } } })),
        }
      }
    })
    await client.connect()

    const iterator = client.observe()
    expect((await iterator.next()).value).toEqual({ D03102: 0 })
    await device.push(encrypt('0DC377BA', JSON.stringify({ state: { reported: { D03102: 1 } } })))
    expect((await iterator.next()).value).toEqual({ D03102: 1 })
    await iterator.return(undefined)

    await waitFor(() => device.requests.filter(request => (
      pathOf(request) === '/sys/dev/status' && observeValue(request) === 1
    )).length === 1)
  })

  it('rejects a waiting iterator on a malformed push and cancels it', async () => {
    const { device, client } = await start(request => {
      if (pathOf(request) === '/sys/dev/sync') return { payload: '0DC377BA' }
      if (pathOf(request) === '/sys/dev/status') {
        return {
          payload: encrypt('0DC377BA', JSON.stringify({ state: { reported: {} } })),
        }
      }
    })
    await client.connect()
    const iterator = client.observe()
    await iterator.next()

    const next = iterator.next()
    await device.push('invalid encrypted payload')
    await expect(next).rejects.toThrow()
    await waitFor(() => device.requests.some(request => observeValue(request) === 1))
  })

  it('sends an encrypted control payload and returns true for success', async () => {
    let desired: Record<string, unknown> | undefined
    const { client } = await start(request => {
      if (pathOf(request) === '/sys/dev/sync') return { payload: '0DC377BA' }
      if (pathOf(request) === '/sys/dev/control') {
        desired = JSON.parse(decrypt(request.payload.toString())).state.desired
        return { payload: JSON.stringify({ status: 'success' }) }
      }
    })
    await client.connect()

    await expect(client.setControl({ D03102: 1 })).resolves.toBe(true)
    expect(desired).toEqual({
      CommandType: 'app',
      DeviceId: '',
      EnduserId: '',
      D03102: 1,
    })
  })

  it('makes the initial attempt plus the configured retries, resyncing only between them', async () => {
    const { device, client } = await start(request => {
      if (pathOf(request) === '/sys/dev/sync') return { payload: '0DC377BA' }
      if (pathOf(request) === '/sys/dev/control') return { payload: JSON.stringify({ status: 'failed' }) }
    })
    await client.connect()

    await expect(client.setControl({ D03102: 1 }, { retries: 2, retryDelayMs: 1 })).resolves.toBe(false)
    expect(device.requests.filter(request => pathOf(request) === '/sys/dev/control')).toHaveLength(3)
    expect(device.requests.filter(request => pathOf(request) === '/sys/dev/sync')).toHaveLength(3)
    expect(pathOf(device.requests.at(-1)!)).toBe('/sys/dev/control')
  })

  it('increments the rolling key before every control attempt', async () => {
    const keys: string[] = []
    const { client } = await start(request => {
      if (pathOf(request) === '/sys/dev/sync') return { payload: '0DC377BA' }
      if (pathOf(request) === '/sys/dev/control') {
        keys.push(request.payload.toString().slice(0, 8))
        return { payload: JSON.stringify({ status: 'success' }) }
      }
    })
    await client.connect()

    await client.setControl({ D03102: 1 })
    await client.setControl({ D03102: 0 })
    expect(keys).toEqual(['0DC377BB', '0DC377BC'])
  })

  it('requires connect before encrypted operations', async () => {
    const { client } = await start(() => undefined)
    await expect(client.getStatus()).rejects.toThrow(NotConnectedError)
    await expect(client.setControl({ D03102: 1 })).rejects.toThrow(/connect\(\)/)
  })

  it('cancels every live observation when closed', async () => {
    const { device, client } = await start(request => {
      if (pathOf(request) === '/sys/dev/sync') return { payload: '0DC377BA' }
      if (pathOf(request) === '/sys/dev/status') {
        return {
          payload: encrypt('0DC377BA', JSON.stringify({ state: { reported: {} } })),
        }
      }
    })
    await client.connect()
    const first = client.observe()
    const second = client.observe()
    await Promise.all([first.next(), second.next()])
    const pending = first.next()

    client.close()

    await expect(Promise.race([
      pending,
      new Promise((_, reject) => setTimeout(() => reject(new Error('iterator did not settle')), 100)),
    ])).rejects.toThrow(/client closed/)
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(device.requests.filter(request => observeValue(request) === 1)).toHaveLength(2)
    await second.return(undefined)
  })
})

function observeValue(request: { options: { number: number, value: Buffer }[] }): number | undefined {
  const option = request.options.find(candidate => candidate.number === CoapOption.Observe)
  return option && bufferToUint(option.value)
}

async function waitFor(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 1000
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error('condition was not met')
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}
