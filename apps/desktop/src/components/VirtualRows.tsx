import { useVirtualizer } from '@tanstack/react-virtual'
import { Fragment, type ReactNode, type RefObject } from 'react'

/**
 * Window a long list against an existing scroller.
 *
 * Short lists render in full: jsdom has no viewport height, and a handful of
 * rows is cheaper to map than to virtualize. Past the threshold, only the
 * visible window (plus overscan) is mounted.
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
  const virtualize = count >= after
  const virtualizer = useVirtualizer({
    count: virtualize ? count : 0,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => estimateSize + gap,
    overscan,
    enabled: virtualize,
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
            transform: `translateY(${item.start}px)`,
            paddingBottom: gap > 0 ? `${gap}px` : undefined,
          }}
        >
          {children(item.index)}
        </div>
      ))}
    </div>
  )
}
