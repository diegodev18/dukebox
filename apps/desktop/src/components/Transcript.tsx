import type { Block, ToolBlock, Transcript as TranscriptData } from '@dukebox/protocol'
import { useEffect, useRef, useState } from 'react'

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
}

export function Transcript({ transcript, onRespond }: Props) {
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

  return (
    <div ref={scroller} onScroll={handleScroll} className="min-h-0 flex-1 overflow-y-auto px-6 py-5.5">
      <div className="measure flex flex-col gap-4">
        {transcript.blocks.map((block) => (
          <BlockView key={block.id} block={block} onRespond={onRespond} />
        ))}

        {transcript.running && <Working />}
      </div>
    </div>
  )
}

function BlockView({ block, onRespond }: { block: Block; onRespond: Props['onRespond'] }) {
  switch (block.kind) {
    case 'prompt':
      return (
        <p className="rounded-[var(--radius)] bg-surface px-3.5 py-2.5 whitespace-pre-wrap">
          {block.text}
        </p>
      )

    case 'text':
      return <p className="whitespace-pre-wrap">{block.text}</p>

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

      {open && <p className="mt-2 pl-5 whitespace-pre-wrap opacity-80">{text}</p>}
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
          <span className="size-1.5 flex-none rounded-full bg-running motion-safe:animate-pulse" />
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

function Working() {
  return (
    <div className="flex items-center gap-1.5" aria-label="Working">
      {[0, 1, 2].map((index) => (
        <span
          key={index}
          className="size-1.5 rounded-full bg-muted-foreground motion-safe:animate-pulse"
          style={{ animationDelay: `${index * 160}ms` }}
        />
      ))}
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
