import { fetch as tauriFetch } from '@tauri-apps/plugin-http'
import { useEffect, useRef, useState } from 'react'
import { CheckIcon, CloseIcon, CopyIcon, DownloadIcon } from '@/components/icons'

/**
 * An image, opened large.
 *
 * Clicking a thumbnail or an inline image in the transcript opens this over
 * the whole window: the image is worth seeing at full size, and "large" means
 * larger than the message column can be. Copy puts the image itself on the
 * clipboard (not the markdown for it), and Save downloads the original file.
 */

interface Props {
  src: string
  alt?: string | undefined
  /** Filename to suggest when saving. Defaults to the alt text, then "image". */
  name?: string | undefined
  onDismiss: () => void
}

export function ImageLightbox({ src, alt, name, onDismiss }: Props) {
  const panel = useRef<HTMLDivElement>(null)
  const dismiss = useRef(onDismiss)
  dismiss.current = onDismiss
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    // Focus moves into the dialog so Escape reaches it and the reader is not
    // left with focus stranded on a button behind the backdrop.
    panel.current?.focus()

    const focusable = () => {
      const nodes = panel.current?.querySelectorAll<HTMLElement>(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
      )
      return nodes ? Array.from(nodes) : []
    }

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        dismiss.current()
        return
      }

      if (event.key !== 'Tab') return

      const items = focusable()
      if (items.length === 0) {
        event.preventDefault()
        panel.current?.focus()
        return
      }

      const first = items[0]!
      const last = items[items.length - 1]!
      const active = document.activeElement

      if (event.shiftKey && (active === first || active === panel.current)) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && (active === last || active === panel.current)) {
        event.preventDefault()
        first.focus()
      }
    }

    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [])

  useEffect(() => {
    if (!copied) return
    const timer = window.setTimeout(() => setCopied(false), 1500)
    return () => window.clearTimeout(timer)
  }, [copied])

  const copy = async () => {
    try {
      if (!navigator.clipboard?.write || typeof ClipboardItem === 'undefined') return
      const blob = await imageBlob(src)
      await navigator.clipboard.write([new ClipboardItem({ [blob.type || 'image/png']: blob })])
      setCopied(true)
    } catch {
      // A locked-down webview can refuse the clipboard; the image still shows.
    }
  }

  const save = async () => {
    try {
      const blob = await imageBlob(src)
      const url = URL.createObjectURL(blob)
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = downloadName(name, alt, blob.type)
      document.body.appendChild(anchor)
      anchor.click()
      anchor.remove()
      // Give the download time to start before releasing the URL.
      window.setTimeout(() => URL.revokeObjectURL(url), 1000)
    } catch {
      // Unreadable images cannot be saved; the modal still shows the one on screen.
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-black/80 p-6"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) onDismiss()
      }}
    >
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-label={alt || 'Image'}
        tabIndex={-1}
        className="flex max-h-full max-w-full flex-col items-center gap-3 outline-none"
      >
        <img
          src={src}
          alt={alt}
          className="max-h-[calc(100vh-8rem)] max-w-[calc(100vw-8rem)] rounded-md object-contain shadow-lg"
        />
        <div className="flex items-center gap-1 rounded-full border border-border bg-background p-1 shadow-lg">
          <button
            type="button"
            onClick={() => void copy()}
            aria-label={copied ? 'Copied' : 'Copy image'}
            title={copied ? 'Copied' : 'Copy image'}
            className="grid size-8 place-items-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            {copied ? <CheckIcon size={15} /> : <CopyIcon size={15} />}
          </button>
          <button
            type="button"
            onClick={() => void save()}
            aria-label="Save image"
            title="Save image"
            className="grid size-8 place-items-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <DownloadIcon size={15} />
          </button>
          <button
            type="button"
            onClick={onDismiss}
            aria-label="Close image"
            title="Close image"
            className="grid size-8 place-items-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <CloseIcon size={15} />
          </button>
        </div>
      </div>
    </div>
  )
}

/**
 * The image as a blob, so it can reach the clipboard or the disk.
 *
 * Data URIs (how attachments travel) decode directly; anything else goes
 * through the native HTTP layer where one exists, because the webview refuses
 * the plaintext tailnet HTTP a Dukebox server speaks.
 */
async function imageBlob(src: string): Promise<Blob> {
  if (src.startsWith('data:')) return dataUriToBlob(src)

  const httpFetch: typeof globalThis.fetch =
    '__TAURI_INTERNALS__' in globalThis ? (tauriFetch as typeof globalThis.fetch) : globalThis.fetch

  const response = await httpFetch(src)
  if (!response.ok) throw new Error(`could not fetch image (${response.status})`)
  return response.blob()
}

function dataUriToBlob(data: string): Blob {
  const comma = data.indexOf(',')
  const header = comma === -1 ? data : data.slice(0, comma)
  const payload = comma === -1 ? '' : data.slice(comma + 1)
  const mime = header.match(/^data:([^;,]+)/)?.[1] ?? 'image/png'

  const binary = atob(payload)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index++) {
    bytes[index] = binary.charCodeAt(index)
  }
  return new Blob([bytes], { type: mime })
}

function downloadName(name: string | undefined, alt: string | undefined, type: string): string {
  const extension = extensionFor(type)
  const base = name ?? (alt ? alt.trim().replace(/\s+/g, '_') || 'image' : 'image')
  return base.toLowerCase().endsWith(`.${extension}`) ? base : `${base}.${extension}`
}

function extensionFor(type: string): string {
  switch (type) {
    case 'image/jpeg':
    case 'image/jpg':
      return 'jpg'
    case 'image/gif':
      return 'gif'
    case 'image/webp':
      return 'webp'
    case 'image/svg+xml':
      return 'svg'
    default:
      return 'png'
  }
}
