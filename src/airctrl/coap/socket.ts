import { createSocket, type Socket } from 'node:dgram'
import { randomBytes, randomInt } from 'node:crypto'
import {
  CoapCode,
  CoapOption,
  CoapType,
  type DecodedCoapMessage,
  decode,
  encode,
  uintToBuffer,
  uriPathOptions,
} from './message.js'

const DEFAULT_TIMEOUT_MS = 8000

export interface RequestOptions {
  method: 'GET' | 'POST'
  path: string
  payload?: string | Buffer
  timeoutMs?: number
}

export interface ObserveOptions {
  path: string
  onNotify: (message: DecodedCoapMessage) => void
  onError?: (error: Error) => void
  timeoutMs?: number
}

export interface Observation {
  first: DecodedCoapMessage
  /** Proactively deregister: same token, Observe = 1. */
  cancel: () => void
}

/**
 * A UDP socket speaking just enough CoAP for Philips devices.
 *
 * Responses are matched to requests by TOKEN, not message ID. Observe
 * notifications reuse the original request's token but carry fresh message IDs,
 * so message-ID matching would drop every push.
 */
export class CoapSocket {
  private readonly socket: Socket
  private readonly handlers = new Map<string, (message: DecodedCoapMessage) => void>()
  /** Timeout + reject for each in-flight request/observe-subscribe, so close() can cancel them cleanly. */
  private readonly pending = new Map<string, { timer: ReturnType<typeof setTimeout>, reject: (error: Error) => void }>()
  /** onError callbacks for observations past their first response, notified on a socket-level error. */
  private readonly observers = new Map<string, (error: Error) => void>()
  private messageId: number
  private closed = false

  constructor(
    private readonly host: string,
    private readonly port: number = 5683,
  ) {
    this.messageId = randomInt(0, 0x10000)
    this.socket = createSocket('udp4')
    this.socket.on('message', buffer => this.dispatch(buffer))
    // A socket-level error must not become an unhandled exception. In-flight
    // requests still fail via their own timeouts; live observations get this
    // error pushed to onError so a dead network doesn't look like a quiet device.
    this.socket.on('error', error => {
      for (const onError of this.observers.values()) onError(error)
    })
    this.socket.unref()
  }

  /** Number of outstanding requests and live observations. Used by tests. */
  get pendingCount(): number {
    return this.handlers.size
  }

  private dispatch(buffer: Buffer): void {
    let message: DecodedCoapMessage
    try {
      message = decode(buffer)
    } catch {
      return // malformed datagram: ignore, never crash the socket
    }
    this.handlers.get(message.token.toString('hex'))?.(message)
  }

  private nextMessageId(): number {
    this.messageId = (this.messageId + 1) & 0xFFFF
    return this.messageId
  }

  private transmit(
    method: 'GET' | 'POST',
    path: string,
    token: Buffer,
    observeValue?: number,
    payload?: string | Buffer,
  ): void {
    if (this.closed) throw new Error('socket is closed')
    const options = uriPathOptions(path)
    if (observeValue !== undefined) {
      options.push({ number: CoapOption.Observe, value: uintToBuffer(observeValue) })
    }
    this.socket.send(encode({
      type: CoapType.NonConfirmable,
      code: method === 'POST' ? CoapCode.POST : CoapCode.GET,
      messageId: this.nextMessageId(),
      token,
      options,
      payload: payload === undefined ? undefined : Buffer.from(payload as string),
    }), this.port, this.host, error => {
      if (!error) return
      const key = token.toString('hex')
      const pending = this.pending.get(key)
      if (!pending) return
      clearTimeout(pending.timer)
      this.handlers.delete(key)
      this.pending.delete(key)
      pending.reject(error)
    })
  }

  /** One request, one response. */
  request(options: RequestOptions): Promise<DecodedCoapMessage> {
    const { method, path, payload, timeoutMs = DEFAULT_TIMEOUT_MS } = options
    return new Promise((resolve, reject) => {
      const token = randomBytes(4)
      const key = token.toString('hex')

      const timer = setTimeout(() => {
        this.handlers.delete(key)
        this.pending.delete(key)
        reject(new Error(`CoAP timeout after ${timeoutMs}ms for ${method} ${path}`))
      }, timeoutMs)
      this.pending.set(key, { timer, reject })

      this.handlers.set(key, message => {
        clearTimeout(timer)
        this.handlers.delete(key)
        this.pending.delete(key)
        resolve(message)
      })

      try {
        this.transmit(method, path, token, undefined, payload)
      } catch (error) {
        clearTimeout(timer)
        this.handlers.delete(key)
        this.pending.delete(key)
        reject(error as Error)
      }
    })
  }

  /** Register an observation. `onNotify` fires for every push after the first. */
  async observe(options: ObserveOptions): Promise<Observation> {
    const { path, onNotify, onError, timeoutMs = DEFAULT_TIMEOUT_MS } = options
    const token = randomBytes(4)
    const key = token.toString('hex')

    const first = await new Promise<DecodedCoapMessage>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.handlers.delete(key)
        this.pending.delete(key)
        reject(new Error(`CoAP observe timeout after ${timeoutMs}ms for ${path}`))
      }, timeoutMs)
      this.pending.set(key, { timer, reject })

      let settled = false
      this.handlers.set(key, message => {
        if (!settled) {
          settled = true
          clearTimeout(timer)
          this.pending.delete(key)
          // Only becomes "live" (eligible for onError) once subscribed.
          if (onError) this.observers.set(key, onError)
          resolve(message)
          return
        }
        onNotify(message)
      })

      try {
        this.transmit('GET', path, token, 0)
      } catch (error) {
        clearTimeout(timer)
        this.handlers.delete(key)
        this.pending.delete(key)
        reject(error as Error)
      }
    })

    return {
      first,
      cancel: () => {
        // Deregister the handler first so a push racing the cancellation is
        // dropped rather than delivered after the caller has stopped listening.
        this.handlers.delete(key)
        this.observers.delete(key)
        if (!this.closed) {
          try {
            this.transmit('GET', path, token, 1)
          } catch {
            // Socket already gone; the handler is removed either way.
          }
        }
      },
    }
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    for (const { timer, reject } of this.pending.values()) {
      clearTimeout(timer)
      reject(new Error('CoAP socket closed'))
    }
    this.pending.clear()
    this.handlers.clear()
    this.observers.clear()
    try {
      this.socket.close()
    } catch {
      // Already closed.
    }
  }
}
