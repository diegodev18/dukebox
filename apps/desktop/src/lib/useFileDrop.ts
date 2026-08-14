import { useRef, useState, type DragEvent } from 'react'

/**
 * Drag-and-drop file attaching for the composer.
 *
 * A drag that does not carry files is left to the browser, so dropping text
 * into the field still works. A drag that does carry files is always
 * intercepted — even on a disabled composer, so the window never navigates
 * away on a stray drop. `dragenter`/`dragleave` fire for every child element
 * crossed, so a counter tracks how deep the pointer is and the highlight only
 * clears when it leaves the target for real.
 */
export function useFileDrop({
  disabled,
  onFiles,
}: {
  disabled: boolean
  onFiles: (files: File[]) => void
}) {
  const [dragging, setDragging] = useState(false)
  const depth = useRef(0)

  const carriesFiles = (event: DragEvent) => Array.from(event.dataTransfer.types).includes('Files')

  const onDragEnter = (event: DragEvent) => {
    if (!carriesFiles(event)) return
    event.preventDefault()
    if (disabled) return
    depth.current += 1
    setDragging(true)
  }

  const onDragOver = (event: DragEvent) => {
    if (!carriesFiles(event)) return
    event.preventDefault()
    event.dataTransfer.dropEffect = 'copy'
  }

  const onDragLeave = (event: DragEvent) => {
    event.preventDefault()
    depth.current = Math.max(0, depth.current - 1)
    if (depth.current === 0) setDragging(false)
  }

  const onDrop = (event: DragEvent) => {
    event.preventDefault()
    depth.current = 0
    setDragging(false)
    if (disabled) return
    const dropped = Array.from(event.dataTransfer.files ?? [])
    if (dropped.length > 0) onFiles(dropped)
  }

  return { dragging, onDragEnter, onDragOver, onDragLeave, onDrop }
}
