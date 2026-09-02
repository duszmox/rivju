import { z } from 'zod'
import {
  EFFORT_LEVELS,
  describeEffectiveSelection,
  findProjectIdByCoordinates,
  getGlobalDefaults,
  getTurnLimits,
  listProjectDefaults,
  setGlobalDefaults,
  setProjectDefaults,
  setTurnLimits,
  MAX_MAX_TURNS,
  MIN_MAX_TURNS,
} from '../../settings/service.ts'
import { getUiTheme, setUiTheme } from '../../ui-theme.ts'
import {
  getTicketNavigationRules,
  setTicketNavigationRules,
  ticketNavigationRulesSchema,
} from '../../tickets/navigation.ts'
import { publicProcedure, router } from '../base.ts'

const effort = z.enum(EFFORT_LEVELS)
const theme = z.enum(['system', 'light', 'dark'])

export const settingsRouter = router({
  /** Global model/effort defaults plus the live `ModelInfo[]` catalog. */
  defaults: publicProcedure.query(() => getGlobalDefaults()),

  setDefaults: publicProcedure
    .input(
      z.object({
        model: z.string().min(1).nullable(),
        effort: effort.nullable(),
      }),
    )
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

  turnLimits: publicProcedure.query(() => getTurnLimits()),

  setTurnLimits: publicProcedure
    .input(
      z.object({
        reviewMaxTurns: z.number().int().min(MIN_MAX_TURNS).max(MAX_MAX_TURNS),
        verifyMaxTurns: z.number().int().min(MIN_MAX_TURNS).max(MAX_MAX_TURNS),
      }),
    )
    .mutation(({ input }) => setTurnLimits(input)),

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
        input.projectId ??
          findProjectIdByCoordinates(input.instanceId, input.gitlabProjectId),
      ),
    ),

  uiTheme: publicProcedure.query(() => getUiTheme()),

  setUiTheme: publicProcedure
    .input(z.object({ theme }))
    .mutation(({ input }) => setUiTheme(input.theme)),

  ticketNavigation: publicProcedure.query(() => getTicketNavigationRules()),

  setTicketNavigation: publicProcedure
    .input(ticketNavigationRulesSchema)
    .mutation(({ input }) => setTicketNavigationRules(input)),
})
