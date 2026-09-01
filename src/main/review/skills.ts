import { eq } from 'drizzle-orm'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { RivjuDatabase } from '../db/client.ts'
import { skill } from '../db/schema.ts'

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

export async function seedBuiltinSkills(db: RivjuDatabase, skillsDir: string): Promise<void> {
  const pluginDir = path.join(skillsDir, 'user')
  await mkdir(path.join(pluginDir, '.claude-plugin'), { recursive: true })
  await writeFile(
    path.join(pluginDir, '.claude-plugin', 'plugin.json'),
    `${JSON.stringify({ name: 'rivju-user-skills', version: '1.0.0', description: 'Review skills managed by rivju' }, null, 2)}\n`,
    'utf8',
  )

  for (const [index, builtin] of BUILTIN_SKILLS.entries()) {
    const dirPath = path.join(pluginDir, 'skills', builtin.name)
    await mkdir(dirPath, { recursive: true })
    await writeFile(
      path.join(dirPath, 'SKILL.md'),
      `---\nname: ${builtin.name}\ndescription: ${builtin.description}\n---\n\n${builtin.body}\n`,
      'utf8',
    )
    const existing = db.select().from(skill).where(eq(skill.name, builtin.name)).all()
      .find((row) => row.scope === 'user' && row.projectId === null)
    if (existing) {
      db.update(skill).set({
        dirPath,
        description: builtin.description,
        origin: 'builtin',
        sortOrder: index,
      }).where(eq(skill.id, existing.id)).run()
    } else {
      db.insert(skill).values({
        scope: 'user',
        projectId: null,
        name: builtin.name,
        dirPath,
        description: builtin.description,
        enabled: true,
        sortOrder: index,
        origin: 'builtin',
      }).run()
    }
  }
}

export function builtinSkillNames(): string[] {
  return BUILTIN_SKILLS.map((item) => item.name)
}
