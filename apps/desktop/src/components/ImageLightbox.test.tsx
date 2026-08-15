import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ImageLightbox } from '@/components/ImageLightbox'

const src = 'data:image/png;base64,QUFB'
const alt = 'a screenshot'
const onDismiss = vi.fn()

class MockClipboardItem {
  constructor(public data: Record<string, Blob>) {}
}

beforeEach(() => {
  onDismiss.mockClear()
  Object.assign(globalThis, { ClipboardItem: MockClipboardItem })
  Object.assign(navigator, { clipboard: { write: vi.fn().mockResolvedValue(undefined) } })
  URL.createObjectURL = vi.fn(() => 'blob:mock-url')
  URL.revokeObjectURL = vi.fn()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('ImageLightbox', () => {
  it('shows the image at full size in a dialog', () => {
    render(<ImageLightbox src={src} alt={alt} onDismiss={onDismiss} />)

    const dialog = screen.getByRole('dialog', { name: alt })
    expect(dialog).toContainElement(screen.getByRole('img', { name: alt }))
    expect(screen.getByRole('button', { name: 'Copy image' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Save image' })).toBeInTheDocument()
  })

  it('closes on the close button', async () => {
    render(<ImageLightbox src={src} alt={alt} onDismiss={onDismiss} />)

    await userEvent.click(screen.getByRole('button', { name: 'Close image' }))
    expect(onDismiss).toHaveBeenCalled()
  })

  it('closes on Escape', async () => {
    render(<ImageLightbox src={src} alt={alt} onDismiss={onDismiss} />)

    await userEvent.keyboard('{Escape}')
    expect(onDismiss).toHaveBeenCalled()
  })

  it('closes when the backdrop is clicked', async () => {
    render(<ImageLightbox src={src} alt={alt} onDismiss={onDismiss} />)

    const backdrop = screen.getByRole('dialog').parentElement!
    await userEvent.click(backdrop)
    expect(onDismiss).toHaveBeenCalled()
  })

  it('copies the image itself to the clipboard', async () => {
    render(<ImageLightbox src={src} alt={alt} onDismiss={onDismiss} />)

    await userEvent.click(screen.getByRole('button', { name: 'Copy image' }))

    const clipboard = navigator.clipboard as unknown as { write: ReturnType<typeof vi.fn> }
    expect(clipboard.write).toHaveBeenCalledTimes(1)
    const [item] = clipboard.write.mock.calls[0]![0] as { data: Record<string, Blob> }[]
    expect(item.data['image/png']).toBeInstanceOf(Blob)
    expect(screen.getByRole('button', { name: 'Copied' })).toBeInTheDocument()
  })

  it('saves the image as a download', async () => {
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    render(<ImageLightbox src={src} alt={alt} name="shot.png" onDismiss={onDismiss} />)

    await userEvent.click(screen.getByRole('button', { name: 'Save image' }))

    expect(click).toHaveBeenCalledTimes(1)
    const anchor = click.mock.instances[0] as HTMLAnchorElement
    expect(anchor.download).toBe('shot.png')
    expect(URL.createObjectURL).toHaveBeenCalledTimes(1)
  })
})
