import { useEffect, useRef, useState } from 'react'

/**
 * Where a person talks to the agent.
 *
 * Enter sends and Shift+Enter breaks a line — the convention every chat app
 * shares, and the one people try first. While the agent is working the same
 * control stops it, because a button that changes meaning in place is easier to
 * find than a second one that is disabled most of the time.
 */

interface Props {
  onSend: (text: string) => void
  onInterrupt: () => void
  running: boolean
  disabled?: boolean
  placeholder?: string
  /** When a send is rejected, the draft comes back rather than vanishing. */
  error?: string | null
}

export function Composer({
  onSend,
  onInterrupt,
  running,
  disabled,
  placeholder = 'Ask for a change…',
  error,
}: Props) {
  const [text, setText] = useState('')
  const field = useRef<HTMLTextAreaElement>(null)
  const lastSent = useRef('')

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

    const draft = lastSent.current
    lastSent.current = ''
    setText((current) => (current.trim() === '' ? draft : current))
  }, [error])

  const submit = () => {
    const trimmed = text.trim()
    // While the agent is working, Stop owns the control. Clearing the field
    // here would look like the follow-up sent, and it did not.
    if (!trimmed || disabled || running) return

    lastSent.current = trimmed
    onSend(trimmed)
    setText('')
  }

  return (
    <div className="shrink-0 px-6 pb-5">
      <div className="measure rounded-[var(--radius)] border border-border bg-surface focus-within:border-muted-foreground/40">
        <textarea
          ref={field}
          value={text}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault()
              submit()
            }
          }}
          disabled={disabled}
          rows={1}
          placeholder={placeholder}
          aria-label="Message"
          className="block w-full resize-none bg-transparent px-3.5 pt-3 pb-1.5 outline-none placeholder:text-muted-foreground disabled:opacity-50"
        />

        <div className="flex items-center justify-between gap-2 px-2.5 pb-2.5">
          <p className="text-[11.5px] text-muted-foreground">↵ Send · ⇧↵ Newline</p>
          {running ? (
            <button
              type="button"
              onClick={onInterrupt}
              className="rounded-[calc(var(--radius)*0.6)] border border-border px-3 py-1.5 text-[12.5px] font-medium hover:bg-muted"
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
    </div>
  )
}
