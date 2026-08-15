import {
  forwardRef,
  memo,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type ChangeEvent,
} from 'react'
import type { PermissionMode } from '@dukebox/protocol'
import { availablePermissionModes, cyclePermissionMode } from '@/components/AgentIcon'
import { AttachmentChips } from '@/components/AttachmentChips'
import { FileMentionList } from '@/components/FileMentionList'
import { PermissionModePicker } from '@/components/RepoBranchPickers'
import { AttachIcon } from '@/components/icons'
import { insertMention } from '@/lib/fileMentions'
import { filesFromPaste, useFileDrop } from '@/lib/useFileDrop'
import { useFileMention } from '@/lib/useFileMention'
import type { FileTreeStatus } from '@/lib/useFileTree'

/**
 * Where a person talks to the agent.
 *
 * Enter sends and Shift+Enter breaks a line — the convention every chat app
 * shares, and the one people try first. While the agent is working the same
 * control stops it, because a button that changes meaning in place is easier to
 * find than a second one that is disabled most of the time.
 *
 * Files are attached with the paperclip or by dropping them on the box, and
 * travel with the prompt as base64 data URIs, which the server stages into the
 * sandbox before the agent sees them. The chips above the field are the
 * draft's attachments: they clear on send and come back with the text when a
 * send is rejected.
 */

/** A file attached to a prompt, as the protocol wants it: base64 data URI. */
export interface ComposerFile {
  name: string
  data: string
}

interface Props {
  onSend: (text: string, files?: ComposerFile[]) => void
  onInterrupt: () => void
  running: boolean
  disabled?: boolean
  placeholder?: string
  /** When a send is rejected, the draft comes back rather than vanishing. */
  error?: string | null
  permissionMode?: PermissionMode | null
  onPermissionModeChange?: (mode: PermissionMode) => void
  /** Which agent's modes the picker and Shift+Tab cycle should offer. */
  agentId?: string
  /**
   * A prompt loaded from the transcript (Edit). `key` changes when the same
   * text is edited again, so the field refills rather than looking unchanged.
   */
  draft?: { text: string; key: number }
  /**
   * When false, the parent owns drag-and-drop (the session column) so a drop
   * on the transcript attaches here instead of navigating away.
   */
  captureDrop?: boolean
  /**
   * Workspace or repository paths `@` can mention. Absent means the list
   * never opens — `@` is just text.
   */
  mentionFiles?: { paths: readonly string[]; status?: FileTreeStatus }
}

export interface ComposerHandle {
  attachFiles: (files: File[]) => void
}

export const Composer = memo(
  forwardRef<ComposerHandle, Props>(function Composer(
    {
      onSend,
      onInterrupt,
      running,
      disabled = false,
      placeholder = 'Ask for a change…',
      error,
      permissionMode,
      onPermissionModeChange,
      agentId,
      draft,
      captureDrop = true,
      mentionFiles,
    },
    ref,
  ) {
    const [text, setText] = useState('')
    const [files, setFiles] = useState<ComposerFile[]>([])
    const [cursor, setCursor] = useState(0)
    const field = useRef<HTMLTextAreaElement>(null)
    const picker = useRef<HTMLInputElement>(null)
    const lastSent = useRef('')
    const lastSentFiles = useRef<ComposerFile[]>([])
    const mention = useFileMention(text, cursor, mentionFiles?.paths)
    const mentionStatus = mentionFiles?.status ?? 'ready'

    const syncCursor = (element: HTMLTextAreaElement) => {
      setCursor(element.selectionStart)
    }

    const pickMention = (path: string) => {
      if (!mention.mention) return
      const next = insertMention(text, mention.mention.start, cursor, path)
      setText(next.text)
      setCursor(next.cursor)
      requestAnimationFrame(() => {
        const element = field.current
        if (!element) return
        element.focus()
        element.setSelectionRange(next.cursor, next.cursor)
      })
    }

    // Grow with the content, up to a point. A composer that takes the window is
    // worse than one that scrolls.
    useEffect(() => {
      const element = field.current
      if (!element) return

      element.style.height = 'auto'
      element.style.height = `${Math.min(element.scrollHeight, 200)}px`
    }, [text])

    useEffect(() => {
      if (!error || !lastSent.current) return

      const restored = lastSent.current
      const draftFiles = lastSentFiles.current
      lastSent.current = ''
      lastSentFiles.current = []
      setText((current) => (current.trim() === '' ? restored : current))
      setFiles((current) => (current.length === 0 ? draftFiles : current))
    }, [error])

    useEffect(() => {
      if (!draft) return

      setText(draft.text)
      field.current?.focus()
    }, [draft])

    const submit = () => {
      const trimmed = text.trim()
      // While the agent is working, Stop owns the control. Clearing the field
      // here would look like the follow-up sent, and it did not.
      if (!trimmed || disabled || running) return

      lastSent.current = trimmed
      lastSentFiles.current = files
      if (files.length > 0) onSend(trimmed, files)
      else onSend(trimmed)
      setText('')
      setFiles([])
    }

    // Selected files are read once, immediately, and held as base64 data URIs so
    // the send is a single message. Re-selecting the same file works because the
    // input's value is reset after every pick.
    const attachFiles = (picked: File[]) => {
      if (picked.length === 0 || disabled) return

      void Promise.all(picked.map(readFile))
        .then((read) => setFiles((current) => [...current, ...read]))
        .catch(() => {
          // A file that could not be read is dropped rather than blocking the
          // ones that could.
        })
    }

    useImperativeHandle(ref, () => ({ attachFiles }), [disabled])

    const handleFiles = (event: ChangeEvent<HTMLInputElement>) => {
      const picked = Array.from(event.target.files ?? [])
      event.target.value = ''
      attachFiles(picked)
    }

    const { dragging, onDragEnter, onDragOver, onDragLeave, onDrop } = useFileDrop({
      disabled: disabled || !captureDrop,
      onFiles: attachFiles,
    })

    const removeFile = (index: number) => {
      setFiles((current) => current.filter((_, i) => i !== index))
    }

    return (
      <div className="shrink-0 px-6 pb-5">
        <div
          className={`measure relative rounded-[var(--radius)] border bg-surface transition-[border-color,box-shadow] ${dragging ? 'border-primary ring-2 ring-primary/20' : 'border-border focus-within:border-muted-foreground/40'}`}
          {...(captureDrop ? { onDragEnter, onDragOver, onDragLeave, onDrop } : {})}
        >
          <textarea
            ref={field}
            value={text}
            onChange={(event) => {
              const element = event.currentTarget
              setText(element.value)
              syncCursor(element)
              element.style.height = 'auto'
              element.style.height = `${Math.min(element.scrollHeight, 200)}px`
            }}
            onClick={(event) => syncCursor(event.currentTarget)}
            onKeyUp={(event) => syncCursor(event.currentTarget)}
            onSelect={(event) => syncCursor(event.currentTarget)}
            onKeyDown={(event) => {
              if (mention.open) {
                if (event.key === 'ArrowDown') {
                  event.preventDefault()
                  if (mention.matches.length > 0) {
                    mention.setIndex((current) => (current + 1) % mention.matches.length)
                  }
                  return
                }
                if (event.key === 'ArrowUp') {
                  event.preventDefault()
                  if (mention.matches.length > 0) {
                    mention.setIndex(
                      (current) => (current - 1 + mention.matches.length) % mention.matches.length,
                    )
                  }
                  return
                }
                if (event.key === 'Escape') {
                  event.preventDefault()
                  mention.dismiss()
                  return
                }
                if ((event.key === 'Enter' || event.key === 'Tab') && !event.shiftKey) {
                  const path = mention.matches[mention.index]
                  if (path) {
                    event.preventDefault()
                    pickMention(path)
                    return
                  }
                  if (event.key === 'Enter') {
                    event.preventDefault()
                    return
                  }
                }
              }
              if (
                event.key === 'Tab' &&
                event.shiftKey &&
                permissionMode &&
                onPermissionModeChange &&
                !disabled
              ) {
                event.preventDefault()
                onPermissionModeChange(cyclePermissionMode(permissionMode, agentId))
                return
              }
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault()
                submit()
              }
            }}
            onPaste={(event) => {
              const pasted = filesFromPaste(event.clipboardData)
              if (pasted.length === 0) return
              event.preventDefault()
              attachFiles(pasted)
            }}
            disabled={disabled}
            rows={1}
            placeholder={disabled ? 'Waiting for connection…' : placeholder}
            aria-label="Message"
            aria-invalid={Boolean(error)}
            {...(error ? { 'aria-describedby': 'composer-error' } : {})}
            className="block w-full resize-none bg-transparent px-3.5 pt-3 pb-1.5 outline-none placeholder:text-muted-foreground disabled:opacity-50"
          />

          {files.length > 0 && (
            <div className="px-3 pb-2">
              <AttachmentChips attachments={files} onRemove={removeFile} disabled={disabled} />
            </div>
          )}

          <div className="flex items-center justify-between gap-2 px-2.5 pb-2.5">
            <div className="flex min-w-0 items-center gap-1.5">
              <button
                type="button"
                onClick={() => picker.current?.click()}
                disabled={disabled}
                aria-label="Attach files"
                title="Attach files"
                className="inline-flex shrink-0 items-center justify-center rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-40"
              >
                <AttachIcon size={15} />
              </button>
              {permissionMode && onPermissionModeChange ? (
                <PermissionModePicker
                  value={permissionMode}
                  onChange={onPermissionModeChange}
                  {...(agentId ? { modes: availablePermissionModes(agentId) } : {})}
                  {...(disabled ? { disabled: true } : {})}
                />
              ) : null}
              <p className="text-[11.5px] text-muted-foreground">
                {permissionMode && onPermissionModeChange
                  ? mentionFiles
                    ? '↵ Send · ⇧↵ Newline · ⇧⇥ Mode · @ File'
                    : '↵ Send · ⇧↵ Newline · ⇧⇥ Mode'
                  : mentionFiles
                    ? '↵ Send · ⇧↵ Newline · @ File'
                    : '↵ Send · ⇧↵ Newline'}
              </p>
            </div>
            {running ? (
              <button
                type="button"
                onClick={onInterrupt}
                disabled={disabled}
                className="rounded-[calc(var(--radius)*0.6)] border border-border px-3 py-1.5 text-[12.5px] font-medium hover:bg-muted disabled:opacity-40"
              >
                Stop
              </button>
            ) : (
              <button
                type="button"
                onClick={submit}
                disabled={!text.trim() || disabled}
                className="rounded-[calc(var(--radius)*0.6)] bg-foreground px-3 py-1.5 text-[12.5px] font-medium text-background disabled:opacity-40"
              >
                Send
              </button>
            )}
          </div>

          {mention.open && (
            <FileMentionList
              items={mention.matches}
              selectedIndex={mention.index}
              status={mentionStatus}
              onSelect={pickMention}
              onHighlight={mention.setIndex}
            />
          )}

          {dragging && (
            <div className="pointer-events-none absolute inset-0 z-10 grid place-items-center rounded-[var(--radius)] border-2 border-dashed border-primary/60 bg-background/85">
              <p className="flex items-center gap-2 text-[13px] font-medium text-foreground">
                <AttachIcon size={16} />
                Drop to attach
              </p>
            </div>
          )}
        </div>
        <input ref={picker} type="file" multiple className="hidden" onChange={handleFiles} />
        {error && (
          <p
            id="composer-error"
            role="alert"
            className="measure mt-2 text-[12.5px] text-destructive"
          >
            {error}
          </p>
        )}
      </div>
    )
  }),
)
Composer.displayName = 'Composer'

/** Read a picked file into the base64 data URI the protocol stages. */
export function readFile(file: File): Promise<ComposerFile> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve({ name: file.name, data: String(reader.result) })
    reader.onerror = () => reject(reader.error ?? new Error(`could not read ${file.name}`))
    reader.readAsDataURL(file)
  })
}
