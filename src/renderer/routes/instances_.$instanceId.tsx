import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute, Link } from '@tanstack/react-router'
import {
  ArrowRight,
  Check,
  FolderOpen,
  GitMerge,
  HardDrive,
  Link2,
  Search,
  Star,
  Trash2,
  Undo2,
} from 'lucide-react'
import { useState } from 'react'
import { Button } from '#/components/ui/button.tsx'
import { Input } from '#/components/ui/input.tsx'
import { useTrpc } from '#/lib/trpc.tsx'

export const Route = createFileRoute('/instances_/$instanceId')({
  component: ProjectPicker,
})

function ProjectPicker() {
  const { instanceId } = Route.useParams()
  const trpc = useTrpc()
  const queryClient = useQueryClient()

  const instances = useQuery(trpc.instances.list.queryOptions())
  const instance = instances.data?.find((i) => i.id === instanceId)

  const picked = useQuery(trpc.projects.list.queryOptions({ instanceId }))

  const [search, setSearch] = useState('')
  const [browseProjectId, setBrowseProjectId] = useState<string | null>(null)

  const results = useQuery({
    ...trpc.projects.search.queryOptions({
      instanceId,
      search: search || undefined,
    }),
    enabled: Boolean(search.trim()),
  })

  const pick = useMutation(trpc.projects.pick.mutationOptions())
  const unpick = useMutation(trpc.projects.unpick.mutationOptions())

  const pickedIds = new Set(picked.data?.map((p) => p.gitlabProjectId) ?? [])
  const browseProject = picked.data?.find(
    (p) => p.gitlabProjectId === browseProjectId,
  )

  return (
    <div className="mx-auto max-w-4xl px-8 py-10">
      <p className="island-kicker">{instance?.label ?? 'Instance'}</p>
      <h1 className="display-title mt-1 text-3xl font-bold text-(--sea-ink)">
        Projects
      </h1>
      <p className="mt-1 text-sm text-(--sea-ink-soft)">
        Pick the projects you want to review. Picked projects are remembered
        locally; browsing searches the live GitLab API (starred first).
      </p>

      <CacheUsage />

      <div className="mt-6 flex gap-2">
        <div className="relative flex-1">
          <Search className="absolute top-1/2 left-3 size-4 -translate-y-1/2 text-(--sea-ink-soft)" />
          <Input
            className="pl-9"
            placeholder="Search your projects…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
      </div>

      {results.isFetching ? (
        <p className="mt-4 text-sm text-(--sea-ink-soft)">Searching…</p>
      ) : null}
      {results.isError ? (
        <p className="mt-4 text-sm text-destructive">
          {results.error instanceof Error
            ? results.error.message
            : 'Search failed'}
        </p>
      ) : null}

      {search.trim() ? (
        <ul className="mt-4 space-y-2">
          {results.data?.map((project) => (
            <li
              key={project.gitlabProjectId}
              className="island-shell flex items-center gap-3 rounded-xl p-3"
            >
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-1.5 truncate text-sm font-medium text-(--sea-ink)">
                  {project.starred ? (
                    <Star className="size-3.5 shrink-0 fill-[var(--lagoon)] text-[var(--lagoon)]" />
                  ) : null}
                  {project.pathWithNamespace}
                </span>
              </span>
              {pickedIds.has(String(project.gitlabProjectId)) ? (
                <span className="flex items-center gap-1 text-xs text-(--palm)">
                  <Check className="size-3.5" /> picked
                </span>
              ) : (
                <Button
                  size="xs"
                  variant="outline"
                  disabled={pick.isPending}
                  onClick={() =>
                    pick.mutate(
                      {
                        instanceId,
                        gitlabProjectId: project.gitlabProjectId,
                        pathWithNamespace: project.pathWithNamespace,
                        name: project.name,
                        defaultBranch: project.defaultBranch,
                      },
                      { onSuccess: () => void queryClient.invalidateQueries() },
                    )
                  }
                >
                  Pick
                </Button>
              )}
              <Button
                size="xs"
                variant="ghost"
                onClick={() =>
                  setBrowseProjectId(String(project.gitlabProjectId))
                }
              >
                Browse MRs
              </Button>
            </li>
          ))}
          {results.data?.length === 0 ? (
            <li className="text-sm text-(--sea-ink-soft)">
              No matching projects.
            </li>
          ) : null}
        </ul>
      ) : null}

      <h2 className="mt-10 flex items-center gap-2 text-sm font-semibold text-(--sea-ink)">
        <FolderOpen className="size-4 text-(--palm)" /> Picked projects
      </h2>
      {picked.isPending ? (
        <p className="mt-3 text-sm text-(--sea-ink-soft)">Loading…</p>
      ) : null}
      {picked.data?.length === 0 ? (
        <p className="mt-3 text-sm text-(--sea-ink-soft)">
          Nothing picked yet — search above and pick a project.
        </p>
      ) : null}
      <ul className="mt-3 space-y-2">
        {picked.data?.map((project) => (
          <li
            key={project.id}
            className={`island-shell flex items-center gap-3 rounded-xl p-4 ${
              browseProjectId === project.gitlabProjectId
                ? 'ring-1 ring-[var(--lagoon-deep)]'
                : ''
            }`}
          >
            <button
              type="button"
              className="min-w-0 flex-1 text-left"
              onClick={() =>
                setBrowseProjectId(
                  browseProjectId === project.gitlabProjectId
                    ? null
                    : project.gitlabProjectId,
                )
              }
            >
              <span className="block truncate font-medium text-(--sea-ink)">
                {project.pathWithNamespace}
              </span>
              <span className="mt-0.5 block text-xs text-(--sea-ink-soft)">
                {project.defaultBranch
                  ? `default: ${project.defaultBranch}`
                  : 'no default branch'}
              </span>
            </button>
            <Button
              variant="ghost"
              size="xs"
              className="text-(--sea-ink-soft)"
              disabled={unpick.isPending}
              onClick={() =>
                unpick.mutate(
                  { instanceId, projectId: project.id },
                  {
                    onSuccess: () => {
                      if (browseProjectId === project.gitlabProjectId)
                        setBrowseProjectId(null)
                      void queryClient.invalidateQueries()
                    },
                  },
                )
              }
            >
              <Undo2 className="size-3" />
              Unpick
            </Button>
            <ReferenceClone project={project} />
            <Button
              variant="ghost"
              size="xs"
              onClick={() => setBrowseProjectId(project.gitlabProjectId)}
            >
              <GitMerge className="size-3" />
              MRs
            </Button>
          </li>
        ))}
      </ul>

      {browseProject ? (
        <ProjectMrs
          instanceId={instanceId}
          gitlabProjectId={Number(browseProject.gitlabProjectId)}
          path={browseProject.pathWithNamespace}
        />
      ) : null}
    </div>
  )
}

function ReferenceClone(props: {
  project: {
    id: string
    instanceId: string
    referenceClonePath: string | null
  }
}) {
  const trpc = useTrpc()
  const queryClient = useQueryClient()
  const choose = useMutation(trpc.repos.chooseReferenceClone.mutationOptions())
  const map = useMutation(trpc.repos.mapReferenceClone.mutationOptions())

  const chooseAndMap = async (): Promise<void> => {
    const clonePath = await choose.mutateAsync()
    if (!clonePath) return
    await map.mutateAsync({
      instanceId: props.project.instanceId,
      projectId: props.project.id,
      clonePath,
    })
    await queryClient.invalidateQueries()
  }

  return (
    <div className="flex max-w-52 items-center gap-1">
      <Button
        variant="ghost"
        size="xs"
        title={
          props.project.referenceClonePath ??
          'Use objects from an existing local clone'
        }
        disabled={choose.isPending || map.isPending}
        onClick={() => void chooseAndMap()}
      >
        <Link2 className="size-3" />
        {props.project.referenceClonePath ? 'Clone mapped' : 'Map clone'}
      </Button>
      {props.project.referenceClonePath ? (
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label="Remove local clone mapping"
          disabled={map.isPending}
          onClick={() =>
            map.mutate(
              {
                instanceId: props.project.instanceId,
                projectId: props.project.id,
                clonePath: null,
              },
              { onSuccess: () => void queryClient.invalidateQueries() },
            )
          }
        >
          ×
        </Button>
      ) : null}
    </div>
  )
}

function CacheUsage() {
  const trpc = useTrpc()
  const queryClient = useQueryClient()
  const usage = useQuery(trpc.repos.cacheUsage.queryOptions())
  const clear = useMutation(trpc.repos.clearCaches.mutationOptions())
  return (
    <div className="island-shell mt-6 flex items-center gap-3 rounded-xl px-4 py-3 text-xs">
      <HardDrive className="size-4 text-(--palm)" />
      <span className="flex-1 text-(--sea-ink-soft)">
        Repository cache:{' '}
        <strong className="text-(--sea-ink)">
          {usage.data ? formatBytes(usage.data.totalBytes) : 'calculating…'}
        </strong>
        {usage.data
          ? ` · mirrors ${formatBytes(usage.data.reposBytes)} · worktrees ${formatBytes(usage.data.worktreesBytes)}`
          : ''}
      </span>
      <Button
        size="xs"
        variant="ghost"
        disabled={clear.isPending}
        onClick={() => {
          if (
            !window.confirm(
              'Clear all cached mirrors and worktrees? They can be downloaded again.',
            )
          )
            return
          clear.mutate(undefined, {
            onSuccess: () => void queryClient.invalidateQueries(),
          })
        }}
      >
        <Trash2 className="size-3" />{' '}
        {clear.isPending ? 'Clearing…' : 'Clear caches'}
      </Button>
    </div>
  )
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`
}

function ProjectMrs(props: {
  instanceId: string
  gitlabProjectId: number
  path: string
}) {
  const trpc = useTrpc()
  const mrs = useQuery(
    trpc.projects.mergeRequests.queryOptions({
      instanceId: props.instanceId,
      gitlabProjectId: props.gitlabProjectId,
    }),
  )

  return (
    <div className="mt-8">
      <h2 className="flex items-center gap-2 text-sm font-semibold text-(--sea-ink)">
        <GitMerge className="size-4 text-(--palm)" />
        Open merge requests · {props.path}
      </h2>
      {mrs.isFetching ? (
        <p className="mt-3 text-sm text-(--sea-ink-soft)">Loading…</p>
      ) : null}
      {mrs.isError ? (
        <p className="mt-3 text-sm text-destructive">
          {mrs.error instanceof Error
            ? mrs.error.message
            : 'Failed to load MRs'}
        </p>
      ) : null}
      {mrs.data?.length === 0 ? (
        <p className="mt-3 text-sm text-(--sea-ink-soft)">
          No open merge requests.
        </p>
      ) : null}
      <ul className="mt-3 space-y-2">
        {mrs.data?.map((mr) => (
          <li key={`${mr.gitlabProjectId}-${mr.iid}`}>
            <Link
              to="/mrs/$instanceId/$gitlabProjectId/$iid"
              params={{
                instanceId: props.instanceId,
                gitlabProjectId: String(mr.gitlabProjectId),
                iid: String(mr.iid),
              }}
              className="island-shell flex items-center gap-3 rounded-xl p-3 hover:-translate-y-px"
            >
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium text-(--sea-ink)">
                  {mr.title}
                </span>
                <span className="mt-0.5 block truncate text-xs text-(--sea-ink-soft)">
                  {mr.sourceBranch} → {mr.targetBranch}
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
