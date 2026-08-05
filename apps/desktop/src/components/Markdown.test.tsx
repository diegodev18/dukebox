import { renderToStaticMarkup } from 'react-dom/server'
import { createElement } from 'react'
import { describe, expect, it, vi } from 'vitest'

vi.mock('@tauri-apps/plugin-opener', () => ({
  openUrl: vi.fn(),
}))

import { Markdown } from './src/components/Markdown'

describe('Markdown', () => {
  it('strips backticks from inline code', () => {
    const html = renderToStaticMarkup(
      createElement(Markdown, null, '`execStream` never demultiplexes'),
    )
    console.log('HTML:', html)
    expect(html).toContain('<code')
    expect(html).toContain('>execStream</code>')
    expect(html).not.toContain('>`execStream`<')
  })

  it('renders the preview sample', () => {
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
    console.log('SAMPLE:', html)
    expect(html).toContain('<ol')
    expect(html).toMatch(/<code[^>]*>execStream<\/code>/)
    expect(html).not.toMatch(/<code[^>]*>`execStream`<\/code>/)
  })
})
