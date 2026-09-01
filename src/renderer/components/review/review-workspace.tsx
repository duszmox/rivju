import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import gitDiffParser from 'gitdiff-parser'
import {
  Decoration,
  Diff,
  Hunk,
  findChangeByNewLineNumber,
  getChangeKey,
  getCollapsedLinesCountBetween,
  getCorrespondingOldLineNumber,
} from 'react-diff-view'
import type { File, Hunk as HunkData } from 'gitdiff-parser'
import type { HunkTokens, TokenNode } from 'react-diff-view'
import type { inferRouterOutputs } from '@trpc/server'
import { codeToTokens } from 'shiki'
import {
  AlertCircle,
  Check,
  ChevronDown,
  ChevronRight,
  FileCode2,
  GitCompareArrows,
  ListChecks,
  LoaderCircle,
  MessageSquareText,
  X,
} from 'lucide-react'
import {
  Fragment,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import type {
  KeyboardEvent as ReactKeyboardEvent,
  ReactElement,
  ReactNode,
} from 'react'
import type { AppRouter } from '../../../main/trpc/router.ts'
import type { FindingRow, TriageState } from '../../../main/db/schema.ts'
import { Button } from '#/components/ui/button.tsx'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '#/components/ui/select.tsx'
import { Textarea } from '#/components/ui/textarea.tsx'
import { useRuns } from '#/components/runs/runs-store.tsx'
import { VerifyPanel } from '#/components/review/verify-panel.tsx'
import { useTrpc, useTrpcClient } from '#/lib/trpc.tsx'
import 'react-diff-view/style/index.css'

type ReviewDetail = inferRouterOutputs<AppRouter>['reviews']['detail']
type ReviewRun = ReviewDetail['runs'][number]
type DiffFile = NonNullable<ReviewDetail['diff']>['files'][number]

interface Coordinates {
  instanceId: string
  gitlabProjectId: number
  iid: number
}

export function ReviewWorkspace(props: Coordinates & {
  labels: string[]
  diffRefs: { baseSha: string; headSha: string } | null
}) {
  const trpc = useTrpc()
  const queryClient = useQueryClient()
  const { runs: liveRuns } = useRuns()
  const [runId, setRunId] = useState<string | undefined>()
  const detailOptions = trpc.reviews.detail.queryOptions({ ...props, runId })
  const review = useQuery({
    ...detailOptions,
    refetchInterval: liveRuns.some(
      (item) => item.status === 'running' || item.status === 'queued',
    )
      ? 1_500
      : false,
  })

  useEffect(() => {
    if (!runId && review.data?.selectedRunId)
      setRunId(review.data.selectedRunId)
  }, [review.data?.selectedRunId, runId])

  const triage = useMutation(
    trpc.reviews.triage.mutationOptions({
      onMutate: async (input) => {
        await queryClient.cancelQueries({ queryKey: detailOptions.queryKey })
        const previous = queryClient.getQueryData<ReviewDetail>(
          detailOptions.queryKey,
        )
        queryClient.setQueryData<ReviewDetail>(
          detailOptions.queryKey,
          (current) =>
            current && {
              ...current,
              findings: current.findings.map((item) =>
                item.id === input.findingId
                  ? {
                      ...item,
                      triage: input.triage,
                      triageNote: input.note.trim() || null,
                    }
                  : item,
              ),
            },
        )
        return { previous }
      },
      onError: (_error, _input, context) => {
        if (context?.previous)
          queryClient.setQueryData(detailOptions.queryKey, context.previous)
      },
      onSettled: () =>
        queryClient.invalidateQueries({ queryKey: detailOptions.queryKey }),
    }),
  )

  if (review.isPending)
    return (
      <SurfaceState
        icon={<LoaderCircle className="size-5 animate-spin" />}
        title="Loading review"
        detail="Collecting runs, findings, and diff data…"
      />
    )
  if (review.isError)
    return (
      <SurfaceState
        icon={<AlertCircle className="size-5" />}
        title="Review unavailable"
        detail={review.error.message}
        tone="error"
      />
    )
  if (review.data.runs.length === 0)
    return (
      <SurfaceState
        icon={<ListChecks className="size-5" />}
        title="No review runs yet"
        detail="Start a full review above. Findings and triage controls will appear here as the agent works."
      />
    )

  return (
    <ReviewSurface
      coordinates={props}
      data={review.data}
      runId={runId ?? review.data.selectedRunId ?? review.data.runs[0].id}
      onRunChange={setRunId}
      labels={props.labels}
      diffRefs={props.diffRefs}
      onTriage={(finding, state, note = finding.triageNote ?? '') =>
        triage.mutate({
          findingId: finding.id,
          runId: runId ?? review.data.selectedRunId ?? review.data.runs[0].id,
          triage: state,
          note,
        })
      }
      triageError={triage.error?.message ?? null}
    />
  )
}

function ReviewSurface(props: {
  coordinates: Coordinates
  data: ReviewDetail
  runId: string
  onRunChange: (runId: string) => void
  labels: string[]
  diffRefs: { baseSha: string; headSha: string } | null
  onTriage: (finding: FindingRow, state: TriageState, note?: string) => void
  triageError: string | null
}) {
  const run =
    props.data.runs.find((item) => item.id === props.runId) ??
    props.data.runs[0]
  const findingIds = new Set(props.data.findingIdsByRun[run.id] ?? [])
  const findings = props.data.findings.filter((item) => findingIds.has(item.id))
  const [selectedFile, setSelectedFile] = useState<string | null>(null)
  const [focusedId, setFocusedId] = useState<string | null>(
    findings[0]?.id ?? null,
  )
  const [noteId, setNoteId] = useState<string | null>(null)
  const [compareLeft, setCompareLeft] = useState(
    props.data.runs[1]?.id ?? run.id,
  )
  const [compareRight, setCompareRight] = useState(run.id)
  const files = props.data.diff?.files ?? []

  useEffect(() => {
    const firstFindingFile = findings.find((item) => item.filePath)?.filePath
    setSelectedFile((current) =>
      files.some((file) => file.path === current)
        ? current
        : firstFindingFile || files.at(0)?.path || null,
    )
    setFocusedId((current) =>
      findings.some((item) => item.id === current)
        ? current
        : (findings[0]?.id ?? null),
    )
  }, [
    run.id,
    files.map((file) => file.path).join('\0'),
    findings.map((item) => item.id).join('\0'),
  ])

  const focusFinding = useCallback((finding: FindingRow) => {
    setFocusedId(finding.id)
    if (finding.filePath) setSelectedFile(finding.filePath)
    requestAnimationFrame(() => {
      document
        .getElementById(`finding-${finding.id}`)
        ?.scrollIntoView({ behavior: 'smooth', block: 'center' })
    })
  }, [])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      const target = event.target
      if (
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target instanceof HTMLSelectElement
      )
        return
      if (!findings.length) return
      const currentIndex = Math.max(
        0,
        findings.findIndex((item) => item.id === focusedId),
      )
      if (event.key === 'j' || event.key === 'k') {
        event.preventDefault()
        const step = event.key === 'j' ? 1 : -1
        focusFinding(
          findings[(currentIndex + step + findings.length) % findings.length],
        )
      } else if (event.key === 'v' || event.key === 'x') {
        event.preventDefault()
        const current = findings[currentIndex]
        props.onTriage(current, event.key === 'v' ? 'valid' : 'invalid')
      } else if (event.key === 'Enter') {
        event.preventDefault()
        setNoteId(findings[currentIndex].id)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [findings, focusFinding, focusedId, props.onTriage])

  const selected = files.find((file) => file.path === selectedFile) ?? null
  const panelFindings = findings.filter((item) => item.scope !== 'line')

  return (
    <section
      className="review-workspace mt-8 border-t border-[var(--line)] pt-6"
      aria-label="Review findings"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="island-kicker">Review workspace</p>
          <h2 className="mt-1 text-xl font-bold text-[var(--sea-ink)]">
            {findings.length} {findings.length === 1 ? 'finding' : 'findings'}
          </h2>
          <p className="mt-1 text-xs text-[var(--sea-ink-soft)]">
            Keyboard: j/k navigate · v valid · x invalid · Enter note
          </p>
        </div>
        <RunPicker
          runs={props.data.runs}
          value={run.id}
          onChange={props.onRunChange}
        />
      </div>

      <VerifyPanel
        coordinates={props.coordinates}
        findings={props.data.findings}
        runs={props.data.runs}
        labels={props.labels}
        diffRefs={props.diffRefs}
      />

      <RunOutcome run={run} findingCount={findings.length} />
      {run.kind === 'verify' ? (
        <VerificationSummary
          run={run}
          findings={props.data.findings}
          verifications={props.data.verificationByRun[run.id] ?? []}
          reanchors={props.data.reanchorByRun[run.id] ?? []}
        />
      ) : null}
      {props.triageError ? (
        <p className="mt-2 text-xs text-destructive">
          Triage update failed: {props.triageError}
        </p>
      ) : null}

      <div className="mt-5 grid min-h-[560px] grid-cols-[220px_minmax(0,1fr)_310px] overflow-hidden rounded-2xl border border-[var(--line)] bg-[var(--surface)] shadow-sm">
        <FileList
          files={files}
          findings={findings}
          selected={selectedFile}
          onSelect={setSelectedFile}
        />
        <main className="min-w-0 overflow-auto bg-[var(--surface-strong)]">
          {selected ? (
            <DiffFileView
              coordinates={props.coordinates}
              run={run}
              file={selected}
              findings={findings.filter(
                (item) =>
                  item.scope === 'line' && item.filePath === selected.path,
              )}
              focusedId={focusedId}
              noteId={noteId}
              onFocus={focusFinding}
              onNote={setNoteId}
              onTriage={props.onTriage}
            />
          ) : props.data.diff ? (
            <SurfaceState
              icon={<FileCode2 className="size-5" />}
              title="No changed files"
              detail="The selected run has no textual file diff to display."
              compact
            />
          ) : (
            <SurfaceState
              icon={<AlertCircle className="size-5" />}
              title="Diff unavailable"
              detail="The repository mirror or reviewed revisions are not available for this run."
              compact
            />
          )}
        </main>
        <aside className="overflow-y-auto border-l border-[var(--line)] bg-[var(--foam)] p-3">
          <h3 className="px-1 text-xs font-bold uppercase tracking-wider text-[var(--sea-ink-soft)]">
            File & global findings
          </h3>
          {panelFindings.length ? (
            panelFindings.map((item) => (
              <FindingCard
                key={item.id}
                finding={item}
                run={run}
                focused={item.id === focusedId}
                noteOpen={item.id === noteId}
                onFocus={focusFinding}
                onNote={setNoteId}
                onTriage={props.onTriage}
              />
            ))
          ) : (
            <p className="px-1 py-8 text-center text-xs text-[var(--sea-ink-soft)]">
              No file- or global-scoped findings in this run.
            </p>
          )}
        </aside>
      </div>

      <FindingComparison
        runs={props.data.runs}
        findings={props.data.findings}
        idsByRun={props.data.findingIdsByRun}
        left={compareLeft}
        right={compareRight}
        onLeft={setCompareLeft}
        onRight={setCompareRight}
        onFinding={focusFinding}
      />
    </section>
  )
}

function RunPicker(props: {
  runs: ReviewRun[]
  value: string
  onChange: (value: string) => void
}) {
  return (
    <Select value={props.value} onValueChange={props.onChange}>
      <SelectTrigger className="w-64">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {props.runs.map((run) => (
          <SelectItem key={run.id} value={run.id}>
            {runLabel(run)}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

function RunOutcome({
  run,
  findingCount,
}: {
  run: ReviewRun
  findingCount: number
}) {
  if (run.status === 'queued' || run.status === 'running')
    return (
      <div className="mt-4 rounded-xl border border-[var(--chip-line)] bg-[var(--hero-a)] px-4 py-3 text-sm text-[var(--lagoon-deep)]">
        <LoaderCircle className="mr-2 inline size-4 animate-spin" />
        {run.kind === 'verify'
          ? `Verification is ${run.status}. Verdicts appear as the agent reports them.`
          : `Review is ${run.status}. Findings appear as they are accepted.`}
      </div>
    )
  if (run.status === 'failed' || run.status === 'interrupted')
    return (
      <div className="mt-4 rounded-xl border border-destructive/25 bg-destructive/5 px-4 py-3 text-sm text-destructive">
        {run.kind === 'verify' ? 'Verification' : 'Review'} {run.status}:{' '}
        {run.error ?? 'No error detail was recorded.'}
      </div>
    )
  if (run.kind === 'verify') return null
  if (run.status === 'done' && findingCount === 0)
    return (
      <div className="mt-4 rounded-xl border border-[var(--chip-line)] bg-[var(--hero-b)] px-4 py-3 text-sm text-[var(--palm)]">
        <Check className="mr-2 inline size-4" />
        Review completed successfully. The agent produced zero findings.
      </div>
    )
  return null
}

const VERDICT_LABELS: Record<'fixed' | 'not_fixed' | 'moot', string> = {
  fixed: 'Fixed',
  not_fixed: 'Not fixed',
  moot: 'Moot',
}

function VerificationSummary(props: {
  run: ReviewRun
  findings: FindingRow[]
  verifications: ReviewDetail['verificationByRun'][string]
  reanchors: ReviewDetail['reanchorByRun'][string]
}) {
  const byId = new Map(props.findings.map((item) => [item.id, item]))
  const counts = { fixed: 0, not_fixed: 0, moot: 0 }
  for (const verdict of props.verifications) counts[verdict.verdict]++
  const staled = props.reanchors.filter((item) => item.outcome === 'stale')
  const reported = new Set(props.verifications.map((item) => item.findingId))
  const unreported = props.reanchors
    .filter((item) => item.outcome === 'stale')
    .filter((item) => !reported.has(item.findingId))

  return (
    <div className="island-shell mt-4 rounded-2xl p-4">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="mr-auto text-sm font-bold text-[var(--sea-ink)]">
          Verification results
        </h3>
        <span className="rounded-full border border-[var(--chip-line)] bg-[var(--chip-bg)] px-2 py-0.5 text-[10px] font-bold text-[var(--palm)]">
          Fixed {counts.fixed}
        </span>
        <span className="rounded-full border border-[var(--chip-line)] bg-[var(--chip-bg)] px-2 py-0.5 text-[10px] font-bold text-[var(--lagoon-deep)]">
          Not fixed {counts.not_fixed}
        </span>
        <span className="rounded-full border border-[var(--chip-line)] bg-[var(--chip-bg)] px-2 py-0.5 text-[10px] font-bold text-[var(--sea-ink-soft)]">
          Moot {counts.moot}
        </span>
        {staled.length ? (
          <span className="rounded-full border border-amber-300 bg-amber-50 px-2 py-0.5 text-[10px] font-bold text-amber-700">
            Stale {staled.length}
          </span>
        ) : null}
      </div>
      {props.run.status === 'done' &&
      props.verifications.length === 0 &&
      props.reanchors.length === 0 ? (
        <p className="mt-3 text-xs text-[var(--sea-ink-soft)]">
          The verifier reported no verdicts; every target finding remains open.
        </p>
      ) : null}
      {props.verifications.length ? (
        <ul className="mt-3 space-y-2">
          {props.verifications.map((item) => {
            const finding = byId.get(item.findingId)
            return (
              <li
                key={item.findingId}
                className="rounded-xl border border-[var(--line)] bg-[var(--surface)] px-3 py-2"
              >
                <p className="flex items-center gap-2 text-xs font-semibold text-[var(--sea-ink)]">
                  <Chip
                    value={VERDICT_LABELS[item.verdict]}
                    tone={
                      item.verdict === 'fixed'
                        ? 'text-[var(--palm)]'
                        : item.verdict === 'moot'
                          ? 'text-[var(--sea-ink-soft)]'
                          : 'text-[var(--lagoon-deep)]'
                    }
                  />
                  <span className="min-w-0 truncate">
                    {finding?.title ?? item.findingId}
                  </span>
                </p>
                <p className="mt-1 text-xs text-[var(--sea-ink-soft)]">
                  {item.justification}
                </p>
              </li>
            )
          })}
        </ul>
      ) : null}
      {unreported.length ? (
        <ul className="mt-2 space-y-1">
          {unreported.map((item) => (
            <li
              key={item.findingId}
              className="text-xs text-amber-700"
            >
              Anchor vanished for “{byId.get(item.findingId)?.title ?? item.findingId}” — marked stale without an agent verdict.
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}

function FileList(props: {
  files: DiffFile[]
  findings: FindingRow[]
  selected: string | null
  onSelect: (path: string) => void
}) {
  return (
    <aside className="overflow-y-auto border-r border-[var(--line)] bg-[var(--foam)] p-2">
      <h3 className="px-2 py-2 text-xs font-bold uppercase tracking-wider text-[var(--sea-ink-soft)]">
        Changed files
      </h3>
      {props.files.length ? (
        props.files.map((file) => {
          const count = props.findings.filter(
            (item) => item.filePath === file.path,
          ).length
          return (
            <button
              key={file.path}
              type="button"
              onClick={() => props.onSelect(file.path)}
              className={`mb-1 flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left text-xs ${props.selected === file.path ? 'bg-[var(--surface-strong)] text-[var(--sea-ink)] shadow-sm' : 'text-[var(--sea-ink-soft)] hover:bg-[var(--link-bg-hover)]'}`}
            >
              <FileCode2 className="size-3.5 shrink-0" />
              <span
                className="min-w-0 flex-1 truncate font-mono"
                title={file.path}
              >
                {file.path}
              </span>
              {count ? (
                <span className="rounded-full bg-[var(--hero-a)] px-1.5 py-0.5 text-[10px] font-bold text-[var(--palm)]">
                  {count}
                </span>
              ) : null}
            </button>
          )
        })
      ) : (
        <p className="px-2 py-8 text-center text-xs text-[var(--sea-ink-soft)]">
          No files in this diff.
        </p>
      )}
    </aside>
  )
}

function DiffFileView(props: {
  coordinates: Coordinates
  run: ReviewRun
  file: DiffFile
  findings: FindingRow[]
  focusedId: string | null
  noteId: string | null
  onFocus: (finding: FindingRow) => void
  onNote: (id: string | null) => void
  onTriage: (finding: FindingRow, state: TriageState, note?: string) => void
}) {
  const client = useTrpcClient()
  const [viewType, setViewType] = useState<'unified' | 'split'>('unified')
  const parsed = useMemo(() => parseFile(props.file.patch), [props.file.patch])
  const [hunks, setHunks] = useState<HunkData[]>(parsed?.hunks ?? [])
  const [sourceError, setSourceError] = useState<string | null>(null)
  const [expanding, setExpanding] = useState(false)
  const [contextLines, setContextLines] = useState(3)
  const attemptedAnchors = useRef(new Set<string>())
  const tokens = useShikiTokens(hunks, props.file.path)

  useEffect(() => {
    setHunks(parsed?.hunks ?? [])
    setContextLines(3)
    setSourceError(null)
    attemptedAnchors.current.clear()
  }, [parsed])

  const expand = useCallback(
    async (_start: number, end: number) => {
      const requestedContext = Math.max(contextLines + 20, end + 3)
      setExpanding(true)
      setSourceError(null)
      try {
        const result = await client.reviews.expandedDiff.query({
          ...props.coordinates,
          runId: props.run.id,
          filePath: props.file.path,
          contextLines: requestedContext,
        })
        const expanded = parseFile(result.patch)
        if (!expanded) throw new Error('Git returned an empty expanded patch')
        setHunks(expanded.hunks)
        setContextLines(requestedContext)
      } catch (error) {
        setSourceError(error instanceof Error ? error.message : String(error))
      } finally {
        setExpanding(false)
      }
    },
    [client, contextLines, props.coordinates, props.file.path, props.run.id],
  )

  useEffect(() => {
    const focused = props.findings.find((item) => item.id === props.focusedId)
    if (!focused?.currentLine) return
    if (findChangeByNewLineNumber(hunks, focused.currentLine)) {
      requestAnimationFrame(() =>
        document
          .getElementById(`finding-${focused.id}`)
          ?.scrollIntoView({ behavior: 'smooth', block: 'center' }),
      )
      return
    }
    if (attemptedAnchors.current.has(focused.id)) return
    attemptedAnchors.current.add(focused.id)
    const oldLine = getCorrespondingOldLineNumber(hunks, focused.currentLine)
    void expand(
      Math.max(1, (oldLine > 0 ? oldLine : focused.currentLine) - 3),
      (oldLine > 0 ? oldLine : focused.currentLine) + 3,
    )
  }, [expand, hunks, props.findings, props.focusedId])

  const widgets = useMemo(() => {
    const groups = new Map<string, FindingRow[]>()
    for (const item of props.findings) {
      if (!item.currentLine) continue
      const change = findChangeByNewLineNumber(hunks, item.currentLine)
      if (!change) continue
      const key = getChangeKey(change)
      groups.set(key, [...(groups.get(key) ?? []), item])
    }
    return Object.fromEntries(
      [...groups].map(([key, items]) => [
        key,
        <div key={key} className="space-y-2">
          {items.map((item) => (
            <FindingCard
              key={item.id}
              finding={item}
              run={props.run}
              focused={item.id === props.focusedId}
              noteOpen={item.id === props.noteId}
              onFocus={props.onFocus}
              onNote={props.onNote}
              onTriage={props.onTriage}
            />
          ))}
        </div>,
      ]),
    )
  }, [
    hunks,
    props.findings,
    props.focusedId,
    props.noteId,
    props.onFocus,
    props.onNote,
    props.onTriage,
    props.run,
  ])

  if (!parsed || parsed.isBinary)
    return (
      <SurfaceState
        compact
        icon={<FileCode2 className="size-5" />}
        title={parsed?.isBinary ? 'Binary file' : 'Patch unavailable'}
        detail={
          parsed?.isBinary
            ? 'Binary changes cannot be rendered as text.'
            : 'Git did not return a renderable patch for this file.'
        }
      />
    )

  return (
    <div className="min-w-[620px]">
      <div className="sticky top-0 z-20 flex items-center justify-between border-b border-[var(--line)] bg-[var(--surface-strong)] px-4 py-2 backdrop-blur">
        <div className="min-w-0">
          <p className="truncate font-mono text-xs font-semibold text-[var(--sea-ink)]">
            {props.file.path}
          </p>
          <p className="text-[10px] text-[var(--sea-ink-soft)]">
            +{props.file.additions} −{props.file.deletions}
            {props.file.truncated ? ' · patch truncated' : ''}
          </p>
        </div>
        <div className="flex rounded-lg border border-[var(--line)] p-0.5">
          {(['unified', 'split'] as const).map((type) => (
            <button
              type="button"
              key={type}
              onClick={() => setViewType(type)}
              className={`rounded-md px-2 py-1 text-[10px] capitalize ${viewType === type ? 'bg-[var(--hero-a)] text-[var(--sea-ink)]' : 'text-[var(--sea-ink-soft)]'}`}
            >
              {type}
            </button>
          ))}
        </div>
      </div>
      {sourceError ? (
        <p className="border-b border-destructive/20 bg-destructive/5 px-4 py-2 text-xs text-destructive">
          Could not expand context: {sourceError}
        </p>
      ) : null}
      <Diff
        viewType={viewType}
        diffType={parsed.type}
        hunks={hunks}
        widgets={widgets}
        tokens={tokens}
        renderToken={renderShikiToken}
        gutterType="anchor"
        generateAnchorID={(change) =>
          change.type === 'delete'
            ? undefined
            : `line-${props.file.path}-${change.type === 'normal' ? change.newLineNumber : change.lineNumber}`
        }
      >
        {(visibleHunks) => renderHunks(visibleHunks, expand, expanding)}
      </Diff>
    </div>
  )
}

function renderHunks(
  hunks: HunkData[],
  expand: (start: number, end: number) => void,
  expanding: boolean,
): ReactElement[] {
  const rows: ReactElement[] = []
  hunks.forEach((hunk, index) => {
    const previous = index === 0 ? null : hunks[index - 1]
    const collapsed = getCollapsedLinesCountBetween(previous, hunk)
    if (collapsed > 0) {
      const start = previous ? previous.oldStart + previous.oldLines : 1
      const end = hunk.oldStart - 1
      rows.push(
        <Decoration key={`expand-${hunk.content}`}>
          <button
            type="button"
            disabled={expanding}
            onClick={() => void expand(Math.max(start, end - 19), end)}
            className="flex w-full items-center justify-center gap-1 py-1 text-[10px] text-[var(--lagoon-deep)] hover:bg-[var(--hero-a)]"
          >
            <ChevronDown className="size-3" />
            {expanding
              ? 'Loading context…'
              : `Expand ${Math.min(20, collapsed)} of ${collapsed} hidden lines`}
          </button>
        </Decoration>,
      )
    }
    rows.push(<Hunk key={hunk.content} hunk={hunk} />)
  })
  return rows
}

function FindingCard(props: {
  finding: FindingRow
  run: ReviewRun
  focused: boolean
  noteOpen: boolean
  onFocus: (finding: FindingRow) => void
  onNote: (id: string | null) => void
  onTriage: (finding: FindingRow, state: TriageState, note?: string) => void
}) {
  const [note, setNote] = useState(props.finding.triageNote ?? '')
  const ref = useRef<HTMLElement>(null)
  useEffect(() => {
    if (props.focused) ref.current?.focus({ preventScroll: true })
  }, [props.focused])
  useEffect(() => {
    setNote(props.finding.triageNote ?? '')
  }, [props.finding.triageNote])
  return (
    <article
      ref={ref}
      id={`finding-${props.finding.id}`}
      tabIndex={-1}
      onClick={() => props.onFocus(props.finding)}
      className={`my-2 rounded-xl border bg-[var(--surface-strong)] p-3 text-left shadow-sm outline-none ${props.focused ? 'border-[var(--lagoon-deep)] ring-2 ring-[var(--hero-a)]' : 'border-[var(--line)]'}`}
    >
      <div className="flex flex-wrap items-center gap-1.5">
        <Chip
          value={props.finding.severity ?? 'info'}
          tone={severityTone(props.finding.severity)}
        />
        <Chip value={props.finding.category ?? 'general'} />
        {props.finding.lifecycle !== 'open' ? (
          <Chip
            value={props.finding.lifecycle}
            tone={lifecycleTone(props.finding.lifecycle)}
          />
        ) : null}
        {props.finding.createdRunId === props.run.id ? (
          <Chip value="new" tone="text-[var(--lagoon-deep)]" />
        ) : null}
        <span className="ml-auto font-mono text-[9px] text-[var(--sea-ink-soft)]">
          run {props.run.id.slice(0, 8)}
        </span>
      </div>
      <h4 className="mt-2 text-sm font-bold text-[var(--sea-ink)]">
        {props.finding.title}
      </h4>
      {props.finding.body ? <MarkdownText value={props.finding.body} /> : null}
      {props.finding.suggestedFix ? (
        <SuggestedFix value={props.finding.suggestedFix} />
      ) : null}
      <div
        className="mt-3 flex items-center gap-1"
        onClick={(event) => event.stopPropagation()}
      >
        <TriageButton
          active={props.finding.triage === 'valid'}
          label="Valid"
          icon={<Check className="size-3" />}
          onClick={() => props.onTriage(props.finding, 'valid')}
        />
        <TriageButton
          active={props.finding.triage === 'invalid'}
          label="Invalid"
          icon={<X className="size-3" />}
          onClick={() => props.onTriage(props.finding, 'invalid')}
        />
        <TriageButton
          active={props.finding.triage === 'untriaged'}
          label="Reset"
          onClick={() => props.onTriage(props.finding, 'untriaged')}
        />
        <button
          type="button"
          className="ml-auto rounded-md p-1.5 text-[var(--sea-ink-soft)] hover:bg-[var(--hero-a)]"
          title="Edit triage note"
          onClick={() => props.onNote(props.noteOpen ? null : props.finding.id)}
        >
          <MessageSquareText className="size-3.5" />
        </button>
      </div>
      {props.noteOpen ? (
        <div className="mt-2" onClick={(event) => event.stopPropagation()}>
          <Textarea
            autoFocus
            value={note}
            onChange={(event) => setNote(event.target.value)}
            onKeyDown={(event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
              if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
                props.onTriage(props.finding, props.finding.triage, note)
                props.onNote(null)
              }
            }}
            placeholder="Why is this valid or invalid?"
            className="min-h-20 text-xs"
          />
          <div className="mt-1 flex justify-end gap-1">
            <Button
              size="sm"
              variant="ghost"
              onClick={() => props.onNote(null)}
            >
              Cancel
            </Button>
            <Button
              size="sm"
              onClick={() => {
                props.onTriage(props.finding, props.finding.triage, note)
                props.onNote(null)
              }}
            >
              Save note
            </Button>
          </div>
        </div>
      ) : props.finding.triageNote ? (
        <p className="mt-2 rounded-md bg-[var(--foam)] px-2 py-1.5 text-xs italic text-[var(--sea-ink-soft)]">
          {props.finding.triageNote}
        </p>
      ) : null}
    </article>
  )
}

function TriageButton(props: {
  active: boolean
  label: string
  icon?: ReactNode
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={props.onClick}
      className={`flex items-center gap-1 rounded-md px-2 py-1 text-[10px] font-semibold ${props.active ? 'bg-[var(--hero-a)] text-[var(--palm)]' : 'text-[var(--sea-ink-soft)] hover:bg-[var(--foam)]'}`}
    >
      {props.icon}
      {props.label}
    </button>
  )
}

function FindingComparison(props: {
  runs: ReviewRun[]
  findings: FindingRow[]
  idsByRun: Record<string, string[]>
  left: string
  right: string
  onLeft: (id: string) => void
  onRight: (id: string) => void
  onFinding: (finding: FindingRow) => void
}) {
  const leftIds = new Set(props.idsByRun[props.left] ?? [])
  const rightIds = new Set(props.idsByRun[props.right] ?? [])
  const added = props.findings.filter(
    (item) => rightIds.has(item.id) && !leftIds.has(item.id),
  )
  const unchanged = props.findings.filter(
    (item) => rightIds.has(item.id) && leftIds.has(item.id),
  )
  const gone = props.findings.filter(
    (item) => leftIds.has(item.id) && !rightIds.has(item.id),
  )
  return (
    <div className="island-shell mt-5 rounded-2xl p-4">
      <div className="flex flex-wrap items-center gap-2">
        <GitCompareArrows className="size-4 text-[var(--lagoon-deep)]" />
        <h3 className="mr-auto text-sm font-bold text-[var(--sea-ink)]">
          Diff of findings
        </h3>
        <RunPicker
          runs={props.runs}
          value={props.left}
          onChange={props.onLeft}
        />
        <ChevronRight className="size-4 text-[var(--sea-ink-soft)]" />
        <RunPicker
          runs={props.runs}
          value={props.right}
          onChange={props.onRight}
        />
      </div>
      <div className="mt-4 grid grid-cols-3 gap-3">
        {(
          [
            ['Added', added, 'text-[var(--palm)]'],
            ['Unchanged', unchanged, 'text-[var(--sea-ink-soft)]'],
            ['Gone', gone, 'text-destructive'],
          ] as const
        ).map(([label, items, tone]) => (
          <div
            key={label}
            className="rounded-xl border border-[var(--line)] bg-[var(--surface)] p-3"
          >
            <p className={`text-xs font-bold ${tone}`}>
              {label} · {items.length}
            </p>
            {items.length ? (
              <ul className="mt-2 space-y-1">
                {items.map((item) => (
                  <li key={item.id}>
                    <button
                      type="button"
                      onClick={() => props.onFinding(item)}
                      className="w-full truncate text-left text-xs text-[var(--sea-ink)] hover:text-[var(--lagoon-deep)]"
                      title={item.title}
                    >
                      {item.title}
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-2 text-xs text-[var(--sea-ink-soft)]">None</p>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}

function SuggestedFix({ value }: { value: string }) {
  const parsed = parseFile(value)
  return (
    <details className="mt-3 rounded-lg border border-[var(--line)] bg-[var(--foam)]">
      <summary className="cursor-pointer px-3 py-2 text-xs font-semibold text-[var(--sea-ink)]">
        Suggested fix
      </summary>
      <div className="overflow-x-auto border-t border-[var(--line)]">
        {parsed && !parsed.isBinary ? (
          <Diff viewType="unified" diffType={parsed.type} hunks={parsed.hunks}>
            {(hunks) =>
              hunks.map((hunk) => <Hunk key={hunk.content} hunk={hunk} />)
            }
          </Diff>
        ) : (
          <pre className="p-3 text-[11px] leading-5">
            {value.split('\n').map((line, index) => (
              <span
                key={index}
                className={`block ${line.startsWith('+') ? 'bg-emerald-500/10 text-emerald-800' : line.startsWith('-') ? 'bg-red-500/10 text-red-800' : ''}`}
              >
                {line || ' '}
              </span>
            ))}
          </pre>
        )}
      </div>
    </details>
  )
}

function MarkdownText({ value }: { value: string }) {
  const blocks = value.split(/(```[\s\S]*?```)/g).filter(Boolean)
  return (
    <div className="mt-2 space-y-2 text-xs leading-relaxed text-[var(--sea-ink-soft)]">
      {blocks.map((block, index) =>
        block.startsWith('```') ? (
          <pre
            key={index}
            className="overflow-x-auto rounded-lg bg-slate-900 p-3 font-mono text-[11px] text-slate-100"
          >
            <code>
              {block.replace(/^```[^\n]*\n?/, '').replace(/```$/, '')}
            </code>
          </pre>
        ) : (
          <Fragment key={index}>
            {block.split(/\n{2,}/).map((paragraph, childIndex) => (
              <p key={childIndex} className="whitespace-pre-wrap">
                {renderInlineMarkdown(paragraph)}
              </p>
            ))}
          </Fragment>
        ),
      )}
    </div>
  )
}

function renderInlineMarkdown(value: string): ReactNode[] {
  return value
    .split(/(`[^`]+`|\*\*[^*]+\*\*)/g)
    .filter(Boolean)
    .map((part, index) =>
      part.startsWith('`') ? (
        <code key={index}>{part.slice(1, -1)}</code>
      ) : part.startsWith('**') ? (
        <strong key={index}>{part.slice(2, -2)}</strong>
      ) : (
        part
      ),
    )
}

function useShikiTokens(
  hunks: HunkData[],
  filePath: string,
): HunkTokens | null {
  const [tokens, setTokens] = useState<HunkTokens | null>(null)
  useEffect(() => {
    let cancelled = false
    const lines = sideLines(hunks)
    Promise.all([
      codeToTokens(lines.old.join('\n'), {
        lang: languageForPath(filePath),
        theme: 'github-light',
      }),
      codeToTokens(lines.new.join('\n'), {
        lang: languageForPath(filePath),
        theme: 'github-light',
      }),
    ])
      .then(([oldResult, newResult]) => {
        if (!cancelled)
          setTokens({
            old: toTokenNodes(oldResult.tokens),
            new: toTokenNodes(newResult.tokens),
          })
      })
      .catch(() => {
        if (!cancelled) setTokens(null)
      })
    return () => {
      cancelled = true
    }
  }, [hunks, filePath])
  return tokens
}

function sideLines(hunks: HunkData[]): { old: string[]; new: string[] } {
  const old: string[] = []
  const next: string[] = []
  for (const hunk of hunks)
    for (const change of hunk.changes) {
      if (change.type === 'normal' || change.type === 'delete')
        old[
          (change.type === 'normal'
            ? change.oldLineNumber
            : change.lineNumber) - 1
        ] = change.content
      if (change.type === 'normal' || change.type === 'insert')
        next[
          (change.type === 'normal'
            ? change.newLineNumber
            : change.lineNumber) - 1
        ] = change.content
    }
  return {
    old: Array.from({ length: old.length }, (_, index) => old[index] ?? ''),
    new: Array.from({ length: next.length }, (_, index) => next[index] ?? ''),
  }
}

function toTokenNodes(
  lines: Array<Array<{ content: string; color?: string; fontStyle?: number }>>,
): TokenNode[][] {
  return lines.map((line) =>
    line.map((token) => ({
      type: 'shiki',
      value: token.content,
      color: token.color,
      fontStyle: token.fontStyle,
    })),
  )
}

function renderShikiToken(
  token: TokenNode,
  renderDefault: (token: TokenNode, index: number) => ReactNode,
  index: number,
): ReactNode {
  if (token.type !== 'shiki') return renderDefault(token, index)
  const fontStyle = Number(token.fontStyle ?? 0)
  return (
    <span
      key={index}
      style={{
        color: String(token.color ?? 'inherit'),
        fontStyle: fontStyle & 1 ? 'italic' : undefined,
        fontWeight: fontStyle & 2 ? 700 : undefined,
        textDecoration: fontStyle & 4 ? 'underline' : undefined,
      }}
    >
      {String(token.value ?? '')}
    </span>
  )
}

type HighlightLanguage =
  | 'typescript'
  | 'tsx'
  | 'javascript'
  | 'jsx'
  | 'json'
  | 'css'
  | 'html'
  | 'markdown'
  | 'python'
  | 'ruby'
  | 'go'
  | 'rust'
  | 'shellscript'
  | 'yaml'
  | 'sql'
  | 'text'

function languageForPath(filePath: string): HighlightLanguage {
  const extension = filePath.split('.').pop()?.toLowerCase()
  const languages: Record<string, HighlightLanguage> = {
    ts: 'typescript',
    tsx: 'tsx',
    js: 'javascript',
    jsx: 'jsx',
    json: 'json',
    css: 'css',
    html: 'html',
    md: 'markdown',
    py: 'python',
    rb: 'ruby',
    go: 'go',
    rs: 'rust',
    sh: 'shellscript',
    bash: 'shellscript',
    yml: 'yaml',
    yaml: 'yaml',
    sql: 'sql',
  }
  return languages[extension ?? ''] ?? 'text'
}

function parseFile(patch: string | undefined): File | null {
  if (!patch) return null
  return gitDiffParser.parse(patch)[0] ?? null
}

function Chip({ value, tone = '' }: { value: string; tone?: string }) {
  return (
    <span
      className={`rounded-full border border-[var(--chip-line)] bg-[var(--chip-bg)] px-2 py-0.5 text-[9px] font-bold uppercase tracking-wide ${tone}`}
    >
      {value}
    </span>
  )
}
function severityTone(value: string | null): string {
  return value === 'critical' || value === 'high'
    ? 'text-destructive'
    : value === 'medium'
      ? 'text-amber-700'
      : 'text-[var(--palm)]'
}
function lifecycleTone(value: FindingRow['lifecycle']): string {
  return value === 'fixed'
    ? 'text-[var(--palm)]'
    : value === 'stale'
      ? 'text-amber-700'
      : 'text-[var(--sea-ink-soft)]'
}
function runLabel(run: ReviewRun): string {
  const date = run.startedAt
    ? new Date(run.startedAt).toLocaleString()
    : 'Not started'
  return `${run.kind === 'verify' ? 'Verify' : 'Review'} · ${date} · ${run.status} · ${run.id.slice(0, 8)}`
}

function SurfaceState({
  icon,
  title,
  detail,
  tone = 'normal',
  compact = false,
}: {
  icon: ReactNode
  title: string
  detail: string
  tone?: 'normal' | 'error'
  compact?: boolean
}) {
  return (
    <div
      className={`${compact ? 'm-6' : 'mt-8'} rounded-2xl border border-[var(--line)] bg-[var(--surface)] px-6 py-10 text-center ${tone === 'error' ? 'text-destructive' : 'text-[var(--sea-ink-soft)]'}`}
    >
      <span className="mx-auto flex size-10 items-center justify-center rounded-full bg-[var(--hero-a)]">
        {icon}
      </span>
      <p className="mt-3 text-sm font-bold text-[var(--sea-ink)]">{title}</p>
      <p className="mx-auto mt-1 max-w-lg text-xs">{detail}</p>
    </div>
  )
}
