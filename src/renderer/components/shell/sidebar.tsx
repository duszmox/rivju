import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import {
  FolderOpen,
  GitMerge,
  KeyRound,
  Monitor,
  Moon,
  Settings,
  Sparkles,
  Square,
  Sun,
} from 'lucide-react'
import { RivjuLogo } from '#/components/brand/logo.tsx'
import { Button } from '#/components/ui/button.tsx'
import { classifyFailure } from '../../../main/errors.ts'
import { useTrpc } from '#/lib/trpc.tsx'
import { useRuns } from '../runs/runs-store.tsx'

const STATUS_STYLES: Record<string, { dot: string; label: string }> = {
  queued: { dot: 'bg-[var(--sea-ink-soft)]', label: 'text-(--sea-ink-soft)' },
  running: {
    dot: 'bg-[var(--lagoon-deep)] animate-pulse',
    label: 'text-(--palm)',
  },
  done: { dot: 'bg-[var(--palm)]', label: 'text-(--palm)' },
  failed: { dot: 'bg-destructive', label: 'text-destructive' },
  cancelled: {
    dot: 'bg-[var(--sea-ink-soft)]',
    label: 'text-(--sea-ink-soft)',
  },
}

/** Compact "2h ago" / "3d ago" rendering for a recently-reviewed timestamp. */
function timeAgo(date: Date): string {
  const seconds = Math.max(0, Math.floor((Date.now() - date.getTime()) / 1000))
  if (seconds < 60) return 'just now'
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return `${days}d ago`
}

/** Compact failure line: the specific title plus the recovery action on hover. */
function FailureLine({ raw }: { raw: string }) {
  const error = classifyFailure(raw)
  return (
    <p
      className="mt-1 truncate text-[10px] text-destructive"
      title={`${error.title}\n\n${error.recovery}`}
    >
      {error.title}
    </p>
  )
}

export function Sidebar() {
  const trpc = useTrpc()
  const queryClient = useQueryClient()
  const { runs, connected } = useRuns()
  const preflight = useQuery(trpc.system.preflight.queryOptions(undefined))
  const cancel = useMutation(trpc.runs.cancel.mutationOptions())
  const theme = useQuery(trpc.settings.uiTheme.queryOptions())
  const setTheme = useMutation(trpc.settings.setUiTheme.mutationOptions())
  const recentProjects = useQuery(
    trpc.projects.recentlyReviewed.queryOptions({ limit: 5 }),
  )

  // system -> light -> dark -> system
  const current = theme.data ?? 'system'
  const next =
    current === 'system' ? 'light' : current === 'light' ? 'dark' : 'system'
  const ThemeIcon =
    current === 'system' ? Monitor : current === 'light' ? Sun : Moon

  const cycleTheme = (): void => {
    setTheme.mutate(
      { theme: next },
      {
        onSuccess: () =>
          void queryClient.invalidateQueries({
            queryKey: trpc.settings.uiTheme.pathKey(),
          }),
      },
    )
  }

  return (
    <aside className="flex h-full w-80 shrink-0 flex-col border-r border-[var(--line)] bg-[var(--foam)]">
      <div className="flex items-center gap-3 border-b border-[var(--line)] px-4 py-4">
        <RivjuLogo className="size-9 shrink-0 rounded-xl shadow-sm" />
        <div className="min-w-0 flex-1">
          <p className="font-bold leading-tight text-(--sea-ink)">rivju</p>
          <p className="text-xs text-(--sea-ink-soft)">
            run stream {connected ? 'live' : 'connecting…'}
          </p>
        </div>
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={cycleTheme}
          disabled={setTheme.isPending}
          title={`Theme: ${current} — switch to ${next}`}
        >
          <ThemeIcon className="size-4" />
        </Button>
      </div>

      {preflight.data?.status === 'ok' && (
        <div className="border-b border-[var(--line)] px-4 py-3 text-xs leading-relaxed text-(--sea-ink-soft)">
          <p className="truncate">
            claude: {preflight.data.account?.email ?? 'logged in'}
            {preflight.data.fromCache ? ' (cached)' : ''}
          </p>
          <p>{preflight.data.models.length} models available</p>
        </div>
      )}

      <nav className="space-y-1 border-b border-[var(--line)] px-3 py-3">
        <Link
          to="/"
          className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-sm text-(--sea-ink-soft) hover:bg-[var(--link-bg-hover)] hover:text-(--sea-ink)"
          activeProps={{
            className: 'bg-[var(--link-bg-hover)] text-(--sea-ink) font-medium',
          }}
        >
          <GitMerge className="size-4" /> Review queue
        </Link>
        <Link
          to="/instances"
          className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-sm text-(--sea-ink-soft) hover:bg-[var(--link-bg-hover)] hover:text-(--sea-ink)"
          activeProps={{
            className: 'bg-[var(--link-bg-hover)] text-(--sea-ink) font-medium',
          }}
        >
          <KeyRound className="size-4" /> GitLab instances
        </Link>
        <Link
          to="/skills"
          className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-sm text-(--sea-ink-soft) hover:bg-[var(--link-bg-hover)] hover:text-(--sea-ink)"
          activeProps={{
            className: 'bg-[var(--link-bg-hover)] text-(--sea-ink) font-medium',
          }}
        >
          <Sparkles className="size-4" /> Skills
        </Link>
        <Link
          to="/settings"
          className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-sm text-(--sea-ink-soft) hover:bg-[var(--link-bg-hover)] hover:text-(--sea-ink)"
          activeProps={{
            className: 'bg-[var(--link-bg-hover)] text-(--sea-ink) font-medium',
          }}
        >
          <Settings className="size-4" /> Settings
        </Link>
      </nav>

      <details className="border-b border-[var(--line)] px-3 py-2 [&_summary::-webkit-details-marker]:hidden">
        <summary className="flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-sm text-(--sea-ink-soft) hover:bg-[var(--link-bg-hover)] hover:text-(--sea-ink)">
          <FolderOpen className="size-4" /> Projects
        </summary>
        <div className="mt-1 space-y-0.5 pb-1">
          {recentProjects.isPending ? (
            <p className="px-2 py-1 text-xs text-(--sea-ink-soft)">
              Loading…
            </p>
          ) : null}
          {recentProjects.data?.length === 0 ? (
            <p className="px-2 py-1 text-xs text-(--sea-ink-soft)">
              No projects reviewed yet.
            </p>
          ) : null}
          {recentProjects.data?.map((p) => (
            <Link
              key={`${p.instanceId}-${p.gitlabProjectId}`}
              to="/instances/$instanceId"
              params={{ instanceId: p.instanceId }}
              className="flex items-center justify-between gap-2 truncate rounded-lg px-2 py-1.5 text-xs text-(--sea-ink-soft) hover:bg-[var(--link-bg-hover)] hover:text-(--sea-ink)"
              title={p.pathWithNamespace}
            >
              <span className="truncate">{p.pathWithNamespace}</span>
              <span className="shrink-0 text-[10px] text-(--sea-ink-soft)">
                {timeAgo(new Date(p.lastReviewedAt))}
              </span>
            </Link>
          ))}
          <Button asChild variant="ghost" size="sm" className="mt-1 w-full">
            <Link to="/projects">See all projects</Link>
          </Button>
        </div>
      </details>

      <div className="flex-1 space-y-2 overflow-y-auto p-3">
        {runs.length === 0 ? (
          <p className="px-1 py-6 text-center text-xs text-(--sea-ink-soft)">
            No runs yet. Start a review from a merge request.
          </p>
        ) : (
          runs.map((run) => {
            const style = STATUS_STYLES[run.status]
            const destination =
              run.instanceId !== null &&
              run.gitlabProjectId !== null &&
              run.iid !== null
                ? {
                    instanceId: run.instanceId,
                    gitlabProjectId: String(run.gitlabProjectId),
                    iid: String(run.iid),
                  }
                : null
            const live = run.status === 'queued' || run.status === 'running'
            // Runs hydrated from the database after a restart carry no phase or
            // tool activity, so there is nothing to say about them — only a run
            // that is still in flight can be "waiting".
            const description =
              run.lastTool ??
              run.message ??
              (run.status === 'queued' ? `queue position ${run.queuePosition ?? '…'}` : run.phase) ??
              (live ? 'waiting…' : null)
            const content = (
              <>
                <div className="flex items-center justify-between gap-2 pr-7">
                  <span className="flex items-center gap-2">
                    <span className={`size-2 rounded-full ${style.dot}`} />
                    <span className="font-mono text-xs text-(--sea-ink-soft)">
                      {run.runId.slice(0, 8)}
                    </span>
                    <span className={`text-xs font-medium ${style.label}`}>
                      {run.status}
                    </span>
                  </span>
                </div>

                {run.sourceBranch ? (
                  <p className="mt-1 truncate font-mono text-[10px] text-(--sea-ink-soft)">
                    {run.sourceBranch}
                    {run.targetBranch ? ` → ${run.targetBranch}` : ''}
                  </p>
                ) : null}

                {description ? (
                  <p className="mt-1 truncate text-xs text-(--sea-ink)">{description}</p>
                ) : null}

                <div className="mt-2 flex items-center justify-between font-mono text-[10px] text-(--sea-ink-soft)">
                  <span>
                    {run.inputTokens.toLocaleString()} in /{' '}
                    {run.outputTokens.toLocaleString()} out
                  </span>
                  <span>${run.costUsd.toFixed(4)}</span>
                </div>

                {run.status === 'done' && (
                  <p className="mt-1 text-[10px] text-(--palm)">
                    {run.findingCount ?? 0} findings
                  </p>
                )}
                {run.status === 'failed' && run.message ? (
                  <FailureLine raw={run.message} />
                ) : null}
              </>
            )
            return (
              <div
                key={run.runId}
                className="relative rounded-xl border border-[var(--line)] bg-[var(--surface)] shadow-sm"
              >
                {destination ? (
                  <Link
                    to="/mrs/$instanceId/$gitlabProjectId/$iid"
                    params={destination}
                    search={{ runId: run.runId }}
                    className="block rounded-xl p-3 transition-colors hover:bg-[var(--link-bg-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--lagoon-deep)]"
                    aria-label={`Open review run ${run.runId.slice(0, 8)}`}
                  >
                    {content}
                  </Link>
                ) : (
                  <div className="p-3">{content}</div>
                )}
                {(run.status === 'running' || run.status === 'queued') && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="absolute right-2 top-2 h-6 w-6 p-0"
                    onClick={() => cancel.mutate({ runId: run.runId })}
                    title="Cancel run"
                  >
                    <Square className="size-3" />
                  </Button>
                )}
              </div>
            )
          })
        )}
      </div>

      <div className="border-t border-[var(--line)] px-4 py-3 text-[10px] text-(--sea-ink-soft)">
        Agentic review for GitLab merge requests
      </div>
    </aside>
  )
}
