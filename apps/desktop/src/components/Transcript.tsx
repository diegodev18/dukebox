import type {
  Block,
  SessionPurpose,
  SessionStatus,
  ToolBlock,
  Transcript as TranscriptData,
} from '@dukebox/protocol'
import { EXIT_PLAN_MODE_ACTION, isTerminal } from '@dukebox/protocol'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { ThinkingOrb } from 'thinking-orbs'
import type { StreamStatus } from '@/lib/stream'
import { activityBlock, mapOrbState, orbStateForTool } from '@/lib/orbState'
import {
  CheckIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  CopyIcon,
  EditIcon,
  SetupIcon,
} from '@/components/icons'
import { Markdown } from '@/components/Markdown'

/**
 * The conversation.
 *
 * Blocks come pre-folded by the reducer, so this only decides how each kind
 * looks. Nothing here interprets the stream — that separation is what lets the
 * folding be tested without a browser.
 */

interface Props {
  transcript: TranscriptData
  onRespond: (id: string, allow: boolean) => void
  /** When set, the seeded environment-setup prompt renders as a compact pill. */
  purpose?: SessionPurpose
  running?: boolean
  status?: SessionStatus
  /** Socket state: empty + catching up is "loading", not "nothing to say". */
  streamStatus?: StreamStatus
  /** Permission answers cannot reach the server while the socket is down. */
  disabled?: boolean
  /**
   * Load a user prompt into the composer. Edit does not rewind the agent
   * conversation — the edited text is sent as a follow-up.
   */
  onEdit?: (text: string) => void
}

export function Transcript({
  transcript,
  onRespond,
  purpose,
  running,
  status,
  streamStatus,
  disabled = false,
  onEdit,
}: Props) {
  const scroller = useRef<HTMLDivElement>(null)
  const pinned = useRef(true)
  const [showJump, setShowJump] = useState(false)

  // Follow the output, but only while the user is already at the bottom.
  // Yanking someone back down while they read what happened earlier is worse
  // than letting the tail run off screen.
  useEffect(() => {
    const element = scroller.current
    if (!element) return

    if (pinned.current) {
      element.scrollTop = element.scrollHeight
      setShowJump(false)
      return
    }

    if (running || transcript.running) setShowJump(true)
  }, [transcript.blocks, transcript.running, running])

  const handleScroll = () => {
    const element = scroller.current
    if (!element) return

    const distance = element.scrollHeight - element.scrollTop - element.clientHeight
    const next = distance < 60
    pinned.current = next
    if (next) setShowJump(false)
  }

  const jumpToBottom = () => {
    const element = scroller.current
    if (!element) return

    pinned.current = true
    element.scrollTop = element.scrollHeight
    setShowJump(false)
  }

  // The server seeds environment_setup with a long fixed prompt. Collapse that
  // first prompt into a Cursor-style summary; later user prompts stay full text.
  const setupPromptId =
    purpose === 'environment_setup'
      ? transcript.blocks.find((block) => block.kind === 'prompt')?.id
      : undefined

  const empty = transcript.blocks.length === 0
  const loading = empty && (streamStatus === 'connecting' || streamStatus === 'catching_up')
  // After a restart the last events can still look mid-turn. The session
  // status is what knows the agent is gone, and a spinner that never stops is
  // how that used to read.
  const showWorking = transcript.running && (status === undefined || !isTerminal(status))

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <div
        ref={scroller}
        onScroll={handleScroll}
        className="min-h-0 flex-1 overflow-y-auto px-6 py-5.5"
      >
        <div className="measure flex flex-col gap-4">
          {empty ? (
            <p className="text-[13px] text-muted-foreground">
              {loading
                ? 'Loading conversation…'
                : purpose === 'environment_setup'
                  ? 'Waiting for the agent…'
                  : 'Ask for a change to start.'}
            </p>
          ) : (
            transcript.blocks.map((block) => (
              <BlockView
                key={block.id}
                block={block}
                onRespond={onRespond}
                compactSetup={block.id === setupPromptId}
                disabled={disabled}
                {...(onEdit ? { onEdit } : {})}
                {...(running !== undefined ? { running } : {})}
                {...(status !== undefined ? { status } : {})}
              />
            ))
          )}

          {showWorking && <Working blocks={transcript.blocks} />}
        </div>
      </div>

      {showJump && (
        <button
          type="button"
          onClick={jumpToBottom}
          aria-label="Jump to new activity"
          className="absolute bottom-3 left-1/2 -translate-x-1/2 rounded-full border border-border bg-background px-3 py-1.5 text-[12.5px] font-medium shadow-sm hover:bg-muted"
        >
          ↓ New activity
        </button>
      )}
    </div>
  )
}

function BlockView({
  block,
  onRespond,
  compactSetup,
  running,
  status,
  disabled = false,
  onEdit,
}: {
  block: Block
  onRespond: Props['onRespond']
  compactSetup?: boolean
  running?: boolean
  status?: SessionStatus
  disabled?: boolean
  onEdit?: Props['onEdit']
}) {
  switch (block.kind) {
    case 'prompt':
      if (compactSetup) {
        return (
          <SetupPrompt
            text={block.text}
            {...(running !== undefined ? { running } : {})}
            {...(status !== undefined ? { status } : {})}
          />
        )
      }
      return (
        <MessageBlock text={block.text} editDisabled={disabled} {...(onEdit ? { onEdit } : {})}>
          <p
            data-selectable
            className="rounded-[var(--radius)] bg-surface px-3.5 py-2.5 whitespace-pre-wrap"
          >
            {block.text}
          </p>
        </MessageBlock>
      )

    case 'text':
      return <Markdown>{block.text}</Markdown>

    case 'thinking':
      return <Thinking text={block.text} />

    case 'tool':
      return <Tool block={block} settled={status !== undefined && isTerminal(status)} />

    case 'permission':
      return <Permission block={block} onRespond={onRespond} disabled={disabled} />

    case 'error':
      return (
        <p
          className={`rounded-[var(--radius)] px-3.5 py-2.5 text-[13px] ${
            block.fatal ? 'bg-destructive/10 text-destructive' : 'bg-surface text-muted-foreground'
          }`}
        >
          {block.message}
        </p>
      )
  }
}

/**
 * A user prompt, with copy and edit on hover.
 *
 * Edit loads the text into the composer rather than rewriting history: the
 * protocol has no rewind, so a follow-up is the honest action.
 */
function MessageBlock({
  text,
  onEdit,
  editDisabled = false,
  children,
}: {
  text: string
  onEdit?: (text: string) => void
  editDisabled?: boolean
  children: ReactNode
}) {
  return (
    <div className="group flex flex-col items-start gap-1">
      {children}
      <MessageActions text={text} {...(onEdit ? { onEdit } : {})} editDisabled={editDisabled} />
    </div>
  )
}

function MessageActions({
  text,
  onEdit,
  editDisabled = false,
}: {
  text: string
  onEdit?: (text: string) => void
  editDisabled?: boolean
}) {
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    if (!copied) return
    const timer = window.setTimeout(() => setCopied(false), 1500)
    return () => window.clearTimeout(timer)
  }, [copied])

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
    } catch {
      // Clipboard can be missing in a locked-down webview; selection still works.
    }
  }

  return (
    <div
      className={`flex gap-0.5 ${
        copied ? 'opacity-100' : 'opacity-0 group-hover:opacity-100 group-focus-within:opacity-100'
      }`}
    >
      <button
        type="button"
        onClick={() => void copy()}
        aria-label={copied ? 'Copied' : 'Copy'}
        title={copied ? 'Copied' : 'Copy'}
        className="grid size-6 place-items-center rounded-[calc(var(--radius)*0.5)] text-muted-foreground hover:bg-muted hover:text-foreground"
      >
        {copied ? <CheckIcon size={13} /> : <CopyIcon size={13} />}
      </button>
      {onEdit ? (
        <button
          type="button"
          onClick={() => onEdit(text)}
          disabled={editDisabled}
          aria-label="Edit"
          title="Edit"
          className="grid size-6 place-items-center rounded-[calc(var(--radius)*0.5)] text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-40"
        >
          <EditIcon size={13} />
        </button>
      ) : null}
    </div>
  )
}

/**
 * Seeded environment-setup prompt, shown like Cursor's task chip: a short
 * labelled pill instead of the full system instructions.
 */
function SetupPrompt({
  text,
  running,
  status,
}: {
  text: string
  running?: boolean
  status?: SessionStatus
}) {
  const [open, setOpen] = useState(false)
  const duration = formatSetupDuration(running, status)

  return (
    <div className="flex flex-col items-start gap-1.5">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-label="Configure environment"
        className="inline-flex items-center gap-2 rounded-md border border-border px-3 py-1.5 text-[13px] text-running hover:bg-muted/60"
      >
        <SetupIcon size={14} className="flex-none" />
        Configure environment
      </button>

      {duration ? <p className="text-[12px] text-muted-foreground">{duration}</p> : null}

      {open && (
        <pre
          data-selectable
          className="max-h-64 w-full overflow-auto rounded-[var(--radius)] border border-border bg-surface px-3 py-2.5 font-mono text-[12px] whitespace-pre-wrap text-muted-foreground"
        >
          {text}
        </pre>
      )}
    </div>
  )
}

function formatSetupDuration(
  running: boolean | undefined,
  status: SessionStatus | undefined,
): string | null {
  // No endedAt on the session summary, so a wall-clock delta would lie for
  // old sessions. Show live progress only; Cursor's "Worked for Ns" needs a
  // real elapsed interval we do not have yet.
  if (running || status === 'running' || status === 'provisioning') {
    return 'Working…'
  }
  return null
}

/** Reasoning, collapsed. Available, but never the first thing read. */
function Thinking({ text }: { text: string }) {
  const [open, setOpen] = useState(false)

  return (
    <div className="text-[13px] text-muted-foreground">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-label={open ? 'Hide thinking' : 'Show thinking'}
        className="flex items-center gap-1.5 hover:text-foreground"
      >
        {open ? (
          <ChevronDownIcon size={13} className="flex-none text-muted-foreground" />
        ) : (
          <ChevronRightIcon size={13} className="flex-none text-muted-foreground" />
        )}
        Thought for a moment
      </button>

      {open && (
        <div className="mt-2 pl-5 opacity-80">
          <Markdown>{text}</Markdown>
        </div>
      )}
    </div>
  )
}

/**
 * A tool call with its outcome.
 *
 * Collapsed to one line by default: the name and target answer "what is it
 * doing" for almost every call, and a session doing real work makes dozens.
 */
function Tool({ block, settled }: { block: ToolBlock; settled?: boolean }) {
  const [open, setOpen] = useState(false)
  const running = block.result === undefined && !settled
  const failed = block.result?.isError === true

  return (
    <div className="rounded-[var(--radius)] border border-border text-[13px]">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-label={open ? `Hide ${block.name}` : `Show ${block.name}`}
        className="flex w-full min-w-0 items-center gap-2 px-3 py-2 text-left"
      >
        {open ? (
          <ChevronDownIcon size={13} className="flex-none text-muted-foreground" />
        ) : (
          <ChevronRightIcon size={13} className="flex-none text-muted-foreground" />
        )}
        <span className="font-medium">{block.name}</span>
        <span className="min-w-0 flex-1 truncate text-muted-foreground">
          {summarize(block.input)}
        </span>

        {running && (
          <ThinkingOrb
            state={orbStateForTool(block.name)}
            size={20}
            theme="auto"
            className="flex-none"
            aria-label={`${block.name} running`}
          />
        )}
        {failed && <span className="flex-none text-[12px] text-destructive">failed</span>}
      </button>

      {open && running && (
        <p className="border-t border-border px-3 py-2.5 text-[12.5px] text-muted-foreground">
          Running…
        </p>
      )}

      {open && block.result && (
        <pre
          data-selectable
          className="max-h-80 overflow-auto border-t border-border px-3 py-2.5 font-mono text-[12px] whitespace-pre-wrap text-muted-foreground"
        >
          {block.result.output || '(no output)'}
        </pre>
      )}
    </div>
  )
}

/**
 * A permission prompt.
 *
 * The one block that stops the session until it is answered, so it is the one
 * block with a coloured border. Amber rather than the `waiting` token: the
 * preset defines that as its primary blue, which reads as an ordinary control
 * rather than as something demanding an answer.
 */
function Permission({
  block,
  onRespond,
  disabled = false,
}: {
  block: Extract<Block, { kind: 'permission' }>
  onRespond: Props['onRespond']
  disabled?: boolean
}) {
  const [decision, setDecision] = useState<'allow' | 'deny' | null>(null)
  const allow = useRef<HTMLButtonElement>(null)
  const answered = block.answered || decision !== null

  const isPlanExit = block.action === EXIT_PLAN_MODE_ACTION

  useEffect(() => {
    if (answered || disabled) return
    allow.current?.focus()
  }, [answered, disabled])

  if (answered) {
    if (decision === 'allow') {
      return (
        <p className="text-[13px] text-done">
          {isPlanExit ? 'Implementing the plan' : `Allowed ${block.action}`}
        </p>
      )
    }
    if (decision === 'deny') {
      return (
        <p className="text-[13px] text-muted-foreground">
          {isPlanExit ? 'Kept planning' : `Denied ${block.action}`}
        </p>
      )
    }
    return <p className="text-[13px] text-muted-foreground">Answered: {block.action}</p>
  }

  const respond = (allow: boolean) => {
    setDecision(allow ? 'allow' : 'deny')
    onRespond(block.id, allow)
  }

  return (
    <div className="rounded-[var(--radius)] border border-running/45 bg-running/5 px-3.5 py-3">
      <p className="text-[13px]">
        {isPlanExit ? (
          'The plan is ready. Implement it, or keep planning.'
        ) : (
          <>
            The agent wants to <span className="font-medium">{block.action}</span>.
          </>
        )}
      </p>

      <div className="mt-2.5 flex gap-2">
        <button
          ref={allow}
          type="button"
          onClick={() => respond(true)}
          disabled={disabled}
          className="rounded-[calc(var(--radius)*0.6)] bg-foreground px-3 py-1.5 text-[12.5px] font-medium text-background disabled:opacity-40"
        >
          {isPlanExit ? 'Implement' : 'Allow'}
        </button>
        <button
          type="button"
          onClick={() => respond(false)}
          disabled={disabled}
          className="rounded-[calc(var(--radius)*0.6)] border border-border px-3 py-1.5 text-[12.5px] font-medium hover:bg-muted disabled:opacity-40"
        >
          {isPlanExit ? 'Keep planning' : 'Deny'}
        </button>
      </div>
    </div>
  )
}

function Working({ blocks }: { blocks: Block[] }) {
  const state = mapOrbState(activityBlock(blocks))

  return (
    <div className="flex items-center" aria-label="Working" role="status">
      <ThinkingOrb state={state} size={20} theme="auto" />
    </div>
  )
}

/**
 * The one detail worth showing next to a tool name.
 *
 * Tool inputs vary by agent and by tool, so this looks for the fields that
 * carry meaning and falls back to nothing rather than dumping JSON into a line
 * that has to stay one line.
 */
function summarize(input: unknown): string {
  if (typeof input === 'string') return input
  if (typeof input !== 'object' || input === null) return ''

  const record = input as Record<string, unknown>
  for (const key of ['file_path', 'path', 'command', 'pattern', 'query', 'url']) {
    const value = record[key]
    if (typeof value === 'string' && value) return value
  }

  return ''
}
