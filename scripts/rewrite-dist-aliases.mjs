/**
 * Rewrite `@/` path aliases in tsc emit to relative specifiers with a `.js`
 * extension. tsc leaves aliases untouched; Node ESM cannot load them.
 *
 * Only `@/` specifiers are rewritten so bare package names (e.g. `ws`) stay
 * intact — tsc-alias's resolveFullPaths is too eager when a folder shares a
 * package name.
 *
 * Usage (cwd = package root, emit in ./dist):
 *   node ../../scripts/rewrite-dist-aliases.mjs
 */
import { readdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

const outDir = path.resolve(process.argv[2] ?? './dist')
const specifier = /((?:from|import)\s*\(?\s*)(['"])@\/([^'"]+)\2/g

async function walk(dir) {
  const out = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...(await walk(full)))
    else if (/\.(js|d\.ts)$/.test(entry.name)) out.push(full)
  }
  return out
}

for (const file of await walk(outDir)) {
  const text = await readFile(file, 'utf8')
  const next = text.replace(specifier, (_m, pref, q, spec) => {
    const target = path.resolve(outDir, spec)
    let rel = path.relative(path.dirname(file), target).split(path.sep).join('/')
    if (!rel.startsWith('.')) rel = `./${rel}`
    return `${pref}${q}${rel}.js${q}`
  })
  if (next !== text) await writeFile(file, next)
}
