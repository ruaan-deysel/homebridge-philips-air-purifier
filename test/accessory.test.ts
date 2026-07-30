import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { Accessory, Characteristic, HapStatusError, HAPStatus, Service, uuid } from '@homebridge/hap-nodejs'
import type { API, Logging, PlatformAccessory } from 'homebridge'
import { describe, expect, it, vi } from 'vitest'
import { PhilipsAirAccessory, type PhilipsAirPlatformLike } from '../src/accessory.js'
import type { DeviceCoordinator } from '../src/device/coordinator.js'
import { Gen3Key } from '../src/device/keys.js'
import { resolveModel } from '../src/device/models.js'
import type { DeviceConfig, DeviceStatus } from '../src/airctrl/schema.js'

const capturedStatus = JSON.parse(readFileSync(
  new URL('./fixtures/ac4220-12-status.json', import.meta.url),
  'utf8',
)) as DeviceStatus

class FakeCoordinator extends EventEmitter {
  available = true
  status: DeviceStatus | null = { ...capturedStatus }
  setControl = vi.fn(async (_values: Record<string, unknown>) => true)

  publish(changes: DeviceStatus): void {
    this.status = { ...this.status, ...changes }
    this.emit('status', this.status)
  }

  setAvailable(available: boolean): void {
    this.available = available
    this.emit('availability', available)
  }
}

const deviceConfig: DeviceConfig = {
  host: '192.0.2.1',
  port: 5683,
  exposeSleepSwitch: true,
  exposeAutoPlusSwitch: true,
  exposeBeepSwitch: true,
  exposeLight: true,
}

function setup(config: DeviceConfig = deviceConfig): {
  accessory: Accessory
  coordinator: FakeCoordinator
} {
  const accessory = new Accessory('Office', uuid.generate('office'))
  const coordinator = new FakeCoordinator()
  const log = Object.assign(vi.fn(), {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    log: vi.fn(),
    success: vi.fn(),
    prefix: '',
  }) as unknown as Logging
  const platform = {
    api: { hap: { HapStatusError, HAPStatus } } as unknown as API,
    log,
    Service,
    Characteristic,
  } as PhilipsAirPlatformLike

  new PhilipsAirAccessory(
    platform,
    accessory as unknown as PlatformAccessory,
    coordinator as unknown as DeviceCoordinator,
    resolveModel('AC4220/12'),
    config,
  )
  return { accessory, coordinator }
}

describe('PhilipsAirAccessory', () => {
  it('exposes the AC4220 services and observed accessory information', async () => {
    const { accessory } = setup()
    const purifier = accessory.getService(Service.AirPurifier)!
    const information = accessory.getService(Service.AccessoryInformation)!

    expect(await information.getCharacteristic(Characteristic.Model).handleGetRequest()).toBe('AC4220/12')
    expect(information.getCharacteristic(Characteristic.SerialNumber).value).toBe('688001001527')
    expect(information.getCharacteristic(Characteristic.FirmwareRevision).value).toBe('0.2.3')
    expect(purifier.getCharacteristic(Characteristic.RotationSpeed).props.minStep).toBe(20)
    expect(accessory.getService(Service.AirQualitySensor)).toBeDefined()
    expect(accessory.getService(Service.TemperatureSensor)).toBeDefined()
    expect(accessory.getService(Service.HumiditySensor)).toBeDefined()
    expect(accessory.getServiceById(Service.FilterMaintenance, 'pre-filter')).toBeDefined()
    expect(accessory.getServiceById(Service.FilterMaintenance, 'nano-protect')).toBeDefined()
    expect(accessory.getServiceById(Service.Lightbulb, 'lamp')).toBeDefined()
    expect(accessory.getServiceById(Service.Switch, 'sleep')).toBeDefined()
    expect(accessory.getServiceById(Service.Switch, 'auto-plus')).toBeDefined()
    expect(accessory.getServiceById(Service.Switch, 'beep')).toBeDefined()
    expect(purifier.isPrimaryService).toBe(true)
    expect(purifier.linkedServices).toEqual(expect.arrayContaining([
      accessory.getService(Service.AirQualitySensor),
      accessory.getService(Service.TemperatureSensor),
      accessory.getService(Service.HumiditySensor),
      accessory.getServiceById(Service.FilterMaintenance, 'pre-filter'),
      accessory.getServiceById(Service.FilterMaintenance, 'nano-protect'),
      accessory.getServiceById(Service.Lightbulb, 'lamp'),
      accessory.getServiceById(Service.Switch, 'sleep'),
      accessory.getServiceById(Service.Switch, 'auto-plus'),
      accessory.getServiceById(Service.Switch, 'beep'),
    ]))
    expect(purifier.linkedServices).toHaveLength(9)
  })

  it('makes every device-backed read fail with No Response while unavailable', async () => {
    const { accessory, coordinator } = setup()
    const reads = [
      accessory.getService(Service.AirPurifier)!
        .getCharacteristic(Characteristic.Active),
      accessory.getService(Service.AirQualitySensor)!
        .getCharacteristic(Characteristic.PM2_5Density),
      accessory.getService(Service.TemperatureSensor)!
        .getCharacteristic(Characteristic.CurrentTemperature),
      accessory.getServiceById(Service.FilterMaintenance, 'pre-filter')!
        .getCharacteristic(Characteristic.FilterLifeLevel),
      accessory.getServiceById(Service.Lightbulb, 'lamp')!
        .getCharacteristic(Characteristic.On),
      accessory.getServiceById(Service.Switch, 'beep')!
        .getCharacteristic(Characteristic.On),
    ]

    coordinator.setAvailable(false)

    for (const characteristic of reads) {
      await expect(characteristic.handleGetRequest())
        .rejects.toBe(HAPStatus.SERVICE_COMMUNICATION_FAILURE)
      expect(characteristic.statusCode).toBe(HAPStatus.SERVICE_COMMUNICATION_FAILURE)
    }
  })

  it('uses hardware-correct AC4220 writes without optimistic status mutation', async () => {
    const { accessory, coordinator } = setup()
    const purifier = accessory.getService(Service.AirPurifier)!

    await purifier.getCharacteristic(Characteristic.RotationSpeed).handleSetRequest(0)
    expect(coordinator.setControl).toHaveBeenLastCalledWith({ [Gen3Key.POWER]: 0 })

    await purifier.getCharacteristic(Characteristic.TargetAirPurifierState).handleSetRequest(
      Characteristic.TargetAirPurifierState.MANUAL,
    )
    expect(coordinator.setControl).toHaveBeenLastCalledWith({
      [Gen3Key.POWER]: 1,
      [Gen3Key.MODE_B]: 1,
    })

    coordinator.publish({ [Gen3Key.MODE_B]: 4 })
    await purifier.getCharacteristic(Characteristic.TargetAirPurifierState).handleSetRequest(
      Characteristic.TargetAirPurifierState.MANUAL,
    )
    expect(coordinator.setControl).toHaveBeenLastCalledWith({
      [Gen3Key.POWER]: 1,
      [Gen3Key.MODE_B]: 4,
    })

    await purifier.getCharacteristic(Characteristic.TargetAirPurifierState).handleSetRequest(
      Characteristic.TargetAirPurifierState.AUTO,
    )
    expect(coordinator.setControl).toHaveBeenLastCalledWith({
      [Gen3Key.POWER]: 1,
      [Gen3Key.MODE_B]: 0,
    })

    await accessory.getServiceById(Service.Lightbulb, 'lamp')!
      .getCharacteristic(Characteristic.On).handleSetRequest(true)
    expect(coordinator.setControl).toHaveBeenLastCalledWith({ [Gen3Key.LAMP_MODE]: 1 })

    await accessory.getServiceById(Service.Switch, 'beep')!
      .getCharacteristic(Characteristic.On).handleSetRequest(true)
    expect(coordinator.setControl).toHaveBeenLastCalledWith({ [Gen3Key.BEEP]: 100 })

    await accessory.getServiceById(Service.Switch, 'sleep')!
      .getCharacteristic(Characteristic.On).handleSetRequest(false)
    expect(coordinator.setControl).toHaveBeenLastCalledWith({
      [Gen3Key.POWER]: 1,
      [Gen3Key.MODE_B]: 0,
    })
    expect(coordinator.status![Gen3Key.LAMP_MODE]).toBe(0)
    expect(coordinator.status![Gen3Key.BEEP]).toBe(100)
  })

  it('turns failed control ACKs into HomeKit communication failures', async () => {
    const { accessory, coordinator } = setup()
    coordinator.setControl.mockResolvedValueOnce(false)

    await expect(accessory.getServiceById(Service.Lightbulb, 'lamp')!
      .getCharacteristic(Characteristic.On).handleSetRequest(true))
      .rejects.toBe(HAPStatus.SERVICE_COMMUNICATION_FAILURE)
  })

  it('updates a characteristic at most once per changed status snapshot', () => {
    const { accessory, coordinator } = setup()
    const speed = accessory.getService(Service.AirPurifier)!
      .getCharacteristic(Characteristic.RotationSpeed)
    const update = vi.spyOn(speed, 'updateValue')

    coordinator.publish({ [Gen3Key.MODE_B]: 2 })

    expect(update).toHaveBeenCalledOnce()
    expect(update).toHaveBeenCalledWith(40)
  })

  it('waits for a fresh status event after availability recovers', () => {
    const { accessory, coordinator } = setup()
    const speed = accessory.getService(Service.AirPurifier)!
      .getCharacteristic(Characteristic.RotationSpeed)
    const update = vi.spyOn(speed, 'updateValue')

    coordinator.setAvailable(false)
    update.mockClear()
    coordinator.status = { ...coordinator.status, [Gen3Key.MODE_B]: 4 }
    coordinator.setAvailable(true)

    expect(update).not.toHaveBeenCalled()

    coordinator.publish({ [Gen3Key.MODE_B]: 2 })
    expect(update).toHaveBeenCalledOnce()
    expect(update).toHaveBeenCalledWith(40)
  })

  it('removes disabled optional services restored from cache', () => {
    const accessory = new Accessory('Office', uuid.generate('cached-office'))
    accessory.addService(Service.Lightbulb, 'Lamp', 'lamp')
    accessory.addService(Service.Switch, 'Sleep Mode', 'sleep')
    accessory.addService(Service.Switch, 'Auto Plus AI', 'auto-plus')
    accessory.addService(Service.Switch, 'Beep', 'beep')
    const coordinator = new FakeCoordinator()
    const platform = {
      api: { hap: { HapStatusError, HAPStatus } } as unknown as API,
      log: vi.fn() as unknown as Logging,
      Service,
      Characteristic,
    } as PhilipsAirPlatformLike

    new PhilipsAirAccessory(
      platform,
      accessory as unknown as PlatformAccessory,
      coordinator as unknown as DeviceCoordinator,
      resolveModel('AC4220/12'),
      { ...deviceConfig, exposeLight: false, exposeSleepSwitch: false, exposeAutoPlusSwitch: false, exposeBeepSwitch: false },
    )

    expect(accessory.getServiceById(Service.Lightbulb, 'lamp')).toBeUndefined()
    expect(accessory.getServiceById(Service.Switch, 'sleep')).toBeUndefined()
    expect(accessory.getServiceById(Service.Switch, 'auto-plus')).toBeUndefined()
    expect(accessory.getServiceById(Service.Switch, 'beep')).toBeUndefined()
  })
})
