import { and, eq, isNull } from 'drizzle-orm'
import { mkdir, writeFile } from 'node:fs/promises'
import { formatSkillDocument } from './frontmatter.ts'
import { USER_PLUGIN_NAME, ensurePluginDir, skillDirIn, skillFileIn, userPluginDir } from './plugin.ts'
import { skill } from '../db/schema.ts'
import type { RivjuDatabase } from '../db/client.ts'

const BUILTIN_SKILLS = [
  {
    name: 'review-correctness',
    description: 'Find concrete correctness bugs and broken edge cases in changed code.',
    body: `Review the merge request for correctness. Trace changed control flow and data flow, check error paths, boundary conditions, concurrency, state transitions, and compatibility with callers. Report only actionable defects introduced or exposed by the change.`,
  },
  {
    name: 'review-security',
    description: 'Find exploitable security and privacy weaknesses in changed code.',
    body: `Review the merge request for security. Look for broken authorization, injection, unsafe parsing, path traversal, credential exposure, insecure defaults, confused-deputy behavior, and missing validation at trust boundaries. Explain the concrete attack or failure path; avoid speculative hardening advice.`,
  },
  {
    name: 'review-conventions',
    description: 'Check changed code against the repository’s established conventions.',
    body: `Review the merge request for violations of conventions already established in the repository. Use nearby code, tests, and documented rules as evidence. Report only deviations that create a meaningful maintenance or behavior risk, not personal style preferences.`,
  },
] as const

/**
 * Built-ins are re-created at boot, so deleting one is meaningless — the UI
 * offers disable instead and the service refuses the delete.
 */
export function isBuiltinSkillName(name: string): boolean {
  return BUILTIN_SKILLS.some((builtin) => builtin.name === name)
}

/**
 * Re-materialise the built-in skills on every boot.
 *
 * Their FILES are rewritten (so a corrupted or hand-deleted SKILL.md heals),
 * but their ROW state is not: `enabled` and `sort_order` belong to the user.
 * A built-in the user switched off stays off across restarts.
 */
export async function seedBuiltinSkills(db: RivjuDatabase, skillsDir: string): Promise<void> {
  const pluginDir = userPluginDir(skillsDir)
  await ensurePluginDir(
    { name: USER_PLUGIN_NAME, dir: pluginDir },
    'Review skills managed by rivju (user scope)',
  )

  for (const [index, builtin] of BUILTIN_SKILLS.entries()) {
    const dirPath = skillDirIn(pluginDir, builtin.name)
    await mkdir(dirPath, { recursive: true })
    const existing = db
      .select()
      .from(skill)
      .where(and(eq(skill.scope, 'user'), isNull(skill.projectId), eq(skill.name, builtin.name)))
      .get()

    // Only rewrite the file when the user has never edited it — a built-in the
    // user customised is theirs now, and clobbering it on boot would be data
    // loss. `origin` flips to 'user' the first time it is saved from the editor.
    if (!existing || existing.origin === 'builtin') {
      await writeFile(
        skillFileIn(pluginDir, builtin.name),
        formatSkillDocument({
          frontmatter: { name: builtin.name, description: builtin.description },
          body: builtin.body,
        }),
        'utf8',
      )
    }

    if (existing) {
      db.update(skill)
        .set(
          existing.origin === 'builtin'
            ? { dirPath, description: builtin.description }
            : { dirPath },
        )
        .where(eq(skill.id, existing.id))
        .run()
    } else {
      db.insert(skill)
        .values({
          scope: 'user',
          projectId: null,
          name: builtin.name,
          dirPath,
          description: builtin.description,
          enabled: true,
          sortOrder: index,
          origin: 'builtin',
        })
        .run()
    }
  }
}
