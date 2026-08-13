import { useEffect, useRef, useState } from 'react'
import { cn } from '@/lib/utils'

/**
 * A vertical splitter between two columns.
 *
 * Dragging moves the seam; the parent owns min/max so this never decides how
 * wide is too wide. Double-click restores the default, the same way a window
 * edge snaps back when it is not worth remembering a one-off size.
 */

interface Props {
  /** Current column width, in pixels. */
  value: number
  min: number
  max: number
  defaultValue: number
  /** `end` sits on the right edge (nav); `start` on the left (workspace). */
  edge: 'start' | 'end'
  label: string
  onChange: (width: number) => void
}

export function ResizeHandle({ value, min, max, defaultValue, edge, label, onChange }: Props) {
  const drag = useRef<{ startX: number; startWidth: number } | null>(null)
  const [dragging, setDragging] = useState(false)

  useEffect(() => {
    if (!dragging) return
    const previous = document.body.style.cursor
    document.body.style.cursor = 'col-resize'
    return () => {
      document.body.style.cursor = previous
    }
  }, [dragging])

  const clamp = (next: number) => Math.min(max, Math.max(min, Math.round(next)))

  const widthFromPointer = (clientX: number, startX: number, startWidth: number) => {
    const delta = clientX - startX
    return clamp(edge === 'end' ? startWidth + delta : startWidth - delta)
  }

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuenow={Math.round(value)}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuetext={`${Math.round(value)} pixels`}
      tabIndex={0}
      data-dragging={dragging ? 'true' : undefined}
      onPointerDown={(event) => {
        if (event.button !== 0) return
        event.preventDefault()
        event.currentTarget.setPointerCapture(event.pointerId)
        drag.current = { startX: event.clientX, startWidth: value }
        setDragging(true)
      }}
      onPointerMove={(event) => {
        const origin = drag.current
        if (!origin) return
        onChange(widthFromPointer(event.clientX, origin.startX, origin.startWidth))
      }}
      onPointerUp={(event) => {
        if (event.currentTarget.hasPointerCapture(event.pointerId)) {
          event.currentTarget.releasePointerCapture(event.pointerId)
        }
        drag.current = null
        setDragging(false)
      }}
      onPointerCancel={() => {
        drag.current = null
        setDragging(false)
      }}
      onDoubleClick={() => onChange(clamp(defaultValue))}
      onKeyDown={(event) => {
        const step = event.shiftKey ? 24 : 8
        if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
          event.preventDefault()
          const direction = event.key === 'ArrowRight' ? 1 : -1
          const delta = edge === 'end' ? direction * step : -direction * step
          onChange(clamp(value + delta))
          return
        }
        if (event.key === 'Home') {
          event.preventDefault()
          onChange(min)
          return
        }
        if (event.key === 'End') {
          event.preventDefault()
          onChange(max)
        }
      }}
      className={cn(
        'absolute inset-y-0 z-20 w-2 cursor-col-resize touch-none',
        edge === 'end' ? '-right-1' : '-left-1',
        dragging ? 'bg-primary/40' : 'bg-transparent hover:bg-primary/25',
      )}
    />
  )
}
