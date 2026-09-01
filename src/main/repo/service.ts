import { dialog } from 'electron'
import { and, eq } from 'drizzle-orm'
import { mkdir, readdir, realpath, rm, stat } from 'node:fs/promises'
import path from 'node:path'
import { getDb } from '../db/client.ts'
import { gitlabInstance, project } from '../db/schema.ts'
import { resolvePaths } from '../paths.ts'
import { decryptToken } from '../security/tokens.ts'
import { computeDiff } from './diff.ts'
import { runGit } from './git.ts'
import { ensureMirror, fetchMergeRequest } from './mirror.ts'
import { addWorktree, gcWorktrees } from './worktree.ts'
import type { DiffResult } from './diff.ts'
import type { ProjectRow } from '../db/schema.ts'

export type RepoOperationPhase =
  | 'idle'
  | 'cloning'
  | 'fetching'
  | 'checking_out'
  | 'diffing'
  | 'ready'
  | 'needs_scoping'
  | 'error'

export interface RepoOperationStatus {
  phase: RepoOperationPhase
  detail: string | null
  updatedAt: number
}

const statuses = new Map<string, RepoOperationStatus>()
const preparations = new Map<string, PrepareResult>()
const pendingPreparations = new Map<string, Promise<PrepareResult>>()
let activeOperations = 0

type PrepareResult = { runId: string; worktreePath: string; diff: DiffResult }

export function operationKey(
  instanceId: string,
  gitlabProjectId: number,
  iid: number,
): string {
  return `${instanceId}:${gitlabProjectId}:${iid}`
}

function setStatus(
  key: string,
  phase: RepoOperationPhase,
  detail: string | null = null,
): void {
  statuses.set(key, { phase, detail, updatedAt: Date.now() })
}

export function getRepoStatus(key: string): RepoOperationStatus {
  return (
    statuses.get(key) ?? { phase: 'idle', detail: null, updatedAt: Date.now() }
  )
}

export async function prepareMergeRequest(input: {
  instanceId: string
  gitlabProjectId: number
  iid: number
  baseSha: string
  headSha: string
  selectedPaths?: string[]
}): Promise<PrepareResult> {
  const key = operationKey(input.instanceId, input.gitlabProjectId, input.iid)
  const cacheKey = preparationCacheKey(key, input)
  const cached = preparations.get(cacheKey)
  if (cached) {
    setStatusFromResult(key, cached)
    return cached
  }
  const pending = pendingPreparations.get(cacheKey)
  if (pending) return pending
  const operation = doPrepareMergeRequest(input, key)
  pendingPreparations.set(cacheKey, operation)
  try {
    const result = await operation
    preparations.set(cacheKey, result)
    return result
  } finally {
    pendingPreparations.delete(cacheKey)
  }
}

function setStatusFromResult(key: string, result: PrepareResult): void {
  setStatus(
    key,
    result.diff.status === 'needs_scoping' ? 'needs_scoping' : 'ready',
    result.diff.status === 'needs_scoping'
      ? 'This merge request needs a file scope'
      : 'Checkout ready',
  )
}

function preparationCacheKey(
  operation: string,
  input: { baseSha: string; headSha: string; selectedPaths?: string[] },
): string {
  const scope = input.selectedPaths
    ? [...input.selectedPaths].sort().join('\0')
    : '*'
  return `${operation}:${input.baseSha}:${input.headSha}:${scope}`
}

async function doPrepareMergeRequest(
  input: {
    instanceId: string
    gitlabProjectId: number
    iid: number
    baseSha: string
    headSha: string
    selectedPaths?: string[]
  },
  key: string,
): Promise<PrepareResult> {
  activeOperations++
  try {
    setStatus(key, 'cloning', 'Checking repository mirror')
    const rows = lookupProject(input.instanceId, input.gitlabProjectId)
    const paths = resolvePaths()
    const token = decryptToken(rows.instance.tokenCiphertext)
    const mirrorProject = {
      instanceId: rows.project.instanceId,
      pathWithNamespace: rows.project.pathWithNamespace,
      baseUrl: rows.instance.baseUrl,
      referenceClonePath: rows.project.referenceClonePath,
    }
    const onProgress = (phase: 'cloning' | 'fetching', detail?: string): void =>
      setStatus(key, phase, detail || null)
    const mirrorPath = await ensureMirror({
      reposDir: paths.reposDir,
      project: mirrorProject,
      token,
      onProgress,
    })
    getDb()
      .update(project)
      .set({ mirrorPath })
      .where(eq(project.id, rows.project.id))
      .run()
    await fetchMergeRequest({ mirrorPath, iid: input.iid, token, onProgress })
    const runId = crypto.randomUUID()
    setStatus(key, 'checking_out', 'Creating detached worktree')
    const worktreePath = await addWorktree({
      mirrorPath,
      worktreesDir: paths.worktreesDir,
      runId,
      headSha: input.headSha,
    })
    setStatus(key, 'diffing', 'Computing structured diff')
    const diff = await computeDiff({
      mirrorPath,
      baseSha: input.baseSha,
      headSha: input.headSha,
      selectedPaths: input.selectedPaths,
    })
    const result = { runId, worktreePath, diff }
    setStatusFromResult(key, result)
    return result
  } catch (error) {
    setStatus(
      key,
      'error',
      error instanceof Error ? error.message : String(error),
    )
    throw error
  } finally {
    activeOperations--
  }
}

function lookupProject(
  instanceId: string,
  gitlabProjectId: number,
): {
  project: ProjectRow
  instance: typeof gitlabInstance.$inferSelect
} {
  const row = getDb()
    .select({ project, instance: gitlabInstance })
    .from(project)
    .innerJoin(gitlabInstance, eq(project.instanceId, gitlabInstance.id))
    .where(
      and(
        eq(project.instanceId, instanceId),
        eq(project.gitlabProjectId, String(gitlabProjectId)),
      ),
    )
    .get()
  if (!row)
    throw new Error(
      'Project must be loaded from GitLab before preparing its repository',
    )
  return row
}

export async function chooseReferenceClone(): Promise<string | null> {
  const result = await dialog.showOpenDialog({
    title: 'Choose an existing local clone',
    properties: ['openDirectory'],
  })
  return result.canceled ? null : (result.filePaths[0] ?? null)
}

export async function mapReferenceClone(input: {
  instanceId: string
  projectId: string
  clonePath: string | null
}): Promise<{ referenceClonePath: string | null }> {
  const row = getDb()
    .select()
    .from(project)
    .where(
      and(
        eq(project.id, input.projectId),
        eq(project.instanceId, input.instanceId),
      ),
    )
    .get()
  if (!row) throw new Error('Unknown project')
  let resolved: string | null = null
  if (input.clonePath) {
    resolved = await realpath(input.clonePath)
    const inside = await runGit([
      '-C',
      resolved,
      'rev-parse',
      '--is-inside-work-tree',
    ])
    if (inside.stdout.trim() !== 'true')
      throw new Error('Selected directory is not a Git worktree')
  }
  getDb()
    .update(project)
    .set({ referenceClonePath: resolved })
    .where(eq(project.id, row.id))
    .run()
  return { referenceClonePath: resolved }
}

export async function getCacheUsage(): Promise<{
  reposBytes: number
  worktreesBytes: number
  totalBytes: number
}> {
  const paths = resolvePaths()
  const [reposBytes, worktreesBytes] = await Promise.all([
    directorySize(paths.reposDir),
    directorySize(paths.worktreesDir),
  ])
  return { reposBytes, worktreesBytes, totalBytes: reposBytes + worktreesBytes }
}

export async function clearCaches(): Promise<void> {
  if (activeOperations > 0)
    throw new Error('Wait for repository operations to finish first')
  const paths = resolvePaths()
  await rm(paths.reposDir, { recursive: true, force: true })
  await rm(paths.worktreesDir, { recursive: true, force: true })
  await Promise.all([
    mkdir(paths.reposDir, { recursive: true }),
    mkdir(paths.worktreesDir, { recursive: true }),
  ])
  getDb().update(project).set({ mirrorPath: null }).run()
  statuses.clear()
  preparations.clear()
}

export async function runRepoGc(): Promise<{ removed: number }> {
  const paths = resolvePaths()
  return gcWorktrees({
    reposDir: paths.reposDir,
    worktreesDir: paths.worktreesDir,
  })
}

async function directorySize(root: string): Promise<number> {
  const entries = await readdir(root, { withFileTypes: true }).catch(() => [])
  const sizes = await Promise.all(
    entries.map(async (entry) => {
      const itemPath = path.join(root, entry.name)
      if (entry.isDirectory()) return directorySize(itemPath)
      if (entry.isFile()) return (await stat(itemPath)).size
      return 0
    }),
  )
  return sizes.reduce((total, size) => total + size, 0)
}
