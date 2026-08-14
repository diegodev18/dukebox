import { memo, useEffect, useRef, useState, type ChangeEvent } from 'react'
import type { PermissionMode } from '@dukebox/protocol'
import { availablePermissionModes, cyclePermissionMode } from '@/components/AgentIcon'
import { PermissionModePicker } from '@/components/RepoBranchPickers'
import { AttachIcon, CloseIcon, FileIcon } from '@/components/icons'

/**
 * Where a person talks to the agent.
 *
 * Enter sends and Shift+Enter breaks a line — the convention every chat app
 * shares, and the one people try first. While the agent is working the same
 * control stops it, because a button that changes meaning in place is easier to
 * find than a second one that is disabled most of the time.
 *
 * Files are attached with the paperclip and travel with the prompt as base64
 * data URIs, which the server stages into the sandbox before the agent sees
 * them. The chips above the field are the draft's attachments: they clear on
 * send and come back with the text when a send is rejected.
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
}

export const Composer = memo(function Composer({
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
}: Props) {
  const [text, setText] = useState('')
  const [files, setFiles] = useState<ComposerFile[]>([])
  const field = useRef<HTMLTextAreaElement>(null)
  const picker = useRef<HTMLInputElement>(null)
  const lastSent = useRef('')
  const lastSentFiles = useRef<ComposerFile[]>([])

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
  const handleFiles = async (event: ChangeEvent<HTMLInputElement>) => {
    const picked = Array.from(event.target.files ?? [])
    event.target.value = ''
    if (picked.length === 0 || disabled) return

    try {
      const read = await Promise.all(picked.map(readFile))
      setFiles((current) => [...current, ...read])
    } catch {
      // A file that could not be read is dropped rather than blocking the
      // ones that could.
    }
  }

  const removeFile = (index: number) => {
    setFiles((current) => current.filter((_, i) => i !== index))
  }

  return (
    <div className="shrink-0 px-6 pb-5">
      <div className="measure rounded-[var(--radius)] border border-border bg-surface focus-within:border-muted-foreground/40">
        <textarea
          ref={field}
          value={text}
          onChange={(event) => {
            const element = event.currentTarget
            setText(element.value)
            element.style.height = 'auto'
            element.style.height = `${Math.min(element.scrollHeight, 200)}px`
          }}
          onKeyDown={(event) => {
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
          disabled={disabled}
          rows={1}
          placeholder={disabled ? 'Waiting for connection…' : placeholder}
          aria-label="Message"
          aria-invalid={Boolean(error)}
          {...(error ? { 'aria-describedby': 'composer-error' } : {})}
          className="block w-full resize-none bg-transparent px-3.5 pt-3 pb-1.5 outline-none placeholder:text-muted-foreground disabled:opacity-50"
        />

        {files.length > 0 && (
          <div className="flex max-h-24 flex-wrap gap-1.5 overflow-y-auto px-3 pb-2">
            {files.map((file, index) => (
              <span
                key={`${file.name}-${index}`}
                className="inline-flex max-w-56 items-center gap-1.5 rounded-md border border-border bg-muted/50 py-1 pr-1 pl-2 text-[12px]"
              >
                <FileIcon size={13} className="shrink-0 text-muted-foreground" />
                <span className="min-w-0 truncate">{file.name}</span>
                <button
                  type="button"
                  onClick={() => removeFile(index)}
                  disabled={disabled}
                  aria-label={`Remove ${file.name}`}
                  className="rounded p-0.5 text-muted-foreground hover:bg-border hover:text-foreground disabled:opacity-40"
                >
                  <CloseIcon size={12} />
                </button>
              </span>
            ))}
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
                ? '↵ Send · ⇧↵ Newline · ⇧⇥ Mode'
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
      </div>
      <input ref={picker} type="file" multiple className="hidden" onChange={handleFiles} />
      {error && (
        <p id="composer-error" role="alert" className="measure mt-2 text-[12.5px] text-destructive">
          {error}
        </p>
      )}
    </div>
  )
})

/** Read a picked file into the base64 data URI the protocol stages. */
export function readFile(file: File): Promise<ComposerFile> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve({ name: file.name, data: String(reader.result) })
    reader.onerror = () => reject(reader.error ?? new Error(`could not read ${file.name}`))
    reader.readAsDataURL(file)
  })
}
