import { isIP } from 'node:net'
import process from 'node:process'
import { HomebridgePluginUiServer, RequestError } from '@homebridge/plugin-ui-utils'

const requestError = message => new RequestError(message, {})
const loadDiscovery = () => import('../dist/airctrl/discovery.js')

export async function scanRequest(payload = {}, dependencies) {
  let discovery
  try {
    discovery = dependencies ?? await loadDiscovery()
  } catch {
    throw requestError('Could not load network discovery. Enter an IP address manually or try again.')
  }
  const { discover, hostsInSubnet, localSubnets } = discovery
  const requestedSubnet = typeof payload?.subnet === 'string' ? payload.subnet.trim() : ''
  let subnet
  try {
    subnet = requestedSubnet || localSubnets()[0]
  } catch {
    throw requestError('Could not detect a local IPv4 network. Enter an IP address manually.')
  }
  if (!subnet) {
    throw requestError('No local IPv4 network detected. Enter an IP address manually.')
  }

  let hosts
  try {
    hosts = [...hostsInSubnet(subnet)]
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw requestError(`Cannot scan ${subnet}: ${detail}. Enter an IP address manually.`)
  }

  try {
    const devices = await discover({ hosts, timeoutMs: 1500, concurrency: 48 })
    return { subnet, scanned: hosts.length, devices }
  } catch {
    throw requestError(`Could not scan ${subnet}. Enter an IP address manually or try again.`)
  }
}

export async function probeRequest(payload = {}, dependencies) {
  const host = typeof payload?.host === 'string' ? payload.host.trim() : ''
  if (isIP(host) !== 4) {
    throw requestError(`"${host}" is not a valid IPv4 address.`)
  }

  const requestedPort = payload?.port === undefined ? 5683 : Number(payload.port)
  if (!Number.isInteger(requestedPort) || requestedPort < 1 || requestedPort > 65535) {
    throw requestError(`"${String(payload?.port)}" is not a valid port.`)
  }

  let device
  try {
    const { probeHost } = dependencies ?? await loadDiscovery()
    device = await probeHost(host, requestedPort, 4000)
  } catch {
    throw requestError(`Could not probe ${host}. Check the IP and try again.`)
  }
  if (!device) {
    throw requestError(`No Philips air purifier answered at ${host}. Check the IP and that the device is on this network.`)
  }
  return { device }
}

class PhilipsAirUiServer extends HomebridgePluginUiServer {
  constructor() {
    super()

    this.onRequest('/subnets', async () => {
      try {
        const { localSubnets } = await loadDiscovery()
        return { subnets: localSubnets() }
      } catch {
        throw requestError('Could not detect a local IPv4 network. Enter an IP address manually.')
      }
    })
    this.onRequest('/scan', scanRequest)
    this.onRequest('/probe', probeRequest)
    this.ready()
  }
}

if (process.send && process.env.NODE_ENV !== 'test') new PhilipsAirUiServer()
