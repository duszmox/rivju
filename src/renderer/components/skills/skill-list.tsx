import { useMutation } from '@tanstack/react-query'
import { ChevronDown, ChevronUp, Copy, EyeOff, Pencil, Trash2 } from 'lucide-react'
import { useState } from 'react'
import { Button } from '#/components/ui/button.tsx'
import { Switch } from '#/components/ui/switch.tsx'
import { useTrpc } from '#/lib/trpc.tsx'
import { SkillEditor } from './skill-editor.tsx'
import type { RouterOutput } from '#/lib/trpc.tsx'

export type SkillSummary = RouterOutput['skills']['list']['user'][number]

const ORIGIN_LABEL: Record<string, string> = {
  builtin: 'built-in',
  user: 'yours',
  imported: 'imported',
}

/**
 * One scope's skill list. Toggling only ever writes `skill.enabled` — the SDK
 * `skills` context filter does the rest, so a skill switched off keeps its
 * files, its position and its edits.
 */
export function SkillList({
  skills,
  emptyMessage,
  projectId,
  onChanged,
}: {
  skills: SkillSummary[]
  emptyMessage: string
  /** Target project for "Duplicate to project"; null hides the action. */
  projectId: string | null
  onChanged: () => void
}) {
  const trpc = useTrpc()
  const [editing, setEditing] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const onError = (cause: unknown): void =>
    setError(cause instanceof Error ? cause.message : String(cause))
  const settled = { onSuccess: () => { setError(null); onChanged() }, onError }

  const setEnabled = useMutation(trpc.skills.setEnabled.mutationOptions())
  const move = useMutation(trpc.skills.move.mutationOptions())
  const duplicate = useMutation(trpc.skills.duplicateToProject.mutationOptions())
  const remove = useMutation(trpc.skills.delete.mutationOptions())

  if (skills.length === 0) {
    return <p className="rounded-xl border border-dashed border-[var(--line)] p-6 text-center text-sm text-(--sea-ink-soft)">{emptyMessage}</p>
  }

  return (
    <div className="space-y-2">
      {error ? <p className="text-xs text-destructive">{error}</p> : null}
      {skills.map((skill, index) => (
        <div key={skill.id} className="island-shell rounded-xl p-3">
          <div
            className="flex items-start gap-3"
            onKeyDown={(event) => {
              // Keyboard reorder without leaving the row.
              if (!event.altKey || (event.key !== 'ArrowUp' && event.key !== 'ArrowDown')) return
              event.preventDefault()
              move.mutate({ id: skill.id, direction: event.key === 'ArrowUp' ? 'up' : 'down' }, settled)
            }}
          >
            <Switch
              className="mt-1"
              checked={skill.enabled}
              disabled={setEnabled.isPending}
              aria-label={`Enable ${skill.name}`}
              onCheckedChange={(checked) => setEnabled.mutate({ id: skill.id, enabled: checked }, settled)}
            />
            <div className="min-w-0 flex-1">
              <p className="flex flex-wrap items-center gap-2">
                <span className="font-medium text-(--sea-ink)">{skill.name}</span>
                <span className="rounded bg-[var(--chip-bg)] px-1.5 py-0.5 text-[10px] font-semibold text-(--sea-ink-soft)">
                  {ORIGIN_LABEL[skill.origin] ?? skill.origin}
                </span>
                {skill.shadowedBy ? (
                  <span
                    className="flex items-center gap-1 rounded bg-[var(--chip-bg)] px-1.5 py-0.5 text-[10px] font-semibold text-(--sea-ink-soft)"
                    title={`Replaced for this project by ${skill.shadowedBy}`}
                  >
                    <EyeOff className="size-3" /> shadowed by the project copy
                  </span>
                ) : null}
                {!skill.fileExists ? (
                  <span className="rounded bg-destructive/10 px-1.5 py-0.5 text-[10px] font-semibold text-destructive">
                    SKILL.md missing
                  </span>
                ) : null}
              </p>
              <p className="mt-0.5 text-xs text-(--sea-ink-soft)">
                {skill.description ?? 'No description.'}
              </p>
              <p className="mt-1 font-mono text-[10px] text-(--sea-ink-soft)">
                {skill.active ? skill.qualifiedName : `${skill.qualifiedName} · not loaded`}
              </p>
            </div>
            <div className="flex shrink-0 items-center gap-0.5">
              <Button
                variant="ghost"
                size="sm"
                className="h-7 w-7 p-0"
                title="Move up (Alt+↑)"
                disabled={index === 0 || move.isPending}
                onClick={() => move.mutate({ id: skill.id, direction: 'up' }, settled)}
              >
                <ChevronUp className="size-3.5" />
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="h-7 w-7 p-0"
                title="Move down (Alt+↓)"
                disabled={index === skills.length - 1 || move.isPending}
                onClick={() => move.mutate({ id: skill.id, direction: 'down' }, settled)}
              >
                <ChevronDown className="size-3.5" />
              </Button>
              <Button
                variant="ghost"
                size="sm"
                title="Edit SKILL.md"
                onClick={() => setEditing(editing === skill.id ? null : skill.id)}
              >
                <Pencil className="size-3.5" />
                Edit
              </Button>
              {projectId && skill.scope === 'user' && !skill.shadowedBy ? (
                <Button
                  variant="ghost"
                  size="sm"
                  title="Copy into this project so it can be modified locally"
                  disabled={duplicate.isPending}
                  onClick={() => duplicate.mutate({ id: skill.id, projectId }, settled)}
                >
                  <Copy className="size-3.5" />
                  Duplicate
                </Button>
              ) : null}
              {!skill.isBuiltin || skill.scope === 'project' ? (
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 w-7 p-0 text-destructive"
                  title="Delete this skill and its files"
                  disabled={remove.isPending}
                  onClick={() => {
                    if (window.confirm(`Delete the skill "${skill.name}" and its files?`)) {
                      remove.mutate({ id: skill.id }, { ...settled, onSuccess: () => { setEditing(null); setError(null); onChanged() } })
                    }
                  }}
                >
                  <Trash2 className="size-3.5" />
                </Button>
              ) : null}
            </div>
          </div>
          {editing === skill.id ? (
            <SkillEditor skillId={skill.id} onClose={() => setEditing(null)} onSaved={onChanged} />
          ) : null}
        </div>
      ))}
    </div>
  )
}
