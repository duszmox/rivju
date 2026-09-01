import { z } from 'zod'
import { getPreflightState, runPreflight } from '../claude/preflight.ts'
import { runEventStream } from '../events/bus.ts'
import { cancelFakeRun, startFakeRun } from '../runs/fake.ts'
import { createCallerFactory, publicProcedure, router } from './base.ts'
import { instancesRouter } from './routers/instances.ts'
import { mergeRequestsRouter } from './routers/mergeRequests.ts'
import { projectsRouter } from './routers/projects.ts'
import { reposRouter } from './routers/repos.ts'

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
  },
  instances: instancesRouter,
  projects: projectsRouter,
  mergeRequests: mergeRequestsRouter,
  repos: reposRouter,
})

export type AppRouter = typeof appRouter

export const createCaller = createCallerFactory(appRouter)
