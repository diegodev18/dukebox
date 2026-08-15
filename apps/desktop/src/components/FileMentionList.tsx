import { useEffect, useRef } from 'react'
import { FileIcon } from '@/components/icons'
import { fileDirOf, fileNameOf } from '@/lib/fileMentions'
import type { FileTreeStatus } from '@/lib/useFileTree'

/**
 * The list that opens while someone types `@` in a prompt.
 *
 * A compact listbox above the field, not a second search palette: the person
 * is mid-sentence and should stay in the composer.
 */

interface Props {
  items: readonly string[]
  selectedIndex: number
  status: FileTreeStatus
  onSelect: (path: string) => void
  onHighlight: (index: number) => void
}

export function FileMentionList({ items, selectedIndex, status, onSelect, onHighlight }: Props) {
  const list = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const node = list.current?.querySelector<HTMLElement>('[aria-selected="true"]')
    node?.scrollIntoView?.({ block: 'nearest' })
  }, [selectedIndex, items])

  let empty: string | null = null
  if (items.length === 0) {
    if (status === 'loading') empty = 'Loading files…'
    else if (status === 'failed') empty = 'Could not load files. Sync files to retry.'
    else empty = 'No matching files'
  }

  return (
    <div
      ref={list}
      role="listbox"
      aria-label="Files"
      className="absolute inset-x-0 bottom-full z-20 mb-1 max-h-56 overflow-y-auto rounded-[calc(var(--radius)*0.8)] border border-border bg-background py-1 shadow-md"
    >
      {empty ? (
        <p role="status" className="px-3 py-2 text-[12.5px] text-muted-foreground">
          {empty}
        </p>
      ) : (
        items.map((path, index) => {
          const active = index === selectedIndex
          const dir = fileDirOf(path)
          return (
            <button
              key={path}
              type="button"
              role="option"
              aria-selected={active}
              onMouseEnter={() => onHighlight(index)}
              onMouseDown={(event) => {
                // Prevent the textarea from taking the click and closing the
                // list before the path is inserted.
                event.preventDefault()
                onSelect(path)
              }}
              className={`flex w-full min-w-0 items-center gap-2 px-3 py-1.5 text-left text-[12.5px] ${
                active ? 'bg-muted text-foreground' : 'hover:bg-muted/60'
              }`}
            >
              <FileIcon size={13} className="flex-none text-muted-foreground" />
              <span className="min-w-0 truncate font-medium">{fileNameOf(path)}</span>
              {dir ? (
                <span className="min-w-0 truncate text-[11.5px] text-muted-foreground">{dir}</span>
              ) : null}
            </button>
          )
        })
      )}
    </div>
  )
}
