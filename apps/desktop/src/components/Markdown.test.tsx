import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

vi.mock('@tauri-apps/plugin-opener', () => ({
  openUrl: vi.fn(),
}))

import { Markdown } from './Markdown.js'

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
})
