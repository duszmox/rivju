import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { closeDatabase, openDatabase } from '../db/client.ts'
import type { RivjuDatabase } from '../db/client.ts'
import { applyMigrations } from '../db/migrate.ts'
import { finding, findingEvent, gitlabInstance, mergeRequest, project, run } from '../db/schema.ts'
import { findingFingerprint, normalizeAnchorSnippet } from './fingerprint.ts'
import { processFindingSubmission } from './mcp.ts'
import { isReadOnlyBash } from './permissions.ts'
import { spawnReviewProcess } from './process.ts'
import { LiveTokenAccumulator, parseBoundedSettingNumber } from './runner.ts'
import { verifyFindingLocation } from './verifier.ts'
import { getReview, updateFindingTriage } from './ui.ts'

const migrationsDir = fileURLToPath(new URL('../../../drizzle', import.meta.url))
const HEAD = 'a'.repeat(40)
const BASE = 'b'.repeat(40)

let db: RivjuDatabase
let root: string
let worktree: string
let mrId: string
let runId: string
let instanceId: string

beforeAll(() => {
  root = mkdtempSync(path.join(tmpdir(), 'rivju-review-test-'))
  worktree = path.join(root, 'worktree')
  mkdirSync(path.join(worktree, 'src'), { recursive: true })
  writeFileSync(path.join(worktree, 'src', 'example.ts'), 'const first = 1\nconst second = 2\nreturn first + second\n')
  db = openDatabase(path.join(root, 'test.db'))
  applyMigrations(db, migrationsDir)
})

beforeEach(() => {
  db.delete(findingEvent).run()
  db.delete(finding).run()
  db.delete(run).run()
  db.delete(mergeRequest).run()
  db.delete(project).run()
  db.delete(gitlabInstance).run()
  instanceId = db.insert(gitlabInstance).values({
    label: 'Test', baseUrl: 'https://gitlab.example.com', tokenCiphertext: 'cipher',
  }).returning({ id: gitlabInstance.id }).get().id
  const projectId = db.insert(project).values({
    instanceId, gitlabProjectId: '1', pathWithNamespace: 'group/project', name: 'project',
  }).returning({ id: project.id }).get().id
  mrId = db.insert(mergeRequest).values({
    projectId, iid: 7, title: 'MR', sourceBranch: 'feature', targetBranch: 'main',
    state: 'opened', webUrl: 'https://gitlab.example.com/mr/7', lastSeenHeadSha: HEAD,
  }).returning({ id: mergeRequest.id }).get().id
  runId = db.insert(run).values({
    mergeRequestId: mrId, kind: 'full', status: 'running', baseSha: BASE, headSha: HEAD,
  }).returning({ id: run.id }).get().id
})

afterAll(() => {
  closeDatabase()
  rmSync(root, { recursive: true, force: true })
})

describe('finding fingerprint', () => {
  it('normalizes anchor whitespace and excludes line/title prose', () => {
    expect(normalizeAnchorSnippet('  const first = 1\r\nreturn first  \n')).toBe('const first = 1\nreturn first')
    expect(findingFingerprint({ filePath: 'src/a.ts', anchorSnippet: '  return value ', category: 'correctness' }))
      .toBe(findingFingerprint({ filePath: 'src/a.ts', anchorSnippet: 'return value', category: 'correctness' }))
  })

  it('changes when the file or category changes', () => {
    const base = findingFingerprint({ filePath: 'src/a.ts', anchorSnippet: 'return value', category: 'correctness' })
    expect(findingFingerprint({ filePath: 'src/b.ts', anchorSnippet: 'return value', category: 'correctness' })).not.toBe(base)
    expect(findingFingerprint({ filePath: 'src/a.ts', anchorSnippet: 'return value', category: 'security' })).not.toBe(base)
  })
})

describe('verification gate', () => {
  it('accepts an exact 1-3 line anchor at the claimed line', async () => {
    await expect(verifyFindingLocation(worktree, {
      scope: 'line', file_path: 'src/example.ts', line: 2,
      anchor_snippet: 'const second = 2\nreturn first + second',
    })).resolves.toMatchObject({ ok: true, line: 2 })
  })

  it('rejects missing files, wrong lines, and traversal', async () => {
    await expect(verifyFindingLocation(worktree, {
      scope: 'line', file_path: 'src/missing.ts', line: 1, anchor_snippet: 'nope',
    })).resolves.toMatchObject({ ok: false, error: expect.stringContaining('does not exist') })
    await expect(verifyFindingLocation(worktree, {
      scope: 'line', file_path: 'src/example.ts', line: 1, anchor_snippet: 'const second = 2',
    })).resolves.toMatchObject({ ok: false, error: expect.stringContaining('does not match') })
    await expect(verifyFindingLocation(worktree, {
      scope: 'line', file_path: '../secret', line: 1, anchor_snippet: 'secret',
    })).resolves.toMatchObject({ ok: false, error: expect.stringContaining('inside') })
  })

  it('records a rejected event without persisting an invalid finding', async () => {
    const result = await processFindingSubmission({ db, runId, mergeRequestId: mrId, headSha: HEAD, worktreePath: worktree }, {
      scope: 'line', file_path: 'src/example.ts', line: 99, anchor_snippet: 'invented()',
      ctx_before: '', ctx_after: '', category: 'correctness', severity: 'high',
      title: 'Invented anchor', body: 'This must be rejected.',
    })
    expect(result.accepted).toBe(false)
    expect(db.select().from(finding).all()).toHaveLength(0)
    expect(db.select().from(findingEvent).all()).toMatchObject([
      { findingId: null, runId, type: 'rejected_by_verifier' },
    ])
  })

  it('persists an accepted finding and submitted event atomically', async () => {
    const result = await processFindingSubmission({ db, runId, mergeRequestId: mrId, headSha: HEAD, worktreePath: worktree }, {
      scope: 'line', file_path: 'src/example.ts', line: 2, anchor_snippet: 'const second = 2',
      ctx_before: 'const first = 1', ctx_after: 'return first + second', category: 'correctness',
      severity: 'medium', title: 'Example defect', body: 'Concrete explanation.',
    })
    expect(result.accepted).toBe(true)
    expect(db.select().from(finding).all()).toMatchObject([
      {
        mergeRequestId: mrId,
        currentLine: 2,
        anchorSnippet: 'const second = 2',
        ctxBefore: 'const first = 1',
        ctxAfter: 'return first + second',
      },
    ])
    expect(db.select().from(findingEvent).all()).toMatchObject([
      { findingId: result.accepted ? result.row.id : '', runId, type: 'submitted' },
    ])
  })
})

describe('read-only execution boundary', () => {
  it('allows only approved Bash command shapes', () => {
    expect(isReadOnlyBash('git diff --stat HEAD~1')).toBe(true)
    expect(isReadOnlyBash("sed -n '1,40p' src/file.ts")).toBe(true)
    expect(isReadOnlyBash('rg TODO src')).toBe(true)
    expect(isReadOnlyBash('git status')).toBe(false)
    expect(isReadOnlyBash('cat /etc/passwd')).toBe(false)
    expect(isReadOnlyBash('rg TODO . | sh')).toBe(false)
    expect(isReadOnlyBash('ls; touch owned')).toBe(false)
  })

  it('terminates the spawned process group within one second', async () => {
    const abort = new AbortController()
    const child = spawnReviewProcess({
      command: process.execPath,
      args: ['-e', 'setInterval(() => {}, 1000)'],
      env: process.env,
      signal: abort.signal,
    }, abort.signal, () => undefined)
    const exited = new Promise<number>((resolve) => {
      const started = Date.now()
      child.once('exit', () => resolve(Date.now() - started))
    })
    abort.abort()
    await expect(exited).resolves.toBeLessThan(1000)
  })
})

describe('review numeric settings', () => {
  it('uses the configured default when a setting is absent or blank', () => {
    expect(parseBoundedSettingNumber(null, 40, 1, 200)).toBe(40)
    expect(parseBoundedSettingNumber(undefined, 40, 1, 200)).toBe(40)
    expect(parseBoundedSettingNumber('  ', 40, 1, 200)).toBe(40)
  })

  it('accepts finite values and clamps them to the configured bounds', () => {
    expect(parseBoundedSettingNumber('60', 40, 1, 200)).toBe(60)
    expect(parseBoundedSettingNumber('0', 40, 1, 200)).toBe(1)
    expect(parseBoundedSettingNumber('500', 40, 1, 200)).toBe(200)
    expect(parseBoundedSettingNumber('invalid', 40, 1, 200)).toBe(40)
  })
})

describe('live review usage', () => {
  it('aggregates model turns without double-counting repeated content blocks', () => {
    const tokens = new LiveTokenAccumulator()

    expect(tokens.update('message-1', 1_000, 25)).toEqual({ inputTokens: 1_000, outputTokens: 25 })
    expect(tokens.update('message-1', 1_000, 80)).toEqual({ inputTokens: 1_000, outputTokens: 80 })
    expect(tokens.update('message-1', 1_000, 80)).toBeNull()
    expect(tokens.update('message-2', 1_400, 40)).toEqual({ inputTokens: 2_400, outputTokens: 120 })
  })

  it('ignores invalid or decreasing token snapshots', () => {
    const tokens = new LiveTokenAccumulator()

    expect(tokens.update('message-1', 100, 20)).toEqual({ inputTokens: 100, outputTokens: 20 })
    expect(tokens.update('message-1', Number.NaN, 10)).toBeNull()
  })
})

describe('review UI persistence', () => {
  it('persists triage and records its run-scoped audit event', async () => {
    const submitted = await processFindingSubmission({
      db, runId, mergeRequestId: mrId, headSha: HEAD, worktreePath: worktree,
    }, {
      scope: 'line', file_path: 'src/example.ts', line: 2,
      anchor_snippet: 'const second = 2', ctx_before: '', ctx_after: '',
      category: 'correctness', severity: 'medium', title: 'Triage me', body: 'Review body.',
    })
    if (!submitted.accepted) throw new Error('Fixture finding was rejected')

    updateFindingTriage({
      findingId: submitted.row.id,
      runId,
      triage: 'valid',
      note: 'Confirmed by the reviewer',
    })

    expect(db.select().from(finding).all()).toMatchObject([
      { id: submitted.row.id, triage: 'valid', triageNote: 'Confirmed by the reviewer' },
    ])
    expect(db.select().from(findingEvent).all().at(-1)).toMatchObject({
      findingId: submitted.row.id,
      runId,
      type: 'triaged',
      payload: { triage: 'valid', note: 'Confirmed by the reviewer' },
    })
  })

  it('returns finding evidence grouped by originating run', async () => {
    const submitted = await processFindingSubmission({
      db, runId, mergeRequestId: mrId, headSha: HEAD, worktreePath: worktree,
    }, {
      scope: 'global', category: 'conventions', severity: 'info', title: 'Global note',
      body: 'A repository-level observation.', ctx_before: '', ctx_after: '',
    })
    if (!submitted.accepted) throw new Error('Fixture finding was rejected')

    const review = await getReview({ instanceId, gitlabProjectId: 1, iid: 7, runId })
    expect(review.findingIdsByRun[runId]).toEqual([submitted.row.id])
    expect(review.findings).toMatchObject([{ id: submitted.row.id, scope: 'global' }])
  })
})
