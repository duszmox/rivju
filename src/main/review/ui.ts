import { TRPCError } from '@trpc/server'
import { and, eq } from 'drizzle-orm'
import { stat } from 'node:fs/promises'
import path from 'node:path'
import { getDb } from '../db/client.ts'
import {
  finding,
  findingEvent,
  gitlabInstance,
  mergeRequest,
  project,
  run,
} from '../db/schema.ts'
import { computeDiff } from '../repo/diff.ts'
import { runGit } from '../repo/git.ts'

export interface ReviewCoordinates {
  instanceId: string
  gitlabProjectId: number
  iid: number
}

export async function getReview(input: ReviewCoordinates & { runId?: string }) {
  const context = reviewContext(input)
  const runs = getDb()
    .select()
    .from(run)
    .where(eq(run.mergeRequestId, context.mr.id))
    .all()
    .sort(
      (left, right) => timeValue(right.startedAt) - timeValue(left.startedAt),
    )
  const selectedRun = input.runId
    ? runs.find((item) => item.id === input.runId)
    : (runs.find((item) => item.status === 'done') ?? runs[0])

  if (input.runId && !selectedRun) {
    throw new TRPCError({
      code: 'NOT_FOUND',
      message: 'Review run not found for this merge request',
    })
  }

  const findings = getDb()
    .select()
    .from(finding)
    .where(eq(finding.mergeRequestId, context.mr.id))
    .all()
  const submittedEvents = getDb()
    .select({ findingId: findingEvent.findingId, runId: findingEvent.runId })
    .from(findingEvent)
    .where(eq(findingEvent.type, 'submitted'))
    .all()
    .filter((event) => runs.some((item) => item.id === event.runId))
  const findingIdsByRun = Object.fromEntries(
    runs.map((item) => [
      item.id,
      submittedEvents
        .filter((event) => event.runId === item.id && event.findingId)
        .map((event) => event.findingId as string),
    ]),
  )

  let diff = null
  if (
    selectedRun?.baseSha &&
    selectedRun.headSha &&
    context.project.mirrorPath
  ) {
    const result = await computeDiff({
      mirrorPath: context.project.mirrorPath,
      baseSha: selectedRun.baseSha,
      headSha: selectedRun.headSha,
    })
    if (result.status === 'ready') diff = result
  }

  return {
    mergeRequestId: context.mr.id,
    selectedRunId: selectedRun?.id ?? null,
    runs,
    findings,
    findingIdsByRun,
    diff,
  }
}

export function updateFindingTriage(input: {
  findingId: string
  runId: string
  triage: 'untriaged' | 'valid' | 'invalid'
  note: string
}) {
  return getDb().transaction((tx) => {
    const existing = tx
      .select({ finding, run })
      .from(finding)
      .innerJoin(run, eq(run.mergeRequestId, finding.mergeRequestId))
      .where(and(eq(finding.id, input.findingId), eq(run.id, input.runId)))
      .get()
    if (!existing) {
      throw new TRPCError({
        code: 'NOT_FOUND',
        message: 'Finding does not belong to this review run',
      })
    }
    const updated = tx
      .update(finding)
      .set({ triage: input.triage, triageNote: input.note.trim() || null })
      .where(eq(finding.id, input.findingId))
      .returning()
      .get()
    tx.insert(findingEvent)
      .values({
        findingId: input.findingId,
        runId: input.runId,
        type: 'triaged',
        payload: { triage: input.triage, note: input.note.trim() },
      })
      .run()
    return updated
  })
}

export async function getExpandedReviewPatch(
  input: ReviewCoordinates & {
    runId: string
    filePath: string
    contextLines: number
  },
): Promise<{ patch: string; sourceKind: 'worktree' | 'mirror' }> {
  const context = reviewContext(input)
  const selectedRun = getDb()
    .select()
    .from(run)
    .where(and(eq(run.id, input.runId), eq(run.mergeRequestId, context.mr.id)))
    .get()
  if (!selectedRun?.baseSha || !selectedRun.headSha) {
    throw new TRPCError({
      code: 'NOT_FOUND',
      message: 'Review revisions are unavailable',
    })
  }
  validateRelativePath(input.filePath)
  const range = `${selectedRun.baseSha}...${selectedRun.headSha}`
  const diffArgs = [
    'diff',
    '--find-renames',
    `--unified=${input.contextLines}`,
    range,
    '--',
    input.filePath,
  ]

  if (
    selectedRun.worktreePath &&
    (await isDirectory(selectedRun.worktreePath))
  ) {
    const result = await runGit(['-C', selectedRun.worktreePath, ...diffArgs], {
      maxOutputBytes: 2 * 1024 * 1024,
    })
    if (result.truncated) throw patchTooLarge()
    return { patch: result.stdout, sourceKind: 'worktree' }
  }
  if (!context.project.mirrorPath) {
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: 'Repository mirror is unavailable',
    })
  }
  const result = await runGit(
    ['--git-dir', context.project.mirrorPath, ...diffArgs],
    {
      maxOutputBytes: 2 * 1024 * 1024,
    },
  )
  if (result.truncated) throw patchTooLarge()
  return { patch: result.stdout, sourceKind: 'mirror' }
}

function reviewContext(input: ReviewCoordinates) {
  const context = getDb()
    .select({ instance: gitlabInstance, project, mr: mergeRequest })
    .from(mergeRequest)
    .innerJoin(project, eq(project.id, mergeRequest.projectId))
    .innerJoin(gitlabInstance, eq(gitlabInstance.id, project.instanceId))
    .where(
      and(
        eq(project.instanceId, input.instanceId),
        eq(project.gitlabProjectId, String(input.gitlabProjectId)),
        eq(mergeRequest.iid, input.iid),
      ),
    )
    .get()
  if (!context) {
    throw new TRPCError({
      code: 'NOT_FOUND',
      message: 'Merge request not found',
    })
  }
  return context
}

function validateRelativePath(filePath: string): void {
  if (
    !filePath ||
    path.isAbsolute(filePath) ||
    filePath.split(/[\\/]/).includes('..')
  ) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: 'Invalid repository path',
    })
  }
}

async function isDirectory(candidate: string): Promise<boolean> {
  return stat(candidate)
    .then((value) => value.isDirectory())
    .catch(() => false)
}

function patchTooLarge(): TRPCError {
  return new TRPCError({
    code: 'PAYLOAD_TOO_LARGE',
    message: 'Expanded patch is too large to display safely',
  })
}

function timeValue(value: Date | null): number {
  return value?.getTime() ?? 0
}
