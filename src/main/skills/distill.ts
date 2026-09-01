import { and, eq } from 'drizzle-orm'
import { formatSkillDocument, readSkillDocument } from './frontmatter.ts'
import { finding, mergeRequest } from '../db/schema.ts'
import type { RivjuDatabase } from '../db/client.ts'

/**
 * Distils the findings a human marked `invalid` into a project-scoped skill.
 *
 * Design constraints from the phase brief, in order of importance:
 *
 * - The output must be a file a human would actually want to edit. So it is
 *   plain prose grouped by file, with a preamble that explains the contract.
 * - It is APPENDED to, never overwritten. Everything already in the file — the
 *   preamble the user rewrote, the rules they merged by hand, the entries they
 *   sharpened — survives verbatim.
 * - Deduplication is by finding fingerprint, carried in an HTML comment above
 *   each entry. Deleting the comment (or the whole entry) is a supported way to
 *   say "regenerate this one"; the comment is invisible in rendered markdown.
 *
 * Generation is deterministic rather than model-driven: this file becomes part
 * of the next review's instructions, so a reviewer needs to be able to predict
 * and audit exactly what it says.
 */

export const REJECTION_SKILL_NAME = 'rejected-findings'

const MARKER_PREFIX = 'rivju:rejection'
const FINGERPRINT_CHARS = 12
const MAX_REJECTIONS = 200

export interface RejectionEntry {
  fingerprint: string
  filePath: string | null
  category: string | null
  title: string
  note: string | null
}

export interface DistilledSkill {
  content: string
  appended: RejectionEntry[]
  /** Already present in the file (by marker) — left untouched. */
  skipped: RejectionEntry[]
}

export function collectProjectRejections(
  db: RivjuDatabase,
  projectId: string,
  limit = MAX_REJECTIONS,
): RejectionEntry[] {
  return db
    .select({
      fingerprint: finding.fingerprint,
      filePath: finding.filePath,
      category: finding.category,
      title: finding.title,
      note: finding.triageNote,
    })
    .from(finding)
    .innerJoin(mergeRequest, eq(finding.mergeRequestId, mergeRequest.id))
    .where(and(eq(mergeRequest.projectId, projectId), eq(finding.triage, 'invalid')))
    .all()
    .slice(0, limit)
}

export function buildRejectionSkill(input: {
  projectPath: string
  /** Current SKILL.md text, or null when the skill does not exist yet. */
  existing: string | null
  rejections: RejectionEntry[]
}): DistilledSkill {
  const existing = input.existing ?? initialDocument(input.projectPath)
  const present = markersIn(existing)

  const appended: RejectionEntry[] = []
  const skipped: RejectionEntry[] = []
  for (const rejection of sortRejections(input.rejections)) {
    if (present.has(marker(rejection.fingerprint))) skipped.push(rejection)
    else appended.push(rejection)
  }

  if (appended.length === 0) return { content: existing, appended, skipped }

  const block: string[] = []
  let currentHeading: string | null = null
  for (const rejection of appended) {
    const heading = headingFor(rejection)
    if (heading !== currentHeading) {
      block.push('', `### ${heading}`)
      currentHeading = heading
    }
    block.push('', ...entryLines(rejection))
  }

  const content = `${existing.replace(/\s*$/, '')}\n${block.join('\n')}\n`
  return { content, appended, skipped }
}

/** The header rivju writes the first time; the user owns it from then on. */
function initialDocument(projectPath: string): string {
  return formatSkillDocument({
    frontmatter: {
      name: REJECTION_SKILL_NAME,
      description: `Findings reviewers of ${projectPath} judged invalid. Read before reporting anything in this project.`,
    },
    body: [
      `# Rejected findings — ${projectPath}`,
      '',
      'Every rule below comes from a finding a human reviewer read and marked',
      '**invalid**. Treat them as standing decisions: do not raise the same point',
      'again unless the surrounding code changed in a way that makes the concern',
      'newly true. When you are unsure whether a rule still applies, say so in the',
      'finding body instead of staying silent.',
      '',
      'This file is yours to edit. rivju only ever appends new entries at the end',
      'and never rewrites what is already here — rewrite the prose, merge entries,',
      'or generalise them into sharper rules freely. The',
      '`<!-- rivju:rejection … -->` comment above an entry is how rivju knows it has',
      'already been distilled: keep it to suppress the entry from coming back,',
      'delete it to let the next distillation regenerate the entry.',
      '',
      '## Rules',
    ].join('\n'),
  })
}

function entryLines(rejection: RejectionEntry): string[] {
  const lines = [`<!-- ${marker(rejection.fingerprint)} -->`, `Do not report: **${inline(rejection.title)}**`]
  const note = rejection.note?.trim()
  if (note) {
    lines.push('', ...note.split(/\r?\n/).map((line) => `> ${line}`.trimEnd()))
  } else {
    lines.push('', '> The reviewer dismissed this without a note.')
  }
  return lines
}

function headingFor(rejection: RejectionEntry): string {
  const where = rejection.filePath ? `\`${rejection.filePath}\`` : 'Repository-wide'
  return rejection.category ? `${where} · ${rejection.category}` : where
}

function marker(fingerprint: string): string {
  return `${MARKER_PREFIX} ${fingerprint.slice(0, FINGERPRINT_CHARS)}`
}

function markersIn(content: string): Set<string> {
  const found = new Set<string>()
  for (const match of content.matchAll(/<!--\s*(rivju:rejection\s+[0-9a-f]+)\s*-->/gi)) {
    found.add(match[1].replace(/\s+/g, ' ').toLowerCase())
  }
  return found
}

function sortRejections(rejections: RejectionEntry[]): RejectionEntry[] {
  return [...rejections].sort(
    (a, b) =>
      (a.filePath ?? '\uFFFF').localeCompare(b.filePath ?? '\uFFFF') ||
      (a.category ?? '').localeCompare(b.category ?? '') ||
      a.title.localeCompare(b.title) ||
      a.fingerprint.localeCompare(b.fingerprint),
  )
}

function inline(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

/**
 * A distilled file the user has edited into invalid frontmatter would break
 * every subsequent run; surface it as a blocking problem instead of appending.
 */
export function validateDistilled(content: string): string[] {
  const result = readSkillDocument(content)
  if (result.ok) {
    return result.document.frontmatter.name === REJECTION_SKILL_NAME
      ? []
      : [`The rules file declares name \`${result.document.frontmatter.name}\`, expected \`${REJECTION_SKILL_NAME}\`.`]
  }
  return result.issues
}
