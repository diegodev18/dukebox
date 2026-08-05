import { useEffect, useRef, useState } from 'react'
import {
  AgentIcon,
  AVAILABLE_AGENTS,
  AVAILABLE_MODELS,
  agentLabel,
  modelLabel,
} from './AgentIcon.js'

/**
 * Chip + searchable popover menus for picking a repository, branch, agent, or
 * model.
 *
 * Anchored under the chip that opened them. Escape and an outside click close
 * the menu; choosing a row closes it and reports the value.
 */

export function shortRepoName(fullName: string): string {
  const slash = fullName.lastIndexOf('/')
  return slash === -1 ? fullName : fullName.slice(slash + 1)
}

export function RepoPicker({
  options,
  value,
  onChange,
  disabled,
}: {
  options: { fullName: string; isRegistered: boolean }[]
  value: string
  onChange: (fullName: string) => void
  disabled?: boolean
}) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')

  const filtered = options.filter((option) =>
    option.fullName.toLowerCase().includes(query.trim().toLowerCase()),
  )

  return (
    <PickerShell
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (!next) setQuery('')
      }}
      disabled={disabled || options.length === 0}
      label={value ? shortRepoName(value) : 'Repository'}
      ariaLabel="Repository"
    >
      <SearchField
        value={query}
        onChange={setQuery}
        placeholder="Search folders, repos…"
        ariaLabel="Search repositories"
      />

      <p className="px-3 pt-2 pb-1 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
        Recents
      </p>

      <div className="max-h-64 overflow-y-auto pb-1">
        {filtered.length === 0 ? (
          <p className="px-3 py-2 text-[13px] text-muted-foreground">No repositories found</p>
        ) : (
          filtered.map((option) => (
            <PickerRow
              key={option.fullName}
              selected={option.fullName === value}
              onSelect={() => {
                onChange(option.fullName)
                setOpen(false)
                setQuery('')
              }}
              icon={<FolderIcon />}
            >
              <span className="truncate">{option.fullName}</span>
              {!option.isRegistered && (
                <span className="ml-auto shrink-0 text-[11px] text-muted-foreground">new</span>
              )}
            </PickerRow>
          ))
        )}
      </div>
    </PickerShell>
  )
}

export function BranchPicker({
  branches,
  value,
  onChange,
  disabled,
  loading,
}: {
  branches: string[]
  value: string
  onChange: (branch: string) => void
  disabled?: boolean
  loading?: boolean
}) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')

  const filtered = branches.filter((branch) =>
    branch.toLowerCase().includes(query.trim().toLowerCase()),
  )

  return (
    <PickerShell
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (!next) setQuery('')
      }}
      disabled={disabled || (!loading && branches.length === 0)}
      label={value || (loading ? '…' : 'Branch')}
      ariaLabel="Branch"
    >
      <SearchField
        value={query}
        onChange={setQuery}
        placeholder="Search branches…"
        ariaLabel="Search branches"
      />

      <div className="max-h-64 overflow-y-auto py-1">
        {loading ? (
          <p className="px-3 py-2 text-[13px] text-muted-foreground">Loading branches…</p>
        ) : filtered.length === 0 ? (
          <p className="px-3 py-2 text-[13px] text-muted-foreground">No branches found</p>
        ) : (
          filtered.map((branch) => (
            <PickerRow
              key={branch}
              selected={branch === value}
              onSelect={() => {
                onChange(branch)
                setOpen(false)
                setQuery('')
              }}
            >
              <span className="truncate font-mono text-[12.5px]">{branch}</span>
            </PickerRow>
          ))
        )}
      </div>
    </PickerShell>
  )
}

export function AgentPicker({
  value,
  onChange,
  disabled,
}: {
  value: string
  onChange: (agentId: string) => void
  disabled?: boolean
}) {
  const [open, setOpen] = useState(false)
  const label = agentLabel(value) ?? value

  return (
    <PickerShell
      open={open}
      onOpenChange={setOpen}
      disabled={Boolean(disabled)}
      label={
        <span className="inline-flex items-center gap-1.5">
          <AgentIcon agentId={value} className="size-3.5" />
          <span className="truncate">{label || 'Agent'}</span>
        </span>
      }
      ariaLabel="Agent"
    >
      <div className="max-h-64 overflow-y-auto py-1">
        {AVAILABLE_AGENTS.map((agent) => (
          <PickerRow
            key={agent.id}
            selected={agent.id === value}
            onSelect={() => {
              onChange(agent.id)
              setOpen(false)
            }}
            icon={<AgentIcon agentId={agent.id} className="size-3.5" />}
          >
            <span className="truncate">{agent.label}</span>
          </PickerRow>
        ))}
      </div>
    </PickerShell>
  )
}

export function ModelPicker({
  value,
  onChange,
  disabled,
}: {
  value: string
  onChange: (modelId: string) => void
  disabled?: boolean
}) {
  const [open, setOpen] = useState(false)
  const label = modelLabel(value) ?? value

  return (
    <PickerShell
      open={open}
      onOpenChange={setOpen}
      disabled={Boolean(disabled)}
      label={<span className="truncate">{label || 'Model'}</span>}
      ariaLabel="Model"
    >
      <div className="max-h-64 overflow-y-auto py-1">
        {AVAILABLE_MODELS.map((model) => (
          <PickerRow
            key={model.id}
            selected={model.id === value}
            onSelect={() => {
              onChange(model.id)
              setOpen(false)
            }}
          >
            <span className="truncate">{model.label}</span>
          </PickerRow>
        ))}
      </div>
    </PickerShell>
  )
}

function PickerShell({
  open,
  onOpenChange,
  disabled,
  label,
  ariaLabel,
  children,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  disabled?: boolean
  label: React.ReactNode
  ariaLabel: string
  children: React.ReactNode
}) {
  const root = useRef<HTMLDivElement>(null)
  const close = useRef(onOpenChange)
  close.current = onOpenChange

  useEffect(() => {
    if (!open) return

    const onPointerDown = (event: PointerEvent) => {
      if (root.current && !root.current.contains(event.target as Node)) {
        close.current(false)
      }
    }

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close.current(false)
    }

    document.addEventListener('pointerdown', onPointerDown, true)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  return (
    <div ref={root} className="relative">
      <button
        type="button"
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
        onClick={() => onOpenChange(!open)}
        className="inline-flex max-w-48 items-center gap-1 rounded-md px-2 py-1 text-[13px] text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-40"
      >
        <span className="truncate font-medium text-foreground">{label}</span>
        <ChevronIcon />
      </button>

      {open && (
        <div
          role="listbox"
          aria-label={ariaLabel}
          className="absolute top-full left-0 z-50 mt-1.5 w-72 overflow-hidden rounded-[calc(var(--radius)*0.9)] border border-border bg-background shadow-md"
        >
          {children}
        </div>
      )}
    </div>
  )
}

function SearchField({
  value,
  onChange,
  placeholder,
  ariaLabel,
}: {
  value: string
  onChange: (value: string) => void
  placeholder: string
  ariaLabel: string
}) {
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  return (
    <div className="border-b border-border px-2 py-2">
      <input
        ref={inputRef}
        type="search"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        aria-label={ariaLabel}
        className="w-full rounded-[calc(var(--radius)*0.6)] border border-border-strong bg-surface px-2.5 py-1.5 text-[13px] outline-none placeholder:text-muted-foreground"
      />
    </div>
  )
}

function PickerRow({
  selected,
  onSelect,
  icon,
  children,
}: {
  selected: boolean
  onSelect: () => void
  icon?: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      role="option"
      aria-selected={selected}
      onClick={onSelect}
      className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[13px] hover:bg-muted aria-selected:bg-muted"
    >
      {icon && <span className="shrink-0 text-muted-foreground">{icon}</span>}
      <span className="flex min-w-0 flex-1 items-center gap-2">{children}</span>
      {selected && (
        <span className="shrink-0 text-foreground">
          <CheckIcon />
        </span>
      )}
    </button>
  )
}

function ChevronIcon() {
  return (
    <svg
      className="size-3.5 shrink-0 opacity-70"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <path d="M4.5 6.5 8 10l3.5-3.5" />
    </svg>
  )
}

function CheckIcon() {
  return (
    <svg
      className="size-3.5"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <path d="M3.5 8.5 6.5 11.5 12.5 4.5" />
    </svg>
  )
}

function FolderIcon() {
  return (
    <svg
      className="size-3.5"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M2.5 4.5h4l1.2 1.2H13.5v7.3a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1V5.5a1 1 0 0 1 1-1Z" />
    </svg>
  )
}
