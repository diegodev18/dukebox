import { ThinkingOrb } from 'thinking-orbs'
import { cn } from '@/lib/utils'

/**
 * Marks an in-progress session in the nav list with the `thinking-orbs`
 * dotted sphere (https://orbs.jakubantalik.com/) — `solving` while the agent
 * works, `listening` while it waits on the human.
 */

type SessionStatus = 'provisioning' | 'running' | 'waiting_input' | 'done' | 'failed' | 'stopped'

export function SessionOrb({
  status,
  label,
  className,
}: {
  status: SessionStatus
  label?: string
  className?: string
}) {
  const name = label ?? (status === 'waiting_input' ? 'Waiting for you' : 'Running')
  const state = status === 'waiting_input' ? 'listening' : 'solving'

  return (
    <ThinkingOrb
      state={state}
      size={20}
      aria-label={name}
      // The orb paints itself on a canvas, so the state is invisible to the
      // DOM. Mirror it onto an attribute so tests can assert the mapping.
      data-orb-state={state}
      className={cn('pointer-events-none select-none', className)}
    />
  )
}
