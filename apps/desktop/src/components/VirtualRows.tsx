import { useVirtualizer } from '@tanstack/react-virtual'
import { Fragment, useLayoutEffect, useState, type ReactNode, type RefObject } from 'react'

/**
 * Window a long list against an existing scroller.
 *
 * Virtualizing before the scroller has a height paints an empty window — the
 * library cannot choose a visible range, so it mounts nothing. Short lists,
 * jsdom, and the first layout pass therefore render in full.
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
   * Space between windowed rows, in pixels.
   *
   * Matches the flex `gap` the list has before it virtualizes. Absolute rows
   * do not participate in that gap, so without this a stack of tool cards
   * fuses into one block the moment the viewport is measured.
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
  const [viewport, setViewport] = useState(0)

  useLayoutEffect(() => {
    let frame: number | null = null
    let observer: ResizeObserver | null = null

    const attach = (element: HTMLElement) => {
      const sync = () => setViewport(element.clientHeight)
      sync()
      if (typeof ResizeObserver === 'undefined') return
      observer = new ResizeObserver(sync)
      observer.observe(element)
    }

    const element = scrollRef.current
    if (element) {
      attach(element)
    } else {
      // The scroller's ref is often on an ancestor. Child layout effects run
      // before that host ref is attached, so try once more after paint.
      frame = requestAnimationFrame(() => {
        frame = null
        const next = scrollRef.current
        if (next) attach(next)
      })
    }

    return () => {
      if (frame != null) cancelAnimationFrame(frame)
      observer?.disconnect()
    }
  }, [scrollRef, count])

  const virtualize = count >= after && viewport > 0
  const virtualizer = useVirtualizer({
    count: virtualize ? count : 0,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => estimateSize + gap,
    overscan,
    enabled: virtualize,
  })

  const virtualItems = virtualizer.getVirtualItems()
  const windowed = virtualize && virtualItems.length > 0

  useLayoutEffect(() => {
    if (!windowed) return
    const element = scrollRef.current
    if (!element) return
    const distance = element.scrollHeight - element.scrollTop - element.clientHeight
    if (distance < 80) element.scrollTop = element.scrollHeight
  }, [windowed, count, scrollRef])

  if (!windowed) {
    const rows = Array.from({ length: count }, (_, index) => (
      <Fragment key={index}>{children(index)}</Fragment>
    ))
    if (gap <= 0) return <>{rows}</>
    return (
      <div className="flex flex-col" style={{ gap: `${gap}px` }}>
        {rows}
      </div>
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
      {virtualItems.map((item) => (
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
            paddingBottom: gap > 0 ? `${gap}px` : undefined,
            transform: `translateY(${item.start}px)`,
          }}
        >
          {children(item.index)}
        </div>
      ))}
    </div>
  )
}
