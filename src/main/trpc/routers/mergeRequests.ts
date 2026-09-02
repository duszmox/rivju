import { z } from 'zod'
import {
  fetchMergeRequestDetail,
  fetchReviewQueue,
} from '../../gitlab/service.ts'
import { publicProcedure, router } from '../base.ts'

export const mergeRequestsRouter = router({
  /**
   * Default review queue across ALL instances: MRs where the authenticated
   * user is reviewer OR assignee, state=opened. Always fetched live — the DB
   * is never the source of truth for this list.
   */
  reviewQueue: publicProcedure.query(() => fetchReviewQueue()),

  /**
   * Live MR check used on every detail-page mount. It returns a newer remote
   * head without accepting it, so the renderer can offer an explicit pull.
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
      fetchMergeRequestDetail(
        input.instanceId,
        input.gitlabProjectId,
        input.iid,
        {
          acceptLatest: false,
        },
      ),
    ),
  pullLatest: publicProcedure
    .input(
      z.object({
        instanceId: z.string().min(1),
        gitlabProjectId: z.number().int().positive(),
        iid: z.number().int().positive(),
      }),
    )
    .mutation(({ input }) =>
      fetchMergeRequestDetail(
        input.instanceId,
        input.gitlabProjectId,
        input.iid,
        {
          acceptLatest: true,
        },
      ),
    ),
})
