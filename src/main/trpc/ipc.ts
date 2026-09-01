import { callTRPCProcedure, getTRPCErrorFromUnknown, TRPCError } from '@trpc/server'
import { getHTTPStatusCodeFromError } from '@trpc/server/http'
import { TRPC_ERROR_CODES_BY_KEY } from '@trpc/server/rpc'
import { ipcMain } from 'electron'
import { appRouter } from './router.ts'
import type { TrpcContext } from './context.ts'
import type {
  IpcTrpcErrorShape,
  IpcTrpcRequest,
  IpcTrpcResponse,
  IpcTrpcSubscriptionEvent,
} from '../../preload/protocol.ts'

/**
 * Wires the tRPC router to IPC. This is the whole transport: no third-party
 * wrappers. Every envelope below mirrors tRPC's own wire format so the renderer
 * link can feed the client unmodified.
 *
 * Procedures are dispatched with `callTRPCProcedure`, which resolves the path
 * against the router's own procedure map and validates that the procedure type
 * matches. Do NOT try to reach procedures by walking a `createCaller` object:
 * that caller is a recursive proxy over a function target, so `typeof` any
 * property is `'function'` and every path "exists" — property-walking it either
 * throws on the first segment or silently resolves nonsense paths.
 */
export function registerTrpcIpc(ctx: TrpcContext): void {
  const dispatch = (req: IpcTrpcRequest, signal?: AbortSignal): Promise<unknown> =>
    callTRPCProcedure({
      router: appRouter,
      path: req.path,
      type: req.type,
      ctx,
      getRawInput: () => Promise.resolve(req.input),
      signal,
      // Required by ProcedureCallOptions. There is no request batching over
      // IPC — each invoke is a single call.
      batchIndex: 0,
    })

  ipcMain.handle(
    'rivju:trpc:invoke',
    async (_event, req: IpcTrpcRequest): Promise<IpcTrpcResponse> => {
      try {
        const data = await dispatch(req)
        return { id: req.id, result: { type: 'data', data } }
      } catch (cause) {
        // Transport-level faults are silent in the renderer (they surface as a
        // generic query error), so always log them here.
        console.error(`[rivju:ipc] ${req.type} ${req.path} failed:`, cause)
        return { id: req.id, error: errorShape(req.path, cause) }
      }
    },
  )

  const active = new Map<string, AbortController>()

  ipcMain.on('rivju:trpc:subscribe', (event, req: IpcTrpcRequest) => {
    const channel = req.replyChannel
    if (!channel) return
    const sender = event.sender

    active.get(channel)?.abort()
    const controller = new AbortController()
    active.set(channel, controller)

    const send = (envelope: IpcTrpcSubscriptionEvent): void => {
      if (!sender.isDestroyed()) sender.send(channel, envelope)
    }

    void (async () => {
      send({ result: { type: 'started' } })
      try {
        const result = await dispatch(req, controller.signal)
        if (!isAsyncIterable(result)) {
          throw new TRPCError({
            code: 'INTERNAL_SERVER_ERROR',
            message: `Procedure "${req.path}" did not return a subscription stream`,
          })
        }
        for await (const chunk of result) {
          if (sender.isDestroyed() || controller.signal.aborted) break
          send({ result: { type: 'data', data: chunk } })
        }
        send({ result: { type: 'stopped' } })
      } catch (cause) {
        if (!controller.signal.aborted) send({ error: errorShape(req.path, cause) })
      } finally {
        if (active.get(channel) === controller) active.delete(channel)
      }
    })()

    sender.once('destroyed', () => {
      controller.abort()
      active.delete(channel)
    })
  })

  ipcMain.on('rivju:trpc:unsubscribe', (_event, req: { replyChannel?: string }) => {
    const channel = req.replyChannel
    if (channel) active.get(channel)?.abort()
  })
}

function errorShape(path: string, cause: unknown): IpcTrpcErrorShape {
  const error = getTRPCErrorFromUnknown(cause)
  return {
    message: error.message,
    code: TRPC_ERROR_CODES_BY_KEY[error.code],
    data: {
      code: error.code,
      httpStatus: getHTTPStatusCodeFromError(error),
      path,
    },
  }
}

function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as AsyncIterable<unknown>)[Symbol.asyncIterator] === 'function'
  )
}
