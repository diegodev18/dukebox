import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { Diff } from '@/components/Diff'

describe('Diff', () => {
  it('lets a collapsed hunk be expanded', async () => {
    const before = Array.from({ length: 20 }, (_, i) => `line ${i}`).join('\n')
    const after = before.replace('line 10', 'CHANGED')

    render(<Diff file={{ path: 'a.ts', before, after }} />)

    expect(screen.queryByText('line 0')).not.toBeInTheDocument()
    await userEvent.click(screen.getAllByRole('button', { name: /unchanged line/ })[0]!)
    expect(screen.getByText('line 0')).toBeInTheDocument()
  })

  it('says when a large file was simplified', () => {
    const before = Array.from({ length: 1600 }, (_, i) => `a ${i}`).join('\n')
    const after = Array.from({ length: 1600 }, (_, i) => `b ${i}`).join('\n')

    render(<Diff file={{ path: 'big.ts', before, after }} />)

    expect(screen.getByText(/diff simplified/i)).toBeInTheDocument()
  })
})
