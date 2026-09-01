import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { eq } from 'drizzle-orm'
import { closeDatabase, openDatabase } from '../db/client.ts'
import type { RivjuDatabase } from '../db/client.ts'
import { applyMigrations } from '../db/migrate.ts'
import {
  finding,
  findingEvent,
  gitlabInstance,
  mergeRequest,
  project,
  run,
} from '../db/schema.ts'
import { runGit } from '../repo/git.ts'
import { getReview } from './ui.ts'
import { composeVerifyPrompt } from './prompt.ts'
import { collectRejectedFindings } from './rejected.ts'
import { processVerificationReport, reanchorOpenFindings, renamesBetween } from './verify.ts'

const migrationsDir = fileURLToPath(new URL('../../../drizzle', import.meta.url))
const OLD = 'a'.repeat(40)
const NEW = 'c'.repeat(40)

const FILE_V1 = [
  'import { parse } from "./parser"',
  '',
  'export function handle(input: string) {',
  '  const value = parse(input)',
  '  if (!value) {',
  '    throw new Error("empty")',
  '  }',
  '  return value.trim()',
  '}',
].join('\n')

const FILE_V2 = [
  '// shifted by new commits',
  '// more context above',
  ...FILE_V1.split('\n'),
].join('\n')

const GONE_V1 = 'const transient = 1\nreturn transient\n'
const RENAMED_V1 = 'export const keep = true\ncheck(keep)\n'

let db: RivjuDatabase
let root: string
let oldWorktree: string
let newWorktree: string
let mrId: string
let runId: string
let instanceId: string
let projectId: string

beforeAll(() => {
  root = mkdtempSync(path.join(tmpdir(), 'rivju-verify-test-'))
  oldWorktree = path.join(root, 'old')
  newWorktree = path.join(root, 'new')
  mkdirSync(path.join(oldWorktree, 'src'), { recursive: true })
  mkdirSync(path.join(newWorktree, 'src'), { recursive: true })
  writeFileSync(path.join(oldWorktree, 'src', 'handler.ts'), FILE_V1)
  writeFileSync(path.join(oldWorktree, 'src', 'gone.ts'), GONE_V1)
  writeFileSync(path.join(oldWorktree, 'src', 'old-name.ts'), RENAMED_V1)
  writeFileSync(path.join(newWorktree, 'src', 'handler.ts'), FILE_V2)
  writeFileSync(path.join(newWorktree, 'src', 'new-name.ts'), RENAMED_V1)
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
  projectId = db.insert(project).values({
    instanceId, gitlabProjectId: '1', pathWithNamespace: 'group/project', name: 'project',
  }).returning({ id: project.id }).get().id
  mrId = db.insert(mergeRequest).values({
    projectId, iid: 7, title: 'MR', sourceBranch: 'feature', targetBranch: 'main',
    state: 'opened', webUrl: 'https://gitlab.example.com/mr/7', lastSeenHeadSha: OLD,
  }).returning({ id: mergeRequest.id }).get().id
  runId = db.insert(run).values({
    mergeRequestId: mrId, kind: 'verify', status: 'running',
    baseSha: OLD, headSha: NEW,
  }).returning({ id: run.id }).get().id
})

afterAll(() => {
  closeDatabase()
  rmSync(root, { recursive: true, force: true })
})

const FILE_V1_CONTEXT_BEFORE = ['', 'export function handle(input: string) {', '  const value = parse(input)'].join('\n')
const FILE_V1_CONTEXT_AFTER = ['    throw new Error("empty")', '  }', '  return value.trim()'].join('\n')

function insertFinding(values: Partial<typeof finding.$inferInsert> & { title: string }) {
  return db.insert(finding).values({
    mergeRequestId: mrId, fingerprint: `fp-${crypto.randomUUID()}`,
    scope: 'line', filePath: 'src/handler.ts', anchorSnippet: '  if (!value) {',
    ctxBefore: FILE_V1_CONTEXT_BEFORE, ctxAfter: FILE_V1_CONTEXT_AFTER,
    currentLine: 5, category: 'correctness', severity: 'high',
    createdRunId: runId, firstSeenHeadSha: OLD, lifecycleRunId: runId,
    ...values,
  }).returning().get()
}

describe('verification reports', () => {
  it('flips a fixed finding while leaving the human triage mark untouched', async () => {
    const row = insertFinding({ title: 'Fixable defect', triage: 'valid', triageNote: 'confirmed' })
    const result = await processVerificationReport({
      db, runId, mergeRequestId: mrId, headSha: NEW,
      targetFindingIds: new Set([row.id]),
    }, {
      finding_id: row.id, verdict: 'fixed', justification: 'The guard was removed in commit X.',
    })
    expect(result.accepted).toBe(true)
    expect(db.select().from(finding).all()).toMatchObject([{
      id: row.id, lifecycle: 'fixed', lifecycleRunId: runId,
      triage: 'valid', triageNote: 'confirmed',
    }])
    expect(db.select().from(findingEvent).all()).toMatchObject([{
      findingId: row.id, runId, type: 'verified',
      payload: { verdict: 'fixed', justification: 'The guard was removed in commit X.', headSha: NEW },
    }])
  })

  it('keeps a not_fixed finding open and records the verdict', async () => {
    const row = insertFinding({ title: 'Still broken', lifecycleRunId: null })
    const result = await processVerificationReport({
      db, runId, mergeRequestId: mrId, headSha: NEW, targetFindingIds: new Set([row.id]),
    }, { finding_id: row.id, verdict: 'not_fixed', justification: 'The branch is still unguarded.' })
    expect(result.accepted).toBe(true)
    expect(db.select().from(finding).all()).toMatchObject([{ id: row.id, lifecycle: 'open' }])
    expect(db.select().from(findingEvent).all()).toMatchObject([{
      findingId: row.id, type: 'verified', payload: { verdict: 'not_fixed' },
    }])
  })

  it('records a moot verdict', async () => {
    const row = insertFinding({ title: 'Moot now' })
    await processVerificationReport({
      db, runId, mergeRequestId: mrId, headSha: NEW, targetFindingIds: new Set([row.id]),
    }, { finding_id: row.id, verdict: 'moot', justification: 'The module was deleted.' })
    expect(db.select().from(finding).all()).toMatchObject([{ id: row.id, lifecycle: 'moot' }])
  })

  it('rejects reports for findings outside the run target set', async () => {
    const row = insertFinding({ title: 'Already stale', lifecycle: 'stale' })
    const result = await processVerificationReport({
      db, runId, mergeRequestId: mrId, headSha: NEW, targetFindingIds: new Set(),
    }, { finding_id: row.id, verdict: 'fixed', justification: 'guess' })
    expect(result.accepted).toBe(false)
    expect(db.select().from(findingEvent).all()).toHaveLength(0)
    expect(db.select().from(finding).all()).toMatchObject([{ id: row.id, lifecycle: 'stale' }])
  })
})

describe('re-anchoring open findings', () => {
  it('re-anchors moved findings, stales vanished ones, and keeps global findings open', async () => {
    const moved = insertFinding({ title: 'Moved defect' })
    const vanished = insertFinding({
      title: 'Vanished defect', filePath: 'src/gone.ts', anchorSnippet: 'const transient = 1',
      ctxBefore: '', ctxAfter: 'return transient', currentLine: 1,
    })
    const global = insertFinding({ title: 'Global note', scope: 'global', filePath: null, anchorSnippet: null, ctxBefore: null, ctxAfter: null, currentLine: null })

    const summary = await reanchorOpenFindings({
      db, mergeRequestId: mrId, runId, headSha: NEW,
      worktreePath: newWorktree, mirrorPath: null, oldHeadSha: OLD,
    })

    expect(summary).toMatchObject({ checked: 3, reanchored: 1, staled: 1 })
    expect([...summary.open.map((item) => item.id)].sort()).toEqual([moved.id, global.id].sort())
    expect(db.select().from(finding).all()).toMatchObject([
      { id: moved.id, currentLine: 7, lifecycle: 'open' },
      { id: vanished.id, lifecycle: 'stale', lifecycleRunId: runId },
      { id: global.id, lifecycle: 'open' },
    ])
    const events = db.select().from(findingEvent).all()
    expect(events.filter((event) => event.type === 'reanchored')).toHaveLength(2)
    expect(events.find((event) => event.findingId === moved.id)?.payload).toMatchObject({
      outcome: 'moved',
      to: { path: 'src/handler.ts', line: 7 },
    })
    expect(events.find((event) => event.findingId === vanished.id)?.payload).toMatchObject({
      outcome: 'stale', reason: 'file_missing',
    })
  })

  it('reports unchanged findings without an event', async () => {
    const stable = insertFinding({ title: 'Unmoved' })
    const summary = await reanchorOpenFindings({
      db, mergeRequestId: mrId, runId, headSha: NEW,
      worktreePath: oldWorktree, mirrorPath: null, oldHeadSha: OLD,
    })
    expect(summary).toMatchObject({ checked: 1, reanchored: 0, staled: 0, unchanged: 1 })
    expect(summary.open.map((item) => item.id)).toEqual([stable.id])
    expect(db.select().from(findingEvent).all()).toHaveLength(0)
  })
})

describe('rename resolution', () => {
  it('maps old paths to new paths from the mirror', async () => {
    const gitRoot = mkdtempSync(path.join(tmpdir(), 'rivju-rename-test-'))
    try {
      const source = path.join(gitRoot, 'source')
      const mirror = path.join(gitRoot, 'mirror.git')
      mkdirSync(source, { recursive: true })
      await runGit(['init', '-b', 'main'], { cwd: source })
      await runGit(['config', 'user.name', 'Rivju Test'], { cwd: source })
      await runGit(['config', 'user.email', 'rivju@example.invalid'], { cwd: source })
      writeFileSync(path.join(source, 'old-name.ts'), RENAMED_V1)
      writeFileSync(path.join(source, 'keep.ts'), 'stable\n')
      await runGit(['add', '.'], { cwd: source })
      await runGit(['commit', '-m', 'base'], { cwd: source })
      const baseSha = (await runGit(['rev-parse', 'HEAD'], { cwd: source })).stdout.trim()
      await runGit(['mv', 'old-name.ts', 'new-name.ts'], { cwd: source })
      await runGit(['add', '.'], { cwd: source })
      await runGit(['commit', '-m', 'rename'], { cwd: source })
      const headSha = (await runGit(['rev-parse', 'HEAD'], { cwd: source })).stdout.trim()
      await runGit(['clone', '--mirror', source, mirror])

      const renames = await renamesBetween(mirror, baseSha, headSha)
      expect(Object.fromEntries(renames)).toEqual({ 'old-name.ts': 'new-name.ts' })
    } finally {
      rmSync(gitRoot, { recursive: true, force: true })
    }
  })

  it('re-anchors a finding into its renamed file once the rename map is available', async () => {
    const renamed = insertFinding({
      title: 'Renamed home', filePath: 'src/old-name.ts',
      anchorSnippet: 'export const keep = true', ctxBefore: '', ctxAfter: 'check(keep)', currentLine: 1,
    })
    // Without a mirror the old path is simply missing at the new head: stale.
    await reanchorOpenFindings({
      db, mergeRequestId: mrId, runId, headSha: NEW,
      worktreePath: newWorktree, mirrorPath: null, oldHeadSha: OLD,
    })
    expect(db.select().from(finding).all()).toMatchObject([
      { id: renamed.id, filePath: 'src/old-name.ts', lifecycle: 'stale' },
    ])

    // With the rename map supplied via a mirror, the path is followed.
    db.delete(findingEvent).run()
    db.update(finding).set({
      lifecycle: 'open', lifecycleRunId: null,
      filePath: 'src/old-name.ts', currentLine: 1,
    }).where(eq(finding.id, renamed.id)).run()
    const mirror = mkdtempSync(path.join(tmpdir(), 'rivju-rename-mirror-'))
    try {
      const source = path.join(mirror, 'source')
      mkdirSync(path.join(source, 'src'), { recursive: true })
      await runGit(['init', '-b', 'main'], { cwd: source })
      await runGit(['config', 'user.name', 'Rivju Test'], { cwd: source })
      await runGit(['config', 'user.email', 'rivju@example.invalid'], { cwd: source })
      writeFileSync(path.join(source, 'src', 'old-name.ts'), RENAMED_V1)
      await runGit(['add', '.'], { cwd: source })
      await runGit(['commit', '-m', 'base'], { cwd: source })
      const baseSha = (await runGit(['rev-parse', 'HEAD'], { cwd: source })).stdout.trim()
      await runGit(['mv', path.join('src', 'old-name.ts'), path.join('src', 'new-name.ts')], { cwd: source })
      await runGit(['add', '.'], { cwd: source })
      await runGit(['commit', '-m', 'rename'], { cwd: source })
      const headSha = (await runGit(['rev-parse', 'HEAD'], { cwd: source })).stdout.trim()
      const mirrorPath = path.join(mirror, 'mirror.git')
      await runGit(['clone', '--mirror', source, mirrorPath])

      const summary = await reanchorOpenFindings({
        db, mergeRequestId: mrId, runId, headSha,
        worktreePath: newWorktree, mirrorPath, oldHeadSha: baseSha,
      })
      expect(summary.reanchored).toBe(1)
      expect(db.select().from(finding).all()).toMatchObject([
        { id: renamed.id, filePath: 'src/new-name.ts', currentLine: 1 },
      ])
    } finally {
      rmSync(mirror, { recursive: true, force: true })
    }
  })
})

describe('rejected findings feedback', () => {
  it('collects project-scoped invalid findings with reviewer notes', () => {
    const rejected = insertFinding({ title: 'Not a bug', triage: 'invalid', triageNote: 'works as intended' })
    insertFinding({ title: 'Still valid', triage: 'valid' })

    const otherProject = db.insert(project).values({
      instanceId, gitlabProjectId: '2', pathWithNamespace: 'group/other', name: 'other',
    }).returning({ id: project.id }).get().id
    const otherMrId = db.insert(mergeRequest).values({
      projectId: otherProject, iid: 8, title: 'Other MR', sourceBranch: 'a', targetBranch: 'b',
      state: 'opened', webUrl: 'https://gitlab.example.com/mr/8',
    }).returning({ id: mergeRequest.id }).get().id
    db.insert(finding).values({
      mergeRequestId: otherMrId, fingerprint: `fp-${crypto.randomUUID()}`,
      scope: 'global', category: 'style', severity: 'info', title: 'Other project invalid',
      triage: 'invalid', lifecycleRunId: runId,
    }).returning().get()

    const items = collectRejectedFindings(db, projectId)
    expect(items).toEqual([
      { filePath: 'src/handler.ts', category: 'correctness', title: 'Not a bug', note: 'works as intended' },
    ])
    expect(items.map((item) => item.title)).not.toContain('Still valid')
    expect(rejected.title).toBe('Not a bug')
  })
})

describe('verify prompt', () => {
  it('lists findings with ids, the diff range, and the rejected block', () => {
    const target = insertFinding({ title: 'Check me', triage: 'valid' })
    insertFinding({ title: 'Not a bug', triage: 'invalid', triageNote: 'works as intended' })
    const prompt = composeVerifyPrompt({
      title: 'MR title',
      reviewedHeadSha: OLD,
      headSha: NEW,
      findings: [target],
      files: [],
      rejected: collectRejectedFindings(db, projectId),
    })
    expect(prompt).toContain(target.id)
    expect(prompt).toContain('mcp__rivju__report_verification')
    expect(prompt).toContain(`${OLD}...${NEW}`)
    expect(prompt).toContain('Previously rejected findings')
    expect(prompt).toContain('Not a bug')
  })
})

describe('review detail evidence', () => {
  it('exposes verification and re-anchoring evidence per run', async () => {
    const row = insertFinding({ title: 'Evidence finding' })
    await processVerificationReport({
      db, runId, mergeRequestId: mrId, headSha: NEW, targetFindingIds: new Set([row.id]),
    }, { finding_id: row.id, verdict: 'not_fixed', justification: 'Still present.' })
    await reanchorOpenFindings({
      db, mergeRequestId: mrId, runId, headSha: NEW,
      worktreePath: newWorktree, mirrorPath: null, oldHeadSha: OLD,
    })

    const review = await getReview({ instanceId, gitlabProjectId: 1, iid: 7 })
    expect(review.findingIdsByRun[runId]).toContain(row.id)
    expect(review.verificationByRun[runId]).toMatchObject([{
      findingId: row.id, verdict: 'not_fixed', justification: 'Still present.',
    }])
    expect(review.reanchorByRun[runId]).toMatchObject([
      { findingId: row.id, outcome: 'moved' },
    ])
  })
})
