import { and, eq } from 'drizzle-orm'
import type { RivjuDatabase } from '../db/client.ts'
import { finding, mergeRequest } from '../db/schema.ts'

export interface RejectedFindingSummary {
  filePath: string | null
  category: string | null
  title: string
  note: string | null
}

/**
 * The human-rejected (`invalid`) findings for a PROJECT — not just one merge
 * request. Every subsequent run for the project receives these as a prompt
 * block so the agent stops re-reporting issues the reviewer has already
 * dismissed.
 */
export function collectRejectedFindings(
  db: RivjuDatabase,
  projectId: string,
  limit = 50,
): RejectedFindingSummary[] {
  return db
    .select({
      filePath: finding.filePath,
      category: finding.category,
      title: finding.title,
      note: finding.triageNote,
    })
    .from(finding)
    .innerJoin(mergeRequest, eq(finding.mergeRequestId, mergeRequest.id))
    .where(
      and(eq(mergeRequest.projectId, projectId), eq(finding.triage, 'invalid')),
    )
    .all()
    .slice(0, limit)
}
