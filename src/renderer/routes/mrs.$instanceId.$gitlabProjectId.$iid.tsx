import { useMutation, useQuery } from '@tanstack/react-query'
import { createFileRoute, Link } from '@tanstack/react-router'
import {
  CheckCircle2,
  ExternalLink,
  FileCode,
  FileMinus,
  FilePlus,
  FilePen,
  GitMerge,
  LoaderCircle,
  Play,
} from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { Button } from '#/components/ui/button.tsx'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '#/components/ui/select.tsx'
import { useTrpc } from '#/lib/trpc.tsx'
import { ReviewWorkspace } from '#/components/review/review-workspace.tsx'

export const Route = createFileRoute('/mrs/$instanceId/$gitlabProjectId/$iid')({
  component: MergeRequestDetail,
})

function MergeRequestDetail() {
  const { instanceId, gitlabProjectId, iid } = Route.useParams()
  const trpc = useTrpc()

  const detail = useQuery(
    trpc.mergeRequests.detail.queryOptions({
      instanceId,
      gitlabProjectId: Number(gitlabProjectId),
      iid: Number(iid),
    }),
  )

  if (detail.isPending) {
    return (
      <div className="px-8 py-10 text-sm text-[var(--sea-ink-soft)]">
        Loading merge request…
      </div>
    )
  }
  if (detail.isError) {
    return (
      <div className="px-8 py-10">
        <p className="text-sm text-destructive">
          {detail.error instanceof Error
            ? detail.error.message
            : 'Failed to load merge request'}
        </p>
        <Link to="/" className="mt-4 inline-block text-sm">
          ← Back to review queue
        </Link>
      </div>
    )
  }

  const { mr, description, labels, diffRefs, files } = detail.data

  return (
    <div className="mx-auto max-w-[1600px] px-8 py-10">
      <Link to="/" className="text-xs text-[var(--sea-ink-soft)]">
        ← Review queue
      </Link>

      <div className="mt-3 flex items-start justify-between gap-6">
        <div className="min-w-0">
          <p className="island-kicker flex items-center gap-2">
            <GitMerge className="size-3.5" />
            {mr.instanceLabel} · !{mr.iid}
          </p>
          <h1 className="display-title mt-1 text-3xl font-bold text-[var(--sea-ink)]">
            {mr.title}
          </h1>
        </div>
        <a
          href={mr.webUrl}
          target="_blank"
          rel="noreferrer"
          className="flex shrink-0 items-center gap-1.5 text-sm text-[var(--lagoon-deep)]"
        >
          <ExternalLink className="size-4" /> Open in GitLab
        </a>
      </div>

      <dl className="island-shell mt-6 grid grid-cols-2 gap-x-8 gap-y-3 rounded-2xl p-6 text-sm sm:grid-cols-3">
        <div>
          <dt className="text-xs text-[var(--sea-ink-soft)]">Source branch</dt>
          <dd className="mt-0.5 font-mono text-[var(--sea-ink)]">
            {mr.sourceBranch}
          </dd>
        </div>
        <div>
          <dt className="text-xs text-[var(--sea-ink-soft)]">Target branch</dt>
          <dd className="mt-0.5 font-mono text-[var(--sea-ink)]">
            {mr.targetBranch}
          </dd>
        </div>
        <div>
          <dt className="text-xs text-[var(--sea-ink-soft)]">Author</dt>
          <dd className="mt-0.5 text-[var(--sea-ink)]">{mr.author ?? '—'}</dd>
        </div>
        <div>
          <dt className="text-xs text-[var(--sea-ink-soft)]">State</dt>
          <dd className="mt-0.5 text-[var(--sea-ink)]">{mr.state}</dd>
        </div>
        <div className="col-span-2 sm:col-span-3">
          <dt className="text-xs text-[var(--sea-ink-soft)]">Diff refs</dt>
          {diffRefs ? (
            <dd className="mt-1 grid gap-1 font-mono text-xs text-[var(--sea-ink)]">
              <span>base: {diffRefs.baseSha}</span>
              <span>head: {diffRefs.headSha}</span>
              <span>start: {diffRefs.startSha}</span>
            </dd>
          ) : (
            <dd className="mt-0.5 text-[var(--sea-ink-soft)]">
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
        />
      ) : null}

      {description ? (
        <div className="mt-6 rounded-2xl border border-[var(--line)] bg-[var(--surface)] p-5">
          <p className="text-xs font-semibold text-[var(--sea-ink-soft)]">
            Description
          </p>
          <p className="mt-2 text-sm whitespace-pre-wrap text-[var(--sea-ink)]">
            {description}
          </p>
        </div>
      ) : null}

      <h2 className="mt-8 text-sm font-semibold text-[var(--sea-ink)]">
        Changed files{' '}
        <span className="text-[var(--sea-ink-soft)]">({files.length})</span>
      </h2>
      <ul className="mt-3 space-y-1.5">
        {files.map((file) => (
          <li
            key={`${file.oldPath}:${file.newPath}`}
            className="flex items-center gap-2.5 rounded-lg border border-[var(--line)] bg-[var(--surface)] px-3 py-2"
          >
            {file.newFile ? (
              <FilePlus className="size-4 shrink-0 text-[var(--palm)]" />
            ) : file.deletedFile ? (
              <FileMinus className="size-4 shrink-0 text-destructive" />
            ) : file.renamedFile ? (
              <FilePen className="size-4 shrink-0 text-[var(--lagoon-deep)]" />
            ) : (
              <FileCode className="size-4 shrink-0 text-[var(--sea-ink-soft)]" />
            )}
            <span className="truncate font-mono text-xs text-[var(--sea-ink)]">
              {file.newPath}
            </span>
            {file.renamedFile && file.oldPath !== file.newPath ? (
              <span className="shrink-0 text-[10px] text-[var(--sea-ink-soft)]">
                (renamed from {file.oldPath})
              </span>
            ) : null}
          </li>
        ))}
      </ul>

      <ReviewWorkspace
        instanceId={instanceId}
        gitlabProjectId={Number(gitlabProjectId)}
        iid={Number(iid)}
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
  const start = useMutation(trpc.runs.start.mutationOptions())
  const [model, setModel] = useState<string>('default')
  const [effort, setEffort] = useState<string>('default')
  const selectedModel = useMemo(() => {
    if (preflight.data?.status !== 'ok') return null
    return model === 'default' ? preflight.data.models[0] : preflight.data.models.find((item) => item.value === model)
  }, [model, preflight.data])

  useEffect(() => {
    prepare.mutate(props, { onSettled: () => void status.refetch() })
  }, [
    props.instanceId,
    props.gitlabProjectId,
    props.iid,
    props.baseSha,
    props.headSha,
  ])

  const phase = status.data?.phase ?? (prepare.isPending ? 'cloning' : 'idle')
  const failed = prepare.isError || phase === 'error'
  const ready = phase === 'ready'
  const needsScoping = phase === 'needs_scoping'
  return (
    <div className="mt-4 flex items-start gap-3 rounded-xl border border-[var(--line)] bg-[var(--surface)] px-4 py-3 text-sm">
      {ready || needsScoping ? (
        <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-[var(--palm)]" />
      ) : failed ? (
        <span className="text-destructive">×</span>
      ) : (
        <LoaderCircle className="mt-0.5 size-4 shrink-0 animate-spin text-[var(--lagoon-deep)]" />
      )}
      <div className="min-w-0 flex-1">
        <p className="font-medium text-[var(--sea-ink)]">
          {ready
            ? 'Detached checkout ready'
            : needsScoping
              ? 'Checkout ready · file scope required'
              : failed
                ? 'Repository preparation failed'
                : repoPhaseLabel(phase)}
        </p>
        <p className="mt-0.5 truncate text-xs text-[var(--sea-ink-soft)]">
          {failed
            ? prepare.error instanceof Error
              ? prepare.error.message
              : status.data?.detail
            : (status.data?.detail ?? 'Starting repository preparation…')}
        </p>
        {ready && preflight.data?.status === 'ok' ? (
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Select value={model} onValueChange={(value) => { setModel(value); setEffort('default') }}>
              <SelectTrigger size="sm"><SelectValue placeholder="Default model" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="default">Default · {preflight.data.models[0]?.displayName}</SelectItem>
                {preflight.data.models.map((item) => <SelectItem key={item.value} value={item.value}>{item.displayName}</SelectItem>)}
              </SelectContent>
            </Select>
            {selectedModel?.supportsEffort ? (
              <Select value={effort} onValueChange={setEffort}>
                <SelectTrigger size="sm"><SelectValue placeholder="Default effort" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="default">Default effort</SelectItem>
                  {selectedModel.supportedEffortLevels?.map((item) => <SelectItem key={item} value={item}>{item}</SelectItem>)}
                </SelectContent>
              </Select>
            ) : null}
            <Button
              size="sm"
              disabled={start.isPending}
              onClick={() => start.mutate({
                ...props,
                model: model === 'default' ? undefined : model,
                effort: effort === 'default' ? undefined : effort as 'low' | 'medium' | 'high' | 'xhigh' | 'max',
              })}
            >
              {start.isPending ? <LoaderCircle className="size-4 animate-spin" /> : <Play className="size-4" />}
              Start review
            </Button>
            {start.isError ? <span className="text-xs text-destructive">{start.error.message}</span> : null}
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
