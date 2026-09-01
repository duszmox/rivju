import { initTRPC } from '@trpc/server'
import type { TrpcContext } from './context.ts'

/**
 * The tRPC builder lives in its own module so router namespaces can import
 * `router`/`publicProcedure` without importing `appRouter` (and hence each
 * other) — a circular import here would evaluate namespace modules before the
 * builder is initialized (TDZ crash).
 */
const t = initTRPC.context<TrpcContext>().create()

export const router = t.router
export const publicProcedure = t.procedure
export const createCallerFactory = t.createCallerFactory
