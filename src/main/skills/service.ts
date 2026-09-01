import { dialog } from 'electron'
import { and, eq, isNull } from 'drizzle-orm'
import { cp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { getDb } from '../db/client.ts'
import { gitlabInstance, project, skill } from '../db/schema.ts'
import { resolvePaths } from '../paths.ts'
import {
  REJECTION_SKILL_NAME,
  buildRejectionSkill,
  collectProjectRejections,
  validateDistilled,
} from './distill.ts'
import { diffLines } from './diff.ts'
import {
  SKILL_NAME_PATTERN,
  formatSkillDocument,
  parseSkillDocument,
  readSkillDocument,
  slugifySkillName,
} from './frontmatter.ts'
import { copyCheckoutSkill, scanCheckoutSkills } from './import.ts'
import {
  PROJECT_PLUGIN_NAME,
  USER_PLUGIN_NAME,
  ensurePluginDir,
  projectPluginDir,
  skillDirIn,
  skillFileIn,
  userPluginDir,
} from './plugin.ts'
import { resolveSkillContext } from './resolve.ts'
import { isBuiltinSkillName } from './seed.ts'
import type { DiffLine } from './diff.ts'
import type { CheckoutSkill } from './import.ts'
import type { ResolvedSkillEntry, SkillProjectRef } from './resolve.ts'
import type { RivjuDatabase } from '../db/client.ts'
import type { SkillRow, SkillScope } from '../db/schema.ts'

/**
 * Skill management: everything the user can do to a skill that is not
 * launching a run.
 *
 * The hard rule from 00-architecture.md is respected throughout: enabling and
 * disabling only ever writes `skill.enabled` in SQLite. Files are never moved,
 * renamed or deleted to implement a toggle — the SDK `skills` context filter
 * does that job, and the files stay exactly where the user (or an import) put
 * them so the state is reversible and inspectable.
 */

export interface SkillSummary extends ResolvedSkillEntry {
  projectId: string | null
  dirPath: string
  filePath: string
  /** False when the SKILL.md is missing on disk — the row is orphaned. */
  fileExists: boolean
  isBuiltin: boolean
}

export interface SkillProjectSummary {
  id: string
  instanceId: string
  instanceLabel: string
  pathWithNamespace: string
  referenceClonePath: string | null
}

export interface SkillLists {
  project: SkillProjectSummary | null
  user: SkillSummary[]
  projectSkills: SkillSummary[]
  userPluginDir: string
  projectPluginDir: string | null
}

/** Persisted projects, for the scope picker on the skills screen. */
export function listSkillProjects(): SkillProjectSummary[] {
  return getDb()
    .select({ project, instanceLabel: gitlabInstance.label })
    .from(project)
    .innerJoin(gitlabInstance, eq(project.instanceId, gitlabInstance.id))
    .all()
    .map((row) => ({
      id: row.project.id,
      instanceId: row.project.instanceId,
      instanceLabel: row.instanceLabel,
      pathWithNamespace: row.project.pathWithNamespace,
      referenceClonePath: row.project.referenceClonePath,
    }))
    .sort(
      (a, b) =>
        a.instanceLabel.localeCompare(b.instanceLabel) ||
        a.pathWithNamespace.localeCompare(b.pathWithNamespace),
    )
}

export async function listSkills(input: { projectId?: string | null }): Promise<SkillLists> {
  const db = getDb()
  const projectSummary = input.projectId ? findProject(db, input.projectId) : null
  const rows = db.select().from(skill).all()
  const context = resolveSkillContext({
    rows,
    skillsDir: resolvePaths().skillsDir,
    project: projectSummary,
  })
  const rowsById = new Map(rows.map((row) => [row.id, row]))
  const summaries = await Promise.all(
    context.entries.map((entry) => summarize(entry, rowsById.get(entry.id))),
  )
  return {
    project: projectSummary,
    user: summaries.filter((item) => item.scope === 'user'),
    projectSkills: summaries.filter((item) => item.scope === 'project'),
    userPluginDir: context.userPluginDir,
    projectPluginDir: context.projectPluginDir ?? (projectSummary
      ? projectPluginDir(resolvePaths().skillsDir, projectSummary)
      : null),
  }
}

async function summarize(entry: ResolvedSkillEntry, row: SkillRow | undefined): Promise<SkillSummary> {
  const dirPath = row?.dirPath ?? ''
  const filePath = path.join(dirPath, 'SKILL.md')
  return {
    ...entry,
    projectId: row?.projectId ?? null,
    dirPath,
    filePath,
    fileExists: await pathExists(filePath),
    isBuiltin: isBuiltinSkillName(entry.name),
  }
}

export interface SkillSource {
  id: string
  name: string
  scope: SkillScope
  filePath: string
  content: string
  exists: boolean
}

export async function getSkillSource(input: { id: string }): Promise<SkillSource> {
  const row = requireSkill(getDb(), input.id)
  const filePath = skillFilePath(row)
  const exists = await pathExists(filePath)
  return {
    id: row.id,
    name: row.name,
    scope: row.scope,
    filePath,
    exists,
    content: exists
      ? await readFile(filePath, 'utf8')
      : formatSkillDocument({
          frontmatter: { name: row.name, description: row.description ?? 'Describe when this skill applies.' },
          body: '# ' + row.name + '\n\nThe SKILL.md for this skill is missing on disk. Write its instructions here and save to recreate it.',
        }),
  }
}

/**
 * Save an edited SKILL.md. Renaming is refused: the name is the key the SDK
 * filter, the DB row and every historical `run.enabled_skills` array agree on.
 */
export async function saveSkillSource(input: { id: string; content: string }): Promise<SkillSummary> {
  const db = getDb()
  const row = requireSkill(db, input.id)
  const parsed = readSkillDocument(input.content)
  if (!parsed.ok) throw new Error(parsed.issues.join('\n'))
  if (parsed.document.frontmatter.name !== row.name) {
    throw new Error(
      `This skill is registered as \`${row.name}\`. Renaming in the editor is not supported — duplicate it under the new name instead.`,
    )
  }
  const filePath = skillFilePath(row)
  await mkdir(path.dirname(filePath), { recursive: true })
  await writeFile(filePath, formatSkillDocument(parsed.document), 'utf8')
  db.update(skill)
    .set({
      description: parsed.document.frontmatter.description,
      // A built-in the user has edited is theirs; boot must stop overwriting it.
      origin: row.origin === 'builtin' ? 'user' : row.origin,
    })
    .where(eq(skill.id, row.id))
    .run()
  return reloadSummary(row.id)
}

export async function setSkillEnabled(input: { id: string; enabled: boolean }): Promise<SkillSummary> {
  const db = getDb()
  const row = requireSkill(db, input.id)
  db.update(skill).set({ enabled: input.enabled }).where(eq(skill.id, row.id)).run()
  return reloadSummary(row.id)
}

/**
 * Reorder within a scope. Sort orders are renormalised to 0..n-1 first so a
 * list that has drifted (duplicates from seeding, gaps from deletes) always
 * moves by exactly one position.
 */
export async function moveSkill(input: { id: string; direction: 'up' | 'down' }): Promise<SkillSummary> {
  const db = getDb()
  const row = requireSkill(db, input.id)
  const siblings = db
    .select()
    .from(skill)
    .all()
    .filter((item) => item.scope === row.scope && item.projectId === row.projectId)
    .sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name))

  const index = siblings.findIndex((item) => item.id === row.id)
  const target = input.direction === 'up' ? index - 1 : index + 1
  if (index === -1 || target < 0 || target >= siblings.length) return reloadSummary(row.id)
  const reordered = [...siblings]
  const [moved] = reordered.splice(index, 1)
  reordered.splice(target, 0, moved)
  reordered.forEach((item, position) => {
    db.update(skill).set({ sortOrder: position }).where(eq(skill.id, item.id)).run()
  })
  return reloadSummary(row.id)
}

export async function createSkill(input: {
  scope: SkillScope
  projectId?: string | null
  name: string
  description: string
}): Promise<SkillSummary> {
  const db = getDb()
  const name = input.name.trim()
  if (!SKILL_NAME_PATTERN.test(name)) {
    throw new Error('Skill names are lowercase words joined by single hyphens, e.g. "review-security".')
  }
  const target = await resolveTargetPlugin(db, input.scope, input.projectId ?? null)
  assertNameFree(db, input.scope, target.projectId, name)

  const document = {
    frontmatter: { name, description: input.description.trim() || `Review guidance: ${name}.` },
    body: [
      `# ${name}`,
      '',
      'Describe what the reviewer should look for, and — just as important —',
      'what is NOT worth reporting. Be concrete: name the patterns, the files,',
      'and the failure modes you care about.',
    ].join('\n'),
  }
  const dirPath = skillDirIn(target.pluginDir, name)
  await mkdir(dirPath, { recursive: true })
  await writeFile(path.join(dirPath, 'SKILL.md'), formatSkillDocument(document), 'utf8')

  const created = db
    .insert(skill)
    .values({
      scope: input.scope,
      projectId: target.projectId,
      name,
      dirPath,
      description: document.frontmatter.description,
      enabled: true,
      sortOrder: nextSortOrder(db, input.scope, target.projectId),
      origin: 'user',
    })
    .returning()
    .get()
  return reloadSummary(created.id)
}

/**
 * "Duplicate to project": copy a user-level skill into the project's plugin so
 * it can be modified locally. The NAME is preserved on purpose — the resolver
 * shadows the user-scope original with the project copy, so the project sees
 * exactly one version of the skill and other projects are unaffected.
 */
export async function duplicateSkillToProject(input: {
  id: string
  projectId: string
}): Promise<SkillSummary> {
  const db = getDb()
  const source = requireSkill(db, input.id)
  if (source.scope !== 'user') throw new Error('Only user-level skills can be duplicated into a project')
  const target = await resolveTargetPlugin(db, 'project', input.projectId)
  const existing = db
    .select()
    .from(skill)
    .where(and(eq(skill.scope, 'project'), eq(skill.projectId, input.projectId), eq(skill.name, source.name)))
    .get()
  if (existing) throw new Error(`This project already has its own copy of \`${source.name}\`.`)

  const dirPath = skillDirIn(target.pluginDir, source.name)
  await mkdir(path.dirname(dirPath), { recursive: true })
  await rm(dirPath, { recursive: true, force: true })
  const sourceDir = source.dirPath
  if (await pathExists(path.join(sourceDir, 'SKILL.md'))) {
    await cp(sourceDir, dirPath, { recursive: true, dereference: true })
  } else {
    await mkdir(dirPath, { recursive: true })
    await writeFile(
      path.join(dirPath, 'SKILL.md'),
      formatSkillDocument({
        frontmatter: { name: source.name, description: source.description ?? source.name },
        body: `# ${source.name}\n\nThe original SKILL.md was missing on disk; write the project-local instructions here.`,
      }),
      'utf8',
    )
  }

  const created = db
    .insert(skill)
    .values({
      scope: 'project',
      projectId: input.projectId,
      name: source.name,
      dirPath,
      description: source.description,
      enabled: source.enabled,
      sortOrder: nextSortOrder(db, 'project', input.projectId),
      origin: 'user',
    })
    .returning()
    .get()
  return reloadSummary(created.id)
}

export async function deleteSkill(input: { id: string }): Promise<{ deleted: true }> {
  const db = getDb()
  const row = requireSkill(db, input.id)
  if (row.scope === 'user' && isBuiltinSkillName(row.name)) {
    throw new Error(
      'Built-in skills are re-created at startup — switch it off instead of deleting it.',
    )
  }
  db.delete(skill).where(eq(skill.id, row.id)).run()
  if (row.dirPath && row.dirPath.startsWith(resolvePaths().skillsDir)) {
    await rm(row.dirPath, { recursive: true, force: true })
  }
  return { deleted: true }
}

/* ---------------------------------------------------------------- import -- */

export interface ImportCandidate extends CheckoutSkill {
  /** Name already taken in the chosen target scope. */
  conflicts: boolean
}

export interface ImportScan {
  root: string
  skillsDir: string
  exists: boolean
  candidates: ImportCandidate[]
}

export async function chooseImportDirectory(): Promise<string | null> {
  const result = await dialog.showOpenDialog({
    title: 'Choose a checkout containing .claude/skills',
    properties: ['openDirectory'],
  })
  return result.canceled ? null : (result.filePaths[0] ?? null)
}

/**
 * Discover importable skills in a checkout, flagged against the names already
 * registered in the scope the user is importing into.
 */
export async function scanImportableSkills(input: {
  root: string
  scope: SkillScope
  projectId?: string | null
}): Promise<ImportScan> {
  const db = getDb()
  const scan = await scanCheckoutSkills(input.root)
  const taken = new Set(
    db
      .select()
      .from(skill)
      .all()
      .filter((row) =>
        input.scope === 'user'
          ? row.scope === 'user' && row.projectId === null
          : row.scope === 'project' && row.projectId === (input.projectId ?? null),
      )
      .map((row) => row.name),
  )
  return {
    ...scan,
    candidates: scan.candidates.map((candidate) => ({
      ...candidate,
      conflicts: candidate.name !== null && taken.has(candidate.name),
    })),
  }
}

export interface ImportResult {
  imported: Array<{ requested: string; name: string; renamed: boolean }>
  failed: Array<{ requested: string; reason: string }>
}

export async function importSkills(input: {
  root: string
  directories: string[]
  scope: SkillScope
  projectId?: string | null
}): Promise<ImportResult> {
  const db = getDb()
  const scan = await scanImportableSkills({ root: input.root, scope: input.scope, projectId: input.projectId })
  const target = await resolveTargetPlugin(db, input.scope, input.projectId ?? null)
  const result: ImportResult = { imported: [], failed: [] }

  for (const directory of input.directories) {
    const candidate = scan.candidates.find((item) => item.directory === directory)
    if (!candidate) {
      result.failed.push({ requested: directory, reason: 'No longer present in the checkout' })
      continue
    }
    if (candidate.issues.includes('No SKILL.md in this directory.')) {
      result.failed.push({ requested: directory, reason: 'There is no SKILL.md to import' })
      continue
    }
    const base = candidate.name ?? slugifySkillName(candidate.directory)
    if (!base) {
      result.failed.push({ requested: directory, reason: 'Cannot derive a valid skill name' })
      continue
    }
    try {
      const name = uniqueName(db, input.scope, target.projectId, base)
      const dirPath = skillDirIn(target.pluginDir, name)
      const description = await copyCheckoutSkill({
        realPath: candidate.realPath,
        destDir: dirPath,
        name,
        fallbackDescription: candidate.description,
      })
      db.insert(skill)
        .values({
          scope: input.scope,
          projectId: target.projectId,
          name,
          dirPath,
          description,
          enabled: false,
          sortOrder: nextSortOrder(db, input.scope, target.projectId),
          origin: 'imported',
        })
        .run()
      result.imported.push({ requested: directory, name, renamed: name !== base })
    } catch (error) {
      result.failed.push({
        requested: directory,
        reason: error instanceof Error ? error.message : String(error),
      })
    }
  }
  return result
}

/* ------------------------------------------------------------- distilled -- */

export interface DistillPreview {
  projectId: string
  skillName: string
  filePath: string
  skillExists: boolean
  existingContent: string
  proposedContent: string
  diff: DiffLine[]
  changed: boolean
  totalRejections: number
  newEntries: number
  alreadyPresent: number
  blockingIssues: string[]
}

export async function previewRejectionDistillation(input: {
  projectId: string
}): Promise<DistillPreview> {
  const db = getDb()
  const projectRef = findProject(db, input.projectId)
  const existingRow = db
    .select()
    .from(skill)
    .where(
      and(
        eq(skill.scope, 'project'),
        eq(skill.projectId, input.projectId),
        eq(skill.name, REJECTION_SKILL_NAME),
      ),
    )
    .get()
  const pluginDir = projectPluginDir(resolvePaths().skillsDir, projectRef)
  const filePath = existingRow ? skillFilePath(existingRow) : skillFileIn(pluginDir, REJECTION_SKILL_NAME)
  const existingContent = (await readFile(filePath, 'utf8').catch(() => null)) ?? ''
  const blockingIssues = existingContent ? validateDistilled(existingContent) : []

  const rejections = collectProjectRejections(db, input.projectId)
  const built = buildRejectionSkill({
    projectPath: projectRef.pathWithNamespace,
    existing: existingContent === '' ? null : existingContent,
    rejections,
  })
  const diff = diffLines(existingContent, built.content)
  return {
    projectId: input.projectId,
    skillName: REJECTION_SKILL_NAME,
    filePath,
    skillExists: Boolean(existingRow) && existingContent !== '',
    existingContent,
    proposedContent: built.content,
    diff,
    // Distillation only ever appends, so "there is a change" means "there is a
    // new entry" — not "the file would be recreated with just its header".
    changed: built.appended.length > 0,
    totalRejections: rejections.length,
    newEntries: built.appended.length,
    alreadyPresent: built.skipped.length,
    blockingIssues,
  }
}

export async function applyRejectionDistillation(input: {
  projectId: string
}): Promise<{ skillId: string; written: number }> {
  const db = getDb()
  const preview = await previewRejectionDistillation(input)
  if (preview.blockingIssues.length > 0) throw new Error(preview.blockingIssues.join('\n'))
  if (!preview.changed) throw new Error('There is nothing new to distil — every rejection is already in the file.')

  await resolveTargetPlugin(db, 'project', input.projectId)
  // Write to exactly the path the preview read from, so what the user approved
  // in the diff is what lands on disk even if the project's plugin directory
  // has moved since the row was written.
  const dirPath = path.dirname(preview.filePath)
  await mkdir(dirPath, { recursive: true })
  await writeFile(preview.filePath, preview.proposedContent, 'utf8')

  const description = parseSkillDocument(preview.proposedContent).frontmatter.description
  const existing = db
    .select()
    .from(skill)
    .where(
      and(
        eq(skill.scope, 'project'),
        eq(skill.projectId, input.projectId),
        eq(skill.name, REJECTION_SKILL_NAME),
      ),
    )
    .get()
  if (existing) {
    db.update(skill).set({ dirPath, description }).where(eq(skill.id, existing.id)).run()
    return { skillId: existing.id, written: preview.newEntries }
  }
  const created = db
    .insert(skill)
    .values({
      scope: 'project',
      projectId: input.projectId,
      name: REJECTION_SKILL_NAME,
      dirPath,
      description,
      enabled: true,
      sortOrder: nextSortOrder(db, 'project', input.projectId),
      origin: 'user',
    })
    .returning()
    .get()
  return { skillId: created.id, written: preview.newEntries }
}

/* --------------------------------------------------------------- helpers -- */

/**
 * Ensure the plugin directory that backs a scope exists before anything is
 * written into it, and hand back the projectId the row must carry.
 */
async function resolveTargetPlugin(
  db: RivjuDatabase,
  scope: SkillScope,
  projectId: string | null,
): Promise<{ pluginDir: string; projectId: string | null }> {
  const skillsDir = resolvePaths().skillsDir
  if (scope === 'user') {
    const dir = userPluginDir(skillsDir)
    await ensurePluginDir({ name: USER_PLUGIN_NAME, dir }, 'Review skills managed by rivju (user scope)')
    return { pluginDir: dir, projectId: null }
  }
  if (!projectId) throw new Error('Choose a project before adding a project-level skill')
  const projectRef = findProject(db, projectId)
  const dir = projectPluginDir(skillsDir, projectRef)
  await ensurePluginDir(
    { name: PROJECT_PLUGIN_NAME, dir },
    `Review skills managed by rivju for ${projectRef.pathWithNamespace}`,
  )
  return { pluginDir: dir, projectId }
}

/** Ensure every plugin directory a run will reference exists on disk. */
export async function ensureRunPluginDirs(projectRef: SkillProjectRef | null): Promise<void> {
  const db = getDb()
  await resolveTargetPlugin(db, 'user', null)
  if (projectRef) await resolveTargetPlugin(db, 'project', projectRef.id)
}

function findProject(db: RivjuDatabase, projectId: string): SkillProjectSummary {
  const row = db
    .select({ project, instanceLabel: gitlabInstance.label })
    .from(project)
    .innerJoin(gitlabInstance, eq(project.instanceId, gitlabInstance.id))
    .where(eq(project.id, projectId))
    .get()
  if (!row) throw new Error('Unknown project')
  return {
    id: row.project.id,
    instanceId: row.project.instanceId,
    instanceLabel: row.instanceLabel,
    pathWithNamespace: row.project.pathWithNamespace,
    referenceClonePath: row.project.referenceClonePath,
  }
}

function requireSkill(db: RivjuDatabase, id: string): SkillRow {
  const row = db.select().from(skill).where(eq(skill.id, id)).get()
  if (!row) throw new Error('Unknown skill')
  return row
}

function skillFilePath(row: SkillRow): string {
  return path.join(row.dirPath, 'SKILL.md')
}

/**
 * The `skill_scope_name_uq` index cannot enforce this for user-scope rows —
 * SQLite treats every NULL `project_id` as distinct — so uniqueness is
 * enforced here, in the single module that writes skill rows.
 */
function assertNameFree(
  db: RivjuDatabase,
  scope: SkillScope,
  projectId: string | null,
  name: string,
): void {
  if (findByName(db, scope, projectId, name)) {
    throw new Error(`A ${scope}-level skill named \`${name}\` already exists.`)
  }
}

function findByName(
  db: RivjuDatabase,
  scope: SkillScope,
  projectId: string | null,
  name: string,
): SkillRow | undefined {
  return db
    .select()
    .from(skill)
    .where(
      and(
        eq(skill.scope, scope),
        projectId === null ? isNull(skill.projectId) : eq(skill.projectId, projectId),
        eq(skill.name, name),
      ),
    )
    .get()
}

function uniqueName(
  db: RivjuDatabase,
  scope: SkillScope,
  projectId: string | null,
  base: string,
): string {
  if (!findByName(db, scope, projectId, base)) return base
  for (let suffix = 2; suffix < 100; suffix++) {
    const candidate = `${base}-${suffix}`.slice(0, 64).replace(/-+$/, '')
    if (!findByName(db, scope, projectId, candidate)) return candidate
  }
  throw new Error(`Too many skills named like \`${base}\``)
}

function nextSortOrder(db: RivjuDatabase, scope: SkillScope, projectId: string | null): number {
  const orders = db
    .select()
    .from(skill)
    .all()
    .filter((row) => row.scope === scope && row.projectId === projectId)
    .map((row) => row.sortOrder)
  return orders.length === 0 ? 0 : Math.max(...orders) + 1
}

async function reloadSummary(id: string): Promise<SkillSummary> {
  const row = requireSkill(getDb(), id)
  const lists = await listSkills({ projectId: row.projectId })
  const found = [...lists.user, ...lists.projectSkills].find((item) => item.id === id)
  if (!found) throw new Error('Skill disappeared while saving')
  return found
}

async function pathExists(target: string): Promise<boolean> {
  return stat(target)
    .then(() => true)
    .catch(() => false)
}
