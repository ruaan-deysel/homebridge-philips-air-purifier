import { Accessory, Characteristic, HapStatusError, HAPStatus, Service, uuid } from '@homebridge/hap-nodejs'
import type { API, Logging, PlatformAccessory, PlatformConfig } from 'homebridge'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { DeviceStatus } from '../src/airctrl/schema.js'
import { Gen1Key, Gen3Key } from '../src/device/keys.js'
import register from '../src/index.js'
import { accessoryUuidSeed, devicesToPrune, PhilipsAirPlatform } from '../src/platform.js'
import { PLATFORM_NAME } from '../src/settings.js'

interface FakeDevice {
  status?: DeviceStatus
  error?: Error
}

class TestPlatformAccessory extends Accessory {
  context: Record<string, unknown> = {}
}

const fakeDevices = vi.hoisted(() => new Map<string, FakeDevice>())
const fakeClients = vi.hoisted(() => new Map<string, {
  close: ReturnType<typeof vi.fn>
  setControl: ReturnType<typeof vi.fn>
}>())

vi.mock('../src/airctrl/client.js', () => ({
  PhilipsCoapClient: class {
    readonly close = vi.fn()
    readonly setControl = vi.fn(async () => true)

    constructor(private readonly host: string) {
      fakeClients.set(host, this)
    }

    async connect(): Promise<void> {
      const error = fakeDevices.get(this.host)?.error
      if (error) throw error
    }

    async getStatus(): Promise<{ status: DeviceStatus, maxAge: number }> {
      return { status: fakeDevices.get(this.host)?.status ?? {}, maxAge: 60 }
    }

    observe(): AsyncIterable<DeviceStatus> {
      return {
        [Symbol.asyncIterator]: () => ({
          next: () => new Promise<IteratorResult<DeviceStatus>>(() => {}),
          return: async () => ({ done: true, value: undefined }),
        }),
      }
    }
  },
}))

function log(): Logging {
  return Object.assign(vi.fn(), {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    log: vi.fn(),
    success: vi.fn(),
    prefix: '',
  }) as unknown as Logging
}

function api(): API & {
  events: Map<string, () => void>
  registered: PlatformAccessory[]
  updated: PlatformAccessory[]
  unregistered: PlatformAccessory[]
} {
  const events = new Map<string, () => void>()
  const registered: PlatformAccessory[] = []
  const updated: PlatformAccessory[] = []
  const unregistered: PlatformAccessory[] = []
  const value = {
    hap: { Characteristic, HapStatusError, HAPStatus, Service, uuid },
    platformAccessory: TestPlatformAccessory,
    on: vi.fn((event: string, listener: () => void) => {
      events.set(event, listener)
      return value
    }),
    registerPlatform: vi.fn(),
    registerPlatformAccessories: vi.fn((
      _plugin: string,
      _platform: string,
      accessories: PlatformAccessory[],
    ) => registered.push(...accessories)),
    updatePlatformAccessories: vi.fn((accessories: PlatformAccessory[]) => updated.push(...accessories)),
    unregisterPlatformAccessories: vi.fn((
      _plugin: string,
      _platform: string,
      accessories: PlatformAccessory[],
    ) => unregistered.push(...accessories)),
    events,
    registered,
    updated,
    unregistered,
  }
  return value as unknown as ReturnType<typeof api>
}

function config(hosts: string[]): PlatformConfig {
  return {
    platform: PLATFORM_NAME,
    devices: hosts.map(host => ({
      host,
      exposeSleepSwitch: false,
      exposeAutoPlusSwitch: false,
      exposeBeepSwitch: false,
      exposeLight: false,
    })),
  }
}

function gen3Status(model = 'AC4220/12', deviceIdKey = Gen1Key.DEVICE_ID): DeviceStatus {
  return {
    [deviceIdKey]: 'stable-device-id',
    [Gen3Key.NAME]: 'Living Room',
    [Gen3Key.MODEL_ID]: model,
    [Gen3Key.POWER]: 1,
    [Gen3Key.MODE_B]: 1,
    [Gen3Key.PM25]: 8,
  }
}

function cached(name: string, seed: string, host: string): PlatformAccessory {
  const accessory = new TestPlatformAccessory(name, uuid.generate(seed)) as unknown as PlatformAccessory
  accessory.context.device = { host }
  return accessory
}

async function launch(mockApi: ReturnType<typeof api>): Promise<void> {
  mockApi.events.get('didFinishLaunching')!()
  await vi.waitFor(() => {
    expect(mockApi.registerPlatformAccessories).toHaveBeenCalled()
  })
}

beforeEach(() => {
  fakeDevices.clear()
  fakeClients.clear()
})

describe('platform helpers', () => {
  it('prefers a stable device id so a DHCP change keeps the accessory', () => {
    expect(accessoryUuidSeed({ host: '192.168.20.151' }, '96868ce0')).toBe('96868ce0')
  })

  it('falls back to the host when the device id is unknown', () => {
    expect(accessoryUuidSeed({ host: '192.168.20.151' }, undefined)).toBe('192.168.20.151')
  })

  it('returns only cached accessories whose UUID is no longer configured', () => {
    const accessories = [{ UUID: 'a' }, { UUID: 'b' }, { UUID: 'c' }]
    expect(devicesToPrune(accessories, new Set(['a', 'c']))).toEqual([{ UUID: 'b' }])
  })
})

describe('registration', () => {
  it('registers the dynamic platform', () => {
    const mockApi = api()
    register(mockApi)
    expect(mockApi.registerPlatform).toHaveBeenCalledWith(PLATFORM_NAME, PhilipsAirPlatform)
  })
})

describe('PhilipsAirPlatform', () => {
  it('waits for didFinishLaunching and registers a device using its current DeviceId key', async () => {
    const mockApi = api()
    fakeDevices.set('192.0.2.1', { status: gen3Status() })
    new PhilipsAirPlatform(log(), config(['192.0.2.1']), mockApi)

    expect(mockApi.registered).toEqual([])
    await launch(mockApi)

    expect(mockApi.registered).toHaveLength(1)
    expect(mockApi.registered[0]?.UUID).toBe(uuid.generate('stable-device-id'))
    expect(mockApi.registered[0]?.displayName).toBe('Living Room')
  })

  it('accepts the Gen3 serial key as a stable id', async () => {
    const mockApi = api()
    fakeDevices.set('192.0.2.2', { status: gen3Status('AC4220/12', Gen3Key.SERIAL) })
    new PhilipsAirPlatform(log(), config(['192.0.2.2']), mockApi)

    await launch(mockApi)

    expect(mockApi.registered[0]?.UUID).toBe(uuid.generate('stable-device-id'))
  })

  it('restores a matching cached accessory without registering a duplicate', async () => {
    const mockApi = api()
    const platform = new PhilipsAirPlatform(log(), config(['192.0.2.1']), mockApi)
    const existing = cached('Old Name', 'stable-device-id', '192.0.2.1')
    platform.configureAccessory(existing)
    fakeDevices.set('192.0.2.1', { status: gen3Status() })

    mockApi.events.get('didFinishLaunching')!()
    await vi.waitFor(() => expect(mockApi.updated).toEqual([existing]))

    expect(mockApi.registered).toEqual([])
    expect(existing.displayName).toBe('Living Room')
  })

  it('keeps a configured cached accessory offline while pruning a removed one', async () => {
    const mockApi = api()
    const platformLog = log()
    const platform = new PhilipsAirPlatform(platformLog, config(['192.0.2.1']), mockApi)
    const configured = cached('Offline', 'offline-id', '192.0.2.1')
    const removed = cached('Removed', 'removed-id', '192.0.2.9')
    platform.configureAccessory(configured)
    platform.configureAccessory(removed)
    fakeDevices.set('192.0.2.1', { error: new Error('offline') })

    mockApi.events.get('didFinishLaunching')!()
    await vi.waitFor(() => expect(mockApi.unregistered).toEqual([removed]))

    expect(platformLog.error).toHaveBeenCalledWith(expect.stringContaining('offline'))
    expect(mockApi.registered).toEqual([])
    expect(fakeClients.get('192.0.2.1')?.close).toHaveBeenCalledOnce()
  })

  it('logs once and removes cached accessories when no devices are configured', async () => {
    const mockApi = api()
    const platformLog = log()
    const platform = new PhilipsAirPlatform(platformLog, config([]), mockApi)
    const removed = cached('Removed', 'removed-id', '192.0.2.9')
    platform.configureAccessory(removed)

    mockApi.events.get('didFinishLaunching')!()
    await vi.waitFor(() => expect(mockApi.unregistered).toEqual([removed]))

    expect(platformLog.info).toHaveBeenCalledOnce()
    expect(mockApi.registered).toEqual([])
  })

  it('logs an unknown model once and controls it with the detected generation', async () => {
    const mockApi = api()
    const platformLog = log()
    fakeDevices.set('192.0.2.3', { status: gen3Status('NEW9999/00') })
    new PhilipsAirPlatform(platformLog, config(['192.0.2.3']), mockApi)

    await launch(mockApi)
    const purifier = mockApi.registered[0]!.getService(Service.AirPurifier)!
    await purifier.getCharacteristic(Characteristic.Active).handleSetRequest(Characteristic.Active.ACTIVE)

    const unknownLogs = vi.mocked(platformLog.info).mock.calls
      .filter(([message]) => String(message).includes('Unknown model'))
    expect(unknownLogs).toHaveLength(1)
    expect(unknownLogs[0]?.[0]).toContain('gen3')
    expect(fakeClients.get('192.0.2.3')?.setControl).toHaveBeenCalledWith({ [Gen3Key.POWER]: 1 })
  })

  it('shuts down every coordinator', async () => {
    const mockApi = api()
    fakeDevices.set('192.0.2.1', { status: gen3Status() })
    fakeDevices.set('192.0.2.2', {
      status: { ...gen3Status(), [Gen1Key.DEVICE_ID]: 'second-device-id' },
    })
    new PhilipsAirPlatform(log(), config(['192.0.2.1', '192.0.2.2']), mockApi)

    mockApi.events.get('didFinishLaunching')!()
    await vi.waitFor(() => expect(mockApi.registered).toHaveLength(2))
    mockApi.events.get('shutdown')!()

    expect(fakeClients.get('192.0.2.1')?.close).toHaveBeenCalledOnce()
    expect(fakeClients.get('192.0.2.2')?.close).toHaveBeenCalledOnce()
  })
})
