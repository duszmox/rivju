import { and, desc, eq, isNotNull } from 'drizzle-orm'
import { getDb } from '../db/client.ts'
import { mergeRequest, project, run } from '../db/schema.ts'
import { runGit } from '../repo/git.ts'

export type HeadMovement =
  | { status: 'no_review' }
  | { status: 'current'; oldHead: string; newHead: string }
  | {
      status: 'ahead'
      oldHead: string
      newHead: string
      /** null when the commits exist remotely but are not fetched locally yet. */
      commitCount: number | null
      commits: { sha: string; subject: string }[]
    }
  | { status: 'unknown'; oldHead: string | null; reason: string }

const SAMPLE_COMMITS = 20

/**
 * How far the merge request head has moved since the most recent completed
 * review. Purely local git work against the prepared mirror — the renderer
 * supplies the current head it received from GitLab.
 */
export async function getHeadMovement(input: {
  instanceId: string
  gitlabProjectId: number
  iid: number
  /** Current head SHA as reported by GitLab (from the MR detail query). */
  headSha?: string | null
}): Promise<HeadMovement> {
  const context = getDb()
    .select({ project, mr: mergeRequest })
    .from(mergeRequest)
    .innerJoin(project, eq(project.id, mergeRequest.projectId))
    .where(
      and(
        eq(project.instanceId, input.instanceId),
        eq(project.gitlabProjectId, String(input.gitlabProjectId)),
        eq(mergeRequest.iid, input.iid),
      ),
    )
    .get()
  if (!context) return { status: 'no_review' }

  const oldHead = latestDoneHead(context.mr.id)
  if (!oldHead) return { status: 'no_review' }

  const newHead = input.headSha ?? context.mr.lastSeenHeadSha ?? null
  if (!newHead || !isSha(newHead) || newHead === oldHead) {
    return { status: 'current', oldHead, newHead: newHead ?? oldHead }
  }
  const mirrorPath = context.project.mirrorPath
  if (!mirrorPath) {
    return { status: 'unknown', oldHead, reason: 'The repository mirror is not prepared yet' }
  }

  try {
    const count = await runGit([
      '--git-dir', mirrorPath, 'rev-list', '--count', `${oldHead}..${newHead}`,
    ])
    const commitCount = Number.parseInt(count.stdout.trim(), 10)
    if (!Number.isFinite(commitCount)) {
      return { status: 'unknown', oldHead, reason: 'git rev-list returned an unreadable count' }
    }
    if (commitCount === 0) return { status: 'current', oldHead, newHead }
    const sampled = await runGit([
      '--git-dir',
      mirrorPath,
      'log',
      '--format=%H%x1f%s%x1e',
      '-n',
      String(SAMPLE_COMMITS),
      `${oldHead}..${newHead}`,
    ])
    return {
      status: 'ahead',
      oldHead,
      newHead,
      commitCount,
      commits: parseCommitSamples(sampled.stdout),
    }
  } catch {
    // The mirror does not know the new head yet (moved after preparation).
    return {
      status: 'ahead',
      oldHead,
      newHead,
      commitCount: null,
      commits: [],
    }
  }
}

function latestDoneHead(mergeRequestId: string): string | null {
  const row = getDb()
    .select({ headSha: run.headSha })
    .from(run)
    .where(and(eq(run.mergeRequestId, mergeRequestId), eq(run.status, 'done'), isNotNull(run.headSha)))
    .orderBy(desc(run.startedAt))
    .get()
  return row?.headSha ?? null
}

/**
 * Parses `git log --format=%H%x1f%s%x1e` output: one `<sha><US><subject><RS>`
 * record per commit, newline-terminated.
 */
export function parseCommitSamples(stdout: string): { sha: string; subject: string }[] {
  return stdout
    .split('\x1e')
    .map((record) => record.trim())
    .filter(Boolean)
    .map((record) => {
      const separator = record.indexOf('\x1f')
      if (separator < 0) return null
      const sha = record.slice(0, separator)
      const subject = record.slice(separator + 1)
      if (!sha || !subject) return null
      return { sha, subject }
    })
    .filter((commit): commit is { sha: string; subject: string } => commit !== null)
}

function isSha(value: string): boolean {
  return /^[0-9a-f]{40,64}$/i.test(value)
}
