import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { FileChangeList } from '@/components/FileChangeList'

vi.mock('@/lib/syntaxHighlight', () => ({
  tokensForCode: async (_path: string, code: string) =>
    code.split('\n').map((content) => [{ content: content || ' ' }]),
}))

const files = [
  {
    path: 'packages/sandbox/src/container.ts',
    before: 'return raw',
    after: 'return demuxed',
  },
  {
    path: 'packages/sandbox/src/demux.test.ts',
    before: null,
    after: "it('strips headers', () => {})",
  },
]

describe('FileChangeList', () => {
  it('opens the first file and sticks its name above the diff', () => {
    render(<FileChangeList files={files} />)

    const header = screen.getByRole('button', { name: 'container.ts' })
    expect(header).toHaveAttribute('aria-expanded', 'true')
    expect(header.className).toMatch(/\bsticky\b/)
    expect(header.closest('.overflow-auto')).not.toBeNull()
    expect(screen.getByText('return demuxed')).toBeInTheDocument()
  })

  it('keeps later files collapsed until chosen', async () => {
    render(<FileChangeList files={files} />)

    expect(screen.getByRole('button', { name: 'demux.test.ts' })).toHaveAttribute(
      'aria-expanded',
      'false',
    )
    await userEvent.click(screen.getByRole('button', { name: 'demux.test.ts' }))
    expect(screen.getByRole('button', { name: 'demux.test.ts' })).toHaveAttribute(
      'aria-expanded',
      'true',
    )
    expect(screen.getByText("it('strips headers', () => {})")).toBeInTheDocument()
  })
})
