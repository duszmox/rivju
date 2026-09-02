import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { CheckCheck, GitCommitHorizontal, LoaderCircle, RefreshCcw } from 'lucide-react'
import { Button } from '#/components/ui/button.tsx'
import { useRuns } from '#/components/runs/runs-store.tsx'
import { useTrpc } from '#/lib/trpc.tsx'
import type { inferRouterOutputs } from '@trpc/server'
import type { AppRouter } from '../../../main/trpc/router.ts'
import type { FindingRow } from '../../../main/db/schema.ts'

type ReviewDetail = inferRouterOutputs<AppRouter>['reviews']['detail']
type ReviewRun = ReviewDetail['runs'][number]

interface Coordinates {
  instanceId: string
  gitlabProjectId: number
  iid: number
}

const LIFECYCLE_LABELS: Record<FindingRow['lifecycle'], string> = {
  open: 'Open',
  fixed: 'Fixed',
  stale: 'Stale',
  moot: 'Moot',
}

/**
 * The Phase 5 action panel: "Check if fixed" (verify run) as the primary
 * action, "Re-review from scratch" as the secondary one, plus lifecycle
 * counts and head-SHA movement since the last completed review.
 */
export function VerifyPanel(props: {
  coordinates: Coordinates
  findings: FindingRow[]
  runs: ReviewRun[]
  labels: string[]
  diffRefs: { baseSha: string; headSha: string } | null
}) {
  const trpc = useTrpc()
  const queryClient = useQueryClient()
  const { runs: liveRuns } = useRuns()
  const anyActive = liveRuns.some(
    (item) => item.status === 'running' || item.status === 'queued',
  )

  const detailKey = trpc.reviews.detail.pathKey()
  const movement = useQuery({
    ...trpc.reviews.movement.queryOptions({
      ...props.coordinates,
      headSha: props.diffRefs?.headSha ?? null,
    }),
    refetchInterval: anyActive ? 4_000 : false,
  })
  const verify = useMutation(
    trpc.runs.verify.mutationOptions({
      onSettled: () =>
        queryClient.invalidateQueries({ queryKey: detailKey }),
    }),
  )
  const start = useMutation(trpc.runs.start.mutationOptions())

  const counts = countLifecycle(props.findings)
  const openCount = props.findings.filter(
    (finding) => finding.lifecycle === 'open' && finding.triage !== 'invalid',
  ).length
  const completed = props.runs.some((item) => item.status === 'done')
  const verifying = props.runs.some(
    (item) =>
      item.kind === 'verify' &&
      (item.status === 'queued' || item.status === 'running'),
  )
  const diffRefs = props.diffRefs

  return (
    <div
      className="island-shell mt-6 flex flex-wrap items-center gap-x-6 gap-y-3 rounded-2xl p-4"
      data-testid="verify-panel"
    >
      <div className="min-w-0">
        <p className="island-kicker">Verification</p>
        <p className="mt-1 text-sm font-semibold text-(--sea-ink)">
          {openCount === 0
            ? 'No eligible open findings — nothing to re-check'
            : `${openCount} open ${openCount === 1 ? 'finding' : 'findings'} to re-check`}
        </p>
        <MovementLine movement={movement.data} />
      </div>

      <div className="ml-auto flex flex-wrap items-center gap-2">
        <LifecycleCounts counts={counts} />
        <Button
          size="sm"
          disabled={
            verifying ||
            verify.isPending ||
            openCount === 0 ||
            !completed
          }
          title={
            !completed
              ? 'Run a full review first — verification compares against a completed review'
              : openCount === 0
                ? 'No eligible open findings to verify'
                : undefined
          }
          onClick={() =>
            verify.mutate({
              ...props.coordinates,
            })
          }
        >
          {verifying || verify.isPending ? (
            <LoaderCircle className="size-4 animate-spin" />
          ) : (
            <CheckCheck className="size-4" />
          )}
          Check if fixed
        </Button>
        {diffRefs ? (
          <Button
            size="sm"
            variant="ghost"
            disabled={start.isPending}
            onClick={() =>
              start.mutate({
                ...props.coordinates,
                baseSha: diffRefs.baseSha,
                headSha: diffRefs.headSha,
                labels: props.labels,
              })
            }
          >
            {start.isPending ? (
              <LoaderCircle className="size-4 animate-spin" />
            ) : (
              <RefreshCcw className="size-4" />
            )}
            Re-review from scratch
          </Button>
        ) : null}
      </div>
      {verify.isError ? (
        <p className="w-full text-xs text-destructive">
          Could not start verification: {verify.error.message}
        </p>
      ) : null}
      {start.isError ? (
        <p className="w-full text-xs text-destructive">
          Could not start re-review: {start.error.message}
        </p>
      ) : null}
    </div>
  )
}

function MovementLine(props: {
  movement:
    | inferRouterOutputs<AppRouter>['reviews']['movement']
    | undefined
}) {
  const movement = props.movement
  if (!movement) {
    return (
      <p className="mt-0.5 text-xs text-(--sea-ink-soft)">
        Checking head position…
      </p>
    )
  }
  if (movement.status === 'no_review') {
    return (
      <p className="mt-0.5 text-xs text-(--sea-ink-soft)">
        No completed review yet.
      </p>
    )
  }
  if (movement.status === 'unknown') {
    return (
      <p className="mt-0.5 text-xs text-(--sea-ink-soft)">
        Head movement unknown: {movement.reason}
      </p>
    )
  }
  if (movement.status === 'current') {
    return (
      <p className="mt-0.5 text-xs text-(--sea-ink-soft)">
        Head is at the reviewed commit
        <span className="ml-1 font-mono">{movement.newHead.slice(0, 8)}</span>
      </p>
    )
  }
  const count =
    movement.commitCount === null
      ? 'New commits'
      : `${movement.commitCount} new ${movement.commitCount === 1 ? 'commit' : 'commits'}`
  const first = movement.commits[0]?.subject
  return (
    <p className="mt-0.5 flex items-center gap-1.5 text-xs text-[var(--lagoon-deep)]">
      <GitCommitHorizontal className="size-3.5 shrink-0" />
      <span className="min-w-0 truncate">
        {count} since this review
        {first ? ` — latest: ${first}` : ''}
      </span>
    </p>
  )
}

function LifecycleCounts(props: {
  counts: Record<FindingRow['lifecycle'], number>
}) {
  const tones: Record<FindingRow['lifecycle'], string> = {
    open: 'text-[var(--lagoon-deep)]',
    fixed: 'text-(--palm)',
    stale: 'text-amber-700',
    moot: 'text-(--sea-ink-soft)',
  }
  const order: FindingRow['lifecycle'][] = ['open', 'fixed', 'stale', 'moot']
  return (
    <div className="flex items-center gap-2 text-xs">
      {order.map((lifecycle) => (
        <span
          key={lifecycle}
          className={`rounded-full border border-[var(--chip-line)] bg-[var(--chip-bg)] px-2 py-0.5 font-semibold ${tones[lifecycle]}`}
        >
          {LIFECYCLE_LABELS[lifecycle]} {props.counts[lifecycle]}
        </span>
      ))}
    </div>
  )
}

function countLifecycle(findings: FindingRow[]): Record<
  FindingRow['lifecycle'],
  number
> {
  const counts = { open: 0, fixed: 0, stale: 0, moot: 0 }
  for (const finding of findings) counts[finding.lifecycle]++
  return counts
}
