import { and, eq } from 'drizzle-orm'
import type { EffortLevel, ModelInfo } from '@anthropic-ai/claude-agent-sdk'
import { getPreflightState } from '../claude/preflight.ts'
import { getDb } from '../db/client.ts'
import { gitlabInstance, project, setting } from '../db/schema.ts'
import type { ProjectRow } from '../db/schema.ts'

/**
 * The layered model/effort defaults from 00-architecture.md:
 *
 *     global default -> per-project override -> per-run override
 *
 * Resolution lives here (not in the runner) so the settings screen, the launch
 * dialog and the run itself all answer "which model will this use?" the same
 * way. The catalog is always the live/cached `ModelInfo[]` from preflight —
 * never a hardcoded list — and effort options are gated per model.
 */

export const DEFAULT_MODEL_KEY = 'review.default_model'
export const DEFAULT_EFFORT_KEY = 'review.default_effort'

export const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const

export type SelectionSource = 'run' | 'project' | 'global' | 'catalog' | 'none'

export interface ModelSelection {
  model: string
  effort: EffortLevel | null
  modelSource: SelectionSource
  effortSource: SelectionSource
}

export function readSetting(key: string): string | null {
  const value = getDb().select().from(setting).where(eq(setting.key, key)).get()?.value ?? null
  return value === null || value.trim() === '' ? null : value
}

export function writeSetting(key: string, value: string | null): void {
  const db = getDb()
  if (value === null) {
    db.delete(setting).where(eq(setting.key, key)).run()
    return
  }
  db.insert(setting)
    .values({ key, value })
    .onConflictDoUpdate({ target: setting.key, set: { value } })
    .run()
}

export function modelCatalog(): ModelInfo[] {
  const preflight = getPreflightState()
  return preflight.status === 'ok' ? preflight.models : []
}

export function findModel(value: string | null | undefined): ModelInfo | undefined {
  if (!value) return undefined
  return modelCatalog().find((item) => item.value === value || item.resolvedModel === value)
}

export function supportedEfforts(model: ModelInfo | undefined): EffortLevel[] {
  if (!model?.supportsEffort) return []
  return (model.supportedEffortLevels ?? []).filter((level): level is EffortLevel =>
    (EFFORT_LEVELS as readonly string[]).includes(level),
  )
}

export function parseEffort(value: string | null | undefined): EffortLevel | undefined {
  return value && (EFFORT_LEVELS as readonly string[]).includes(value)
    ? (value as EffortLevel)
    : undefined
}

/**
 * Resolve the layers into the pair a run will actually be launched with.
 * Throws when the result is unusable — a review must never silently fall back
 * to a model the user did not choose.
 */
export function resolveModelSelection(input: {
  projectRow?: Pick<ProjectRow, 'modelOverride' | 'effortOverride'> | null
  model?: string
  effort?: EffortLevel
}): ModelSelection {
  const preflight = getPreflightState()
  if (preflight.status !== 'ok') {
    throw new Error('Claude preflight must succeed before a model can be resolved')
  }
  const globalModel = readSetting(DEFAULT_MODEL_KEY)
  const projectModel = input.projectRow?.modelOverride ?? null

  const model = input.model ?? projectModel ?? globalModel ?? preflight.models[0]?.value
  const modelSource: SelectionSource = input.model
    ? 'run'
    : projectModel
      ? 'project'
      : globalModel
        ? 'global'
        : 'catalog'
  const available = findModel(model)
  if (!model || !available) throw new Error('Choose a model reported by the live Claude preflight')

  const projectEffort = parseEffort(input.projectRow?.effortOverride)
  const globalEffort = parseEffort(readSetting(DEFAULT_EFFORT_KEY))
  const effort = input.effort ?? projectEffort ?? globalEffort
  const effortSource: SelectionSource = input.effort
    ? 'run'
    : projectEffort
      ? 'project'
      : globalEffort
        ? 'global'
        : 'none'
  if (effort && !supportedEfforts(available).includes(effort)) {
    throw new Error(`${available.displayName} does not support effort ${effort}`)
  }
  return { model, effort: effort ?? null, modelSource, effortSource }
}

export interface EffectiveSelection {
  model: string | null
  modelDisplayName: string | null
  effort: EffortLevel | null
  modelSource: SelectionSource
  effortSource: SelectionSource
  supportedEfforts: EffortLevel[]
  error: string | null
}

/** Map GitLab coordinates onto rivju's own project id. */
export function findProjectIdByCoordinates(
  instanceId: string | undefined,
  gitlabProjectId: number | undefined,
): string | null {
  if (!instanceId || !gitlabProjectId) return null
  return (
    getDb()
      .select()
      .from(project)
      .where(
        and(eq(project.instanceId, instanceId), eq(project.gitlabProjectId, String(gitlabProjectId))),
      )
      .get()?.id ?? null
  )
}

/** Non-throwing variant for UI surfaces that must render even when broken. */
export function describeEffectiveSelection(projectId?: string | null): EffectiveSelection {
  const projectRow = projectId
    ? (getDb().select().from(project).where(eq(project.id, projectId)).get() ?? null)
    : null
  try {
    const selection = resolveModelSelection({ projectRow })
    return {
      model: selection.model,
      modelDisplayName: findModel(selection.model)?.displayName ?? selection.model,
      effort: selection.effort,
      modelSource: selection.modelSource,
      effortSource: selection.effortSource,
      supportedEfforts: supportedEfforts(findModel(selection.model)),
      error: null,
    }
  } catch (error) {
    return {
      model: null,
      modelDisplayName: null,
      effort: null,
      modelSource: 'none',
      effortSource: 'none',
      supportedEfforts: [],
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

export interface GlobalDefaults {
  model: string | null
  effort: EffortLevel | null
  models: ModelInfo[]
  /** Model used when no default is set — the first entry preflight reported. */
  catalogDefault: string | null
  preflightOk: boolean
}

export function getGlobalDefaults(): GlobalDefaults {
  const models = modelCatalog()
  return {
    model: readSetting(DEFAULT_MODEL_KEY),
    effort: parseEffort(readSetting(DEFAULT_EFFORT_KEY)) ?? null,
    models,
    catalogDefault: models[0]?.value ?? null,
    preflightOk: getPreflightState().status === 'ok',
  }
}

export function setGlobalDefaults(input: {
  model: string | null
  effort: EffortLevel | null
}): GlobalDefaults {
  if (input.model && !findModel(input.model)) {
    throw new Error('That model is not in the catalog reported by the Claude preflight')
  }
  const target = findModel(input.model ?? modelCatalog()[0]?.value)
  if (input.effort && !supportedEfforts(target).includes(input.effort)) {
    throw new Error(`${target?.displayName ?? 'That model'} does not support effort ${input.effort}`)
  }
  writeSetting(DEFAULT_MODEL_KEY, input.model)
  writeSetting(DEFAULT_EFFORT_KEY, input.effort)
  return getGlobalDefaults()
}

export interface ProjectDefaultsRow {
  projectId: string
  instanceId: string
  instanceLabel: string
  pathWithNamespace: string
  modelOverride: string | null
  effortOverride: EffortLevel | null
  effective: EffectiveSelection
}

export function listProjectDefaults(): ProjectDefaultsRow[] {
  return getDb()
    .select({ project, instanceLabel: gitlabInstance.label })
    .from(project)
    .innerJoin(gitlabInstance, eq(project.instanceId, gitlabInstance.id))
    .all()
    .map((row) => ({
      projectId: row.project.id,
      instanceId: row.project.instanceId,
      instanceLabel: row.instanceLabel,
      pathWithNamespace: row.project.pathWithNamespace,
      modelOverride: row.project.modelOverride,
      effortOverride: parseEffort(row.project.effortOverride) ?? null,
      effective: describeEffectiveSelection(row.project.id),
    }))
    .sort(
      (a, b) =>
        a.instanceLabel.localeCompare(b.instanceLabel) ||
        a.pathWithNamespace.localeCompare(b.pathWithNamespace),
    )
}

export function setProjectDefaults(input: {
  projectId: string
  model: string | null
  effort: EffortLevel | null
}): ProjectDefaultsRow {
  const db = getDb()
  const row = db.select().from(project).where(eq(project.id, input.projectId)).get()
  if (!row) throw new Error('Unknown project')
  if (input.model && !findModel(input.model)) {
    throw new Error('That model is not in the catalog reported by the Claude preflight')
  }
  const target = findModel(input.model ?? readSetting(DEFAULT_MODEL_KEY) ?? modelCatalog()[0]?.value)
  if (input.effort && !supportedEfforts(target).includes(input.effort)) {
    throw new Error(`${target?.displayName ?? 'That model'} does not support effort ${input.effort}`)
  }
  db.update(project)
    .set({ modelOverride: input.model, effortOverride: input.effort })
    .where(eq(project.id, input.projectId))
    .run()
  const updated = listProjectDefaults().find((item) => item.projectId === input.projectId)
  if (!updated) throw new Error('Unknown project')
  return updated
}
