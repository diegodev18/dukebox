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
 *
 * Browsers disagree about how a file drag announces itself, so `carriesFiles`
 * accepts every signal: the "Files" type Chrome/WebKit put in `types`, the
 * "application/x-moz-file" type Firefox uses instead, and the `kind: 'file'`
 * entries in `items` that some Chromium drags expose even when the type is
 * missing. Enumeration is allowed in the protected drag-store mode of
 * `dragenter`/`dragover`, so `items` can be read there.
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

  const carriesFiles = (event: DragEvent): boolean => {
    const dataTransfer = event.dataTransfer
    if (!dataTransfer) return false

    const types = Array.from(dataTransfer.types ?? []).map((type) => type.toLowerCase())
    if (types.includes('files') || types.includes('application/x-moz-file')) return true

    return Array.from(dataTransfer.items ?? []).some((item) => item.kind === 'file')
  }

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

  const readFiles = (event: DragEvent): File[] => {
    const dataTransfer = event.dataTransfer
    if (!dataTransfer) return []

    const dropped = Array.from(dataTransfer.files ?? [])
    if (dropped.length > 0) return dropped

    // Some engines leave `files` empty on drop but expose each file as an item.
    return Array.from(dataTransfer.items ?? [])
      .map((item) => (item.kind === 'file' ? item.getAsFile() : null))
      .filter((file): file is File => file !== null)
  }

  const onDrop = (event: DragEvent) => {
    event.preventDefault()
    depth.current = 0
    setDragging(false)
    if (disabled) return
    const dropped = readFiles(event)
    if (dropped.length > 0) onFiles(dropped)
  }

  return { dragging, onDragEnter, onDragOver, onDragLeave, onDrop }
}
