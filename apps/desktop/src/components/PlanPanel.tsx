import { ThinkingOrb } from 'thinking-orbs'
import { Markdown } from '@/components/Markdown'
import { BuildIcon } from '@/components/icons'

/**
 * The plan, rendered for review, and the button that builds it.
 *
 * Cursor keeps the plan out of the transcript so it can be read as a whole
 * while the agent works. This tab is that surface: the markdown the agent
 * wrote in plan mode, with Build as the one action that matters. The rest of
 * the session is unchanged — the plan stays in the conversation too.
 */

interface Props {
  /** The plan the agent wrote in plan mode. Empty until one exists. */
  plan: string
  /** The agent is mid-turn: streaming the plan, or building it. */
  running?: boolean
  /**
   * Whether Build can fire right now.
   *
   * False while the plan is still being written. Distinct from `running`
   * because Claude Code parks on an `exit_plan_mode` approval: the plan is
   * ready to build while the turn is technically still in flight.
   */
  ready?: boolean
  /** The socket is down; nothing can reach the agent. */
  disabled?: boolean
  onBuild: () => void
}

export function PlanPanel({
  plan,
  running = false,
  ready = false,
  disabled = false,
  onBuild,
}: Props) {
  if (!plan) {
    return (
      <div className="flex min-h-0 flex-1 flex-col items-start gap-2.5 px-4 py-4">
        {running ? (
          <>
            <ThinkingOrb state="composing" size={20} theme="auto" aria-label="Planning" />
            <p className="text-[12.5px] text-muted-foreground">Drafting the plan…</p>
          </>
        ) : (
          <p className="text-[12.5px] text-muted-foreground">
            There is no plan yet. Ask in Plan mode to draft one.
          </p>
        )}
      </div>
    )
  }

  // A ready plan under a running agent is a plan being built, not one waiting.
  const building = running && !ready

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-2 border-b border-border px-3.5 py-2">
        <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium">Plan</span>
        <button
          type="button"
          onClick={onBuild}
          disabled={!ready || disabled}
          className="inline-flex shrink-0 items-center gap-1.5 rounded-[calc(var(--radius)*0.6)] bg-foreground px-2.5 py-1.5 text-[12.5px] font-medium text-background hover:opacity-90 disabled:opacity-40"
        >
          <BuildIcon size={14} />
          {building ? 'Building…' : 'Build'}
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
        <div className="measure">
          <Markdown>{plan}</Markdown>
        </div>
      </div>
    </div>
  )
}
