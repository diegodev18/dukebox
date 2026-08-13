import { createHighlighter, type BundledLanguage, type Highlighter } from 'shiki'

/**
 * Token colours for a diff row.
 *
 * The highlighter runs on the whole file, not on each changed line: a string
 * that opens on line 4 and closes on line 12 would otherwise paint those
 * lines as two different languages. Rows then pick the line they already
 * numbered.
 */

export type HighlightToken = {
  content: string
  style?: Record<string, string>
}

const LANGUAGES = [
  'ts',
  'tsx',
  'js',
  'jsx',
  'json',
  'markdown',
  'css',
  'html',
  'rust',
  'go',
  'python',
  'toml',
  'yaml',
  'bash',
] as const satisfies readonly BundledLanguage[]

type HighlightLanguage = (typeof LANGUAGES)[number]

const BY_EXTENSION: Record<string, HighlightLanguage> = {
  ts: 'ts',
  mts: 'ts',
  cts: 'ts',
  tsx: 'tsx',
  js: 'js',
  mjs: 'js',
  cjs: 'js',
  jsx: 'jsx',
  json: 'json',
  md: 'markdown',
  markdown: 'markdown',
  css: 'css',
  html: 'html',
  htm: 'html',
  rs: 'rust',
  go: 'go',
  py: 'python',
  toml: 'toml',
  yaml: 'yaml',
  yml: 'yaml',
  sh: 'bash',
  bash: 'bash',
  zsh: 'bash',
}

/** Grammar to load for a path, or plaintext when the extension is unknown. */
export function languageFromPath(path: string): HighlightLanguage | 'plaintext' {
  const base = path.slice(path.lastIndexOf('/') + 1)
  const dot = base.lastIndexOf('.')
  if (dot <= 0) return 'plaintext'
  const ext = base.slice(dot + 1).toLowerCase()
  return BY_EXTENSION[ext] ?? 'plaintext'
}

let highlighter: Promise<Highlighter> | null = null

function getHighlighter(): Promise<Highlighter> {
  highlighter ??= createHighlighter({
    langs: [],
    themes: ['github-light', 'github-dark'],
  })
  return highlighter
}

/** Tokens for each line of `code`, in file order. Empty files yield no lines. */
export async function tokensForCode(path: string, code: string): Promise<HighlightToken[][]> {
  if (code === '') return []
  const lang = languageFromPath(path)
  if (lang === 'plaintext') return unstyled(code)

  try {
    const loaded = await getHighlighter()
    const loadedLangs = loaded.getLoadedLanguages()
    if (!loadedLangs.includes(lang)) {
      await loaded.loadLanguage(lang)
    }
    const result = loaded.codeToTokens(code, {
      lang,
      themes: { light: 'github-light', dark: 'github-dark' },
      defaultColor: false,
    })
    return result.tokens.map((line) =>
      line.map((token) => ({
        content: token.content,
        ...(token.htmlStyle ? { style: token.htmlStyle } : {}),
      })),
    )
  } catch {
    // Colour is decoration. A missing grammar must not blank the diff.
    return unstyled(code)
  }
}

function unstyled(code: string): HighlightToken[][] {
  return code.split('\n').map((content) => [{ content }])
}
