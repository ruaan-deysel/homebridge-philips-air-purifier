import { describe, expect, it } from 'vitest'
import { PLATFORM_NAME, PLUGIN_NAME } from '../src/settings.js'

describe('scaffold', () => {
  it('exposes the platform and plugin names', () => {
    expect(PLATFORM_NAME).toBe('PhilipsAirPurifier')
    expect(PLUGIN_NAME).toBe('homebridge-philips-air-purifier')
  })
})
