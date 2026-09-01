import { useMutation, useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { Bot, GitMerge, KeyRound, LoaderCircle, Play, Square } from 'lucide-react'
import { Button } from '#/components/ui/button.tsx'
import { useTrpc } from '#/lib/trpc.tsx'
import { useRuns } from '../runs/runs-store.tsx'

const STATUS_STYLES: Record<string, { dot: string; label: string }> = {
  running: { dot: 'bg-[var(--lagoon-deep)] animate-pulse', label: 'text-[var(--palm)]' },
  done: { dot: 'bg-[var(--palm)]', label: 'text-[var(--palm)]' },
  failed: { dot: 'bg-destructive', label: 'text-destructive' },
  cancelled: { dot: 'bg-[var(--sea-ink-soft)]', label: 'text-[var(--sea-ink-soft)]' },
}

export function Sidebar() {
  const trpc = useTrpc()
  const { runs, connected } = useRuns()
  const preflight = useQuery(trpc.system.preflight.queryOptions(undefined))
  const fakeStart = useMutation(trpc.runs.fakeStart.mutationOptions())
  const fakeCancel = useMutation(trpc.runs.fakeCancel.mutationOptions())

  return (
    <aside className="flex h-full w-80 shrink-0 flex-col border-r border-[var(--line)] bg-[var(--foam)]">
      <div className="flex items-center gap-3 border-b border-[var(--line)] px-4 py-4">
        <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-[var(--hero-b)]">
          <Bot className="size-5 text-[var(--palm)]" />
        </span>
        <div>
          <p className="font-bold text-[var(--sea-ink)]">rivju</p>
          <p className="text-xs text-[var(--sea-ink-soft)]">
            run stream {connected ? 'live' : 'connecting…'}
          </p>
        </div>
      </div>

      {preflight.data?.status === 'ok' && (
        <div className="border-b border-[var(--line)] px-4 py-3 text-xs leading-relaxed text-[var(--sea-ink-soft)]">
          <p className="truncate">
            claude: {preflight.data.account?.email ?? 'logged in'}
            {preflight.data.fromCache ? ' (cached)' : ''}
          </p>
          <p>{preflight.data.models.length} models available</p>
        </div>
      )}

      {import.meta.env.DEV && (
        <div className="border-b border-[var(--line)] px-4 py-3">
          <Button
            className="w-full"
            onClick={() => fakeStart.mutate()}
            disabled={fakeStart.isPending}
          >
            {fakeStart.isPending ? (
              <LoaderCircle className="size-4 animate-spin" />
            ) : (
              <Play className="size-4" />
            )}
            Start fake run
          </Button>
        </div>
      )}

      <nav className="space-y-1 border-b border-[var(--line)] px-3 py-3">
        <Link
          to="/"
          className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-sm text-[var(--sea-ink-soft)] hover:bg-[var(--link-bg-hover)] hover:text-[var(--sea-ink)]"
          activeProps={{ className: 'bg-[var(--link-bg-hover)] text-[var(--sea-ink)] font-medium' }}
        >
          <GitMerge className="size-4" /> Review queue
        </Link>
        <Link
          to="/instances"
          className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-sm text-[var(--sea-ink-soft)] hover:bg-[var(--link-bg-hover)] hover:text-[var(--sea-ink)]"
          activeProps={{ className: 'bg-[var(--link-bg-hover)] text-[var(--sea-ink)] font-medium' }}
        >
          <KeyRound className="size-4" /> GitLab instances
        </Link>
      </nav>

      <div className="flex-1 space-y-2 overflow-y-auto p-3">
        {runs.length === 0 ? (
          <p className="px-1 py-6 text-center text-xs text-[var(--sea-ink-soft)]">
            No runs yet. Real reviews arrive in Phase 3.
          </p>
        ) : (
          runs.map((run) => {
            const style = STATUS_STYLES[run.status]
            return (
              <div
                key={run.runId}
                className="rounded-xl border border-[var(--line)] bg-[var(--surface)] p-3 shadow-sm"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="flex items-center gap-2">
                    <span className={`size-2 rounded-full ${style.dot}`} />
                    <span className="font-mono text-xs text-[var(--sea-ink-soft)]">
                      {run.runId.slice(0, 8)}
                    </span>
                    <span className={`text-xs font-medium ${style.label}`}>{run.status}</span>
                  </span>
                  {run.status === 'running' && (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-6 w-6 p-0"
                      onClick={() => fakeCancel.mutate({ runId: run.runId })}
                      title="Cancel run"
                    >
                      <Square className="size-3" />
                    </Button>
                  )}
                </div>

                <p className="mt-1 truncate text-xs text-[var(--sea-ink)]">
                  {run.lastTool ?? run.message ?? run.phase ?? 'waiting…'}
                </p>

                <div className="mt-2 flex items-center justify-between font-mono text-[10px] text-[var(--sea-ink-soft)]">
                  <span>
                    {run.inputTokens.toLocaleString()} in / {run.outputTokens.toLocaleString()} out
                  </span>
                  <span>${run.costUsd.toFixed(4)}</span>
                </div>

                {run.status === 'done' && (
                  <p className="mt-1 text-[10px] text-[var(--palm)]">
                    {run.findingCount ?? 0} findings
                  </p>
                )}
                {run.status === 'failed' && (
                  <p className="mt-1 truncate text-[10px] text-destructive">{run.message}</p>
                )}
              </div>
            )
          })
        )}
      </div>

      <div className="border-t border-[var(--line)] px-4 py-3 text-[10px] text-[var(--sea-ink-soft)]">
        Phase 1 — GitLab instances, projects, MR listing
      </div>
    </aside>
  )
}
