import { openUrl } from '@tauri-apps/plugin-opener'
import type { Components } from 'react-markdown'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { MouseEvent, ReactNode } from 'react'
import { memo, useState } from 'react'
import { ImageLightbox } from '@/components/ImageLightbox'

/**
 * Assistant prose, rendered as Markdown.
 *
 * The stream delivers plain strings; this is the only place they become
 * structure. Links leave the window rather than navigate the webview.
 */

interface Props {
  children: string
  className?: string
}

const components: Components = {
  p: ({ children }) => <p className="whitespace-pre-wrap">{children}</p>,
  strong: ({ children }) => <strong className="font-semibold">{children}</strong>,
  em: ({ children }) => <em>{children}</em>,
  a: ({ href, children }) => <MarkdownLink href={href}>{children}</MarkdownLink>,
  img: ({ src, alt }) => <MarkdownImage src={src} alt={alt} />,
  ul: ({ children }) => <ul className="list-disc space-y-1 pl-5">{children}</ul>,
  ol: ({ children }) => <ol className="list-decimal space-y-1 pl-5">{children}</ol>,
  li: ({ children }) => <li className="whitespace-pre-wrap">{children}</li>,
  blockquote: ({ children }) => (
    <blockquote className="border-l-2 border-border pl-3 text-muted-foreground">
      {children}
    </blockquote>
  ),
  hr: () => <hr className="border-border" />,
  h1: ({ children }) => <Heading level={1}>{children}</Heading>,
  h2: ({ children }) => <Heading level={2}>{children}</Heading>,
  h3: ({ children }) => <Heading level={3}>{children}</Heading>,
  h4: ({ children }) => <Heading level={4}>{children}</Heading>,
  h5: ({ children }) => <Heading level={5}>{children}</Heading>,
  h6: ({ children }) => <Heading level={6}>{children}</Heading>,
  code: ({ className, children }) => (
    <code
      className={
        className
          ? `font-mono text-[12.5px] leading-relaxed whitespace-pre ${className}`
          : 'rounded-[calc(var(--radius)*0.45)] bg-muted px-1 py-0.5 font-mono text-[12.5px]'
      }
    >
      {children}
    </code>
  ),
  pre: ({ children }) => (
    <pre className="overflow-x-auto rounded-[var(--radius)] border border-border bg-surface px-3 py-2.5 font-mono text-[12.5px] [&_code]:rounded-none [&_code]:bg-transparent [&_code]:p-0">
      {children}
    </pre>
  ),
  table: ({ children }) => (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-[13px]">{children}</table>
    </div>
  ),
  thead: ({ children }) => <thead className="border-b border-border">{children}</thead>,
  th: ({ children }) => <th className="px-2 py-1.5 text-left font-medium">{children}</th>,
  td: ({ children }) => <td className="border-t border-border px-2 py-1.5">{children}</td>,
}

export const Markdown = memo(function Markdown({ children, className }: Props) {
  return (
    <div
      data-selectable
      className={['flex flex-col gap-2.5 [&>*:first-child]:mt-0', className]
        .filter(Boolean)
        .join(' ')}
    >
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {children}
      </ReactMarkdown>
    </div>
  )
})

function MarkdownImage({ src, alt }: { src?: string | undefined; alt?: string | undefined }) {
  const [open, setOpen] = useState(false)
  if (!src) return null

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label={alt ? `View ${alt}` : 'View image'}
        title="View image"
        className="block max-w-full cursor-zoom-in"
      >
        <img
          src={src}
          alt={alt}
          className="max-h-96 max-w-full rounded-[var(--radius)] border border-border object-contain"
        />
      </button>
      {open && <ImageLightbox src={src} alt={alt} onDismiss={() => setOpen(false)} />}
    </>
  )
}

function Heading({ level, children }: { level: 1 | 2 | 3 | 4 | 5 | 6; children: ReactNode }) {
  const Tag = `h${level}` as const
  const size =
    level <= 2
      ? 'text-[15px] font-semibold'
      : level === 3
        ? 'text-[14px] font-semibold'
        : 'text-[13px] font-semibold'

  return <Tag className={size}>{children}</Tag>
}

function MarkdownLink({ href, children }: { href?: string | undefined; children: ReactNode }) {
  const open = (event: MouseEvent<HTMLAnchorElement>) => {
    event.preventDefault()
    if (!href) return

    void openUrl(href).catch(() => {
      window.open(href, '_blank', 'noopener,noreferrer')
    })
  }

  return (
    <a
      href={href}
      onClick={open}
      className="text-primary underline decoration-primary/35 underline-offset-2 hover:decoration-primary"
    >
      {children}
    </a>
  )
}
