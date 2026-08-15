import { describe, it, expect } from 'vitest'
import { base64ToBytes } from './base64'

describe('base64ToBytes', () => {
  it('decodes a simple base64 string to its byte values', () => {
    // 'hello' -> [104, 101, 108, 108, 111]
    expect(Array.from(base64ToBytes('aGVsbG8='))).toEqual([104, 101, 108, 108, 111])
  })

  it('decodes a base64 string that needs no padding', () => {
    // 'abc' (3 bytes -> no '=' padding) -> [97, 98, 99]
    expect(Array.from(base64ToBytes('YWJj'))).toEqual([97, 98, 99])
  })

  it('decodes the empty string to an empty byte array', () => {
    expect(base64ToBytes('')).toEqual(new Uint8Array(0))
  })

  it('round-trips arbitrary byte values, including 0 and 255', () => {
    const original = new Uint8Array([0, 1, 127, 128, 255, 37])
    const base64 = btoa(String.fromCharCode(...original))
    expect(Array.from(base64ToBytes(base64))).toEqual(Array.from(original))
  })
})
