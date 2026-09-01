import { z } from 'zod'
import { fetchMergeRequestDetail, fetchReviewQueue } from '../../gitlab/service.ts'
import { publicProcedure, router } from '../base.ts'

export const mergeRequestsRouter = router({
  /**
   * Default review queue across ALL instances: MRs where the authenticated
   * user is reviewer OR assignee, state=opened. Always fetched live — the DB
   * is never the source of truth for this list.
   */
  reviewQueue: publicProcedure.query(() => fetchReviewQueue()),

  /**
   * MR detail: metadata, `diff_refs` (base/head/start sha) and the
   * changed-file list. Also persists the project + merge_request rows so the
   * Phase 2 repo layer can resolve branches and head sha.
   */
  detail: publicProcedure
    .input(
      z.object({
        instanceId: z.string().min(1),
        gitlabProjectId: z.number().int().positive(),
        iid: z.number().int().positive(),
      }),
    )
    .query(({ input }) =>
      fetchMergeRequestDetail(input.instanceId, input.gitlabProjectId, input.iid),
    ),
})
