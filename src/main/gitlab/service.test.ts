import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { closeDatabase, openDatabase } from '../db/client.ts'
import type { RivjuDatabase } from '../db/client.ts'
import { applyMigrations } from '../db/migrate.ts'
import {
  finding,
  gitlabInstance,
  mergeRequest,
  project,
} from '../db/schema.ts'
import {
  addInstance,
  deleteInstance,
  fetchMergeRequestDetail,
  fetchReviewQueue,
  listInstances,
  majorVersion,
  reAuthInstance,
  validateInstance,
} from './service.ts'
import userFixture from './fixtures/user.json'
import versionFixture from './fixtures/version.json'
import tokenSelfFixture from './fixtures/personal_access_token_self.json'
import projectsPage1 from './fixtures/projects_page1.json'
import mergeRequestsFixture from './fixtures/merge_requests.json'
import mergeRequestDetail from './fixtures/merge_request_detail.json'
import mergeRequestDiffs from './fixtures/merge_request_diffs.json'

vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (plaintext: string) => Buffer.from(`enc:${plaintext}`),
    // real safeStorage.decryptString returns a string
    decryptString: (buffer: Buffer) => Buffer.from(buffer.toString('utf8').replace(/^enc:/, '')).toString('utf8'),
  },
}))

const migrationsDir = fileURLToPath(new URL('../../../drizzle', import.meta.url))
const BASE = 'https://gitlab.example.com'

let db: RivjuDatabase
let workDir: string
/** Current GitLab version served by the fake fetch; tests can downgrade it. */
let servedVersion: string = versionFixture.version

/**
 * A fixture-backed GitLab API: routes URL paths to the recorded JSON files so
 * service-layer code runs end to end without network access.
 */
function fixtureFetch(url: string | URL | Request): Response {
  const href = typeof url === 'string' ? url : url.toString()
  const parsed = new URL(href)
  const p = parsed.pathname
  const respond = (body: unknown, status = 200): Response =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    })

  if (p === '/api/v4/user') return respond(userFixture)
  if (p === '/api/v4/version') return respond({ ...versionFixture, version: servedVersion })
  if (p === '/api/v4/personal_access_tokens/self') return respond(tokenSelfFixture)
  if (p === '/api/v4/projects' && parsed.searchParams.get('membership') === 'true') {
    return respond(projectsPage1)
  }
  if (p === '/api/v4/projects/3201') return respond(projectsPage1[0])
  if (p === '/api/v4/merge_requests') {
    if (parsed.searchParams.get('reviewer_id') === '48213') {
      return respond(mergeRequestsFixture)
    }
    if (parsed.searchParams.get('assignee_id') === '48213') {
      // Only the first MR appears in the assignee call too — the merge must dedupe.
      return respond([mergeRequestsFixture[0]])
    }
    return respond([])
  }
  if (p === '/api/v4/projects/3201/merge_requests/101') return respond(mergeRequestDetail)
  if (p === '/api/v4/projects/3201/merge_requests/101/diffs') return respond(mergeRequestDiffs)
  return respond({ message: 'not found' }, 404)
}

async function seedInstance(label = 'Work GitLab'): Promise<ReturnType<typeof addInstance>> {
  return addInstance({ label, baseUrl: BASE, token: 'glpat-test-token-123' })
}

beforeAll(() => {
  workDir = mkdtempSync(path.join(tmpdir(), 'rivju-phase1-test-'))
  db = openDatabase(path.join(workDir, 'test.db'))
  applyMigrations(db, migrationsDir)
  vi.stubGlobal('fetch', fixtureFetch)
})

beforeEach(() => {
  // fresh tables per test (instance delete cascades the rest)
  db.delete(finding).run()
  db.delete(mergeRequest).run()
  db.delete(project).run()
  db.delete(gitlabInstance).run()
  servedVersion = versionFixture.version
})

afterAll(() => {
  vi.unstubAllGlobals()
  closeDatabase()
  rmSync(workDir, { recursive: true, force: true })
})

describe('instance add validation flow', () => {
  it('validates via /user and /version, stores encrypted metadata, never the plaintext', async () => {
    const view = await seedInstance()

    expect(view.username).toBe('malin.dev')
    expect(view.userId).toBe('48213')
    expect(view.gitlabVersion).toBe('17.11.3-ee')
    expect(view.versionWarning).toBe(false)

    const rows = db.select().from(gitlabInstance).all()
    expect(rows).toHaveLength(1)
    const row = rows[0]
    expect(row.tokenCiphertext).not.toContain('glpat-test-token-123')
    expect(JSON.parse(row.tokenScopes)).toEqual(['api', 'read_user'])

    // listInstances exposes no token material at all
    const views = listInstances()
    expect(JSON.stringify(views)).not.toContain('glpat')
  })

  it('warns when the GitLab major version is below 15', async () => {
    servedVersion = '14.10.0'
    const view = await seedInstance('Old GitLab')
    expect(view.gitlabVersion).toBe('14.10.0')
    expect(view.versionWarning).toBe(true)
  })

  it('rejects an invalid token with a clear error and stores nothing', async () => {
    const live = globalThis.fetch
    vi.stubGlobal(
      'fetch',
      () => new Response(JSON.stringify({ message: '401 Unauthorized' }), { status: 401 }),
    )
    await expect(
      addInstance({ label: 'Bad', baseUrl: BASE, token: 'glpat-bad' }),
    ).rejects.toThrow(/401/)
    vi.stubGlobal('fetch', live)
    expect(listInstances()).toHaveLength(0)
  })

  it('re-validate refreshes username and version', async () => {
    const id = (await seedInstance()).id
    servedVersion = '18.1.0'
    const view = await validateInstance(id)
    expect(view.gitlabVersion).toBe('18.1.0')
  })

  it('reAuth replaces the stored ciphertext after validating the new token', async () => {
    const id = (await seedInstance()).id
    const view = await reAuthInstance(id, 'glpat-rotated-token')
    expect(view.username).toBe('malin.dev')
    const row = db.select().from(gitlabInstance).all()[0]
    expect(row.tokenCiphertext).not.toContain('glpat-rotated-token')
  })
})

describe('delete cascades', () => {
  it('removes projects and merge requests but keeps findings', async () => {
    const id = (await seedInstance()).id

    // simulate prior work: picked project, listed MR, a finding on that MR
    const projectRow = db
      .insert(project)
      .values({
        instanceId: id,
        gitlabProjectId: '3201',
        pathWithNamespace: 'acme/rivju-core',
        name: 'rivju-core',
        defaultBranch: 'main',
      })
      .returning()
      .get()
    const mrRow = db
      .insert(mergeRequest)
      .values({
        projectId: projectRow.id,
        iid: 101,
        title: 'Guard hallucinated anchors',
        sourceBranch: 'fix/verify-anchors',
        targetBranch: 'main',
        state: 'opened',
        webUrl: 'https://gitlab.example.com/acme/rivju-core/-/merge_requests/101',
      })
      .returning()
      .get()
    const findingRow = db
      .insert(finding)
      .values({
        mergeRequestId: mrRow.id,
        fingerprint: 'deadbeef',
        scope: 'line',
        filePath: 'src/main/review/verify.ts',
        anchorSnippet: 'if (!anchorsMatch(finding))',
        title: 'Anchor never checked',
        triage: 'valid',
        triageNote: 'real bug, fix before merge',
      })
      .returning()
      .get()

    deleteInstance(id)

    expect(db.select().from(project).all()).toHaveLength(0)
    expect(db.select().from(mergeRequest).all()).toHaveLength(0)
    const findings = db.select().from(finding).all()
    expect(findings).toHaveLength(1)
    expect(findings[0].id).toBe(findingRow.id)
    expect(findings[0].mergeRequestId).toBeNull()
    expect(findings[0].triage).toBe('valid')
    expect(findings[0].triageNote).toBe('real bug, fix before merge')
  })
})

describe('review queue (default filter across instances)', () => {
  it('merges reviewer_id and assignee_id calls and dedupes', async () => {
    await seedInstance('One')
    const queue = await fetchReviewQueue()

    // reviewer call returns 2 MRs; assignee call re-returns MR !101 → deduped
    expect(queue.items).toHaveLength(2)
    expect(queue.instanceErrors).toHaveLength(0)
    expect(queue.items.map((i) => i.iid).sort((a, b) => a - b)).toEqual([57, 101])
    // most recently updated first
    expect(queue.items[0].iid).toBe(101)
    // repo path: from references.full, falling back to web_url parsing
    expect(queue.items[0].projectPath).toBe('acme/rivju-core')
    expect(queue.items[1].projectPath).toBe('acme/infra-scripts')
  })

  it('continues across instances when one fails', async () => {
    await seedInstance('Good')
    const good = listInstances().find((i) => i.label === 'Good')
    const live = globalThis.fetch
    // Only the "Second" instance's requests fail (identified by its token header).
    vi.stubGlobal('fetch', (url: string | URL | Request, init?: RequestInit) => {
      const href = typeof url === 'string' ? url : url.toString()
      const tokenHeader = new Headers(init?.headers).get('PRIVATE-TOKEN')
      if (tokenHeader === 'glpat-second' && href.includes('/api/v4/merge_requests')) {
        return new Response(JSON.stringify({ message: '500 whoops' }), {
          status: 500,
          headers: { 'Retry-After': '0' },
        })
      }
      return fixtureFetch(url)
    })
    // second instance still validates (/user + /version work), then breaks on the queue
    await addInstance({ label: 'Second', baseUrl: BASE, token: 'glpat-second' })
    const queue = await fetchReviewQueue()
    vi.stubGlobal('fetch', live)

    expect(good).toBeDefined()
    expect(queue.items.length).toBeGreaterThan(0)
    expect(queue.items.some((i) => i.instanceId === good?.id)).toBe(true)
    expect(queue.instanceErrors.length).toBeGreaterThan(0)
    expect(
      queue.items.every((i) => i.instanceId !== queue.instanceErrors[0]?.instanceId),
    ).toBe(true)
  })
})

describe('MR detail', () => {
  it('captures diff_refs and the changed-file list, persists project+MR rows', async () => {
    const instanceId = (await seedInstance()).id
    const detail = await fetchMergeRequestDetail(instanceId, 3201, 101)

    expect(detail.mr.title).toBe('Guard hallucinated anchors in submit_finding')
    expect(detail.diffRefs).toEqual({
      baseSha: '1f2e3d4c5b6a79887766554433221100ffeeddcc',
      headSha: 'aa11bb22cc33dd44ee55ff66001122334455667',
      startSha: '1f2e3d4c5b6a79887766554433221100ffeeddcc',
    })
    expect(detail.files).toHaveLength(4)
    expect(detail.files[0]).toMatchObject({ newPath: 'src/main/review/verify.ts' })
    expect(detail.files[1]).toMatchObject({ newPath: 'src/main/review/anchor.ts', newFile: true })
    expect(detail.files[2]).toMatchObject({ newPath: 'src/main/review/old.ts', deletedFile: true })
    expect(detail.files[3]).toMatchObject({
      newPath: 'src/main/review/renamed-core.ts',
      renamedFile: true,
    })

    const projectRows = db.select().from(project).all()
    expect(projectRows).toHaveLength(1)
    expect(projectRows[0].gitlabProjectId).toBe('3201')
    const mrRows = db.select().from(mergeRequest).all()
    expect(mrRows).toHaveLength(1)
    expect(mrRows[0].lastSeenHeadSha).toBe('aa11bb22cc33dd44ee55ff66001122334455667')
    expect(mrRows[0].iid).toBe(101)
  })
})

describe('majorVersion', () => {
  it('parses major versions and treats unknown as no-warning', () => {
    expect(majorVersion('14.10.0')).toBe(14)
    expect(majorVersion('15.11.13')).toBe(15)
    expect(majorVersion('17.11.3-ee')).toBe(17)
    expect(majorVersion(null)).toBe(Number.POSITIVE_INFINITY)
    expect(majorVersion('weird')).toBe(Number.POSITIVE_INFINITY)
  })
})
