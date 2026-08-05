import type {
  Block,
  SessionPurpose,
  SessionStatus,
  ToolBlock,
  Transcript as TranscriptData,
} from '@dukebox/protocol'
import { useEffect, useRef, useState } from 'react'
import { ThinkingOrb } from 'thinking-orbs'
import { activityBlock, mapOrbState, orbStateForTool } from '../lib/orbState.js'
import { Markdown } from './Markdown.js'

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
}

export function Transcript({ transcript, onRespond, purpose, running, status }: Props) {
  const scroller = useRef<HTMLDivElement>(null)
  const pinned = useRef(true)

  // Follow the output, but only while the user is already at the bottom.
  // Yanking someone back down while they read what happened earlier is worse
  // than letting the tail run off screen.
  useEffect(() => {
    const element = scroller.current
    if (!element || !pinned.current) return

    element.scrollTop = element.scrollHeight
  }, [transcript.blocks])

  const handleScroll = () => {
    const element = scroller.current
    if (!element) return

    const distance = element.scrollHeight - element.scrollTop - element.clientHeight
    pinned.current = distance < 60
  }

  // The server seeds environment_setup with a long fixed prompt. Collapse that
  // first prompt into a Cursor-style summary; later user prompts stay full text.
  const setupPromptId =
    purpose === 'environment_setup'
      ? transcript.blocks.find((block) => block.kind === 'prompt')?.id
      : undefined

  return (
    <div
      ref={scroller}
      onScroll={handleScroll}
      className="min-h-0 flex-1 overflow-y-auto px-6 py-5.5"
    >
      <div className="measure flex flex-col gap-4">
        {transcript.blocks.map((block) => (
          <BlockView
            key={block.id}
            block={block}
            onRespond={onRespond}
            compactSetup={block.id === setupPromptId}
            {...(running !== undefined ? { running } : {})}
            {...(status !== undefined ? { status } : {})}
          />
        ))}

        {transcript.running && <Working blocks={transcript.blocks} />}
      </div>
    </div>
  )
}

function BlockView({
  block,
  onRespond,
  compactSetup,
  running,
  status,
}: {
  block: Block
  onRespond: Props['onRespond']
  compactSetup?: boolean
  running?: boolean
  status?: SessionStatus
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
        <p
          data-selectable
          className="rounded-[var(--radius)] bg-surface px-3.5 py-2.5 whitespace-pre-wrap"
        >
          {block.text}
        </p>
      )

    case 'text':
      return <Markdown>{block.text}</Markdown>

    case 'thinking':
      return <Thinking text={block.text} />

    case 'tool':
      return <Tool block={block} />

    case 'permission':
      return <Permission block={block} onRespond={onRespond} />

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
        <SetupIcon />
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

function SetupIcon() {
  return (
    <svg
      className="size-3.5 flex-none"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="4" cy="4" r="1.5" />
      <circle cx="12" cy="8" r="1.5" />
      <circle cx="4" cy="12" r="1.5" />
      <path d="M5.5 4h4.5a2 2 0 0 1 2 2v1.5M5.5 12h4.5a2 2 0 0 0 2-2V9.5" />
    </svg>
  )
}

/** Reasoning, collapsed. Available, but never the first thing read. */
function Thinking({ text }: { text: string }) {
  const [open, setOpen] = useState(false)

  return (
    <div className="text-[13px] text-muted-foreground">
      <button
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        className="flex items-center gap-1.5 hover:text-foreground"
      >
        <Chevron open={open} />
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
function Tool({ block }: { block: ToolBlock }) {
  const [open, setOpen] = useState(false)
  const running = block.result === undefined
  const failed = block.result?.isError === true

  return (
    <div className="rounded-[var(--radius)] border border-border text-[13px]">
      <button
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        className="flex w-full min-w-0 items-center gap-2 px-3 py-2 text-left"
      >
        <Chevron open={open} />
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

      {open && block.result && (
        <pre className="max-h-80 overflow-auto border-t border-border px-3 py-2.5 font-mono text-[12px] whitespace-pre-wrap text-muted-foreground">
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
}: {
  block: Extract<Block, { kind: 'permission' }>
  onRespond: Props['onRespond']
}) {
  if (block.answered) {
    return <p className="text-[13px] text-muted-foreground">Answered: {block.action}</p>
  }

  return (
    <div className="rounded-[var(--radius)] border border-running/45 bg-running/5 px-3.5 py-3">
      <p className="text-[13px]">
        The agent wants to <span className="font-medium">{block.action}</span>.
      </p>

      <div className="mt-2.5 flex gap-2">
        <button
          onClick={() => onRespond(block.id, true)}
          className="rounded-[calc(var(--radius)*0.6)] bg-foreground px-3 py-1.5 text-[12.5px] font-medium text-background"
        >
          Allow
        </button>
        <button
          onClick={() => onRespond(block.id, false)}
          className="rounded-[calc(var(--radius)*0.6)] border border-border px-3 py-1.5 text-[12.5px] font-medium hover:bg-muted"
        >
          Deny
        </button>
      </div>
    </div>
  )
}

function Working({ blocks }: { blocks: Block[] }) {
  const state = mapOrbState(activityBlock(blocks))

  return (
    <div className="flex items-center">
      <ThinkingOrb state={state} size={20} theme="auto" />
    </div>
  )
}

function Chevron({ open }: { open: boolean }) {
  return (
    <svg
      className={`size-3.25 flex-none text-muted-foreground ${open ? 'rotate-90' : ''}`}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="m6 4 4 4-4 4" />
    </svg>
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
