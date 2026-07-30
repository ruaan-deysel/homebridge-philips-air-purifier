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
import { ApiGeneration, deviceKey, type DeviceModelConfig, powerValues } from './device/models.js'
import {
  airQualityFromPm25,
  beepFromValue,
  beepValue,
  booleanFromValue,
  booleanValue,
  filterLifePercent,
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
  private preFilterKeys?: [string, string]
  private nanoFilter?: HapService
  private nanoFilterKeys?: [string, string]
  private light?: HapService
  private lightControl?: { key: string, on: string | number, off: string | number }
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

    this.onGet(active, device => this.powered(device)
      ? C.Active.ACTIVE
      : C.Active.INACTIVE)
    active.onSet(value => this.write({
      [this.power.key]: value === C.Active.ACTIVE ? this.power.on : this.power.off,
    }))
    this.onGet(currentState, device => this.powered(device)
      ? C.CurrentAirPurifierState.PURIFYING_AIR
      : C.CurrentAirPurifierState.INACTIVE)
    this.onGet(targetState, device => this.matchesControl(device, this.model.presetModes.auto)
      ? C.TargetAirPurifierState.AUTO
      : C.TargetAirPurifierState.MANUAL)
    targetState.onSet(value => {
      if (value === C.TargetAirPurifierState.AUTO) {
        const control = this.model.presetModes.auto
        if (!control) throw this.communicationError()
        return this.write(control)
      }
      const control = Object.values(this.model.speeds)[this.lastManualMode - 1]
      if (!control) throw this.communicationError()
      return this.write(control)
    })
    this.onGet(rotationSpeed, device => this.powered(device)
      ? rotationSpeedFromMode(this.speedMode(device), Object.keys(this.model.speeds).length)
      : 0)
    rotationSpeed.onSet(value => {
      if (Number(value) <= 0) return this.write({ [this.power.key]: this.power.off })
      const mode = modeFromRotationSpeed(Number(value), Object.keys(this.model.speeds).length)
      const control = mode === null ? undefined : Object.values(this.model.speeds)[mode - 1]
      if (!control) throw this.communicationError()
      return this.write(control)
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

    const temperatureKey = this.temperatureKey
    if (status && temperatureKey && temperatureKey in status) {
      this.temperature = accessory.getService(S.TemperatureSensor)
        ?? accessory.addService(S.TemperatureSensor, `${accessory.displayName} Temperature`)
      this.purifier.addLinkedService(this.temperature)
      this.onGet(
        this.temperature.getCharacteristic(C.CurrentTemperature),
        device => this.temperatureValue(device[temperatureKey]),
      )
    } else {
      const cached = accessory.getService(S.TemperatureSensor)
      if (cached) accessory.removeService(cached)
    }

    const humidityKey = this.humidityKey
    if (status && humidityKey && humidityKey in status) {
      this.humidity = accessory.getService(S.HumiditySensor)
        ?? accessory.addService(S.HumiditySensor, `${accessory.displayName} Humidity`)
      this.purifier.addLinkedService(this.humidity)
      this.onGet(
        this.humidity.getCharacteristic(C.CurrentRelativeHumidity),
        device => this.number(device[humidityKey]),
      )
    } else {
      const cached = accessory.getService(S.HumiditySensor)
      if (cached) accessory.removeService(cached)
    }

    this.preFilterKeys = status ? this.filterKeys(status, 'pre') : undefined
    if (this.preFilterKeys) {
      this.preFilter = accessory.getServiceById(S.FilterMaintenance, 'pre-filter')
        ?? accessory.addService(S.FilterMaintenance, 'Pre-Filter', 'pre-filter')
      this.purifier.addLinkedService(this.preFilter)
      this.wireFilter(this.preFilter, ...this.preFilterKeys)
    } else {
      const cached = accessory.getServiceById(S.FilterMaintenance, 'pre-filter')
      if (cached) accessory.removeService(cached)
    }

    this.nanoFilterKeys = status ? this.filterKeys(status, 'nano') : undefined
    if (this.nanoFilterKeys) {
      this.nanoFilter = accessory.getServiceById(S.FilterMaintenance, 'nano-protect')
        ?? accessory.addService(S.FilterMaintenance, 'NanoProtect Filter', 'nano-protect')
      this.purifier.addLinkedService(this.nanoFilter)
      this.wireFilter(this.nanoFilter, ...this.nanoFilterKeys)
    } else {
      const cached = accessory.getServiceById(S.FilterMaintenance, 'nano-protect')
      if (cached) accessory.removeService(cached)
    }

    const cachedLight = accessory.getServiceById(S.Lightbulb, 'lamp')
    this.lightControl = status
      ? model.lights.map(key => this.lightValues(key)).find(control => control && control.key in status)
      : undefined
    if (config.exposeLight && this.lightControl) {
      this.light = cachedLight ?? accessory.addService(S.Lightbulb, 'Lamp', 'lamp')
      this.purifier.addLinkedService(this.light)
      const on = this.light.getCharacteristic(C.On)
      this.onGet(on, device => device[this.lightControl!.key] !== this.lightControl!.off)
      on.onSet(value => this.write({
        [this.lightControl!.key]: value ? this.lightControl!.on : this.lightControl!.off,
      }))
    } else if (cachedLight) {
      accessory.removeService(cachedLight)
    }

    const cachedSleep = accessory.getServiceById(S.Switch, 'sleep')
    if (config.exposeSleepSwitch && this.model.presetModes.sleep) {
      this.sleep = cachedSleep ?? accessory.addService(S.Switch, 'Sleep Mode', 'sleep')
      this.purifier.addLinkedService(this.sleep)
      const on = this.sleep.getCharacteristic(C.On)
      this.onGet(on, device =>
        this.powered(device) && this.matchesControl(device, this.model.presetModes.sleep))
      on.onSet(value => {
        const control = value ? this.model.presetModes.sleep : this.model.presetModes.auto
        if (!control) throw this.communicationError()
        return this.write(control)
      })
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

  private get temperatureKey(): string | undefined {
    const key = this.model.apiGeneration === ApiGeneration.Gen1
      ? Gen1Key.TEMPERATURE
      : this.model.apiGeneration === ApiGeneration.Gen3 ? Gen3Key.TEMPERATURE : undefined
    return key && !this.unavailable(this.model.unavailableSensors, key) ? key : undefined
  }

  private get humidityKey(): string | undefined {
    const key = this.model.apiGeneration === ApiGeneration.Gen1
      ? Gen1Key.HUMIDITY
      : this.model.apiGeneration === ApiGeneration.Gen3 ? Gen3Key.HUMIDITY : undefined
    return key && !this.unavailable(this.model.unavailableSensors, key) ? key : undefined
  }

  private unavailable(keys: string[], key: string): boolean {
    return keys.some(value => deviceKey(value) === key)
  }

  private filterKeys(status: DeviceStatus, kind: 'pre' | 'nano'): [string, string] | undefined {
    const unavailableKey = kind === 'pre'
      ? Gen1Key.FILTER_NANOPROTECT_PREFILTER
      : Gen1Key.FILTER_NANOPROTECT
    if (this.unavailable(this.model.unavailableFilters, unavailableKey)) return undefined

    const candidates: [string, string][] = this.model.apiGeneration === ApiGeneration.Gen3
      ? [kind === 'pre'
          ? [Gen3Key.FILTER_PREFILTER, Gen3Key.FILTER_PREFILTER_TOTAL]
          : [Gen3Key.FILTER_NANOPROTECT, Gen3Key.FILTER_NANOPROTECT_TOTAL]]
      : this.model.apiGeneration === ApiGeneration.Gen1
        ? kind === 'pre'
          ? [
              [Gen1Key.FILTER_NANOPROTECT_PREFILTER, Gen1Key.FILTER_NANOPROTECT_CLEAN_TOTAL],
              [Gen1Key.FILTER_PRE, Gen1Key.FILTER_PRE_TOTAL],
            ]
          : [
              [Gen1Key.FILTER_NANOPROTECT, Gen1Key.FILTER_NANOPROTECT_TOTAL],
              [Gen1Key.FILTER_HEPA, Gen1Key.FILTER_HEPA_TOTAL],
            ]
        : []
    return candidates.find(([remaining, total]) => remaining in status && total in status)
  }

  private lightValues(registryKey: string): {
    key: string
    on: string | number
    off: string | number
  } | undefined {
    const key = deviceKey(registryKey)
    if (key === Gen1Key.DISPLAY_BACKLIGHT) return { key, on: '1', off: '0' }
    if (
      key === Gen1Key.LIGHT_BRIGHTNESS
      || key === Gen2Key.DISPLAY_BACKLIGHT
      || key === Gen3Key.DISPLAY_BACKLIGHT_PRIMARY
    ) return { key, on: 100, off: 0 }
    if (registryKey.startsWith(`${Gen3Key.DISPLAY_BACKLIGHT}#`)) return { key, on: 123, off: 0 }
    if (key === Gen3Key.DISPLAY_BACKLIGHT) return { key, on: 100, off: 0 }
    if (key === Gen3Key.LAMP_MODE) return { key, on: 1, off: 0 }
    return undefined
  }

  private powered(status: DeviceStatus): boolean {
    return status[this.power.key] === this.power.on
  }

  private matchesControl(
    status: DeviceStatus,
    control: Record<string, string | number> | undefined,
  ): boolean {
    if (!control) return false
    const entries = Object.entries(control)
      .filter(([key]) => deviceKey(key) !== this.power.key)
    return entries.length > 0
      && entries.every(([key, value]) => status[deviceKey(key)] === value)
  }

  private speedMode(status: DeviceStatus): number | null {
    const index = Object.values(this.model.speeds)
      .findIndex(control => this.matchesControl(status, control))
    return index === -1 ? null : index + 1
  }

  private number(value: unknown): number {
    return typeof value === 'number' && Number.isFinite(value) ? value : 0
  }

  private temperatureValue(value: unknown): number {
    return this.model.apiGeneration === ApiGeneration.Gen3
      ? temperatureFromRaw(value)
      : this.number(value)
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
    const mode = this.speedMode(status)
    if (mode !== null) this.lastManualMode = mode
    const powered = this.powered(status)

    this.update(this.purifier.getCharacteristic(C.Active), powered ? C.Active.ACTIVE : C.Active.INACTIVE)
    this.update(
      this.purifier.getCharacteristic(C.CurrentAirPurifierState),
      powered ? C.CurrentAirPurifierState.PURIFYING_AIR : C.CurrentAirPurifierState.INACTIVE,
    )
    this.update(
      this.purifier.getCharacteristic(C.TargetAirPurifierState),
      this.matchesControl(status, this.model.presetModes.auto)
        ? C.TargetAirPurifierState.AUTO
        : C.TargetAirPurifierState.MANUAL,
    )
    this.update(
      this.purifier.getCharacteristic(C.RotationSpeed),
      powered ? rotationSpeedFromMode(mode, speedCount) : 0,
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
    if (this.temperature && this.temperatureKey) this.update(
      this.temperature.getCharacteristic(C.CurrentTemperature),
      this.temperatureValue(status[this.temperatureKey]),
    )
    if (this.humidity && this.humidityKey) this.update(
      this.humidity.getCharacteristic(C.CurrentRelativeHumidity),
      this.number(status[this.humidityKey]),
    )
    if (this.preFilter && this.preFilterKeys) this.updateFilter(
      this.preFilter,
      status[this.preFilterKeys[0]],
      status[this.preFilterKeys[1]],
    )
    if (this.nanoFilter && this.nanoFilterKeys) this.updateFilter(
      this.nanoFilter,
      status[this.nanoFilterKeys[0]],
      status[this.nanoFilterKeys[1]],
    )
    if (this.light && this.lightControl) this.update(
      this.light.getCharacteristic(C.On),
      status[this.lightControl.key] !== this.lightControl.off,
    )
    if (this.sleep) this.update(
      this.sleep.getCharacteristic(C.On),
      powered && this.matchesControl(status, this.model.presetModes.sleep),
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
