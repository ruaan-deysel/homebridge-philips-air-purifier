import type { API } from 'homebridge'
import { PLATFORM_NAME } from './settings.js'

export default (api: API): void => {
  // PhilipsAirPlatform is registered here in Task 8. Registering a no-op
  // placeholder now keeps the package loadable and the build honest.
  api.registerPlatform(PLATFORM_NAME, class {
    constructor() {}
    configureAccessory(): void {}
  } as never)
}
