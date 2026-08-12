import { FitAddon } from '@xterm/addon-fit'
import { Terminal as Xterm } from '@xterm/xterm'
import { useEffect, useRef } from 'react'
import type { TerminalTab } from '@/lib/useTerminals'

/**
 * One shell, rendered.
 *
 * The xterm instance is created once and kept for the life of the tab. It is
 * hidden rather than unmounted when another tab is selected: xterm rebuilds its
 * screen from scratch on mount, so unmounting would mean a full replay flash
 * every time someone switches between two terminals.
 */

interface TerminalProps {
  tab: TerminalTab
  active: boolean
  onInput: (data: string) => void
  onResize: (cols: number, rows: number) => void
  onDrain: () => void
}

/** Dragging a window edge fires continuously; each resize is a round trip. */
const RESIZE_DEBOUNCE_MS = 120

export function Terminal({ tab, active, onInput, onResize, onDrain }: TerminalProps) {
  const host = useRef<HTMLDivElement>(null)
  const xterm = useRef<Xterm | null>(null)
  const fit = useRef<FitAddon | null>(null)

  // Read by long-lived listeners that must not be re-registered on every
  // render — rebinding xterm's onData would double every keystroke.
  const handlers = useRef({ onInput, onResize })
  handlers.current = { onInput, onResize }

  useEffect(() => {
    if (!host.current) return

    const terminal = new Xterm({
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
      fontSize: 12.5,
      theme: themeFromCss(host.current),
      cursorBlink: true,
      scrollback: 5000,
    })

    const fitAddon = new FitAddon()
    terminal.loadAddon(fitAddon)
    terminal.open(host.current)
    fitAddon.fit()

    terminal.onData((data) => {
      handlers.current.onInput(encode(data))
    })

    xterm.current = terminal
    fit.current = fitAddon

    return () => {
      terminal.dispose()
      xterm.current = null
      fit.current = null
    }
  }, [])

  // The app follows the system colour scheme, and a terminal left on the old
  // palette is the one element that does not.
  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)')

    const update = () => {
      if (xterm.current && host.current) {
        xterm.current.options.theme = themeFromCss(host.current)
      }
    }

    media.addEventListener('change', update)
    return () => media.removeEventListener('change', update)
  }, [])

  // Refit and report the size whenever the panel changes shape.
  useEffect(() => {
    if (!host.current) return

    let timer: ReturnType<typeof setTimeout> | null = null

    const observer = new ResizeObserver(() => {
      if (timer) clearTimeout(timer)

      timer = setTimeout(() => {
        const terminal = xterm.current
        if (!terminal || !fit.current) return

        fit.current.fit()
        handlers.current.onResize(terminal.cols, terminal.rows)
      }, RESIZE_DEBOUNCE_MS)
    })

    observer.observe(host.current)

    return () => {
      if (timer) clearTimeout(timer)
      observer.disconnect()
    }
  }, [])

  // Write whatever arrived while this component could not.
  useEffect(() => {
    const terminal = xterm.current
    if (!terminal || tab.pending.length === 0) return

    for (const chunk of tab.pending) {
      terminal.write(decode(chunk))
    }

    onDrain()
  }, [tab.pending, onDrain])

  // Refit on becoming visible: a terminal sized while hidden measures a
  // zero-height box and comes back one row tall.
  useEffect(() => {
    if (!active || !fit.current || !xterm.current) return

    fit.current.fit()
    handlers.current.onResize(xterm.current.cols, xterm.current.rows)
  }, [active])

  return (
    <div className={`min-h-0 flex-1 ${active ? 'flex' : 'hidden'} flex-col`}>
      <div ref={host} role="region" aria-label={tab.title} className="min-h-0 flex-1 px-2 py-1.5" />
      {tab.exited && (
        <p className="border-t border-border px-3 py-1.5 text-[12px] text-muted-foreground">
          This shell exited.
        </p>
      )}
    </div>
  )
}

/** UTF-8 safe base64, which `btoa` alone is not for pasted text. */
function encode(value: string): string {
  const bytes = new TextEncoder().encode(value)
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)

  return btoa(binary)
}

function decode(value: string): Uint8Array {
  const binary = atob(value)
  return Uint8Array.from(binary, (character) => character.charCodeAt(0))
}

/**
 * Pull terminal colours from the app's own palette.
 *
 * xterm needs concrete colours, and the stylesheet defines these in `oklch`,
 * which it cannot parse. Resolving them against a mounted element hands back
 * whatever the browser computed — a colour xterm understands, in whichever
 * scheme is currently active.
 */
function themeFromCss(element: HTMLElement): Record<string, string> {
  const styles = getComputedStyle(element)

  const read = (name: string, fallback: string) => {
    const value = styles.getPropertyValue(name).trim()
    return value ? resolve(value, fallback) : fallback
  }

  return {
    background: read('--color-surface', '#1a1a1a'),
    foreground: read('--color-foreground', '#e6e6e6'),
    cursor: read('--color-foreground', '#e6e6e6'),
    selectionBackground: read('--color-muted', '#3a3a3a'),
  }
}

/**
 * Convert any CSS colour to one xterm accepts.
 *
 * Painting it onto a canvas is the cheapest way to make the browser do the
 * conversion: `oklch()` goes in, `rgb()` comes out.
 */
function resolve(value: string, fallback: string): string {
  const context = document.createElement('canvas').getContext('2d')
  if (!context) return fallback

  context.fillStyle = fallback
  context.fillStyle = value

  return context.fillStyle
}
