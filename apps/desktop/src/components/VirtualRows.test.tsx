import { createRef } from 'react'
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { VirtualRows } from '@/components/VirtualRows'

describe('VirtualRows', () => {
  it('renders every row when the scroller has no height', () => {
    const scrollRef = createRef<HTMLDivElement>()

    render(
      <div ref={scrollRef} className="overflow-auto">
        <VirtualRows count={50} scrollRef={scrollRef} estimateSize={20} after={10}>
          {(index) => <div>Row {index}</div>}
        </VirtualRows>
      </div>,
    )

    expect(screen.getByText('Row 0')).toBeInTheDocument()
    expect(screen.getByText('Row 49')).toBeInTheDocument()
  })

  it('keeps a list gap so stacked cards do not fuse', () => {
    const scrollRef = createRef<HTMLDivElement>()

    const { container } = render(
      <div ref={scrollRef} className="overflow-auto">
        <VirtualRows count={8} scrollRef={scrollRef} estimateSize={20} after={40} gap={16}>
          {(index) => <div>Row {index}</div>}
        </VirtualRows>
      </div>,
    )

    expect(container.querySelector('.flex.flex-col')).toHaveStyle({ gap: '16px' })
  })
})
