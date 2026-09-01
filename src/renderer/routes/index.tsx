import { useQuery } from '@tanstack/react-query'
import { Link, createFileRoute } from '@tanstack/react-router'
import { ArrowRight, GitMerge, RefreshCw } from 'lucide-react'
import { Button } from '#/components/ui/button.tsx'
import { ErrorSurface } from '#/components/errors/error-surface.tsx'
import { FirstRunGuide } from '#/components/onboarding/first-run-guide.tsx'
import { useTrpc } from '#/lib/trpc.tsx'

export const Route = createFileRoute('/')({ component: ReviewQueue })

function ReviewQueue() {
  const trpc = useTrpc()
  const queue = useQuery(trpc.mergeRequests.reviewQueue.queryOptions())
  const instances = useQuery(trpc.instances.list.queryOptions())

  return (
    <div className="mx-auto max-w-4xl px-8 py-10">
      <div className="flex items-center justify-between gap-4">
        <div>
          <p className="island-kicker">Review queue</p>
          <h1 className="display-title mt-1 text-3xl font-bold text-(--sea-ink)">
            Merge requests awaiting your review
          </h1>
          <p className="mt-1 text-sm text-(--sea-ink-soft)">
            MRs where you are reviewer or assignee, across all connected
            instances. Fetched live.
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => queue.refetch()}
          disabled={queue.isFetching}
        >
          <RefreshCw className={queue.isFetching ? 'size-4 animate-spin' : 'size-4'} />
          Refresh
        </Button>
      </div>

      <FirstRunGuide />

      {queue.data?.instanceErrors.map((error) => (
        <div key={error.instanceId} className="mt-4">
          <ErrorSurface heading={error.instanceLabel} raw={error.message} />
        </div>
      ))}

      {queue.isPending ? (
        <p className="mt-8 text-sm text-(--sea-ink-soft)">Loading review queue…</p>
      ) : null}

      {queue.data && queue.data.items.length === 0 && instances.data?.length !== 0 ? (
        <p className="mt-8 text-sm text-(--sea-ink-soft)">
          Nothing waiting for review right now.
        </p>
      ) : null}

      <ul className="mt-6 space-y-2">
        {queue.data?.items.map((mr) => (
          <li key={`${mr.instanceId}-${mr.gitlabProjectId}-${mr.iid}`}>
            <Link
              to="/mrs/$instanceId/$gitlabProjectId/$iid"
              params={{
                instanceId: mr.instanceId,
                gitlabProjectId: String(mr.gitlabProjectId),
                iid: String(mr.iid),
              }}
              className="island-shell flex items-center gap-4 rounded-xl p-4 hover:-translate-y-px"
            >
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-[var(--hero-b)]">
                <GitMerge className="size-4 text-(--palm)" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate font-medium text-(--sea-ink)">
                  {mr.title}
                  {mr.draft ? (
                    <span className="ml-2 rounded bg-[var(--chip-bg)] px-1.5 py-0.5 text-[10px] font-semibold text-(--sea-ink-soft)">
                      draft
                    </span>
                  ) : null}
                </span>
                <span className="mt-0.5 block truncate text-xs text-(--sea-ink-soft)">
                  {mr.projectPath ?? mr.instanceLabel} · {mr.sourceBranch} → {mr.targetBranch}
                  {mr.author ? ` · by ${mr.author}` : ''}
                </span>
              </span>
              <span className="shrink-0 font-mono text-xs text-(--sea-ink-soft)">
                !{mr.iid}
              </span>
              <ArrowRight className="size-4 shrink-0 text-(--sea-ink-soft)" />
            </Link>
          </li>
        ))}
      </ul>
    </div>
  )
}
