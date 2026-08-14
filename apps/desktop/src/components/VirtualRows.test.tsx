import { createRef } from 'react'
import { render } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { VirtualRows } from '@/components/VirtualRows'

vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: (options: { count: number; enabled: boolean; estimateSize: () => number }) => ({
    getTotalSize: () => (options.enabled ? options.count * options.estimateSize() : 0),
    getVirtualItems: () =>
      options.enabled
        ? Array.from({ length: Math.min(options.count, 4) }, (_, index) => ({
            key: index,
            index,
            start: index * options.estimateSize(),
          }))
        : [],
    measureElement: () => undefined,
  }),
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
})
