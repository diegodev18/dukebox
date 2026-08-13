import { useEffect, useMemo, useRef, useState } from 'react'
import { RefreshIcon } from '@/components/icons'
import type { Command } from '@/lib/commands'
import { filterCommands } from '@/lib/commands'

/**
 * The command palette: Ctrl/Cmd+Shift+P.
 *
 * A searchable menu of app commands — reload the webview for now, more later.
 * Same centred modal as the search palette, but for actions rather than the
 * things a person navigates to. It is presentational on purpose: what a
 * command does is the caller's job, so the caller passes `onRun`.
 */

interface Props {
  commands: Command[]
  onRun: (command: Command) => void
  onDismiss: () => void
}

export function CommandPalette({ commands, onRun, onDismiss }: Props) {
  const [query, setQuery] = useState('')
  const [selectedIndex, setSelectedIndex] = useState(0)

  const items = useMemo(() => filterCommands(query, commands), [query, commands])
  const selected = items[selectedIndex] ?? null

  const panel = useRef<HTMLDivElement>(null)
  const input = useRef<HTMLInputElement>(null)
  const selectedIndexRef = useRef(selectedIndex)
  const itemsRef = useRef(items)
  const dismiss = useRef(onDismiss)
  const run = useRef(onRun)

  selectedIndexRef.current = selectedIndex
  itemsRef.current = items
  dismiss.current = onDismiss
  run.current = (command) => {
    onRun(command)
    onDismiss()
  }

  useEffect(() => {
    setSelectedIndex(0)
  }, [query])

  useEffect(() => {
    const node = panel.current?.querySelector<HTMLElement>('[aria-selected="true"]')
    node?.scrollIntoView?.({ block: 'nearest' })
  }, [selectedIndex, items])

  useEffect(() => {
    input.current?.focus()

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        dismiss.current()
        return
      }

      if (event.key === 'ArrowDown') {
        event.preventDefault()
        setSelectedIndex((current) => {
          const last = Math.max(0, itemsRef.current.length - 1)
          return Math.min(last, current + 1)
        })
        return
      }

      if (event.key === 'ArrowUp') {
        event.preventDefault()
        setSelectedIndex((current) => Math.max(0, current - 1))
        return
      }

      if (event.key === 'Enter') {
        const item = itemsRef.current[selectedIndexRef.current]
        if (!item) return
        event.preventDefault()
        run.current(item)
      }
    }

    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [])

  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-black/40 p-6"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) onDismiss()
      }}
    >
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby="command-palette-title"
        tabIndex={-1}
        className="flex w-full max-w-xl flex-col overflow-hidden rounded-[calc(var(--radius)*1.1)] border border-border bg-background/95 shadow-lg outline-none backdrop-blur-md"
      >
        <h2 id="command-palette-title" className="sr-only">
          Commands
        </h2>

        <div className="flex items-center gap-2 border-b border-border px-3.5 py-2.5">
          <span className="text-muted-foreground">
            <RefreshIcon size={16} />
          </span>
          <input
            ref={input}
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search commands…"
            aria-label="Search commands"
            aria-controls="command-palette-results"
            aria-activedescendant={selected ? `command-item-${selected.id}` : undefined}
            className="min-w-0 flex-1 bg-transparent text-[14px] outline-none placeholder:text-muted-foreground"
          />
        </div>

        <div
          id="command-palette-results"
          role="listbox"
          aria-label="Commands"
          className="min-h-0 max-h-[min(24rem,50vh)] flex-1 overflow-y-auto py-1.5"
        >
          {items.length === 0 ? (
            <p className="px-4 py-6 text-center text-[13px] text-muted-foreground">
              No commands for “{query.trim()}”.
            </p>
          ) : (
            items.map((command, index) => {
              const active = selected?.id === command.id
              return (
                <button
                  key={command.id}
                  type="button"
                  id={`command-item-${command.id}`}
                  role="option"
                  aria-selected={active}
                  onMouseEnter={() => setSelectedIndex(index)}
                  onClick={() => run.current(command)}
                  className={`flex w-full items-center gap-2.5 rounded-[calc(var(--radius)*0.7)] px-2 py-1.5 text-left text-[13px] ${
                    active ? 'bg-muted text-foreground' : 'text-foreground hover:bg-muted/60'
                  }`}
                >
                  <span
                    className={`size-1.5 flex-none rounded-full ${active ? 'bg-primary' : 'bg-transparent'}`}
                  />
                  <span className="min-w-0 flex-1 truncate">{command.label}</span>
                </button>
              )
            })
          )}
        </div>

        <div className="flex flex-wrap gap-x-3.5 gap-y-1 border-t border-border px-3.5 py-2 text-[11px] text-muted-foreground">
          <span>↑↓ Select</span>
          <span>↵ Run</span>
        </div>
      </div>
    </div>
  )
}
