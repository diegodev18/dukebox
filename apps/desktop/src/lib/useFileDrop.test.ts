import { describe, expect, it } from 'vitest'
import {
  dataTransferHasFiles,
  filesFromPaste,
  preventWindowFileNavigation,
} from '@/lib/useFileDrop'

describe('dataTransferHasFiles', () => {
  it('accepts the Files type Chrome and WebKit announce', () => {
    expect(dataTransferHasFiles({ types: ['Files'] } as unknown as DataTransfer)).toBe(true)
  })

  it('accepts Firefox application/x-moz-file', () => {
    expect(
      dataTransferHasFiles({ types: ['application/x-moz-file'] } as unknown as DataTransfer),
    ).toBe(true)
  })

  it('rejects a text-only drag', () => {
    expect(
      dataTransferHasFiles({ types: ['text/plain'], items: [] } as unknown as DataTransfer),
    ).toBe(false)
  })
})

describe('filesFromPaste', () => {
  it('reads files off the clipboard', () => {
    const file = new File(['x'], 'image.png', { type: 'image/png' })
    expect(filesFromPaste({ files: [file], items: [] } as unknown as DataTransfer)).toEqual([file])
  })

  it('falls back to items when files is empty', () => {
    const file = new File(['x'], 'image.png', { type: 'image/png' })
    expect(
      filesFromPaste({
        files: [],
        items: [{ kind: 'file', getAsFile: () => file }],
      } as unknown as DataTransfer),
    ).toEqual([file])
  })
})

describe('preventWindowFileNavigation', () => {
  it('prevents the default drop so the window does not navigate to the file', () => {
    const stop = preventWindowFileNavigation()
    const event = new Event('drop', { cancelable: true, bubbles: true })
    Object.defineProperty(event, 'dataTransfer', { value: { types: ['Files'] } })

    window.dispatchEvent(event)

    expect(event.defaultPrevented).toBe(true)
    stop()
  })

  it('leaves a text drop alone so the field can still receive it', () => {
    const stop = preventWindowFileNavigation()
    const event = new Event('drop', { cancelable: true, bubbles: true })
    Object.defineProperty(event, 'dataTransfer', {
      value: { types: ['text/plain'], items: [] },
    })

    window.dispatchEvent(event)

    expect(event.defaultPrevented).toBe(false)
    stop()
  })
})
