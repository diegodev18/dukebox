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
  children: (index: number) => ReactNode
}

export function VirtualRows({
  count,
  scrollRef,
  estimateSize,
  overscan = 8,
  after = DEFAULT_VIRTUALIZE_AFTER,
  wide = false,
  children,
}: Props) {
  const virtualize = count >= after
  const virtualizer = useVirtualizer({
    count: virtualize ? count : 0,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => estimateSize,
    overscan,
    enabled: virtualize,
  })

  if (!virtualize) {
    return (
      <>
        {Array.from({ length: count }, (_, index) => (
          <Fragment key={index}>{children(index)}</Fragment>
        ))}
      </>
    )
  }

  return (
    <div
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
          }}
        >
          {children(item.index)}
        </div>
      ))}
    </div>
  )
}
