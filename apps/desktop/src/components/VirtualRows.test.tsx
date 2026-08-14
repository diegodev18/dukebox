import { createRef, type ReactElement, type RefObject } from 'react'
import { render } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { VirtualRows } from '@/components/VirtualRows'

type VirtualizerOptions = {
  count: number
  enabled: boolean
  estimateSize: () => number
  scrollMargin?: number
}

let lastScrollMargin: number | undefined

vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: (options: VirtualizerOptions) => {
    lastScrollMargin = options.scrollMargin
    return {
      options: { scrollMargin: options.scrollMargin ?? 0 },
      getTotalSize: () => (options.enabled ? options.count * options.estimateSize() : 0),
      getVirtualItems: () =>
        options.enabled
          ? Array.from({ length: Math.min(options.count, 4) }, (_, index) => ({
              key: index,
              index,
              start: index * options.estimateSize() + (options.scrollMargin ?? 0),
            }))
          : [],
      measureElement: () => undefined,
    }
  },
}))

describe('VirtualRows', () => {
  it('spaces a short list with the requested gap', () => {
    const scrollRef = createRef<HTMLDivElement>()

    const { container } = render(
      <div ref={scrollRef}>
        <VirtualRows count={3} scrollRef={scrollRef} estimateSize={20} gap={16}>
          {(index) => <div>row {index}</div>}
        </VirtualRows>
      </div>,
    )

    const list = container.querySelector('[data-virtual-list]')
    expect(list).toHaveStyle({ gap: '16px' })
  })

  it('puts the same gap on virtualized rows so they do not collapse', () => {
    const scrollRef = createRef<HTMLDivElement>()

    const { container } = render(
      <div ref={scrollRef} style={{ height: 240, overflow: 'auto' }}>
        <VirtualRows count={40} scrollRef={scrollRef} estimateSize={24} after={8} gap={16}>
          {(index) => <div>row {index}</div>}
        </VirtualRows>
      </div>,
    )

    const row = container.querySelector('[data-index]')
    expect(row).toBeTruthy()
    expect(row).toHaveStyle({ paddingBottom: '16px' })
  })

  it('keeps a later list aligned with the shared scroller', () => {
    const scrollRef = createRef<HTMLDivElement>()
    const view = render(offsetList(scrollRef, 40))

    const scroll = scrollRef.current!
    const list = view.container.querySelector('[data-virtual-list]') as HTMLElement
    vi.spyOn(scroll, 'getBoundingClientRect').mockReturnValue(box(10))
    vi.spyOn(list, 'getBoundingClientRect').mockReturnValue(box(250))
    Object.defineProperty(scroll, 'scrollTop', { configurable: true, value: 40 })

    // Remeasure after the list's offset inside the scroller is known.
    view.rerender(offsetList(scrollRef, 41))

    // 250 (list) - 10 (scroller) + 40 (already scrolled).
    expect(lastScrollMargin).toBe(280)
    const row = view.container.querySelector('[data-index]')
    expect(row).toHaveStyle({ transform: 'translateY(0px)' })
  })
})

function offsetList(scrollRef: RefObject<HTMLDivElement | null>, count: number): ReactElement {
  return (
    <div ref={scrollRef} className="overflow-auto" style={{ height: 240, overflow: 'auto' }}>
      <div style={{ height: 180 }} />
      <VirtualRows count={count} scrollRef={scrollRef} estimateSize={20} after={8}>
        {(index) => <div>row {index}</div>}
      </VirtualRows>
    </div>
  )
}

function box(top: number): DOMRect {
  return {
    x: 0,
    y: top,
    top,
    bottom: top + 20,
    left: 0,
    right: 100,
    width: 100,
    height: 20,
    toJSON() {
      return this
    },
  }
}
