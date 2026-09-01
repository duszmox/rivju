import { contextBridge, ipcRenderer } from 'electron'
import type { IpcTrpcRequest, IpcTrpcSubscriptionEvent, RivjuIpc } from './protocol.ts'

/**
 * The ONLY surface the renderer can reach. Exposes the tRPC IPC transport —
 * nothing else. Feature code goes through tRPC procedures, never raw channels.
 */
const rivju: RivjuIpc = {
  invoke: (req: IpcTrpcRequest) => ipcRenderer.invoke('rivju:trpc:invoke', req),
  subscribe: (req: IpcTrpcRequest, onEvent: (event: IpcTrpcSubscriptionEvent) => void) => {
    const replyChannel = req.replyChannel ?? `rivju:trpc:sub:${String(req.id)}:${crypto.randomUUID()}`
    const listener = (_event: Electron.IpcRendererEvent, envelope: IpcTrpcSubscriptionEvent): void => {
      onEvent(envelope)
    }
    ipcRenderer.on(replyChannel, listener)
    ipcRenderer.send('rivju:trpc:subscribe', { ...req, replyChannel })
    return () => {
      ipcRenderer.removeListener(replyChannel, listener)
      ipcRenderer.send('rivju:trpc:unsubscribe', { replyChannel })
    }
  },
}

contextBridge.exposeInMainWorld('rivju', rivju)
