import type { SessionSummary, WorkspaceFileResponse } from '@dukebox/protocol'
import { useEffect, useMemo, useRef, useState, type CSSProperties, type RefObject } from 'react'
import type { DukeboxClient } from '@/lib/client'
import { buildFileTree, type FileTreeNode } from '@/lib/fileTree'
import { tokensForCode, type HighlightToken } from '@/lib/syntaxHighlight'
import { VirtualRows } from '@/components/VirtualRows'
import {
  ChevronDownIcon,
  ChevronRightIcon,
  FileIcon,
  FolderIcon,
  RefreshIcon,
} from '@/components/icons'

/**
 * Browse the files in a session's sandbox.
 *
 * A tree of the working tree, not the session's diffs — those live on Changes.
 * Read-only: opening a file shows its contents, and that is all.
 */

interface Props {
  client?: DukeboxClient | null
  session: SessionSummary | null
  /**
   * Changes when the agent edits files, so the tree refetches without the
   * person having to press refresh.
   */
  revision: string
}

export function SandboxFiles({ client, session, revision }: Props) {
  const [paths, setPaths] = useState<string[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [openDirs, setOpenDirs] = useState<ReadonlySet<string>>(() => new Set())
  const [tick, setTick] = useState(0)

  const sessionId = session?.id ?? null

  useEffect(() => {
    if (!client || !sessionId) {
      setPaths([])
      setError(null)
      setLoading(false)
      return
    }

    let cancelled = false
    setLoading(true)
    setError(null)

    client
      .listWorkspaceTree(sessionId)
      .then((found) => {
        if (cancelled) return
        setPaths(found)
        setLoading(false)
      })
      .catch((cause: unknown) => {
        if (cancelled) return
        setPaths([])
        setError(cause instanceof Error ? cause.message : 'Could not load files.')
        setLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [client, sessionId, revision, tick])

  useEffect(() => {
    setSelected(null)
    setOpenDirs(new Set())
  }, [sessionId])

  const tree = useMemo(() => buildFileTree(paths), [paths])

  if (!session || !client) {
    return (
      <p className="px-4 py-4 text-[12.5px] text-muted-foreground">
        Select a session to browse its files.
      </p>
    )
  }

  if (loading && paths.length === 0 && !error) {
    return (
      <p role="status" className="px-4 py-4 text-[12.5px] text-muted-foreground">
        Loading files…
      </p>
    )
  }

  if (error && paths.length === 0) {
    return (
      <div className="flex min-h-0 flex-1 flex-col items-start gap-2.5 px-4 py-4">
        <p className="text-[12.5px] text-muted-foreground">{error}</p>
        <button
          type="button"
          onClick={() => setTick((value) => value + 1)}
          className="rounded-[calc(var(--radius)*0.6)] bg-muted px-2.5 py-1.5 text-[12.5px] font-medium hover:bg-border"
        >
          Try again
        </button>
      </div>
    )
  }

  if (paths.length === 0) {
    return (
      <p className="px-4 py-4 text-[12.5px] text-muted-foreground">
        No files in this workspace yet.
      </p>
    )
  }

  const toggleDir = (path: string) => {
    setOpenDirs((current) => {
      const next = new Set(current)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-1 border-b border-border px-2 py-1.5">
        <span className="min-w-0 flex-1 truncate px-1.5 text-[12.5px] text-muted-foreground">
          {selected ?? 'Workspace'}
        </span>
        <button
          type="button"
          onClick={() => setTick((value) => value + 1)}
          aria-label="Refresh files"
          className="grid size-6 place-items-center rounded-[calc(var(--radius)*0.6)] text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <RefreshIcon size={13} />
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-auto py-1">
        {tree.map((node) => (
          <TreeRow
            key={node.path}
            node={node}
            depth={0}
            openDirs={openDirs}
            selected={selected}
            onToggleDir={toggleDir}
            onSelectFile={setSelected}
          />
        ))}
      </div>

      {selected && <FilePreview client={client} sessionId={session.id} path={selected} />}
    </div>
  )
}

function TreeRow({
  node,
  depth,
  openDirs,
  selected,
  onToggleDir,
  onSelectFile,
}: {
  node: FileTreeNode
  depth: number
  openDirs: ReadonlySet<string>
  selected: string | null
  onToggleDir: (path: string) => void
  onSelectFile: (path: string) => void
}) {
  const padding = 8 + depth * 12

  if (node.kind === 'dir') {
    const open = openDirs.has(node.path)

    return (
      <div>
        <button
          type="button"
          onClick={() => onToggleDir(node.path)}
          aria-expanded={open}
          aria-label={node.name}
          style={{ paddingLeft: padding }}
          className="flex w-full min-w-0 items-center gap-1.5 py-0.5 pr-3 text-left text-[12.5px] hover:bg-muted"
        >
          {open ? (
            <ChevronDownIcon size={13} className="flex-none text-muted-foreground" />
          ) : (
            <ChevronRightIcon size={13} className="flex-none text-muted-foreground" />
          )}
          <FolderIcon size={13} className="flex-none text-muted-foreground" />
          <span className="truncate">{node.name}</span>
        </button>
        {open &&
          node.children.map((child) => (
            <TreeRow
              key={child.path}
              node={child}
              depth={depth + 1}
              openDirs={openDirs}
              selected={selected}
              onToggleDir={onToggleDir}
              onSelectFile={onSelectFile}
            />
          ))}
      </div>
    )
  }

  return (
    <button
      type="button"
      onClick={() => onSelectFile(node.path)}
      aria-current={selected === node.path ? 'true' : undefined}
      aria-label={node.name}
      style={{ paddingLeft: padding }}
      className={`flex w-full min-w-0 items-center gap-1.5 py-0.5 pr-3 text-left text-[12.5px] hover:bg-muted ${
        selected === node.path ? 'bg-muted font-medium' : ''
      }`}
    >
      <span className="size-[13px] flex-none" />
      <FileIcon size={13} className="flex-none text-muted-foreground" />
      <span className="truncate">{node.name}</span>
    </button>
  )
}

function FilePreview({
  client,
  sessionId,
  path,
}: {
  client: DukeboxClient
  sessionId: string
  path: string
}) {
  const [file, setFile] = useState<WorkspaceFileResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  const scroller = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let cancelled = false
    setFile(null)
    setError(null)

    client
      .readWorkspaceFile(sessionId, path)
      .then((loaded) => {
        if (!cancelled) setFile(loaded)
      })
      .catch((cause: unknown) => {
        if (cancelled) return
        setError(cause instanceof Error ? cause.message : 'Could not read that file.')
      })

    return () => {
      cancelled = true
    }
  }, [client, sessionId, path])

  return (
    <div
      ref={scroller}
      className="flex min-h-0 flex-1 flex-col overflow-auto border-t border-border"
    >
      {error ? (
        <p className="px-3 py-2 text-[12.5px] text-muted-foreground">{error}</p>
      ) : !file ? (
        <p role="status" className="px-3 py-2 text-[12.5px] text-muted-foreground">
          Loading…
        </p>
      ) : file.binary ? (
        <p className="px-3 py-2 text-[12.5px] text-muted-foreground">
          This file is binary and cannot be previewed.
        </p>
      ) : (
        <>
          {file.truncated && (
            <p className="px-3 py-1.5 text-[12px] text-muted-foreground">
              File truncated (too large)
            </p>
          )}
          <CodeView path={file.path} content={file.content} scrollRef={scroller} />
        </>
      )}
    </div>
  )
}

function CodeView({
  path,
  content,
  scrollRef,
}: {
  path: string
  content: string
  scrollRef: RefObject<HTMLElement | null>
}) {
  const [lines, setLines] = useState<HighlightToken[][] | null>(null)

  useEffect(() => {
    let cancelled = false
    void tokensForCode(path, content).then((tokens) => {
      if (!cancelled) setLines(tokens)
    })
    return () => {
      cancelled = true
    }
  }, [path, content])

  const rendered: HighlightToken[][] =
    lines ?? content.split('\n').map((text) => [{ content: text || ' ' }])
  const digits = String(Math.max(1, rendered.length)).length

  return (
    <div data-selectable className="inline-block min-w-full font-mono text-[12px] leading-[1.55]">
      <VirtualRows count={rendered.length} scrollRef={scrollRef} estimateSize={19} after={80} wide>
        {(index) => {
          const tokens = rendered[index]!
          return (
            <div className="flex min-w-full">
              <span
                className="flex-none select-none py-0 pr-3 pl-2 text-right tabular-nums text-muted-foreground opacity-60"
                style={{ width: `${digits + 2}ch` }}
              >
                {index + 1}
              </span>
              <span className="flex-1 whitespace-pre pr-3 text-foreground">
                {tokens.map((token, tokenIndex) => (
                  <span
                    key={tokenIndex}
                    className="shiki-token"
                    style={token.style as CSSProperties | undefined}
                  >
                    {token.content}
                  </span>
                ))}
              </span>
            </div>
          )
        }}
      </VirtualRows>
    </div>
  )
}
