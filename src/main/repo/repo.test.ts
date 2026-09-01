import {
  mkdtemp,
  mkdir,
  readFile,
  stat,
  utimes,
  writeFile,
} from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createGitAuth } from './auth.ts'
import { computeDiff, LARGE_MR_FILE_LIMIT } from './diff.ts'
import { runGit } from './git.ts'
import { ensureMirror, mirrorPathFor, remoteUrlFor } from './mirror.ts'
import {
  addWorktree,
  gcWorktrees,
  removeWorktree,
  withRunWorktree,
} from './worktree.ts'

const tempRoots: string[] = []

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'rivju-repo-test-'))
  tempRoots.push(dir)
  return dir
}

afterEach(async () => {
  const { rm } = await import('node:fs/promises')
  await Promise.all(
    tempRoots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  )
})

async function makeRepository(): Promise<{
  root: string
  mirror: string
  baseSha: string
  headSha: string
}> {
  const root = await tempDir()
  const source = path.join(root, 'source')
  const mirror = path.join(root, 'repos', 'instance', 'group', 'project.git')
  await mkdir(source, { recursive: true })
  await runGit(['init', '-b', 'main'], { cwd: source })
  await runGit(['config', 'user.name', 'Rivju Test'], { cwd: source })
  await runGit(['config', 'user.email', 'rivju@example.invalid'], {
    cwd: source,
  })
  await writeFile(path.join(source, 'changed.txt'), 'before\n')
  await writeFile(path.join(source, 'rename-me.txt'), 'rename content\n')
  await runGit(['add', '.'], { cwd: source })
  await runGit(['commit', '-m', 'base'], { cwd: source })
  const baseSha = (
    await runGit(['rev-parse', 'HEAD'], { cwd: source })
  ).stdout.trim()

  await writeFile(
    path.join(source, 'changed.txt'),
    `after\n${'long line\n'.repeat(30)}`,
  )
  await runGit(['mv', 'rename-me.txt', 'renamed.txt'], { cwd: source })
  await runGit(['add', '.'], { cwd: source })
  await runGit(['commit', '-m', 'head'], { cwd: source })
  const headSha = (
    await runGit(['rev-parse', 'HEAD'], { cwd: source })
  ).stdout.trim()
  await mkdir(path.dirname(mirror), { recursive: true })
  await runGit(['clone', '--mirror', source, mirror])
  return { root, mirror, baseSha, headSha }
}

describe('repository paths and authentication', () => {
  it('builds nested mirror paths and credential-free remote URLs', () => {
    const project = {
      instanceId: 'instance-1',
      pathWithNamespace: 'group/subgroup/project',
      baseUrl: 'https://gitlab.example.com',
      referenceClonePath: null,
    }
    expect(mirrorPathFor('/cache/repos', project)).toBe(
      path.join(
        '/cache/repos',
        'instance-1',
        'group',
        'subgroup',
        'project.git',
      ),
    )
    expect(remoteUrlFor(project)).toBe(
      'https://gitlab.example.com/group/subgroup/project.git',
    )
  })

  it('keeps the PAT out of the askpass helper file', async () => {
    const auth = await createGitAuth('super-secret-test-token')
    try {
      const helper = auth.env.GIT_ASKPASS
      expect(helper).toBeTruthy()
      expect(await readFile(helper!, 'utf8')).not.toContain(
        'super-secret-test-token',
      )
      expect(auth.env.RIVJU_GIT_TOKEN).toBe('super-secret-test-token')
    } finally {
      await auth.dispose()
    }
  })

  it('replaces an interrupted partial clone with an atomic usable mirror', async () => {
    const repo = await makeRepository()
    const remotes = path.join(repo.root, 'remotes')
    const remote = path.join(remotes, 'group', 'project.git')
    const reposDir = path.join(repo.root, 'cache')
    await mkdir(path.dirname(remote), { recursive: true })
    await runGit(['clone', '--bare', path.join(repo.root, 'source'), remote])
    const project = {
      instanceId: 'instance-1',
      pathWithNamespace: 'group/project',
      baseUrl: new URL(`file://${remotes}/`).toString(),
      referenceClonePath: path.join(repo.root, 'source'),
    }
    const destination = mirrorPathFor(reposDir, project)
    const interrupted = `${destination}.partial-interrupted`
    await mkdir(interrupted, { recursive: true })

    expect(
      await ensureMirror({
        reposDir,
        project,
        token: 'unused-for-file-remote',
      }),
    ).toBe(destination)
    expect(
      (
        await runGit([
          '--git-dir',
          destination,
          'rev-parse',
          '--is-bare-repository',
        ])
      ).stdout.trim(),
    ).toBe('true')
    await expect(stat(interrupted)).rejects.toThrow()
  })
})

describe('worktree lifecycle', () => {
  it('creates simultaneous clean detached worktrees and removes only successful ones', async () => {
    const repo = await makeRepository()
    const worktreesDir = path.join(repo.root, 'worktrees')
    const [first, second] = await Promise.all([
      addWorktree({
        mirrorPath: repo.mirror,
        worktreesDir,
        runId: 'run-one',
        headSha: repo.headSha,
      }),
      addWorktree({
        mirrorPath: repo.mirror,
        worktreesDir,
        runId: 'run-two',
        headSha: repo.headSha,
      }),
    ])

    for (const worktree of [first, second]) {
      expect(
        (await runGit(['rev-parse', 'HEAD'], { cwd: worktree })).stdout.trim(),
      ).toBe(repo.headSha)
      expect(
        await runGit(['symbolic-ref', '-q', 'HEAD'], { cwd: worktree }).catch(
          () => null,
        ),
      ).toBeNull()
      expect(
        (await runGit(['status', '--porcelain'], { cwd: worktree })).stdout,
      ).toBe('')
    }

    await removeWorktree({
      mirrorPath: repo.mirror,
      worktreesDir,
      runId: path.basename(first),
    })
    await expect(stat(first)).rejects.toThrow()
    expect((await stat(second)).isDirectory()).toBe(true)
  })

  it('reaps expired registered worktrees and immediate orphan directories', async () => {
    const repo = await makeRepository()
    const worktreesDir = path.join(repo.root, 'worktrees')
    const retained = await addWorktree({
      mirrorPath: repo.mirror,
      worktreesDir,
      runId: 'failed-run',
      headSha: repo.headSha,
    })
    const orphan = path.join(worktreesDir, 'orphan')
    await mkdir(orphan)
    const old = new Date(Date.now() - 25 * 60 * 60 * 1000)
    await utimes(retained, old, old)

    const result = await gcWorktrees({
      reposDir: path.join(repo.root, 'repos'),
      worktreesDir,
    })
    expect(result.removed).toBe(2)
    await expect(stat(retained)).rejects.toThrow()
    await expect(stat(orphan)).rejects.toThrow()
  })

  it('automatically removes successful runs and retains failed runs', async () => {
    const repo = await makeRepository()
    const worktreesDir = path.join(repo.root, 'worktrees')
    const successfulPath = path.join(worktreesDir, 'successful-run')
    await expect(
      withRunWorktree(
        {
          mirrorPath: repo.mirror,
          worktreesDir,
          runId: 'successful-run',
          headSha: repo.headSha,
        },
        async () => 'done',
      ),
    ).resolves.toBe('done')
    await expect(stat(successfulPath)).rejects.toThrow()

    const failedPath = path.join(worktreesDir, 'failed-run')
    await expect(
      withRunWorktree(
        {
          mirrorPath: repo.mirror,
          worktreesDir,
          runId: 'failed-run',
          headSha: repo.headSha,
        },
        async () => {
          throw new Error('review failed')
        },
      ),
    ).rejects.toThrow('review failed')
    expect((await stat(failedPath)).isDirectory()).toBe(true)
  })
})

describe('structured diff', () => {
  it('returns status and stats and caps each file patch independently', async () => {
    const repo = await makeRepository()
    const result = await computeDiff({
      mirrorPath: repo.mirror,
      baseSha: repo.baseSha,
      headSha: repo.headSha,
      perFilePatchBytes: 80,
    })
    expect(result.status).toBe('ready')
    if (result.status !== 'ready') return
    expect(result.files).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: 'changed.txt',
          status: 'modified',
          truncated: true,
        }),
        expect.objectContaining({
          path: 'renamed.txt',
          oldPath: 'rename-me.txt',
          status: 'renamed',
        }),
      ]),
    )
    expect(result.totalAdditions).toBeGreaterThan(0)
  })

  it('returns file choices instead of silently processing an oversized MR', async () => {
    const root = await tempDir()
    const source = path.join(root, 'source')
    const mirror = path.join(root, 'repos', 'large.git')
    await mkdir(source, { recursive: true })
    await runGit(['init', '-b', 'main'], { cwd: source })
    await runGit(['config', 'user.name', 'Rivju Test'], { cwd: source })
    await runGit(['config', 'user.email', 'rivju@example.invalid'], {
      cwd: source,
    })
    await writeFile(path.join(source, 'README.md'), 'base\n')
    await runGit(['add', '.'], { cwd: source })
    await runGit(['commit', '-m', 'base'], { cwd: source })
    const baseSha = (
      await runGit(['rev-parse', 'HEAD'], { cwd: source })
    ).stdout.trim()
    for (let index = 0; index <= LARGE_MR_FILE_LIMIT; index++) {
      await writeFile(
        path.join(source, `file-${String(index).padStart(3, '0')}.txt`),
        'new\n',
      )
    }
    await runGit(['add', '.'], { cwd: source })
    await runGit(['commit', '-m', 'large'], { cwd: source })
    const headSha = (
      await runGit(['rev-parse', 'HEAD'], { cwd: source })
    ).stdout.trim()
    await mkdir(path.dirname(mirror), { recursive: true })
    await runGit(['clone', '--mirror', source, mirror])

    const result = await computeDiff({ mirrorPath: mirror, baseSha, headSha })
    expect(result.status).toBe('needs_scoping')
    expect(result.files).toHaveLength(LARGE_MR_FILE_LIMIT + 1)
    expect(result.files.every((file) => file.patch === undefined)).toBe(true)
  })
})
