import type { Block } from '@dukebox/protocol'
import type { OrbState } from 'thinking-orbs'

/**
 * Map a tool name onto an orb verb.
 *
 * Agent tool names vary by adapter (Claude Code, Codex, …), so this matches
 * substrings rather than an exact catalogue. The fallback is `weaving` —
 * something is happening, but we do not know which verb fits.
 */
export function orbStateForTool(name: string): OrbState {
  const key = name.toLowerCase()

  if (/search|grep|glob|read|find|list|ls|look/.test(key)) return 'searching'
  if (/write|edit|apply|patch|create|update|str_replace|strreplace/.test(key)) return 'shaping'
  if (/bash|shell|terminal|exec|run_command|command/.test(key)) return 'working'
  if (/fetch|http|web|url|browser|download/.test(key)) return 'connecting'

  return 'weaving'
}

/**
 * Pick the orb state for the agent's current turn from the latest block.
 *
 * Returns `working` when there is nothing more specific to show (empty
 * transcript, prompt, finished tool, error, answered permission).
 */
export function mapOrbState(block: Block | null | undefined): OrbState {
  if (!block) return 'working'

  switch (block.kind) {
    case 'thinking':
      return 'solving'
    case 'text':
      return 'composing'
    case 'permission':
      return block.answered ? 'working' : 'listening'
    case 'tool':
      return block.result === undefined ? orbStateForTool(block.name) : 'working'
    default:
      return 'working'
  }
}

/** Last block that can drive the orb — skips prompts and finished noise. */
export function activityBlock(blocks: Block[]): Block | null {
  for (let i = blocks.length - 1; i >= 0; i--) {
    const block = blocks[i]!
    if (block.kind === 'prompt') continue
    if (block.kind === 'error') continue
    if (block.kind === 'permission' && block.answered) continue
    if (block.kind === 'tool' && block.result !== undefined) continue
    return block
  }
  return null
}
