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

  return (
    <ThinkingOrb
      state={status === 'waiting_input' ? 'listening' : 'solving'}
      size={20}
      aria-label={name}
      className={cn('pointer-events-none select-none', className)}
    />
  )
}
