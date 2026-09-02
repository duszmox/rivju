import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import { and, eq, ne } from 'drizzle-orm'
import { lstat, readFile, realpath } from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'
import type { RivjuDatabase } from '../db/client.ts'
import { finding, findingEvent } from '../db/schema.ts'
import type { FindingRow } from '../db/schema.ts'
import { emitRunEvent } from '../events/bus.ts'
import { runGit } from '../repo/git.ts'
import { reanchorFinding } from './anchor.ts'

// ---- re-anchoring -----------------------------------------------------------

export type ReanchorSummary = {
  checked: number
  reanchored: number
  staled: number
  unchanged: number
  /** Findings still `open` after re-anchoring — the verify agent's target set. */
  open: FindingRow[]
}

/**
 * Re-anchors every still-open, non-invalid finding of an MR against a fresh checkout at
 * the new head. File-level work (reading the checkout) lives here; the
 * matching itself is the pure engine in `anchor.ts`. Stale findings are marked
 * immediately — `stale` means "the code moved or vanished", never "fixed" —
 * and are excluded from the returned target set.
 */
export async function reanchorOpenFindings(input: {
  db: RivjuDatabase
  mergeRequestId: string
  runId: string
  headSha: string
  worktreePath: string
  mirrorPath: string | null
  oldHeadSha: string | null
}): Promise<ReanchorSummary> {
  const open = input.db
    .select()
    .from(finding)
    .where(
      and(
        eq(finding.mergeRequestId, input.mergeRequestId),
        eq(finding.lifecycle, 'open'),
        ne(finding.triage, 'invalid'),
      ),
    )
    .all()
  const renames =
    input.mirrorPath && input.oldHeadSha
      ? await renamesBetween(input.mirrorPath, input.oldHeadSha, input.headSha).catch(
          () => new Map<string, string>(),
        )
      : new Map<string, string>()

  let reanchored = 0
  let staled = 0
  let unchanged = 0
  const remaining: FindingRow[] = []

  for (const row of open) {
    // Global findings have no anchor to prove; the verify agent judges them.
    if (!row.filePath || !row.anchorSnippet) {
      remaining.push(row)
      continue
    }
    const targetPath = renames.get(row.filePath) ?? row.filePath
    const content = await readWorktreeFile(input.worktreePath, targetPath)
    const resolution = reanchorFinding({
      content,
      filePath: targetPath,
      state: {
        filePath: row.filePath,
        anchorSnippet: row.anchorSnippet,
        ctxBefore: row.ctxBefore,
        ctxAfter: row.ctxAfter,
        currentLine: row.currentLine,
      },
    })

    if (resolution.outcome === 'stale') {
      const updated = input.db
        .update(finding)
        .set({ lifecycle: 'stale', lifecycleRunId: input.runId })
        .where(eq(finding.id, row.id))
        .returning()
        .get()
      input.db
        .insert(findingEvent)
        .values({
          findingId: row.id,
          runId: input.runId,
          type: 'reanchored',
          payload: {
            outcome: 'stale',
            reason: resolution.reason,
            from: { path: row.filePath, line: row.currentLine },
            headSha: input.headSha,
          },
        })
        .run()
      emitRunEvent({ type: 'run:finding', runId: input.runId, at: Date.now(), finding: updated })
      staled++
      continue
    }

    const changed =
      resolution.outcome !== 'unchanged' ||
      resolution.tier === 'trimmed' ||
      resolution.snippet !== row.anchorSnippet ||
      resolution.ctxBefore !== (row.ctxBefore ?? '') ||
      resolution.ctxAfter !== (row.ctxAfter ?? '')
    if (!changed) {
      unchanged++
      remaining.push(row)
      continue
    }
    const updated = input.db
      .update(finding)
      .set({
        filePath: resolution.filePath,
        currentLine: resolution.line,
        anchorSnippet: resolution.snippet,
        ctxBefore: resolution.ctxBefore,
        ctxAfter: resolution.ctxAfter,
      })
      .where(eq(finding.id, row.id))
      .returning()
      .get()
    input.db
      .insert(findingEvent)
      .values({
        findingId: row.id,
        runId: input.runId,
        type: 'reanchored',
        payload: {
          outcome: resolution.outcome,
          tier: resolution.tier,
          ambiguous: resolution.ambiguous,
          from: { path: row.filePath, line: row.currentLine },
          to: { path: resolution.filePath, line: resolution.line },
          headSha: input.headSha,
        },
      })
      .run()
    emitRunEvent({ type: 'run:finding', runId: input.runId, at: Date.now(), finding: updated })
    reanchored++
    remaining.push(updated)
  }

  return { checked: open.length, reanchored, staled, unchanged, open: remaining }
}

/** Rename map (old path -> new path) between two revisions of a mirror. */
export async function renamesBetween(
  mirrorPath: string,
  oldSha: string,
  newSha: string,
): Promise<Map<string, string>> {
  const result = await runGit([
    '--git-dir',
    mirrorPath,
    'diff',
    '--find-renames',
    '--name-status',
    '-z',
    `${oldSha}...${newSha}`,
  ])
  const fields = result.stdout.split('\0')
  if (fields.at(-1) === '') fields.pop()
  const renames = new Map<string, string>()
  for (let index = 0; index < fields.length; ) {
    const code = fields[index++] ?? ''
    const firstPath = fields[index++]
    if (!firstPath) break
    if (code.startsWith('R')) {
      const newPath = fields[index++]
      if (newPath) renames.set(firstPath, newPath)
    }
  }
  return renames
}

async function readWorktreeFile(
  worktreePath: string,
  relPath: string,
): Promise<string | null> {
  if (
    !relPath ||
    path.isAbsolute(relPath) ||
    relPath.split(/[\\/]/).includes('..')
  )
    return null
  const root = await realpath(worktreePath)
  const candidate = path.resolve(root, relPath)
  let resolved: string
  try {
    resolved = await realpath(candidate)
    const info = await lstat(resolved)
    if (!info.isFile()) return null
  } catch {
    return null
  }
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) return null
  return readFile(resolved, 'utf8').catch(() => null)
}

// ---- verification reports ---------------------------------------------------

const verificationShape = {
  finding_id: z.string().uuid(),
  verdict: z.enum(['fixed', 'not_fixed', 'moot']),
  justification: z.string().min(1),
}
const verificationInputSchema = z.object(verificationShape)
export type VerificationInput = z.infer<typeof verificationInputSchema>

export async function processVerificationReport(
  input: {
    db: RivjuDatabase
    runId: string
    mergeRequestId: string
    headSha: string
    targetFindingIds: ReadonlySet<string>
  },
  args: VerificationInput,
): Promise<{ accepted: true; row: FindingRow } | { accepted: false; error: string }> {
  if (!input.targetFindingIds.has(args.finding_id)) {
    return {
      accepted: false,
      error: `finding_id ${args.finding_id} is not part of this verification run's open-finding set.`,
    }
  }
  const row = input.db.transaction((tx) => {
    const existing = tx
      .select()
      .from(finding)
      .where(
        and(
          eq(finding.id, args.finding_id),
          eq(finding.mergeRequestId, input.mergeRequestId),
        ),
      )
      .get()
    if (!existing) return null
    // A verify run may ONLY move lifecycle to fixed/moot. It must never touch
    // finding.triage — that axis belongs to the human alone.
    const lifecycle =
      args.verdict === 'fixed' ? 'fixed' : args.verdict === 'moot' ? 'moot' : existing.lifecycle
    const updated = tx
      .update(finding)
      .set({
        lifecycle,
        ...(args.verdict === 'not_fixed' ? {} : { lifecycleRunId: input.runId }),
      })
      .where(eq(finding.id, existing.id))
      .returning()
      .get()
    tx
      .insert(findingEvent)
      .values({
        findingId: existing.id,
        runId: input.runId,
        type: 'verified',
        payload: {
          verdict: args.verdict,
          justification: args.justification,
          headSha: input.headSha,
        },
      })
      .run()
    return updated
  })
  if (!row) {
    return { accepted: false, error: `Unknown finding id: ${args.finding_id}` }
  }
  emitRunEvent({ type: 'run:finding', runId: input.runId, at: Date.now(), finding: row })
  return { accepted: true, row }
}

export function createVerifyMcp(input: {
  db: RivjuDatabase
  runId: string
  mergeRequestId: string
  headSha: string
  targetFindingIds: ReadonlySet<string>
  onFinished: (summary: string) => void
}) {
  let closed = false

  const reportVerification = tool(
    'report_verification',
    'Report the verification verdict for one open finding after inspecting the checkout.',
    verificationShape,
    async (args) => {
      emitRunEvent({
        type: 'run:tool',
        runId: input.runId,
        at: Date.now(),
        tool: 'report_verification',
        summary: `${args.verdict} · ${args.finding_id.slice(0, 8)}`,
      })
      if (closed) {
        return {
          content: [{ type: 'text' as const, text: 'REJECTED: finish_review already closed this run.' }],
          isError: true,
        }
      }
      const result = await processVerificationReport(input, args)
      return result.accepted
        ? { content: [{ type: 'text' as const, text: `Recorded ${args.verdict} for finding ${args.finding_id}.` }] }
        : { content: [{ type: 'text' as const, text: `REJECTED: ${result.error}` }], isError: true }
    },
  )

  const finishVerification = tool(
    'finish_review',
    'Finish the verification after every open finding has a verdict.',
    { summary: z.string().min(1) },
    async (args) => {
      if (closed) {
        return {
          content: [{ type: 'text' as const, text: 'REJECTED: finish_review may only be called once.' }],
          isError: true,
        }
      }
      closed = true
      input.onFinished(args.summary)
      emitRunEvent({
        type: 'run:tool',
        runId: input.runId,
        at: Date.now(),
        tool: 'finish_review',
        summary: args.summary.slice(0, 120),
      })
      return { content: [{ type: 'text' as const, text: 'Verification finished successfully.' }] }
    },
  )

  return createSdkMcpServer({
    name: 'rivju',
    version: '1.0.0',
    instructions:
      'Call report_verification once per open finding, then finish_review exactly once.',
    tools: [reportVerification, finishVerification],
    alwaysLoad: true,
  })
}
