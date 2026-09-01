import { useMutation, useQuery } from '@tanstack/react-query'
import { FolderOpen, Link2, LoaderCircle, PackagePlus } from 'lucide-react'
import { useState } from 'react'
import { Button } from '#/components/ui/button.tsx'
import { useTrpc } from '#/lib/trpc.tsx'

/**
 * Import skills out of a checkout's `.claude/skills`.
 *
 * Every candidate is `realpath`ed before it is read or copied: dotfile setups
 * routinely symlink these directories at a shared source, and copying the link
 * would import an empty husk. The copy itself dereferences too, so an imported
 * skill is self-contained content rather than links back into the checkout.
 */
export function ImportPanel({
  scope,
  projectId,
  defaultRoot,
  onImported,
}: {
  scope: 'user' | 'project'
  projectId: string | null
  /** The project's reference clone, when one is mapped — the usual answer. */
  defaultRoot: string | null
  onImported: () => void
}) {
  const trpc = useTrpc()
  const [root, setRoot] = useState<string | null>(defaultRoot)
  const [selected, setSelected] = useState<Set<string>>(new Set())

  const choose = useMutation(trpc.skills.chooseImportDirectory.mutationOptions())
  const runImport = useMutation(trpc.skills.import.mutationOptions())
  const scan = useQuery({
    ...trpc.skills.scanImports.queryOptions({ root: root ?? '', scope, projectId }),
    enabled: Boolean(root),
    retry: false,
    staleTime: 0,
  })

  const toggle = (directory: string): void => {
    setSelected((current) => {
      const next = new Set(current)
      if (next.has(directory)) next.delete(directory)
      else next.add(directory)
      return next
    })
  }

  return (
    <div className="island-shell rounded-2xl p-5">
      <p className="flex items-center gap-2 font-semibold text-[var(--sea-ink)]">
        <PackagePlus className="size-4 text-[var(--palm)]" />
        Import from a checkout
      </p>
      <p className="mt-1 text-sm text-[var(--sea-ink-soft)]">
        Copies <code>.claude/skills/*</code> out of a local checkout into rivju&apos;s{' '}
        {scope === 'user' ? 'user' : 'project'} plugin. Imported skills arrive switched off so they
        never change a review before you have read them.
      </p>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          disabled={choose.isPending}
          onClick={() =>
            choose.mutate(undefined, {
              onSuccess: (chosen) => {
                if (chosen) {
                  setRoot(chosen)
                  setSelected(new Set())
                }
              },
            })
          }
        >
          <FolderOpen className="size-4" />
          Choose folder…
        </Button>
        {defaultRoot && root !== defaultRoot ? (
          <Button variant="ghost" size="sm" onClick={() => { setRoot(defaultRoot); setSelected(new Set()) }}>
            Use the mapped reference clone
          </Button>
        ) : null}
        {root ? (
          <span className="truncate font-mono text-[11px] text-[var(--sea-ink-soft)]">{root}</span>
        ) : null}
      </div>

      {scan.isFetching ? (
        <p className="mt-3 flex items-center gap-2 text-sm text-[var(--sea-ink-soft)]">
          <LoaderCircle className="size-4 animate-spin" /> Scanning…
        </p>
      ) : null}

      {scan.isError ? (
        <p className="mt-3 text-sm text-destructive">
          {scan.error instanceof Error ? scan.error.message : 'Scan failed'}
        </p>
      ) : null}

      {scan.data && !scan.data.exists ? (
        <p className="mt-3 text-sm text-[var(--sea-ink-soft)]">
          No <code>{scan.data.skillsDir}</code> in that folder.
        </p>
      ) : null}

      {scan.data?.exists && scan.data.candidates.length === 0 ? (
        <p className="mt-3 text-sm text-[var(--sea-ink-soft)]">
          That checkout has a <code>.claude/skills</code> directory but nothing importable in it.
        </p>
      ) : null}

      {scan.data?.candidates.length ? (
        <ul className="mt-3 space-y-2">
          {scan.data.candidates.map((candidate) => {
            const importable = candidate.name !== null
            return (
              <li
                key={candidate.directory}
                className="flex items-start gap-3 rounded-xl border border-[var(--line)] p-3"
              >
                <input
                  type="checkbox"
                  className="mt-1"
                  disabled={!importable}
                  checked={selected.has(candidate.directory)}
                  onChange={() => toggle(candidate.directory)}
                  aria-label={`Import ${candidate.directory}`}
                />
                <div className="min-w-0 flex-1">
                  <p className="flex flex-wrap items-center gap-2 text-sm font-medium text-[var(--sea-ink)]">
                    {candidate.name ?? candidate.directory}
                    {candidate.symlinked ? (
                      <span
                        className="flex items-center gap-1 rounded bg-[var(--chip-bg)] px-1.5 py-0.5 text-[10px] font-semibold text-[var(--sea-ink-soft)]"
                        title={`Resolved to ${candidate.realPath}`}
                      >
                        <Link2 className="size-3" /> symlink resolved
                      </span>
                    ) : null}
                    {candidate.conflicts ? (
                      <span className="rounded bg-[var(--chip-bg)] px-1.5 py-0.5 text-[10px] font-semibold text-[var(--sea-ink-soft)]">
                        name taken — will import with a suffix
                      </span>
                    ) : null}
                  </p>
                  <p className="mt-0.5 text-xs text-[var(--sea-ink-soft)]">
                    {candidate.description ?? 'No description in the frontmatter.'}
                  </p>
                  <p className="mt-1 font-mono text-[10px] break-all text-[var(--sea-ink-soft)]">
                    {candidate.realPath}
                  </p>
                  {candidate.issues.length > 0 ? (
                    <ul className="mt-1 space-y-0.5 text-[11px] text-destructive">
                      {candidate.issues.map((issue) => (
                        <li key={issue}>{issue}</li>
                      ))}
                    </ul>
                  ) : null}
                </div>
              </li>
            )
          })}
        </ul>
      ) : null}

      {selected.size > 0 && root ? (
        <Button
          className="mt-3"
          size="sm"
          disabled={runImport.isPending}
          onClick={() =>
            runImport.mutate(
              { root, directories: [...selected], scope, projectId },
              {
                onSuccess: () => {
                  setSelected(new Set())
                  void scan.refetch()
                  onImported()
                },
              },
            )
          }
        >
          {runImport.isPending ? (
            <LoaderCircle className="size-4 animate-spin" />
          ) : (
            <PackagePlus className="size-4" />
          )}
          Import {selected.size} skill{selected.size === 1 ? '' : 's'}
        </Button>
      ) : null}

      {runImport.data ? (
        <div className="mt-2 text-xs">
          {runImport.data.imported.map((item) => (
            <p key={item.name} className="text-[var(--palm)]">
              Imported {item.requested} as <code>{item.name}</code>
              {item.renamed ? ' (renamed to avoid a collision)' : ''}
            </p>
          ))}
          {runImport.data.failed.map((item) => (
            <p key={item.requested} className="text-destructive">
              {item.requested}: {item.reason}
            </p>
          ))}
        </div>
      ) : null}
      {runImport.isError ? (
        <p className="mt-2 text-xs text-destructive">
          {runImport.error instanceof Error ? runImport.error.message : 'Import failed'}
        </p>
      ) : null}
    </div>
  )
}
