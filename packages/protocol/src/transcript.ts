import type { AgentEvent, EnvelopedEvent, PromptAttachment } from '@/events'
import { countLineChanges } from '@/lineChanges'
import type { PermissionMode } from '@/session'

/**
 * The event stream, folded into what a person reads.
 *
 * Events arrive as a flat sequence of deltas: a hundred `assistant_text`
 * fragments are one paragraph, and a `tool_call` only makes sense next to the
 * `tool_result` that answers it. Rendering the raw stream would mean a DOM node
 * per token and tool calls separated from their outcomes by whatever the agent
 * said in between.
 *
 * This folds the stream into blocks — the unit the UI actually draws. It lives
 * in the protocol package because the server needs the same grouping to render
 * a session summary, and two implementations would drift.
 */

/** Prose from the agent. Consecutive deltas are one block. */
export interface TextBlock {
  kind: 'text'
  id: string
  text: string
}

/** Reasoning. Same folding as text, but the UI collapses it by default. */
export interface ThinkingBlock {
  kind: 'thinking'
  id: string
  text: string
}

/**
 * A tool call and its outcome, together.
 *
 * `result` stays undefined while the tool is still running, which is what the
 * UI keys its spinner off. A `done` or fatal error closes anything still
 * waiting — after a restart those are the blocks that would otherwise spin
 * forever on a turn that cannot finish.
 */
export interface ToolBlock {
  kind: 'tool'
  id: string
  name: string
  input: unknown
  result?: { output: string; isError: boolean }
}

/** A permission prompt. Blocks the session until answered. */
export interface PermissionBlock {
  kind: 'permission'
  id: string
  action: string
  detail: unknown
  answered?: boolean
  /**
   * What the answer was, once there is one.
   *
   * Undefined on a block settled by `closeOpenWork` rather than by the user:
   * nobody answered, so neither `true` nor `false` would be true.
   */
  allowed?: boolean
}

/** Something failed. Fatal errors end the session. */
export interface ErrorBlock {
  kind: 'error'
  id: string
  message: string
  fatal: boolean
}

/** What the user typed. Folded from `user_prompt`, like every other block. */
export interface PromptBlock {
  kind: 'prompt'
  id: string
  text: string
  attachments?: PromptAttachment[]
}

export type Block =
  TextBlock | ThinkingBlock | ToolBlock | PermissionBlock | ErrorBlock | PromptBlock

/** A file the session changed, latest state per path. */
export interface FileChange {
  path: string
  before: string | null
  after: string | null
  /** Line counts, folded once from before/after so the UI does not re-diff. */
  added?: number
  removed?: number
}

export interface Transcript {
  blocks: Block[]
  files: FileChange[]
  usage: { inputTokens: number; outputTokens: number; costUsd: number }
  /** The agent behind this session, once it has said so. */
  agentId?: string
  model?: string
  /** How the agent is allowed to act, once it has said so. */
  permissionMode?: PermissionMode
  /** True between the first event of a turn and its `done`. */
  running: boolean
  /** Highest seq folded in. What a reconnect resumes from. */
  lastSeq: number
}

export function emptyTranscript(): Transcript {
  return {
    blocks: [],
    files: [],
    usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
    running: false,
    lastSeq: 0,
  }
}

/**
 * Fold one event into a transcript, returning a new one.
 *
 * Returns the *same* object when nothing changed, so React can skip a render
 * on events that only affect bookkeeping. Out-of-order and duplicate events are
 * dropped by seq — replay and live delivery can overlap, and the server's
 * ordering guarantee is only worth having if the client enforces it too.
 */
export function applyEvent(transcript: Transcript, enveloped: EnvelopedEvent): Transcript {
  if (enveloped.seq <= transcript.lastSeq) return transcript

  const next: Transcript = {
    ...transcript,
    blocks: transcript.blocks,
    lastSeq: enveloped.seq,
  }

  fold(next, enveloped.event, enveloped.seq)
  return next
}

/** Fold many events at once. Cheaper than one call per event during replay. */
export function applyEvents(transcript: Transcript, events: readonly EnvelopedEvent[]): Transcript {
  return events.reduce(applyEvent, transcript)
}

/**
 * Mark a permission request answered, so the UI stops offering the buttons.
 *
 * `allowed` is kept as well as `answered`: an approved plan and a rejected one
 * both stop asking, but only the rejected one gets replanned in place.
 */
export function answerPermission(transcript: Transcript, id: string, allowed: boolean): Transcript {
  const index = transcript.blocks.findIndex(
    (block) => block.kind === 'permission' && block.id === id,
  )
  if (index === -1) return transcript

  const blocks = [...transcript.blocks]
  blocks[index] = { ...(blocks[index] as PermissionBlock), answered: true, allowed }
  return { ...transcript, blocks }
}

/**
 * Mutates `draft`, which is always a fresh object from `applyEvent`.
 *
 * Text and thinking deltas extend the last block of their kind rather than
 * appending — that is the whole point of folding, and it is why streaming a
 * long answer costs one growing block instead of thousands of siblings.
 */
function fold(draft: Transcript, event: AgentEvent, seq: number): void {
  switch (event.type) {
    case 'session_started': {
      draft.agentId = event.agentId
      if (event.model !== undefined) draft.model = event.model
      draft.running = true
      return
    }

    case 'user_prompt': {
      // Marks the session running before the agent has said anything: the
      // prompt is sent and then nothing arrives until the first token, and a
      // transcript that looks idle in that gap reads as a prompt that was lost.
      draft.running = true
      draft.blocks = [
        ...draft.blocks,
        {
          kind: 'prompt',
          id: `prompt-${seq}`,
          text: event.text,
          ...(event.attachments && event.attachments.length > 0
            ? { attachments: event.attachments }
            : {}),
        },
      ]
      return
    }

    case 'assistant_text': {
      draft.running = true
      extend(draft, 'text', event.delta, seq)
      return
    }

    case 'thinking': {
      draft.running = true
      extend(draft, 'thinking', event.delta, seq)
      return
    }

    case 'tool_call': {
      draft.running = true
      draft.blocks = [
        ...draft.blocks,
        { kind: 'tool', id: event.id, name: event.name, input: event.input },
      ]
      return
    }

    case 'tool_result': {
      // Matched by id, not position: tools can resolve out of order, and a
      // parallel call would otherwise attach its output to the wrong block.
      const index = findLast(draft.blocks, (b) => b.kind === 'tool' && b.id === event.id)
      if (index === -1) return

      const blocks = [...draft.blocks]
      blocks[index] = {
        ...(blocks[index] as ToolBlock),
        result: { output: event.output, isError: event.isError },
      }
      draft.blocks = blocks
      return
    }

    case 'file_diff': {
      // Latest state per path wins. An agent that edits a file three times
      // produces three events but one entry in the review panel.
      const { added, removed } = countLineChanges(event.before, event.after)
      const files = draft.files.filter((file) => file.path !== event.path)
      files.push({
        path: event.path,
        before: event.before,
        after: event.after,
        added,
        removed,
      })
      files.sort((a, b) => a.path.localeCompare(b.path))
      draft.files = files
      return
    }

    case 'permission_request': {
      draft.blocks = [
        ...draft.blocks,
        { kind: 'permission', id: event.id, action: event.action, detail: event.detail },
      ]
      return
    }

    case 'permission_mode': {
      draft.permissionMode = event.mode
      return
    }

    case 'usage': {
      // Accumulated, not replaced: a session's cost is every turn's cost, and
      // each `usage` event reports only the turn that just ended.
      draft.usage = {
        inputTokens: draft.usage.inputTokens + event.inputTokens,
        outputTokens: draft.usage.outputTokens + event.outputTokens,
        costUsd: draft.usage.costUsd + (event.costUsd ?? 0),
      }
      return
    }

    case 'error': {
      draft.blocks = [
        ...draft.blocks,
        { kind: 'error', id: `error-${seq}`, message: event.message, fatal: event.fatal },
      ]
      if (event.fatal) {
        draft.running = false
        closeOpenWork(draft)
      }
      return
    }

    case 'done': {
      draft.running = false
      closeOpenWork(draft)
      return
    }
  }
}

/**
 * Settle work that will never finish.
 *
 * A turn that ends — `done`, or a fatal error — leaves any tool still waiting
 * for a result and any permission still unanswered. After a control-plane
 * restart those are the blocks that keep the UI spinning: the agent that was
 * going to answer is gone.
 */
function closeOpenWork(draft: Transcript): void {
  let changed = false
  const blocks = draft.blocks.map((block) => {
    if (block.kind === 'tool' && block.result === undefined) {
      changed = true
      return { ...block, result: { output: 'Interrupted.', isError: true } }
    }
    if (block.kind === 'permission' && !block.answered) {
      changed = true
      return { ...block, answered: true }
    }
    return block
  })
  if (changed) draft.blocks = blocks
}

/** Extend the trailing block of a kind, or start one. */
function extend(draft: Transcript, kind: 'text' | 'thinking', delta: string, seq: number): void {
  const last = draft.blocks.at(-1)

  if (last?.kind === kind) {
    const blocks = [...draft.blocks]
    blocks[blocks.length - 1] = { ...last, text: last.text + delta }
    draft.blocks = blocks
    return
  }

  draft.blocks = [...draft.blocks, { kind, id: `${kind}-${seq}`, text: delta }]
}

function findLast<T>(items: readonly T[], predicate: (item: T) => boolean): number {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index]
    if (item !== undefined && predicate(item)) return index
  }
  return -1
}
