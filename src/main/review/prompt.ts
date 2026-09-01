import type { DiffFileSummary } from '../repo/diff.ts'

export const REVIEW_SYSTEM_PROMPT = `
You are performing a read-only merge request review. Use the provided tools and
the checkout to investigate. For each concrete issue, call
mcp__rivju__submit_finding. Never report a finding only in prose. A line or file
finding must quote the exact 1-3 line anchor at its starting line in head_sha;
the server rejects guesses. Use global scope only when no file location exists.
When complete, call mcp__rivju__finish_review exactly once. That call is required
even when there are zero findings. Do not attempt to change files.
`.trim()

export function composeReviewPrompt(input: {
  title: string
  description: string | null
  labels: string[]
  baseSha: string
  headSha: string
  files: DiffFileSummary[]
}): string {
  const changedFiles = input.files.map((file) =>
    `- ${file.status}: ${file.path} (+${file.additions}/-${file.deletions})${file.truncated ? ' [prompt patch truncated]' : ''}`,
  ).join('\n')
  const patches = input.files.map((file) =>
    `## ${file.path}\n\n\`\`\`diff\n${file.patch ?? '(no textual patch)'}\n\`\`\``,
  ).join('\n\n')

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
`
}
