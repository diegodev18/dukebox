import type { ServerMessage } from '@dukebox/protocol'

/**
 * The terminals open in the current session.
 *
 * A reducer plus the state it folds, kept apart from the socket for the same
 * reason the transcript is: a pure function over messages can be tested without
 * a WebSocket, a container, or a DOM.
 *
 * Output is queued as base64 rather than written straight to xterm because the
 * component that owns the xterm instance may not be mounted when a chunk
 * arrives — the panel can be hidden, and the terminal keeps running anyway.
 */

export interface TerminalTab {
  terminalId: string
  title: string
  exited: boolean
  /** Base64 chunks not yet written to xterm, oldest first. */
  pending: string[]
}

export interface TerminalState {
  tabs: TerminalTab[]
}

export function emptyTerminalState(): TerminalState {
  return { tabs: [] }
}

export function applyTerminalMessage(state: TerminalState, message: ServerMessage): TerminalState {
  switch (message.type) {
    case 'terminal_list':
      // Authoritative: the server knows what is alive, and a tab left over
      // from a previous connection would be one nothing can be typed into.
      return {
        tabs: message.terminals.map((terminal) => ({
          terminalId: terminal.terminalId,
          title: terminal.title,
          exited: false,
          pending: [],
        })),
      }

    case 'terminal_opened':
      if (state.tabs.some((tab) => tab.terminalId === message.terminalId)) return state

      return {
        tabs: [
          ...state.tabs,
          {
            terminalId: message.terminalId,
            title: message.title,
            exited: false,
            pending: [],
          },
        ],
      }

    case 'terminal_output':
      return appendOutput(state, message.terminalId, [message.data])

    case 'terminal_exit':
      // Kept in the list rather than removed. A shell's exit is information,
      // and a tab that vanishes leaves the user wondering what happened.
      return mapTab(state, message.terminalId, (tab) => ({ ...tab, exited: true }))

    default:
      return state
  }
}

/**
 * Queue several chunks for one or more terminals in a single state update.
 *
 * PTY output arrives faster than frames. Applying each chunk on its own is a
 * React render per byte-burst; one map per frame is enough for xterm to catch up.
 */
export function applyTerminalOutputs(
  state: TerminalState,
  batches: ReadonlyMap<string, readonly string[]>,
): TerminalState {
  let next = state
  for (const [terminalId, chunks] of batches) {
    if (chunks.length === 0) continue
    next = appendOutput(next, terminalId, chunks)
  }
  return next
}

function appendOutput(
  state: TerminalState,
  terminalId: string,
  chunks: readonly string[],
): TerminalState {
  if (chunks.length === 0) return state
  return mapTab(state, terminalId, (tab) => ({
    ...tab,
    pending: [...tab.pending, ...chunks],
  }))
}

/** Drop chunks already written to xterm, so they are not replayed on remount. */
export function drainTab(state: TerminalState, terminalId: string, count: number): TerminalState {
  return mapTab(state, terminalId, (tab) => {
    if (count <= 0 || tab.pending.length === 0) return tab

    // Slice rather than clear: output can arrive between the write and this
    // update, and dropping those chunks is how a command's output vanishes
    // while the next prompt still appears — it looks like the command hung.
    const pending = tab.pending.slice(count)
    return pending.length === tab.pending.length ? tab : { ...tab, pending }
  })
}

export function removeTab(state: TerminalState, terminalId: string): TerminalState {
  const tabs = state.tabs.filter((tab) => tab.terminalId !== terminalId)
  return tabs.length === state.tabs.length ? state : { tabs }
}

/** Change a tab's label. Empty titles are ignored so a tab never goes blank. */
export function renameTab(state: TerminalState, terminalId: string, title: string): TerminalState {
  const next = title.trim()
  if (!next) return state

  return mapTab(state, terminalId, (tab) => (tab.title === next ? tab : { ...tab, title: next }))
}

/**
 * Replace one tab, returning the same state object when nothing changed.
 *
 * Identity matters: React skips a render when the state is unchanged, and
 * output for a terminal that no longer exists is common enough during teardown
 * to be worth not re-rendering over.
 */
function mapTab(
  state: TerminalState,
  terminalId: string,
  update: (tab: TerminalTab) => TerminalTab,
): TerminalState {
  const index = state.tabs.findIndex((tab) => tab.terminalId === terminalId)
  if (index === -1) return state

  const updated = update(state.tabs[index]!)
  if (updated === state.tabs[index]) return state

  const tabs = [...state.tabs]
  tabs[index] = updated

  return { tabs }
}
