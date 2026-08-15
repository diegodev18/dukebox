import { describe, expect, it } from 'vitest'
import {
  fileDirOf,
  fileNameOf,
  filterMentionPaths,
  insertMention,
  mentionQueryAt,
} from '@/lib/fileMentions'

describe('mentionQueryAt', () => {
  it('finds an @ token at the start of the text', () => {
    expect(mentionQueryAt('@src', 4)).toEqual({ start: 0, query: 'src' })
  })

  it('finds an @ token after whitespace', () => {
    expect(mentionQueryAt('look at @app', 12)).toEqual({ start: 8, query: 'app' })
  })

  it('uses the cursor, not the end of the text', () => {
    expect(mentionQueryAt('see @REA please', 8)).toEqual({ start: 4, query: 'REA' })
  })

  it('ignores an @ in the middle of a word', () => {
    expect(mentionQueryAt('user@host', 9)).toBeNull()
  })

  it('is null when the cursor is not inside an @ token', () => {
    expect(mentionQueryAt('see @app later', 3)).toBeNull()
    expect(mentionQueryAt('see @app later', 14)).toBeNull()
  })
})

describe('filterMentionPaths', () => {
  const paths = ['README.md', 'src/app.ts', 'src/lib/util.ts', 'docs/guide.md']

  it('ranks a filename prefix above a path substring', () => {
    expect(filterMentionPaths(paths, 'app')).toEqual(['src/app.ts'])
  })

  it('matches a directory prefix in the path', () => {
    expect(filterMentionPaths(paths, 'docs')).toEqual(['docs/guide.md'])
  })

  it('lists paths alphabetically when the query is empty', () => {
    expect(filterMentionPaths(paths, '')).toEqual([
      'docs/guide.md',
      'README.md',
      'src/app.ts',
      'src/lib/util.ts',
    ])
  })

  it('caps the result list', () => {
    const many = Array.from({ length: 50 }, (_, index) => `file-${index}.ts`)
    expect(filterMentionPaths(many, 'file', 8)).toHaveLength(8)
  })
})

describe('insertMention', () => {
  it('replaces the query with the path and a trailing space', () => {
    expect(insertMention('look at @ap', 8, 11, 'src/app.ts')).toEqual({
      text: 'look at @src/app.ts ',
      cursor: 20,
    })
  })
})

describe('path parts', () => {
  it('splits a nested path into name and directory', () => {
    expect(fileNameOf('src/lib/util.ts')).toBe('util.ts')
    expect(fileDirOf('src/lib/util.ts')).toBe('src/lib')
  })

  it('treats a root file as having no directory', () => {
    expect(fileNameOf('README.md')).toBe('README.md')
    expect(fileDirOf('README.md')).toBe('')
  })
})
