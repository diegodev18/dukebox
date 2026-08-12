import type { SessionSummary } from '@dukebox/protocol'
import { openUrl } from '@tauri-apps/plugin-opener'
import { agentHasRemoteControl } from '@/components/AgentIcon'
import { PhoneIcon } from '@/components/icons'

/**
 * Claude Code Remote Control for this session.
 *
 * Hidden when the agent cannot enable it. Off is a button that registers the
 * session with claude.ai; connected is a link to open it from the phone or
 * another browser, plus a way to turn it off.
 */

interface Props {
  session: SessionSummary
  enabled: boolean
  url: string | null
  error?: string
  connecting?: boolean
  disabled?: boolean
  onChange: (enabled: boolean) => void
}

export function RemoteControl({
  session,
  enabled,
  url,
  error,
  connecting,
  disabled,
  onChange,
}: Props) {
  if (!agentHasRemoteControl(session.agentId)) return null

  if (connecting) {
    return (
      <span className="flex items-center gap-1.5 rounded-[calc(var(--radius)*0.6)] border border-border px-2.5 py-1 text-[12.5px] text-muted-foreground">
        <PhoneIcon size={13} />
        Connecting…
      </span>
    )
  }

  if (enabled && url) {
    return (
      <div className="flex items-center gap-1.5">
        <button
          type="button"
          onClick={() => void openUrl(url).catch(() => undefined)}
          className="flex items-center gap-1.5 rounded-[calc(var(--radius)*0.6)] border border-border px-2.5 py-1 text-[12.5px] font-medium hover:bg-muted"
        >
          <PhoneIcon size={13} className="text-muted-foreground" />
          Open remotely
        </button>
        <button
          type="button"
          onClick={() => onChange(false)}
          disabled={disabled}
          aria-label="Turn off Remote Control"
          className="rounded-[calc(var(--radius)*0.6)] border border-border px-2 py-1 text-[12.5px] text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-50"
        >
          Off
        </button>
      </div>
    )
  }

  return (
    <div className="flex items-center gap-2">
      {error ? (
        <span role="alert" className="max-w-56 truncate text-[12px] text-destructive" title={error}>
          {error}
        </span>
      ) : null}
      <button
        type="button"
        onClick={() => onChange(true)}
        disabled={disabled}
        className="flex items-center gap-1.5 rounded-[calc(var(--radius)*0.6)] border border-border px-2.5 py-1 text-[12.5px] font-medium hover:bg-muted disabled:opacity-50"
      >
        <PhoneIcon size={13} className="text-muted-foreground" />
        Remote control
      </button>
    </div>
  )
}
