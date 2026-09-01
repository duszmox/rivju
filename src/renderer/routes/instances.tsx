import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute, Link } from '@tanstack/react-router'
import { FolderOpen, KeyRound, LoaderCircle, LockKeyhole, Plus, RefreshCw, Trash2, TriangleAlert } from 'lucide-react'
import { useState } from 'react'
import { Button } from '#/components/ui/button.tsx'
import { Input } from '#/components/ui/input.tsx'
import { Label } from '#/components/ui/label.tsx'
import { useTrpc } from '#/lib/trpc.tsx'

export const Route = createFileRoute('/instances')({ component: Instances })

function Instances() {
  const trpc = useTrpc()
  const queryClient = useQueryClient()
  const instances = useQuery(trpc.instances.list.queryOptions())
  const encryption = useQuery(trpc.instances.encryptionAvailable.queryOptions())

  const add = useMutation(trpc.instances.add.mutationOptions())
  const validate = useMutation(trpc.instances.validate.mutationOptions())
  const reAuth = useMutation(trpc.instances.reAuth.mutationOptions())
  const remove = useMutation(trpc.instances.delete.mutationOptions())

  const [label, setLabel] = useState('')
  const [baseUrl, setBaseUrl] = useState('')
  const [token, setToken] = useState('')

  const invalidate = (): void => {
    void queryClient.invalidateQueries()
  }

  const submitAdd = (): void => {
    add.mutate(
      { label, baseUrl, token },
      {
        onSuccess: () => {
          setLabel('')
          setBaseUrl('')
          setToken('')
          invalidate()
        },
      },
    )
  }

  return (
    <div className="mx-auto max-w-3xl px-8 py-10">
      <p className="island-kicker">GitLab</p>
      <h1 className="display-title mt-1 text-3xl font-bold text-[var(--sea-ink)]">Instances</h1>
      <p className="mt-1 text-sm text-[var(--sea-ink-soft)]">
        Connect one or more self-hosted GitLab instances. Tokens are encrypted
        with your OS keychain and never leave this machine in plaintext.
      </p>

      {!encryption.isPending && encryption.data === false ? (
        <div className="mt-6 flex items-start gap-3 rounded-xl border border-destructive/40 bg-destructive/5 p-4 text-sm">
          <TriangleAlert className="mt-0.5 size-4 text-destructive" />
          <p className="text-destructive">
            Secure token storage is unavailable on this system. rivju refuses to
            store tokens in plaintext — adding an instance will fail.
          </p>
        </div>
      ) : null}

      <form
        className="island-shell mt-6 space-y-4 rounded-2xl p-6"
        onSubmit={(e) => {
          e.preventDefault()
          submitAdd()
        }}
      >
        <p className="flex items-center gap-2 text-sm font-semibold text-[var(--sea-ink)]">
          <Plus className="size-4 text-[var(--palm)]" /> Add instance
        </p>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="label">Label</Label>
            <Input
              id="label"
              placeholder="Work GitLab"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              required
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="baseUrl">Base URL</Label>
            <Input
              id="baseUrl"
              placeholder="https://gitlab.example.com"
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              required
            />
          </div>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="token">Personal access token (api scope)</Label>
          <Input
            id="token"
            type="password"
            placeholder="glpat-…"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            autoComplete="off"
            required
          />
        </div>
        {add.isError ? (
          <p className="text-sm text-destructive">
            {add.error instanceof Error ? add.error.message : 'Failed to add instance'}
          </p>
        ) : null}
        <Button type="submit" disabled={add.isPending || !label || !baseUrl || !token}>
          {add.isPending ? (
            <LoaderCircle className="size-4 animate-spin" />
          ) : (
            <KeyRound className="size-4" />
          )}
          Validate &amp; add
        </Button>
      </form>

      <div className="mt-8 space-y-3">
        {instances.isPending ? (
          <p className="text-sm text-[var(--sea-ink-soft)]">Loading instances…</p>
        ) : null}
        {instances.data?.length === 0 ? (
          <p className="text-sm text-[var(--sea-ink-soft)]">No instances yet.</p>
        ) : null}
        {instances.data?.map((instance) => (
          <div
            key={instance.id}
            className="island-shell rounded-xl p-4"
          >
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0">
                <p className="flex items-center gap-2 font-semibold text-[var(--sea-ink)]">
                  <LockKeyhole className="size-4 text-[var(--palm)]" />
                  {instance.label}
                  {instance.versionWarning ? (
                    <span
                      className="rounded bg-destructive/10 px-1.5 py-0.5 text-[10px] font-semibold text-destructive"
                      title="GitLab major version below 15 — some API features may be missing"
                    >
                      old GitLab
                    </span>
                  ) : null}
                </p>
                <p className="mt-0.5 truncate text-xs text-[var(--sea-ink-soft)]">
                  {instance.baseUrl}
                  {instance.username ? ` · ${instance.username}` : ''}
                  {instance.gitlabVersion ? ` · GitLab ${instance.gitlabVersion}` : ''}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-1">
                <Button
                  variant="ghost"
                  size="sm"
                  title="Re-validate against /user and /version"
                  onClick={() => validate.mutate({ instanceId: instance.id }, { onSuccess: invalidate })}
                  disabled={validate.isPending}
                >
                  <RefreshCw className="size-3.5" />
                  Validate
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  title="Re-enter the personal access token"
                  onClick={() => {
                    const newToken = window.prompt(
                      `New personal access token for ${instance.label}`,
                    )
                    if (newToken) {
                      reAuth.mutate(
                        { instanceId: instance.id, token: newToken },
                        { onSuccess: invalidate },
                      )
                    }
                  }}
                  disabled={reAuth.isPending}
                >
                  <KeyRound className="size-3.5" />
                  Re-auth
                </Button>
                <Button asChild variant="ghost" size="sm">
                  <Link to="/instances/$instanceId" params={{ instanceId: instance.id }}>
                    <FolderOpen className="size-3.5" />
                    Projects
                  </Link>
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-destructive"
                  title="Delete instance, its projects and MRs (findings are kept)"
                  onClick={() => {
                    if (
                      window.confirm(
                        `Delete ${instance.label}? Projects and merge requests are removed; your findings are kept.`,
                      )
                    ) {
                      remove.mutate({ instanceId: instance.id }, { onSuccess: invalidate })
                    }
                  }}
                  disabled={remove.isPending}
                >
                  <Trash2 className="size-3.5" />
                </Button>
              </div>
            </div>
            {reAuth.isPending && reAuth.variables.instanceId === instance.id ? (
              <p className="mt-2 text-xs text-[var(--sea-ink-soft)]">Validating new token…</p>
            ) : null}
            {validate.isError && validate.variables.instanceId === instance.id ? (
              <p className="mt-2 text-xs text-destructive">
                {validate.error instanceof Error ? validate.error.message : 'Validation failed'}
              </p>
            ) : null}
            {reAuth.isError && reAuth.variables.instanceId === instance.id ? (
              <p className="mt-2 text-xs text-destructive">
                {reAuth.error instanceof Error ? reAuth.error.message : 'Re-auth failed'}
              </p>
            ) : null}
          </div>
        ))}
      </div>
    </div>
  )
}
