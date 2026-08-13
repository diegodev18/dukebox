/**
 * How wide the session columns are.
 *
 * The layout used to hard-code these: 236px for the nav, a clamp for the
 * workspace. People with long repository names or a dense diff wanted more
 * room, but unbounded growth ate the transcript. The numbers below are the
 * rails — drag freely inside them, never past them.
 */

export const NAV_WIDTH_KEY = 'dukebox:nav-width'
export const WORKSPACE_WIDTH_KEY = 'dukebox:workspace-width'

/** Matches the original `grid-cols-[236px_…]`. */
export const NAV_DEFAULT = 236
export const NAV_MIN = 196
export const NAV_MAX = 400

/** Close to the old `clamp(340px, 30vw, 460px)` on a typical window. */
export const WORKSPACE_DEFAULT = 400
export const WORKSPACE_MIN = 320
export const WORKSPACE_MAX = 640
/** Collapsed workspace rail — counts, not tabs. */
export const WORKSPACE_COLLAPSED = 244

/** Floor for the conversation column so the side panels cannot close it. */
export const MAIN_MIN = 380

export function clampColumnWidth(
  next: number,
  min: number,
  max: number,
  /** Remaining pixels this column may take after the others have claimed theirs. */
  available?: number,
): number {
  const ceiling =
    available === undefined ? max : Math.min(max, Math.max(min, Math.floor(available)))
  if (!Number.isFinite(next)) return min
  return Math.min(ceiling, Math.max(min, Math.round(next)))
}

export function loadColumnWidth(key: string, fallback: number, min: number, max: number): number {
  try {
    const raw = localStorage.getItem(key)
    if (raw === null) return fallback
    return clampColumnWidth(Number(raw), min, max)
  } catch {
    return fallback
  }
}

export function saveColumnWidth(key: string, width: number): void {
  localStorage.setItem(key, String(width))
}
