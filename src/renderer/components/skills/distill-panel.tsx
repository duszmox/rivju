import { useMutation, useQuery } from '@tanstack/react-query'
import { FileDiff, LoaderCircle, TriangleAlert } from 'lucide-react'
import { Button } from '#/components/ui/button.tsx'
import { useTrpc } from '#/lib/trpc.tsx'

const LINE_STYLE: Record<string, string> = {
  add: 'bg-[var(--palm)]/10 text-(--sea-ink)',
  delete: 'bg-destructive/10 text-destructive line-through',
  context: 'text-(--sea-ink-soft)',
  gap: 'bg-[var(--chip-bg)] text-(--sea-ink-soft) italic',
}

const LINE_PREFIX: Record<string, string> = { add: '+', delete: '-', context: ' ', gap: '⋯' }

/**
 * Distil the findings this project's reviewers marked invalid into a
 * project-scoped rules skill. The diff is shown first and nothing is written
 * until it is accepted: the file is a human's document that rivju appends to,
 * never a generated artifact it owns.
 */
export function DistillPanel({
  projectId,
  onApplied,
}: {
  projectId: string
  onApplied: () => void
}) {
  const trpc = useTrpc()
  const preview = useQuery({
    ...trpc.skills.distillPreview.queryOptions({ projectId }),
    retry: false,
    staleTime: 0,
  })
  const apply = useMutation(trpc.skills.distillApply.mutationOptions())
  const data = preview.data

  return (
    <div className="island-shell rounded-2xl p-5">
      <p className="flex items-center gap-2 font-semibold text-(--sea-ink)">
        <FileDiff className="size-4 text-(--palm)" />
        Distil rejections into a project skill
      </p>
      <p className="mt-1 text-sm text-(--sea-ink-soft)">
        Turns every finding a reviewer marked <strong>invalid</strong> in this project into standing
        rules in a <code>rejected-findings</code> skill. Entries are appended — your edits to the
        file are never rewritten.
      </p>

      {preview.isPending ? (
        <p className="mt-3 flex items-center gap-2 text-sm text-(--sea-ink-soft)">
          <LoaderCircle className="size-4 animate-spin" /> Reading rejections…
        </p>
      ) : null}
      {preview.isError ? (
        <p className="mt-3 text-sm text-destructive">
          {preview.error instanceof Error ? preview.error.message : 'Could not build a preview'}
        </p>
      ) : null}

      {data ? (
        <>
          <p className="mt-3 text-xs text-(--sea-ink-soft)">
            {data.totalRejections} rejected finding{data.totalRejections === 1 ? '' : 's'} ·{' '}
            {data.newEntries} new · {data.alreadyPresent} already in the file
          </p>
          <p className="mt-0.5 font-mono text-[10px] break-all text-(--sea-ink-soft)">
            {data.filePath}
          </p>

          {data.blockingIssues.length > 0 ? (
            <div className="mt-3 flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/5 p-2 text-xs text-destructive">
              <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
              <div>
                <p className="font-semibold">
                  The existing rules file is no longer a valid SKILL.md — fix it before appending.
                </p>
                <ul className="mt-1 space-y-0.5">
                  {data.blockingIssues.map((issue) => (
                    <li key={issue}>{issue}</li>
                  ))}
                </ul>
              </div>
            </div>
          ) : null}

          {data.changed ? (
            <pre className="mt-3 max-h-96 overflow-auto rounded-xl border border-[var(--line)] bg-[var(--surface)] p-2 font-mono text-[11px] leading-relaxed">
              {data.diff.map((line, index) => (
                <div key={`${index}-${line.text}`} className={`px-1 ${LINE_STYLE[line.kind]}`}>
                  {LINE_PREFIX[line.kind]} {line.text}
                </div>
              ))}
            </pre>
          ) : (
            <p className="mt-3 text-sm text-(--sea-ink-soft)">
              {data.totalRejections === 0
                ? 'No findings have been marked invalid in this project yet.'
                : 'Every rejection is already in the rules file.'}
            </p>
          )}

          {data.changed && data.blockingIssues.length === 0 ? (
            <Button
              className="mt-3"
              size="sm"
              disabled={apply.isPending}
              onClick={() =>
                apply.mutate(
                  { projectId },
                  {
                    onSuccess: () => {
                      void preview.refetch()
                      onApplied()
                    },
                  },
                )
              }
            >
              {apply.isPending ? (
                <LoaderCircle className="size-4 animate-spin" />
              ) : (
                <FileDiff className="size-4" />
              )}
              Append {data.newEntries} entr{data.newEntries === 1 ? 'y' : 'ies'}
            </Button>
          ) : null}
          {apply.isError ? (
            <p className="mt-2 text-xs text-destructive">
              {apply.error instanceof Error ? apply.error.message : 'Could not write the skill'}
            </p>
          ) : null}
        </>
      ) : null}
    </div>
  )
}
