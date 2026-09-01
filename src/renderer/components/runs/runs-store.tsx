import type { RunEvent } from '../../../main/events/bus.ts'
import { createContext, useContext, useEffect, useMemo, useState  } from 'react'
import type {ReactNode} from 'react';
import { useTrpcClient } from '#/lib/trpc.tsx'

export interface RunSummary {
  runId: string
  status: 'queued' | 'running' | 'done' | 'failed' | 'cancelled'
  phase: string | null
  message: string | null
  lastTool: string | null
  inputTokens: number
  outputTokens: number
  costUsd: number
  findingCount: number | null
  queuePosition: number | null
  startedAt: number
  endedAt: number | null
  instanceId: string | null
  gitlabProjectId: number | null
  iid: number | null
  sourceBranch: string | null
  targetBranch: string | null
}

type RunsMap = Record<string, RunSummary>

function emptySummary(runId: string): RunSummary {
  return {
    runId,
    status: 'queued',
    phase: null,
    message: null,
    lastTool: null,
    inputTokens: 0,
    outputTokens: 0,
    costUsd: 0,
    findingCount: null,
    queuePosition: null,
    startedAt: Date.now(),
    endedAt: null,
    instanceId: null,
    gitlabProjectId: null,
    iid: null,
    sourceBranch: null,
    targetBranch: null,
  }
}

function applyEvent(prev: RunsMap, event: RunEvent): RunsMap {
  const run = prev[event.runId] ?? emptySummary(event.runId)
  switch (event.type) {
    case 'run:queued':
      return {
        ...prev,
        [event.runId]: {
          ...run,
          status: 'queued',
          queuePosition: event.position,
          instanceId: event.instanceId,
          gitlabProjectId: event.gitlabProjectId,
          iid: event.iid,
          sourceBranch: event.sourceBranch,
          targetBranch: event.targetBranch,
        },
      }
    case 'run:started':
      return { ...prev, [event.runId]: { ...run, status: 'running', queuePosition: null, startedAt: event.at } }
    case 'run:phase':
      return { ...prev, [event.runId]: { ...run, phase: event.phase, message: event.message } }
    case 'run:tool':
      return { ...prev, [event.runId]: { ...run, lastTool: `${event.tool} · ${event.summary}` } }
    case 'run:usage':
      return {
        ...prev,
        [event.runId]: {
          ...run,
          inputTokens: event.inputTokens,
          outputTokens: event.outputTokens,
          costUsd: event.costUsd,
        },
      }
    case 'run:done':
      return {
        ...prev,
        [event.runId]: { ...run, status: 'done', findingCount: event.findingCount, endedAt: event.at },
      }
    case 'run:finding':
      return { ...prev, [event.runId]: { ...run, findingCount: (run.findingCount ?? 0) + 1 } }
    case 'run:failed':
      return { ...prev, [event.runId]: { ...run, status: 'failed', message: event.error, endedAt: event.at } }
    case 'run:cancelled':
      return { ...prev, [event.runId]: { ...run, status: 'cancelled', endedAt: event.at } }
  }
}

interface RunsState {
  runs: RunSummary[]
  connected: boolean
}

const RunsContext = createContext<RunsState | null>(null)

/**
 * Single subscription for the whole app, mounted once above the router.
 * Runs are derived purely from the run:* event stream.
 */
export function RunsProvider({ children }: { children: ReactNode }) {
  const client = useTrpcClient()
  const [runs, setRuns] = useState<RunsMap>({})
  const [connected, setConnected] = useState(false)

  useEffect(() => {
    const subscription = client.runs.watch.subscribe(undefined, {
      onStarted: () => setConnected(true),
      onData: (event) => {
        setRuns((prev) => applyEvent(prev, event))
      },
      onError: () => setConnected(false),
    })
    void client.runs.list.query().then((rows) => {
      setRuns((current) => {
        const hydrated = { ...current }
        for (const row of rows) {
          // The subscription is established first. Never overwrite a newer
          // event-derived summary with this point-in-time database snapshot.
          if (Object.hasOwn(hydrated, row.id)) continue
          hydrated[row.id] = {
            ...emptySummary(row.id),
            status: row.status === 'interrupted' ? 'failed' : row.status,
            message: row.error,
            inputTokens: row.usage?.inputTokens ?? 0,
            outputTokens: row.usage?.outputTokens ?? 0,
            costUsd: row.usage?.costUsd ?? 0,
            startedAt: row.startedAt ? new Date(row.startedAt).getTime() : Date.now(),
            endedAt: row.endedAt ? new Date(row.endedAt).getTime() : null,
            instanceId: row.instanceId,
            gitlabProjectId: row.gitlabProjectId,
            iid: row.iid,
            sourceBranch: row.sourceBranch,
            targetBranch: row.targetBranch,
          }
        }
        return hydrated
      })
    })
    return () => {
      subscription.unsubscribe()
      setConnected(false)
    }
  }, [client])

  const value = useMemo<RunsState>(() => {
    const list = Object.values(runs).sort((a, b) => b.startedAt - a.startedAt)
    return { runs: list, connected }
  }, [runs, connected])

  return <RunsContext.Provider value={value}>{children}</RunsContext.Provider>
}

export function useRuns(): RunsState {
  const state = useContext(RunsContext)
  if (!state) throw new Error('useRuns must be used inside <RunsProvider>')
  return state
}
