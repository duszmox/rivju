import { useMutation, useQuery } from '@tanstack/react-query'
import { CircleAlert, LoaderCircle, RotateCcw } from 'lucide-react'
import { useState  } from 'react'
import type {ReactNode} from 'react';
import { RivjuLogo } from '#/components/brand/logo.tsx'
import { Button } from '#/components/ui/button.tsx'
import { useQueryClientInstance, useTrpc, useTrpcClient } from '#/lib/trpc.tsx'

/**
 * Blocking gate: until the main-process preflight says the claude CLI exists
 * and is authenticated, nothing else of the app renders — just remediation.
 */
export function PreflightGate({ children }: { children: ReactNode }) {
  const trpc = useTrpc()
  const client = useTrpcClient()
  const queryClient = useQueryClientInstance()
  const [retrying, setRetrying] = useState(false)

  const preflightKey = trpc.system.preflight.queryOptions().queryKey
  const preflight = useQuery({
    ...trpc.system.preflight.queryOptions(),
    refetchInterval: (query) => (query.state.data?.status === 'pending' ? 1_200 : false),
  })

  const retry = useMutation({
    mutationFn: () => client.system.preflightRetry.mutate(),
    onMutate: () => setRetrying(true),
    onSettled: () => {
      setRetrying(false)
      void queryClient.invalidateQueries({ queryKey: preflightKey })
    },
  })

  // A failed preflight query is NOT a claude problem — it means the tRPC/IPC
  // transport itself is broken. Surfacing it distinctly matters: while this
  // branch was missing, an IPC fault rendered as "Checking the claude CLI…"
  // forever and sent debugging in entirely the wrong direction.
  if (preflight.isError) {
    return (
      <div className="flex h-screen w-screen items-center justify-center bg-background p-6">
        <div className="w-full max-w-xl rounded-2xl border border-[var(--line)] bg-[var(--surface-strong)] p-8 shadow-sm">
          <div className="flex items-center gap-3">
            <CircleAlert className="size-6 text-destructive" />
            <h1 className="text-xl font-bold text-[var(--sea-ink)]">
              rivju can't reach its own backend
            </h1>
          </div>
          <p className="mt-4 text-sm font-medium text-[var(--sea-ink)]">
            The renderer could not call the main process. This is an internal transport fault, not
            a problem with your Claude installation.
          </p>
          <pre className="mt-3 overflow-auto rounded-lg bg-[var(--foam)] p-3 text-xs text-[var(--sea-ink-soft)]">
            {preflight.error.message}
          </pre>
          <div className="mt-6">
            <Button onClick={() => void preflight.refetch()}>
              <RotateCcw className="size-4" />
              Retry
            </Button>
          </div>
        </div>
      </div>
    )
  }

  if (preflight.isPending || preflight.data.status === 'pending') {
    return (
      <div className="flex h-screen w-screen flex-col items-center justify-center gap-4 bg-background">
        <RivjuLogo className="size-16 rounded-2xl shadow-md" />
        <p className="text-lg font-bold text-[var(--sea-ink)]">rivju</p>
        <div className="flex items-center gap-2">
          <LoaderCircle className="size-4 animate-spin text-[var(--lagoon-deep)]" />
          <p className="text-sm text-[var(--sea-ink-soft)]">Checking the claude CLI…</p>
        </div>
      </div>
    )
  }

  if (preflight.data.status === 'failed') {
    const { reason, message, hint } = preflight.data
    return (
      <div className="flex h-screen w-screen items-center justify-center bg-background p-6">
        <div className="w-full max-w-xl rounded-2xl border border-[var(--line)] bg-[var(--surface-strong)] p-8 shadow-sm">
          <div className="flex items-center gap-3">
            <CircleAlert className="size-6 text-destructive" />
            <h1 className="text-xl font-bold text-[var(--sea-ink)]">rivju can't start</h1>
          </div>
          <p className="mt-4 text-sm font-medium text-[var(--sea-ink)]">{message}</p>
          <p className="mt-2 rounded-lg bg-[var(--foam)] p-3 text-sm text-[var(--sea-ink-soft)]">
            {hint}
          </p>
          <div className="mt-6 flex items-center gap-3">
            <Button onClick={() => retry.mutate()} disabled={retrying}>
              {retrying ? (
                <LoaderCircle className="size-4 animate-spin" />
              ) : (
                <RotateCcw className="size-4" />
              )}
              {retrying ? 'Checking…' : 'Retry preflight'}
            </Button>
            <span className="text-xs text-[var(--sea-ink-soft)]">
              reason: <code>{reason}</code>
            </span>
          </div>
        </div>
      </div>
    )
  }

  return <>{children}</>
}
