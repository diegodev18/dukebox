import { useCallback, useLayoutEffect, useRef, useState } from 'react'
import {
  clampColumnWidth,
  loadColumnWidth,
  saveColumnWidth,
  MAIN_MIN,
  NAV_DEFAULT,
  NAV_MAX,
  NAV_MIN,
  NAV_WIDTH_KEY,
  WORKSPACE_DEFAULT,
  WORKSPACE_MAX,
  WORKSPACE_MIN,
  WORKSPACE_WIDTH_KEY,
} from '@/lib/columnWidths'

/**
 * Preferred widths for the nav and workspace columns.
 *
 * The stored value is what the person asked for. The rendered value is that
 * number clamped to the window, so shrinking the window cannot cover the
 * transcript, and growing it again restores the choice.
 */

export function useColumnWidths(composing: boolean) {
  const containerRef = useRef<HTMLDivElement>(null)
  const [containerWidth, setContainerWidth] = useState(0)
  const [navPreferred, setNavPreferred] = useState(() =>
    loadColumnWidth(NAV_WIDTH_KEY, NAV_DEFAULT, NAV_MIN, NAV_MAX),
  )
  const [workspacePreferred, setWorkspacePreferred] = useState(() =>
    loadColumnWidth(WORKSPACE_WIDTH_KEY, WORKSPACE_DEFAULT, WORKSPACE_MIN, WORKSPACE_MAX),
  )

  useLayoutEffect(() => {
    const el = containerRef.current
    if (!el) return

    const update = () => setContainerWidth(el.getBoundingClientRect().width)
    update()

    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(update)
    observer?.observe(el)
    window.addEventListener('resize', update)
    return () => {
      observer?.disconnect()
      window.removeEventListener('resize', update)
    }
  }, [])

  const workspaceTaken = composing
    ? 0
    : clampColumnWidth(workspacePreferred, WORKSPACE_MIN, WORKSPACE_MAX)
  const availableForNav =
    containerWidth > 0 ? containerWidth - workspaceTaken - MAIN_MIN : undefined
  const navMax =
    availableForNav === undefined
      ? NAV_MAX
      : Math.min(NAV_MAX, Math.max(NAV_MIN, Math.floor(availableForNav)))
  const navWidth = clampColumnWidth(navPreferred, NAV_MIN, NAV_MAX, availableForNav)

  const availableForWorkspace =
    containerWidth > 0 ? containerWidth - navWidth - MAIN_MIN : undefined
  const workspaceMax =
    composing || availableForWorkspace === undefined
      ? WORKSPACE_MAX
      : Math.min(WORKSPACE_MAX, Math.max(WORKSPACE_MIN, Math.floor(availableForWorkspace)))
  const workspaceWidth = clampColumnWidth(
    workspacePreferred,
    WORKSPACE_MIN,
    WORKSPACE_MAX,
    composing ? undefined : availableForWorkspace,
  )

  const setNavWidth = useCallback((next: number) => {
    const width = clampColumnWidth(next, NAV_MIN, NAV_MAX)
    setNavPreferred(width)
    saveColumnWidth(NAV_WIDTH_KEY, width)
  }, [])

  const setWorkspaceWidth = useCallback((next: number) => {
    const width = clampColumnWidth(next, WORKSPACE_MIN, WORKSPACE_MAX)
    setWorkspacePreferred(width)
    saveColumnWidth(WORKSPACE_WIDTH_KEY, width)
  }, [])

  return {
    containerRef,
    navWidth,
    workspaceWidth,
    navMax,
    workspaceMax,
    setNavWidth,
    setWorkspaceWidth,
  }
}
