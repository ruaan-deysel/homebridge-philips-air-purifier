import { describe, expect, it } from 'vitest'
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
} from '../src/homekit/mapping.js'

describe('airQualityFromPm25', () => {
  it.each([
    [undefined, 0],
    ['12', 0],
    [Number.NaN, 0],
    [Number.POSITIVE_INFINITY, 0],
    [0, 1],
    [12, 1],
    [13, 2],
    [35, 2],
    [36, 3],
    [55, 3],
    [56, 4],
    [150, 4],
    [151, 5],
    [500, 5],
  ])('maps %j to %i', (pm25, expected) => {
    expect(airQualityFromPm25(pm25)).toBe(expected)
  })
})

describe('fan speed mapping', () => {
  it.each([
    [0, 0],
    [17, 0],
    [18, 0],
    [19, 0],
    [1, 20],
    [2, 40],
    [3, 60],
    [4, 80],
    [5, 100],
    [6, 0],
  ])('maps mode %i to %i percent', (mode, expected) => {
    expect(rotationSpeedFromMode(mode, 5)).toBe(expected)
  })

  it.each([
    [-1, null],
    [0, null],
    [1, 1],
    [20, 1],
    [40, 2],
    [45, 2],
    [60, 3],
    [80, 4],
    [91, 5],
    [100, 5],
  ])('maps %i percent to mode %j', (speed, expected) => {
    expect(modeFromRotationSpeed(speed, 5)).toBe(expected)
  })
})

describe('filterLifePercent', () => {
  it.each([
    [175, 720, 24],
    [1374, 9600, 14],
    [-1, 720, 0],
    [900, 720, 100],
    [1, 0, 0],
    [Number.NaN, 720, 0],
    [1, Number.POSITIVE_INFINITY, 0],
    ['175', 720, 0],
  ])('maps %j of %j to %i percent', (remaining, total, expected) => {
    expect(filterLifePercent(remaining, total)).toBe(expected)
  })
})

describe('device scalar mapping', () => {
  it('maps beep writes to the AC4220 domain and reads numeric nonzero', () => {
    expect(beepValue(true)).toBe(100)
    expect(beepValue(false)).toBe(0)
    expect(beepFromValue(100)).toBe(true)
    expect(beepFromValue(-1)).toBe(true)
    expect(beepFromValue(0)).toBe(false)
    expect(beepFromValue('100')).toBe(false)
  })

  it('maps lamp writes to D03135 domain and reads numeric nonzero', () => {
    expect(lampValue(true)).toBe(1)
    expect(lampValue(false)).toBe(0)
    expect(lampFromValue(2)).toBe(true)
    expect(lampFromValue(0)).toBe(false)
    expect(lampFromValue('1')).toBe(false)
  })

  it('maps temperature tenths and numeric booleans', () => {
    expect(temperatureFromRaw(284)).toBe(28.4)
    expect(temperatureFromRaw('284')).toBe(0)
    expect(booleanValue(true)).toBe(1)
    expect(booleanValue(false)).toBe(0)
    expect(booleanFromValue(1)).toBe(true)
    expect(booleanFromValue(100)).toBe(true)
    expect(booleanFromValue(0)).toBe(false)
    expect(booleanFromValue('1')).toBe(false)
  })
})
