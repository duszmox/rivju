import { z } from 'zod'
import {
  getExpandedReviewPatch,
  getReview,
  updateFindingTriage,
} from '../../review/ui.ts'
import { publicProcedure, router } from '../base.ts'

const coordinates = z.object({
  instanceId: z.string().min(1),
  gitlabProjectId: z.number().int().positive(),
  iid: z.number().int().positive(),
})

export const reviewsRouter = router({
  detail: publicProcedure
    .input(coordinates.extend({ runId: z.string().uuid().optional() }))
    .query(({ input }) => getReview(input)),
  expandedDiff: publicProcedure
    .input(
      coordinates.extend({
        runId: z.string().uuid(),
        filePath: z.string().min(1).max(4096),
        contextLines: z.number().int().min(4).max(100_000),
      }),
    )
    .query(({ input }) => getExpandedReviewPatch(input)),
  triage: publicProcedure
    .input(
      z.object({
        findingId: z.string().uuid(),
        runId: z.string().uuid(),
        triage: z.enum(['untriaged', 'valid', 'invalid']),
        note: z.string().max(4_000),
      }),
    )
    .mutation(({ input }) => updateFindingTriage(input)),
})
