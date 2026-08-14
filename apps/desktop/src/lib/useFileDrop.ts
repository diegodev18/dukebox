import { useRef, useState, type DragEvent as ReactDragEvent } from 'react'

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

/** Files from a paste. Screenshots land here as `image/png` with no filename. */
export function filesFromPaste(data: DataTransfer | null | undefined): File[] {
  if (!data) return []

  const fromFiles = Array.from(data.files ?? [])
  if (fromFiles.length > 0) return fromFiles

  return Array.from(data.items ?? [])
    .map((item) => (item.kind === 'file' ? item.getAsFile() : null))
    .filter((file): file is File => file !== null)
}

export function dataTransferHasFiles(dataTransfer: DataTransfer | null | undefined): boolean {
  if (!dataTransfer) return false

  const types = Array.from(dataTransfer.types ?? []).map((type) => type.toLowerCase())
  if (types.includes('files') || types.includes('application/x-moz-file')) return true

  return Array.from(dataTransfer.items ?? []).some((item) => item.kind === 'file')
}

/**
 * Stop the browser from navigating to a dropped file.
 *
 * The composer only intercepts drops on itself. A drop on the transcript,
 * sidebar, or chrome is the default browser action — replace the page with
 * the image — which looks exactly like the session dying.
 */
export function preventWindowFileNavigation(): () => void {
  const prevent = (event: Event) => {
    const drag = event as DragEvent
    if (!dataTransferHasFiles(drag.dataTransfer)) return
    event.preventDefault()
  }

  window.addEventListener('dragover', prevent)
  window.addEventListener('drop', prevent)
  return () => {
    window.removeEventListener('dragover', prevent)
    window.removeEventListener('drop', prevent)
  }
}

export function useFileDrop({
  disabled,
  onFiles,
}: {
  disabled: boolean
  onFiles: (files: File[]) => void
}) {
  const [dragging, setDragging] = useState(false)
  const depth = useRef(0)

  const carriesFiles = (event: ReactDragEvent): boolean => dataTransferHasFiles(event.dataTransfer)

  const onDragEnter = (event: ReactDragEvent) => {
    if (!carriesFiles(event)) return
    event.preventDefault()
    if (disabled) return
    depth.current += 1
    setDragging(true)
  }

  const onDragOver = (event: ReactDragEvent) => {
    if (!carriesFiles(event)) return
    event.preventDefault()
    event.dataTransfer.dropEffect = 'copy'
  }

  const onDragLeave = (event: ReactDragEvent) => {
    event.preventDefault()
    depth.current = Math.max(0, depth.current - 1)
    if (depth.current === 0) setDragging(false)
  }

  const readFiles = (event: ReactDragEvent): File[] => {
    const dataTransfer = event.dataTransfer
    if (!dataTransfer) return []

    const dropped = Array.from(dataTransfer.files ?? [])
    if (dropped.length > 0) return dropped

    // Some engines leave `files` empty on drop but expose each file as an item.
    return Array.from(dataTransfer.items ?? [])
      .map((item) => (item.kind === 'file' ? item.getAsFile() : null))
      .filter((file): file is File => file !== null)
  }

  const onDrop = (event: ReactDragEvent) => {
    event.preventDefault()
    depth.current = 0
    setDragging(false)
    if (disabled) return
    const dropped = readFiles(event)
    if (dropped.length > 0) onFiles(dropped)
  }

  return { dragging, onDragEnter, onDragOver, onDragLeave, onDrop }
}
