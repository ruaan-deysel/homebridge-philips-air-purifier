import { createCipheriv, createDecipheriv, createHash } from 'node:crypto'

/**
 * Fixed secret baked into Philips firmware. Not a security choice this plugin
 * makes — the device will not talk to us without it.
 */
const SECRET_KEY = 'JiangPan'

export class DigestMismatchError extends Error {
  constructor(expected: string, actual: string) {
    super(`payload digest mismatch: expected ${expected}, computed ${actual}`)
    this.name = 'DigestMismatchError'
  }
}

/**
 * The device derives both key and IV from one MD5 hash, then uses the ASCII
 * bytes of the hex digits (not the raw hash bytes) as AES material.
 */
export function deriveKeyAndIv(clientKey: string): { key: Buffer, iv: Buffer } {
  const digest = createHash('md5').update(SECRET_KEY + clientKey).digest('hex').toUpperCase()
  return {
    key: Buffer.from(digest.slice(0, 16), 'ascii'),
    iv: Buffer.from(digest.slice(16), 'ascii'),
  }
}

/**
 * Increment the rolling client key, wrapping at 32 bits.
 *
 * Uses `>>> 0`, NOT `& 0xFFFFFFFF`. JavaScript's bitwise AND operates on SIGNED
 * 32-bit integers, so `0x80000000 & 0xFFFFFFFF` is -2147483648 and formats as
 * "-80000000". Since sync keys are random, roughly half of all sessions would
 * eventually cross this boundary and corrupt every later control write.
 */
export function nextKey(clientKey: string): string {
  const incremented = (Number.parseInt(clientKey, 16) + 1) >>> 0
  return incremented.toString(16).padStart(8, '0').toUpperCase()
}

/** Build the wire payload: clientKey + ciphertextHex + sha256(clientKey + ciphertextHex). */
export function encrypt(clientKey: string, payload: string): string {
  const { key, iv } = deriveKeyAndIv(clientKey)
  const cipher = createCipheriv('aes-128-cbc', key, iv) // PKCS7 padding is the default
  const ciphertext = Buffer
    .concat([cipher.update(payload, 'utf8'), cipher.final()])
    .toString('hex')
    .toUpperCase()
  const digest = createHash('sha256').update(clientKey + ciphertext).digest('hex').toUpperCase()
  return clientKey + ciphertext + digest
}

/** Verify the digest and decrypt. The key travels in the payload's first 8 chars. */
export function decrypt(blob: string): string {
  const clientKey = blob.slice(0, 8)
  const ciphertext = blob.slice(8, -64)
  const digest = blob.slice(-64)
  const computed = createHash('sha256').update(clientKey + ciphertext).digest('hex').toUpperCase()
  if (digest !== computed) throw new DigestMismatchError(digest, computed)

  const { key, iv } = deriveKeyAndIv(clientKey)
  const decipher = createDecipheriv('aes-128-cbc', key, iv)
  return Buffer.concat([decipher.update(Buffer.from(ciphertext, 'hex')), decipher.final()]).toString('utf8')
}
