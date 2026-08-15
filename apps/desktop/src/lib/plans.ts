import type { Block } from '@dukebox/protocol'
import { EXIT_PLAN_MODE_ACTION, planFromDetail } from '@dukebox/protocol'

/**
 * A plan the agent asked the user to approve, as the workspace shows it.
 *
 * One tab per plan rather than one tab that keeps changing: a session that
 * plans, builds, and plans again produced two different pieces of work, and
 * collapsing them would lose the first.
 */
export interface PlanTab {
  /** The permission block currently shown. Changes when a plan is replanned. */
  id: string
  /** 1-based, for the `Plan #N` label. Stable across a replan. */
  number: number
  plan: string
  /**
   * `pending` still asks; `built` was approved with Build; `closed` was settled
   * without building — the turn died, or a reload lost the local answer.
   */
  status: 'pending' | 'built' | 'closed'
}

/**
 * Fold the transcript's plan requests into the tabs to show.
 *
 * Replanning replaces in place: after "Keep planning" the next plan is the same
 * piece of work said better, so it takes over the tab and its number. Anything
 * else — built, or settled without an answer — closes the tab, and the next
 * plan starts a new one.
 */
export function planTabs(blocks: readonly Block[]): PlanTab[] {
  const tabs: PlanTab[] = []
  // Whether the last tab was denied, and so is waiting to be replanned into.
  // Kept out of PlanTab: the panel has no use for it, only this fold does.
  let replaceable = false

  for (const block of blocks) {
    if (block.kind !== 'permission' || block.action !== EXIT_PLAN_MODE_ACTION) continue

    const plan = planFromDetail(block.detail)
    if (plan === null) continue

    const status = !block.answered ? 'pending' : block.allowed === true ? 'built' : 'closed'
    const denied = block.answered === true && block.allowed === false
    const open = tabs.at(-1)

    if (replaceable && open) {
      tabs[tabs.length - 1] = { ...open, id: block.id, plan, status }
    } else {
      tabs.push({ id: block.id, number: tabs.length + 1, plan, status })
    }

    replaceable = denied
  }

  return tabs
}
