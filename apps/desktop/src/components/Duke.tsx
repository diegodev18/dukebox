import { cn } from '@/lib/utils'

/**
 * Duke, the Schnauzer the product is named after.
 *
 * Three sizes, one drawing: the hero for pairing and empty screens, a square
 * mark for chrome, and the wordmark that sits at the top of the sidebar.
 * The illustration is the brand; everything around it stays quiet.
 */

const HERO_SRC = '/duke-hero.svg'
const MARK_SRC = '/duke-mark.svg'

export type DukePresence = 'idle' | 'working' | 'waiting'

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
    <p className={cn('flex items-center gap-2', className)}>
      <DukeMark size={20} decorative />
      <span className="text-[13px] font-semibold tracking-tight text-foreground">Dukebox</span>
    </p>
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
