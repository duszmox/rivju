import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import {
  Check,
  CircleDashed,
  FolderGit2,
  GitMerge,
  KeyRound,
} from 'lucide-react'
import type { ReactNode } from 'react'
import { Button } from '#/components/ui/button.tsx'
import { useTrpc, useTrpcClient } from '#/lib/trpc.tsx'

/**
 * First-run experience: preflight (the blocking gate above this tree) →
 * connect a GitLab instance → pick a project → review a first MR, as a guided
 * path instead of an empty app. Each step completes live from real data, so
 * the checklist doubles as "what rivju needs from me". It hides itself once
 * the path is walked (first run recorded) or is no longer needed.
 */
export function FirstRunGuide() {
  const trpc = useTrpc()
  const client = useTrpcClient()
  const instances = useQuery(trpc.instances.list.queryOptions())
  const runs = useQuery(trpc.runs.list.queryOptions())

  const instanceCount = instances.data?.length ?? 0
  const projectsQueries = useQuery({
    queryKey: [
      'first-run',
      'projects',
      instances.data?.map((i) => i.id).join(','),
    ],
    queryFn: async () => {
      const lists = await Promise.all(
        (instances.data ?? []).map((instance) =>
          client.projects.list
            .query({ instanceId: instance.id })
            .catch(() => []),
        ),
      )
      return lists.flat()
    },
    enabled: instanceCount > 0,
    staleTime: 30_000,
  })
  const projectCount = projectsQueries.data?.length ?? 0
  const firstInstanceId = instances.data?.at(0)?.id
  const reviewed = (runs.data?.length ?? 0) > 0

  if (instances.isPending || runs.isPending) return null
  // A disabled query (zero instances) stays 'pending' forever — only wait on
  // it when it can actually resolve.
  if (instanceCount > 0 && projectsQueries.isPending) return null
  if (reviewed || (instanceCount > 0 && projectCount > 0)) return null

  return (
    <div className="island-shell mt-8 rounded-2xl p-8">
      <p className="font-semibold text-(--sea-ink)">Welcome to rivju</p>
      <p className="mx-auto mt-2 max-w-lg text-sm text-(--sea-ink-soft)">
        Three quick steps and your first agentic review is running. Your claude
        CLI login was already checked by the startup gate.
      </p>

      <ol className="mx-auto mt-6 max-w-lg space-y-3 text-left">
        <Step
          done={instanceCount > 0}
          icon={<KeyRound className="size-4" />}
          title="Connect a GitLab instance"
          detail="A personal access token with api scope, validated against /user and /version."
        >
          <Button asChild size="sm">
            <Link to="/instances">Add an instance</Link>
          </Button>
        </Step>
        <Step
          done={projectCount > 0}
          icon={<FolderGit2 className="size-4" />}
          title="Pick a project"
          detail={
            instanceCount > 0
              ? 'Pick the repository whose merge requests you review.'
              : 'Available once an instance is connected.'
          }
        >
          {firstInstanceId ? (
            <Button asChild size="sm" variant="outline">
              <Link
                to="/instances/$instanceId"
                params={{ instanceId: firstInstanceId }}
              >
                Browse projects
              </Link>
            </Button>
          ) : null}
        </Step>
        <Step
          done={reviewed}
          icon={<GitMerge className="size-4" />}
          title="Review your first merge request"
          detail={
            instanceCount > 0 && projectCount > 0
              ? 'Open a merge request from the queue below, wait for the checkout, and start the review.'
              : 'Once a project is picked, its merge requests appear in the review queue below.'
          }
        />
      </ol>
    </div>
  )
}

function Step({
  done,
  icon,
  title,
  detail,
  children,
}: {
  done: boolean
  icon: ReactNode
  title: string
  detail: string
  children?: ReactNode
}) {
  return (
    <li
      className={`flex items-start gap-3 rounded-xl border p-4 transition-colors ${
        done
          ? 'border-[var(--chip-line)] bg-[var(--hero-b)]'
          : 'border-[var(--line)] bg-[var(--surface)]'
      }`}
    >
      <span
        className={`mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-lg ${
          done
            ? 'bg-[var(--palm)] text-white'
            : 'bg-[var(--foam)] text-(--sea-ink-soft)'
        }`}
      >
        {done ? <Check className="size-4" /> : icon}
      </span>
      <div className="min-w-0 flex-1">
        <p
          className={`flex items-center gap-2 text-sm font-semibold text-(--sea-ink)`}
        >
          {title}
          {!done ? (
            <CircleDashed className="size-3.5 text-(--sea-ink-soft)" />
          ) : null}
        </p>
        <p className="mt-0.5 text-xs text-(--sea-ink-soft)">{detail}</p>
      </div>
      {!done && children ? <div className="shrink-0">{children}</div> : null}
    </li>
  )
}
