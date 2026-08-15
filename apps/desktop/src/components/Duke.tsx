import { cn } from '@/lib/utils'
import type { DukeMood } from '@/lib/orbState'

/**
 * Duke, the Schnauzer the product is named after.
 *
 * One drawing everywhere: the hero for pairing and empty screens, a square
 * mark for chrome and the wordmark, and the same mark as a live indicator
 * in the session list and the transcript.
 */

const HERO_SRC = '/duke-hero.svg'
const MARK_SRC = '/duke-mark.svg'

export type DukePresence = 'idle' | 'working' | 'waiting'
export type { DukeMood }

const PRESENCE_LABEL: Record<DukePresence, string> = {
  idle: 'Duke',
  working: 'Duke is working',
  waiting: 'Duke is waiting for you',
}

export function DukeHero({
  size = 160,
  label = 'Duke',
  className,
}: {
  size?: number
  label?: string
  className?: string
}) {
  const height = Math.round(size * (603 / 747))
  return (
    <img
      src={HERO_SRC}
      alt={label}
      width={size}
      height={height}
      draggable={false}
      className={cn('pointer-events-none select-none', className)}
    />
  )
}

export function DukeMark({
  size = 20,
  decorative = false,
  presence,
  label,
  className,
}: {
  size?: number
  decorative?: boolean
  presence?: DukePresence
  label?: string
  className?: string
}) {
  const name = decorative ? undefined : (label ?? (presence ? PRESENCE_LABEL[presence] : 'Duke'))
  const live = presence === 'working'

  return (
    <img
      src={MARK_SRC}
      alt={name ?? ''}
      width={size}
      height={size}
      draggable={false}
      aria-hidden={decorative || undefined}
      className={cn(
        'pointer-events-none select-none',
        live && 'motion-safe:animate-pulse',
        className,
      )}
    />
  )
}

export function DukeWordmark({ className }: { className?: string }) {
  return (
    <p className={cn('flex items-center gap-2.5', className)}>
      <DukeMark size={32} decorative />
      <span className="text-[15px] font-semibold tracking-tight text-foreground">Dukebox</span>
    </p>
  )
}

/**
 * Duke as a live indicator — the same mark as the wordmark, with a little
 * motion so it still reads as the slot that used to hold the thinking orb.
 */
export function DukeLive({
  size = 20,
  mood = 'working',
  decorative = false,
  label,
  className,
}: {
  size?: number
  mood?: DukeMood
  decorative?: boolean
  label?: string
  className?: string
}) {
  const name = decorative ? undefined : (label ?? 'Duke is working')

  return (
    <img
      src={MARK_SRC}
      alt={name ?? ''}
      width={size}
      height={size}
      draggable={false}
      aria-hidden={decorative || undefined}
      aria-label={name}
      data-mood={mood}
      className={cn('duke-live pointer-events-none select-none', className)}
    />
  )
}

/** Map a session status onto Duke's presence in the session header. */
export function presenceForStatus(
  status: 'provisioning' | 'running' | 'waiting_input' | 'done' | 'failed' | 'stopped',
): DukePresence {
  if (status === 'running' || status === 'provisioning') return 'working'
  if (status === 'waiting_input') return 'waiting'
  return 'idle'
}
