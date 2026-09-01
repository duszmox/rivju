import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import type { RunUsage } from '../db/schema.ts'

/**
 * Assistant messages are emitted once per completed content block. Messages
 * from the same model turn share an id and carry progressively newer usage, so
 * retain the largest snapshot for each id instead of counting every block.
 * Shared by the live runner and the offline JSONL replay so both count
 * identically.
 */
export class LiveTokenAccumulator {
  private readonly messages = new Map<
    string,
    { inputTokens: number; outputTokens: number }
  >()
  private inputTokens = 0
  private outputTokens = 0

  update(
    messageId: string,
    inputTokens: number,
    outputTokens: number,
  ): {
    inputTokens: number
    outputTokens: number
  } | null {
    const previous = this.messages.get(messageId) ?? {
      inputTokens: 0,
      outputTokens: 0,
    }
    const next = {
      inputTokens: Math.max(
        previous.inputTokens,
        finiteTokenCount(inputTokens),
      ),
      outputTokens: Math.max(
        previous.outputTokens,
        finiteTokenCount(outputTokens),
      ),
    }
    if (
      next.inputTokens === previous.inputTokens &&
      next.outputTokens === previous.outputTokens
    )
      return null

    this.inputTokens += next.inputTokens - previous.inputTokens
    this.outputTokens += next.outputTokens - previous.outputTokens
    this.messages.set(messageId, next)
    return { inputTokens: this.inputTokens, outputTokens: this.outputTokens }
  }
}

export function usageFromResult(
  message: Extract<SDKMessage, { type: 'result' }>,
): RunUsage {
  return Object.values(message.modelUsage).reduce<RunUsage>(
    (total, item) => ({
      inputTokens: total.inputTokens + item.inputTokens,
      outputTokens: total.outputTokens + item.outputTokens,
      cacheReadInputTokens:
        (total.cacheReadInputTokens ?? 0) + item.cacheReadInputTokens,
      cacheCreationInputTokens:
        (total.cacheCreationInputTokens ?? 0) + item.cacheCreationInputTokens,
      costUsd: (total.costUsd ?? 0) + item.costUSD,
    }),
    { inputTokens: 0, outputTokens: 0, costUsd: 0 },
  )
}

function finiteTokenCount(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0
}
