import { lstat, readFile, realpath } from 'node:fs/promises'
import path from 'node:path'

export type FindingLocation = {
  scope: 'line' | 'file' | 'global'
  file_path?: string | null
  line?: number | null
  anchor_snippet?: string | null
}

export type VerificationResult =
  | {
      ok: true
      filePath: string | null
      line: number | null
      anchorSnippet: string | null
      ctxBefore: string
      ctxAfter: string
    }
  | { ok: false; error: string }

/**
 * Proves an anchor against the detached worktree checked out at head_sha.
 * Path containment and realpath checks also prevent a repository symlink from
 * turning this read-only verifier into an arbitrary host-file reader.
 */
export async function verifyFindingLocation(
  worktreePath: string,
  input: FindingLocation,
): Promise<VerificationResult> {
  if (input.scope === 'global') {
    if (input.file_path || input.line || input.anchor_snippet) {
      return { ok: false, error: 'Global findings must not claim a file, line, or anchor snippet.' }
    }
    return { ok: true, filePath: null, line: null, anchorSnippet: null, ctxBefore: '', ctxAfter: '' }
  }

  const filePath = input.file_path?.trim()
  if (!filePath) return { ok: false, error: 'A line or file finding requires file_path.' }
  if (path.isAbsolute(filePath) || filePath.split(/[\\/]/).includes('..')) {
    return { ok: false, error: `file_path must stay inside the reviewed checkout: ${filePath}` }
  }

  const root = await realpath(worktreePath)
  const candidate = path.resolve(root, filePath)
  let resolved: string
  try {
    resolved = await realpath(candidate)
    const info = await lstat(resolved)
    if (!info.isFile()) return { ok: false, error: `file_path is not a regular file at head_sha: ${filePath}` }
  } catch {
    return { ok: false, error: `file_path does not exist at head_sha: ${filePath}` }
  }
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
    return { ok: false, error: `file_path resolves outside the reviewed checkout: ${filePath}` }
  }

  const line = input.line
  const snippet = input.anchor_snippet?.replace(/\r\n?/g, '\n').replace(/\n$/, '')
  if (!line || line < 1 || !Number.isInteger(line)) {
    return { ok: false, error: 'A line or file finding requires a positive integer line.' }
  }
  if (!snippet) return { ok: false, error: 'A line or file finding requires anchor_snippet.' }
  const snippetLines = snippet.split('\n')
  if (snippetLines.length > 3) {
    return { ok: false, error: 'anchor_snippet must contain between 1 and 3 lines.' }
  }

  const content = (await readFile(resolved, 'utf8')).replace(/\r\n?/g, '\n')
  const contentLines = content.split('\n')
  if (contentLines.at(-1) === '') contentLines.pop()
  const start = line - 1
  const end = start + snippetLines.length
  const actual = contentLines.slice(start, end).join('\n')
  if (actual !== snippet) {
    return {
      ok: false,
      error: `anchor_snippet does not match ${filePath} at line ${line}. Re-read the file and submit the exact 1-3 lines from head_sha.`,
    }
  }
  return {
    ok: true,
    filePath,
    line,
    anchorSnippet: snippet,
    ctxBefore: contentLines.slice(Math.max(0, start - 3), start).join('\n'),
    ctxAfter: contentLines.slice(end, end + 3).join('\n'),
  }
}
