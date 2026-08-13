import { createRef } from 'react'
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { LineWidthSizer, VirtualRows, longestLine } from '@/components/VirtualRows'

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

  it('sizes an in-flow box to the longest line', () => {
    const { container } = render(
      <LineWidthSizer
        text={'x'.repeat(80)}
        gutter={<span data-testid="gutter" style={{ width: '4ch' }} />}
      />,
    )

    const sizer = container.querySelector('[data-line-width-sizer]')
    expect(sizer).toHaveAttribute('aria-hidden', 'true')
    expect(sizer).toHaveTextContent('x'.repeat(80))
    expect(screen.getByTestId('gutter')).toBeInTheDocument()
    expect(longestLine(['ab', 'abcdefgh', 'cd'])).toBe('abcdefgh')
  })
})
