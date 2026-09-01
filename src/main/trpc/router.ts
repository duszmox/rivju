import { z } from 'zod'
import { getPreflightState, runPreflight } from '../claude/preflight.ts'
import { runEventStream } from '../events/bus.ts'
import { cancelReview, listRuns, startReview, startVerifyRun } from '../review/runner.ts'
import { cancelFakeRun, startFakeRun } from '../runs/fake.ts'
import { createCallerFactory, publicProcedure, router } from './base.ts'
import { instancesRouter } from './routers/instances.ts'
import { mergeRequestsRouter } from './routers/mergeRequests.ts'
import { projectsRouter } from './routers/projects.ts'
import { reposRouter } from './routers/repos.ts'
import { reviewsRouter } from './routers/reviews.ts'
import { settingsRouter } from './routers/settings.ts'
import { skillsRouter } from './routers/skills.ts'

export const appRouter = router({
  system: {
    ping: publicProcedure.query(() => ({ pong: true as const, at: Date.now() })),
    preflight: publicProcedure.query(() => getPreflightState()),
    preflightRetry: publicProcedure.mutation(() => runPreflight()),
  },
  runs: {
    watch: publicProcedure.subscription(async function* (opts) {
      const stream = runEventStream()
      const onAbort = (): void => stream.close()
      opts.signal?.addEventListener('abort', onAbort, { once: true })
      try {
        for await (const event of stream) yield event
      } finally {
        opts.signal?.removeEventListener('abort', onAbort)
        stream.close()
      }
    }),
    fakeStart: publicProcedure.mutation(() => startFakeRun()),
    fakeCancel: publicProcedure
      .input(z.object({ runId: z.string().min(1) }))
      .mutation(({ input }) => cancelFakeRun(input.runId)),
    list: publicProcedure.query(() => listRuns()),
    start: publicProcedure
      .input(z.object({
        instanceId: z.string().min(1),
        gitlabProjectId: z.number().int().positive(),
        iid: z.number().int().positive(),
        baseSha: z.string().regex(/^[0-9a-f]{40,64}$/i),
        headSha: z.string().regex(/^[0-9a-f]{40,64}$/i),
        labels: z.array(z.string()).max(100).default([]),
        selectedPaths: z.array(z.string().min(1)).min(1).max(150).optional(),
        model: z.string().min(1).optional(),
        effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).optional(),
      }))
      .mutation(({ input }) => startReview(input)),
    cancel: publicProcedure
      .input(z.object({ runId: z.string().min(1) }))
      .mutation(({ input }) => ({ cancelled: cancelReview(input.runId) })),
    /**
     * "Check if fixed": queue a `verify` run against the merge request's
     * current head. The reviewed head is the latest completed run; the new
     * head is resolved live from GitLab in the main process.
     */
    verify: publicProcedure
      .input(z.object({
        instanceId: z.string().min(1),
        gitlabProjectId: z.number().int().positive(),
        iid: z.number().int().positive(),
      }))
      .mutation(({ input }) => startVerifyRun(input)),
  },
  instances: instancesRouter,
  projects: projectsRouter,
  mergeRequests: mergeRequestsRouter,
  repos: reposRouter,
  reviews: reviewsRouter,
  skills: skillsRouter,
  settings: settingsRouter,
})

export type AppRouter = typeof appRouter

export const createCaller = createCallerFactory(appRouter)
