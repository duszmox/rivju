/**
 * Pure re-anchoring engine — no I/O. The caller reads the file content at the
 * new head and passes it in together with the finding's recorded anchor state.
 *
 * Semantics (00-architecture.md "Finding identity and re-anchoring"):
 * - exact `anchor_snippet` match in the file at the new head -> the new line;
 * - multiple matches -> disambiguated with `ctx_before` / `ctx_after`;
 * - zero matches -> `stale`.
 *
 * `stale` means "the code moved or vanished", NOT "fixed". Only the verify
 * agent may set `fixed`.
 */

export type AnchorMatchTier = 'exact' | 'trimmed'

export type AnchorResolution =
  | {
      outcome: 'unchanged' | 'moved' | 'disambiguated'
      /** 1-based line of the first anchor line at the new head. */
      line: number
      filePath: string
      /** The anchor text exactly as it appears at the new location. */
      snippet: string
      ctxBefore: string
      ctxAfter: string
      tier: AnchorMatchTier
      /** True when context could not narrow several equally valid matches. */
      ambiguous: boolean
    }
  | { outcome: 'stale'; reason: 'file_missing' | 'snippet_gone' }

export interface AnchorState {
  /** Path the finding was recorded under (used for the unchanged check). */
  filePath: string
  anchorSnippet: string
  ctxBefore: string | null
  ctxAfter: string | null
  currentLine: number | null
}

const CONTEXT_LINES = 3

export function reanchorFinding(input: {
  /** File content at the new head; null when the path does not exist there. */
  content: string | null
  /** Path to search at the new head — the caller resolves renames first. */
  filePath: string
  state: AnchorState
}): AnchorResolution {
  if (input.content === null) return { outcome: 'stale', reason: 'file_missing' }
  const snippetLines = splitLines(input.state.anchorSnippet)
  if (!snippetLines.length) return { outcome: 'stale', reason: 'snippet_gone' }
  const contentLines = splitLines(input.content)

  let tier: AnchorMatchTier = 'exact'
  let haystack = contentLines
  let needle = snippetLines
  let positions = matchPositions(haystack, needle)
  if (!positions.length) {
    tier = 'trimmed'
    haystack = contentLines.map(trimLine)
    needle = snippetLines.map(trimLine)
    positions = matchPositions(haystack, needle)
  }
  if (!positions.length) return { outcome: 'stale', reason: 'snippet_gone' }

  let line: number
  let ambiguous = false
  let disambiguated = false
  if (positions.length === 1) {
    line = positions[0] + 1
  } else {
    const narrowed = narrowWithContext(
      haystack,
      positions,
      needle.length,
      splitLines(input.state.ctxBefore ?? ''),
      splitLines(input.state.ctxAfter ?? ''),
    )
    if (narrowed.length === 1) {
      line = narrowed[0] + 1
      disambiguated = true
    } else {
      // Duplicated snippet that context cannot separate (or that repeats the
      // same context): stay stable by keeping the occurrence nearest to the
      // previously recorded line.
      line = nearestTo(positions, input.state.currentLine) + 1
      ambiguous = true
    }
  }

  const outcome = pickOutcome(input, line, disambiguated)
  const start = line - 1
  const end = start + snippetLines.length
  return {
    outcome,
    line,
    filePath: input.filePath,
    snippet: contentLines.slice(start, end).join('\n'),
    ctxBefore: contentLines.slice(Math.max(0, start - CONTEXT_LINES), start).join('\n'),
    ctxAfter: contentLines.slice(end, end + CONTEXT_LINES).join('\n'),
    tier,
    ambiguous,
  }
}

function pickOutcome(
  input: { filePath: string; state: AnchorState },
  line: number,
  disambiguated: boolean,
): 'unchanged' | 'moved' | 'disambiguated' {
  const samePlace =
    input.state.currentLine === line && input.state.filePath === input.filePath
  if (samePlace) return 'unchanged'
  return disambiguated ? 'disambiguated' : 'moved'
}

function matchPositions(haystack: string[], needle: string[]): number[] {
  const positions: number[] = []
  if (!needle.length || needle.length > haystack.length) return positions
  outer: for (let start = 0; start <= haystack.length - needle.length; start++) {
    for (let offset = 0; offset < needle.length; offset++) {
      if (haystack[start + offset] !== needle[offset]) continue outer
    }
    positions.push(start)
  }
  return positions
}

/**
 * Keeps only the occurrences whose surrounding lines still match the context
 * recorded with the finding. Missing context (empty strings) matches nothing
 * extra, so it cannot narrow on its own.
 */
function narrowWithContext(
  haystack: string[],
  positions: number[],
  needleLength: number,
  ctxBefore: string[],
  ctxAfter: string[],
): number[] {
  const before = ctxBefore.slice(-CONTEXT_LINES)
  const after = ctxAfter.slice(0, CONTEXT_LINES)
  const hasContext = before.some(nonEmptyLine) || after.some(nonEmptyLine)
  if (!hasContext) return positions
  return positions.filter((start) => {
    if (before.length && start - before.length < 0) return false
    if (before.length && !sliceEquals(haystack, start - before.length, before)) return false
    if (after.length) {
      const afterStart = start + needleLength
      if (afterStart + after.length > haystack.length) return false
      if (!sliceEquals(haystack, afterStart, after)) return false
    }
    return true
  })
}

function sliceEquals(haystack: string[], start: number, expected: string[]): boolean {
  for (let index = 0; index < expected.length; index++) {
    if (haystack[start + index] !== expected[index]) return false
  }
  return true
}

function nearestTo(positions: number[], currentLine: number | null): number {
  const target = currentLine === null ? 0 : currentLine - 1
  let best = positions[0]
  for (const position of positions) {
    if (Math.abs(position - target) < Math.abs(best - target)) best = position
  }
  return best
}

function splitLines(text: string): string[] {
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  if (lines.at(-1) === '') lines.pop()
  return lines
}

function trimLine(line: string): string {
  return line.trim()
}

function nonEmptyLine(line: string): boolean {
  return line.trim().length > 0
}
