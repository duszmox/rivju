import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { closeDatabase, openDatabase } from '../db/client.ts'
import { applyMigrations } from '../db/migrate.ts'
import { finding, gitlabInstance, mergeRequest, project } from '../db/schema.ts'
import { diffLines, hasChanges } from './diff.ts'
import {
  REJECTION_SKILL_NAME,
  buildRejectionSkill,
  collectProjectRejections,
  validateDistilled,
} from './distill.ts'
import { formatSkillDocument, readSkillDocument } from './frontmatter.ts'
import { copyCheckoutSkill, scanCheckoutSkills } from './import.ts'
import { resolveSkillContext } from './resolve.ts'
import type { RivjuDatabase } from '../db/client.ts'
import type { SkillRow } from '../db/schema.ts'

const migrationsDir = fileURLToPath(new URL('../../../drizzle', import.meta.url))

describe('SKILL.md frontmatter', () => {
  it('parses the standard keys and separates the body', () => {
    const parsed = readSkillDocument('---\nname: review-security\ndescription: Find holes.\n---\n\nBody line.\n')
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.document.frontmatter).toEqual({
      name: 'review-security',
      description: 'Find holes.',
    })
    expect(parsed.document.body).toBe('Body line.\n')
  })

  it('rejects non-standard keys — rivju state belongs in SQLite', () => {
    const parsed = readSkillDocument('---\nname: a-skill\ndescription: d\nenabled: true\n---\n\nBody\n')
    expect(parsed.ok).toBe(false)
    if (parsed.ok) return
    expect(parsed.issues.join('\n')).toContain('`enabled` is not a standard skill key')
  })

  it('rejects a name the SDK filter could never resolve', () => {
    const parsed = readSkillDocument('---\nname: Review Security\ndescription: d\n---\n\nBody\n')
    expect(parsed.ok).toBe(false)
    if (parsed.ok) return
    expect(parsed.issues.join('\n')).toContain('lowercase letters')
  })

  it('reports an unterminated frontmatter block instead of guessing', () => {
    const parsed = readSkillDocument('---\nname: a-skill\ndescription: d\n\nBody\n')
    expect(parsed.ok).toBe(false)
    if (parsed.ok) return
    expect(parsed.issues[0]).toContain('never closed')
  })

  it('rejects an empty body — a skill with no instructions is a no-op', () => {
    const parsed = readSkillDocument('---\nname: a-skill\ndescription: d\n---\n')
    expect(parsed.ok).toBe(false)
  })

  it('round-trips a description containing a colon by quoting it', () => {
    const source = formatSkillDocument({
      frontmatter: { name: 'a-skill', description: 'Rule: never report style nits.' },
      body: 'Body',
    })
    expect(source).toContain('description: "Rule: never report style nits."')
    const parsed = readSkillDocument(source)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.document.frontmatter.description).toBe('Rule: never report style nits.')
  })

  it('leaves an ordinary description unquoted', () => {
    const source = formatSkillDocument({
      frontmatter: { name: 'a-skill', description: 'Find correctness bugs.' },
      body: 'Body',
    })
    expect(source).toContain('description: Find correctness bugs.')
  })
})

describe('run skill resolution', () => {
  const skillsDir = '/data/skills'
  const projectRef = { id: 'p1', instanceId: 'i1', pathWithNamespace: 'group/app' }

  const row = (over: Partial<SkillRow> & Pick<SkillRow, 'id' | 'name'>): SkillRow => ({
    scope: 'user',
    projectId: null,
    dirPath: `/data/skills/user/skills/${over.name}`,
    description: null,
    enabled: true,
    sortOrder: 0,
    origin: 'user',
    ...over,
  })

  it('emits plugin-qualified names in sort order', () => {
    const context = resolveSkillContext({
      rows: [
        row({ id: '1', name: 'b-skill', sortOrder: 1 }),
        row({ id: '2', name: 'a-skill', sortOrder: 0 }),
      ],
      skillsDir,
      project: projectRef,
    })
    expect(context.skills).toEqual([
      'rivju-user-skills:a-skill',
      'rivju-user-skills:b-skill',
    ])
  })

  it('omits disabled skills from the SDK filter but keeps them in the listing', () => {
    const context = resolveSkillContext({
      rows: [
        row({ id: '1', name: 'on-skill' }),
        row({ id: '2', name: 'off-skill', enabled: false, sortOrder: 1 }),
      ],
      skillsDir,
      project: projectRef,
    })
    expect(context.skills).toEqual(['rivju-user-skills:on-skill'])
    expect(context.entries.map((entry) => entry.name)).toEqual(['on-skill', 'off-skill'])
  })

  it('lets a project copy shadow the user skill of the same name', () => {
    const context = resolveSkillContext({
      rows: [
        row({ id: '1', name: 'review-security' }),
        row({ id: '2', name: 'review-correctness', sortOrder: 1 }),
        row({ id: '3', name: 'review-security', scope: 'project', projectId: 'p1' }),
      ],
      skillsDir,
      project: projectRef,
    })
    expect(context.skills).toEqual([
      'rivju-user-skills:review-correctness',
      'rivju-project-skills:review-security',
    ])
    const shadowed = context.entries.find((entry) => entry.scope === 'user' && entry.name === 'review-security')
    expect(shadowed?.active).toBe(false)
    expect(shadowed?.shadowedBy).toBe('rivju-project-skills:review-security')
  })

  it('ignores skills belonging to a different project', () => {
    const context = resolveSkillContext({
      rows: [row({ id: '1', name: 'other-only', scope: 'project', projectId: 'p2' })],
      skillsDir,
      project: projectRef,
    })
    expect(context.skills).toEqual([])
    expect(context.plugins).toHaveLength(1)
  })

  it('only hands the SDK a project plugin that exists', () => {
    const bare = resolveSkillContext({ rows: [], skillsDir, project: projectRef })
    expect(bare.plugins.map((plugin) => plugin.path)).toEqual(['/data/skills/user'])

    const withProject = resolveSkillContext({
      rows: [row({ id: '1', name: 'local-rule', scope: 'project', projectId: 'p1' })],
      skillsDir,
      project: projectRef,
    })
    expect(withProject.plugins.map((plugin) => plugin.path)).toEqual([
      '/data/skills/user',
      path.join('/data/skills/project/i1/group/app'),
    ])
  })

  it('never leaks the user settings sources', () => {
    expect(resolveSkillContext({ rows: [], skillsDir, project: null }).settingSources).toEqual([])
  })
})

describe('line diff', () => {
  it('reports appended lines and collapses untouched context', () => {
    const before = Array.from({ length: 30 }, (_, index) => `line ${index}`).join('\n')
    const after = `${before}\nnew one\nnew two`
    const lines = diffLines(before, after)
    expect(hasChanges(lines)).toBe(true)
    expect(lines.filter((line) => line.kind === 'add').map((line) => line.text)).toEqual([
      'new one',
      'new two',
    ])
    expect(lines.some((line) => line.kind === 'gap')).toBe(true)
  })

  it('reports no changes for identical content', () => {
    expect(hasChanges(diffLines('a\nb\n', 'a\nb\n'))).toBe(false)
  })
})

describe('rejection distillation', () => {
  const rejection = (over: Partial<Parameters<typeof buildRejectionSkill>[0]['rejections'][number]>) => ({
    fingerprint: 'a'.repeat(64),
    filePath: 'src/app.ts',
    category: 'correctness',
    title: 'Off-by-one in the retry loop',
    note: 'The bound is enforced by the caller.',
    ...over,
  })

  it('creates a valid, human-readable skill on the first run', () => {
    const built = buildRejectionSkill({
      projectPath: 'group/app',
      existing: null,
      rejections: [rejection({})],
    })
    expect(validateDistilled(built.content)).toEqual([])
    const parsed = readSkillDocument(built.content)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.document.frontmatter.name).toBe(REJECTION_SKILL_NAME)
    expect(built.content).toContain('### `src/app.ts` · correctness')
    expect(built.content).toContain('Do not report: **Off-by-one in the retry loop**')
    expect(built.content).toContain('> The bound is enforced by the caller.')
    expect(built.appended).toHaveLength(1)
  })

  it('appends without touching anything the human wrote', () => {
    const first = buildRejectionSkill({
      projectPath: 'group/app',
      existing: null,
      rejections: [rejection({})],
    })
    const edited = first.content.replace(
      '> The bound is enforced by the caller.',
      '> Rewritten by hand: the caller owns the bound, and always will.',
    )
    const second = buildRejectionSkill({
      projectPath: 'group/app',
      existing: edited,
      rejections: [rejection({}), rejection({ fingerprint: 'b'.repeat(64), title: 'Unused import' })],
    })
    expect(second.appended.map((item) => item.title)).toEqual(['Unused import'])
    expect(second.skipped).toHaveLength(1)
    expect(second.content).toContain('Rewritten by hand: the caller owns the bound')
    expect(second.content).toContain('Do not report: **Unused import**')
    expect(validateDistilled(second.content)).toEqual([])
  })

  it('is a no-op when every rejection is already distilled', () => {
    const first = buildRejectionSkill({ projectPath: 'g/a', existing: null, rejections: [rejection({})] })
    const second = buildRejectionSkill({
      projectPath: 'g/a',
      existing: first.content,
      rejections: [rejection({})],
    })
    expect(second.content).toBe(first.content)
    expect(hasChanges(diffLines(first.content, second.content))).toBe(false)
  })

  it('regenerates an entry whose marker the human deleted', () => {
    const first = buildRejectionSkill({ projectPath: 'g/a', existing: null, rejections: [rejection({})] })
    const stripped = first.content.replace(/<!-- rivju:rejection [0-9a-f]+ -->\n/, '')
    const second = buildRejectionSkill({
      projectPath: 'g/a',
      existing: stripped,
      rejections: [rejection({})],
    })
    expect(second.appended).toHaveLength(1)
  })

  it('groups global findings under a heading that is not a fake file path', () => {
    const built = buildRejectionSkill({
      projectPath: 'g/a',
      existing: null,
      rejections: [rejection({ filePath: null, category: null, note: null })],
    })
    expect(built.content).toContain('### Repository-wide')
    expect(built.content).toContain('> The reviewer dismissed this without a note.')
  })
})

describe('rejection collection', () => {
  let db: RivjuDatabase
  let root: string
  let projectId: string

  beforeAll(() => {
    root = mkdtempSync(path.join(tmpdir(), 'rivju-skills-test-'))
    db = openDatabase(path.join(root, 'test.db'))
    applyMigrations(db, migrationsDir)

    const instance = db
      .insert(gitlabInstance)
      .values({ label: 'gl', baseUrl: 'https://gl.test', tokenCiphertext: 'x' })
      .returning()
      .get()
    const mine = db
      .insert(project)
      .values({
        instanceId: instance.id,
        gitlabProjectId: '1',
        pathWithNamespace: 'group/app',
        name: 'app',
      })
      .returning()
      .get()
    const other = db
      .insert(project)
      .values({
        instanceId: instance.id,
        gitlabProjectId: '2',
        pathWithNamespace: 'group/other',
        name: 'other',
      })
      .returning()
      .get()
    const mr = (owner: string, iid: number) =>
      db
        .insert(mergeRequest)
        .values({
          projectId: owner,
          iid,
          title: `mr ${iid}`,
          sourceBranch: 'a',
          targetBranch: 'b',
          state: 'opened',
          webUrl: 'https://gl.test/mr',
        })
        .returning()
        .get()
    const mineMr = mr(mine.id, 1)
    const otherMr = mr(other.id, 2)

    db.insert(finding)
      .values([
        {
          mergeRequestId: mineMr.id,
          fingerprint: 'f1',
          scope: 'line',
          filePath: 'src/a.ts',
          title: 'rejected here',
          category: 'style',
          triage: 'invalid',
          triageNote: 'we like it this way',
        },
        {
          mergeRequestId: mineMr.id,
          fingerprint: 'f2',
          scope: 'line',
          filePath: 'src/b.ts',
          title: 'still untriaged',
        },
        {
          mergeRequestId: otherMr.id,
          fingerprint: 'f3',
          scope: 'line',
          filePath: 'src/c.ts',
          title: 'rejected in another project',
          triage: 'invalid',
        },
      ])
      .run()
    projectId = mine.id
  })

  afterAll(() => {
    closeDatabase()
    rmSync(root, { recursive: true, force: true })
  })

  it('collects only this project’s invalid findings', () => {
    const rejections = collectProjectRejections(db, projectId)
    expect(rejections.map((item) => item.title)).toEqual(['rejected here'])
    expect(rejections[0].note).toBe('we like it this way')
  })
})

describe('importing from a checkout', () => {
  let root: string
  let checkout: string
  let shared: string
  let plugin: string

  beforeAll(() => {
    root = mkdtempSync(path.join(tmpdir(), 'rivju-import-test-'))
    checkout = path.join(root, 'checkout')
    shared = path.join(root, 'shared-skills', 'house-style')
    plugin = path.join(root, 'plugin', 'skills')
    mkdirSync(path.join(checkout, '.claude', 'skills'), { recursive: true })
    mkdirSync(shared, { recursive: true })
    mkdirSync(plugin, { recursive: true })

    // A skill that lives in the checkout.
    const local = path.join(checkout, '.claude', 'skills', 'local-rule')
    mkdirSync(local, { recursive: true })
    writeFileSync(
      path.join(local, 'SKILL.md'),
      '---\nname: local-rule\ndescription: A rule kept in the repo.\n---\n\nLocal body.\n',
      'utf8',
    )

    // A skill symlinked in from a shared directory, plus a symlinked file
    // INSIDE it — both must be resolved to real content on import.
    writeFileSync(
      path.join(shared, 'SKILL.md'),
      '---\nname: house-style\ndescription: The team house style.\n---\n\nShared body.\n',
      'utf8',
    )
    writeFileSync(path.join(root, 'reference.md'), 'referenced content\n', 'utf8')
    symlinkSync(path.join(root, 'reference.md'), path.join(shared, 'reference.md'))
    symlinkSync(shared, path.join(checkout, '.claude', 'skills', 'house-style'))

    // A directory with no SKILL.md — discovered but flagged, not importable.
    mkdirSync(path.join(checkout, '.claude', 'skills', 'not-a-skill'), { recursive: true })
  })

  afterAll(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('reports nothing for a checkout without .claude/skills', async () => {
    const scan = await scanCheckoutSkills(path.join(root, 'shared-skills'))
    expect(scan.exists).toBe(false)
    expect(scan.candidates).toEqual([])
  })

  it('resolves a symlinked skill directory to its real path and frontmatter', async () => {
    const scan = await scanCheckoutSkills(checkout)
    expect(scan.exists).toBe(true)
    const bySlug = Object.fromEntries(scan.candidates.map((item) => [item.directory, item]))

    expect(bySlug['house-style'].symlinked).toBe(true)
    expect(bySlug['house-style'].realPath).toBe(shared)
    expect(bySlug['house-style'].name).toBe('house-style')
    expect(bySlug['house-style'].description).toBe('The team house style.')

    expect(bySlug['local-rule'].symlinked).toBe(false)
    expect(bySlug['not-a-skill'].issues).toContain('No SKILL.md in this directory.')
  })

  it('copies real file content, not links back into the checkout', async () => {
    const scan = await scanCheckoutSkills(checkout)
    const candidate = scan.candidates.find((item) => item.directory === 'house-style')
    expect(candidate).toBeDefined()
    if (!candidate) return

    const dest = path.join(plugin, 'house-style')
    const description = await copyCheckoutSkill({
      realPath: candidate.realPath,
      destDir: dest,
      name: 'house-style',
      fallbackDescription: null,
    })
    expect(description).toBe('The team house style.')
    expect(readFileSync(path.join(dest, 'SKILL.md'), 'utf8')).toContain('Shared body.')
    expect(readFileSync(path.join(dest, 'reference.md'), 'utf8')).toBe('referenced content\n')

    // Deleting the original leaves the import fully intact.
    rmSync(shared, { recursive: true, force: true })
    expect(readFileSync(path.join(dest, 'SKILL.md'), 'utf8')).toContain('Shared body.')
    expect(readFileSync(path.join(dest, 'reference.md'), 'utf8')).toBe('referenced content\n')
  })

  it('renames the copy to the registered name', async () => {
    const source = path.join(root, 'odd')
    mkdirSync(source, { recursive: true })
    writeFileSync(
      path.join(source, 'SKILL.md'),
      '---\nname: original-name\ndescription: Odd one out.\n---\n\nBody.\n',
      'utf8',
    )
    const dest = path.join(plugin, 'original-name-2')
    await copyCheckoutSkill({
      realPath: source,
      destDir: dest,
      name: 'original-name-2',
      fallbackDescription: null,
    })
    const written = readFileSync(path.join(dest, 'SKILL.md'), 'utf8')
    expect(written).toContain('name: original-name-2')
    expect(written).not.toContain('name: original-name\n')
  })
})
