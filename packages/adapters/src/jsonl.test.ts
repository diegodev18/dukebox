import { describe, expect, it, vi } from 'vitest'
import { JsonlReader, readJsonl } from '@/jsonl'

describe('JsonlReader', () => {
  it('parses one object per line', () => {
    const reader = new JsonlReader()
    expect(reader.push('{"a":1}\n{"b":2}\n')).toEqual([{ a: 1 }, { b: 2 }])
  })

  it('holds back a line until its newline arrives', () => {
    const reader = new JsonlReader()

    expect(reader.push('{"a":1}')).toEqual([])
    expect(reader.push('\n')).toEqual([{ a: 1 }])
  })

  it('reassembles an object split across chunks', () => {
    const reader = new JsonlReader()

    // The case that matters: a message carrying file contents is far larger
    // than one stream chunk, so it always arrives in pieces.
    expect(reader.push('{"type":"assis')).toEqual([])
    expect(reader.push('tant","text":"hel')).toEqual([])
    expect(reader.push('lo"}\n')).toEqual([{ type: 'assistant', text: 'hello' }])
  })

  it('parses several objects from a single chunk', () => {
    const reader = new JsonlReader()
    expect(reader.push('{"a":1}\n{"b":2}\n{"c":3}\n')).toEqual([{ a: 1 }, { b: 2 }, { c: 3 }])
  })

  it('carries a partial trailing line into the next chunk', () => {
    const reader = new JsonlReader()

    expect(reader.push('{"a":1}\n{"b":')).toEqual([{ a: 1 }])
    expect(reader.push('2}\n')).toEqual([{ b: 2 }])
  })

  it('ignores blank lines', () => {
    const reader = new JsonlReader()
    expect(reader.push('\n\n{"a":1}\n\n')).toEqual([{ a: 1 }])
  })

  it('handles \\r\\n line endings', () => {
    const reader = new JsonlReader()
    expect(reader.push('{"a":1}\r\n')).toEqual([{ a: 1 }])
  })

  it('preserves newlines inside string values', () => {
    const reader = new JsonlReader()
    // The newline here is escaped, so it is data rather than a line break.
    expect(reader.push('{"text":"line one\\nline two"}\n')).toEqual([
      { text: 'line one\nline two' },
    ])
  })

  describe('malformed input', () => {
    it('skips a bad line and keeps going', () => {
      const onMalformed = vi.fn()
      const reader = new JsonlReader({ onMalformed })

      // One bad line must not cost us the rest of the session.
      const result = reader.push('{"a":1}\nnot json\n{"b":2}\n')

      expect(result).toEqual([{ a: 1 }, { b: 2 }])
      expect(onMalformed).toHaveBeenCalledOnce()
      expect(onMalformed.mock.calls[0]?.[0]).toBe('not json')
    })

    it('reports the line and the parse error', () => {
      const onMalformed = vi.fn()
      new JsonlReader({ onMalformed }).push('{"broken":\n')

      expect(onMalformed).toHaveBeenCalledWith('{"broken":', expect.any(Error))
    })

    it('does not require a handler', () => {
      const reader = new JsonlReader()
      expect(() => reader.push('garbage\n')).not.toThrow()
    })
  })

  describe('flush', () => {
    it('returns a complete object left without a trailing newline', () => {
      const reader = new JsonlReader()

      // A process killed mid-stream can leave a finished object unterminated.
      reader.push('{"a":1}')
      expect(reader.flush()).toEqual([{ a: 1 }])
    })

    it('reports an incomplete object as malformed', () => {
      const onMalformed = vi.fn()
      const reader = new JsonlReader({ onMalformed })

      reader.push('{"a":')
      expect(reader.flush()).toEqual([])
      expect(onMalformed).toHaveBeenCalledOnce()
    })

    it('returns nothing for an empty buffer', () => {
      expect(new JsonlReader().flush()).toEqual([])
    })

    it('empties the buffer, so a second flush yields nothing', () => {
      const reader = new JsonlReader()
      reader.push('{"a":1}')

      expect(reader.flush()).toEqual([{ a: 1 }])
      expect(reader.flush()).toEqual([])
    })
  })
})

describe('readJsonl', () => {
  async function* chunks(...values: string[]) {
    for (const value of values) yield value
  }

  it('yields objects across chunk boundaries', async () => {
    const source = chunks('{"a":1}\n{"b"', ':2}\n{"c":3}\n')

    const results = []
    for await (const value of readJsonl(source)) results.push(value)

    expect(results).toEqual([{ a: 1 }, { b: 2 }, { c: 3 }])
  })

  it('yields a final object with no trailing newline', async () => {
    const results = []
    for await (const value of readJsonl(chunks('{"a":1}'))) results.push(value)

    expect(results).toEqual([{ a: 1 }])
  })

  it('accepts Buffers as well as strings', async () => {
    async function* buffers() {
      yield Buffer.from('{"a":1}\n')
    }

    const results = []
    for await (const value of readJsonl(buffers())) results.push(value)

    expect(results).toEqual([{ a: 1 }])
  })

  it('ends cleanly on an empty stream', async () => {
    const results = []
    for await (const value of readJsonl(chunks())) results.push(value)

    expect(results).toEqual([])
  })
})
