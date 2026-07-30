import type {
  API,
  Characteristic as HapCharacteristic,
  CharacteristicValue,
  Logging,
  PlatformAccessory,
  Service as HapService,
} from 'homebridge'
import type { DeviceConfig, DeviceStatus } from './airctrl/schema.js'
import type { DeviceCoordinator } from './device/coordinator.js'
import { Gen1Key, Gen2Key, Gen3Key } from './device/keys.js'
import { ApiGeneration, type DeviceModelConfig, powerValues } from './device/models.js'
import {
  airQualityFromPm25,
  beepFromValue,
  beepValue,
  booleanFromValue,
  booleanValue,
  filterLifePercent,
  lampFromValue,
  lampValue,
  modeFromRotationSpeed,
  rotationSpeedFromMode,
  temperatureFromRaw,
} from './homekit/mapping.js'

/** The structural slice Task 9's platform supplies. */
export interface PhilipsAirPlatformLike {
  readonly api: API
  readonly log: Logging
  readonly Service: API['hap']['Service']
  readonly Characteristic: API['hap']['Characteristic']
}

export class PhilipsAirAccessory {
  private readonly deviceCharacteristics: HapCharacteristic[] = []
  private readonly purifier: HapService
  private readonly airQuality: HapService
  private temperature?: HapService
  private humidity?: HapService
  private preFilter?: HapService
  private nanoFilter?: HapService
  private light?: HapService
  private sleep?: HapService
  private autoPlus?: HapService
  private beep?: HapService
  private lastManualMode = 1

  constructor(
    private readonly platform: PhilipsAirPlatformLike,
    private readonly accessory: PlatformAccessory,
    private readonly coordinator: DeviceCoordinator,
    private readonly model: DeviceModelConfig,
    private readonly config: DeviceConfig,
  ) {
    const S = platform.Service
    const C = platform.Characteristic
    const status = coordinator.status

    const information = accessory.getService(S.AccessoryInformation)!
    information
      .setCharacteristic(C.Manufacturer, 'Philips')
      .setCharacteristic(C.Name, accessory.displayName)

    this.purifier = accessory.getService(S.AirPurifier)
      ?? accessory.addService(S.AirPurifier, accessory.displayName)
    this.airQuality = accessory.getService(S.AirQualitySensor)
      ?? accessory.addService(S.AirQualitySensor, `${accessory.displayName} Air Quality`)
    this.purifier.setPrimaryService()
    this.purifier.addLinkedService(this.airQuality)

    const active = this.purifier.getCharacteristic(C.Active)
    const currentState = this.purifier.getCharacteristic(C.CurrentAirPurifierState)
    const targetState = this.purifier.getCharacteristic(C.TargetAirPurifierState)
    const rotationSpeed = this.purifier.getCharacteristic(C.RotationSpeed)
    const childLock = this.purifier.getCharacteristic(C.LockPhysicalControls)
    rotationSpeed.setProps({ minStep: 100 / Math.max(1, Object.keys(model.speeds).length) })

    this.onGet(active, device => booleanFromValue(device[this.power.key])
      ? C.Active.ACTIVE
      : C.Active.INACTIVE)
    active.onSet(value => this.write({
      [this.power.key]: value === C.Active.ACTIVE ? this.power.on : this.power.off,
    }))
    this.onGet(currentState, device => booleanFromValue(device[this.power.key])
      ? C.CurrentAirPurifierState.PURIFYING_AIR
      : C.CurrentAirPurifierState.INACTIVE)
    this.onGet(targetState, device => this.mode(device) === 0
      ? C.TargetAirPurifierState.AUTO
      : C.TargetAirPurifierState.MANUAL)
    targetState.onSet(value => {
      if (value === C.TargetAirPurifierState.AUTO) {
        return this.write(this.model.presetModes.auto ?? {
          [this.power.key]: this.power.on,
          [Gen3Key.MODE_B]: 0,
        })
      }
      return this.write(Object.values(this.model.speeds)[this.lastManualMode - 1] ?? {
        [this.power.key]: this.power.on,
        [Gen3Key.MODE_B]: this.lastManualMode,
      })
    })
    this.onGet(rotationSpeed, device =>
      rotationSpeedFromMode(this.mode(device), Object.keys(this.model.speeds).length))
    rotationSpeed.onSet(value => {
      const mode = modeFromRotationSpeed(Number(value), Object.keys(this.model.speeds).length)
      if (mode === null) return this.write({ [this.power.key]: this.power.off })
      return this.write(Object.values(this.model.speeds)[mode - 1]!)
    })
    this.onGet(childLock, device => booleanFromValue(device[this.childLockKey])
      ? C.LockPhysicalControls.CONTROL_LOCK_ENABLED
      : C.LockPhysicalControls.CONTROL_LOCK_DISABLED)
    childLock.onSet(value => this.write({
      [this.childLockKey]: booleanValue(value === C.LockPhysicalControls.CONTROL_LOCK_ENABLED),
    }))

    const pm25 = this.airQuality.getCharacteristic(C.PM2_5Density)
    const airQuality = this.airQuality.getCharacteristic(C.AirQuality)
    this.onGet(pm25, device => this.number(device[this.pm25Key]))
    this.onGet(airQuality, device => airQualityFromPm25(device[this.pm25Key]))

    if (status && Gen3Key.TEMPERATURE in status && !model.unavailableSensors.includes(Gen3Key.TEMPERATURE)) {
      this.temperature = accessory.getService(S.TemperatureSensor)
        ?? accessory.addService(S.TemperatureSensor, `${accessory.displayName} Temperature`)
      this.purifier.addLinkedService(this.temperature)
      this.onGet(
        this.temperature.getCharacteristic(C.CurrentTemperature),
        device => temperatureFromRaw(device[Gen3Key.TEMPERATURE]),
      )
    } else {
      const cached = accessory.getService(S.TemperatureSensor)
      if (cached) accessory.removeService(cached)
    }

    if (status && Gen3Key.HUMIDITY in status && !model.unavailableSensors.includes(Gen3Key.HUMIDITY)) {
      this.humidity = accessory.getService(S.HumiditySensor)
        ?? accessory.addService(S.HumiditySensor, `${accessory.displayName} Humidity`)
      this.purifier.addLinkedService(this.humidity)
      this.onGet(
        this.humidity.getCharacteristic(C.CurrentRelativeHumidity),
        device => this.number(device[Gen3Key.HUMIDITY]),
      )
    } else {
      const cached = accessory.getService(S.HumiditySensor)
      if (cached) accessory.removeService(cached)
    }

    if (status && (Gen3Key.FILTER_PREFILTER in status || Gen3Key.FILTER_PREFILTER_TOTAL in status)) {
      this.preFilter = accessory.getServiceById(S.FilterMaintenance, 'pre-filter')
        ?? accessory.addService(S.FilterMaintenance, 'Pre-Filter', 'pre-filter')
      this.purifier.addLinkedService(this.preFilter)
      this.wireFilter(this.preFilter, Gen3Key.FILTER_PREFILTER, Gen3Key.FILTER_PREFILTER_TOTAL)
    } else {
      const cached = accessory.getServiceById(S.FilterMaintenance, 'pre-filter')
      if (cached) accessory.removeService(cached)
    }

    if (status && (Gen3Key.FILTER_NANOPROTECT in status || Gen3Key.FILTER_NANOPROTECT_TOTAL in status)) {
      this.nanoFilter = accessory.getServiceById(S.FilterMaintenance, 'nano-protect')
        ?? accessory.addService(S.FilterMaintenance, 'NanoProtect Filter', 'nano-protect')
      this.purifier.addLinkedService(this.nanoFilter)
      this.wireFilter(this.nanoFilter, Gen3Key.FILTER_NANOPROTECT, Gen3Key.FILTER_NANOPROTECT_TOTAL)
    } else {
      const cached = accessory.getServiceById(S.FilterMaintenance, 'nano-protect')
      if (cached) accessory.removeService(cached)
    }

    const cachedLight = accessory.getServiceById(S.Lightbulb, 'lamp')
    if (config.exposeLight && model.lights.includes(Gen3Key.LAMP_MODE)) {
      this.light = cachedLight ?? accessory.addService(S.Lightbulb, 'Lamp', 'lamp')
      this.purifier.addLinkedService(this.light)
      const on = this.light.getCharacteristic(C.On)
      this.onGet(on, device => lampFromValue(device[Gen3Key.LAMP_MODE]))
      on.onSet(value => this.write({ [Gen3Key.LAMP_MODE]: lampValue(Boolean(value)) }))
    } else if (cachedLight) {
      accessory.removeService(cachedLight)
    }

    const cachedSleep = accessory.getServiceById(S.Switch, 'sleep')
    if (config.exposeSleepSwitch && this.model.presetModes.sleep) {
      this.sleep = cachedSleep ?? accessory.addService(S.Switch, 'Sleep Mode', 'sleep')
      this.purifier.addLinkedService(this.sleep)
      const on = this.sleep.getCharacteristic(C.On)
      this.onGet(on, device => booleanFromValue(device[this.power.key]) && this.mode(device) === 17)
      on.onSet(value => this.write(value
        ? this.model.presetModes.sleep!
        : this.model.presetModes.auto!))
    } else if (cachedSleep) {
      accessory.removeService(cachedSleep)
    }

    const cachedAutoPlus = accessory.getServiceById(S.Switch, 'auto-plus')
    if (config.exposeAutoPlusSwitch && model.switches.includes(Gen3Key.AUTO_PLUS_AI)) {
      this.autoPlus = cachedAutoPlus ?? accessory.addService(S.Switch, 'Auto Plus AI', 'auto-plus')
      this.purifier.addLinkedService(this.autoPlus)
      const on = this.autoPlus.getCharacteristic(C.On)
      this.onGet(on, device => booleanFromValue(device[Gen3Key.AUTO_PLUS_AI]))
      on.onSet(value => this.write({ [Gen3Key.AUTO_PLUS_AI]: booleanValue(Boolean(value)) }))
    } else if (cachedAutoPlus) {
      accessory.removeService(cachedAutoPlus)
    }

    const cachedBeep = accessory.getServiceById(S.Switch, 'beep')
    if (config.exposeBeepSwitch && model.switches.includes(Gen3Key.BEEP)) {
      this.beep = cachedBeep ?? accessory.addService(S.Switch, 'Beep', 'beep')
      this.purifier.addLinkedService(this.beep)
      const on = this.beep.getCharacteristic(C.On)
      this.onGet(on, device => beepFromValue(device[Gen3Key.BEEP]))
      on.onSet(value => this.write({ [Gen3Key.BEEP]: beepValue(Boolean(value)) }))
    } else if (cachedBeep) {
      accessory.removeService(cachedBeep)
    }

    coordinator.on('status', (next: DeviceStatus) => {
      this.updateInformation(next)
      if (coordinator.available) this.updateCharacteristics(next)
    })
    coordinator.on('availability', (available: boolean) => {
      if (!available) this.markUnavailable()
    })

    if (status) this.updateInformation(status)
    if (coordinator.available && status) this.updateCharacteristics(status)
    else this.markUnavailable()
  }

  private get power(): ReturnType<typeof powerValues> {
    return powerValues(this.model.apiGeneration)
  }

  private get childLockKey(): string {
    return this.model.apiGeneration === ApiGeneration.Gen3 ? Gen3Key.CHILD_LOCK : Gen1Key.CHILD_LOCK
  }

  private get pm25Key(): string {
    switch (this.model.apiGeneration) {
      case ApiGeneration.Gen2: return Gen2Key.PM25
      case ApiGeneration.Gen3: return Gen3Key.PM25
      default: return Gen1Key.PM25
    }
  }

  private get modeKey(): string {
    switch (this.model.apiGeneration) {
      case ApiGeneration.Gen2: return Gen2Key.MODE
      case ApiGeneration.Gen3: return Gen3Key.MODE_B
      default: return Gen1Key.MODE
    }
  }

  private mode(status: DeviceStatus): unknown {
    return status[this.modeKey]
  }

  private number(value: unknown): number {
    return typeof value === 'number' && Number.isFinite(value) ? value : 0
  }

  private communicationError(): InstanceType<API['hap']['HapStatusError']> {
    return new this.platform.api.hap.HapStatusError(
      this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE,
    )
  }

  private currentStatus(): DeviceStatus {
    if (!this.coordinator.available || !this.coordinator.status) throw this.communicationError()
    return this.coordinator.status
  }

  private onGet(
    characteristic: HapCharacteristic,
    read: (status: DeviceStatus) => CharacteristicValue,
  ): void {
    this.deviceCharacteristics.push(characteristic)
    characteristic.onGet(() => read(this.currentStatus()))
  }

  private async write(values: Record<string, unknown>): Promise<void> {
    if (!this.coordinator.available) throw this.communicationError()
    try {
      if (!await this.coordinator.setControl(values)) throw this.communicationError()
    } catch (error) {
      if (error instanceof this.platform.api.hap.HapStatusError) throw error
      this.platform.log.error(`Control write failed: ${String(error)}`)
      throw this.communicationError()
    }
  }

  private wireFilter(service: HapService, remainingKey: string, totalKey: string): void {
    const C = this.platform.Characteristic
    this.onGet(
      service.getCharacteristic(C.FilterLifeLevel),
      status => filterLifePercent(status[remainingKey], status[totalKey]),
    )
    this.onGet(
      service.getCharacteristic(C.FilterChangeIndication),
      status => filterLifePercent(status[remainingKey], status[totalKey]) === 0
        ? C.FilterChangeIndication.CHANGE_FILTER
        : C.FilterChangeIndication.FILTER_OK,
    )
  }

  private updateInformation(status: DeviceStatus): void {
    const C = this.platform.Characteristic
    const information = this.accessory.getService(this.platform.Service.AccessoryInformation)!
    const model = status[Gen3Key.MODEL_ID] ?? status[Gen2Key.MODEL_ID] ?? status[Gen1Key.MODEL_ID]
    const serial = status[Gen3Key.SERIAL] ?? status[Gen1Key.DEVICE_ID]
    const firmware = status[Gen3Key.SOFTWARE_VERSION]
      ?? status[Gen2Key.SOFTWARE_VERSION]
      ?? status[Gen1Key.SOFTWARE_VERSION]
    if (typeof model === 'string') this.update(information.getCharacteristic(C.Model), model)
    if (typeof serial === 'string') this.update(information.getCharacteristic(C.SerialNumber), serial)
    if (typeof firmware === 'string') this.update(information.getCharacteristic(C.FirmwareRevision), firmware)
  }

  private updateCharacteristics(status: DeviceStatus): void {
    const C = this.platform.Characteristic
    const speedCount = Object.keys(this.model.speeds).length
    const mode = this.mode(status)
    if (typeof mode === 'number' && Number.isInteger(mode) && mode >= 1 && mode <= speedCount) {
      this.lastManualMode = mode
    }
    const powered = booleanFromValue(status[this.power.key])

    this.update(this.purifier.getCharacteristic(C.Active), powered ? C.Active.ACTIVE : C.Active.INACTIVE)
    this.update(
      this.purifier.getCharacteristic(C.CurrentAirPurifierState),
      powered ? C.CurrentAirPurifierState.PURIFYING_AIR : C.CurrentAirPurifierState.INACTIVE,
    )
    this.update(
      this.purifier.getCharacteristic(C.TargetAirPurifierState),
      mode === 0 ? C.TargetAirPurifierState.AUTO : C.TargetAirPurifierState.MANUAL,
    )
    this.update(
      this.purifier.getCharacteristic(C.RotationSpeed),
      rotationSpeedFromMode(mode, speedCount),
    )
    this.update(
      this.purifier.getCharacteristic(C.LockPhysicalControls),
      booleanFromValue(status[this.childLockKey])
        ? C.LockPhysicalControls.CONTROL_LOCK_ENABLED
        : C.LockPhysicalControls.CONTROL_LOCK_DISABLED,
    )
    this.update(
      this.airQuality.getCharacteristic(C.PM2_5Density),
      this.number(status[this.pm25Key]),
    )
    this.update(
      this.airQuality.getCharacteristic(C.AirQuality),
      airQualityFromPm25(status[this.pm25Key]),
    )
    if (this.temperature) this.update(
      this.temperature.getCharacteristic(C.CurrentTemperature),
      temperatureFromRaw(status[Gen3Key.TEMPERATURE]),
    )
    if (this.humidity) this.update(
      this.humidity.getCharacteristic(C.CurrentRelativeHumidity),
      this.number(status[Gen3Key.HUMIDITY]),
    )
    if (this.preFilter) this.updateFilter(
      this.preFilter,
      status[Gen3Key.FILTER_PREFILTER],
      status[Gen3Key.FILTER_PREFILTER_TOTAL],
    )
    if (this.nanoFilter) this.updateFilter(
      this.nanoFilter,
      status[Gen3Key.FILTER_NANOPROTECT],
      status[Gen3Key.FILTER_NANOPROTECT_TOTAL],
    )
    if (this.light) this.update(
      this.light.getCharacteristic(C.On),
      lampFromValue(status[Gen3Key.LAMP_MODE]),
    )
    if (this.sleep) this.update(
      this.sleep.getCharacteristic(C.On),
      powered && mode === 17,
    )
    if (this.autoPlus) this.update(
      this.autoPlus.getCharacteristic(C.On),
      booleanFromValue(status[Gen3Key.AUTO_PLUS_AI]),
    )
    if (this.beep) this.update(
      this.beep.getCharacteristic(C.On),
      beepFromValue(status[Gen3Key.BEEP]),
    )
  }

  private updateFilter(service: HapService, remaining: unknown, total: unknown): void {
    const C = this.platform.Characteristic
    const life = filterLifePercent(remaining, total)
    this.update(service.getCharacteristic(C.FilterLifeLevel), life)
    this.update(
      service.getCharacteristic(C.FilterChangeIndication),
      life === 0 ? C.FilterChangeIndication.CHANGE_FILTER : C.FilterChangeIndication.FILTER_OK,
    )
  }

  private update(characteristic: HapCharacteristic, value: CharacteristicValue): void {
    if (
      characteristic.value !== value
      || characteristic.statusCode !== this.platform.api.hap.HAPStatus.SUCCESS
    ) characteristic.updateValue(value)
  }

  private markUnavailable(): void {
    for (const characteristic of this.deviceCharacteristics) {
      characteristic.updateValue(this.communicationError())
    }
  }
}
