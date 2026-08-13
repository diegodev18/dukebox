import type { DeviceRole } from '@dukebox/protocol'

/**
 * Settings sections, and which roles can see them.
 *
 * Kept out of the Settings screen so other UI (the command palette) can list
 * the same destinations without loading the panel itself.
 */

export type SettingsCategory =
  'account' | 'git' | 'agents' | 'devices' | 'servers' | 'appearance' | 'updates'

export const SETTINGS_CATEGORIES: { id: SettingsCategory; label: string; ownerOnly?: boolean }[] = [
  { id: 'account', label: 'Account' },
  { id: 'git', label: 'Git' },
  { id: 'agents', label: 'Agents', ownerOnly: true },
  { id: 'devices', label: 'Devices', ownerOnly: true },
  { id: 'servers', label: 'Servers' },
  { id: 'appearance', label: 'Appearance' },
  { id: 'updates', label: 'Updates' },
]

export function settingsCategoriesFor(role: DeviceRole | null): typeof SETTINGS_CATEGORIES {
  if (role === 'owner') return SETTINGS_CATEGORIES
  return SETTINGS_CATEGORIES.filter((category) => !category.ownerOnly)
}
