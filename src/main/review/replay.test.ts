import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
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
import { parseRunLog, replayRunMessages } from './replay.ts'

/**
 * Corpus provenance: the message envelopes (system/init, assistant, user
 * tool_result, result, rate_limit_event) were recorded from a real
 * claude-agent-sdk 0.3.252 session (CLI 2.1.241) on this machine; the
 * rivju_run_start / tool-call turns follow those recorded shapes exactly, with
 * rivju's own tool names and a checkout that matches the anchors.
 */
const corpusDir = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures',
)
const migrationsDir = fileURLToPath(
  new URL('../../../drizzle', import.meta.url),
)
const HEAD = 'c'.repeat(40)
const VERIFY_FINDING_ID = '3f2a9c1e-5d41-4b8a-9c02-6f7e8d9a0b3c'

const WORKTREE_FILE = [
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

let db: RivjuDatabase
let root: string
let worktree: string
let mrId: string
let instanceId: string

beforeAll(() => {
  root = mkdtempSync(path.join(tmpdir(), 'rivju-replay-test-'))
  worktree = path.join(root, 'worktree')
  mkdirSync(path.join(worktree, 'src'), { recursive: true })
  writeFileSync(path.join(worktree, 'src', 'handler.ts'), WORKTREE_FILE)
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
  instanceId = db
    .insert(gitlabInstance)
    .values({
      label: 'Test',
      baseUrl: 'https://gitlab.example.com',
      tokenCiphertext: 'cipher',
    })
    .returning({ id: gitlabInstance.id })
    .get().id
  const projectId = db
    .insert(project)
    .values({
      instanceId,
      gitlabProjectId: '1',
      pathWithNamespace: 'group/project',
      name: 'project',
    })
    .returning({ id: project.id })
    .get().id
  mrId = db
    .insert(mergeRequest)
    .values({
      projectId,
      iid: 7,
      title: 'MR',
      sourceBranch: 'feature',
      targetBranch: 'main',
      state: 'opened',
      webUrl: 'https://gitlab.example.com/mr/7',
      lastSeenHeadSha: HEAD,
    })
    .returning({ id: mergeRequest.id })
    .get().id
})

afterAll(() => {
  closeDatabase()
  rmSync(root, { recursive: true, force: true })
})

function insertRun(kind: 'full' | 'verify'): string {
  return db
    .insert(run)
    .values({
      mergeRequestId: mrId,
      kind,
      status: 'running',
      baseSha: 'b'.repeat(40),
      headSha: HEAD,
    })
    .returning({ id: run.id })
    .get().id
}

function replayFixture(
  runId: string,
  file: string,
  extra: Partial<Parameters<typeof replayRunMessages>[0]> = {},
) {
  const text = readFileSync(path.join(corpusDir, file), 'utf8')
  return replayRunMessages(
    {
      db,
      runId,
      mergeRequestId: mrId,
      headSha: HEAD,
      worktreePath: worktree,
      ...extra,
    },
    parseRunLog(text),
  )
}

describe('replaying a recorded full review run', () => {
  it('drives recorded tool calls through the parsing + verification layer', async () => {
    const runId = insertRun('full')
    const summary = await replayFixture(runId, 'full-run.jsonl')

    expect(summary.messages).toBe(10)
    expect(summary.submitted).toBe(1)
    expect(summary.rejected).toBe(1)
    expect(summary.finishCalls).toBe(1)
    expect(summary.resultSubtype).toBe('success')
    expect(summary.usage).toMatchObject({ inputTokens: 14, outputTokens: 215 })
    expect(summary.errors.join('\n')).toContain('does not match')

    // The accepted finding is persisted exactly once, verified at its anchor.
    const rows = db.select().from(finding).all()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      filePath: 'src/handler.ts',
      currentLine: 4,
      severity: 'high',
    })
    // The rejected submission is recorded as an event without a finding row.
    expect(
      db
        .select()
        .from(findingEvent)
        .all()
        .filter((e) => e.type === 'rejected_by_verifier'),
    ).toHaveLength(1)
  })

  it('merges a re-submitted finding by fingerprint, preserving the human triage', async () => {
    const runId = insertRun('full')
    await replayFixture(runId, 'full-run.jsonl')
    const first = db.select().from(finding).all()[0]
    db.update(finding)
      .set({
        triage: 'valid',
        triageNote: 'confirmed by hand',
      })
      .where(eq(finding.id, first.id))
      .run()

    // Same log replayed (a new run re-reporting the same defect) must not
    // duplicate the finding nor wipe the reviewer's triage.
    const secondRunId = insertRun('full')
    await replayFixture(secondRunId, 'full-run.jsonl')

    const rows = db.select().from(finding).all()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      id: first.id,
      triage: 'valid',
      triageNote: 'confirmed by hand',
      lifecycle: 'open',
    })
    const submitted = db
      .select()
      .from(findingEvent)
      .all()
      .filter((e) => e.type === 'submitted')
    expect(submitted).toHaveLength(2)
    expect(new Set(submitted.map((e) => e.findingId))).toEqual(
      new Set([first.id]),
    )
  })
})

describe('replaying a recorded verify run', () => {
  it('feeds report_verification through the verification report layer', async () => {
    const runId = insertRun('verify')
    db.insert(finding)
      .values({
        id: VERIFY_FINDING_ID,
        mergeRequestId: mrId,
        fingerprint: `fp-${crypto.randomUUID()}`,
        scope: 'line',
        filePath: 'src/handler.ts',
        anchorSnippet: '  const value = parse(input)',
        currentLine: 4,
        category: 'correctness',
        severity: 'high',
        title: 'Unguarded parse',
        body: 'body',
        createdRunId: runId,
        firstSeenHeadSha: HEAD,
      })
      .returning()
      .get()

    const summary = await replayFixture(runId, 'verify-run.jsonl', {
      targetFindingIds: new Set([VERIFY_FINDING_ID]),
    })
    expect(summary.reported).toBe(1)
    expect(summary.errors).toEqual([])
    expect(db.select().from(finding).all()).toMatchObject([
      { id: VERIFY_FINDING_ID, lifecycle: 'open' },
    ])
    expect(db.select().from(findingEvent).all()).toMatchObject([
      {
        findingId: VERIFY_FINDING_ID,
        runId,
        type: 'verified',
        payload: { verdict: 'not_fixed' },
      },
    ])
  })

  it('rejects verdicts outside the run target set', async () => {
    const runId = insertRun('verify')
    const summary = await replayFixture(runId, 'verify-run.jsonl', {
      targetFindingIds: new Set(),
    })
    expect(summary.reported).toBe(0)
    expect(summary.rejected).toBe(1)
    expect(db.select().from(findingEvent).all()).toHaveLength(0)
  })
})

describe('replaying a run that hit max turns', () => {
  it('surfaces the max-turns result and recomputes usage', async () => {
    const runId = insertRun('full')
    const summary = await replayFixture(runId, 'max-turns-run.jsonl')
    expect(summary.resultSubtype).toBe('error_max_turns')
    expect(summary.errors.join('\n')).toContain('maximum number of turns')
    expect(summary.submitted).toBe(0)
    expect(summary.finishCalls).toBe(0)
    expect(summary.usage).toMatchObject({
      inputTokens: 44,
      outputTokens: 12210,
    })
  })
})

describe('corrupt run logs', () => {
  it('names the first malformed line instead of failing silently', () => {
    expect(() => parseRunLog('{"type":"assistant"}\nnot json\n')).toThrow(
      /line 2/,
    )
  })
})
