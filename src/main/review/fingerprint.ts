import { createHash } from 'node:crypto'

/** Stable identity deliberately excludes line numbers and finding prose. */
export function normalizeAnchorSnippet(snippet: string): string {
  return snippet
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.trim())
    .join('\n')
    .trim()
}

export function findingFingerprint(input: {
  filePath: string | null | undefined
  anchorSnippet: string | null | undefined
  category: string
}): string {
  return createHash('sha256')
    .update(input.filePath ?? '')
    .update(normalizeAnchorSnippet(input.anchorSnippet ?? ''))
    .update(input.category)
    .digest('hex')
}
