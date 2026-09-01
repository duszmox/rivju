import { mkdir, readdir, rm, stat } from 'node:fs/promises'
import path from 'node:path'
import { runGit, withMirrorLock } from './git.ts'

const RETENTION_MS = 24 * 60 * 60 * 1000

function assertRunId(runId: string): void {
  if (!/^[a-zA-Z0-9_-]+$/.test(runId)) throw new Error('Invalid run id')
}

export function worktreePathFor(worktreesDir: string, runId: string): string {
  assertRunId(runId)
  return path.join(worktreesDir, runId)
}

export async function addWorktree(input: {
  mirrorPath: string
  worktreesDir: string
  runId: string
  headSha: string
}): Promise<string> {
  const worktreePath = worktreePathFor(input.worktreesDir, input.runId)
  if (!/^[0-9a-f]{40,64}$/i.test(input.headSha))
    throw new Error('Invalid head SHA')
  await mkdir(input.worktreesDir, { recursive: true })
  return withMirrorLock(input.mirrorPath, async () => {
    await rm(worktreePath, { recursive: true, force: true })
    await runGit([
      '--git-dir',
      input.mirrorPath,
      'worktree',
      'add',
      '--detach',
      worktreePath,
      input.headSha,
    ])
    return worktreePath
  })
}

/** Call only after successful run completion. Failures intentionally retain it. */
export async function removeWorktree(input: {
  mirrorPath: string
  worktreesDir: string
  runId: string
}): Promise<void> {
  const worktreePath = worktreePathFor(input.worktreesDir, input.runId)
  await withMirrorLock(input.mirrorPath, async () => {
    await runGit([
      '--git-dir',
      input.mirrorPath,
      'worktree',
      'remove',
      '--force',
      worktreePath,
    ])
    await runGit(['--git-dir', input.mirrorPath, 'worktree', 'prune'])
  })
}

/**
 * Lifecycle wrapper for the review engine: a successful task removes its
 * checkout, while a rejected task deliberately leaves it for diagnostics.
 */
export async function withRunWorktree<T>(
  input: Parameters<typeof addWorktree>[0],
  task: (worktreePath: string) => Promise<T>,
): Promise<T> {
  const worktreePath = await addWorktree(input)
  // If the task rejects, execution never reaches removal and the checkout is
  // intentionally retained until boot GC reaps it after 24 hours.
  const result = await task(worktreePath)
  await removeWorktree({
    mirrorPath: input.mirrorPath,
    worktreesDir: input.worktreesDir,
    runId: input.runId,
  })
  return result
}

export async function gcWorktrees(input: {
  reposDir: string
  worktreesDir: string
  now?: number
}): Promise<{ removed: number }> {
  const now = input.now ?? Date.now()
  const mirrors = await findMirrors(input.reposDir)
  const registered = new Map<string, string>()

  for (const mirror of mirrors) {
    await runGit(['--git-dir', mirror, 'worktree', 'prune']).catch(
      () => undefined,
    )
    const list = await runGit([
      '--git-dir',
      mirror,
      'worktree',
      'list',
      '--porcelain',
    ]).catch(() => null)
    if (!list) continue
    for (const line of list.stdout.split('\n')) {
      if (line.startsWith('worktree '))
        registered.set(path.resolve(line.slice(9)), mirror)
    }
  }

  let removed = 0
  const entries = await readdir(input.worktreesDir, {
    withFileTypes: true,
  }).catch(() => [])
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const worktreePath = path.join(input.worktreesDir, entry.name)
    const info = await stat(worktreePath)
    const mirror = registered.get(path.resolve(worktreePath))
    if (mirror && now - info.mtimeMs < RETENTION_MS) continue
    if (mirror) {
      await removeWorktree({
        mirrorPath: mirror,
        worktreesDir: input.worktreesDir,
        runId: entry.name,
      }).catch(async () => {
        await rm(worktreePath, { recursive: true, force: true })
      })
    } else {
      // Not known to any mirror: an interrupted add/removed mirror left an orphan.
      await rm(worktreePath, { recursive: true, force: true })
    }
    removed++
  }
  return { removed }
}

async function findMirrors(root: string): Promise<string[]> {
  const found: string[] = []
  async function walk(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
    if (entries.some((entry) => entry.name === 'HEAD' && entry.isFile())) {
      found.push(dir)
      return
    }
    await Promise.all(
      entries
        .filter((entry) => entry.isDirectory())
        .map((entry) => walk(path.join(dir, entry.name))),
    )
  }
  await walk(root)
  return found
}
