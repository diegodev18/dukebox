import { createElement } from 'react'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

vi.mock('@tauri-apps/plugin-opener', () => ({
  openUrl: vi.fn(),
}))

import { Markdown } from '@/components/Markdown'

describe('Markdown', () => {
  it('strips backticks from inline code', () => {
    const html = renderToStaticMarkup(
      createElement(Markdown, null, '`execStream` never demultiplexes'),
    )

    expect(html).toContain('<code')
    expect(html).toContain('>execStream</code>')
    expect(html).not.toContain('>`execStream`<')
  })

  it('renders lists, fences, and inline code from a sample', () => {
    const md = [
      'I found it.',
      '',
      '`execStream` never demultiplexes Docker’s output, so the 8-byte frame headers reach the JSON parser.',
      '',
      'Two things to fix:',
      '',
      '1. Call `demuxStream` before reading',
      '2. Resume `stderr` so the pipe does not stall',
      '',
      '```ts',
      'this.docker.modem.demuxStream(raw, stdout, stderr)',
      '```',
      '',
    ].join('\n')

    const html = renderToStaticMarkup(createElement(Markdown, null, md))

    expect(html).toContain('<ol')
    expect(html).toContain('language-ts')
    expect(html).toMatch(/<code[^>]*>execStream<\/code>/)
    expect(html).not.toMatch(/<code[^>]*>`execStream`<\/code>/)
  })

  it('opens an inline image in a lightbox when clicked', async () => {
    render(createElement(Markdown, null, '![screenshot](https://example.com/shot.png)'))

    await userEvent.click(screen.getByRole('button', { name: 'View screenshot' }))

    expect(screen.getByRole('dialog', { name: 'screenshot' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Save image' })).toBeInTheDocument()
  })
})
