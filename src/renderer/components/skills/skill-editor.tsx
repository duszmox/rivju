import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { LoaderCircle, Save, TriangleAlert, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Button } from '#/components/ui/button.tsx'
import { Textarea } from '#/components/ui/textarea.tsx'
import { useTrpc } from '#/lib/trpc.tsx'

/**
 * SKILL.md editor. Validation happens in the main process against the same
 * parser the loader uses, so "it saved" and "the SDK will accept it" mean the
 * same thing. Only `name` and `description` are legal frontmatter keys and the
 * name is fixed — everything rivju tracks about a skill lives in SQLite.
 */
export function SkillEditor({
  skillId,
  onClose,
  onSaved,
}: {
  skillId: string
  onClose: () => void
  onSaved: () => void
}) {
  const trpc = useTrpc()
  const queryClient = useQueryClient()
  const source = useQuery(trpc.skills.source.queryOptions({ id: skillId }))
  const save = useMutation(trpc.skills.save.mutationOptions())
  const [draft, setDraft] = useState<string | null>(null)

  useEffect(() => {
    setDraft(null)
  }, [skillId])

  const content = draft ?? source.data?.content ?? ''
  const dirty = draft !== null && draft !== source.data?.content
  const issues = save.error instanceof Error ? save.error.message.split('\n') : []

  return (
    <div className="mt-3 rounded-xl border border-[var(--line)] bg-[var(--surface)] p-3">
      <div className="flex items-center justify-between gap-2">
        <p className="font-mono text-[11px] text-[var(--sea-ink-soft)]">
          {source.data?.filePath ?? 'loading…'}
          {source.data && !source.data.exists ? ' · missing on disk, saving recreates it' : ''}
        </p>
        <div className="flex items-center gap-1">
          <Button
            size="sm"
            disabled={!dirty || save.isPending}
            onClick={() =>
              save.mutate(
                { id: skillId, content },
                {
                  onSuccess: () => {
                    setDraft(null)
                    // Re-read: the saved file is the normalised form of what
                    // was typed, so the buffer must show what is on disk.
                    void queryClient.invalidateQueries({ queryKey: trpc.skills.source.pathKey() })
                    onSaved()
                  },
                },
              )
            }
          >
            {save.isPending ? <LoaderCircle className="size-3.5 animate-spin" /> : <Save className="size-3.5" />}
            Save
          </Button>
          <Button variant="ghost" size="sm" onClick={onClose}>
            <X className="size-3.5" />
          </Button>
        </div>
      </div>

      {source.isPending ? (
        <p className="mt-2 text-xs text-[var(--sea-ink-soft)]">Reading SKILL.md…</p>
      ) : (
        <Textarea
          spellCheck={false}
          className="mt-2 min-h-72 font-mono text-xs leading-relaxed"
          value={content}
          onChange={(event) => setDraft(event.target.value)}
        />
      )}

      {issues.length > 0 ? (
        <div className="mt-2 flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/5 p-2 text-xs">
          <TriangleAlert className="mt-0.5 size-3.5 shrink-0 text-destructive" />
          <ul className="space-y-0.5 text-destructive">
            {issues.map((issue) => (
              <li key={issue}>{issue}</li>
            ))}
          </ul>
        </div>
      ) : null}

      <p className="mt-2 text-[11px] text-[var(--sea-ink-soft)]">
        Frontmatter may contain only <code>name</code> and <code>description</code>. The name is
        fixed — duplicate the skill to use a different one.
      </p>
    </div>
  )
}
