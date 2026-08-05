import { describe, expect, it } from 'vitest'
import { RingBuffer } from './ringBuffer.js'

describe('RingBuffer', () => {
  it('returns everything it was given while under capacity', () => {
    const buffer = new RingBuffer(1024)
    buffer.append(Buffer.from('hello '))
    buffer.append(Buffer.from('world'))

    expect(buffer.contents().toString()).toBe('hello world')
    expect(buffer.truncated).toBe(false)
  })

  it('keeps the newest bytes when it overflows', () => {
    const buffer = new RingBuffer(10)
    buffer.append(Buffer.from('0123456789'))
    buffer.append(Buffer.from('abcde'))

    expect(buffer.contents().toString()).toBe('56789abcde')
  })

  it('reports truncation, so a reader knows the screen is partial', () => {
    const buffer = new RingBuffer(4)
    buffer.append(Buffer.from('12345'))

    expect(buffer.truncated).toBe(true)
  })

  it('handles a single chunk larger than the whole buffer', () => {
    const buffer = new RingBuffer(4)
    buffer.append(Buffer.from('abcdefgh'))

    expect(buffer.contents().toString()).toBe('efgh')
  })

  it('never exceeds its capacity across many small writes', () => {
    const buffer = new RingBuffer(8)
    for (let index = 0; index < 100; index += 1) {
      buffer.append(Buffer.from('xy'))
    }

    expect(buffer.contents()).toHaveLength(8)
  })

  it('starts empty', () => {
    expect(new RingBuffer(16).contents()).toHaveLength(0)
  })

  it('ignores empty writes', () => {
    const buffer = new RingBuffer(16)
    buffer.append(Buffer.alloc(0))

    expect(buffer.contents()).toHaveLength(0)
    expect(buffer.truncated).toBe(false)
  })
})
