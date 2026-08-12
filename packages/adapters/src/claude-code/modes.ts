import { DEFAULT_PERMISSION_MODE, type PermissionMode } from '@dukebox/protocol'

/**
 * Map Dukebox permission modes onto Claude Code CLI flags.
 *
 * Claude's bypass mode is named `bypassPermissions`; the rest share names.
 */

const TO_CLAUDE: Record<PermissionMode, string> = {
  bypass: 'bypassPermissions',
  plan: 'plan',
  auto: 'auto',
  acceptEdits: 'acceptEdits',
}

const FROM_CLAUDE: Record<string, PermissionMode> = {
  bypassPermissions: 'bypass',
  plan: 'plan',
  auto: 'auto',
  acceptEdits: 'acceptEdits',
}

export function toClaudePermissionMode(mode: PermissionMode | undefined): string {
  return TO_CLAUDE[mode ?? DEFAULT_PERMISSION_MODE]
}

export function fromClaudePermissionMode(raw: string | undefined): PermissionMode | undefined {
  if (!raw) return undefined
  return FROM_CLAUDE[raw]
}
