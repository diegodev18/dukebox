import { useState } from 'react'
import { CloseIcon, FileIcon } from '@/components/icons'
import { ImageLightbox } from '@/components/ImageLightbox'

export interface AttachmentChip {
  name: string
  mediaType?: string | undefined
  data?: string | undefined
}

function isImage(file: AttachmentChip): boolean {
  if (file.data?.startsWith('data:image/')) return true
  return Boolean(file.mediaType?.startsWith('image/'))
}

/**
 * Chips for files attached to a prompt.
 *
 * Images with a data URI render as a thumbnail so a screenshot is visible
 * in the transcript, not just named — clicking one opens it large. Everything
 * else is a filename.
 */
export function AttachmentChips({
  attachments,
  onRemove,
  disabled = false,
}: {
  attachments: AttachmentChip[]
  onRemove?: (index: number) => void
  disabled?: boolean
}) {
  const [lightbox, setLightbox] = useState<{ src: string; name: string } | null>(null)

  if (attachments.length === 0) return null

  return (
    <>
      <div className="flex max-h-36 flex-wrap gap-1.5 overflow-y-auto">
        {attachments.map((file, index) => {
          const image = isImage(file) && file.data
          return (
            <span
              key={`${file.name}-${index}`}
              className="inline-flex max-w-56 items-center gap-1.5 rounded-md border border-border bg-muted/50 py-1 pr-1 pl-1.5 text-[12px]"
            >
              {image ? (
                <button
                  type="button"
                  onClick={() => setLightbox({ src: file.data!, name: file.name })}
                  aria-label={`View ${file.name}`}
                  title="View image"
                  className="shrink-0 cursor-zoom-in"
                >
                  <img src={file.data} alt={file.name} className="size-8 rounded object-cover" />
                </button>
              ) : (
                <FileIcon size={13} className="shrink-0 text-muted-foreground" />
              )}
              <span className="min-w-0 truncate">{file.name}</span>
              {onRemove ? (
                <button
                  type="button"
                  onClick={() => onRemove(index)}
                  disabled={disabled}
                  aria-label={`Remove ${file.name}`}
                  className="rounded p-0.5 text-muted-foreground hover:bg-border hover:text-foreground disabled:opacity-40"
                >
                  <CloseIcon size={12} />
                </button>
              ) : null}
            </span>
          )
        })}
      </div>

      {lightbox && (
        <ImageLightbox
          src={lightbox.src}
          alt={lightbox.name}
          name={lightbox.name}
          onDismiss={() => setLightbox(null)}
        />
      )}
    </>
  )
}
