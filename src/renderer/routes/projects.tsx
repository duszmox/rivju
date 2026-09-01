import { useQuery } from '@tanstack/react-query'
import { createFileRoute, Link } from '@tanstack/react-router'
import { ArrowRight, FolderOpen } from 'lucide-react'
import { useTrpc } from '#/lib/trpc.tsx'

export const Route = createFileRoute('/projects')({ component: AllProjects })

function AllProjects() {
  const trpc = useTrpc()
  const instances = useQuery(trpc.instances.list.queryOptions())

  return (
    <div className="mx-auto max-w-4xl px-8 py-10">
      <p className="island-kicker">GitLab</p>
      <h1 className="display-title mt-1 text-3xl font-bold text-(--sea-ink)">
        Projects
      </h1>
      <p className="mt-1 text-sm text-(--sea-ink-soft)">
        Picked projects across every connected GitLab instance.
      </p>

      {instances.isPending ? (
        <p className="mt-6 text-sm text-(--sea-ink-soft)">Loading instances…</p>
      ) : null}
      {instances.data?.length === 0 ? (
        <p className="mt-6 text-sm text-(--sea-ink-soft)">
          No GitLab instances connected yet.
        </p>
      ) : null}

      <div className="mt-6 space-y-8">
        {instances.data?.map((instance) => (
          <InstanceProjects
            key={instance.id}
            instanceId={instance.id}
            label={instance.label}
          />
        ))}
      </div>
    </div>
  )
}

function InstanceProjects(props: { instanceId: string; label: string }) {
  const trpc = useTrpc()
  const picked = useQuery(
    trpc.projects.list.queryOptions({ instanceId: props.instanceId }),
  )

  if (picked.data?.length === 0) return null

  return (
    <div>
      <h2 className="flex items-center gap-2 text-sm font-semibold text-(--sea-ink)">
        <FolderOpen className="size-4 text-(--palm)" /> {props.label}
      </h2>
      {picked.isPending ? (
        <p className="mt-3 text-sm text-(--sea-ink-soft)">Loading…</p>
      ) : null}
      <ul className="mt-3 space-y-2">
        {picked.data?.map((project) => (
          <li key={project.id}>
            <Link
              to="/instances/$instanceId"
              params={{ instanceId: props.instanceId }}
              className="island-shell flex items-center gap-3 rounded-xl p-3 hover:-translate-y-px"
            >
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium text-(--sea-ink)">
                  {project.pathWithNamespace}
                </span>
                <span className="mt-0.5 block text-xs text-(--sea-ink-soft)">
                  {project.defaultBranch
                    ? `default: ${project.defaultBranch}`
                    : 'no default branch'}
                </span>
              </span>
              <ArrowRight className="size-4 shrink-0 text-(--sea-ink-soft)" />
            </Link>
          </li>
        ))}
      </ul>
    </div>
  )
}
