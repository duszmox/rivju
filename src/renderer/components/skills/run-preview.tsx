import { useQuery } from '@tanstack/react-query'
import { CircleCheck, LoaderCircle, RefreshCw, TriangleAlert } from 'lucide-react'
import { Button } from '#/components/ui/button.tsx'
import { useTrpc } from '#/lib/trpc.tsx'

/**
 * "What this run will load."
 *
 * The left column is what rivju will hand the SDK. The right column is what
 * the SDK reports back after actually resolving it — a real session is opened
 * with these exact options and asked for its context usage, so a skill that
 * silently fails to resolve shows up as *missing* here rather than as a
 * mysteriously unhelpful review.
 *
 * The probe never runs a model turn, so it costs nothing.
 */
export function RunContextPreview({ projectId }: { projectId: string | null }) {
  const trpc = useTrpc()
  const preview = useQuery({
    ...trpc.skills.runContext.queryOptions({ projectId }),
    staleTime: 0,
    refetchOnWindowFocus: false,
    retry: false,
  })

  const data = preview.data

  return (
    <section className="island-shell mt-6 rounded-2xl p-5">
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="island-kicker">Live preview</p>
          <h2 className="mt-1 font-semibold text-(--sea-ink)">What the next run will load</h2>
          <p className="mt-1 text-sm text-(--sea-ink-soft)">
            rivju opens a real Claude session with exactly these options and reads back the skills
            it resolved. No model turn runs, so this costs nothing.
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => preview.refetch()}
          disabled={preview.isFetching}
        >
          <RefreshCw className={preview.isFetching ? 'size-4 animate-spin' : 'size-4'} />
          Re-check
        </Button>
      </div>

      {preview.isPending ? (
        <p className="mt-4 flex items-center gap-2 text-sm text-(--sea-ink-soft)">
          <LoaderCircle className="size-4 animate-spin" /> Asking the SDK…
        </p>
      ) : null}

      {preview.isError ? (
        <p className="mt-4 text-sm text-destructive">
          {preview.error instanceof Error ? preview.error.message : 'Preview failed'}
        </p>
      ) : null}

      {data ? (
        <div className="mt-4 grid gap-4 lg:grid-cols-2">
          <div className="rounded-xl border border-[var(--line)] p-3">
            <p className="text-xs font-semibold text-(--sea-ink)">rivju will pass</p>
            <dl className="mt-2 space-y-2 text-xs">
              <div>
                <dt className="text-(--sea-ink-soft)">
                  skills[] · {data.requested.skills.length}
                </dt>
                <dd className="mt-1 space-y-0.5 font-mono text-[11px] text-(--sea-ink)">
                  {data.requested.skills.length === 0 ? (
                    <span className="text-(--sea-ink-soft)">
                      empty — this run loads no skills at all
                    </span>
                  ) : (
                    data.requested.skills.map((name) => <div key={name}>{name}</div>)
                  )}
                </dd>
              </div>
              <div>
                <dt className="text-(--sea-ink-soft)">plugins[]</dt>
                <dd className="mt-1 space-y-0.5 font-mono text-[11px] break-all text-(--sea-ink)">
                  {data.requested.plugins.map((plugin) => (
                    <div key={plugin.path}>
                      {plugin.name} → {plugin.path}
                    </div>
                  ))}
                </dd>
              </div>
              <div>
                <dt className="text-(--sea-ink-soft)">settingSources</dt>
                <dd className="mt-1 font-mono text-[11px] text-(--sea-ink)">
                  {data.requested.settingSources.length === 0
                    ? '[] — nothing from your ~/.claude'
                    : data.requested.settingSources.join(', ')}
                </dd>
              </div>
              <div>
                <dt className="text-(--sea-ink-soft)">model / effort</dt>
                <dd className="mt-1 font-mono text-[11px] text-(--sea-ink)">
                  {data.selection.error
                    ? data.selection.error
                    : `${data.selection.modelDisplayName ?? '—'} (${data.selection.modelSource}) · effort ${data.selection.effort ?? 'unset'} (${data.selection.effortSource})`}
                </dd>
              </div>
            </dl>
          </div>

          <div className="rounded-xl border border-[var(--line)] p-3">
            <p className="text-xs font-semibold text-(--sea-ink)">the SDK reports</p>
            {data.probeError ? (
              <p className="mt-2 flex items-start gap-2 text-xs text-destructive">
                <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
                {data.probeError}
              </p>
            ) : data.probe ? (
              <>
                <p className="mt-2 text-xs text-(--sea-ink-soft)">
                  {data.probe.includedSkills} of {data.probe.totalSkills} discovered skills loaded ·{' '}
                  {data.probe.tokens.toLocaleString()} tokens of system prompt
                </p>
                <ul className="mt-2 space-y-0.5 font-mono text-[11px] text-(--sea-ink)">
                  {data.probe.loaded.length === 0 ? (
                    <li className="text-(--sea-ink-soft)">nothing loaded</li>
                  ) : (
                    data.probe.loaded.map((skill) => (
                      <li key={skill.name} className="flex items-center justify-between gap-2">
                        <span className="truncate">{skill.name}</span>
                        <span className="shrink-0 text-(--sea-ink-soft)">
                          {skill.source} · {skill.tokens}t
                        </span>
                      </li>
                    ))
                  )}
                </ul>
              </>
            ) : null}

            {data.missing.length > 0 ? (
              <p className="mt-3 flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/5 p-2 text-xs text-destructive">
                <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
                <span>
                  Requested but not loaded: {data.missing.join(', ')}. Check the SKILL.md
                  frontmatter — a skill whose name does not resolve is silently dropped.
                </span>
              </p>
            ) : null}
            {data.unexpected.length > 0 ? (
              <p className="mt-2 flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/5 p-2 text-xs text-destructive">
                <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
                <span>Loaded but not requested: {data.unexpected.join(', ')}.</span>
              </p>
            ) : null}
            {data.probe && data.missing.length === 0 && data.unexpected.length === 0 ? (
              <p className="mt-3 flex items-center gap-2 text-xs text-(--palm)">
                <CircleCheck className="size-3.5" /> The SDK loaded exactly what rivju asked for.
              </p>
            ) : null}
          </div>
        </div>
      ) : null}
    </section>
  )
}
