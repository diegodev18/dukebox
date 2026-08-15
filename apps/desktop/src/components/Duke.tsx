import { cn } from '@/lib/utils'
import type { DukeMood } from '@/lib/orbState'

/**
 * Duke, the Schnauzer the product is named after.
 *
 * Three sizes, one drawing: the hero for pairing and empty screens, a square
 * mark for chrome, and the wordmark that sits at the top of the sidebar.
 * The live face replaces the old thinking orb — layered so the ears, brows,
 * and eyelids can move on their own.
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
 * Duke as a live indicator — blink, ear flicks, brow shifts — in the slot
 * that used to hold the thinking orb.
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
    <svg
      viewBox="0 0 64 64"
      width={size}
      height={size}
      role={decorative ? undefined : 'img'}
      aria-label={name}
      aria-hidden={decorative || undefined}
      data-mood={mood}
      overflow="visible"
      className={cn('duke-live pointer-events-none select-none', className)}
    >
      <g className="duke-live-head">
        <g className="duke-live-ear duke-live-ear-l">
          <path
            d="M20.4 18.8 C12.6 20.2 7.4 27.6 8.2 36.2 C8.8 43.6 14.4 48.2 20.2 46.4 C23.4 45.4 24.8 40.2 24.6 33.6 C24.4 27.2 23.4 21.4 20.4 18.8 Z"
            fill="#555353"
          />
          <path
            d="M19.8 22.4 C15 23.6 11.8 28.6 12.2 34.4 C12.6 39.6 16.2 42.8 19.6 41.6 C21.8 40.8 22.8 36.8 22.8 32 C22.8 27.6 22 23.8 19.8 22.4 Z"
            fill="#6a6563"
          />
        </g>
        <g className="duke-live-ear duke-live-ear-r">
          <path
            d="M43.6 18.8 C51.4 20.2 56.6 27.6 55.8 36.2 C55.2 43.6 49.6 48.2 43.8 46.4 C40.6 45.4 39.2 40.2 39.4 33.6 C39.6 27.2 40.6 21.4 43.6 18.8 Z"
            fill="#555353"
          />
          <path
            d="M44.2 22.4 C49 23.6 52.2 28.6 51.8 34.4 C51.4 39.6 47.8 42.8 44.4 41.6 C42.2 40.8 41.2 36.8 41.2 32 C41.2 27.6 42 23.8 44.2 22.4 Z"
            fill="#6a6563"
          />
        </g>

        <path
          d="M16.2 24.6 C18.4 17.8 24.8 14.6 32 14.6 C39.2 14.6 45.6 17.8 47.8 24.6 C50.2 31.8 48.8 41.2 43.6 47.2 C39.8 51.6 35.4 53.4 32 53.4 C28.6 53.4 24.2 51.6 20.4 47.2 C15.2 41.2 13.8 31.8 16.2 24.6 Z"
          fill="#6c6866"
        />

        <g className="duke-live-brow duke-live-brow-l">
          <path
            d="M16.8 28.6 C18.2 23.8 25.6 22.4 29.6 26.8 C27.4 30 21.8 31.6 17.6 30.4 C17 30 16.8 29.4 16.8 28.6 Z"
            fill="#d4cec7"
          />
        </g>
        <g className="duke-live-brow duke-live-brow-r">
          <path
            d="M47.2 28.6 C45.8 23.8 38.4 22.4 34.4 26.8 C36.6 30 42.2 31.6 46.4 30.4 C47 30 47.2 29.4 47.2 28.6 Z"
            fill="#d4cec7"
          />
        </g>

        <g className="duke-live-eyes">
          <rect
            className="duke-live-eye"
            x="22.4"
            y="30.6"
            width="4.4"
            height="7"
            rx="2.2"
            fill="#171717"
          />
          <rect
            className="duke-live-eye"
            x="37.2"
            y="30.6"
            width="4.4"
            height="7"
            rx="2.2"
            fill="#171717"
          />
        </g>

        <path
          d="M18.8 40.8 C20.6 36.8 26.2 36.4 29 40.4 C25.8 43.6 21.2 44 18.8 40.8 Z"
          fill="#d8d2cb"
        />
        <path
          d="M45.2 40.8 C43.4 36.8 37.8 36.4 35 40.4 C38.2 43.6 42.8 44 45.2 40.8 Z"
          fill="#d8d2cb"
        />
        <path
          d="M20 46 C21.2 51.4 25.4 56.4 32 56.8 C38.6 56.4 42.8 51.4 44 46 C41.6 49.8 37.2 52 32 51.8 C26.8 52 22.4 49.8 20 46 Z"
          fill="#c8c2bb"
        />
        <path
          d="M24.4 50.6 C26.6 54 29.4 55.4 32 55.4 C34.6 55.4 37.4 54 39.6 50.6 C37.4 52.6 34.8 53.4 32 53.2 C29.2 53.4 26.6 52.6 24.4 50.6 Z"
          fill="#d6d0c9"
        />

        <ellipse cx="32" cy="43" rx="4.3" ry="3.3" fill="#171717" />
      </g>
    </svg>
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
