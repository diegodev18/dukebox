import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { Diff } from '@/components/Diff'

/** Innermost node whose full text matches, even when Shiki split it into spans. */
const withText = (text: string) => (_: string, node: Element | null) => {
  if (!node || node.textContent !== text) return false
  return ![...node.children].some((child) => child.textContent === text)
}

describe('Diff', () => {
  it('lets a collapsed hunk be expanded', async () => {
    const before = Array.from({ length: 20 }, (_, i) => `line ${i}`).join('\n')
    const after = before.replace('line 10', 'CHANGED')

    render(<Diff file={{ path: 'a.txt', before, after }} />)

    await waitFor(() => {
      expect(screen.getByText('CHANGED').closest('[aria-busy="false"]')).not.toBeNull()
    })
    expect(screen.queryByText(withText('line 0'))).not.toBeInTheDocument()
    await userEvent.click(screen.getAllByRole('button', { name: /unchanged line/ })[0]!)
    expect(screen.getByText(withText('line 0'))).toBeInTheDocument()
  })

  it('says when a large file was simplified', async () => {
    const before = Array.from({ length: 1600 }, (_, i) => `a ${i}`).join('\n')
    const after = Array.from({ length: 1600 }, (_, i) => `b ${i}`).join('\n')

    render(<Diff file={{ path: 'big.txt', before, after }} />)

    await waitFor(() => {
      expect(screen.getByText(/diff simplified/i).closest('[aria-busy="false"]')).not.toBeNull()
    })
  })

  it('shows line numbers and no plus or minus prefixes', async () => {
    render(<Diff file={{ path: 'a.txt', before: 'a\nb\nc', after: 'a\nB\nc' }} />)

    await waitFor(() => {
      expect(screen.getByText('B').closest('[aria-busy="false"]')).not.toBeNull()
    })
    expect(screen.getByText('b')).toBeInTheDocument()
    expect(screen.queryByText('+')).not.toBeInTheDocument()
    expect(screen.queryByText('−')).not.toBeInTheDocument()
    // Old line 2 (removed b) and new line 2 (added B) both appear.
    expect(screen.getAllByText('2').length).toBeGreaterThanOrEqual(2)
  })

  it('keeps line numbers on an expanded hunk', async () => {
    const before = Array.from({ length: 20 }, (_, i) => `line ${i}`).join('\n')
    const after = before.replace('line 10', 'CHANGED')

    render(<Diff file={{ path: 'a.txt', before, after }} />)

    await waitFor(() => {
      expect(screen.getByText('CHANGED').closest('[aria-busy="false"]')).not.toBeNull()
    })
    await userEvent.click(screen.getAllByRole('button', { name: /unchanged line/ })[0]!)
    expect(screen.getByText(withText('line 0'))).toBeInTheDocument()
    expect(screen.getAllByText('1').length).toBeGreaterThanOrEqual(2)
  })

  it('colours TypeScript keywords once the highlighter is ready', async () => {
    render(
      <Diff
        file={{
          path: 'a.ts',
          before: 'function foo() {\n  return 1\n}',
          after: 'function foo() {\n  return 2\n}',
        }}
      />,
    )

    await waitFor(
      () => {
        const keyword = screen.getAllByText('function')[0]
        expect(keyword?.tagName).toBe('SPAN')
        expect(keyword?.getAttribute('style') ?? '').toMatch(/--shiki-(light|dark)/)
      },
      { timeout: 15_000 },
    )
  })
})
