import { readFile } from 'node:fs/promises'
import { describe, expect, it, vi } from 'vitest'
import { RequestError } from '@homebridge/plugin-ui-utils'
import { probeRequest, scanRequest } from '../homebridge-ui/server.js'
import { hostsInSubnet, localSubnets } from '../src/airctrl/discovery.js'

const root = new URL('../', import.meta.url)

describe('custom UI server', () => {
  it('rejects invalid IPv4 addresses before probing', async () => {
    const probe = vi.fn()

    await expect(probeRequest({ host: '192.168.1.999' }, { probeHost: probe })).rejects.toMatchObject({
      constructor: RequestError,
      message: '"192.168.1.999" is not a valid IPv4 address.',
    })
    expect(probe).not.toHaveBeenCalled()
  })

  it('reports a clear error when the host is not a Philips air purifier', async () => {
    await expect(
      probeRequest({ host: '192.168.1.20' }, { probeHost: vi.fn().mockResolvedValue(null) }),
    ).rejects.toMatchObject({
      constructor: RequestError,
      message: 'No Philips air purifier answered at 192.168.1.20. Check the IP and that the device is on this network.',
    })
  })

  it('converts probe failures to user-facing request errors', async () => {
    await expect(probeRequest(
      { host: '192.168.1.20' },
      { probeHost: vi.fn().mockRejectedValue(new Error('socket failure')) },
    )).rejects.toBeInstanceOf(RequestError)
  })

  it('refuses oversized subnets before discovery starts', async () => {
    const discover = vi.fn()

    await expect(scanRequest(
      { subnet: '10.0.0.0/21' },
      { discover, hostsInSubnet, localSubnets },
    )).rejects.toBeInstanceOf(RequestError)
    expect(discover).not.toHaveBeenCalled()
  })

  it('returns the discovered identity fields unchanged', async () => {
    const device = {
      host: '192.168.1.20',
      model: 'AC4220/12',
      name: 'Office',
      firmware: '0.2.3',
    }
    const result = await scanRequest(
      { subnet: '192.168.1.0/30' },
      { discover: vi.fn().mockResolvedValue([device]), hostsInSubnet, localSubnets },
    )

    expect(result.devices).toEqual([device])
  })

  it('converts subnet detection failures to request errors', async () => {
    await expect(scanRequest({}, {
      discover: vi.fn(),
      hostsInSubnet,
      localSubnets: () => {
        throw new Error('interface failure')
      },
    })).rejects.toBeInstanceOf(RequestError)
  })

  it('converts discovery failures to request errors', async () => {
    await expect(scanRequest({}, {
      discover: vi.fn().mockRejectedValue(new Error('scan failure')),
      hostsInSubnet,
      localSubnets: () => ['192.168.1.0/30'],
    })).rejects.toBeInstanceOf(RequestError)
  })
})

describe('custom UI package', () => {
  it('declares the exact Homebridge platform metadata and service toggles', async () => {
    const schema = JSON.parse(await readFile(new URL('config.schema.json', root), 'utf8'))

    expect(schema).toMatchObject({
      pluginAlias: 'PhilipsAir',
      pluginType: 'platform',
      singular: true,
      customUiPath: './homebridge-ui',
    })
    expect(Object.keys(schema.schema.properties.devices.items.properties)).toEqual(expect.arrayContaining([
      'exposeLight',
      'exposeSleepSwitch',
      'exposeAutoPlusSwitch',
      'exposeBeepSwitch',
    ]))
  })

  it('uses safe DOM rendering and exposes the required config actions', async () => {
    const html = await readFile(new URL('homebridge-ui/public/index.html', root), 'utf8')

    expect(html).not.toMatch(/\b(?:innerHTML|outerHTML|insertAdjacentHTML)\b/)
    expect(html).toContain('aria-live="polite"')
    expect(html).toContain('homebridge.updatePluginConfig')
    expect(html).toContain('homebridge.savePluginConfig')
    expect(html).toContain("homebridge.request('/scan')")
    expect(html).toContain("homebridge.request('/probe'")
    for (const key of [
      'exposeLight',
      'exposeSleepSwitch',
      'exposeAutoPlusSwitch',
      'exposeBeepSwitch',
    ]) expect(html).toContain(key)
  })
})
