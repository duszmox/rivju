import { randomUUID } from 'node:crypto'
import { app } from 'electron'
import { TRPCError } from '@trpc/server'
import { emitRunEvent } from '../events/bus.ts'

/**
 * Dev-only synthetic run. Its only job is to prove the `run:*` streaming
 * pipeline end to end (main event bus -> tRPC subscription over IPC -> live
 * sidebar) before any real agent exists. Refuses to start in packaged builds.
 */

const timers = new Map<string, Set<NodeJS.Timeout>>()

export function startFakeRun(): { runId: string } {
  if (app.isPackaged) {
    throw new TRPCError({ code: 'FORBIDDEN', message: 'Fake runs are only available in dev builds' })
  }

  const runId = randomUUID()
  const pending = new Set<NodeJS.Timeout>()
  timers.set(runId, pending)

  const schedule = (delayMs: number, fn: () => void): void => {
    const timer = setTimeout(() => {
      pending.delete(timer)
      fn()
    }, delayMs)
    pending.add(timer)
  }

  schedule(0, () => {
    emitRunEvent({ type: 'run:started', runId, at: Date.now(), model: 'sonnet', effort: null })
  })
  schedule(250, () => {
    emitRunEvent({
      type: 'run:phase',
      runId,
      at: Date.now(),
      phase: 'preparing',
      message: 'Preparing worktree (synthetic)',
    })
  })
  schedule(900, () => {
    emitRunEvent({
      type: 'run:phase',
      runId,
      at: Date.now(),
      phase: 'reviewing',
      message: 'Agent reading the diff (synthetic)',
    })
  })

  let inputTokens = 0
  let outputTokens = 0
  let costUsd = 0
  const toolCalls: Array<{ tool: string; summary: string }> = [
    { tool: 'Grep', summary: 'pattern "TODO" across src/' },
    { tool: 'Read', summary: 'src/main/trpc/router.ts' },
    { tool: 'Bash', summary: 'git diff --stat HEAD~1' },
    { tool: 'Read', summary: 'src/main/db/schema.ts' },
    { tool: 'Glob', summary: '**/*.tsx' },
    { tool: 'Read', summary: 'src/renderer/routes/index.tsx' },
  ]
  toolCalls.forEach((call, index) => {
    schedule(1300 + index * 700, () => {
      emitRunEvent({ type: 'run:tool', runId, at: Date.now(), tool: call.tool, summary: call.summary })
      inputTokens += 900 + Math.floor(Math.random() * 1600)
      outputTokens += 120 + Math.floor(Math.random() * 280)
      costUsd = (inputTokens / 1_000_000) * 3 + (outputTokens / 1_000_000) * 15
      emitRunEvent({
        type: 'run:usage',
        runId,
        at: Date.now(),
        inputTokens,
        outputTokens,
        costUsd,
      })
    })
  })

  schedule(5600, () => {
    emitRunEvent({
      type: 'run:phase',
      runId,
      at: Date.now(),
      phase: 'summarizing',
      message: 'Summarizing findings (synthetic)',
    })
  })
  schedule(6600, () => {
    emitRunEvent({ type: 'run:done', runId, at: Date.now(), findingCount: 3 })
    timers.delete(runId)
  })

  return { runId }
}

export function cancelFakeRun(runId: string): void {
  const pending = timers.get(runId)
  if (!pending) return
  for (const timer of pending) clearTimeout(timer)
  pending.clear()
  timers.delete(runId)
  emitRunEvent({ type: 'run:cancelled', runId, at: Date.now() })
}

/** Kills any in-flight fake runs (wired to before-quit). */
export function disposeFakeRuns(): void {
  for (const [runId, pending] of [...timers]) {
    for (const timer of pending) clearTimeout(timer)
    timers.delete(runId)
  }
}
