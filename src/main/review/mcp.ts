import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import { and, eq } from 'drizzle-orm'
import { z } from 'zod'
import type { RivjuDatabase } from '../db/client.ts'
import { finding, findingEvent } from '../db/schema.ts'
import { emitRunEvent } from '../events/bus.ts'
import { findingFingerprint } from './fingerprint.ts'
import { verifyFindingLocation } from './verifier.ts'

const findingShape = {
  scope: z.enum(['line', 'file', 'global']),
  file_path: z.string().min(1).nullable().optional(),
  line: z.number().int().positive().nullable().optional(),
  anchor_snippet: z.string().min(1).nullable().optional(),
  ctx_before: z.string().default(''),
  ctx_after: z.string().default(''),
  category: z.string().min(1).max(80),
  severity: z.enum(['critical', 'high', 'medium', 'low', 'info']),
  title: z.string().min(1).max(200),
  body: z.string().min(1),
  suggested_fix: z.string().min(1).optional(),
}
const findingInputSchema = z.object(findingShape)
export type FindingInput = z.infer<typeof findingInputSchema>

const finishShape = {
  summary: z.string().min(1),
  confidence: z.number().min(0).max(1),
  files_reviewed: z.array(z.string().min(1)),
}

export type FinishReview = {
  summary: string
  confidence: number
  filesReviewed: string[]
}

type SubmissionContext = {
  db: RivjuDatabase
  runId: string
  mergeRequestId: string
  headSha: string
  worktreePath: string
  onFinding?: () => void
}

export async function processFindingSubmission(input: SubmissionContext, args: FindingInput) {
  emitRunEvent({
    type: 'run:tool', runId: input.runId, at: Date.now(), tool: 'submit_finding', summary: args.title,
  })
  const verified = await verifyFindingLocation(input.worktreePath, args)
  if (!verified.ok) {
    input.db.insert(findingEvent).values({
      findingId: null,
      runId: input.runId,
      type: 'rejected_by_verifier',
      payload: { error: verified.error, submission: args, headSha: input.headSha },
    }).run()
    emitRunEvent({
      type: 'run:tool', runId: input.runId, at: Date.now(), tool: 'verifier', summary: `Rejected: ${verified.error}`,
    })
    return { accepted: false as const, error: verified.error }
  }

  const fingerprint = findingFingerprint({
    filePath: verified.filePath, anchorSnippet: verified.anchorSnippet, category: args.category,
  })
  const row = input.db.transaction((tx) => {
    const existing = tx.select().from(finding).where(and(
      eq(finding.mergeRequestId, input.mergeRequestId), eq(finding.fingerprint, fingerprint),
    )).get()
    const accepted = existing
      ? tx.update(finding).set({
          scope: args.scope, filePath: verified.filePath, anchorSnippet: verified.anchorSnippet,
          ctxBefore: verified.ctxBefore, ctxAfter: verified.ctxAfter, currentLine: verified.line,
          category: args.category, severity: args.severity, title: args.title, body: args.body,
          suggestedFix: args.suggested_fix ?? null, lifecycle: 'open', lifecycleRunId: input.runId,
        }).where(eq(finding.id, existing.id)).returning().get()
      : tx.insert(finding).values({
          mergeRequestId: input.mergeRequestId, fingerprint, scope: args.scope,
          filePath: verified.filePath, anchorSnippet: verified.anchorSnippet,
          ctxBefore: verified.ctxBefore, ctxAfter: verified.ctxAfter, currentLine: verified.line,
          category: args.category, severity: args.severity, title: args.title, body: args.body,
          suggestedFix: args.suggested_fix ?? null, createdRunId: input.runId,
          firstSeenHeadSha: input.headSha, lifecycleRunId: input.runId,
        }).returning().get()
    tx.insert(findingEvent).values({
      findingId: accepted.id, runId: input.runId, type: 'submitted', payload: { fingerprint, headSha: input.headSha },
    }).run()
    return accepted
  })
  input.onFinding?.()
  emitRunEvent({ type: 'run:finding', runId: input.runId, at: Date.now(), finding: row })
  return { accepted: true as const, row }
}

export function createReviewMcp(input: {
  db: RivjuDatabase
  runId: string
  mergeRequestId: string
  headSha: string
  worktreePath: string
  onFinished: (result: FinishReview) => void
  onFinding?: () => void
}) {
  let closed = false
  const submitFinding = tool(
    'submit_finding',
    'Submit one review finding. Line/file anchors are accepted only when the exact snippet matches head_sha.',
    findingShape,
    async (args) => {
      if (closed) return {
        content: [{ type: 'text' as const, text: 'REJECTED: finish_review already closed this review.' }],
        isError: true,
      }
      const result = await processFindingSubmission(input, args)
      return result.accepted
        ? { content: [{ type: 'text' as const, text: `Accepted finding ${result.row.id}.` }] }
        : { content: [{ type: 'text' as const, text: `REJECTED: ${result.error}` }], isError: true }
    },
  )

  const finishReview = tool(
    'finish_review',
    'Finish the review after all findings have been submitted.',
    finishShape,
    async (args) => {
      if (closed) return {
        content: [{ type: 'text' as const, text: 'REJECTED: finish_review may only be called once.' }],
        isError: true,
      }
      closed = true
      input.onFinished({
        summary: args.summary,
        confidence: args.confidence,
        filesReviewed: args.files_reviewed,
      })
      emitRunEvent({
        type: 'run:tool',
        runId: input.runId,
        at: Date.now(),
        tool: 'finish_review',
        summary: `${args.files_reviewed.length} files · ${Math.round(args.confidence * 100)}% confidence`,
      })
      return { content: [{ type: 'text' as const, text: 'Review finished successfully.' }] }
    },
  )

  return createSdkMcpServer({
    name: 'rivju',
    version: '1.0.0',
    instructions: 'Use submit_finding for every finding, then call finish_review exactly once.',
    tools: [submitFinding, finishReview],
    alwaysLoad: true,
  })
}
