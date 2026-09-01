import { z } from 'zod'
import {
  chooseReferenceClone,
  clearCaches,
  getCacheUsage,
  getRepoStatus,
  mapReferenceClone,
  operationKey,
  prepareMergeRequest,
} from '../../repo/service.ts'
import { publicProcedure, router } from '../base.ts'

const coordinates = z.object({
  instanceId: z.string().min(1),
  gitlabProjectId: z.number().int().positive(),
  iid: z.number().int().positive(),
})

export const reposRouter = router({
  status: publicProcedure
    .input(coordinates)
    .query(({ input }) =>
      getRepoStatus(
        operationKey(input.instanceId, input.gitlabProjectId, input.iid),
      ),
    ),
  prepare: publicProcedure
    .input(
      coordinates.extend({
        baseSha: z.string().regex(/^[0-9a-f]{40,64}$/i),
        headSha: z.string().regex(/^[0-9a-f]{40,64}$/i),
        selectedPaths: z.array(z.string().min(1)).min(1).max(150).optional(),
      }),
    )
    .mutation(({ input }) => prepareMergeRequest(input)),
  chooseReferenceClone: publicProcedure.mutation(() => chooseReferenceClone()),
  mapReferenceClone: publicProcedure
    .input(
      z.object({
        instanceId: z.string().min(1),
        projectId: z.string().min(1),
        clonePath: z.string().min(1).nullable(),
      }),
    )
    .mutation(({ input }) => mapReferenceClone(input)),
  cacheUsage: publicProcedure.query(() => getCacheUsage()),
  clearCaches: publicProcedure.mutation(() => clearCaches()),
})
