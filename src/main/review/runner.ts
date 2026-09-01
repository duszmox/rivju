import { query } from '@anthropic-ai/claude-agent-sdk'
import type { EffortLevel, SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import { and, eq } from 'drizzle-orm'
import { appendFile, mkdir } from 'node:fs/promises'
import path from 'node:path'
import { getPreflightState } from '../claude/preflight.ts'
import { getDb } from '../db/client.ts'
import { gitlabInstance, mergeRequest, project, run, setting, skill } from '../db/schema.ts'
import { emitRunEvent } from '../events/bus.ts'
import { resolvePaths } from '../paths.ts'
import { computeDiff } from '../repo/diff.ts'
import { ensureMirror, fetchMergeRequest } from '../repo/mirror.ts'
import { withRunWorktree } from '../repo/worktree.ts'
import { decryptToken } from '../security/tokens.ts'
import { createReviewMcp } from './mcp.ts'
import { canUseReviewTool } from './permissions.ts'
import { spawnReviewProcess } from './process.ts'
import { composeReviewPrompt, REVIEW_SYSTEM_PROMPT } from './prompt.ts'
import type { RunRow, RunUsage } from '../db/schema.ts'

const DEFAULT_CONCURRENCY = 2
const MAX_CONCURRENCY = 5
const DEFAULT_MAX_TURNS = 40
const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000
const EFFORTS = new Set<EffortLevel>(['low', 'medium', 'high', 'xhigh', 'max'])

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

type QueuedReview = StartReviewInput & { runId: string }
type ReviewQuery = ReturnType<typeof query>
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
  const enabledSkills = resolveEnabledSkills(context.project.id)
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
  pending.push({ ...input, runId })
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
  emitRunEvent({ type: 'run:started', runId: item.runId, at: Date.now(), model: row.model, effort: row.effort })
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
        const preflight = getPreflightState()
        if (preflight.status !== 'ok') throw new Error('Claude preflight is not ready')
        const userPlugin = path.join(paths.skillsDir, 'user')
        const projectPlugin = path.join(
          paths.skillsDir,
          'project',
          context.project.instanceId,
          ...context.project.pathWithNamespace.split('/'),
        )
        const plugins = [{ type: 'local' as const, path: userPlugin, skipMcpDiscovery: true }]
        if (resolveEnabledSkills(context.project.id).some((name) =>
          db.select().from(skill).where(eq(skill.name, name)).all().some((entry) => entry.projectId === context.project.id),
        )) plugins.push({ type: 'local' as const, path: projectPlugin, skipMcpDiscovery: true })

        emitPhase(item.runId, 'reviewing', `Reviewing ${diff.files.length} changed files`)
        const prompt = composeReviewPrompt({
          title: context.mr.title,
          description: context.mr.description,
          labels: item.labels,
          baseSha: item.baseSha,
          headSha: item.headSha,
          files: diff.files,
        })
        log.write({
          type: 'rivju_run_start',
          at: Date.now(),
          runId: item.runId,
          prompt,
          config: {
            baseSha: item.baseSha,
            headSha: item.headSha,
            model: row.model,
            effort: row.effort,
            enabledSkills: row.enabledSkills ?? [],
            cwd: worktreePath,
          },
        })
        const session = query({
          prompt,
          options: {
            cwd: worktreePath,
            pathToClaudeCodeExecutable: preflight.claudePath,
            settingSources: [],
            plugins,
            skills: row.enabledSkills ?? [],
            mcpServers: { rivju: mcp },
            strictMcpConfig: true,
            tools: ['Read', 'Grep', 'Glob', 'Bash', 'Skill'],
            allowedTools: ['Read', 'Grep', 'Glob', 'Bash', 'Skill', 'mcp__rivju__submit_finding', 'mcp__rivju__finish_review'],
            disallowedTools: ['Write', 'Edit', 'WebFetch'],
            canUseTool: canUseReviewTool,
            sandbox: {
              enabled: true,
              failIfUnavailable: true,
              autoAllowBashIfSandboxed: false,
              allowUnsandboxedCommands: false,
              network: { allowedDomains: [], strictAllowlist: true },
            },
            model: row.model ?? undefined,
            effort: parseEffort(row.effort),
            maxTurns: settingNumber('review.max_turns', DEFAULT_MAX_TURNS, 1, 200),
            abortController: activeReview.abort,
            includePartialMessages: true,
            systemPrompt: REVIEW_SYSTEM_PROMPT,
            spawnClaudeCodeProcess: (options) => spawnReviewProcess(
              options,
              activeReview.abort.signal,
              (data) => { log.write({ type: 'rivju_stderr', data, at: Date.now() }) },
            ),
          },
        })
        activeReview.session = session
        const timeoutMs = settingNumber('review.timeout_ms', DEFAULT_TIMEOUT_MS, 10_000, 2 * 60 * 60 * 1000)
        activeReview.timeout = setTimeout(() => {
          activeReview.timedOut = true
          activeReview.abort.abort()
        }, timeoutMs)
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
        if (!completion.finished) throw new Error('Agent ended without calling finish_review')
        if (activeReview.abort.signal.aborted) throw abortError()
        emitPhase(item.runId, 'summarizing', 'Saving review results')
        db.update(run).set({ status: 'done', usage, endedAt: new Date() }).where(eq(run.id, item.runId)).run()
        emitRunEvent({ type: 'run:done', runId: item.runId, at: Date.now(), findingCount })
      },
    )
  } catch (error) {
    if (isCancelled(item.runId)) return
    const message = activeReview.timedOut
      ? 'Review exceeded its wall-clock timeout'
      : error instanceof Error ? error.message : String(error)
    db.update(run).set({ status: 'failed', error: message, endedAt: new Date() }).where(eq(run.id, item.runId)).run()
    emitRunEvent({ type: 'run:failed', runId: item.runId, at: Date.now(), error: message })
  } finally {
    if (activeReview.timeout) clearTimeout(activeReview.timeout)
    activeReview.session?.close()
    await log.close()
  }
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

function resolveSelection(input: StartReviewInput, projectRow: typeof project.$inferSelect) {
  const preflight = getPreflightState()
  if (preflight.status !== 'ok') throw new Error('Claude preflight must succeed before launching a review')
  const globalModel = settingValue('review.default_model')
  const model = input.model ?? projectRow.modelOverride ?? globalModel ?? preflight.models[0]?.value
  const available = preflight.models.find((item) => item.value === model || item.resolvedModel === model)
  if (!model || !available) throw new Error('Choose a model reported by the live Claude preflight')
  const effort = input.effort ?? parseEffort(projectRow.effortOverride ?? settingValue('review.default_effort'))
  if (effort && (!available.supportsEffort || !available.supportedEffortLevels?.includes(effort))) {
    throw new Error(`${available.displayName} does not support effort ${effort}`)
  }
  return { model, effort: effort ?? null }
}

function resolveEnabledSkills(projectId: string): string[] {
  return getDb().select().from(skill).all()
    .filter((row) => row.enabled && (row.scope === 'user' || row.projectId === projectId))
    .sort((a, b) => a.sortOrder - b.sortOrder)
    .map((row) => row.name)
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

function parseEffort(value: string | null | undefined): EffortLevel | undefined {
  return value && EFFORTS.has(value as EffortLevel) ? value as EffortLevel : undefined
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
