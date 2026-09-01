import { integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core'

/**
 * Full data model from 00-architecture.md. Every table is created up front even
 * though later phases are the ones that populate most of them.
 *
 * Conventions:
 * - ids are text UUIDs generated in the app (crypto.randomUUID)
 * - timestamps are unix epoch milliseconds (integer, mode: 'timestamp_ms')
 * - json columns are text with mode: 'json'
 * - enums are text columns constrained via `{ enum: [...] }`
 */

const uuid = () => crypto.randomUUID()

const createdAt = () =>
  integer('created_at', { mode: 'timestamp_ms' })
    .notNull()
    .$defaultFn(() => new Date())

export const gitlabInstance = sqliteTable('gitlab_instance', {
  id: text('id').primaryKey().$defaultFn(uuid),
  label: text('label').notNull(),
  baseUrl: text('base_url').notNull(),
  /** safeStorage ciphertext — the plaintext token never touches disk or IPC. */
  tokenCiphertext: text('token_ciphertext').notNull(),
  /** JSON array of requested scopes, e.g. ["api"]. */
  tokenScopes: text('token_scopes').notNull().default('[]'),
  gitlabVersion: text('gitlab_version'),
  userId: text('user_id'),
  username: text('username'),
  createdAt: createdAt(),
})

export const project = sqliteTable(
  'project',
  {
    id: text('id').primaryKey().$defaultFn(uuid),
    instanceId: text('instance_id')
      .notNull()
      .references(() => gitlabInstance.id, { onDelete: 'cascade' }),
    gitlabProjectId: text('gitlab_project_id').notNull(),
    pathWithNamespace: text('path_with_namespace').notNull(),
    name: text('name').notNull(),
    defaultBranch: text('default_branch'),
    mirrorPath: text('mirror_path'),
    referenceClonePath: text('reference_clone_path'),
    modelOverride: text('model_override'),
    effortOverride: text('effort_override'),
  },
  (t) => [uniqueIndex('project_gitlab_uq').on(t.instanceId, t.gitlabProjectId)],
)

export const mergeRequest = sqliteTable(
  'merge_request',
  {
    id: text('id').primaryKey().$defaultFn(uuid),
    projectId: text('project_id')
      .notNull()
      .references(() => project.id, { onDelete: 'cascade' }),
    iid: integer('iid').notNull(),
    title: text('title').notNull(),
    description: text('description'),
    author: text('author'),
    sourceBranch: text('source_branch').notNull(),
    targetBranch: text('target_branch').notNull(),
    state: text('state').notNull(),
    webUrl: text('web_url').notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' }),
    lastSeenHeadSha: text('last_seen_head_sha'),
  },
  (t) => [uniqueIndex('merge_request_project_iid_uq').on(t.projectId, t.iid)],
)

export type RunKind = 'full' | 'verify'
export type RunStatus =
  | 'queued'
  | 'running'
  | 'done'
  | 'failed'
  | 'cancelled'
  | 'interrupted'

export type RunUsage = {
  inputTokens: number
  outputTokens: number
  cacheReadInputTokens?: number
  cacheCreationInputTokens?: number
  costUsd?: number
}

export const run = sqliteTable('run', {
  id: text('id').primaryKey().$defaultFn(uuid),
  mergeRequestId: text('merge_request_id')
    .notNull()
    .references(() => mergeRequest.id, { onDelete: 'cascade' }),
  kind: text('kind', { enum: ['full', 'verify'] as const }).notNull().$type<RunKind>(),
  status: text('status', {
    enum: ['queued', 'running', 'done', 'failed', 'cancelled', 'interrupted'] as const,
  })
    .notNull()
    .default('queued')
    .$type<RunStatus>(),
  baseSha: text('base_sha'),
  headSha: text('head_sha'),
  model: text('model'),
  effort: text('effort'),
  /** JSON array of enabled skill names (SDK `skills` context filter). */
  enabledSkills: text('enabled_skills', { mode: 'json' }).$type<string[]>(),
  worktreePath: text('worktree_path'),
  logPath: text('log_path'),
  usage: text('usage', { mode: 'json' }).$type<RunUsage>(),
  error: text('error'),
  startedAt: integer('started_at', { mode: 'timestamp_ms' }),
  endedAt: integer('ended_at', { mode: 'timestamp_ms' }),
})

export type FindingScope = 'line' | 'file' | 'global'
export type TriageState = 'untriaged' | 'valid' | 'invalid'
export type LifecycleState = 'open' | 'fixed' | 'stale' | 'moot'

export const finding = sqliteTable(
  'finding',
  {
    id: text('id').primaryKey().$defaultFn(uuid),
    /**
     * Nullable: deleting a GitLab instance cascades its projects and merge
     * requests, but findings are the user's own work and must survive — they
     * become orphans (merge_request_id set to null) instead of being deleted.
     */
    mergeRequestId: text('merge_request_id').references(() => mergeRequest.id, {
      onDelete: 'set null',
    }),
    /** sha256(file_path + normalized(anchor_snippet) + category) — unique per MR. */
    fingerprint: text('fingerprint').notNull(),
    scope: text('scope', { enum: ['line', 'file', 'global'] as const })
      .notNull()
      .$type<FindingScope>(),
    filePath: text('file_path'),
    anchorSnippet: text('anchor_snippet'),
    ctxBefore: text('ctx_before'),
    ctxAfter: text('ctx_after'),
    currentLine: integer('current_line'),
    category: text('category'),
    severity: text('severity'),
    title: text('title').notNull(),
    body: text('body'),
    suggestedFix: text('suggested_fix'),
    createdRunId: text('created_run_id').references(() => run.id, { onDelete: 'set null' }),
    firstSeenHeadSha: text('first_seen_head_sha'),
    triage: text('triage', { enum: ['untriaged', 'valid', 'invalid'] as const })
      .notNull()
      .default('untriaged')
      .$type<TriageState>(),
    triageNote: text('triage_note'),
    lifecycle: text('lifecycle', { enum: ['open', 'fixed', 'stale', 'moot'] as const })
      .notNull()
      .default('open')
      .$type<LifecycleState>(),
    lifecycleRunId: text('lifecycle_run_id').references(() => run.id, { onDelete: 'set null' }),
  },
  (t) => [uniqueIndex('finding_mr_fingerprint_uq').on(t.mergeRequestId, t.fingerprint)],
)

export type FindingEventType =
  | 'submitted'
  | 'rejected_by_verifier'
  | 'reanchored'
  | 'verified'
  | 'triaged'

export const findingEvent = sqliteTable('finding_event', {
  id: text('id').primaryKey().$defaultFn(uuid),
  /** Null only for verifier rejections, which happen before a valid finding exists. */
  findingId: text('finding_id').references(() => finding.id, { onDelete: 'cascade' }),
  runId: text('run_id')
    .notNull()
    .references(() => run.id, { onDelete: 'cascade' }),
  type: text('type', {
    enum: ['submitted', 'rejected_by_verifier', 'reanchored', 'verified', 'triaged'] as const,
  })
    .notNull()
    .$type<FindingEventType>(),
  payload: text('payload', { mode: 'json' }),
  createdAt: createdAt(),
})

export type SkillScope = 'user' | 'project'
export type SkillOrigin = 'builtin' | 'user' | 'imported'

export const skill = sqliteTable(
  'skill',
  {
    id: text('id').primaryKey().$defaultFn(uuid),
    scope: text('scope', { enum: ['user', 'project'] as const }).notNull().$type<SkillScope>(),
    projectId: text('project_id').references(() => project.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    dirPath: text('dir_path').notNull(),
    description: text('description'),
    enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
    sortOrder: integer('sort_order').notNull().default(0),
    origin: text('origin', { enum: ['builtin', 'user', 'imported'] as const })
      .notNull()
      .default('user')
      .$type<SkillOrigin>(),
  },
  (t) => [uniqueIndex('skill_scope_name_uq').on(t.scope, t.projectId, t.name)],
)

export const setting = sqliteTable('setting', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
})

export type GitlabInstanceRow = typeof gitlabInstance.$inferSelect
export type ProjectRow = typeof project.$inferSelect
export type MergeRequestRow = typeof mergeRequest.$inferSelect
export type RunRow = typeof run.$inferSelect
export type FindingRow = typeof finding.$inferSelect
export type FindingEventRow = typeof findingEvent.$inferSelect
export type SkillRow = typeof skill.$inferSelect
export type SettingRow = typeof setting.$inferSelect
