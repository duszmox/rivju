export type RunPhase =
  | 'queued'
  | 'preparing'
  | 'reviewing'
  | 'summarizing'
  | 'done'
  | 'failed'
  | 'cancelled'

export type RunEvent =
  | {
      type: 'run:started'
      runId: string
      at: number
      model?: string | null
      effort?: string | null
    }
  | { type: 'run:phase'; runId: string; at: number; phase: RunPhase; message: string }
  | { type: 'run:tool'; runId: string; at: number; tool: string; summary: string }
  | {
      type: 'run:usage'
      runId: string
      at: number
      inputTokens: number
      outputTokens: number
      costUsd: number
    }
  | { type: 'run:done'; runId: string; at: number; findingCount: number }
  | { type: 'run:failed'; runId: string; at: number; error: string }
  | { type: 'run:cancelled'; runId: string; at: number }

type Listener = (event: RunEvent) => void

const listeners = new Set<Listener>()

/** Broadcast a run lifecycle event to every live subscriber (tRPC `runs.watch`). */
export function emitRunEvent(event: RunEvent): void {
  for (const listener of [...listeners]) listener(event)
}

export function onRunEvent(listener: Listener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export interface RunEventStream extends AsyncIterable<RunEvent> {
  /** Ends the stream: pending and future next() calls resolve as done. */
  close: () => void
}

/**
 * Independent per-subscriber stream over the bus. `close()` makes a pending
 * next() resolve with done, which is what unwinds the tRPC subscription
 * generator when a client unsubscribes.
 */
export function runEventStream(): RunEventStream {
  const queue: RunEvent[] = []
  let closed = false
  let wake: (() => void) | null = null

  const off = onRunEvent((event) => {
    queue.push(event)
    wake?.()
    wake = null
  })

  const iterator: AsyncIterator<RunEvent> = {
    next: () =>
      new Promise<IteratorResult<RunEvent>>((resolve) => {
        const attempt = (): void => {
          const event = queue.shift()
          if (event) resolve({ value: event, done: false })
          else if (closed) resolve({ value: undefined, done: true })
          else wake = attempt
        }
        attempt()
      }),
    return: async () => {
      closed = true
      off()
      wake?.()
      wake = null
      return { value: undefined, done: true }
    },
  }

  return {
    [Symbol.asyncIterator]: () => iterator,
    close: () => {
      closed = true
      off()
      wake?.()
      wake = null
    },
  }
}
