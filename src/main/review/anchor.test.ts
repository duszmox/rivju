import { describe, expect, it } from 'vitest'
import { reanchorFinding } from './anchor.ts'

const FILE_V1 = [
  'import { parse } from "./parser"',
  '',
  'export function handle(input: string) {',
  '  const value = parse(input)',
  '  if (!value) {',
  '    throw new Error("empty")',
  '  }',
  '  return value.trim()',
  '}',
].join('\n')

function state(overrides: Partial<Parameters<typeof reanchorFinding>[0]['state']> = {}) {
  return {
    filePath: 'src/handler.ts',
    anchorSnippet: '  if (!value) {',
    ctxBefore: '  const value = parse(input)',
    ctxAfter: '    throw new Error("empty")',
    currentLine: 5,
    ...overrides,
  }
}

describe('re-anchoring engine', () => {
  it('reports unchanged when the file and line are identical', () => {
    const result = reanchorFinding({
      content: FILE_V1,
      filePath: 'src/handler.ts',
      state: state(),
    })
    expect(result).toMatchObject({
      outcome: 'unchanged',
      line: 5,
      filePath: 'src/handler.ts',
      tier: 'exact',
      ambiguous: false,
    })
  })

  it('finds the snippet at a shifted line when lines are inserted above', () => {
    const shifted = `${FILE_V1.split('\n').slice(0, 3).join('\n')}\n// new comment\n// another comment\n${FILE_V1.split('\n').slice(3).join('\n')}`
    const result = reanchorFinding({
      content: shifted,
      filePath: 'src/handler.ts',
      state: state(),
    })
    expect(result).toMatchObject({ outcome: 'moved', line: 7 })
  })

  it('disambiguates a duplicated snippet with the recorded context', () => {
    const duplicated = [
      'function first(value: string) {',
      '  const value = parse(value)',
      '  if (!value) {',
      '    throw new Error("empty")',
      '  }',
      '}',
      'function second(input: string) {',
      '  const value = parse(input)',
      '  if (!value) {',
      '    throw new Error("empty")',
      '  }',
      '}',
    ].join('\n')
    // The after-context (`throw new Error("empty")`) appears after BOTH
    // copies and the state carries no before-context, so context cannot
    // separate them — nearest-to-previous-line wins, flagged ambiguous.
    const ambiguous = reanchorFinding({
      content: duplicated,
      filePath: 'src/handler.ts',
      state: state({ ctxBefore: '', currentLine: 4 }),
    })
    expect(ambiguous).toMatchObject({
      outcome: 'moved',
      line: 3,
      ambiguous: true,
    })

    // A distinct before-context pins the later copy exactly.
    const disambiguated = reanchorFinding({
      content: duplicated,
      filePath: 'src/handler.ts',
      state: state({
        ctxBefore: '  const value = parse(input)',
        currentLine: 3,
      }),
    })
    expect(disambiguated).toMatchObject({
      outcome: 'disambiguated',
      line: 9,
      ambiguous: false,
    })
  })

  it('marks the finding stale when the snippet no longer exists', () => {
    const withoutSnippet = FILE_V1
      .split('\n')
      .filter((line) => !line.includes('!value'))
      .join('\n')
    expect(
      reanchorFinding({ content: withoutSnippet, filePath: 'src/handler.ts', state: state() }),
    ).toMatchObject({ outcome: 'stale', reason: 'snippet_gone' })
  })

  it('marks the finding stale when the recorded file is gone', () => {
    expect(
      reanchorFinding({ content: null, filePath: 'src/handler.ts', state: state() }),
    ).toMatchObject({ outcome: 'stale', reason: 'file_missing' })
  })

  it('re-anchors into a renamed file and never reports unchanged across paths', () => {
    const movedContent = FILE_V1.replace(
      'export function handle',
      'export function handleRequest',
    )
    const result = reanchorFinding({
      content: movedContent,
      filePath: 'src/request-handler.ts',
      state: state(),
    })
    expect(result).toMatchObject({
      outcome: 'moved',
      line: 5,
      filePath: 'src/request-handler.ts',
    })
  })

  it('matches after line-ending and trailing-newline normalization', () => {
    const result = reanchorFinding({
      content: `${FILE_V1}\r\n`,
      filePath: 'src/handler.ts',
      state: state(),
    })
    expect(result).toMatchObject({ outcome: 'unchanged', line: 5, tier: 'exact' })
  })

  it('falls back to trimmed matching when only indentation changed and refreshes the snippet', () => {
    const reindented = FILE_V1.split('\n')
      .map((line) => (line.startsWith('  if') ? `    ${line.trim()}` : line))
      .join('\n')
    const result = reanchorFinding({
      content: reindented,
      filePath: 'src/handler.ts',
      state: state(),
    })
    expect(result).toMatchObject({
      outcome: 'unchanged',
      line: 5,
      tier: 'trimmed',
      snippet: '    if (!value) {',
    })
  })

  it('returns refreshed three-line context at the new location', () => {
    const result = reanchorFinding({
      content: FILE_V1,
      filePath: 'src/handler.ts',
      state: state({ ctxBefore: null, ctxAfter: null }),
    })
    if (result.outcome === 'stale') throw new Error('expected a match')
    expect(result.ctxBefore.split('\n')).toEqual([
      '',
      'export function handle(input: string) {',
      '  const value = parse(input)',
    ])
    expect(result.ctxAfter.split('\n')).toEqual([
      '    throw new Error("empty")',
      '  }',
      '  return value.trim()',
    ])
  })
})
