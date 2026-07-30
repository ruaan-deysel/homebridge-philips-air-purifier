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
  /** Send the Observe option. Status reads need this even when one-shot. */
  observe?: boolean
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
  private messageId: number
  private closed = false

  constructor(
    private readonly host: string,
    private readonly port: number = 5683,
  ) {
    this.messageId = randomInt(0, 0x10000)
    this.socket = createSocket('udp4')
    this.socket.on('message', buffer => this.dispatch(buffer))
    // A socket-level error must not become an unhandled exception; pending
    // requests fail via their own timeouts.
    this.socket.on('error', () => {})
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
    }), this.port, this.host)
  }

  /** One request, one response. */
  request(options: RequestOptions): Promise<DecodedCoapMessage> {
    const { method, path, payload, observe = false, timeoutMs = DEFAULT_TIMEOUT_MS } = options
    return new Promise((resolve, reject) => {
      const token = randomBytes(4)
      const key = token.toString('hex')

      const timer = setTimeout(() => {
        this.handlers.delete(key)
        reject(new Error(`CoAP timeout after ${timeoutMs}ms for ${method} ${path}`))
      }, timeoutMs)

      this.handlers.set(key, message => {
        clearTimeout(timer)
        this.handlers.delete(key)
        resolve(message)
      })

      try {
        this.transmit(method, path, token, observe ? 0 : undefined, payload)
      } catch (error) {
        clearTimeout(timer)
        this.handlers.delete(key)
        reject(error as Error)
      }
    })
  }

  /** Register an observation. `onNotify` fires for every push after the first. */
  async observe(options: ObserveOptions): Promise<Observation> {
    const { path, onNotify, timeoutMs = DEFAULT_TIMEOUT_MS } = options
    const token = randomBytes(4)
    const key = token.toString('hex')

    const first = await new Promise<DecodedCoapMessage>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.handlers.delete(key)
        reject(new Error(`CoAP observe timeout after ${timeoutMs}ms for ${path}`))
      }, timeoutMs)

      let settled = false
      this.handlers.set(key, message => {
        if (!settled) {
          settled = true
          clearTimeout(timer)
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
        reject(error as Error)
      }
    })

    return {
      first,
      cancel: () => {
        // Deregister the handler first so a push racing the cancellation is
        // dropped rather than delivered after the caller has stopped listening.
        this.handlers.delete(key)
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
    this.handlers.clear()
    try {
      this.socket.close()
    } catch {
      // Already closed.
    }
  }
}
