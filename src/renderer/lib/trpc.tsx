import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createTRPCClient, TRPCClientError } from '@trpc/client'
import type { TRPCLink } from '@trpc/client'
import { createTRPCOptionsProxy } from '@trpc/tanstack-react-query'
import { observable } from '@trpc/server/observable'
import { createContext, useContext, useMemo  } from 'react'
import type {ReactNode} from 'react';
import type { AppRouter } from '../../main/trpc/router.ts'

/**
 * Our own tRPC-over-IPC link. Emits exactly the envelopes tRPC's client
 * expects (verified against @trpc/client 11.18 internals):
 *
 * - query/mutation: one `{ result: { type: 'data', data } }` envelope, then
 *   complete. Errors: `observer.error(TRPCClientError.from(mainEnvelope))`,
 *   where main sent `{ error: { message, code: <number>, data } }`.
 * - subscription: forwards main's `{ result: { type: 'started' | 'data' |
 *   'stopped' } }` chunks verbatim; errors same as above.
 */
export function ipcLink(): TRPCLink<AppRouter> {
  return () => {
    return ({ op }) => {
      return observable((observer) => {
        if (op.type === 'subscription') {
          const unsubscribe = window.rivju.subscribe(
            { id: op.id, type: 'subscription', path: op.path, input: op.input },
            (event) => {
              if ('error' in event) {
                observer.error(TRPCClientError.from(event))
                return
              }
              observer.next(event)
            },
          )
          return unsubscribe
        }

        window.rivju
          .invoke({ id: op.id, type: op.type, path: op.path, input: op.input })
          .then((response) => {
            if ('error' in response) {
              observer.error(TRPCClientError.from(response))
              return
            }
            observer.next({ result: response.result })
            observer.complete()
          })
          .catch((cause: unknown) => {
            observer.error(
              TRPCClientError.from(cause instanceof Error ? cause : { message: String(cause) }),
            )
          })

        return () => {}
      })
    }
  }
}

function createClient() {
  return createTRPCClient<AppRouter>({ links: [ipcLink()] })
}

function createProxy(client: ReturnType<typeof createClient>, queryClient: QueryClient) {
  return createTRPCOptionsProxy<AppRouter>({ client, queryClient })
}

type TrpcClient = ReturnType<typeof createClient>
type TrpcProxy = ReturnType<typeof createProxy>

interface TrpcBundle {
  queryClient: QueryClient
  client: TrpcClient
  trpc: TrpcProxy
}

const TrpcContext = createContext<TrpcBundle | null>(null)

export function TrpcProvider({ children }: { children: ReactNode }) {
  const bundle = useMemo<TrpcBundle>(() => {
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: {
          // GitLab data refreshes on focus and at most once a minute; the MR
          // list is always fetched live through these queries (never from the
          // DB cache as a source of truth).
          staleTime: 60_000,
          refetchOnWindowFocus: true,
          retry: 1,
        },
      },
    })
    const client = createClient()
    return { queryClient, client, trpc: createProxy(client, queryClient) }
  }, [])
  return (
    <QueryClientProvider client={bundle.queryClient}>
      <TrpcContext.Provider value={bundle}>{children}</TrpcContext.Provider>
    </QueryClientProvider>
  )
}

function useBundle(): TrpcBundle {
  const bundle = useContext(TrpcContext)
  if (!bundle) throw new Error('tRPC used outside <TrpcProvider>')
  return bundle
}

export function useTrpc(): TrpcProxy {
  return useBundle().trpc
}

export function useTrpcClient(): TrpcClient {
  return useBundle().client
}

export function useQueryClientInstance(): QueryClient {
  return useBundle().queryClient
}
