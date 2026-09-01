import { runGit } from './git.ts'

export const LARGE_MR_FILE_LIMIT = 150
export const LARGE_MR_LINE_LIMIT = 20_000
export const DEFAULT_FILE_PATCH_BYTES = 512 * 1024

export type DiffStatus =
  'added' | 'modified' | 'deleted' | 'renamed' | 'copied' | 'type-changed'

export interface DiffFileSummary {
  path: string
  oldPath: string | null
  status: DiffStatus
  additions: number
  deletions: number
  truncated: boolean
  patch?: string
}

export type DiffResult =
  | {
      status: 'ready'
      files: DiffFileSummary[]
      totalAdditions: number
      totalDeletions: number
    }
  | {
      status: 'needs_scoping'
      files: DiffFileSummary[]
      totalAdditions: number
      totalDeletions: number
      limits: { files: number; lines: number }
    }

export async function computeDiff(input: {
  mirrorPath: string
  baseSha: string
  headSha: string
  selectedPaths?: string[]
  perFilePatchBytes?: number
}): Promise<DiffResult> {
  assertSha(input.baseSha)
  assertSha(input.headSha)
  const range = `${input.baseSha}...${input.headSha}`
  const [names, stats] = await Promise.all([
    runGit([
      '--git-dir',
      input.mirrorPath,
      'diff',
      '--find-renames',
      '--name-status',
      '-z',
      range,
    ]),
    runGit([
      '--git-dir',
      input.mirrorPath,
      'diff',
      '--find-renames',
      '--numstat',
      '-z',
      range,
    ]),
  ])
  const files = mergeSummaries(
    parseNameStatus(names.stdout),
    parseNumstat(stats.stdout),
  )
  const totalAdditions = files.reduce((sum, file) => sum + file.additions, 0)
  const totalDeletions = files.reduce((sum, file) => sum + file.deletions, 0)
  const isLarge =
    files.length > LARGE_MR_FILE_LIMIT ||
    totalAdditions + totalDeletions > LARGE_MR_LINE_LIMIT

  if (isLarge && input.selectedPaths === undefined) {
    return {
      status: 'needs_scoping',
      files,
      totalAdditions,
      totalDeletions,
      limits: { files: LARGE_MR_FILE_LIMIT, lines: LARGE_MR_LINE_LIMIT },
    }
  }

  const selected = input.selectedPaths ? new Set(input.selectedPaths) : null
  if (selected) {
    const known = new Set(files.map((file) => file.path))
    for (const selectedPath of selected) {
      if (!known.has(selectedPath))
        throw new Error(`Selected path is not in the diff: ${selectedPath}`)
    }
  }
  const scoped = selected
    ? files.filter((file) => selected.has(file.path))
    : files
  const withPatches = await Promise.all(
    scoped.map(async (file) => {
      const patch = await runGit(
        [
          '--git-dir',
          input.mirrorPath,
          'diff',
          '--find-renames',
          range,
          '--',
          file.path,
        ],
        { maxOutputBytes: input.perFilePatchBytes ?? DEFAULT_FILE_PATCH_BYTES },
      )
      return { ...file, patch: patch.stdout, truncated: patch.truncated }
    }),
  )
  return { status: 'ready', files: withPatches, totalAdditions, totalDeletions }
}

interface NameEntry {
  path: string
  oldPath: string | null
  status: DiffStatus
}

function parseNameStatus(output: string): NameEntry[] {
  const fields = output.split('\0')
  if (fields.at(-1) === '') fields.pop()
  const result: NameEntry[] = []
  for (let index = 0; index < fields.length;) {
    const code = fields[index++] ?? ''
    const firstPath = fields[index++]
    if (!firstPath) throw new Error('Malformed git name-status output')
    if (code.startsWith('R') || code.startsWith('C')) {
      const newPath = fields[index++]
      if (!newPath)
        throw new Error('Malformed rename in git name-status output')
      result.push({
        path: newPath,
        oldPath: firstPath,
        status: code.startsWith('R') ? 'renamed' : 'copied',
      })
    } else {
      result.push({
        path: firstPath,
        oldPath: null,
        status: statusFromCode(code),
      })
    }
  }
  return result
}

interface NumstatEntry {
  path: string
  additions: number
  deletions: number
}

function parseNumstat(output: string): NumstatEntry[] {
  const fields = output.split('\0')
  if (fields.at(-1) === '') fields.pop()
  const result: NumstatEntry[] = []
  for (let index = 0; index < fields.length; index++) {
    const field = fields[index] ?? ''
    const match = /^(\d+|-)\t(\d+|-)\t(.*)$/.exec(field)
    if (!match) throw new Error('Malformed git numstat output')
    let filePath = match[3]
    if (!filePath) {
      // With -z, rename records end the stat tuple with an empty path followed
      // by old and new path fields.
      index++
      const oldPath = fields[index]
      index++
      const newPath = fields[index]
      if (!oldPath || !newPath)
        throw new Error('Malformed rename in git numstat output')
      filePath = newPath
    }
    result.push({
      path: filePath,
      additions: match[1] === '-' ? 0 : Number(match[1]),
      deletions: match[2] === '-' ? 0 : Number(match[2]),
    })
  }
  return result
}

function mergeSummaries(
  names: NameEntry[],
  stats: NumstatEntry[],
): DiffFileSummary[] {
  const statsByPath = new Map(stats.map((entry) => [entry.path, entry]))
  return names.map((entry) => {
    const stat = statsByPath.get(entry.path)
    return {
      ...entry,
      additions: stat?.additions ?? 0,
      deletions: stat?.deletions ?? 0,
      truncated: false,
    }
  })
}

function statusFromCode(code: string): DiffStatus {
  switch (code[0]) {
    case 'A':
      return 'added'
    case 'D':
      return 'deleted'
    case 'T':
      return 'type-changed'
    default:
      return 'modified'
  }
}

function assertSha(sha: string): void {
  if (!/^[0-9a-f]{40,64}$/i.test(sha))
    throw new Error(`Invalid git SHA: ${sha}`)
}

export const diffParsersForTesting = { parseNameStatus, parseNumstat }
