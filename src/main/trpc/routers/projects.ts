import { z } from 'zod'
import {
  browseProjectMergeRequests,
  listPickedProjects,
  pickProject,
  searchProjects,
  unpickProject,
} from '../../gitlab/service.ts'
import { listRecentlyReviewedProjects } from '../../review/runner.ts'
import { publicProcedure, router } from '../base.ts'

export const projectsRouter = router({
  /** Persisted projects (the ones the user picked) for one instance. */
  list: publicProcedure
    .input(z.object({ instanceId: z.string().min(1) }))
    .query(({ input }) => listPickedProjects(input.instanceId)),

  /**
   * Live search: `GET /projects?membership=true&simple=true` (+ `search`),
   * starred-first, then by last activity.
   */
  search: publicProcedure
    .input(
      z.object({
        instanceId: z.string().min(1),
        search: z.string().max(200).optional(),
      }),
    )
    .query(({ input }) => searchProjects(input.instanceId, input.search)),

  /** Persist a project row when the user picks one. */
  pick: publicProcedure
    .input(
      z.object({
        instanceId: z.string().min(1),
        gitlabProjectId: z.number().int().positive(),
        pathWithNamespace: z.string().min(1),
        name: z.string().min(1),
        defaultBranch: z.string().min(1).nullable(),
      }),
    )
    .mutation(({ input }) => pickProject(input)),

  unpick: publicProcedure
    .input(z.object({ instanceId: z.string().min(1), projectId: z.string().min(1) }))
    .mutation(({ input }) => unpickProject(input.instanceId, input.projectId)),

  /** Picked projects with at least one run, most recently reviewed first. */
  recentlyReviewed: publicProcedure
    .input(z.object({ limit: z.number().int().positive().max(50).optional() }).optional())
    .query(({ input }) => listRecentlyReviewedProjects(input?.limit)),

  /** Secondary browse view: open MRs for one project. */
  mergeRequests: publicProcedure
    .input(
      z.object({
        instanceId: z.string().min(1),
        gitlabProjectId: z.number().int().positive(),
      }),
    )
    .query(({ input }) =>
      browseProjectMergeRequests(input.instanceId, input.gitlabProjectId),
    ),
})
