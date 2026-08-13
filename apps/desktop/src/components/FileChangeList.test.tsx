import { render, screen, waitFor } from '@testing-library/react'
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
  it('opens every file by default and sticks names above the diffs', async () => {
    render(<FileChangeList files={files} />)

    for (const file of files) {
      const header = screen.getByRole('button', { name: basename(file.path) })
      expect(header).toHaveAttribute('aria-expanded', 'true')
      expect(header.className).toMatch(/\bsticky\b/)
      expect(header.closest('.overflow-auto')).not.toBeNull()
    }
    await waitFor(() => {
      expect(screen.getByText('return demuxed').closest('[aria-busy="false"]')).not.toBeNull()
      expect(
        screen.getByText("it('strips headers', () => {})").closest('[aria-busy="false"]'),
      ).not.toBeNull()
    })
  })

  it('collapses a diff and expands it again', async () => {
    render(<FileChangeList files={files} />)

    const header = screen.getByRole('button', { name: 'demux.test.ts' })
    await userEvent.click(header)
    expect(header).toHaveAttribute('aria-expanded', 'false')
    await userEvent.click(header)
    expect(header).toHaveAttribute('aria-expanded', 'true')
    await waitFor(() => {
      expect(
        screen.getByText("it('strips headers', () => {})").closest('[aria-busy="false"]'),
      ).not.toBeNull()
    })
  })
})

function basename(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1)
}
