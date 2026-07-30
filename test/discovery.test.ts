import { networkInterfaces } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  discover,
  hostsInSubnet,
  localSubnets,
  probeHost,
} from '../src/airctrl/discovery.js'
import {
  pathOf,
  startFakeDevice,
  type FakeDevice,
} from './helpers/fake-device.js'

vi.mock('node:os', () => ({
  networkInterfaces: vi.fn(),
}))

describe('localSubnets', () => {
  afterEach(() => vi.resetAllMocks())

  it('normalizes and deduplicates external IPv4 interface CIDRs', () => {
    vi.mocked(networkInterfaces).mockReturnValue({
      en0: [
        {
          address: '192.168.20.151',
          netmask: '255.255.255.0',
          family: 'IPv4',
          mac: '00:00:00:00:00:00',
          internal: false,
          cidr: '192.168.20.151/24',
        },
        {
          address: 'fe80::1',
          netmask: 'ffff:ffff:ffff:ffff::',
          family: 'IPv6',
          mac: '00:00:00:00:00:00',
          internal: false,
          cidr: 'fe80::1/64',
          scopeid: 1,
        },
      ],
      en1: [
        {
          address: '192.168.20.200',
          netmask: '255.255.255.0',
          family: 'IPv4',
          mac: '00:00:00:00:00:00',
          internal: false,
          cidr: '192.168.20.200/24',
        },
      ],
      lo0: [
        {
          address: '127.0.0.1',
          netmask: '255.0.0.0',
          family: 'IPv4',
          mac: '00:00:00:00:00:00',
          internal: true,
          cidr: '127.0.0.1/8',
        },
      ],
      lo1: [
        {
          address: '127.0.0.2',
          netmask: '255.0.0.0',
          family: 'IPv4',
          mac: '00:00:00:00:00:00',
          internal: false,
          cidr: '127.0.0.2/8',
        },
      ],
    })

    expect(localSubnets()).toEqual(['192.168.20.0/24'])
  })
})

describe('hostsInSubnet', () => {
  it('excludes the network and broadcast addresses from a /24', () => {
    const hosts = [...hostsInSubnet('192.168.20.151/24')]

    expect(hosts).toHaveLength(254)
    expect(hosts[0]).toBe('192.168.20.1')
    expect(hosts[253]).toBe('192.168.20.254')
  })

  it('handles small and high-bit subnets with unsigned arithmetic', () => {
    expect([...hostsInSubnet('10.0.0.1/30')]).toEqual(['10.0.0.1', '10.0.0.2'])
    expect([...hostsInSubnet('192.168.255.253/30')]).toEqual([
      '192.168.255.253',
      '192.168.255.254',
    ])
  })
})

describe('probeHost', () => {
  const devices: FakeDevice[] = []

  afterEach(async () => {
    vi.restoreAllMocks()
    await Promise.all(devices.map(device => device.close()))
    devices.length = 0
  })

  it('maps plaintext device info from exactly one GET without syncing', async () => {
    const device = await startFakeDevice(request => {
      if (pathOf(request) === '/sys/dev/info') {
        return {
          payload: JSON.stringify({
            modelid: 'AC4220/12',
            name: 'Office',
            device_id: 'device-1',
            swversion: '1.2.3',
          }),
        }
      }
    })
    devices.push(device)

    await expect(probeHost('127.0.0.1', device.port, 200)).resolves.toEqual({
      host: '127.0.0.1',
      model: 'AC4220/12',
      name: 'Office',
      deviceId: 'device-1',
      firmware: '1.2.3',
    })
    expect(device.requests.map(pathOf)).toEqual(['/sys/dev/info'])
  })

  it('returns null when the plaintext info response has no model', async () => {
    const device = await startFakeDevice(() => ({
      payload: JSON.stringify({ name: 'Unknown' }),
    }))
    devices.push(device)

    await expect(probeHost('127.0.0.1', device.port, 200)).resolves.toBeNull()
  })

  it('returns null on timeout without an unhandled late rejection', async () => {
    const device = await startFakeDevice(() => undefined)
    devices.push(device)

    await expect(probeHost('127.0.0.1', device.port, 10)).resolves.toBeNull()
  })

  it('clears its deadline after a fast response', async () => {
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout')
    const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout')
    const device = await startFakeDevice(() => ({
      payload: JSON.stringify({ modelid: 'AC4220/12' }),
    }))
    devices.push(device)

    await probeHost('127.0.0.1', device.port, 123)

    const deadlineIndex = setTimeoutSpy.mock.calls.findIndex(([, delay]) => delay === 123)
    expect(deadlineIndex).toBeGreaterThanOrEqual(0)
    expect(clearTimeoutSpy).toHaveBeenCalledWith(setTimeoutSpy.mock.results[deadlineIndex]!.value)
  })
})

describe('discover', () => {
  const devices: FakeDevice[] = []

  afterEach(async () => {
    await Promise.all(devices.map(device => device.close()))
    devices.length = 0
    vi.doUnmock('../src/airctrl/client.js')
    vi.resetModules()
  })

  it('bounds concurrent probes and preserves successful duplicate inputs', async () => {
    let active = 0
    let maxActive = 0
    const device = await startFakeDevice(async () => {
      active++
      maxActive = Math.max(maxActive, active)
      await new Promise(resolve => setTimeout(resolve, 10))
      active--
      return { payload: JSON.stringify({ modelid: 'AC4220/12', name: 'Office' }) }
    })
    devices.push(device)
    const hosts = Array<string>(5).fill('127.0.0.1')

    const found = await discover({
      hosts,
      port: device.port,
      timeoutMs: 200,
      concurrency: 2,
    })

    expect(maxActive).toBe(2)
    expect(device.requests).toHaveLength(5)
    expect(found.map(result => result.host)).toEqual(hosts)
  })

  it('expands an explicit subnet and returns only responding hosts', async () => {
    const device = await startFakeDevice(() => ({
      payload: JSON.stringify({ modelid: 'AC4220/12', name: 'Office' }),
    }))
    devices.push(device)

    await expect(discover({
      subnet: '127.0.0.0/30',
      port: device.port,
      timeoutMs: 10,
      concurrency: 2,
    })).resolves.toEqual([{
      host: '127.0.0.1',
      model: 'AC4220/12',
      name: 'Office',
    }])
  })

  it('sorts results by numeric host address', async () => {
    vi.resetModules()
    vi.doMock('../src/airctrl/client.js', () => ({
      PhilipsCoapClient: class {
        constructor(private readonly host: string) {}
        getInfo(): Promise<{ modelid: string, name: string }> {
          return Promise.resolve({ modelid: 'AC4220/12', name: this.host })
        }
        close(): void {}
      },
    }))
    const { discover: discoverWithMockClient } = await import('../src/airctrl/discovery.js')

    const found = await discoverWithMockClient({
      hosts: ['127.0.0.10', '127.0.0.2'],
      concurrency: 1,
    })

    expect(found.map(result => result.host)).toEqual(['127.0.0.2', '127.0.0.10'])
  })

  it.each([0, -1, 1.5])('rejects invalid concurrency %s', async concurrency => {
    await expect(discover({ hosts: ['127.0.0.1'], concurrency }))
      .rejects.toBeInstanceOf(RangeError)
  })
})
