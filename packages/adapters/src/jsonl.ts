/**
 * Line-delimited JSON reading over a byte stream.
 *
 * Agents emit one JSON object per line, but a stream chunk has nothing to do
 * with line boundaries: a single object can arrive split across several
 * chunks, and one chunk can carry several objects. Parsing chunks directly
 * would corrupt any message large enough to be interesting — which is exactly
 * the ones carrying file contents.
 */

export interface JsonlReaderOptions {
  /**
   * Called for a line that is not valid JSON.
   *
   * Malformed lines are reported and skipped rather than thrown, because a
   * single bad line should not take down a session that is otherwise fine.
   * Agents also write occasional non-JSON noise to stdout.
   */
  onMalformed?: (line: string, error: unknown) => void
}

/** Incremental parser. Feed it chunks, get back complete objects. */
export class JsonlReader {
  private buffer = ''

  constructor(private readonly options: JsonlReaderOptions = {}) {}

  /** Parse whatever complete lines this chunk completes. */
  push(chunk: string): unknown[] {
    this.buffer += chunk

    const parsed: unknown[] = []
    let newlineIndex = this.buffer.indexOf('\n')

    while (newlineIndex !== -1) {
      const line = this.buffer.slice(0, newlineIndex)
      this.buffer = this.buffer.slice(newlineIndex + 1)

      const value = this.parseLine(line)
      if (value !== undefined) parsed.push(value)

      newlineIndex = this.buffer.indexOf('\n')
    }

    return parsed
  }

  /**
   * Parse whatever is left when the stream ends.
   *
   * A stream can end without a trailing newline — normally when the process
   * was killed mid-write. Any complete object still in the buffer is worth
   * keeping; an incomplete one is reported as malformed.
   */
  flush(): unknown[] {
    if (this.buffer.trim() === '') {
      this.buffer = ''
      return []
    }

    const value = this.parseLine(this.buffer)
    this.buffer = ''
    return value === undefined ? [] : [value]
  }

  private parseLine(line: string): unknown {
    const trimmed = line.trim()
    if (trimmed === '') return undefined

    try {
      return JSON.parse(trimmed)
    } catch (error) {
      this.options.onMalformed?.(trimmed, error)
      return undefined
    }
  }
}

/** Read an async byte stream as a stream of parsed JSON values. */
export async function* readJsonl(
  source: AsyncIterable<Buffer | string>,
  options: JsonlReaderOptions = {},
): AsyncGenerator<unknown> {
  const reader = new JsonlReader(options)

  for await (const chunk of source) {
    for (const value of reader.push(chunk.toString())) {
      yield value
    }
  }

  for (const value of reader.flush()) {
    yield value
  }
}
