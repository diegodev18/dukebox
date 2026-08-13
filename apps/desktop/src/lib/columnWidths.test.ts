import { afterEach, describe, expect, it } from 'vitest'
import {
  clampColumnWidth,
  loadColumnWidth,
  NAV_DEFAULT,
  NAV_MAX,
  NAV_MIN,
  NAV_WIDTH_KEY,
  saveColumnWidth,
  WORKSPACE_DEFAULT,
  WORKSPACE_MAX,
  WORKSPACE_MIN,
} from '@/lib/columnWidths'

afterEach(() => {
  localStorage.clear()
})

describe('clampColumnWidth', () => {
  it('stays inside the hard min and max', () => {
    expect(clampColumnWidth(100, NAV_MIN, NAV_MAX)).toBe(NAV_MIN)
    expect(clampColumnWidth(800, NAV_MIN, NAV_MAX)).toBe(NAV_MAX)
    expect(clampColumnWidth(240, NAV_MIN, NAV_MAX)).toBe(240)
  })

  it('rounds to a whole pixel', () => {
    expect(clampColumnWidth(240.6, NAV_MIN, NAV_MAX)).toBe(241)
  })

  it('caps at the remaining window so the main column is not eaten', () => {
    expect(clampColumnWidth(640, WORKSPACE_MIN, WORKSPACE_MAX, 500)).toBe(500)
    expect(clampColumnWidth(200, WORKSPACE_MIN, WORKSPACE_MAX, 500)).toBe(WORKSPACE_MIN)
  })

  it('never drops below min even when the window is too small', () => {
    expect(clampColumnWidth(400, NAV_MIN, NAV_MAX, 80)).toBe(NAV_MIN)
  })

  it('treats a non-finite value as the minimum', () => {
    expect(clampColumnWidth(Number.NaN, NAV_MIN, NAV_MAX)).toBe(NAV_MIN)
  })
})

describe('loadColumnWidth / saveColumnWidth', () => {
  it('returns the default when nothing is stored', () => {
    expect(loadColumnWidth(NAV_WIDTH_KEY, NAV_DEFAULT, NAV_MIN, NAV_MAX)).toBe(NAV_DEFAULT)
  })

  it('round-trips a saved width', () => {
    saveColumnWidth(NAV_WIDTH_KEY, 320)
    expect(loadColumnWidth(NAV_WIDTH_KEY, NAV_DEFAULT, NAV_MIN, NAV_MAX)).toBe(320)
  })

  it('ignores invalid storage and clamps out-of-range values', () => {
    localStorage.setItem(NAV_WIDTH_KEY, 'nope')
    expect(loadColumnWidth(NAV_WIDTH_KEY, NAV_DEFAULT, NAV_MIN, NAV_MAX)).toBe(NAV_MIN)

    localStorage.setItem(NAV_WIDTH_KEY, '12')
    expect(loadColumnWidth(NAV_WIDTH_KEY, NAV_DEFAULT, NAV_MIN, NAV_MAX)).toBe(NAV_MIN)

    localStorage.setItem(NAV_WIDTH_KEY, '999')
    expect(loadColumnWidth(NAV_WIDTH_KEY, NAV_DEFAULT, NAV_MIN, NAV_MAX)).toBe(NAV_MAX)
  })

  it('keeps the workspace default inside its own rails', () => {
    expect(WORKSPACE_DEFAULT).toBeGreaterThanOrEqual(WORKSPACE_MIN)
    expect(WORKSPACE_DEFAULT).toBeLessThanOrEqual(WORKSPACE_MAX)
  })
})
