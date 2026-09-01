/**
 * A minimal line diff, used to show the user exactly what rejection
 * distillation is about to append to their rules skill before it is written.
 *
 * Pure and dependency-free: `react-diff-view` in the renderer consumes unified
 * patch text produced by git, which is the wrong shape here (nothing is a git
 * object), and pulling a diff library into the main process for one screen is
 * not worth it.
 */

export type DiffLineKind = 'context' | 'add' | 'delete' | 'gap'

export interface DiffLine {
  kind: DiffLineKind
  text: string
  oldLine: number | null
  newLine: number | null
}

const MAX_DIFF_LINES = 4000
const CONTEXT = 3

export function diffLines(before: string, after: string): DiffLine[] {
  const a = splitLines(before)
  const b = splitLines(after)
  if (a.length + b.length > MAX_DIFF_LINES) return wholeFileDiff(a, b)
  return collapse(computeDiff(a, b))
}

export function hasChanges(lines: DiffLine[]): boolean {
  return lines.some((line) => line.kind === 'add' || line.kind === 'delete')
}

function splitLines(value: string): string[] {
  if (value === '') return []
  return value.replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n')
}

/** Classic LCS table walk — inputs here are a few hundred lines at most. */
function computeDiff(a: string[], b: string[]): DiffLine[] {
  const lengths: number[][] = Array.from({ length: a.length + 1 }, () =>
    new Array<number>(b.length + 1).fill(0),
  )
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lengths[i][j] = a[i] === b[j] ? lengths[i + 1][j + 1] + 1 : Math.max(lengths[i + 1][j], lengths[i][j + 1])
    }
  }

  const out: DiffLine[] = []
  let i = 0
  let j = 0
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push({ kind: 'context', text: a[i], oldLine: i + 1, newLine: j + 1 })
      i++
      j++
    } else if (lengths[i + 1][j] >= lengths[i][j + 1]) {
      out.push({ kind: 'delete', text: a[i], oldLine: i + 1, newLine: null })
      i++
    } else {
      out.push({ kind: 'add', text: b[j], oldLine: null, newLine: j + 1 })
      j++
    }
  }
  for (; i < a.length; i++) out.push({ kind: 'delete', text: a[i], oldLine: i + 1, newLine: null })
  for (; j < b.length; j++) out.push({ kind: 'add', text: b[j], oldLine: null, newLine: j + 1 })
  return out
}

/** Keep 3 lines of context around each change; replace the rest with a gap. */
function collapse(lines: DiffLine[]): DiffLine[] {
  const keep = new Array<boolean>(lines.length).fill(false)
  lines.forEach((line, index) => {
    if (line.kind === 'context') return
    for (let k = Math.max(0, index - CONTEXT); k <= Math.min(lines.length - 1, index + CONTEXT); k++) {
      keep[k] = true
    }
  })

  const out: DiffLine[] = []
  let skipped = 0
  lines.forEach((line, index) => {
    if (keep[index]) {
      if (skipped > 0) {
        out.push({
          kind: 'gap',
          text: `${skipped} unchanged line${skipped === 1 ? '' : 's'}`,
          oldLine: null,
          newLine: null,
        })
        skipped = 0
      }
      out.push(line)
    } else {
      skipped++
    }
  })
  if (skipped > 0) {
    out.push({
      kind: 'gap',
      text: `${skipped} unchanged line${skipped === 1 ? '' : 's'}`,
      oldLine: null,
      newLine: null,
    })
  }
  return out
}

function wholeFileDiff(a: string[], b: string[]): DiffLine[] {
  return [
    { kind: 'gap', text: `${a.length} existing lines (too large to diff line by line)`, oldLine: null, newLine: null },
    ...b.slice(a.length).map<DiffLine>((text, index) => ({
      kind: 'add',
      text,
      oldLine: null,
      newLine: a.length + index + 1,
    })),
  ]
}
