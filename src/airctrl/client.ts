import { randomBytes } from 'node:crypto'
import { decrypt, encrypt, nextKey } from './crypto.js'
import {
  DeviceInfoSchema,
  parseStatusPayload,
  type DeviceInfo,
  type DeviceStatus,
} from './schema.js'
import { CoapOption, bufferToUint, findOption, type DecodedCoapMessage } from './coap/message.js'
import { CoapSocket, type Observation } from './coap/socket.js'

const STATUS_PATH = '/sys/dev/status'
const CONTROL_PATH = '/sys/dev/control'
const SYNC_PATH = '/sys/dev/sync'
const INFO_PATH = '/sys/dev/info'
const DEFAULT_MAX_AGE = 60

export class NotConnectedError extends Error {
  constructor() {
    super('client key not initialised; call connect() first')
    this.name = 'NotConnectedError'
  }
}

export interface SetControlOptions {
  retries?: number
  retryDelayMs?: number
  resync?: boolean
}

export class PhilipsCoapClient {
  private readonly socket: CoapSocket
  private readonly observations = new Set<Observation>()
  private readonly observationFailures = new Map<Observation, (error: Error) => void>()
  private clientKey?: string
  private closed = false

  constructor(host: string, port = 5683) {
    this.socket = new CoapSocket(host, port)
  }

  async getInfo(): Promise<DeviceInfo> {
    this.requireOpen()
    try {
      const response = await this.socket.request({ method: 'GET', path: INFO_PATH })
      this.requireOpen()
      return DeviceInfoSchema.parse(JSON.parse(response.payload.toString()))
    } catch (error) {
      this.requireOpen()
      throw error
    }
  }

  async connect(): Promise<void> {
    this.requireOpen()
    const nonce = randomBytes(4).toString('hex').toUpperCase()
    try {
      const response = await this.socket.request({ method: 'POST', path: SYNC_PATH, payload: nonce })
      this.requireOpen()
      this.clientKey = response.payload.toString().trim()
    } catch (error) {
      this.requireOpen()
      throw error
    }
  }

  private requireKey(): string {
    if (!this.clientKey) throw new NotConnectedError()
    return this.clientKey
  }

  private requireOpen(): void {
    if (this.closed) throw new Error('client closed')
  }

  private parseStatus(message: DecodedCoapMessage): DeviceStatus {
    return parseStatusPayload(decrypt(message.payload.toString()))
  }

  async getStatus(): Promise<{ status: DeviceStatus, maxAge: number }> {
    this.requireOpen()
    this.requireKey()
    let observation: Observation | undefined
    try {
      observation = await this.socket.observe({ path: STATUS_PATH, onNotify: () => {} })
      this.requireOpen()
      const maxAgeOption = findOption(observation.first.options, CoapOption.MaxAge)
      const maxAge = maxAgeOption ? bufferToUint(maxAgeOption.value) : DEFAULT_MAX_AGE
      return {
        status: this.parseStatus(observation.first),
        maxAge: maxAge > 0 ? maxAge : DEFAULT_MAX_AGE,
      }
    } catch (error) {
      this.requireOpen()
      throw error
    } finally {
      observation?.cancel()
    }
  }

  async *observe(): AsyncGenerator<DeviceStatus> {
    this.requireOpen()
    this.requireKey()
    const queue: DeviceStatus[] = []
    let failure: Error | undefined
    let wake: (() => void) | undefined
    const fail = (error: unknown): void => {
      failure = error instanceof Error ? error : new Error(String(error))
      wake?.()
      wake = undefined
    }
    const enqueue = (message: DecodedCoapMessage): void => {
      try {
        queue.push(this.parseStatus(message))
        wake?.()
        wake = undefined
      } catch (error) {
        fail(error)
      }
    }

    let observation: Observation
    try {
      observation = await this.socket.observe({
        path: STATUS_PATH,
        onNotify: enqueue,
        onError: fail,
      })
    } catch (error) {
      this.requireOpen()
      throw error
    }
    if (this.closed) {
      observation.cancel()
      this.requireOpen()
    }
    this.observations.add(observation)
    this.observationFailures.set(observation, fail)

    try {
      yield this.parseStatus(observation.first)
      while (true) {
        if (failure) throw failure
        if (queue.length) {
          yield queue.shift()!
          continue
        }
        await new Promise<void>(resolve => {
          wake = resolve
          if (failure || queue.length) {
            wake = undefined
            resolve()
          }
        })
      }
    } finally {
      this.observationFailures.delete(observation)
      if (this.observations.delete(observation)) observation.cancel()
    }
  }

  async setControl(
    values: Record<string, unknown>,
    options: SetControlOptions = {},
  ): Promise<boolean> {
    this.requireOpen()
    const { retries = 5, retryDelayMs = 500, resync = true } = options
    this.requireKey()
    const payload = JSON.stringify({
      state: {
        desired: {
          CommandType: 'app',
          DeviceId: '',
          EnduserId: '',
          ...values,
        },
      },
    })

    for (let attempt = 0; attempt <= retries; attempt++) {
      this.requireOpen()
      try {
        this.clientKey = nextKey(this.requireKey())
        const response = await this.socket.request({
          method: 'POST',
          path: CONTROL_PATH,
          payload: encrypt(this.clientKey, payload),
        })
        this.requireOpen()
        if (JSON.parse(response.payload.toString()).status === 'success') return true
      } catch {
        this.requireOpen()
        // A timeout, malformed response, or rejected write is retryable.
      }

      if (attempt === retries) break
      if (resync) {
        try {
          await this.connect()
        } catch {
          this.requireOpen()
          return false
        }
      }
      await new Promise(resolve => setTimeout(resolve, retryDelayMs))
    }

    return false
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    for (const observation of this.observations) {
      this.observationFailures.get(observation)?.(new Error('client closed'))
      observation.cancel()
    }
    this.observations.clear()
    this.observationFailures.clear()
    setImmediate(() => this.socket.close())
  }
}
