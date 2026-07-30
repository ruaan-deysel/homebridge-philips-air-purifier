import { describe, expect, it } from 'vitest'
import { DigestMismatchError, decrypt, deriveKeyAndIv, encrypt, nextKey } from '../src/airctrl/crypto.js'

describe('nextKey', () => {
  // Python: (int(k, 16) + 1) & 0xFFFFFFFF, formatted as 4 big-endian bytes.
  // JS `&` is SIGNED 32-bit and returns -80000000 for the first case.
  it.each([
    ['0DC377BA', '0DC377BB'],
    ['0000000F', '00000010'],
    ['7FFFFFFF', '80000000'], // regression: signed AND breaks here
    ['80000000', '80000001'], // regression: signed AND breaks here
    ['FFFFFFFF', '00000000'], // wraps to zero
  ])('increments %s to %s', (input, expected) => {
    expect(nextKey(input)).toBe(expected)
  })
})

describe('deriveKeyAndIv', () => {
  it('derives key and IV from MD5("JiangPan" + clientKey)', () => {
    const { key, iv } = deriveKeyAndIv('0DC377BA')
    // MD5("JiangPan0DC377BA") = 58C810828608D8F6E4C37DBC8DAC1FC9
    expect(key.toString('ascii')).toBe('58C810828608D8F6')
    expect(iv.toString('ascii')).toBe('E4C37DBC8DAC1FC9')
  })
})

describe('encrypt / decrypt', () => {
  it('round-trips a JSON payload', () => {
    const payload = JSON.stringify({ state: { desired: { D03102: 1 } } })
    expect(decrypt(encrypt('0DC377BA', payload))).toBe(payload)
  })

  it('produces key + ciphertext + 64-char digest, all uppercase hex', () => {
    const blob = encrypt('0DC377BA', '{"test":1}')
    expect(blob.slice(0, 8)).toBe('0DC377BA')
    expect(blob).toHaveLength(8 + 32 + 64) // 10 bytes padded to 32 hex chars
    expect(blob).toBe(blob.toUpperCase())
  })

  it('throws DigestMismatchError when the digest is tampered with', () => {
    const blob = encrypt('0DC377BA', '{"test":1}')
    const tampered = `${blob.slice(0, -1)}${blob.at(-1) === '0' ? '1' : '0'}`
    expect(() => decrypt(tampered)).toThrow(DigestMismatchError)
  })
})
