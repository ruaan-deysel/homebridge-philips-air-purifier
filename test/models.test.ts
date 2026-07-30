import { describe, expect, it } from 'vitest'
import { ApiGeneration, DEVICE_MODELS, deviceKey, powerValues, resolveModel } from '../src/device/models.js'

describe('deviceKey', () => {
  it.each([
    ['D03105#1', 'D03105'],
    ['D0310A#2', 'D0310A'],
    ['D03102', 'D03102'],
  ])('strips the variant suffix from %s', (input, expected) => {
    expect(deviceKey(input)).toBe(expected)
  })
})

describe('powerValues', () => {
  it.each([
    [ApiGeneration.Gen1, 'pwr', '1', '0'],
    [ApiGeneration.Gen2, 'D03-02', 'ON', 'OFF'],
    [ApiGeneration.Gen3, 'D03102', 1, 0],
  ])('maps %s to the right power key and values', (generation, key, on, off) => {
    expect(powerValues(generation)).toEqual({ key, on, off })
  })
})

describe('resolveModel', () => {
  it('resolves AC4220/12 via the AC4220 family prefix', () => {
    const config = resolveModel('AC4220/12')
    expect(config.apiGeneration).toBe(ApiGeneration.Gen3)
    expect(Object.keys(config.speeds)).toHaveLength(5)
    expect(config.presetModes.auto).toEqual({ D03102: 1, D0310C: 0 })
    expect(config.presetModes.sleep).toEqual({ D03102: 1, D0310C: 17 })
  })

  it('prefers an exact match over the family prefix', () => {
    // 'AC0850/81' is an exact registry key, while its 6-char prefix 'AC0850' is
    // not — so this asserts the exact branch is taken, by identity.
    expect(DEVICE_MODELS['AC0850/81']).toBeDefined()
    expect(resolveModel('AC0850/81')).toBe(DEVICE_MODELS['AC0850/81'])
  })

  it('falls back to a generic config for an unknown model', () => {
    const config = resolveModel('XX9999/99', ApiGeneration.Gen3)
    expect(config.apiGeneration).toBe(ApiGeneration.Gen3)
    expect(config.speeds).toEqual({})
  })

  // NOTE: The brief's stated count is 61, but the source repository this task was
  // told to clone (github.com/ruaan-deysel/ha-philips-airpurifier) currently has
  // 62 distinct entries in DEVICE_MODELS (verified via Python AST parse — no
  // duplicate FanModel string values, all 62 keys present in the dict literal).
  // "Port from data, not from memory" is followed here: all 62 registry entries
  // are transcribed, and this assertion reflects the real data rather than the
  // brief's count. See task-5-report.md for details.
  it('has all 62 models from the HA registry', () => {
    expect(Object.keys(DEVICE_MODELS)).toHaveLength(62)
  })
})
