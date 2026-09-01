import { useQuery } from '@tanstack/react-query'
import { createFileRoute, Link } from '@tanstack/react-router'
import { ExternalLink, FileCode, FileMinus, FilePlus, FilePen, GitMerge } from 'lucide-react'
import { useTrpc } from '#/lib/trpc.tsx'

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
    return <div className="px-8 py-10 text-sm text-[var(--sea-ink-soft)]">Loading merge request…</div>
  }
  if (detail.isError) {
    return (
      <div className="px-8 py-10">
        <p className="text-sm text-destructive">
          {detail.error instanceof Error ? detail.error.message : 'Failed to load merge request'}
        </p>
        <Link to="/" className="mt-4 inline-block text-sm">
          ← Back to review queue
        </Link>
      </div>
    )
  }

  const { mr, description, diffRefs, files } = detail.data

  return (
    <div className="mx-auto max-w-4xl px-8 py-10">
      <Link to="/" className="text-xs text-[var(--sea-ink-soft)]">
        ← Review queue
      </Link>

      <div className="mt-3 flex items-start justify-between gap-6">
        <div className="min-w-0">
          <p className="island-kicker flex items-center gap-2">
            <GitMerge className="size-3.5" />
            {mr.instanceLabel} · !{mr.iid}
          </p>
          <h1 className="display-title mt-1 text-3xl font-bold text-[var(--sea-ink)]">{mr.title}</h1>
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
          <dd className="mt-0.5 font-mono text-[var(--sea-ink)]">{mr.sourceBranch}</dd>
        </div>
        <div>
          <dt className="text-xs text-[var(--sea-ink-soft)]">Target branch</dt>
          <dd className="mt-0.5 font-mono text-[var(--sea-ink)]">{mr.targetBranch}</dd>
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
            <dd className="mt-0.5 text-[var(--sea-ink-soft)]">not reported by GitLab</dd>
          )}
        </div>
      </dl>

      {description ? (
        <div className="mt-6 rounded-2xl border border-[var(--line)] bg-[var(--surface)] p-5">
          <p className="text-xs font-semibold text-[var(--sea-ink-soft)]">Description</p>
          <p className="mt-2 text-sm whitespace-pre-wrap text-[var(--sea-ink)]">{description}</p>
        </div>
      ) : null}

      <h2 className="mt-8 text-sm font-semibold text-[var(--sea-ink)]">
        Changed files <span className="text-[var(--sea-ink-soft)]">({files.length})</span>
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
            <span className="truncate font-mono text-xs text-[var(--sea-ink)]">{file.newPath}</span>
            {file.renamedFile && file.oldPath !== file.newPath ? (
              <span className="shrink-0 text-[10px] text-[var(--sea-ink-soft)]">
                (renamed from {file.oldPath})
              </span>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  )
}
