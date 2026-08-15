import { Markdown } from '@/components/Markdown'
import type { PlanTab } from '@/lib/plans'

/**
 * The plan the agent wants approved, and the button that starts the work.
 *
 * Lives in the workspace rather than the transcript because a plan is a
 * document, not a message: it is long, it is read out of order, and it stays
 * worth re-reading while the agent builds it. The transcript keeps a line
 * pointing here so the conversation still records that a plan was asked for.
 *
 * Read-only on purpose. Editing the plan in place would need an answer richer
 * than allow/deny, so refining it stays a matter of replying in the composer
 * and letting the agent replan.
 */

interface Props {
  tab: PlanTab
  onRespond: (id: string, allow: boolean) => void
  /** Answers cannot reach the server while the socket is down. */
  disabled?: boolean
}

export function PlanPanel({ tab, onRespond, disabled = false }: Props) {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto px-3.5 py-3">
        {tab.status === 'built' && (
          <p className="mb-2.5 text-[12.5px] text-done">Building this plan.</p>
        )}
        {tab.status === 'closed' && (
          <p className="mb-2.5 text-[12.5px] text-muted-foreground">
            This plan was not built.
          </p>
        )}
        <Markdown>{tab.plan}</Markdown>
      </div>

      {tab.status === 'pending' && (
        <div className="border-t border-border px-3.5 py-3">
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => onRespond(tab.id, true)}
              disabled={disabled}
              className="rounded-[calc(var(--radius)*0.6)] bg-foreground px-3 py-1.5 text-[12.5px] font-medium text-background disabled:opacity-40"
            >
              Build
            </button>
            <button
              type="button"
              onClick={() => onRespond(tab.id, false)}
              disabled={disabled}
              className="rounded-[calc(var(--radius)*0.6)] border border-border px-3 py-1.5 text-[12.5px] font-medium hover:bg-muted disabled:opacity-40"
            >
              Keep planning
            </button>
          </div>
          <p className="mt-2 text-[12px] text-muted-foreground">
            Building switches the session to Bypass, so the work runs without
            asking again.
          </p>
        </div>
      )}
    </div>
  )
}
