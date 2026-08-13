/**
 * Turn a flat list of repo-relative paths into a directory tree.
 *
 * Directories sort before files, then by name. The Files tab walks this
 * rather than inventing a second listing API per folder.
 */

export type FileTreeNode =
  | { kind: 'dir'; name: string; path: string; children: FileTreeNode[] }
  | { kind: 'file'; name: string; path: string }

type MutableDir = {
  kind: 'dir'
  name: string
  path: string
  children: Map<string, MutableDir | MutableFile>
}

type MutableFile = { kind: 'file'; name: string; path: string }

export function buildFileTree(paths: readonly string[]): FileTreeNode[] {
  const root: MutableDir['children'] = new Map()

  for (const path of paths) {
    const parts = path.split('/').filter(Boolean)
    if (parts.length === 0) continue

    let current = root
    let prefix = ''

    for (let index = 0; index < parts.length; index++) {
      const name = parts[index]!
      prefix = prefix ? `${prefix}/${name}` : name
      const isFile = index === parts.length - 1

      if (isFile) {
        current.set(name, { kind: 'file', name, path })
        continue
      }

      const existing = current.get(name)
      if (existing?.kind === 'dir') {
        current = existing.children
        continue
      }

      const dir: MutableDir = { kind: 'dir', name, path: prefix, children: new Map() }
      current.set(name, dir)
      current = dir.children
    }
  }

  return freeze(root)
}

function freeze(nodes: Map<string, MutableDir | MutableFile>): FileTreeNode[] {
  return [...nodes.values()]
    .map((node) =>
      node.kind === 'dir'
        ? {
            kind: 'dir' as const,
            name: node.name,
            path: node.path,
            children: freeze(node.children),
          }
        : node,
    )
    .sort((left, right) => {
      if (left.kind !== right.kind) return left.kind === 'dir' ? -1 : 1
      return left.name.localeCompare(right.name)
    })
}
