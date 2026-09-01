/**
 * Shared IPC transport types. Type-only module — importable from main, preload,
 * and renderer with zero runtime cost.
 *
 * Envelopes deliberately mirror tRPC's own wire format (TRPCSuccessResponse /
 * TRPCErrorResponse / subscription result messages) so the renderer link can
 * feed the tRPC client unmodified.
 */

export interface IpcTrpcRequest {
  id: number
  type: 'query' | 'mutation' | 'subscription'
  path: string
  input?: unknown
  /** Required for subscriptions: the webContents channel events stream back on. */
  replyChannel?: string
}

export interface IpcTrpcErrorShape {
  message: string
  /** Numeric JSON-RPC-style code (TRPC_ERROR_CODES_BY_KEY). */
  code: number
  data: {
    code: string
    httpStatus: number
    path: string
  }
}

export type IpcTrpcResponse =
  | { id: number; result: { type: 'data'; data: unknown } }
  | { id: number; error: IpcTrpcErrorShape }

export type IpcTrpcSubscriptionEvent =
  | { result: { type: 'started' } }
  | { result: { type: 'data'; data: unknown } }
  | { result: { type: 'stopped' } }
  | { error: IpcTrpcErrorShape }

export interface RivjuIpc {
  invoke: (req: IpcTrpcRequest) => Promise<IpcTrpcResponse>
  /** Returns an unsubscribe function. */
  subscribe: (req: IpcTrpcRequest, onEvent: (event: IpcTrpcSubscriptionEvent) => void) => () => void
}

declare global {
  interface Window {
    rivju: RivjuIpc
  }
}
