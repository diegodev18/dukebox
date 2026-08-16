import { type ReactNode, useEffect, useRef, useState } from 'react'
import { SearchIcon } from '@/components/icons'

/**
 * Shared chrome for the command and search palettes.
 *
 * Both are the same centred dialog — veil, query field, list, footer hints —
 * and they must trap Tab and swallow Escape the same way. The catalogues stay
 * separate; this is only the shell so those interactions cannot drift.
 */

export interface PaletteTab {
  id: string
  label: string
}

interface Props {
  title: string
  placeholder: string
  inputLabel: string
  listboxLabel: string
  query: string
  onQueryChange: (query: string) => void
  /** Extra value that, with the query, resets the highlight to the first row. */
  resetKey?: unknown
  itemCount: number
  optionId: (index: number) => string
  empty: ReactNode
  footer: ReactNode
  tabs?: {
    value: string
    options: readonly PaletteTab[]
    onChange: (id: string) => void
    label?: string
  }
  onDismiss: () => void
  onConfirm: (index: number) => void
  onKeyDown?: (event: KeyboardEvent) => boolean | void
  children: (state: {
    selectedIndex: number
    setSelectedIndex: (index: number) => void
  }) => ReactNode
}

export function Palette({
  title,
  placeholder,
  inputLabel,
  listboxLabel,
  query,
  onQueryChange,
  resetKey,
  itemCount,
  optionId,
  empty,
  footer,
  tabs,
  onDismiss,
  onConfirm,
  onKeyDown,
  children,
}: Props) {
  const [selectedIndex, setSelectedIndex] = useState(0)

  const panel = useRef<HTMLDivElement>(null)
  const input = useRef<HTMLInputElement>(null)
  const selectedIndexRef = useRef(selectedIndex)
  const itemCountRef = useRef(itemCount)
  const dismiss = useRef(onDismiss)
  const confirm = useRef(onConfirm)
  const extraKeyDown = useRef(onKeyDown)

  selectedIndexRef.current = selectedIndex
  itemCountRef.current = itemCount
  dismiss.current = onDismiss
  confirm.current = onConfirm
  extraKeyDown.current = onKeyDown

  const titleId = `${slug(title)}-palette-title`
  const listboxId = `${slug(title)}-palette-results`
  const selected =
    selectedIndex >= 0 && selectedIndex < itemCount ? optionId(selectedIndex) : undefined

  useEffect(() => {
    setSelectedIndex(0)
  }, [query, resetKey])

  useEffect(() => {
    const node = panel.current?.querySelector<HTMLElement>('[aria-selected="true"]')
    node?.scrollIntoView?.({ block: 'nearest' })
  }, [selectedIndex, itemCount])

  useEffect(() => {
    input.current?.focus()

    const focusable = () => {
      const nodes = panel.current?.querySelectorAll<HTMLElement>(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
      )
      return nodes ? Array.from(nodes) : []
    }

    const onDocumentKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        event.stopImmediatePropagation()
        dismiss.current()
        return
      }

      if (extraKeyDown.current?.(event)) return

      if (event.key === 'ArrowDown') {
        event.preventDefault()
        setSelectedIndex((current) => {
          const last = Math.max(0, itemCountRef.current - 1)
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
        if (itemCountRef.current === 0) return
        event.preventDefault()
        confirm.current(selectedIndexRef.current)
        return
      }

      if (event.key !== 'Tab') return

      const nodes = focusable()
      if (nodes.length === 0) {
        event.preventDefault()
        panel.current?.focus()
        return
      }

      const first = nodes[0]!
      const last = nodes[nodes.length - 1]!
      const active = document.activeElement

      if (event.shiftKey && (active === first || active === panel.current)) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && (active === last || active === panel.current)) {
        event.preventDefault()
        first.focus()
      }
    }

    document.addEventListener('keydown', onDocumentKeyDown)
    return () => document.removeEventListener('keydown', onDocumentKeyDown)
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
        aria-labelledby={titleId}
        tabIndex={-1}
        className="flex w-full max-w-xl flex-col overflow-hidden rounded-[calc(var(--radius)*1.1)] border border-border bg-background/95 shadow-lg outline-none backdrop-blur-md"
      >
        <h2 id={titleId} className="sr-only">
          {title}
        </h2>

        <div className="flex items-center gap-2 border-b border-border px-3.5 py-2.5">
          <span className="text-muted-foreground">
            <SearchIcon size={16} />
          </span>
          <input
            ref={input}
            type="search"
            value={query}
            onChange={(event) => onQueryChange(event.target.value)}
            placeholder={placeholder}
            aria-label={inputLabel}
            aria-controls={listboxId}
            aria-activedescendant={selected}
            className="min-w-0 flex-1 bg-transparent text-[14px] outline-none placeholder:text-muted-foreground"
          />
        </div>

        {tabs && (
          <div
            role="tablist"
            aria-label={tabs.label ?? 'Filter'}
            className="flex flex-wrap gap-1 border-b border-border px-3 py-2"
          >
            {tabs.options.map((tab) => (
              <button
                key={tab.id}
                type="button"
                role="tab"
                aria-selected={tabs.value === tab.id}
                onClick={() => {
                  tabs.onChange(tab.id)
                  input.current?.focus()
                }}
                className={`rounded-full px-2.5 py-0.5 text-[12px] ${
                  tabs.value === tab.id
                    ? 'bg-muted font-medium text-foreground'
                    : 'text-muted-foreground hover:bg-muted/70 hover:text-foreground'
                }`}
              >
                {tab.label}
              </button>
            ))}
          </div>
        )}

        <div
          id={listboxId}
          role="listbox"
          aria-label={listboxLabel}
          className="min-h-0 max-h-[min(24rem,50vh)] flex-1 overflow-y-auto py-1.5"
        >
          {itemCount === 0 ? (
            <p className="px-4 py-6 text-center text-[13px] text-muted-foreground">{empty}</p>
          ) : (
            children({ selectedIndex, setSelectedIndex })
          )}
        </div>

        <div className="flex flex-wrap gap-x-3.5 gap-y-1 border-t border-border px-3.5 py-2 text-[11px] text-muted-foreground">
          {footer}
        </div>
      </div>
    </div>
  )
}

export function PaletteOption({
  id,
  active,
  onMouseEnter,
  onClick,
  children,
}: {
  id: string
  active: boolean
  onMouseEnter: () => void
  onClick: () => void
  children: ReactNode
}) {
  return (
    <button
      type="button"
      id={id}
      role="option"
      aria-selected={active}
      onMouseEnter={onMouseEnter}
      onClick={onClick}
      className={`flex w-full items-center gap-2.5 rounded-[calc(var(--radius)*0.7)] px-2 py-1.5 text-left text-[13px] ${
        active ? 'bg-muted text-foreground' : 'text-foreground hover:bg-muted/60'
      }`}
    >
      <span
        className={`size-1.5 flex-none rounded-full ${active ? 'bg-primary' : 'bg-transparent'}`}
      />
      {children}
    </button>
  )
}

function slug(title: string): string {
  return title.trim().toLowerCase().replace(/\s+/g, '-')
}
