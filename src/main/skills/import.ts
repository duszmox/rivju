import { cp, mkdir, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { formatSkillDocument, readSkillDocument, slugifySkillName } from './frontmatter.ts'

/**
 * Reading and copying skills out of a checkout's `.claude/skills`.
 *
 * Kept free of Electron and the database so the symlink behaviour — the part
 * that is easy to get subtly wrong and impossible to notice afterwards — is
 * directly testable.
 *
 * Symlinks are resolved twice over: `realpath` on the directory before it is
 * read (dotfile repos routinely link `.claude/skills` or an individual skill at
 * a shared source), and `dereference` on the copy so what lands in rivju's
 * plugin is real file content rather than links back into the user's checkout,
 * which may move or disappear.
 */

export interface CheckoutSkill {
  /** Directory name inside `.claude/skills`. */
  directory: string
  /** Path as listed, before symlink resolution. */
  sourcePath: string
  /** `realpath` of the same directory — what actually gets copied. */
  realPath: string
  symlinked: boolean
  name: string | null
  description: string | null
  issues: string[]
}

export interface CheckoutScan {
  root: string
  skillsDir: string
  exists: boolean
  candidates: CheckoutSkill[]
}

export async function scanCheckoutSkills(root: string): Promise<CheckoutScan> {
  const skillsDir = path.join(root, '.claude', 'skills')
  const resolvedRoot = (await realpathOrNull(skillsDir)) ?? skillsDir
  if (!(await pathExists(resolvedRoot))) return { root, skillsDir, exists: false, candidates: [] }

  const entries = await readdir(resolvedRoot)
  const candidates: CheckoutSkill[] = []
  for (const entry of entries.sort()) {
    if (entry.startsWith('.')) continue
    const sourcePath = path.join(resolvedRoot, entry)
    // stat (not the dirent) so a symlinked skill directory still counts.
    const info = await stat(sourcePath).catch(() => null)
    if (!info?.isDirectory()) continue
    candidates.push(await describeCandidate(entry, sourcePath))
  }
  return { root, skillsDir, exists: true, candidates }
}

async function describeCandidate(entry: string, sourcePath: string): Promise<CheckoutSkill> {
  const realPath = (await realpathOrNull(sourcePath)) ?? sourcePath
  const file = path.join(realPath, 'SKILL.md')
  const issues: string[] = []
  let name: string | null = null
  let description: string | null = null

  if (!(await pathExists(file))) {
    issues.push('No SKILL.md in this directory.')
  } else {
    const parsed = readSkillDocument(await readFile(file, 'utf8'))
    if (parsed.ok) {
      name = parsed.document.frontmatter.name
      description = parsed.document.frontmatter.description
    } else {
      issues.push(...parsed.issues)
      name = slugifySkillName(entry) || null
      if (!name) issues.push(`Cannot derive a valid skill name from the directory \`${entry}\`.`)
    }
  }
  return {
    directory: entry,
    sourcePath,
    realPath,
    symlinked: realPath !== sourcePath,
    name,
    description,
    issues,
  }
}

/**
 * Copy a discovered skill into a plugin directory under the name rivju
 * registered, and normalise its frontmatter to the standard keys. Returns the
 * description that ends up on disk.
 */
export async function copyCheckoutSkill(input: {
  realPath: string
  destDir: string
  name: string
  fallbackDescription: string | null
}): Promise<string> {
  await rm(input.destDir, { recursive: true, force: true })
  await mkdir(path.dirname(input.destDir), { recursive: true })
  await cp(input.realPath, input.destDir, { recursive: true, dereference: true })

  const filePath = path.join(input.destDir, 'SKILL.md')
  const raw = (await readFile(filePath, 'utf8').catch(() => null)) ?? ''
  const parsed = readSkillDocument(raw)
  const description = parsed.ok
    ? parsed.document.frontmatter.description
    : (input.fallbackDescription ?? `Imported skill \`${input.name}\`.`)
  const body = parsed.ok ? parsed.document.body : stripFrontmatter(raw) || `# ${input.name}\n`
  await writeFile(
    filePath,
    formatSkillDocument({ frontmatter: { name: input.name, description }, body }),
    'utf8',
  )
  return description
}

function stripFrontmatter(raw: string): string {
  const normalized = raw.replace(/\r\n/g, '\n')
  if (!normalized.startsWith('---\n')) return normalized.trim()
  const end = normalized.indexOf('\n---', 4)
  return end === -1 ? normalized.trim() : normalized.slice(end + 4).replace(/^\n+/, '')
}

async function pathExists(target: string): Promise<boolean> {
  return stat(target)
    .then(() => true)
    .catch(() => false)
}

async function realpathOrNull(target: string): Promise<string | null> {
  return realpath(target).catch(() => null)
}
