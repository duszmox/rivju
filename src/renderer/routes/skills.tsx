import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { LoaderCircle, Plus } from 'lucide-react'
import { useState } from 'react'
import { DistillPanel } from '#/components/skills/distill-panel.tsx'
import { ImportPanel } from '#/components/skills/import-panel.tsx'
import { RunContextPreview } from '#/components/skills/run-preview.tsx'
import { SkillList } from '#/components/skills/skill-list.tsx'
import { Button } from '#/components/ui/button.tsx'
import { Input } from '#/components/ui/input.tsx'
import { Label } from '#/components/ui/label.tsx'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '#/components/ui/select.tsx'
import { useTrpc } from '#/lib/trpc.tsx'

export const Route = createFileRoute('/skills')({ component: Skills })

const NO_PROJECT = 'none'

function Skills() {
  const trpc = useTrpc()
  const queryClient = useQueryClient()
  const [projectId, setProjectId] = useState<string>(NO_PROJECT)
  const selectedProjectId = projectId === NO_PROJECT ? null : projectId

  const projects = useQuery(trpc.skills.projects.queryOptions())
  const skills = useQuery({
    ...trpc.skills.list.queryOptions({ projectId: selectedProjectId }),
    staleTime: 0,
  })

  const listKey = trpc.skills.list.pathKey()
  const runContextKey = trpc.skills.runContext.pathKey()
  const distillKey = trpc.skills.distillPreview.pathKey()

  /**
   * Any skill change re-asks the SDK what the next run would load. That costs
   * a short-lived claude process (no model turn) and is the whole point of the
   * preview: it must never drift from the toggles above it.
   */
  const refresh = (): void => {
    void queryClient.invalidateQueries({ queryKey: listKey })
    void queryClient.invalidateQueries({ queryKey: runContextKey })
    void queryClient.invalidateQueries({ queryKey: distillKey })
  }

  const project = projects.data?.find((item) => item.id === selectedProjectId) ?? null

  return (
    <div className="mx-auto max-w-4xl px-8 py-10">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="island-kicker">Review skills</p>
          <h1 className="display-title mt-1 text-3xl font-bold text-[var(--sea-ink)]">Skills</h1>
          <p className="mt-1 max-w-xl text-sm text-[var(--sea-ink-soft)]">
            Skills are the review instructions rivju loads into each run. Switching one off writes a
            flag in rivju&apos;s database and changes the SDK&apos;s skill filter — files are never
            moved, renamed or deleted to turn a skill off.
          </p>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="skill-project">Project scope</Label>
          <Select value={projectId} onValueChange={setProjectId}>
            <SelectTrigger id="skill-project" size="sm" className="min-w-64">
              <SelectValue placeholder="User-level only" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={NO_PROJECT}>User-level only</SelectItem>
              {projects.data?.map((item) => (
                <SelectItem key={item.id} value={item.id}>
                  {item.instanceLabel} · {item.pathWithNamespace}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      <RunContextPreview projectId={selectedProjectId} />

      <section className="mt-8">
        <div className="flex items-center justify-between gap-4">
          <div>
            <h2 className="font-semibold text-[var(--sea-ink)]">User-level skills</h2>
            <p className="text-xs text-[var(--sea-ink-soft)]">
              Loaded for every project, in this order.
            </p>
          </div>
          <NewSkillButton scope="user" projectId={null} onCreated={refresh} />
        </div>
        <div className="mt-3">
          {skills.isPending ? (
            <p className="text-sm text-[var(--sea-ink-soft)]">Loading skills…</p>
          ) : (
            <SkillList
              skills={skills.data?.user ?? []}
              emptyMessage="No user-level skills."
              projectId={selectedProjectId}
              onChanged={refresh}
            />
          )}
        </div>
      </section>

      {project ? (
        <>
          <section className="mt-8">
            <div className="flex items-center justify-between gap-4">
              <div>
                <h2 className="font-semibold text-[var(--sea-ink)]">
                  Project skills · {project.pathWithNamespace}
                </h2>
                <p className="text-xs text-[var(--sea-ink-soft)]">
                  Loaded only for this project. A project skill with the same name replaces the
                  user-level one.
                </p>
              </div>
              <NewSkillButton scope="project" projectId={project.id} onCreated={refresh} />
            </div>
            <div className="mt-3">
              <SkillList
                skills={skills.data?.projectSkills ?? []}
                emptyMessage="No project-level skills. Duplicate a user skill or import one from the checkout."
                projectId={project.id}
                onChanged={refresh}
              />
            </div>
          </section>

          <section className="mt-8 space-y-4">
            <DistillPanel projectId={project.id} onApplied={refresh} />
            <ImportPanel
              key={project.id}
              scope="project"
              projectId={project.id}
              defaultRoot={project.referenceClonePath}
              onImported={refresh}
            />
          </section>
        </>
      ) : (
        <section className="mt-8">
          <ImportPanel scope="user" projectId={null} defaultRoot={null} onImported={refresh} />
          <p className="mt-3 text-xs text-[var(--sea-ink-soft)]">
            Choose a project above to manage project-level skills, import into a project, or distil
            its rejected findings into a rules skill.
          </p>
        </section>
      )}
    </div>
  )
}

function NewSkillButton({
  scope,
  projectId,
  onCreated,
}: {
  scope: 'user' | 'project'
  projectId: string | null
  onCreated: () => void
}) {
  const trpc = useTrpc()
  const create = useMutation(trpc.skills.create.mutationOptions())
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')

  if (!open) {
    return (
      <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
        <Plus className="size-4" />
        New skill
      </Button>
    )
  }

  return (
    <form
      className="flex flex-wrap items-end gap-2"
      onSubmit={(event) => {
        event.preventDefault()
        create.mutate(
          { scope, projectId, name: name.trim(), description: description.trim() },
          {
            onSuccess: () => {
              setName('')
              setDescription('')
              setOpen(false)
              onCreated()
            },
          },
        )
      }}
    >
      <div className="space-y-1">
        <Label htmlFor={`new-skill-${scope}`}>Name</Label>
        <Input
          id={`new-skill-${scope}`}
          className="h-8 w-48"
          placeholder="review-performance"
          value={name}
          onChange={(event) => setName(event.target.value)}
          required
        />
      </div>
      <div className="space-y-1">
        <Label htmlFor={`new-skill-desc-${scope}`}>Description</Label>
        <Input
          id={`new-skill-desc-${scope}`}
          className="h-8 w-64"
          placeholder="When should the agent load this?"
          value={description}
          onChange={(event) => setDescription(event.target.value)}
        />
      </div>
      <Button type="submit" size="sm" disabled={create.isPending || name.trim() === ''}>
        {create.isPending ? <LoaderCircle className="size-4 animate-spin" /> : <Plus className="size-4" />}
        Create
      </Button>
      <Button type="button" variant="ghost" size="sm" onClick={() => setOpen(false)}>
        Cancel
      </Button>
      {create.isError ? (
        <p className="w-full text-xs text-destructive">
          {create.error instanceof Error ? create.error.message : 'Could not create the skill'}
        </p>
      ) : null}
    </form>
  )
}
