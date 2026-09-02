import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute, Link } from '@tanstack/react-router'
import {
  CheckCircle2,
  FileCode,
  FileMinus,
  FilePlus,
  FilePen,
  GitMerge,
  LoaderCircle,
  Play,
  RefreshCw,
} from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { Button } from '#/components/ui/button.tsx'
import { Markdown } from '#/components/ui/markdown.tsx'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '#/components/ui/select.tsx'
import { ErrorSurface } from '#/components/errors/error-surface.tsx'
import { INHERIT, inheritModelLabel } from '#/lib/model-select.ts'
import { useTrpc } from '#/lib/trpc.tsx'
import { ReviewWorkspace } from '#/components/review/review-workspace.tsx'

export const Route = createFileRoute('/mrs/$instanceId/$gitlabProjectId/$iid')({
  validateSearch: (search: Record<string, unknown>): { runId?: string } => ({
    ...(typeof search.runId === 'string' ? { runId: search.runId } : {}),
  }),
  component: MergeRequestDetail,
})

function MergeRequestDetail() {
  const { instanceId, gitlabProjectId, iid } = Route.useParams()
  const { runId } = Route.useSearch()
  const trpc = useTrpc()
  const queryClient = useQueryClient()
  const coordinates = {
    instanceId,
    gitlabProjectId: Number(gitlabProjectId),
    iid: Number(iid),
  }
  const detailOptions = trpc.mergeRequests.detail.queryOptions(coordinates, {
    staleTime: 0,
    refetchOnMount: 'always',
  })

  const detail = useQuery(detailOptions)
  const pullLatest = useMutation(
    trpc.mergeRequests.pullLatest.mutationOptions({
      onSuccess: (latest) => {
        queryClient.setQueryData(detailOptions.queryKey, latest)
      },
    }),
  )

  if (detail.isPending) {
    return (
      <div className="px-8 py-10 text-sm text-(--sea-ink-soft)">
        Loading merge request…
      </div>
    )
  }
  if (detail.isError) {
    return (
      <div className="mx-auto max-w-3xl px-8 py-10">
        <ErrorSurface
          heading="Failed to load merge request"
          raw={
            detail.error instanceof Error
              ? detail.error.message
              : String(detail.error)
          }
          onRetry={() => void detail.refetch()}
          retrying={detail.isRefetching}
        />
        <Link to="/" className="mt-4 inline-block text-sm">
          ← Back to review queue
        </Link>
      </div>
    )
  }

  const {
    mr,
    description,
    labels,
    diffRefs,
    files,
    hasNewVersion,
    previousHeadSha,
    totalAdditions,
    totalDeletions,
    lineStatsComplete,
  } = detail.data
  const totalChangedLines = totalAdditions + totalDeletions

  return (
    <div className="mx-auto max-w-[1600px] px-8 py-10">
      <Link to="/" className="text-xs text-(--sea-ink-soft)">
        ← Review queue
      </Link>

      <div className="mt-3 flex flex-wrap items-start justify-between gap-6">
        <div className="min-w-0">
          <p className="island-kicker flex items-center gap-2">
            <GitMerge className="size-3.5" />
            <Link
              to={`/instances/$instanceId`}
              className="text-(--sea-ink-soft)"
              params={{ instanceId: instanceId }}
            >
              {mr.projectPath ?? mr.instanceLabel}
            </Link>
            ·{' '}
            <a
              href={mr.webUrl}
              target="_blank"
              rel="noreferrer"
              className="flex shrink-0 items-center gap-1.5 text-sm text-(--lagoon-deep)"
            >
              !{mr.iid}
            </a>
          </p>
          <h1 className="display-title mt-1 text-3xl font-bold text-(--sea-ink)">
            {mr.title}
          </h1>
        </div>
        <div className="flex flex-wrap items-stretch justify-end gap-3">
          <div className="island-shell flex items-center gap-4 rounded-xl px-4 py-2.5">
            <div>
              <p className="text-xl font-bold text-(--sea-ink)">
                {lineStatsComplete
                  ? totalChangedLines
                  : `≥${totalChangedLines}`}
              </p>
              <p className="text-[10px] uppercase tracking-wide text-(--sea-ink-soft)">
                lines changed
              </p>
            </div>
            <div className="flex gap-2 font-mono text-sm font-bold">
              <span className="text-(--palm)">+{totalAdditions}</span>
              <span className="text-destructive">−{totalDeletions}</span>
            </div>
          </div>
        </div>
      </div>

      {hasNewVersion && diffRefs ? (
        <div className="mt-5 rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm dark:border-amber-700 dark:bg-amber-950/30">
          <div>
            <p className="font-semibold text-amber-800 dark:text-amber-300">
              A newer merge request version is available
            </p>
            <p className="mt-0.5 font-mono text-xs text-amber-700 dark:text-amber-400">
              {previousHeadSha?.slice(0, 8)} → {diffRefs.headSha.slice(0, 8)}
            </p>
          </div>
        </div>
      ) : null}

      <dl className="island-shell mt-6 grid grid-cols-2 gap-x-8 gap-y-3 rounded-2xl p-6 text-sm sm:grid-cols-3">
        <div>
          <dt className="text-xs text-(--sea-ink-soft)">Source branch</dt>
          <dd className="mt-0.5 font-mono text-(--sea-ink)">
            {mr.sourceBranch}
          </dd>
        </div>
        <div>
          <dt className="text-xs text-(--sea-ink-soft)">Target branch</dt>
          <dd className="mt-0.5 font-mono text-(--sea-ink)">
            {mr.targetBranch}
          </dd>
        </div>
        <div>
          <dt className="text-xs text-(--sea-ink-soft)">Author</dt>
          <dd className="mt-0.5 text-(--sea-ink)">{mr.author ?? '—'}</dd>
        </div>
        <div>
          <dt className="text-xs text-(--sea-ink-soft)">State</dt>
          <dd className="mt-0.5 text-(--sea-ink)">{mr.state}</dd>
        </div>
        <div className="col-span-2 sm:col-span-3">
          <dt className="text-xs text-(--sea-ink-soft)">Diff refs</dt>
          {diffRefs ? (
            <dd className="mt-1 grid gap-1 font-mono text-xs text-(--sea-ink)">
              <span>base: {diffRefs.baseSha}</span>
              <span>head: {diffRefs.headSha}</span>
              <span>start: {diffRefs.startSha}</span>
            </dd>
          ) : (
            <dd className="mt-0.5 text-(--sea-ink-soft)">
              not reported by GitLab
            </dd>
          )}
        </div>
      </dl>

      {diffRefs ? (
        <RepositoryPreparation
          instanceId={instanceId}
          gitlabProjectId={Number(gitlabProjectId)}
          iid={Number(iid)}
          baseSha={diffRefs.baseSha}
          headSha={diffRefs.headSha}
          labels={labels}
          hasNewVersion={hasNewVersion}
          pullPending={pullLatest.isPending}
          pullError={pullLatest.isError ? pullLatest.error.message : null}
          onPull={() => pullLatest.mutate(coordinates)}
        />
      ) : null}

      {description ? (
        <div className="mt-6 rounded-2xl border border-[var(--line)] bg-[var(--surface)] p-5">
          <p className="text-xs font-semibold text-(--sea-ink-soft)">
            Description
          </p>
          <Markdown
            value={description}
            baseUrl={mr.webUrl}
            className="mt-2 text-sm text-(--sea-ink)"
          />
        </div>
      ) : null}

      <h2 className="mt-8 text-sm font-semibold text-(--sea-ink)">
        Changed files{' '}
        <span className="text-(--sea-ink-soft)">({files.length})</span>
      </h2>
      <ul className="mt-3 space-y-1.5">
        {files.map((file) => (
          <li
            key={`${file.oldPath}:${file.newPath}`}
            className="flex items-center gap-2.5 rounded-lg border border-[var(--line)] bg-[var(--surface)] px-3 py-2"
          >
            {file.newFile ? (
              <FilePlus className="size-4 shrink-0 text-(--palm)" />
            ) : file.deletedFile ? (
              <FileMinus className="size-4 shrink-0 text-destructive" />
            ) : file.renamedFile ? (
              <FilePen className="size-4 shrink-0 text-[var(--lagoon-deep)]" />
            ) : (
              <FileCode className="size-4 shrink-0 text-(--sea-ink-soft)" />
            )}
            <span className="truncate font-mono text-xs text-(--sea-ink)">
              {file.newPath}
            </span>
            {file.renamedFile && file.oldPath !== file.newPath ? (
              <span className="shrink-0 text-[10px] text-(--sea-ink-soft)">
                (renamed from {file.oldPath})
              </span>
            ) : null}
            <span className="ml-auto flex shrink-0 gap-2 font-mono text-[11px] font-semibold">
              <span className="text-(--palm)">+{file.additions}</span>
              <span className="text-destructive">−{file.deletions}</span>
            </span>
          </li>
        ))}
      </ul>

      <ReviewWorkspace
        instanceId={instanceId}
        gitlabProjectId={Number(gitlabProjectId)}
        iid={Number(iid)}
        labels={labels}
        diffRefs={diffRefs}
        initialRunId={runId}
      />
    </div>
  )
}

function RepositoryPreparation(props: {
  instanceId: string
  gitlabProjectId: number
  iid: number
  baseSha: string
  headSha: string
  labels: string[]
  hasNewVersion: boolean
  pullPending: boolean
  pullError: string | null
  onPull: () => void
}) {
  const trpc = useTrpc()
  const prepare = useMutation(trpc.repos.prepare.mutationOptions())
  const status = useQuery({
    ...trpc.repos.status.queryOptions({
      instanceId: props.instanceId,
      gitlabProjectId: props.gitlabProjectId,
      iid: props.iid,
    }),
    refetchInterval: (query) => {
      const phase = query.state.data?.phase
      if (prepare.isPending) return 300
      return phase === 'ready' || phase === 'needs_scoping' || phase === 'error'
        ? false
        : 300
    },
  })
  const preflight = useQuery(trpc.system.preflight.queryOptions(undefined))
  // The "Default" entries below must name what the layered settings actually
  // resolve to (global -> project), not simply the first model in the catalog.
  const effective = useQuery(
    trpc.settings.effective.queryOptions({
      instanceId: props.instanceId,
      gitlabProjectId: props.gitlabProjectId,
    }),
  )
  const start = useMutation(trpc.runs.start.mutationOptions())
  const [model, setModel] = useState<string>(INHERIT)
  const [effort, setEffort] = useState<string>(INHERIT)
  const selectedModel = useMemo(() => {
    if (preflight.data?.status !== 'ok') return null
    const resolved = effective.data?.model ?? preflight.data.models[0]?.value
    const wanted = model === INHERIT ? resolved : model
    return preflight.data.models.find(
      (item) => item.value === wanted || item.resolvedModel === wanted,
    )
  }, [model, preflight.data, effective.data])

  useEffect(() => {
    if (props.hasNewVersion) return
    prepare.mutate(
      {
        instanceId: props.instanceId,
        gitlabProjectId: props.gitlabProjectId,
        iid: props.iid,
        baseSha: props.baseSha,
        headSha: props.headSha,
      },
      { onSettled: () => void status.refetch() },
    )
  }, [
    props.instanceId,
    props.gitlabProjectId,
    props.iid,
    props.baseSha,
    props.headSha,
    props.hasNewVersion,
  ])

  const phase = status.data?.phase ?? (prepare.isPending ? 'cloning' : 'idle')
  const failed = !props.hasNewVersion && (prepare.isError || phase === 'error')
  const ready = !props.hasNewVersion && phase === 'ready'
  const needsScoping =
    !props.hasNewVersion && phase === 'needs_scoping'
  return (
    <div className="mt-4 flex items-start gap-3 rounded-xl border border-[var(--line)] bg-[var(--surface)] px-4 py-3 text-sm">
      {props.hasNewVersion ? (
        <RefreshCw className="mt-0.5 size-4 shrink-0 text-amber-700" />
      ) : ready || needsScoping ? (
        <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-(--palm)" />
      ) : failed ? (
        <span className="text-destructive">×</span>
      ) : (
        <LoaderCircle className="mt-0.5 size-4 shrink-0 animate-spin text-[var(--lagoon-deep)]" />
      )}
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="font-medium text-(--sea-ink)">
            {props.hasNewVersion
              ? 'New version available'
              : ready
                ? 'Detached checkout ready'
                : needsScoping
                  ? 'Checkout ready · file scope required'
                  : failed
                    ? 'Repository preparation failed'
                    : repoPhaseLabel(phase)}
          </p>
          {props.hasNewVersion || ready || needsScoping ? (
            <Button
              size="sm"
              variant={props.hasNewVersion ? 'default' : 'outline'}
              disabled={props.pullPending || prepare.isPending}
              onClick={props.onPull}
            >
              <RefreshCw
                className={props.pullPending ? 'animate-spin' : undefined}
              />
              {props.hasNewVersion ? 'Pull latest version' : 'Fetch + pull'}
            </Button>
          ) : null}
        </div>
        <p className="mt-0.5 truncate text-xs text-(--sea-ink-soft)">
          {props.hasNewVersion
            ? 'Pull latest to fetch and prepare the new head.'
            : failed
            ? prepare.error instanceof Error
              ? prepare.error.message
              : status.data?.detail
            : (status.data?.detail ?? 'Starting repository preparation…')}
        </p>
        {props.pullError ? (
          <p className="mt-1 text-xs text-destructive">{props.pullError}</p>
        ) : null}
        {ready && preflight.data?.status === 'ok' ? (
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Select
              value={model}
              onValueChange={(value) => {
                setModel(value)
                setEffort(INHERIT)
              }}
            >
              <SelectTrigger size="sm">
                <SelectValue placeholder="Default model" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={INHERIT}>
                  {inheritModelLabel(
                    effective.data?.modelSource,
                    effective.data?.modelDisplayName ??
                      preflight.data.models[0]?.displayName,
                  )}
                </SelectItem>
                {preflight.data.models.map((item) => (
                  <SelectItem key={item.value} value={item.value}>
                    {item.displayName}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {selectedModel?.supportsEffort ? (
              <Select value={effort} onValueChange={setEffort}>
                <SelectTrigger size="sm">
                  <SelectValue placeholder="Default effort" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={INHERIT}>
                    Default effort
                    {model === INHERIT && effective.data?.effort
                      ? ` · ${effective.data.effort}`
                      : ''}
                  </SelectItem>
                  {selectedModel.supportedEffortLevels?.map((item) => (
                    <SelectItem key={item} value={item}>
                      {item}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : null}
            <Button
              size="sm"
              disabled={start.isPending}
              onClick={() =>
                start.mutate({
                  instanceId: props.instanceId,
                  gitlabProjectId: props.gitlabProjectId,
                  iid: props.iid,
                  baseSha: props.baseSha,
                  headSha: props.headSha,
                  labels: props.labels,
                  model: model === INHERIT ? undefined : model,
                  effort:
                    effort === INHERIT
                      ? undefined
                      : (effort as 'low' | 'medium' | 'high' | 'xhigh' | 'max'),
                })
              }
            >
              {start.isPending ? (
                <LoaderCircle className="size-4 animate-spin" />
              ) : (
                <Play className="size-4" />
              )}
              Start review
            </Button>
            {start.isError ? (
              <span className="text-xs text-destructive">
                {start.error.message}
              </span>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  )
}

function repoPhaseLabel(phase: string): string {
  switch (phase) {
    case 'fetching':
      return 'Fetching merge request refs…'
    case 'checking_out':
      return 'Creating detached checkout…'
    case 'diffing':
      return 'Computing diff…'
    default:
      return 'Cloning repository mirror…'
  }
}
