import { useCallback, useEffect, useState } from 'react'
import {
  applyTheme,
  defaultSettings,
  loadSettings,
  saveSettings,
  type Settings,
} from '@/lib/settings'

/**
 * App preferences, loaded once and edited from the settings panel.
 *
 * The panel edits the same object the boot path reads, so a change here (a
 * theme, the launch-update behaviour, an identity) survives the restart that
 * would otherwise show the old value first.
 */

export interface UseSettings {
  /** Null only for the moment the store file is being read. */
  settings: Settings | null
  /** Persist a partial change and apply its side effects (theme). */
  save: (patch: Partial<Settings>) => void
}

export function useSettings(): UseSettings {
  const [settings, setSettings] = useState<Settings | null>(null)

  useEffect(() => {
    let cancelled = false

    loadSettings()
      .then((loaded) => {
        if (!cancelled) setSettings(loaded)
      })
      .catch(() => {
        // A store that cannot be read should not strand the app on a blank
        // window; the defaults are a safe way to keep going.
        if (!cancelled) setSettings(defaultSettings())
      })

    return () => {
      cancelled = true
    }
  }, [])

  const save = useCallback((patch: Partial<Settings>) => {
    setSettings((current) => {
      const next = { ...(current ?? defaultSettings()), ...patch }
      if (patch.theme !== undefined) applyTheme(next.theme)
      void saveSettings(patch)
      return next
    })
  }, [])

  return { settings, save }
}
