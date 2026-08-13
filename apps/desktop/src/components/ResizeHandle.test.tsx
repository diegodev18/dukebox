import { fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { ResizeHandle } from '@/components/ResizeHandle'

if (!Element.prototype.setPointerCapture) {
  Element.prototype.setPointerCapture = () => undefined
}
if (!Element.prototype.releasePointerCapture) {
  Element.prototype.releasePointerCapture = () => undefined
}
if (!Element.prototype.hasPointerCapture) {
  Element.prototype.hasPointerCapture = () => false
}

function Harness({
  edge = 'end',
  initial = 236,
  max = 400,
}: {
  edge?: 'start' | 'end'
  initial?: number
  max?: number
}) {
  const [width, setWidth] = useState(initial)
  return (
    <div data-testid="width">
      {width}
      <ResizeHandle
        value={width}
        min={196}
        max={max}
        defaultValue={236}
        edge={edge}
        label="Resize sessions"
        onChange={setWidth}
      />
    </div>
  )
}

describe('ResizeHandle', () => {
  it('grows the nav when the seam is dragged right', () => {
    render(<Harness />)
    const handle = screen.getByRole('separator', { name: 'Resize sessions' })

    fireEvent.pointerDown(handle, { clientX: 236, pointerId: 1, button: 0 })
    fireEvent.pointerMove(handle, { clientX: 300, pointerId: 1 })
    fireEvent.pointerUp(handle, { pointerId: 1 })

    expect(screen.getByTestId('width')).toHaveTextContent('300')
    expect(handle).toHaveAttribute('aria-valuenow', '300')
  })

  it('grows the workspace when its left seam is dragged left', () => {
    render(<Harness edge="start" initial={400} max={640} />)
    const handle = screen.getByRole('separator', { name: 'Resize sessions' })

    fireEvent.pointerDown(handle, { clientX: 400, pointerId: 1, button: 0 })
    fireEvent.pointerMove(handle, { clientX: 300, pointerId: 1 })
    fireEvent.pointerUp(handle, { pointerId: 1 })

    expect(screen.getByTestId('width')).toHaveTextContent('500')
  })

  it('does not pass the max width', () => {
    render(<Harness />)
    const handle = screen.getByRole('separator', { name: 'Resize sessions' })

    fireEvent.pointerDown(handle, { clientX: 236, pointerId: 1, button: 0 })
    fireEvent.pointerMove(handle, { clientX: 900, pointerId: 1 })
    fireEvent.pointerUp(handle, { pointerId: 1 })

    expect(screen.getByTestId('width')).toHaveTextContent('400')
  })

  it('moves the seam with the arrow keys', () => {
    render(<Harness />)
    const handle = screen.getByRole('separator', { name: 'Resize sessions' })
    handle.focus()

    fireEvent.keyDown(handle, { key: 'ArrowRight' })
    expect(screen.getByTestId('width')).toHaveTextContent('244')

    fireEvent.keyDown(handle, { key: 'ArrowLeft' })
    expect(screen.getByTestId('width')).toHaveTextContent('236')
  })

  it('restores the default on double-click', () => {
    const onChange = vi.fn()
    render(
      <ResizeHandle
        value={320}
        min={196}
        max={400}
        defaultValue={236}
        edge="end"
        label="Resize sessions"
        onChange={onChange}
      />,
    )

    fireEvent.doubleClick(screen.getByRole('separator', { name: 'Resize sessions' }))
    expect(onChange).toHaveBeenCalledWith(236)
  })
})
