import type { API, DynamicPlatformPlugin, Logging, PlatformAccessory, PlatformConfig } from 'homebridge'
import { PhilipsAirAccessory } from './accessory.js'
import { PhilipsCoapClient } from './airctrl/client.js'
import { PluginConfigSchema, type DeviceConfig, type DeviceStatus } from './airctrl/schema.js'
import { DeviceCoordinator } from './device/coordinator.js'
import { Gen1Key, Gen2Key, Gen3Key } from './device/keys.js'
import { detectGeneration, DEVICE_MODELS, resolveModel } from './device/models.js'
import { PLATFORM_NAME, PLUGIN_NAME } from './settings.js'

/** Stable seed for the accessory UUID: device id if known, else host. */
export function accessoryUuidSeed(
  device: Pick<DeviceConfig, 'host'>,
  deviceId: string | undefined,
): string {
  return deviceId ?? device.host
}

/** Cached accessories no longer represented in the config. */
export function devicesToPrune<T extends { UUID: string }>(cached: T[], configured: Set<string>): T[] {
  return cached.filter(accessory => !configured.has(accessory.UUID))
}

function firstString(status: DeviceStatus, keys: string[]): string | undefined {
  return keys.map(key => status[key]).find(value => typeof value === 'string' && value.length > 0) as
    string | undefined
}

export class PhilipsAirPlatform implements DynamicPlatformPlugin {
  readonly Service: API['hap']['Service']
  readonly Characteristic: API['hap']['Characteristic']
  private readonly cached: PlatformAccessory[] = []
  private readonly coordinators = new Set<DeviceCoordinator>()

  constructor(
    readonly log: Logging,
    readonly config: PlatformConfig,
    readonly api: API,
  ) {
    this.Service = api.hap.Service
    this.Characteristic = api.hap.Characteristic
    api.on('didFinishLaunching', () => void this.discoverDevices())
    api.on('shutdown', () => this.shutdown())
  }

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
      this.unregister(this.cached)
      return
    }

    const configuredUuids = new Set<string>()
    for (const device of devices) {
      try {
        configuredUuids.add(await this.setUpDevice(device))
      } catch (error) {
        const cached = this.cached.find(accessory => accessory.context.device?.host === device.host)
        if (cached) configuredUuids.add(cached.UUID)
        this.log.error(`Failed to set up device at ${device.host}: ${String(error)}`)
      }
    }
    this.unregister(devicesToPrune(this.cached, configuredUuids))
  }

  private async setUpDevice(device: DeviceConfig): Promise<string> {
    const makeClient = async (): Promise<PhilipsCoapClient> =>
      new PhilipsCoapClient(device.host, device.port)
    const coordinator = new DeviceCoordinator(await makeClient(), this.log, device.host, makeClient)
    this.coordinators.add(coordinator)

    try {
      await coordinator.start()
      const status = coordinator.status
      if (!status) throw new Error('device returned no status')

      const deviceId = firstString(status, [Gen1Key.DEVICE_ID, Gen3Key.SERIAL, 'device_id'])
      const modelId = firstString(status, [Gen3Key.MODEL_ID, Gen2Key.MODEL_ID, Gen1Key.MODEL_ID]) ?? ''
      const generation = detectGeneration(status)
      const knownModel = DEVICE_MODELS[modelId] ?? DEVICE_MODELS[modelId.slice(0, 6)]
      const model = knownModel ?? resolveModel(modelId, generation)
      if (!knownModel) {
        this.log.info(`Unknown model ${modelId || '(unreported)'}; using generic ${generation} profile`)
      }

      const accessoryUuid = this.api.hap.uuid.generate(accessoryUuidSeed(device, deviceId))
      const displayName = device.name
        || firstString(status, [Gen3Key.NAME, Gen2Key.NAME, Gen1Key.NAME])
        || modelId
        || device.host
      const existing = this.cached.find(accessory => accessory.UUID === accessoryUuid)
      const accessory = existing ?? new this.api.platformAccessory(displayName, accessoryUuid)
      accessory.displayName = displayName
      accessory.context.device = device
      new PhilipsAirAccessory(this, accessory, coordinator, model, device)

      if (existing) {
        this.api.updatePlatformAccessories([existing])
        this.log.info(`Restored ${displayName} (${modelId || 'unknown model'}) at ${device.host}`)
      } else {
        this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory])
        this.log.info(`Added ${displayName} (${modelId || 'unknown model'}) at ${device.host}`)
      }
      return accessoryUuid
    } catch (error) {
      coordinator.shutdown()
      this.coordinators.delete(coordinator)
      throw error
    }
  }

  private unregister(accessories: PlatformAccessory[]): void {
    if (accessories.length > 0) {
      this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, accessories)
    }
  }

  private shutdown(): void {
    for (const coordinator of this.coordinators) coordinator.shutdown()
    this.coordinators.clear()
  }
}
