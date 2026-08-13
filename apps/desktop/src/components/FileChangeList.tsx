import type { FileChange } from '@dukebox/protocol'
import { memo, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Diff, fileChangeCounts, expandedPaths } from '@/components/Diff'
import { ChevronDownIcon, ChevronRightIcon } from '@/components/icons'

/**
 * The files a session changed, and what changed in them.
 *
 * Chrome around the list — workspace tabs, a pull request title — stays put.
 * This is the only scroller: file names stick to the top and left, and the
 * diff moves underneath. A per-file `overflow-x` hid the horizontal bar under
 * the last hunk, so a tall diff had to be scrolled to the bottom before a
 * long line could be read.
 *
 * One list rather than a tree: a session's diff is a handful of files, and a
 * tree of three entries is a widget pretending there is more to navigate than
 * there is.
 */
export const FileChangeList = memo(function FileChangeList({ files }: { files: FileChange[] }) {
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set())
  const panel = useRef<HTMLDivElement>(null)

  // Diffs default to open — the Changes and Pull request tabs exist to review
  // what changed — and a file that arrives later is open too. Only a diff the
  // user collapsed stays closed.
  useEffect(() => {
    setOpen((current) => (files.length === 0 ? new Set() : expandedPaths(current, files)))
  }, [files])

  // Sticky headers need the *visible* panel width. `100%` is the scrolled
  // content, so a long line makes the name as wide as the diff and sticky
  // left does nothing. `clientWidth` is the viewport of this scroller.
  useLayoutEffect(() => {
    const el = panel.current
    if (!el) return
    const sync = () => el.style.setProperty('--workspace-files-width', `${el.clientWidth}px`)
    sync()
    const observer = new ResizeObserver(sync)
    observer.observe(el)
    return () => observer.disconnect()
  }, [files.length])

  return (
    // The inner `w-max` box is as wide as the longest line — without it the
    // file row is only the panel wide, sticky left cannot travel, and the
    // name pans away with the code.
    <div ref={panel} className="min-h-0 flex-1 overflow-auto">
      <div className="w-max min-w-full">
        {files.map((file) => {
          const expanded = open.has(file.path)

          return (
            <div key={file.path} className="border-b border-border last:border-b-0">
              <button
                type="button"
                onClick={() =>
                  setOpen((current) => {
                    const next = new Set(current)
                    if (next.has(file.path)) next.delete(file.path)
                    else next.add(file.path)
                    return next
                  })
                }
                aria-expanded={expanded}
                aria-label={basename(file.path)}
                className="sticky top-0 left-0 z-10 box-border flex w-[var(--workspace-files-width)] min-w-0 items-center gap-2 bg-surface px-3 py-2 text-left text-[12.5px] hover:bg-muted"
              >
                {expanded ? (
                  <ChevronDownIcon size={13} className="flex-none text-muted-foreground" />
                ) : (
                  <ChevronRightIcon size={13} className="flex-none text-muted-foreground" />
                )}
                {/* The name leads and the directory trails: the name is what
                  someone is looking for, and paths are too long to lead with. */}
                <span className="truncate font-medium">{basename(file.path)}</span>
                <span className="min-w-0 flex-1 truncate text-muted-foreground">
                  {dirname(file.path)}
                </span>
                <Badge file={file} />
              </button>

              {expanded && (
                <div className="border-t border-border py-1.5">
                  <Diff file={file} />
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
})

/** Whether a file was created, deleted, or edited — plus how much. */
function Badge({ file }: { file: FileChange }) {
  const [label, tone] =
    file.before === null
      ? ['new', 'text-added']
      : file.after === null
        ? ['deleted', 'text-removed']
        : ['edited', 'text-muted-foreground']

  const { added, removed } = fileChangeCounts(file)

  return (
    <span className={`flex-none text-[11.5px] ${tone}`}>
      {label}
      {(added > 0 || removed > 0) && (
        <span className="ml-1.5 font-mono tabular-nums">
          {added > 0 && <span className="text-added">+{added}</span>}
          {added > 0 && removed > 0 && ' '}
          {removed > 0 && <span className="text-removed">−{removed}</span>}
        </span>
      )}
    </span>
  )
}

function basename(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1)
}

function dirname(path: string): string {
  const cut = path.lastIndexOf('/')
  return cut === -1 ? '' : path.slice(0, cut)
}
