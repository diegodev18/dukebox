import { useVirtualizer } from '@tanstack/react-virtual'
import { Fragment, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react'

/**
 * Window a long list against an existing scroller.
 *
 * Short lists render in full: jsdom has no viewport height, and a handful of
 * rows is cheaper to map than to virtualize. Past the threshold, only the
 * visible window (plus overscan) is mounted.
 *
 * Several diffs share one scroller. The virtualizer treats scrollTop as an
 * offset into this list, so a file that starts further down must declare how
 * far. Without that, scrolling past the first file unmounts the next file's
 * lines.
 */

export const DEFAULT_VIRTUALIZE_AFTER = 40

interface Props {
  count: number
  scrollRef: RefObject<HTMLElement | null>
  estimateSize: number
  overscan?: number
  /** Virtualize once the list is at least this long. */
  after?: number
  /** Size items to their content width (diffs), not the scroller. */
  wide?: boolean
  /**
   * Space between rows, in pixels.
   *
   * Flex `gap` on the parent is ignored once rows are absolutely positioned,
   * so the list has to carry the same spacing in both modes.
   */
  gap?: number
  children: (index: number) => ReactNode
}

export function VirtualRows({
  count,
  scrollRef,
  estimateSize,
  overscan = 8,
  after = DEFAULT_VIRTUALIZE_AFTER,
  wide = false,
  gap = 0,
  children,
}: Props) {
  const listRef = useRef<HTMLDivElement>(null)
  const [scrollMargin, setScrollMargin] = useState(0)
  const virtualize = count >= after

  useLayoutEffect(() => {
    if (!virtualize) return
    const list = listRef.current
    if (!list) return
    const found = list.closest('.overflow-auto')
    const scroll = scrollRef.current ?? (found instanceof HTMLElement ? found : null)
    if (!scroll) return

    const measure = () => {
      const next =
        list.getBoundingClientRect().top - scroll.getBoundingClientRect().top + scroll.scrollTop
      setScrollMargin((current) => (Math.abs(current - next) < 0.5 ? current : next))
    }

    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(scroll)
    const content = scroll.firstElementChild
    if (content) observer.observe(content)
    return () => observer.disconnect()
  }, [virtualize, count, scrollRef])

  const virtualizer = useVirtualizer({
    count: virtualize ? count : 0,
    getScrollElement: () => {
      if (scrollRef.current) return scrollRef.current
      const found = listRef.current?.closest('.overflow-auto')
      return found instanceof HTMLElement ? found : null
    },
    estimateSize: () => estimateSize + gap,
    overscan,
    enabled: virtualize,
    scrollMargin,
  })

  if (!virtualize) {
    const rows = Array.from({ length: count }, (_, index) => (
      <Fragment key={index}>{children(index)}</Fragment>
    ))

    // No wrapper when there is no gap: diffs and file views size themselves
    // to the longest line, and an extra block box would stop that.
    if (gap <= 0) return <>{rows}</>

    return (
      <div data-virtual-list style={{ display: 'flex', flexDirection: 'column', gap: `${gap}px` }}>
        {rows}
      </div>
    )
  }

  return (
    <div
      ref={listRef}
      data-virtual-list
      style={{
        height: `${virtualizer.getTotalSize()}px`,
        width: wide ? 'max-content' : '100%',
        minWidth: '100%',
        position: 'relative',
      }}
    >
      {virtualizer.getVirtualItems().map((item) => (
        <div
          key={item.key}
          data-index={item.index}
          ref={virtualizer.measureElement}
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            width: wide ? 'max-content' : '100%',
            minWidth: '100%',
            transform: `translateY(${item.start - virtualizer.options.scrollMargin}px)`,
            paddingBottom: gap > 0 ? `${gap}px` : undefined,
          }}
        >
          {children(item.index)}
        </div>
      ))}
    </div>
  )
}
