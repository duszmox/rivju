import { z } from 'zod'

/**
 * SKILL.md frontmatter — standard keys ONLY.
 *
 * 00-architecture.md is explicit: `name` and `description` are the entire
 * vocabulary. Every piece of rivju state (enabled, scope, order, origin) lives
 * in SQLite keyed by skill name, so a rivju skill directory stays a plain
 * Claude Code skill that the SDK, the CLI, or a human can read unchanged.
 *
 * The parser here is deliberately a strict subset of YAML rather than a real
 * YAML dependency: it accepts exactly the shape we write, and rejects anything
 * else with a message a user can act on. Silently tolerating richer YAML would
 * let a user write frontmatter we then destroy on the next save.
 */

export const SKILL_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

export const skillFrontmatterSchema = z.object({
  name: z
    .string()
    .min(1)
    .max(64)
    .regex(
      SKILL_NAME_PATTERN,
      'must be lowercase letters, digits and single hyphens (e.g. "review-security")',
    ),
  description: z
    .string()
    .min(1, 'a description is required — it is what the model sees when deciding to load the skill')
    .max(1024),
})

export type SkillFrontmatter = z.infer<typeof skillFrontmatterSchema>

export interface SkillDocument {
  frontmatter: SkillFrontmatter
  /** Everything after the closing `---`, with the leading blank line trimmed. */
  body: string
}

const ALLOWED_KEYS = new Set(['name', 'description'])
const DELIMITER = '---'

export class SkillFrontmatterError extends Error {
  readonly issues: string[]
  constructor(issues: string[]) {
    super(issues.join('\n'))
    this.name = 'SkillFrontmatterError'
    this.issues = issues
  }
}

/** Throws {@link SkillFrontmatterError} listing every problem at once. */
export function parseSkillDocument(source: string): SkillDocument {
  const result = readSkillDocument(source)
  if (!result.ok) throw new SkillFrontmatterError(result.issues)
  return result.document
}

export type SkillDocumentResult =
  | { ok: true; document: SkillDocument }
  | { ok: false; issues: string[] }

/** Non-throwing variant — the editor renders `issues` inline. */
export function readSkillDocument(source: string): SkillDocumentResult {
  const normalized = source.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n')
  const lines = normalized.split('\n')
  if (lines[0]?.trim() !== DELIMITER) {
    return {
      ok: false,
      issues: ['SKILL.md must start with a `---` frontmatter block on the very first line.'],
    }
  }
  const closing = lines.findIndex((line, index) => index > 0 && line.trim() === DELIMITER)
  if (closing === -1) {
    return { ok: false, issues: ['The frontmatter block is never closed by a second `---` line.'] }
  }

  const issues: string[] = []
  const fields: Record<string, string> = {}
  for (const [offset, raw] of lines.slice(1, closing).entries()) {
    const lineNumber = offset + 2
    const line = raw.trim()
    if (line === '' || line.startsWith('#')) continue
    const separator = raw.indexOf(':')
    if (separator === -1) {
      issues.push(`Line ${lineNumber}: expected \`key: value\`, got \`${line}\`.`)
      continue
    }
    const key = raw.slice(0, separator).trim()
    const value = unquote(raw.slice(separator + 1).trim())
    if (!ALLOWED_KEYS.has(key)) {
      issues.push(
        `Line ${lineNumber}: \`${key}\` is not a standard skill key. rivju keeps its own state in its database — only \`name\` and \`description\` may appear here.`,
      )
      continue
    }
    if (key in fields) {
      issues.push(`Line ${lineNumber}: \`${key}\` is set twice.`)
      continue
    }
    if (value === '') {
      issues.push(`Line ${lineNumber}: \`${key}\` has no value.`)
      continue
    }
    fields[key] = value
  }

  const parsed = skillFrontmatterSchema.safeParse(fields)
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const key = issue.path[0]
      issues.push(key ? `\`${String(key)}\`: ${issue.message}` : issue.message)
    }
  }

  const body = lines.slice(closing + 1).join('\n').replace(/^\n+/, '')
  if (body.trim() === '') {
    issues.push('The skill body is empty — there are no instructions for the agent to follow.')
  }
  if (issues.length > 0) return { ok: false, issues }
  return { ok: true, document: { frontmatter: parsed.data as SkillFrontmatter, body } }
}

export function formatSkillDocument(document: SkillDocument): string {
  const { name, description } = document.frontmatter
  const body = document.body.replace(/\r\n/g, '\n').replace(/^\n+/, '').replace(/\s*$/, '')
  return [
    DELIMITER,
    `name: ${formatScalar(name)}`,
    `description: ${formatScalar(description)}`,
    DELIMITER,
    '',
    body,
    '',
  ].join('\n')
}

/**
 * Quote only when a bare YAML scalar would be misread. Descriptions routinely
 * contain `:` and `#`, which would otherwise parse as a mapping or a comment.
 */
function formatScalar(value: string): string {
  const needsQuotes =
    value !== value.trim() ||
    /^[-?:,[\]{}#&*!|>'"%@`]/.test(value) ||
    /:\s/.test(value) ||
    /\s#/.test(value) ||
    value.endsWith(':')
  if (!needsQuotes) return value
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

function unquote(value: string): string {
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\')
  }
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1).replace(/''/g, "'")
  }
  return value
}

/** Best-effort slug for an imported skill whose name is not already valid. */
export function slugifySkillName(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
    .replace(/-+$/, '')
  return SKILL_NAME_PATTERN.test(slug) ? slug : ''
}
