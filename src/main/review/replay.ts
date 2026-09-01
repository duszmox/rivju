import { z } from 'zod'
import type { RivjuDatabase } from '../db/client.ts'
import type { RunUsage } from '../db/schema.ts'
import { findingInputSchema, processFindingSubmission } from './mcp.ts'
import { processVerificationReport } from './verify.ts'
import { LiveTokenAccumulator, usageFromResult } from './usage.ts'

/**
 * Offline replay of a recorded run log (`<userData>/logs/<run-id>.jsonl`).
 *
 * A run log is the full SDK message stream plus rivju's own `rivju_*` records.
 * Replaying feeds the recorded `mcp__rivju__submit_finding` /
 * `mcp__rivju__report_verification` tool calls back through the real parsing +
 * verification layer (`processFindingSubmission` / `processVerificationReport`)
 * against a checkout, and recomputes usage with the same accumulator the live
 * runner uses. This is how recorded runs are debugged without re-running an
 * agent — and how this whole layer is tested.
 */

export const RIVJU_MCP_PREFIX = 'mcp__rivju__'

const verificationInputSchema = z.object({
  finding_id: z.string().min(1),
  verdict: z.enum(['fixed', 'not_fixed', 'moot']),
  justification: z.string().min(1),
})

export type ReplaySummary = {
  messages: number
  submitted: number
  rejected: number
  reported: number
  finishCalls: number
  usage: RunUsage
  resultSubtype: string | null
  errors: string[]
}

/** Parses JSONL text into message records, naming the offending line. */
export function parseRunLog(text: string): unknown[] {
  const messages: unknown[] = []
  for (const [index, line] of text.split('\n').entries()) {
    if (line.trim() === '') continue
    try {
      messages.push(JSON.parse(line))
    } catch {
      throw new Error(`Run log line ${index + 1} is not valid JSON`)
    }
  }
  return messages
}

type AssistantContentBlock = {
  type: string
  name?: string
  input?: unknown
}

export async function replayRunMessages(
  input: {
    db: RivjuDatabase
    runId: string
    mergeRequestId: string
    headSha: string
    worktreePath: string
    /** Open findings targeted by a verify run, when replaying one. */
    targetFindingIds?: ReadonlySet<string>
  },
  messages: readonly unknown[],
): Promise<ReplaySummary> {
  const summary: ReplaySummary = {
    messages: 0,
    submitted: 0,
    rejected: 0,
    reported: 0,
    finishCalls: 0,
    usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
    resultSubtype: null,
    errors: [],
  }
  const liveTokens = new LiveTokenAccumulator()

  for (const record of messages) {
    summary.messages++
    if (!isRecord(record)) {
      summary.errors.push('Run log contains a record that is not an object')
      continue
    }

    if (record.type === 'assistant' && isRecord(record.message)) {
      const usage = record.message.usage
      if (isRecord(usage)) {
        const tokens = liveTokens.update(
          typeof record.message.id === 'string' ? record.message.id : '',
          numberAt(usage, 'input_tokens'),
          numberAt(usage, 'output_tokens'),
        )
        if (tokens) summary.usage = { ...summary.usage, ...tokens }
      }
      const content = record.message.content
      if (!Array.isArray(content)) continue
      for (const block of content as AssistantContentBlock[]) {
        if (block.type !== 'tool_use' || typeof block.name !== 'string')
          continue
        await applyToolCall(input, block.name, block.input, summary)
      }
      continue
    }

    if (record.type === 'result') {
      summary.resultSubtype =
        typeof record.subtype === 'string' ? record.subtype : null
      if (isRecord(record.modelUsage)) {
        summary.usage = usageFromResult(
          record as Parameters<typeof usageFromResult>[0],
        )
      } else {
        summary.errors.push(
          'result record has no modelUsage; usage was not updated',
        )
      }
      if (record.is_error === true) {
        summary.errors.push(
          'errors' in record && Array.isArray(record.errors)
            ? record.errors.filter((e) => typeof e === 'string').join('; ')
            : typeof record.result === 'string'
              ? record.result
              : 'run ended with an error result',
        )
      }
    }
  }
  return summary
}

async function applyToolCall(
  input: Parameters<typeof replayRunMessages>[0],
  name: string,
  rawArgs: unknown,
  summary: ReplaySummary,
): Promise<void> {
  if (name === `${RIVJU_MCP_PREFIX}submit_finding`) {
    const parsed = findingInputSchema.safeParse(rawArgs)
    if (!parsed.success) {
      summary.rejected++
      summary.errors.push(`submit_finding input failed schema validation`)
      return
    }
    const result = await processFindingSubmission(input, parsed.data)
    if (result.accepted) summary.submitted++
    else {
      summary.rejected++
      summary.errors.push(result.error)
    }
    return
  }

  if (name === `${RIVJU_MCP_PREFIX}report_verification`) {
    const parsed = verificationInputSchema.safeParse(rawArgs)
    if (!parsed.success) {
      summary.rejected++
      summary.errors.push('report_verification input failed schema validation')
      return
    }
    if (!input.targetFindingIds) {
      summary.rejected++
      summary.errors.push('replaying a verify run requires targetFindingIds')
      return
    }
    const result = await processVerificationReport(
      {
        db: input.db,
        runId: input.runId,
        mergeRequestId: input.mergeRequestId,
        headSha: input.headSha,
        targetFindingIds: input.targetFindingIds,
      },
      parsed.data,
    )
    if (result.accepted) summary.reported++
    else {
      summary.rejected++
      summary.errors.push(result.error)
    }
    return
  }

  if (name === `${RIVJU_MCP_PREFIX}finish_review`) summary.finishCalls++
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function numberAt(record: Record<string, unknown>, key: string): number {
  const value = record[key]
  return typeof value === 'number' ? value : Number.NaN
}
