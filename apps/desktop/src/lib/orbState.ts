import type { Block } from '@dukebox/protocol'

/**
 * How Duke should move while the agent is busy.
 *
 * Same buckets the old orb used for tools. Agent names vary by adapter
 * (Claude Code, Codex, …), so this matches substrings rather than an exact
 * catalogue. The fallback is `weaving` — something is happening, but we do
 * not know which verb fits.
 */
export type DukeMood =
  | 'working'
  | 'listening'
  | 'searching'
  | 'shaping'
  | 'connecting'
  | 'weaving'
  | 'solving'
  | 'composing'

export type ToolCategory = 'searching' | 'shaping' | 'working' | 'connecting' | 'weaving'

export function toolCategory(name: string): ToolCategory {
  const key = name.toLowerCase()

  if (/search|grep|glob|read|find|list|ls|look/.test(key)) return 'searching'
  if (/write|edit|apply|patch|create|update|str_replace|strreplace/.test(key)) return 'shaping'
  if (/bash|shell|terminal|exec|run_command|command/.test(key)) return 'working'
  if (/fetch|http|web|url|browser|download/.test(key)) return 'connecting'

  return 'weaving'
}

/** Map a tool name onto Duke's mood. */
export function orbStateForTool(name: string): DukeMood {
  return toolCategory(name)
}

/**
 * Pick Duke's mood for the agent's current turn from the latest block.
 *
 * Returns `working` when there is nothing more specific to show (empty
 * transcript, prompt, finished tool, error, answered permission).
 */
export function mapOrbState(block: Block | null | undefined): DukeMood {
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

/** Last block that can drive Duke — skips prompts and finished noise. */
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
