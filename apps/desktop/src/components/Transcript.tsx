import type {
  Block,
  SessionPurpose,
  SessionStatus,
  ToolBlock,
  Transcript as TranscriptData,
} from '@dukebox/protocol'
import { EXIT_PLAN_MODE_ACTION, isTerminal, planFromDetail } from '@dukebox/protocol'
import { memo, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { StreamStatus } from '@/lib/stream'
import { activityBlock, mapOrbState, orbStateForTool, toolCategory } from '@/lib/orbState'
import { DukeLive } from '@/components/Duke'
import {
  CheckIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  CopyIcon,
  EditIcon,
  FileIcon,
  GlobeIcon,
  SearchIcon,
  SetupIcon,
  TerminalIcon,
} from '@/components/icons'
import { AttachmentChips } from '@/components/AttachmentChips'
import { Markdown } from '@/components/Markdown'
import { VirtualRows } from '@/components/VirtualRows'

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
  const turnActive = Boolean(running || transcript.running)
  const last = transcript.blocks.at(-1)
  // Copy is available for user prompts and the last assistant message of each
  // finished turn (the answer worth grabbing, not the interim chatter mid-turn).
  // A turn still in progress gets nothing to copy until the agent is done.
  const copyableTextIds = useMemo(() => {
    const ids = new Set<string>()
    let lastTextId: string | undefined
    for (const block of transcript.blocks) {
      if (block.kind === 'prompt') {
        if (lastTextId) ids.add(lastTextId)
        lastTextId = undefined
      } else if (block.kind === 'text') {
        lastTextId = block.id
      }
    }
    if (lastTextId && !running) ids.add(lastTextId)
    return ids
  }, [transcript.blocks, running])
  const streamingTextId = turnActive && last?.kind === 'text' ? last.id : undefined
  const streamingThinkingId = turnActive && last?.kind === 'thinking' ? last.id : undefined
  const settled = status !== undefined && isTerminal(status)
  const items = useMemo(() => groupTranscriptItems(transcript.blocks), [transcript.blocks])
  const itemCount = items.length + (showWorking ? 1 : 0)

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
            <VirtualRows
              count={itemCount}
              scrollRef={scroller}
              estimateSize={72}
              after={32}
              gap={16}
            >
              {(index) => {
                if (index >= items.length) {
                  return <Working key="working" blocks={transcript.blocks} />
                }

                const item = items[index]!
                if (item.kind === 'run') {
                  return <ToolRun key={item.id} entries={item.entries} settled={settled} />
                }

                const block = item.block
                return (
                  <BlockView
                    key={block.id}
                    block={block}
                    onRespond={onRespond}
                    compactSetup={block.id === setupPromptId}
                    disabled={disabled}
                    onEdit={onEdit}
                    streaming={block.id === streamingTextId || block.id === streamingThinkingId}
                    running={block.id === setupPromptId ? running : undefined}
                    status={block.id === setupPromptId ? status : undefined}
                    copyable={block.kind === 'prompt' || copyableTextIds.has(block.id)}
                  />
                )
              }}
            </VirtualRows>
          )}
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

const BlockView = memo(function BlockView({
  block,
  onRespond,
  compactSetup,
  running,
  status,
  disabled = false,
  onEdit,
  streaming = false,
  copyable = false,
}: {
  block: Exclude<Block, ToolBlock>
  onRespond: Props['onRespond']
  compactSetup?: boolean
  running?: boolean | undefined
  status?: SessionStatus | undefined
  disabled?: boolean
  onEdit?: Props['onEdit'] | undefined
  streaming?: boolean
  copyable?: boolean
}) {
  switch (block.kind) {
    case 'prompt':
      if (compactSetup) {
        return <SetupPrompt text={block.text} running={running} status={status} />
      }
      return (
        <MessageBlock text={block.text} editDisabled={disabled} onEdit={onEdit} copyable>
          <div className="rounded-[var(--radius)] bg-surface px-3.5 py-2.5">
            <p data-selectable className="whitespace-pre-wrap">
              {block.text}
            </p>
            {block.attachments && block.attachments.length > 0 ? (
              <div className="mt-2">
                <AttachmentChips attachments={block.attachments} />
              </div>
            ) : null}
          </div>
        </MessageBlock>
      )

    case 'text':
      return (
        <MessageBlock text={block.text} copyable={copyable}>
          {streaming ? (
            <p data-selectable className="whitespace-pre-wrap">
              {block.text}
            </p>
          ) : (
            <Markdown>{block.text}</Markdown>
          )}
        </MessageBlock>
      )

    case 'thinking':
      return <Thinking text={block.text} streaming={streaming} />

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
})

/**
 * A user prompt or assistant reply, with copy (and, for prompts, edit) on hover.
 *
 * Copy appears only for user messages and the last assistant message of each
 * finished turn — the answer worth grabbing, never the stream still arriving.
 * Edit loads the text into the composer rather than rewriting history: the
 * protocol has no rewind, so a follow-up is the honest action.
 */
function MessageBlock({
  text,
  onEdit,
  editDisabled = false,
  copyable = true,
  children,
}: {
  text: string
  onEdit?: ((text: string) => void) | undefined
  editDisabled?: boolean
  copyable?: boolean
  children: ReactNode
}) {
  return (
    <div className="group flex flex-col items-start gap-1">
      {children}
      {copyable || onEdit ? (
        <MessageActions
          text={text}
          {...(onEdit ? { onEdit } : {})}
          editDisabled={editDisabled}
          copyable={copyable}
        />
      ) : null}
    </div>
  )
}

function MessageActions({
  text,
  onEdit,
  editDisabled = false,
  copyable = true,
}: {
  text: string
  onEdit?: (text: string) => void
  editDisabled?: boolean
  copyable?: boolean
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
      {copyable ? (
        <button
          type="button"
          onClick={() => void copy()}
          aria-label={copied ? 'Copied' : 'Copy'}
          title={copied ? 'Copied' : 'Copy'}
          className="grid size-6 place-items-center rounded-[calc(var(--radius)*0.5)] text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          {copied ? <CheckIcon size={13} /> : <CopyIcon size={13} />}
        </button>
      ) : null}
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
  running?: boolean | undefined
  status?: SessionStatus | undefined
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
function Thinking({ text, streaming = false }: { text: string; streaming?: boolean }) {
  const [open, setOpen] = useState(false)

  return (
    <div className="py-0.5 text-[13px] text-muted-foreground">
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
          {streaming ? (
            <p data-selectable className="whitespace-pre-wrap">
              {text}
            </p>
          ) : (
            <Markdown>{text}</Markdown>
          )}
        </div>
      )}
    </div>
  )
}

/**
 * Consecutive tool calls, folded into one row of the transcript.
 *
 * Thinking that sits between those calls stays inside the same run so an
 * exploration does not become a tower of one-line cards. A single call with
 * no thinking stays a compact line.
 */
const ToolRun = memo(function ToolRun({
  entries,
  settled = false,
}: {
  entries: RunEntry[]
  settled?: boolean
}) {
  const tools = entries.filter((entry): entry is ToolBlock => entry.kind === 'tool')
  if (tools.length === 1 && entries.length === 1) {
    return <Tool block={tools[0]!} settled={settled} />
  }
  return <ToolGroup entries={entries} settled={settled} />
})

function ToolGroup({ entries, settled = false }: { entries: RunEntry[]; settled?: boolean }) {
  const tools = entries.filter((entry): entry is ToolBlock => entry.kind === 'tool')
  const live = !settled && tools.some((tool) => tool.result === undefined)
  const failed = tools.some((tool) => tool.result?.isError === true)
  const [userOpen, setUserOpen] = useState<boolean | null>(null)
  const open = userOpen ?? live
  const label = groupLabel(tools, settled)
  const running = tools.find((tool) => tool.result === undefined && !settled)

  return (
    <div className="text-[13px] text-muted-foreground">
      <button
        type="button"
        onClick={() => setUserOpen((value) => !(value ?? live))}
        aria-expanded={open}
        aria-label={open ? `Hide ${label}` : `Show ${label}`}
        className="flex w-full min-w-0 items-center gap-1.5 py-0.5 text-left hover:text-foreground"
      >
        {open ? (
          <ChevronDownIcon size={13} className="flex-none text-muted-foreground" />
        ) : (
          <ChevronRightIcon size={13} className="flex-none text-muted-foreground" />
        )}
        <span className="min-w-0 flex-1 truncate">{label}</span>
        {live && running && (
          <DukeLive
            mood={orbStateForTool(running.name)}
            size={20}
            className="flex-none"
            label={`${running.name} running`}
          />
        )}
        {failed && <span className="flex-none text-[12px] text-destructive">failed</span>}
      </button>

      {open && (
        <div className="mt-1 flex flex-col">
          {entries.map((entry) =>
            entry.kind === 'tool' ? (
              <Tool key={entry.id} block={entry} settled={settled} />
            ) : (
              <Thinking
                key={entry.id}
                text={entry.text}
                streaming={!settled && entry === entries.at(-1)}
              />
            ),
          )}
        </div>
      )}
    </div>
  )
}

/**
 * A tool call with its outcome.
 *
 * One compact line: an icon, a short verb, and the target. Output stays
 * behind a click — a session doing real work makes dozens of these.
 */
function Tool({ block, settled }: { block: ToolBlock; settled?: boolean }) {
  const [open, setOpen] = useState(false)
  const running = block.result === undefined && !settled
  const failed = block.result?.isError === true
  const verb = toolVerb(block.name)
  const summary = summarize(block.input)

  return (
    <div className="text-[13px]">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-label={open ? `Hide ${block.name}` : `Show ${block.name}`}
        className="flex w-full min-w-0 items-center gap-2 py-1 text-left"
      >
        <ToolGlyph name={block.name} />
        <span className="font-medium">{verb}</span>
        {summary ? (
          <span className="min-w-0 flex-1 truncate text-muted-foreground">{summary}</span>
        ) : (
          <span className="min-w-0 flex-1" />
        )}

        {running && (
          <DukeLive
            mood={orbStateForTool(block.name)}
            size={20}
            className="flex-none"
            label={`${block.name} running`}
          />
        )}
        {failed && <span className="flex-none text-[12px] text-destructive">failed</span>}
      </button>

      {open && running && (
        <p className="px-5 pb-1.5 text-[12.5px] text-muted-foreground">Running…</p>
      )}

      {open && block.result && (
        <pre
          data-selectable
          className="mb-1.5 max-h-80 overflow-auto rounded-[var(--radius)] border border-border bg-surface px-3 py-2.5 font-mono text-[12px] whitespace-pre-wrap text-muted-foreground"
        >
          {block.result.output || '(no output)'}
        </pre>
      )}
    </div>
  )
}

function ToolGlyph({ name }: { name: string }) {
  const className = 'flex-none text-muted-foreground'
  switch (toolCategory(name)) {
    case 'searching':
      return <SearchIcon size={13} className={className} />
    case 'shaping':
      return <EditIcon size={13} className={className} />
    case 'working':
      return <TerminalIcon size={13} className={className} />
    case 'connecting':
      return <GlobeIcon size={13} className={className} />
    default:
      return <FileIcon size={13} className={className} />
  }
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
  // A plan with a body is answered from its workspace tab, where it can be
  // read. Two sets of buttons for one answer would only drift apart, so the
  // transcript keeps the record and points at the panel. A plan that arrived
  // without a body has nothing to show there, and keeps its card.
  const inWorkspace = isPlanExit && planFromDetail(block.detail) !== null

  useEffect(() => {
    if (answered || disabled || inWorkspace) return
    allow.current?.focus()
  }, [answered, disabled, inWorkspace])

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

  if (inWorkspace) {
    return <p className="text-[13px] text-muted-foreground">The plan is ready in the workspace.</p>
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
      <DukeLive mood={state} size={28} decorative />
    </div>
  )
}

/**
 * Consecutive tools become one transcript row. Thinking between those tools
 * stays inside the same run — otherwise every "thought for a moment" splits
 * an exploration into a stack of one-line cards.
 *
 * Presentation only — the protocol reducer still stores one block per call.
 */
function groupTranscriptItems(blocks: Block[]): TranscriptItem[] {
  const items: TranscriptItem[] = []
  let run: Extract<TranscriptItem, { kind: 'run' }> | undefined

  const flushRun = () => {
    if (!run) return
    const hasTool = run.entries.some((entry) => entry.kind === 'tool')
    if (hasTool) items.push(run)
    else {
      for (const entry of run.entries) {
        if (entry.kind === 'thinking') items.push({ kind: 'block', block: entry })
      }
    }
    run = undefined
  }

  for (const block of blocks) {
    if (block.kind === 'tool' || block.kind === 'thinking') {
      if (!run) run = { kind: 'run', id: block.id, entries: [] }
      run.entries.push(block)
      continue
    }
    flushRun()
    items.push({ kind: 'block', block })
  }
  flushRun()
  return items
}

type RunEntry = ToolBlock | Extract<Block, { kind: 'thinking' }>

type TranscriptItem =
  | { kind: 'block'; block: Exclude<Block, ToolBlock> }
  | { kind: 'run'; id: string; entries: RunEntry[] }

/** Short verb for a tool row. The original name stays on the aria-label. */
function toolVerb(name: string): string {
  const key = name.toLowerCase()
  if (/read/.test(key)) return 'Read'
  if (/search|grep|glob|find|list|ls|look/.test(key)) return 'Searched'
  if (/write|edit|apply|patch|create|update|str_replace|strreplace/.test(key)) return 'Edited'
  if (/bash|shell|terminal|exec|run_command|command/.test(key)) return 'Ran'
  if (/fetch|http|web|url|browser|download/.test(key)) return 'Fetched'
  return name
}

function groupLabel(tools: ToolBlock[], settled: boolean): string {
  const running = settled ? undefined : tools.find((tool) => tool.result === undefined)
  if (running) {
    const verb = toolVerb(running.name)
    const target = summarize(running.input)
    return target ? `${verb} ${target}` : verb
  }

  if (tools.length === 1) {
    const tool = tools[0]!
    const verb = toolVerb(tool.name)
    const target = summarize(tool.input)
    return target ? `${verb} ${target}` : verb
  }

  const categories = new Set(tools.map((tool) => toolCategory(tool.name)))
  const count = tools.length
  if (categories.size === 1) {
    switch ([...categories][0]) {
      case 'searching':
        return `Explored ${count} files`
      case 'working':
        return `Ran ${count} commands`
      case 'shaping':
        return `Edited ${count} files`
      case 'connecting':
        return `Fetched ${count} URLs`
    }
  }

  return `${count} actions`
}

/**
 * The one detail worth showing next to a tool name.
 *
 * Tool inputs vary by agent and by tool, so this looks for the fields that
 * carry meaning and falls back to nothing rather than dumping JSON into a line
 * that has to stay one line. Paths shrink to the basename so a long tree
 * does not eat the row.
 */
function summarize(input: unknown): string {
  if (typeof input === 'string') return basenameIfPath(input)
  if (typeof input !== 'object' || input === null) return ''

  const record = input as Record<string, unknown>
  for (const key of ['file_path', 'path', 'command', 'pattern', 'query', 'url']) {
    const value = record[key]
    if (typeof value !== 'string' || !value) continue
    if (key === 'file_path' || key === 'path') return basenameIfPath(value)
    return value
  }

  return ''
}

function basenameIfPath(value: string): string {
  if (/\s/.test(value)) return value
  if (!/[/\\]/.test(value)) return value
  return value.split(/[/\\]/).pop() || value
}
