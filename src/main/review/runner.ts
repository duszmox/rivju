import { query } from '@anthropic-ai/claude-agent-sdk'
import type { EffortLevel, SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import { and, desc, eq, isNotNull } from 'drizzle-orm'
import { appendFile, mkdir } from 'node:fs/promises'
import path from 'node:path'
import { getPreflightState } from '../claude/preflight.ts'
import { getDb } from '../db/client.ts'
import { gitlabInstance, mergeRequest, project, run, setting, skill } from '../db/schema.ts'
import { emitRunEvent } from '../events/bus.ts'
import { getClientForInstance } from '../gitlab/service.ts'
import { resolvePaths } from '../paths.ts'
import { computeDiff } from '../repo/diff.ts'
import { ensureMirror, fetchMergeRequest } from '../repo/mirror.ts'
import { withRunWorktree } from '../repo/worktree.ts'
import { decryptToken } from '../security/tokens.ts'
import { createReviewMcp } from './mcp.ts'
import { canUseReviewTool } from './permissions.ts'
import { spawnReviewProcess } from './process.ts'
import { composeReviewPrompt, composeVerifyPrompt, REVIEW_SYSTEM_PROMPT, VERIFY_SYSTEM_PROMPT } from './prompt.ts'
import { collectRejectedFindings } from './rejected.ts'
import { createVerifyMcp, reanchorOpenFindings } from './verify.ts'
import { resolveSkillContext } from '../skills/resolve.ts'
import { ensureRunPluginDirs } from '../skills/service.ts'
import { parseEffort, resolveModelSelection } from '../settings/service.ts'
import type { RivjuDatabase } from '../db/client.ts'
import type { RunKind, RunRow, RunUsage } from '../db/schema.ts'

const DEFAULT_CONCURRENCY = 2
const MAX_CONCURRENCY = 5
const DEFAULT_MAX_TURNS = 40
const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000
const VERIFY_DEFAULT_MAX_TURNS = 15
const VERIFY_DEFAULT_TIMEOUT_MS = 10 * 60 * 1000
const MAX_TIMEOUT_MS = 2 * 60 * 60 * 1000

export type StartReviewInput = {
  instanceId: string
  gitlabProjectId: number
  iid: number
  baseSha: string
  headSha: string
  labels: string[]
  selectedPaths?: string[]
  model?: string
  effort?: EffortLevel
}

export type StartVerifyInput = {
  instanceId: string
  gitlabProjectId: number
  iid: number
}

type QueuedReview = StartReviewInput & { runId: string; kind: RunKind }
type ReviewQuery = ReturnType<typeof query>
type ReviewContext = Awaited<ReturnType<typeof lookupContext>>
type ActiveReview = {
  abort: AbortController
  session: ReviewQuery | null
  timeout: NodeJS.Timeout | null
  timedOut: boolean
}

const pending: QueuedReview[] = []
const active = new Map<string, ActiveReview>()
let disposing = false

export function startReview(input: StartReviewInput): RunRow {
  if (disposing) throw new Error('rivju is shutting down')
  const db = getDb()
  const context = lookupContext(input)
  const selection = resolveSelection(input, context.project)
  const enabledSkills = resolveRunSkills(context.project).skills
  const paths = resolvePaths()
  const runId = crypto.randomUUID()
  const logPath = path.join(paths.logsDir, `${runId}.jsonl`)
  const row = db.insert(run).values({
    id: runId,
    mergeRequestId: context.mr.id,
    kind: 'full',
    status: 'queued',
    baseSha: input.baseSha,
    headSha: input.headSha,
    model: selection.model,
    effort: selection.effort,
    enabledSkills,
    logPath,
  }).returning().get()
  pending.push({ ...input, runId, kind: 'full' })
  emitQueuePositions()
  queueMicrotask(pumpQueue)
  return row
}

/**
 * Queue a `verify` run for a merge request: the cheap agent checks whether the
 * still-open findings survive at the current head. The reviewed head is the
 * most recent completed run; the new head is resolved live from GitLab so the
 * check always sees what a reviewer would see right now.
 */
export async function startVerifyRun(input: StartVerifyInput): Promise<RunRow> {
  if (disposing) throw new Error('rivju is shutting down')
  const db = getDb()
  const context = lookupContext(input)
  const reviewed = latestDoneRunWithHead(context.mr.id)
  if (!reviewed?.headSha) {
    throw new Error('Run a full review first — "Check if fixed" compares against a completed review')
  }
  const fresh = await getClientForInstance(context.instance).getMergeRequest(
    input.gitlabProjectId,
    input.iid,
  )
  const headSha = fresh.diff_refs?.head_sha ?? null
  if (!headSha || !isSha(headSha)) {
    throw new Error('GitLab did not report a current head SHA for this merge request')
  }
  const selection = resolveSelection({}, context.project)
  const paths = resolvePaths()
  const runId = crypto.randomUUID()
  const logPath = path.join(paths.logsDir, `${runId}.jsonl`)
  const row = db.insert(run).values({
    id: runId,
    mergeRequestId: context.mr.id,
    kind: 'verify',
    status: 'queued',
    baseSha: reviewed.headSha,
    headSha,
    model: selection.model,
    effort: selection.effort,
    enabledSkills: [],
    logPath,
  }).returning().get()
  pending.push({
    instanceId: input.instanceId,
    gitlabProjectId: input.gitlabProjectId,
    iid: input.iid,
    baseSha: reviewed.headSha,
    headSha,
    labels: [],
    runId,
    kind: 'verify',
  })
  emitQueuePositions()
  queueMicrotask(pumpQueue)
  return row
}

export function cancelReview(runId: string): boolean {
  const queuedIndex = pending.findIndex((item) => item.runId === runId)
  if (queuedIndex >= 0) {
    pending.splice(queuedIndex, 1)
    markCancelled(runId)
    emitQueuePositions()
    return true
  }
  const running = active.get(runId)
  if (!running) return false
  running.abort.abort()
  if (running.timeout) clearTimeout(running.timeout)
  void running.session?.interrupt().catch(() => undefined)
  running.session?.close()
  markCancelled(runId)
  return true
}

/** Abort/close every SDK process synchronously enough for Electron before-quit. */
export function disposeReviewRuns(): void {
  disposing = true
  for (const item of pending.splice(0)) markCancelled(item.runId)
  for (const [runId, item] of active) {
    item.abort.abort()
    if (item.timeout) clearTimeout(item.timeout)
    void item.session?.interrupt().catch(() => undefined)
    item.session?.close()
    markCancelled(runId)
  }
}

export function listRuns(): RunRow[] {
  return getDb().select().from(run).all().sort((a, b) =>
    (b.startedAt?.getTime() ?? 0) - (a.startedAt?.getTime() ?? 0),
  )
}

function pumpQueue(): void {
  if (disposing) return
  const cap = concurrencyLimit()
  while (active.size < cap) {
    const next = pending.shift()
    if (!next) break
    const state: ActiveReview = { abort: new AbortController(), session: null, timeout: null, timedOut: false }
    active.set(next.runId, state)
    void executeReview(next, state)
      .catch((error: unknown) => failRunSafely(next.runId, error))
      .finally(() => {
        active.delete(next.runId)
        emitQueuePositions()
        pumpQueue()
      })
  }
  emitQueuePositions()
}

async function executeReview(item: QueuedReview, activeReview: ActiveReview): Promise<void> {
  const db = getDb()
  const context = lookupContext(item)
  const row = db.select().from(run).where(eq(run.id, item.runId)).get()
  if (!row || row.status === 'cancelled') return
  db.update(run).set({ status: 'running', startedAt: new Date() }).where(eq(run.id, item.runId)).run()
  emitRunEvent({
    type: 'run:started', runId: item.runId, at: Date.now(), model: row.model, effort: row.effort,
  })
  const paths = resolvePaths()
  await mkdir(paths.logsDir, { recursive: true })
  const log = new JsonlWriter(row.logPath ?? path.join(paths.logsDir, `${item.runId}.jsonl`))

  try {
    emitPhase(item.runId, 'preparing', 'Fetching merge request and creating detached checkout')
    const token = decryptToken(context.instance.tokenCiphertext)
    const mirrorPath = await ensureMirror({
      reposDir: paths.reposDir,
      project: {
        instanceId: context.project.instanceId,
        pathWithNamespace: context.project.pathWithNamespace,
        baseUrl: context.instance.baseUrl,
        referenceClonePath: context.project.referenceClonePath,
      },
      token,
      signal: activeReview.abort.signal,
      onProgress: (_phase, detail) => emitPhase(item.runId, 'preparing', detail ?? 'Preparing repository'),
    })
    await fetchMergeRequest({
      mirrorPath,
      iid: item.iid,
      token,
      signal: activeReview.abort.signal,
      onProgress: (_phase, detail) => emitPhase(item.runId, 'preparing', detail ?? 'Fetching merge request'),
    })
    db.update(project).set({ mirrorPath }).where(eq(project.id, context.project.id)).run()

    await withRunWorktree(
      { mirrorPath, worktreesDir: paths.worktreesDir, runId: item.runId, headSha: item.headSha },
      async (worktreePath) => {
        db.update(run).set({ worktreePath }).where(eq(run.id, item.runId)).run()
        const flow = { item, context, row, mirrorPath, worktreePath, activeReview, log }
        if (item.kind === 'verify') await runVerifyFlow(flow)
        else await runFullFlow(flow)
      },
    )
  } catch (error) {
    if (isCancelled(item.runId)) return
    const message = activeReview.timedOut
      ? `${item.kind === 'verify' ? 'Verification' : 'Review'} exceeded its wall-clock timeout`
      : error instanceof Error ? error.message : String(error)
    db.update(run).set({ status: 'failed', error: message, endedAt: new Date() }).where(eq(run.id, item.runId)).run()
    emitRunEvent({ type: 'run:failed', runId: item.runId, at: Date.now(), error: message })
  } finally {
    if (activeReview.timeout) clearTimeout(activeReview.timeout)
    activeReview.session?.close()
    await log.close()
  }
}

type ReviewFlow = {
  item: QueuedReview
  context: ReviewContext
  row: RunRow
  /** The mirror resolved for THIS run — context.project.mirrorPath may lag. */
  mirrorPath: string
  worktreePath: string
  activeReview: ActiveReview
  log: JsonlWriter
}

async function runFullFlow(flow: ReviewFlow): Promise<void> {
  const { item, context, row, mirrorPath, worktreePath, activeReview, log } = flow
  const db = getDb()
  const diff = await computeDiff({
    mirrorPath,
    baseSha: item.baseSha,
    headSha: item.headSha,
    selectedPaths: item.selectedPaths,
  })
  if (diff.status === 'needs_scoping') {
    throw new Error('This merge request exceeds the review budget. Select a file scope before launching.')
  }

  const completion = { finished: false }
  let findingCount = 0
  const mcp = createReviewMcp({
    db,
    runId: item.runId,
    mergeRequestId: context.mr.id,
    headSha: item.headSha,
    worktreePath,
    onFinding: () => { findingCount++ },
    onFinished: () => { completion.finished = true },
  })
  const preflight = requirePreflight()
  // Resolved once more at launch time (not reused from the queued row) so a
  // toggle made while the run was waiting in the queue takes effect, and so
  // the plugin directories are guaranteed to exist before the SDK reads them.
  const skillContext = resolveRunSkills(context.project)
  await ensureRunPluginDirs(skillContext.projectPluginDir ? projectRefOf(context.project) : null)
  db.update(run).set({ enabledSkills: skillContext.skills }).where(eq(run.id, item.runId)).run()

  emitPhase(item.runId, 'reviewing', `Reviewing ${diff.files.length} changed files`)
  const prompt = composeReviewPrompt({
    title: context.mr.title,
    description: context.mr.description,
    labels: item.labels,
    baseSha: item.baseSha,
    headSha: item.headSha,
    files: diff.files,
    rejected: collectRejectedFindings(db, context.project.id),
  })
  log.write({
    type: 'rivju_run_start',
    at: Date.now(),
    runId: item.runId,
    prompt,
    config: {
      kind: 'full',
      baseSha: item.baseSha,
      headSha: item.headSha,
      model: row.model,
      effort: row.effort,
      enabledSkills: skillContext.skills,
      plugins: skillContext.plugins.map((plugin) => plugin.path),
      settingSources: skillContext.settingSources,
      cwd: worktreePath,
    },
  })
  const session = query({
    prompt,
    options: {
      cwd: worktreePath,
      pathToClaudeCodeExecutable: preflight.claudePath,
      settingSources: [],
      plugins: skillContext.plugins,
      skills: skillContext.skills,
      mcpServers: { rivju: mcp },
      strictMcpConfig: true,
      tools: ['Read', 'Grep', 'Glob', 'Bash', 'Skill'],
      allowedTools: ['Read', 'Grep', 'Glob', 'Bash', 'Skill', 'mcp__rivju__submit_finding', 'mcp__rivju__finish_review'],
      disallowedTools: ['Write', 'Edit', 'WebFetch'],
      canUseTool: canUseReviewTool,
      sandbox: reviewSandbox(),
      model: row.model ?? undefined,
      effort: parseEffort(row.effort),
      maxTurns: settingNumber('review.max_turns', DEFAULT_MAX_TURNS, 1, 200),
      abortController: activeReview.abort,
      includePartialMessages: true,
      systemPrompt: REVIEW_SYSTEM_PROMPT,
      spawnClaudeCodeProcess: spawnReviewProcessFactory(activeReview, log),
    },
  })
  activeReview.session = session
  armTimeout(activeReview, 'review.timeout_ms', DEFAULT_TIMEOUT_MS)
  const usage = await consumeSession(item, session, db, log)
  if (!completion.finished) throw new Error('Agent ended without calling finish_review')
  ensureNotAborted(activeReview)
  emitPhase(item.runId, 'summarizing', 'Saving review results')
  completeRun(item.runId, usage, findingCount)
}

/**
 * Verify flow: re-anchor the still-open findings at the new head, then hand
 * only what remains open to a tightly scoped verification agent.
 */
async function runVerifyFlow(flow: ReviewFlow): Promise<void> {
  const { item, context, row, mirrorPath, worktreePath, activeReview, log } = flow
  const db = getDb()
  emitPhase(item.runId, 'preparing', 'Re-anchoring open findings at the new head')
  const reanchor = await reanchorOpenFindings({
    db,
    mergeRequestId: context.mr.id,
    runId: item.runId,
    headSha: item.headSha,
    worktreePath,
    mirrorPath,
    oldHeadSha: item.baseSha,
  })
  log.write({
    type: 'rivju_reanchor',
    at: Date.now(),
    runId: item.runId,
    checked: reanchor.checked,
    reanchored: reanchor.reanchored,
    staled: reanchor.staled,
    unchanged: reanchor.unchanged,
  })
  const targets = reanchor.open
  if (!targets.length) {
    emitPhase(item.runId, 'summarizing', 'No open findings remain to verify')
    completeRun(item.runId, { inputTokens: 0, outputTokens: 0, costUsd: 0 }, 0)
    return
  }

  const diff = await computeDiff({
    mirrorPath,
    baseSha: item.baseSha,
    headSha: item.headSha,
  })
  if (diff.status === 'needs_scoping') {
    throw new Error('The changes since the reviewed head exceed the review budget; verify is unavailable for this merge request.')
  }

  const completion = { finished: false }
  const mcp = createVerifyMcp({
    db,
    runId: item.runId,
    mergeRequestId: context.mr.id,
    headSha: item.headSha,
    targetFindingIds: new Set(targets.map((target) => target.id)),
    onFinished: () => { completion.finished = true },
  })
  const preflight = requirePreflight()
  const prompt = composeVerifyPrompt({
    title: context.mr.title,
    reviewedHeadSha: item.baseSha,
    headSha: item.headSha,
    findings: targets,
    files: diff.files,
    rejected: collectRejectedFindings(db, context.project.id),
  })
  log.write({
    type: 'rivju_run_start',
    at: Date.now(),
    runId: item.runId,
    prompt,
    config: {
      kind: 'verify',
      baseSha: item.baseSha,
      headSha: item.headSha,
      model: row.model,
      effort: row.effort,
      enabledSkills: [],
      openFindings: targets.length,
      cwd: worktreePath,
    },
  })
  emitPhase(item.runId, 'reviewing', `Verifying ${targets.length} open findings`)
  const session = query({
    prompt,
    options: {
      cwd: worktreePath,
      pathToClaudeCodeExecutable: preflight.claudePath,
      settingSources: [],
      // Verification is deliberately skill-free. The option must be present and
      // empty: omitting `skills` makes the CLI load every skill it discovered,
      // which here means Claude Code's own bundled ones.
      skills: [],
      mcpServers: { rivju: mcp },
      strictMcpConfig: true,
      tools: ['Read', 'Grep', 'Glob', 'Bash'],
      allowedTools: ['Read', 'Grep', 'Glob', 'Bash', 'mcp__rivju__report_verification', 'mcp__rivju__finish_review'],
      disallowedTools: ['Write', 'Edit', 'WebFetch'],
      canUseTool: canUseReviewTool,
      sandbox: reviewSandbox(),
      model: row.model ?? undefined,
      effort: parseEffort(row.effort),
      maxTurns: settingNumber('verify.max_turns', VERIFY_DEFAULT_MAX_TURNS, 1, 200),
      abortController: activeReview.abort,
      includePartialMessages: true,
      systemPrompt: VERIFY_SYSTEM_PROMPT,
      spawnClaudeCodeProcess: spawnReviewProcessFactory(activeReview, log),
    },
  })
  activeReview.session = session
  armTimeout(activeReview, 'verify.timeout_ms', VERIFY_DEFAULT_TIMEOUT_MS)
  const usage = await consumeSession(item, session, db, log)
  if (!completion.finished) throw new Error('Verification agent ended without calling finish_review')
  ensureNotAborted(activeReview)
  emitPhase(item.runId, 'summarizing', 'Saving verification results')
  completeRun(item.runId, usage, targets.length)
}

function requirePreflight() {
  const preflight = getPreflightState()
  if (preflight.status !== 'ok') throw new Error('Claude preflight is not ready')
  return preflight
}

function reviewSandbox() {
  return {
    enabled: true,
    failIfUnavailable: true,
    autoAllowBashIfSandboxed: false,
    allowUnsandboxedCommands: false,
    network: { allowedDomains: [], strictAllowlist: true },
  }
}

function spawnReviewProcessFactory(activeReview: ActiveReview, log: JsonlWriter) {
  return (options: Parameters<typeof spawnReviewProcess>[0]) => spawnReviewProcess(
    options,
    activeReview.abort.signal,
    (data) => { log.write({ type: 'rivju_stderr', data, at: Date.now() }) },
  )
}

/** Stream the SDK session to the run log + live events; returns final usage. */
async function consumeSession(
  item: { runId: string },
  session: ReviewQuery,
  db: RivjuDatabase,
  log: JsonlWriter,
): Promise<RunUsage> {
  let usage: RunUsage = { inputTokens: 0, outputTokens: 0, costUsd: 0 }
  const liveTokens = new LiveTokenAccumulator()
  for await (const message of session) {
    log.write(message)
    emitToolUse(item.runId, message)
    if (message.type === 'assistant') {
      const tokens = liveTokens.update(
        message.message.id,
        message.message.usage.input_tokens,
        message.message.usage.output_tokens,
      )
      if (tokens) {
        usage = { ...usage, ...tokens }
        db.update(run).set({ usage }).where(eq(run.id, item.runId)).run()
        emitUsage(item.runId, usage)
      }
    }
    if (message.type === 'result') {
      usage = usageFromResult(message)
      db.update(run).set({ usage }).where(eq(run.id, item.runId)).run()
      emitUsage(item.runId, usage)
      if (message.is_error) throw new Error('errors' in message ? message.errors.join('; ') : message.result)
    }
  }
  return usage
}

function armTimeout(activeReview: ActiveReview, settingKey: string, fallback: number): void {
  const timeoutMs = settingNumber(settingKey, fallback, 10_000, MAX_TIMEOUT_MS)
  activeReview.timeout = setTimeout(() => {
    activeReview.timedOut = true
    activeReview.abort.abort()
  }, timeoutMs)
}

function ensureNotAborted(activeReview: ActiveReview): void {
  if (activeReview.abort.signal.aborted) throw abortError()
}

function completeRun(runId: string, usage: RunUsage, findingCount: number): void {
  getDb().update(run).set({ status: 'done', usage, endedAt: new Date() }).where(eq(run.id, runId)).run()
  emitRunEvent({ type: 'run:done', runId, at: Date.now(), findingCount })
}

function lookupContext(input: Pick<StartReviewInput, 'instanceId' | 'gitlabProjectId' | 'iid'>) {
  const result = getDb().select({ instance: gitlabInstance, project, mr: mergeRequest })
    .from(project)
    .innerJoin(gitlabInstance, eq(project.instanceId, gitlabInstance.id))
    .innerJoin(mergeRequest, eq(mergeRequest.projectId, project.id))
    .where(and(
      eq(project.instanceId, input.instanceId),
      eq(project.gitlabProjectId, String(input.gitlabProjectId)),
      eq(mergeRequest.iid, input.iid),
    )).get()
  if (!result) throw new Error('Open the merge request detail before launching a review')
  return result
}

function latestDoneRunWithHead(mergeRequestId: string): RunRow | undefined {
  return getDb().select().from(run)
    .where(and(
      eq(run.mergeRequestId, mergeRequestId),
      eq(run.status, 'done'),
      isNotNull(run.headSha),
    ))
    .orderBy(desc(run.startedAt))
    .all()[0]
}

function resolveSelection(
  input: Pick<StartReviewInput, 'model' | 'effort'>,
  projectRow: typeof project.$inferSelect,
) {
  return resolveModelSelection({ projectRow, model: input.model, effort: input.effort })
}

function projectRefOf(projectRow: typeof project.$inferSelect) {
  return {
    id: projectRow.id,
    instanceId: projectRow.instanceId,
    pathWithNamespace: projectRow.pathWithNamespace,
  }
}

/**
 * The SDK inputs for a run, from the single shared resolver the "what this run
 * will load" preview also uses. Names come back plugin-qualified so a
 * project-scoped copy of a user skill replaces the original instead of loading
 * alongside it.
 */
function resolveRunSkills(projectRow: typeof project.$inferSelect) {
  return resolveSkillContext({
    rows: getDb().select().from(skill).all(),
    skillsDir: resolvePaths().skillsDir,
    project: projectRefOf(projectRow),
  })
}

function settingValue(key: string): string | null {
  return getDb().select().from(setting).where(eq(setting.key, key)).get()?.value ?? null
}

function settingNumber(key: string, fallback: number, min: number, max: number): number {
  return parseBoundedSettingNumber(settingValue(key), fallback, min, max)
}

export function parseBoundedSettingNumber(
  value: string | null | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  if (value === null || value === undefined || value.trim() === '') return fallback
  const parsed = Number(value)
  return Number.isFinite(parsed) ? Math.max(min, Math.min(max, Math.floor(parsed))) : fallback
}

function concurrencyLimit(): number {
  return settingNumber('review.max_concurrent_runs', DEFAULT_CONCURRENCY, 1, MAX_CONCURRENCY)
}

function isSha(value: string): boolean {
  return /^[0-9a-f]{40,64}$/i.test(value)
}

function emitQueuePositions(): void {
  pending.forEach((item, index) => emitRunEvent({
    type: 'run:queued', runId: item.runId, at: Date.now(), position: index + 1,
  }))
}

function emitPhase(runId: string, phase: 'preparing' | 'reviewing' | 'summarizing', message: string): void {
  emitRunEvent({ type: 'run:phase', runId, at: Date.now(), phase, message })
}

function emitToolUse(runId: string, message: SDKMessage): void {
  if (message.type !== 'assistant') return
  for (const block of message.message.content) {
    if (block.type === 'tool_use') emitRunEvent({
      type: 'run:tool', runId, at: Date.now(), tool: block.name, summary: summarizeToolInput(block.input),
    })
  }
}

function emitUsage(runId: string, usage: RunUsage): void {
  emitRunEvent({
    type: 'run:usage',
    runId,
    at: Date.now(),
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    costUsd: usage.costUsd ?? 0,
  })
}

function summarizeToolInput(input: unknown): string {
  if (!input || typeof input !== 'object') return ''
  const entries = Object.entries(input).slice(0, 2).map(([key, value]) => `${key}=${String(value).slice(0, 80)}`)
  return entries.join(' · ')
}

function usageFromResult(message: Extract<SDKMessage, { type: 'result' }>): RunUsage {
  return Object.values(message.modelUsage).reduce<RunUsage>((total, item) => ({
    inputTokens: total.inputTokens + item.inputTokens,
    outputTokens: total.outputTokens + item.outputTokens,
    cacheReadInputTokens: (total.cacheReadInputTokens ?? 0) + item.cacheReadInputTokens,
    cacheCreationInputTokens: (total.cacheCreationInputTokens ?? 0) + item.cacheCreationInputTokens,
    costUsd: (total.costUsd ?? 0) + item.costUSD,
  }), { inputTokens: 0, outputTokens: 0, costUsd: 0 })
}

/**
 * Assistant messages are emitted once per completed content block. Messages
 * from the same model turn share an id and carry progressively newer usage, so
 * retain the largest snapshot for each id instead of counting every block.
 */
export class LiveTokenAccumulator {
  private readonly messages = new Map<string, { inputTokens: number; outputTokens: number }>()
  private inputTokens = 0
  private outputTokens = 0

  update(messageId: string, inputTokens: number, outputTokens: number): {
    inputTokens: number
    outputTokens: number
  } | null {
    const previous = this.messages.get(messageId) ?? { inputTokens: 0, outputTokens: 0 }
    const next = {
      inputTokens: Math.max(previous.inputTokens, finiteTokenCount(inputTokens)),
      outputTokens: Math.max(previous.outputTokens, finiteTokenCount(outputTokens)),
    }
    if (next.inputTokens === previous.inputTokens && next.outputTokens === previous.outputTokens) return null

    this.inputTokens += next.inputTokens - previous.inputTokens
    this.outputTokens += next.outputTokens - previous.outputTokens
    this.messages.set(messageId, next)
    return { inputTokens: this.inputTokens, outputTokens: this.outputTokens }
  }
}

function finiteTokenCount(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0
}

function markCancelled(runId: string): void {
  getDb().update(run).set({ status: 'cancelled', endedAt: new Date() }).where(eq(run.id, runId)).run()
  emitRunEvent({ type: 'run:cancelled', runId, at: Date.now() })
}

function failRunSafely(runId: string, error: unknown): void {
  try {
    const db = getDb()
    const row = db.select().from(run).where(eq(run.id, runId)).get()
    if (!row || row.status === 'cancelled' || row.status === 'failed') return
    const message = error instanceof Error ? error.message : String(error)
    db.update(run).set({ status: 'failed', error: message, endedAt: new Date() }).where(eq(run.id, runId)).run()
    emitRunEvent({ type: 'run:failed', runId, at: Date.now(), error: message })
  } catch (secondary) {
    console.error(`[rivju] failed to finalize review run ${runId}`, secondary)
  }
}

function isCancelled(runId: string): boolean {
  return getDb().select().from(run).where(eq(run.id, runId)).get()?.status === 'cancelled'
}

function abortError(): Error {
  const error = new Error('Review cancelled')
  error.name = 'AbortError'
  return error
}

class JsonlWriter {
  private tail: Promise<void> = Promise.resolve()
  constructor(private readonly filePath: string) {}
  write(value: unknown): void {
    const line = `${JSON.stringify(value)}\n`
    this.tail = this.tail.then(() => appendFile(this.filePath, line, 'utf8'))
  }
  async close(): Promise<void> { await this.tail }
}
