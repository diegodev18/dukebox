import { useMemo, useState } from 'react'
import { Palette, PaletteOption } from '@/components/Palette'
import type { Command } from '@/lib/commands'
import { filterCommands } from '@/lib/commands'

/**
 * The command palette: Ctrl/Cmd+Shift+P.
 *
 * A searchable menu of app commands — reload, theme, git preferences. Same
 * centred modal as the search palette, but for actions rather than the things
 * a person navigates to. It is presentational on purpose: what a command does
 * is the caller's job, so the caller passes `onRun`.
 */

interface Props {
  commands: Command[]
  onRun: (command: Command) => void
  onDismiss: () => void
}

export function CommandPalette({ commands, onRun, onDismiss }: Props) {
  const [query, setQuery] = useState('')
  const items = useMemo(() => filterCommands(query, commands), [query, commands])

  return (
    <Palette
      title="Commands"
      placeholder="Search commands…"
      inputLabel="Search commands"
      listboxLabel="Commands"
      query={query}
      onQueryChange={setQuery}
      itemCount={items.length}
      optionId={(index) => `command-item-${items[index]!.id}`}
      empty={`No commands for “${query.trim()}”.`}
      footer={
        <>
          <span>↑↓ Select</span>
          <span>↵ Run</span>
        </>
      }
      onDismiss={onDismiss}
      onConfirm={(index) => {
        const command = items[index]
        if (!command) return
        onRun(command)
        onDismiss()
      }}
    >
      {({ selectedIndex, setSelectedIndex }) =>
        items.map((command, index) => (
          <PaletteOption
            key={command.id}
            id={`command-item-${command.id}`}
            active={selectedIndex === index}
            onMouseEnter={() => setSelectedIndex(index)}
            onClick={() => {
              onRun(command)
              onDismiss()
            }}
          >
            <span className="min-w-0 flex-1 truncate">{command.label}</span>
            {command.detail && (
              <span className="flex-none text-[12px] text-muted-foreground">{command.detail}</span>
            )}
          </PaletteOption>
        ))
      }
    </Palette>
  )
}
