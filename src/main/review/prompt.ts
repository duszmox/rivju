import type { DiffFileSummary } from '../repo/diff.ts'
import type { FindingRow } from '../db/schema.ts'
import type { RejectedFindingSummary } from './rejected.ts'

export const REVIEW_SYSTEM_PROMPT = `
You are performing a read-only merge request review. Use the provided tools and
the checkout to investigate. For each concrete issue, call
mcp__rivju__submit_finding. Never report a finding only in prose. A line or file
finding must quote the exact 1-3 line anchor at its starting line in head_sha;
the server rejects guesses. Use global scope only when no file location exists.
When complete, call mcp__rivju__finish_review exactly once. That call is required
even when there are zero findings. Do not attempt to change files.
`.trim()

export const VERIFY_SYSTEM_PROMPT = `
You are verifying previously reported review findings against the current head
of a merge request. You receive the still-open findings, the diff since the
head that was reviewed, and a fresh detached checkout. Investigate each finding
in the checkout, then report exactly one verdict per finding with
mcp__rivju__report_verification:
- "fixed" — the concrete issue the finding describes no longer exists in the
  code at head_sha. Verify the actual change, not just that the lines moved.
- "not_fixed" — the issue is still present or still possible. Quote what you
  saw as evidence.
- "moot" — events made the finding irrelevant, e.g. the code was deleted or
  the requirement changed, so verification is no longer meaningful.
A finding whose anchor no longer matches may still describe a real problem
somewhere else — search before concluding. If you cannot determine a verdict,
report "not_fixed" and say what is unclear. When every finding has a verdict,
call mcp__rivju__finish_review exactly once. Do not attempt to change files and
do not submit new findings.
`.trim()

export function composeReviewPrompt(input: {
  title: string
  description: string | null
  labels: string[]
  baseSha: string
  headSha: string
  files: DiffFileSummary[]
  rejected: RejectedFindingSummary[]
}): string {
  const changedFiles = input.files.map((file) =>
    `- ${file.status}: ${file.path} (+${file.additions}/-${file.deletions})${file.truncated ? ' [prompt patch truncated]' : ''}`,
  ).join('\n')
  const patches = input.files.map((file) =>
    `## ${file.path}\n\n\`\`\`diff\n${file.patch ?? '(no textual patch)'}\n\`\`\``,
  ).join('\n\n')
  const rejected = renderRejectedBlock(input.rejected)

  return `${REVIEW_SYSTEM_PROMPT}

# Merge request

Title: ${input.title}
Description: ${input.description?.trim() || '(none)'}
Labels: ${input.labels.length ? input.labels.join(', ') : '(none)'}
Base SHA: ${input.baseSha}
Head SHA: ${input.headSha}

# Changed files

${changedFiles || '(none)'}

# Git diff (base...head)

${patches || '(empty diff)'}
${rejected}`
}

function renderRejectedBlock(items: RejectedFindingSummary[]): string {
  if (!items.length) return ''
  const lines = items.map((item) => {
    const where = item.filePath ? ` \`${item.filePath}\`` : ''
    const note = item.note ? ` — reviewer note: ${item.note}` : ''
    return `- [${item.category ?? 'general'}]${where} ${item.title}${note}`
  })
  return `

# Previously rejected findings

The human reviewer marked the following findings invalid for this project. Do
NOT report them again unless the code you are looking at is materially
different from what was rejected.

${lines.join('\n')}`
}

export function composeVerifyPrompt(input: {
  title: string
  reviewedHeadSha: string
  headSha: string
  findings: FindingRow[]
  files: DiffFileSummary[]
  rejected: RejectedFindingSummary[]
}): string {
  const findings = input.findings.map((finding) => {
    const location = finding.scope === 'global'
      ? 'global'
      : `${finding.filePath ?? '(unknown file)'}:${finding.currentLine ?? '?'}`
    const triage = finding.triage === 'untriaged'
      ? 'not yet human-triaged'
      : `human triage: ${finding.triage}${finding.triageNote ? ` (${finding.triageNote})` : ''}`
    const anchor = finding.anchorSnippet
      ? `\n  anchor: ${finding.anchorSnippet.split('\n').map((line) => JSON.stringify(line)).join(' + ')}`
      : ''
    return [
      `- id: ${finding.id}`,
      `  title: ${finding.title}`,
      `  location: ${location} (scope: ${finding.scope})`,
      `  severity: ${finding.severity ?? 'info'} · category: ${finding.category ?? 'general'}`,
      `  ${triage}${anchor}`,
      `  body: ${(finding.body ?? '').slice(0, 600)}`,
    ].join('\n')
  }).join('\n')
  const patches = input.files.map((file) =>
    `## ${file.path}\n\n\`\`\`diff\n${file.patch ?? '(no textual patch)'}\n\`\`\``,
  ).join('\n\n')
  const rejected = renderRejectedBlock(input.rejected)

  return `${VERIFY_SYSTEM_PROMPT}

# Merge request

Title: ${input.title}
Reviewed head SHA: ${input.reviewedHeadSha}
Current head SHA: ${input.headSha}

# Open findings to verify

${findings || '(none)'}

# Changes since the reviewed head (${input.reviewedHeadSha}...${input.headSha})

${patches || '(no changes between the reviewed head and the current head)'}
${rejected}`
}
