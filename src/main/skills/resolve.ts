import {
  PROJECT_PLUGIN_NAME,
  USER_PLUGIN_NAME,
  projectPluginDir,
  qualifiedSkillName,
  userPluginDir,
} from './plugin.ts'
import { SKILL_NAME_PATTERN } from './frontmatter.ts'
import type { SkillOrigin, SkillRow, SkillScope } from '../db/schema.ts'

/**
 * Turns rivju's SQLite skill state into the exact SDK inputs for one run.
 *
 * This is the ONLY place that decides what a run loads. The runner and the
 * "what this run will load" preview both call it, which is what makes the
 * preview trustworthy — if they computed it separately the preview would be a
 * second guess rather than the truth.
 *
 * Two behaviours are load-bearing, both verified against claude 2.1.241:
 *
 * 1. Names are emitted PLUGIN-QUALIFIED (`rivju-user-skills:review-security`).
 *    A bare name matches every plugin that defines it, so a project-scoped
 *    copy of a user skill would silently enable the original too.
 * 2. A project-scoped skill SHADOWS the user-scoped skill of the same name.
 *    "Duplicate to project" exists so a project can modify a shared skill
 *    locally; loading both copies would double the instructions.
 */

export interface ResolvedSkillEntry {
  id: string
  name: string
  qualifiedName: string
  scope: SkillScope
  origin: SkillOrigin
  description: string | null
  sortOrder: number
  enabled: boolean
  /** Qualified name of the project skill that replaces this user skill. */
  shadowedBy: string | null
  /** True when this skill's qualified name is in the SDK `skills` array. */
  active: boolean
}

export interface SkillProjectRef {
  id: string
  instanceId: string
  pathWithNamespace: string
}

export interface ResolvedSkillContext {
  /** SDK `skills` option — the context filter. Empty means "load nothing". */
  skills: string[]
  /** SDK `plugins` option. */
  plugins: Array<{ type: 'local'; path: string; skipMcpDiscovery: true }>
  /** SDK `settingSources` — always empty, so the user's ~/.claude never leaks in. */
  settingSources: []
  entries: ResolvedSkillEntry[]
  userPluginDir: string
  projectPluginDir: string | null
}

export function resolveSkillContext(input: {
  rows: SkillRow[]
  skillsDir: string
  project: SkillProjectRef | null
}): ResolvedSkillContext {
  const userDir = userPluginDir(input.skillsDir)
  const projectDir = input.project ? projectPluginDir(input.skillsDir, input.project) : null

  const userRows = sortRows(
    input.rows.filter((row) => row.scope === 'user' && row.projectId === null && isUsable(row)),
  )
  const projectRows = input.project
    ? sortRows(
        input.rows.filter(
          (row) => row.scope === 'project' && row.projectId === input.project?.id && isUsable(row),
        ),
      )
    : []

  const projectNames = new Map(projectRows.map((row) => [row.name, row]))
  const entries: ResolvedSkillEntry[] = []

  for (const row of userRows) {
    const shadow = projectNames.get(row.name)
    entries.push({
      ...describe(row, USER_PLUGIN_NAME),
      shadowedBy: shadow ? qualifiedSkillName(PROJECT_PLUGIN_NAME, shadow.name) : null,
      active: row.enabled && !shadow,
    })
  }
  for (const row of projectRows) {
    entries.push({ ...describe(row, PROJECT_PLUGIN_NAME), shadowedBy: null, active: row.enabled })
  }

  const plugins: ResolvedSkillContext['plugins'] = [
    { type: 'local', path: userDir, skipMcpDiscovery: true },
  ]
  // Only hand the SDK a project plugin that has something in it: a `local`
  // plugin path that does not exist aborts the whole session.
  if (projectDir && projectRows.length > 0) {
    plugins.push({ type: 'local', path: projectDir, skipMcpDiscovery: true })
  }

  return {
    skills: entries.filter((entry) => entry.active).map((entry) => entry.qualifiedName),
    plugins,
    settingSources: [],
    entries,
    userPluginDir: userDir,
    projectPluginDir: projectRows.length > 0 ? projectDir : null,
  }
}

function describe(row: SkillRow, pluginName: string): Omit<ResolvedSkillEntry, 'shadowedBy' | 'active'> {
  return {
    id: row.id,
    name: row.name,
    qualifiedName: qualifiedSkillName(pluginName, row.name),
    scope: row.scope,
    origin: row.origin,
    description: row.description,
    sortOrder: row.sortOrder,
    enabled: row.enabled,
  }
}

function sortRows(rows: SkillRow[]): SkillRow[] {
  return [...rows].sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name))
}

/** A row whose name the CLI could never resolve is dead weight — skip it. */
function isUsable(row: SkillRow): boolean {
  return SKILL_NAME_PATTERN.test(row.name)
}
