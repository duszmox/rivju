const ACTIVE_RUN_STATUSES = new Set(['queued', 'running'])

interface PersistedRunStatus {
  id: string
  status: string
}

interface LiveRunStatus {
  runId: string
  status: string
}

export function hasNewlySettledRun(
  persistedRuns: readonly PersistedRunStatus[],
  liveRuns: readonly LiveRunStatus[],
): boolean {
  const activeRunIds = new Set(
    persistedRuns
      .filter((run) => ACTIVE_RUN_STATUSES.has(run.status))
      .map((run) => run.id),
  )

  return liveRuns.some(
    (run) =>
      activeRunIds.has(run.runId) && !ACTIVE_RUN_STATUSES.has(run.status),
  )
}
