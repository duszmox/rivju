import { z } from 'zod'
import {
  EFFORT_LEVELS,
  describeEffectiveSelection,
  findProjectIdByCoordinates,
  getGlobalDefaults,
  listProjectDefaults,
  setGlobalDefaults,
  setProjectDefaults,
} from '../../settings/service.ts'
import { publicProcedure, router } from '../base.ts'

const effort = z.enum(EFFORT_LEVELS)

export const settingsRouter = router({
  /** Global model/effort defaults plus the live `ModelInfo[]` catalog. */
  defaults: publicProcedure.query(() => getGlobalDefaults()),

  setDefaults: publicProcedure
    .input(z.object({ model: z.string().min(1).nullable(), effort: effort.nullable() }))
    .mutation(({ input }) => setGlobalDefaults(input)),

  projectDefaults: publicProcedure.query(() => listProjectDefaults()),

  setProjectDefaults: publicProcedure
    .input(
      z.object({
        projectId: z.string().uuid(),
        model: z.string().min(1).nullable(),
        effort: effort.nullable(),
      }),
    )
    .mutation(({ input }) => setProjectDefaults(input)),

  /** Resolved global -> project pair, for the launch dialog's "Default" label. */
  effective: publicProcedure
    .input(
      z.object({
        projectId: z.string().uuid().nullish(),
        instanceId: z.string().min(1).optional(),
        gitlabProjectId: z.number().int().positive().optional(),
      }),
    )
    .query(({ input }) =>
      describeEffectiveSelection(
        input.projectId ?? findProjectIdByCoordinates(input.instanceId, input.gitlabProjectId),
      ),
    ),
})
