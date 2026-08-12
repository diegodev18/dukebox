import type { EnvironmentSummary, OpencodeProvider, PermissionMode } from '@dukebox/protocol'
import { useEffect, useRef, useState } from 'react'
import {
  AgentIcon,
  AVAILABLE_AGENTS,
  AVAILABLE_MODELS,
  AVAILABLE_PERMISSION_MODES,
  agentLabel,
  modelLabel,
  permissionModeLabel,
} from '@/components/AgentIcon'
import { CheckIcon, ChevronDownIcon, FolderIcon, ServerIcon } from '@/components/icons'

/**
 * Chip + searchable popover menus for picking a repository, branch, agent, or
 * model.
 *
 * Anchored under the chip that opened them. Escape, an outside click, and
 * choosing a row close the menu. Arrow keys move the highlight; Enter picks.
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
        Repositories
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
              icon={<FolderIcon size={14} />}
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

/** Sentinel for "no environment": the base image, with no override. */
export const BASE_IMAGE_VALUE = ''

/**
 * Which environment the session runs in.
 *
 * Only environments whose pattern covers the chosen branch are listed — an
 * environment that cannot apply is not a choice. The base image closes the
 * list as the always-available fallback, so there is never a dead end.
 */
export function EnvironmentPicker({
  environments,
  value,
  onChange,
  disabled,
}: {
  environments: EnvironmentSummary[]
  value: string
  onChange: (value: string) => void
  disabled?: boolean
}) {
  const [open, setOpen] = useState(false)
  const selected = environments.find((environment) => environment.id === value)

  return (
    <PickerShell
      open={open}
      onOpenChange={setOpen}
      disabled={Boolean(disabled)}
      label={<span className="truncate">{selected?.name ?? 'Base image'}</span>}
      ariaLabel="Environment"
    >
      <div className="max-h-64 overflow-y-auto py-1">
        {environments.map((environment) => (
          <PickerRow
            key={environment.id}
            selected={environment.id === value}
            onSelect={() => {
              onChange(environment.id)
              setOpen(false)
            }}
          >
            <span className="truncate">{environment.name}</span>
            <span className="ml-auto shrink-0 font-mono text-[11px] text-muted-foreground">
              {environment.branchPattern}
            </span>
          </PickerRow>
        ))}

        <PickerRow
          selected={value === BASE_IMAGE_VALUE}
          onSelect={() => {
            onChange(BASE_IMAGE_VALUE)
            setOpen(false)
          }}
        >
          <span className="truncate">No environment (base image)</span>
        </PickerRow>
      </div>
    </PickerShell>
  )
}

/**
 * Which VPS the sandbox will run on.
 *
 * Dukebox is self-hosted and nothing stops an owner from running more than one
 * server, so the session has to say where it lands rather than assuming there
 * is only ever one place it could.
 *
 * Only the connected instance is listed today, and it cannot be changed —
 * registering additional instances comes with the settings panel. The chip
 * still earns its place: it makes the destination visible at the moment the
 * session is created, which is the only moment it is cheap to notice.
 */
export function InstancePicker({
  instances,
  value,
  disabled,
}: {
  instances: { id: string; name: string; host: string }[]
  value: string
  disabled?: boolean
}) {
  const [open, setOpen] = useState(false)
  const selected = instances.find((instance) => instance.id === value)

  return (
    <PickerShell
      open={open}
      onOpenChange={setOpen}
      disabled={disabled || instances.length === 0}
      label={
        <span className="inline-flex items-center gap-1.5">
          <ServerIcon size={14} className="flex-none" />
          <span className="truncate">{selected?.name ?? 'Instance'}</span>
        </span>
      }
      ariaLabel="Instance"
    >
      <div className="max-h-64 overflow-y-auto py-1">
        {instances.map((instance) => (
          <PickerRow
            key={instance.id}
            selected={instance.id === value}
            // Inert: there is nothing else to switch to yet, and closing the
            // menu is the honest response to picking what is already in use.
            onSelect={() => setOpen(false)}
            icon={<ServerIcon size={14} className="flex-none" />}
          >
            <span className="min-w-0 flex-1">
              <span className="block truncate">{instance.name}</span>
              <span className="block truncate font-mono text-[11px] text-muted-foreground">
                {instance.host}
              </span>
            </span>
          </PickerRow>
        ))}
      </div>

      <div className="border-t border-border py-1">
        <button
          type="button"
          disabled
          className="w-full px-3 py-1.5 text-left text-[13px] opacity-40"
        >
          Add instance…
        </button>
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

export function ProviderPicker({
  providers,
  value,
  onChange,
  onAddProvider,
  disabled,
}: {
  providers: OpencodeProvider[]
  value: string
  onChange: (providerId: string) => void
  onAddProvider: () => void
  disabled?: boolean
}) {
  const [open, setOpen] = useState(false)
  const selected = providers.find((provider) => provider.id === value)

  return (
    <PickerShell
      open={open}
      onOpenChange={setOpen}
      disabled={Boolean(disabled)}
      label={<span className="truncate">{selected?.name ?? 'Provider'}</span>}
      ariaLabel="Provider"
    >
      <div className="max-h-64 overflow-y-auto py-1">
        {providers.map((provider) => (
          <PickerRow
            key={provider.id}
            selected={provider.id === value}
            onSelect={() => {
              onChange(provider.id)
              setOpen(false)
            }}
          >
            <span className="truncate">{provider.name}</span>
          </PickerRow>
        ))}
      </div>

      <div className="border-t border-border py-1">
        <button
          type="button"
          onClick={() => {
            setOpen(false)
            onAddProvider()
          }}
          className="w-full px-3 py-1.5 text-left text-[13px] hover:bg-muted"
        >
          Add provider…
        </button>
      </div>
    </PickerShell>
  )
}

export function ModelPicker({
  value,
  onChange,
  disabled,
  models = AVAILABLE_MODELS,
}: {
  value: string
  onChange: (modelId: string) => void
  disabled?: boolean
  models?: readonly { id: string; label: string }[]
}) {
  const [open, setOpen] = useState(false)
  const label = models.find((model) => model.id === value)?.label ?? modelLabel(value) ?? value

  return (
    <PickerShell
      open={open}
      onOpenChange={setOpen}
      disabled={Boolean(disabled) || models.length === 0}
      label={<span className="truncate">{label || 'Model'}</span>}
      ariaLabel="Model"
    >
      <div className="max-h-64 overflow-y-auto py-1">
        {models.map((model) => (
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

export function PermissionModePicker({
  value,
  onChange,
  disabled,
}: {
  value: PermissionMode
  onChange: (mode: PermissionMode) => void
  disabled?: boolean
}) {
  const [open, setOpen] = useState(false)
  const label = permissionModeLabel(value) ?? value

  return (
    <PickerShell
      open={open}
      onOpenChange={setOpen}
      disabled={Boolean(disabled)}
      label={<span className="truncate">{label || 'Mode'}</span>}
      ariaLabel="Permission mode"
    >
      <div className="max-h-64 overflow-y-auto py-1">
        {AVAILABLE_PERMISSION_MODES.map((mode) => (
          <PickerRow
            key={mode.id}
            selected={mode.id === value}
            onSelect={() => {
              onChange(mode.id)
              setOpen(false)
            }}
          >
            <span className="truncate">{mode.label}</span>
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

    const options = () =>
      Array.from(root.current?.querySelectorAll<HTMLElement>('[role="option"]') ?? [])

    const highlight = (index: number) => {
      const items = options()
      items.forEach((item, i) => {
        if (i === index) item.setAttribute('data-highlighted', '')
        else item.removeAttribute('data-highlighted')
      })
      items[index]?.scrollIntoView?.({ block: 'nearest' })
    }

    const highlightedIndex = () => {
      const items = options()
      const marked = items.findIndex((item) => item.hasAttribute('data-highlighted'))
      if (marked >= 0) return marked
      return items.findIndex((item) => item.getAttribute('aria-selected') === 'true')
    }

    const selected = highlightedIndex()
    highlight(selected >= 0 ? selected : 0)

    const onPointerDown = (event: PointerEvent) => {
      if (root.current && !root.current.contains(event.target as Node)) {
        close.current(false)
      }
    }

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        close.current(false)
        return
      }

      // Arrow/Enter belong to the field the person is in, unless that field
      // is this picker — a composer behind an open menu still needs Enter to
      // send.
      if (!root.current?.contains(event.target as Node)) return

      const items = options()
      if (items.length === 0) return

      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault()
        const current = highlightedIndex()
        const from = current >= 0 ? current : event.key === 'ArrowDown' ? -1 : 0
        const delta = event.key === 'ArrowDown' ? 1 : -1
        highlight((from + delta + items.length) % items.length)
        return
      }

      if (event.key === 'Home') {
        event.preventDefault()
        highlight(0)
        return
      }

      if (event.key === 'End') {
        event.preventDefault()
        highlight(items.length - 1)
        return
      }

      if (event.key === 'Enter') {
        const current = highlightedIndex()
        const item = items[current >= 0 ? current : 0]
        if (!item) return
        event.preventDefault()
        item.click()
      }
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
        <ChevronDownIcon size={14} className="shrink-0 opacity-70" />
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
      className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[13px] hover:bg-muted aria-selected:bg-muted data-[highlighted]:bg-muted"
    >
      {icon && <span className="shrink-0 text-muted-foreground">{icon}</span>}
      <span className="flex min-w-0 flex-1 items-center gap-2">{children}</span>
      {selected && (
        <span className="shrink-0 text-foreground">
          <CheckIcon size={14} />
        </span>
      )}
    </button>
  )
}
