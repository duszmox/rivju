import { access, mkdir, readdir, realpath, rename, rm } from 'node:fs/promises'
import path from 'node:path'
import { createGitAuth } from './auth.ts'
import { runGit, withMirrorLock } from './git.ts'

export interface MirrorProject {
  instanceId: string
  pathWithNamespace: string
  baseUrl: string
  referenceClonePath: string | null
}

export type RepoProgress = (
  phase: 'cloning' | 'fetching',
  detail?: string,
) => void

function safeSegments(value: string): string[] {
  const segments = value.split('/')
  if (
    !segments.length ||
    segments.some(
      (part) => !part || part === '.' || part === '..' || part.includes('\\'),
    )
  ) {
    throw new Error(`Unsafe GitLab project path: ${value}`)
  }
  return segments
}

export function mirrorPathFor(
  reposDir: string,
  project: MirrorProject,
): string {
  return (
    path.join(
      reposDir,
      ...safeSegments(project.instanceId),
      ...safeSegments(project.pathWithNamespace),
    ) + '.git'
  )
}

export function remoteUrlFor(project: MirrorProject): string {
  const url = new URL(project.baseUrl)
  const encodedPath = safeSegments(project.pathWithNamespace)
    .map(encodeURIComponent)
    .join('/')
  url.pathname = `${url.pathname.replace(/\/$/, '')}/${encodedPath}.git`
  return url.toString()
}

async function isUsableMirror(mirrorPath: string): Promise<boolean> {
  try {
    const result = await runGit([
      '--git-dir',
      mirrorPath,
      'rev-parse',
      '--is-bare-repository',
    ])
    return result.stdout.trim() === 'true'
  } catch {
    return false
  }
}

export async function ensureMirror(input: {
  reposDir: string
  project: MirrorProject
  token: string
  onProgress?: RepoProgress
  signal?: AbortSignal
}): Promise<string> {
  const mirrorPath = mirrorPathFor(input.reposDir, input.project)
  return withMirrorLock(mirrorPath, async () => {
    if (await isUsableMirror(mirrorPath)) return mirrorPath

    await mkdir(path.dirname(mirrorPath), { recursive: true })
    await rm(mirrorPath, { recursive: true, force: true })
    await removeInterruptedClones(mirrorPath)
    const partialPath = `${mirrorPath}.partial-${crypto.randomUUID()}`
    const auth = await createGitAuth(input.token)
    try {
      input.onProgress?.('cloning', 'Starting mirror clone')
      const args = ['clone', '--mirror', '--progress']
      if (input.project.referenceClonePath) {
        const referencePath = await realpath(input.project.referenceClonePath)
        await access(referencePath)
        args.push('--reference', referencePath)
      }
      args.push(remoteUrlFor(input.project), partialPath)
      await runGit(args, {
        env: auth.env,
        signal: input.signal,
        onStderr: (chunk) =>
          input.onProgress?.('cloning', lastProgressLine(chunk)),
      })
      await rename(partialPath, mirrorPath)
      return mirrorPath
    } catch (error) {
      await rm(partialPath, { recursive: true, force: true })
      throw error
    } finally {
      await auth.dispose()
    }
  })
}

async function removeInterruptedClones(mirrorPath: string): Promise<void> {
  const parent = path.dirname(mirrorPath)
  const prefix = `${path.basename(mirrorPath)}.partial-`
  const entries = await readdir(parent, { withFileTypes: true }).catch(() => [])
  await Promise.all(
    entries
      .filter((entry) => entry.isDirectory() && entry.name.startsWith(prefix))
      .map((entry) =>
        rm(path.join(parent, entry.name), { recursive: true, force: true }),
      ),
  )
}

export async function fetchMergeRequest(input: {
  mirrorPath: string
  iid: number
  token: string
  onProgress?: RepoProgress
  signal?: AbortSignal
}): Promise<void> {
  await withMirrorLock(input.mirrorPath, async () => {
    const auth = await createGitAuth(input.token)
    try {
      input.onProgress?.('fetching', `Fetching merge request !${input.iid}`)
      await runGit(
        [
          '--git-dir',
          input.mirrorPath,
          'fetch',
          '--prune',
          '--progress',
          'origin',
          '+refs/heads/*:refs/heads/*',
          `+refs/merge-requests/${input.iid}/head:refs/merge-requests/${input.iid}/head`,
        ],
        {
          env: auth.env,
          signal: input.signal,
          onStderr: (chunk) =>
            input.onProgress?.('fetching', lastProgressLine(chunk)),
        },
      )
    } finally {
      await auth.dispose()
    }
  })
}

function lastProgressLine(chunk: string): string {
  return (
    chunk
      .split(/[\r\n]+/)
      .filter(Boolean)
      .at(-1)
      ?.trim() ?? ''
  )
}
