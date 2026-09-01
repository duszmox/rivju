import { query } from '@anthropic-ai/claude-agent-sdk'
import { eq } from 'drizzle-orm'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { z } from 'zod'
import { getPreflightState } from '../claude/preflight.ts'
import { getDb } from '../db/client.ts'
import { gitlabInstance, project, skill } from '../db/schema.ts'
import { resolvePaths } from '../paths.ts'
import { describeEffectiveSelection } from '../settings/service.ts'
import { PROJECT_PLUGIN_NAME, USER_PLUGIN_NAME } from './plugin.ts'
import { resolveSkillContext } from './resolve.ts'
import { ensureRunPluginDirs } from './service.ts'
import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import type { EffectiveSelection } from '../settings/service.ts'
import type { ResolvedSkillEntry, SkillProjectRef } from './resolve.ts'

/**
 * "What this run will load", answered by the SDK rather than by us.
 *
 * The phase brief is emphatic that this must reflect what the SDK actually
 * reports. So the preview opens a real session with the exact options the next
 * run would use and asks it: `getContextUsage()` returns the skills that were
 * loaded into the system prompt, with their canonical `plugin:skill` names,
 * their source, and their token cost.
 *
 * Why that call and not the `system/init` message: init reports every skill it
 * DISCOVERED (including Claude Code's own bundled skills), not the subset the
 * `skills` filter admitted. Context usage reports the subset — verified
 * against claude 2.1.241, where `skills: ['alpha']` yields
 * `includedSkills: 1` out of `totalSkills: 14`.
 *
 * The probe is driven by a streaming prompt that never yields a message, so
 * the session initialises and is torn down without a single model turn: zero
 * tokens, no cost.
 */

const PROBE_TIMEOUT_MS = 60_000

const contextUsageSkillsSchema = z.object({
  totalSkills: z.number(),
  includedSkills: z.number(),
  tokens: z.number(),
  skillFrontmatter: z.array(
    z.object({
      name: z.string(),
      source: z.string(),
      pluginName: z.string().optional(),
      tokens: z.number(),
    }),
  ),
})

export interface LoadedSkill {
  name: string
  source: string
  pluginName: string | null
  tokens: number
}

export interface SkillProbe {
  /** Skills the CLI discovered across every plugin, including its bundled ones. */
  totalSkills: number
  /** Skills the `skills` filter actually admitted into the system prompt. */
  includedSkills: number
  tokens: number
  loaded: LoadedSkill[]
}

export interface RunContextPreview {
  project: { id: string; pathWithNamespace: string; instanceLabel: string } | null
  requested: {
    skills: string[]
    plugins: Array<{ name: string; path: string }>
    settingSources: string[]
  }
  entries: ResolvedSkillEntry[]
  selection: EffectiveSelection
  probe: SkillProbe | null
  probeError: string | null
  /** Requested but not reported as loaded — a broken or misnamed skill. */
  missing: string[]
  /** Reported as loaded but not requested — a leak we would want to know about. */
  unexpected: string[]
  probedAt: number
}

let queue: Promise<unknown> = Promise.resolve()

export async function previewRunContext(input: {
  projectId?: string | null
}): Promise<RunContextPreview> {
  // Serialised: every probe spawns a claude process, and the panel is easy to
  // re-trigger by switching projects or toggling a skill.
  const next = queue.catch(() => undefined).then(() => buildPreview(input))
  queue = next.catch(() => undefined)
  return next
}

async function buildPreview(input: { projectId?: string | null }): Promise<RunContextPreview> {
  const db = getDb()
  const projectRow = input.projectId
    ? db
        .select({ project, instanceLabel: gitlabInstance.label })
        .from(project)
        .innerJoin(gitlabInstance, eq(project.instanceId, gitlabInstance.id))
        .where(eq(project.id, input.projectId))
        .get()
    : undefined
  const projectRef: SkillProjectRef | null = projectRow
    ? {
        id: projectRow.project.id,
        instanceId: projectRow.project.instanceId,
        pathWithNamespace: projectRow.project.pathWithNamespace,
      }
    : null

  await ensureRunPluginDirs(projectRef)
  const context = resolveSkillContext({
    rows: db.select().from(skill).all(),
    skillsDir: resolvePaths().skillsDir,
    project: projectRef,
  })
  const selection = describeEffectiveSelection(input.projectId ?? null)

  const requested = {
    skills: context.skills,
    plugins: context.plugins.map((plugin) => ({
      name: plugin.path === context.userPluginDir ? USER_PLUGIN_NAME : PROJECT_PLUGIN_NAME,
      path: plugin.path,
    })),
    settingSources: context.settingSources as string[],
  }

  const base: RunContextPreview = {
    project: projectRow
      ? {
          id: projectRow.project.id,
          pathWithNamespace: projectRow.project.pathWithNamespace,
          instanceLabel: projectRow.instanceLabel,
        }
      : null,
    requested,
    entries: context.entries,
    selection,
    probe: null,
    probeError: null,
    missing: [],
    unexpected: [],
    probedAt: Date.now(),
  }

  const preflight = getPreflightState()
  if (preflight.status !== 'ok') {
    return { ...base, probeError: 'Claude preflight has not succeeded, so the SDK cannot be asked.' }
  }

  try {
    const probe = await probeSkillContext({
      claudePath: preflight.claudePath,
      plugins: context.plugins,
      skills: context.skills,
      model: selection.model ?? undefined,
    })
    const loadedNames = new Set(probe.loaded.map((item) => item.name))
    const requestedNames = new Set(context.skills)
    return {
      ...base,
      probe,
      missing: context.skills.filter((name) => !loadedNames.has(name)),
      unexpected: probe.loaded.map((item) => item.name).filter((name) => !requestedNames.has(name)),
      probedAt: Date.now(),
    }
  } catch (error) {
    return {
      ...base,
      probeError: error instanceof Error ? error.message : String(error),
      probedAt: Date.now(),
    }
  }
}

async function probeSkillContext(input: {
  claudePath: string
  plugins: Array<{ type: 'local'; path: string; skipMcpDiscovery: true }>
  skills: string[]
  model?: string
}): Promise<SkillProbe> {
  const abort = new AbortController()
  const timer = setTimeout(() => abort.abort(), PROBE_TIMEOUT_MS)
  const cwd = await mkdtemp(path.join(tmpdir(), 'rivju-skill-probe-'))
  const session = query({
    prompt: idlePrompt(abort.signal),
    options: {
      cwd,
      pathToClaudeCodeExecutable: input.claudePath,
      settingSources: [],
      plugins: input.plugins,
      skills: input.skills,
      allowedTools: [],
      model: input.model,
      abortController: abort,
    },
  })
  try {
    await session.initializationResult()
    const usage = await session.getContextUsage()
    // Omitted entirely when the filter admitted nothing — that is a valid
    // answer ("this run loads no skills"), not a failure.
    if (!usage.skills) return { totalSkills: 0, includedSkills: 0, tokens: 0, loaded: [] }
    const parsed = contextUsageSkillsSchema.parse(usage.skills)
    return {
      totalSkills: parsed.totalSkills,
      includedSkills: parsed.includedSkills,
      tokens: parsed.tokens,
      loaded: parsed.skillFrontmatter.map((item) => ({
        name: item.name,
        source: item.source,
        pluginName: item.pluginName ?? null,
        tokens: item.tokens,
      })),
    }
  } finally {
    clearTimeout(timer)
    abort.abort()
    session.close()
    await rm(cwd, { recursive: true, force: true }).catch(() => undefined)
  }
}

/**
 * A prompt stream that never yields a message and ends when the probe is torn
 * down. Keeping the session turn-less is what makes the preview free: the CLI
 * initialises, answers the context-usage query, and exits without ever calling
 * the model.
 */
function idlePrompt(signal: AbortSignal): AsyncIterable<SDKUserMessage> {
  return {
    [Symbol.asyncIterator]: () => ({
      next: async (): Promise<IteratorResult<SDKUserMessage>> => {
        await new Promise<void>((resolve) => {
          if (signal.aborted) {
            resolve()
            return
          }
          signal.addEventListener('abort', () => resolve(), { once: true })
        })
        return { done: true, value: undefined }
      },
    }),
  }
}
