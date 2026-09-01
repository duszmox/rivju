import { and, desc, eq } from 'drizzle-orm'
import { getDb } from '../db/client.ts'
import { gitlabInstance, mergeRequest, project } from '../db/schema.ts'
import { decryptToken, encryptToken } from '../security/tokens.ts'
import { GitlabApiError, GitlabClient } from './client.ts'
import { gitlabProjectSchema } from './schemas.ts'
import type { GitlabInstanceRow, ProjectRow } from '../db/schema.ts'
import type { GitlabMergeRequest, GitlabProject } from './schemas.ts'

/**
 * Service layer between the tRPC routers and (client, vault, db). Holds the
 * per-instance client cache so the concurrency cap is genuinely per instance.
 * Plaintext tokens are decrypted only inside `getClientForInstance` / add /
 * re-auth and never leave the main process.
 */

export interface InstanceView {
  id: string
  label: string
  baseUrl: string
  username: string | null
  userId: string | null
  gitlabVersion: string | null
  /** Major version below 15 — architecture requires a warning. */
  versionWarning: boolean
  createdAt: string
}

export interface ProjectView {
  id: string
  instanceId: string
  gitlabProjectId: string
  pathWithNamespace: string
  name: string
  defaultBranch: string | null
  mirrorPath: string | null
  referenceClonePath: string | null
}

export interface MergeRequestListItem {
  instanceId: string
  instanceLabel: string
  baseUrl: string
  gitlabProjectId: number
  iid: number
  title: string
  state: string
  webUrl: string
  author: string | null
  sourceBranch: string
  targetBranch: string
  updatedAt: string | null
  draft: boolean
}

export interface MergeRequestDetail {
  mr: MergeRequestListItem
  description: string | null
  labels: string[]
  diffRefs: { baseSha: string; headSha: string; startSha: string } | null
  files: {
    newPath: string
    oldPath: string
    newFile: boolean
    deletedFile: boolean
    renamedFile: boolean
  }[]
}

export interface InstanceError {
  instanceId: string
  instanceLabel: string
  message: string
}

export interface ReviewQueue {
  items: MergeRequestListItem[]
  instanceErrors: InstanceError[]
}

// ---- per-instance client cache -------------------------------------------

const clientCache = new Map<string, { client: GitlabClient; tokenFingerprint: string }>()

function fingerprintToken(token: string): string {
  // Identifies the token so a re-auth invalidates the cached client, without
  // ever logging or returning the plaintext.
  let hash = 5381
  for (let i = 0; i < token.length; i++) hash = ((hash << 5) + hash + token.charCodeAt(i)) | 0
  return String(hash)
}

export function getClientForInstance(instance: GitlabInstanceRow): GitlabClient {
  const token = decryptToken(instance.tokenCiphertext)
  const fp = fingerprintToken(token)
  const cached = clientCache.get(instance.id)
  if (cached && cached.tokenFingerprint === fp) return cached.client
  const client = new GitlabClient({ baseUrl: instance.baseUrl, token })
  clientCache.set(instance.id, { client, tokenFingerprint: fp })
  return client
}

function invalidateClient(instanceId: string): void {
  clientCache.delete(instanceId)
}

// ---- instances -------------------------------------------------------------

export function toInstanceView(row: GitlabInstanceRow): InstanceView {
  return {
    id: row.id,
    label: row.label,
    baseUrl: row.baseUrl,
    username: row.username,
    userId: row.userId,
    gitlabVersion: row.gitlabVersion,
    versionWarning: majorVersion(row.gitlabVersion) < 15,
    createdAt: row.createdAt.toISOString(),
  }
}

export function majorVersion(version: string | null): number {
  if (!version) return Number.POSITIVE_INFINITY
  const match = version.match(/(\d+)\./)
  return match ? Number(match[1]) : Number.POSITIVE_INFINITY
}

/** Never returns token material — ciphertext stays in the DB. */
export function listInstances(): InstanceView[] {
  const rows = getDb().select().from(gitlabInstance).orderBy(desc(gitlabInstance.createdAt)).all()
  return rows.map(toInstanceView)
}

export function getInstance(instanceId: string): GitlabInstanceRow {
  const row = getDb().select().from(gitlabInstance).where(eq(gitlabInstance.id, instanceId)).get()
  if (!row) throw new Error(`Unknown instance: ${instanceId}`)
  return row
}

/**
 * Add-instance flow: validate the PAT against /user and /version (plus
 * /personal_access_tokens/self for scopes on GitLab 16+), encrypt, persist.
 */
export async function addInstance(input: {
  label: string
  baseUrl: string
  token: string
}): Promise<InstanceView> {
  const baseUrl = normalizeBaseUrl(input.baseUrl)
  const client = new GitlabClient({ baseUrl, token: input.token })

  const user = await client.currentUser()
  const version = await client.version()
  const tokenInfo = await client.tokenSelf()

  const inserted = getDb()
    .insert(gitlabInstance)
    .values({
      label: input.label,
      baseUrl,
      tokenCiphertext: encryptToken(input.token),
      tokenScopes: JSON.stringify(tokenInfo?.scopes ?? []),
      gitlabVersion: version.version,
      userId: String(user.id),
      username: user.username,
    })
    .returning()
    .get()
  return toInstanceView(inserted)
}

/** Re-validates stored credentials; refreshes username/version from the server. */
export async function validateInstance(instanceId: string): Promise<InstanceView> {
  const instance = getInstance(instanceId)
  const client = getClientForInstance(instance)
  const [user, version] = await Promise.all([client.currentUser(), client.version()])
  const updated = getDb()
    .update(gitlabInstance)
    .set({ username: user.username, userId: String(user.id), gitlabVersion: version.version })
    .where(eq(gitlabInstance.id, instanceId))
    .returning()
    .get()
  return toInstanceView(updated)
}

/** Replace the token for an existing instance (re-auth), after validating it. */
export async function reAuthInstance(instanceId: string, token: string): Promise<InstanceView> {
  const instance = getInstance(instanceId)
  const probe = new GitlabClient({ baseUrl: instance.baseUrl, token })
  const [user, version, tokenInfo] = await Promise.all([
    probe.currentUser(),
    probe.version(),
    probe.tokenSelf(),
  ])
  const updated = getDb()
    .update(gitlabInstance)
    .set({
      tokenCiphertext: encryptToken(token),
      tokenScopes: JSON.stringify(tokenInfo?.scopes ?? []),
      username: user.username,
      userId: String(user.id),
      gitlabVersion: version.version,
    })
    .where(eq(gitlabInstance.id, instanceId))
    .returning()
    .get()
  invalidateClient(instanceId)
  return toInstanceView(updated)
}

/**
 * Delete cascades to projects and merge requests (SQLite FK cascade) but NOT
 * to findings: `finding.merge_request_id` is `ON DELETE SET NULL`, so
 * findings survive as the user's own work.
 */
export function deleteInstance(instanceId: string): { id: string } {
  invalidateClient(instanceId)
  const deleted = getDb()
    .delete(gitlabInstance)
    .where(eq(gitlabInstance.id, instanceId))
    .returning({ id: gitlabInstance.id })
    .get()
  if (!deleted) throw new Error(`Unknown instance: ${instanceId}`)
  return deleted
}

function normalizeBaseUrl(input: string): string {
  let url: URL
  try {
    url = new URL(input)
  } catch {
    throw new Error(`"${input}" is not a valid URL. Use e.g. https://gitlab.example.com`)
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error('Base URL must start with https:// (or http:// for local test instances)')
  }
  return url.origin
}

// ---- projects ----------------------------------------------------------------

export function listPickedProjects(instanceId: string): ProjectView[] {
  const rows = getDb()
    .select()
    .from(project)
    .where(eq(project.instanceId, instanceId))
    .orderBy(project.pathWithNamespace)
    .all()
  return rows.map(toProjectView)
}

function toProjectView(row: ProjectRow): ProjectView {
  return {
    id: row.id,
    instanceId: row.instanceId,
    gitlabProjectId: row.gitlabProjectId,
    pathWithNamespace: row.pathWithNamespace,
    name: row.name,
    defaultBranch: row.defaultBranch,
    mirrorPath: row.mirrorPath,
    referenceClonePath: row.referenceClonePath,
  }
}

export interface ProjectSearchResult {
  instanceId: string
  instanceLabel: string
  gitlabProjectId: number
  pathWithNamespace: string
  name: string
  defaultBranch: string | null
  starred: boolean
  lastActivityAt: string | null
}

/**
 * Live project search for one instance: `membership=true&simple=true`
 * (+ `search`), starred projects first, then by last activity. `simple=true`
 * responses carry no `starred` flag, so starred ids come from a second
 * `starred=true&simple=true` call and are merged in.
 */
export async function searchProjects(
  instanceId: string,
  search: string | undefined,
): Promise<ProjectSearchResult[]> {
  const instance = getInstance(instanceId)
  const client = getClientForInstance(instance)
  const query: Record<string, string | number | boolean | undefined> = { simple: true }
  if (search) query.search = search

  const [membership, starred] = await Promise.all([
    client.listProjects(query),
    client.listProjects({ starred: true, simple: true }, { maxPages: 1 }),
  ])
  const starredIds = new Set(starred.map((p) => p.id))

  const starredFirst = [...membership].sort((a, b) => {
    const starDiff = Number(starredIds.has(b.id)) - Number(starredIds.has(a.id))
    if (starDiff !== 0) return starDiff
    return (b.last_activity_at ?? '').localeCompare(a.last_activity_at ?? '')
  })
  return starredFirst.map((p) => ({
    instanceId,
    instanceLabel: instance.label,
    gitlabProjectId: p.id,
    pathWithNamespace: p.path_with_namespace,
    name: p.name,
    defaultBranch: p.default_branch ?? null,
    starred: starredIds.has(p.id),
    lastActivityAt: p.last_activity_at ?? null,
  }))
}

/** Persist a project row when the user picks one (upsert on instance+gitlab id). */
export function pickProject(input: {
  instanceId: string
  gitlabProjectId: number
  pathWithNamespace: string
  name: string
  defaultBranch: string | null
}): ProjectView {
  const db = getDb()
  const existing = db
    .select()
    .from(project)
    .where(
      and(
        eq(project.instanceId, input.instanceId),
        eq(project.gitlabProjectId, String(input.gitlabProjectId)),
      ),
    )
    .get()
  if (existing) {
    const updated = db
      .update(project)
      .set({
        pathWithNamespace: input.pathWithNamespace,
        name: input.name,
        defaultBranch: input.defaultBranch,
      })
      .where(eq(project.id, existing.id))
      .returning()
      .get()
    return toProjectView(updated)
  }
  const inserted = db
    .insert(project)
    .values({
      instanceId: input.instanceId,
      gitlabProjectId: String(input.gitlabProjectId),
      pathWithNamespace: input.pathWithNamespace,
      name: input.name,
      defaultBranch: input.defaultBranch,
    })
    .returning()
    .get()
  return toProjectView(inserted)
}

export function unpickProject(instanceId: string, projectId: string): { id: string } {
  const deleted = getDb()
    .delete(project)
    .where(and(eq(project.instanceId, instanceId), eq(project.id, projectId)))
    .returning({ id: project.id })
    .get()
  if (!deleted) throw new Error(`Unknown project ${projectId} on instance ${instanceId}`)
  return deleted
}

// ---- merge requests -----------------------------------------------------------

/**
 * Default review queue: for every stored instance, MRs where I am reviewer OR
 * assignee, state=opened. Two API calls per instance, results merged and
 * deduped by (project, iid). One failing instance doesn't kill the rest —
 * it lands in `instanceErrors`.
 */
export async function fetchReviewQueue(): Promise<ReviewQueue> {
  const instances = getDb().select().from(gitlabInstance).all()
  const items = new Map<string, MergeRequestListItem>()
  const instanceErrors: InstanceError[] = []

  await Promise.all(
    instances.map(async (instance) => {
      try {
        const userId = instance.userId ? Number(instance.userId) : null
        if (userId === null || Number.isNaN(userId)) return
        const client = getClientForInstance(instance)
        const [asReviewer, asAssignee] = await Promise.all([
          client.listMergeRequests({ reviewer_id: userId, state: 'opened', scope: 'all' }),
          client.listMergeRequests({ assignee_id: userId, state: 'opened', scope: 'all' }),
        ])
        for (const mr of mergeAndDedupe(asReviewer, asAssignee)) {
          items.set(`${instance.id}:${mr.project_id ?? '?'}:${mr.iid}`, toListItem(instance, mr))
        }
      } catch (err) {
        instanceErrors.push({
          instanceId: instance.id,
          instanceLabel: instance.label,
          message: err instanceof Error ? err.message : String(err),
        })
      }
    }),
  )

  return {
    items: [...items.values()].sort((a, b) =>
      (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''),
    ),
    instanceErrors,
  }
}

/** Two calls (reviewer + assignee) merged, deduped by project_id+iid. */
export function mergeAndDedupe(
  asReviewer: GitlabMergeRequest[],
  asAssignee: GitlabMergeRequest[],
): GitlabMergeRequest[] {
  const merged = new Map<string, GitlabMergeRequest>()
  for (const mr of [...asReviewer, ...asAssignee]) {
    merged.set(`${mr.project_id ?? '?'}:${mr.iid}`, mr)
  }
  return [...merged.values()]
}

function toListItem(instance: GitlabInstanceRow, mr: GitlabMergeRequest): MergeRequestListItem {
  return {
    instanceId: instance.id,
    instanceLabel: instance.label,
    baseUrl: instance.baseUrl,
    gitlabProjectId: mr.project_id ?? 0,
    iid: mr.iid,
    title: mr.title,
    state: mr.state,
    webUrl: mr.web_url,
    author: mr.author?.username ?? null,
    sourceBranch: mr.source_branch,
    targetBranch: mr.target_branch,
    updatedAt: mr.updated_at ?? null,
    draft: mr.draft ?? mr.work_in_progress ?? false,
  }
}

/** Per-project browse view (secondary listing). */
export async function browseProjectMergeRequests(
  instanceId: string,
  gitlabProjectId: number,
): Promise<MergeRequestListItem[]> {
  const instance = getInstance(instanceId)
  const client = getClientForInstance(instance)
  const mrs = await client.listProjectMergeRequests(gitlabProjectId, {
    state: 'opened',
    order_by: 'updated_at',
  })
  return mrs.map((mr) => toListItem(instance, mr))
}

/**
 * MR detail: fetch MR + changed files live, capture `diff_refs`, and persist
 * the project + merge_request rows so Phase 2's repo layer can resolve head
 * sha and branches without a round trip.
 */
export async function fetchMergeRequestDetail(
  instanceId: string,
  gitlabProjectId: number,
  iid: number,
): Promise<MergeRequestDetail> {
  const instance = getInstance(instanceId)
  const client = getClientForInstance(instance)

  const [mr, files] = await Promise.all([
    client.getMergeRequest(gitlabProjectId, iid),
    client.listMergeRequestDiffs(gitlabProjectId, iid),
  ])

  await persistMrHierarchy(instance, gitlabProjectId, mr)

  return {
    mr: toListItem(instance, mr),
    description: mr.description ?? null,
    labels: mr.labels ?? [],
    diffRefs: mr.diff_refs
      ? {
          baseSha: mr.diff_refs.base_sha,
          headSha: mr.diff_refs.head_sha,
          startSha: mr.diff_refs.start_sha,
        }
      : null,
    files: files.map((f) => ({
      newPath: f.new_path,
      oldPath: f.old_path,
      newFile: f.new_file ?? false,
      deletedFile: f.deleted_file ?? false,
      renamedFile: f.renamed_file ?? false,
    })),
  }
}

async function persistMrHierarchy(
  instance: GitlabInstanceRow,
  gitlabProjectId: number,
  mr: GitlabMergeRequest,
): Promise<void> {
  const db = getDb()
  let projectRow = db
    .select()
    .from(project)
    .where(
      and(
        eq(project.instanceId, instance.id),
        eq(project.gitlabProjectId, String(gitlabProjectId)),
      ),
    )
    .get()
  if (!projectRow) {
    // The user hasn't picked this project; fetch the minimum to fill the row.
    const fetched = await client_getProject(instance, gitlabProjectId)
    projectRow = db
      .insert(project)
      .values({
        instanceId: instance.id,
        gitlabProjectId: String(gitlabProjectId),
        pathWithNamespace: fetched.path_with_namespace,
        name: fetched.name,
        defaultBranch: fetched.default_branch ?? null,
      })
      .returning()
      .get()
  }
  db.insert(mergeRequest)
    .values({
      projectId: projectRow.id,
      iid: mr.iid,
      title: mr.title,
      description: mr.description ?? null,
      author: mr.author?.username ?? null,
      sourceBranch: mr.source_branch,
      targetBranch: mr.target_branch,
      state: mr.state,
      webUrl: mr.web_url,
      updatedAt: mr.updated_at ? new Date(mr.updated_at) : null,
      lastSeenHeadSha: mr.diff_refs?.head_sha ?? null,
    })
    .onConflictDoUpdate({
      target: [mergeRequest.projectId, mergeRequest.iid],
      set: {
        title: mr.title,
        description: mr.description ?? null,
        state: mr.state,
        updatedAt: mr.updated_at ? new Date(mr.updated_at) : null,
        lastSeenHeadSha: mr.diff_refs?.head_sha ?? null,
      },
    })
    .run()
}

async function client_getProject(
  instance: GitlabInstanceRow,
  gitlabProjectId: number,
): Promise<GitlabProject> {
  return getClientForInstance(instance).getJson(
    `/api/v4/projects/${gitlabProjectId}`,
    gitlabProjectSchema,
  )
}

export function describeGitlabError(err: unknown): string {
  if (err instanceof GitlabApiError) {
    if (err.status === 401) return 'Token rejected (401). Re-authenticate this instance.'
    return err.message
  }
  return err instanceof Error ? err.message : String(err)
}
