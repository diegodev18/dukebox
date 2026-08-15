import type { Block } from '@dukebox/protocol'
import { describe, expect, it } from 'vitest'
import { planTabs } from '@/lib/plans'

function plan(id: string, text: string, answer?: { allowed?: boolean }): Block {
  return {
    kind: 'permission',
    id,
    action: 'exit_plan_mode',
    detail: { plan: text },
    ...(answer ? { answered: true, ...answer } : {}),
  }
}

describe('planTabs', () => {
  it('lists a pending plan', () => {
    expect(planTabs([plan('a', '# First')])).toEqual([
      { id: 'a', number: 1, plan: '# First', status: 'pending' },
    ])
  })

  it('ignores permissions that are not plans', () => {
    const blocks: Block[] = [
      { kind: 'permission', id: 'b', action: 'Bash', detail: { command: 'ls' } },
      { kind: 'text', id: 't', text: 'hello' },
    ]

    expect(planTabs(blocks)).toEqual([])
  })

  it('ignores a plan request that carries no plan text', () => {
    const blocks: Block[] = [{ kind: 'permission', id: 'a', action: 'exit_plan_mode', detail: {} }]

    expect(planTabs(blocks)).toEqual([])
  })

  it('replaces the tab in place when a denied plan is replanned', () => {
    const tabs = planTabs([plan('a', '# First', { allowed: false }), plan('b', '# Second')])

    expect(tabs).toEqual([{ id: 'b', number: 1, plan: '# Second', status: 'pending' }])
  })

  it('keeps replacing across several rounds of replanning', () => {
    const tabs = planTabs([
      plan('a', '# First', { allowed: false }),
      plan('b', '# Second', { allowed: false }),
      plan('c', '# Third'),
    ])

    expect(tabs).toEqual([{ id: 'c', number: 1, plan: '# Third', status: 'pending' }])
  })

  it('opens a new tab once a plan has been built', () => {
    const tabs = planTabs([plan('a', '# First', { allowed: true }), plan('b', '# Second')])

    expect(tabs).toEqual([
      { id: 'a', number: 1, plan: '# First', status: 'built' },
      { id: 'b', number: 2, plan: '# Second', status: 'pending' },
    ])
  })

  it('keeps a plan settled without an answer, and does not let it be replaced', () => {
    // `closeOpenWork` marks a plan answered when the turn dies, and a reload
    // refolds the transcript without the local allow/deny. Merging the next
    // plan into that tab would fuse two different plans.
    const tabs = planTabs([plan('a', '# First', {}), plan('b', '# Second')])

    expect(tabs).toEqual([
      { id: 'a', number: 1, plan: '# First', status: 'closed' },
      { id: 'b', number: 2, plan: '# Second', status: 'pending' },
    ])
  })

  it('numbers tabs by position, so a replaced plan keeps its number', () => {
    const tabs = planTabs([
      plan('a', '# Built', { allowed: true }),
      plan('b', '# Denied', { allowed: false }),
      plan('c', '# Replanned'),
    ])

    expect(tabs.map((tab) => tab.number)).toEqual([1, 2])
    expect(tabs[1]).toMatchObject({ id: 'c', plan: '# Replanned', status: 'pending' })
  })
})
