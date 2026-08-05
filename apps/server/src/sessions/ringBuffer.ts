/**
 * The last N bytes written to it.
 *
 * Terminal scrollback has to be capped somewhere: an accidental `yes` produces
 * megabytes a second, and a buffer that grows with it makes control-plane
 * memory hostage to whatever someone types. A fixed cap makes the worst case
 * knowable instead.
 */
export class RingBuffer {
  private chunks: Buffer[] = []
  private size = 0
  private overflowed = false

  constructor(private readonly capacityBytes: number) {}

  append(chunk: Buffer): void {
    if (chunk.length === 0) return

    this.chunks.push(chunk)
    this.size += chunk.length

    if (this.size <= this.capacityBytes) return

    this.overflowed = true

    // Whole chunks are dropped first and only the one straddling the boundary
    // is sliced. Concatenating on every append would be quadratic against a
    // stream arriving as thousands of small writes, which is what a PTY is.
    while (this.chunks.length > 0 && this.size - this.chunks[0]!.length >= this.capacityBytes) {
      this.size -= this.chunks.shift()!.length
    }

    const excess = this.size - this.capacityBytes
    if (excess > 0 && this.chunks.length > 0) {
      this.chunks[0] = this.chunks[0]!.subarray(excess)
      this.size -= excess
    }
  }

  contents(): Buffer {
    return Buffer.concat(this.chunks)
  }

  /** Whether anything has been dropped. A reattached screen is partial. */
  get truncated(): boolean {
    return this.overflowed
  }
}
