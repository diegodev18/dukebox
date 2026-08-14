import { describe, expect, it } from 'vitest'
import { buildFileTree } from '@/lib/fileTree'

describe('buildFileTree', () => {
  it('nests files under their directories', () => {
    expect(buildFileTree(['CLAUDE.md', 'src/app.ts', 'src/lib/util.ts'])).toEqual([
      {
        kind: 'dir',
        name: 'src',
        path: 'src',
        children: [
          {
            kind: 'dir',
            name: 'lib',
            path: 'src/lib',
            children: [{ kind: 'file', name: 'util.ts', path: 'src/lib/util.ts' }],
          },
          { kind: 'file', name: 'app.ts', path: 'src/app.ts' },
        ],
      },
      { kind: 'file', name: 'CLAUDE.md', path: 'CLAUDE.md' },
    ])
  })

  it('sorts directories before files', () => {
    const tree = buildFileTree(['z.ts', 'a/b.ts'])
    expect(tree.map((node) => node.name)).toEqual(['a', 'z.ts'])
  })

  it('returns an empty tree for no paths', () => {
    expect(buildFileTree([])).toEqual([])
  })
})
