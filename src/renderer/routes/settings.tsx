import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { TriangleAlert } from 'lucide-react'
import { Button } from '#/components/ui/button.tsx'
import { Label } from '#/components/ui/label.tsx'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '#/components/ui/select.tsx'
import { useTrpc } from '#/lib/trpc.tsx'
import type { RouterOutput } from '#/lib/trpc.tsx'

export const Route = createFileRoute('/settings')({ component: Settings })

const INHERIT = '__inherit__'
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const
type Effort = (typeof EFFORTS)[number]
type ModelInfo = RouterOutput['settings']['defaults']['models'][number]
type UiTheme = NonNullable<RouterOutput['settings']['uiTheme']>

const THEME_OPTIONS: Array<{ value: UiTheme; label: string }> = [
  { value: 'system', label: 'System' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
]

/**
 * The layered defaults from 00-architecture.md: global -> per-project -> the
 * per-run override in the launch dialog. The model list is whatever the live
 * preflight reported — never a hardcoded catalog — and effort options are
 * gated by each model's own `supportedEffortLevels`.
 */
function Settings() {
  const trpc = useTrpc()
  const queryClient = useQueryClient()
  const defaults = useQuery(trpc.settings.defaults.queryOptions())
  const projects = useQuery(trpc.settings.projectDefaults.queryOptions())
  const setDefaults = useMutation(trpc.settings.setDefaults.mutationOptions())
  const setProject = useMutation(trpc.settings.setProjectDefaults.mutationOptions())
  const theme = useQuery(trpc.settings.uiTheme.queryOptions())
  const setTheme = useMutation(trpc.settings.setUiTheme.mutationOptions())

  const refresh = (): void => {
    void queryClient.invalidateQueries({ queryKey: trpc.settings.defaults.pathKey() })
    void queryClient.invalidateQueries({ queryKey: trpc.settings.projectDefaults.pathKey() })
    void queryClient.invalidateQueries({ queryKey: trpc.settings.effective.pathKey() })
    void queryClient.invalidateQueries({ queryKey: trpc.skills.runContext.pathKey() })
  }

  const models = defaults.data?.models ?? []
  const globalModel = defaults.data?.model ?? null
  const globalTarget = findModel(models, globalModel ?? defaults.data?.catalogDefault ?? null)
  const error = setDefaults.error ?? setProject.error

  return (
    <div className="mx-auto max-w-3xl px-8 py-10">
      <p className="island-kicker">Preferences</p>
      <h1 className="display-title mt-1 text-3xl font-bold text-[var(--sea-ink)]">Settings</h1>
      <p className="mt-1 text-sm text-[var(--sea-ink-soft)]">
        Model and effort resolve in layers: the global default, then a per-project override, then
        whatever you pick in the launch dialog for one run. The resolved pair is stored on every run
        so a review always records what produced it.
      </p>

      {defaults.data && !defaults.data.preflightOk ? (
        <div className="mt-6 flex items-start gap-3 rounded-xl border border-destructive/40 bg-destructive/5 p-4 text-sm">
          <TriangleAlert className="mt-0.5 size-4 text-destructive" />
          <p className="text-destructive">
            The Claude preflight has not succeeded, so there is no model catalog to choose from.
          </p>
        </div>
      ) : null}

      {error ? (
        <p className="mt-4 text-sm text-destructive">
          {error instanceof Error ? error.message : 'Could not save'}
        </p>
      ) : null}

      <section className="island-shell mt-6 rounded-2xl p-6">
        <h2 className="font-semibold text-[var(--sea-ink)]">Appearance</h2>
        <p className="mt-1 text-sm text-[var(--sea-ink-soft)]">
          Follow the operating system or pin a fixed theme.
        </p>
        <div className="mt-4 inline-flex rounded-lg border border-[var(--line)] p-1">
          {THEME_OPTIONS.map((option) => {
            const active = (theme.data ?? 'system') === option.value
            return (
              <Button
                key={option.value}
                size="sm"
                variant={active ? 'default' : 'ghost'}
                disabled={setTheme.isPending}
                onClick={() =>
                  setTheme.mutate(
                    { theme: option.value },
                    {
                      onSuccess: () =>
                        void queryClient.invalidateQueries({
                          queryKey: trpc.settings.uiTheme.pathKey(),
                        }),
                    },
                  )
                }
              >
                {option.label}
              </Button>
            )
          })}
        </div>
      </section>

      <section className="island-shell mt-8 rounded-2xl p-6">
        <h2 className="font-semibold text-[var(--sea-ink)]">Global default</h2>
        <p className="mt-1 text-sm text-[var(--sea-ink-soft)]">
          Used by every project that has no override of its own.
        </p>
        <div className="mt-4 flex flex-wrap items-end gap-4">
          <div className="space-y-1.5">
            <Label htmlFor="global-model">Model</Label>
            <Select
              value={globalModel ?? INHERIT}
              onValueChange={(value) =>
                setDefaults.mutate(
                  { model: value === INHERIT ? null : value, effort: null },
                  { onSuccess: refresh },
                )
              }
            >
              <SelectTrigger id="global-model" size="sm" className="min-w-64">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={INHERIT}>
                  First model the CLI reports
                  {defaults.data?.catalogDefault
                    ? ` · ${findModel(models, defaults.data.catalogDefault)?.displayName ?? defaults.data.catalogDefault}`
                    : ''}
                </SelectItem>
                {models.map((model) => (
                  <SelectItem key={model.value} value={model.value}>
                    {model.displayName}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <EffortSelect
            id="global-effort"
            model={globalTarget}
            value={defaults.data?.effort ?? null}
            onChange={(effort) =>
              setDefaults.mutate({ model: globalModel, effort }, { onSuccess: refresh })
            }
          />
        </div>
      </section>

      <section className="mt-8">
        <h2 className="font-semibold text-[var(--sea-ink)]">Per-project overrides</h2>
        <p className="mt-1 text-sm text-[var(--sea-ink-soft)]">
          A project that needs a stronger (or cheaper) reviewer than the rest.
        </p>
        {projects.data?.length === 0 ? (
          <p className="mt-4 rounded-xl border border-dashed border-[var(--line)] p-6 text-center text-sm text-[var(--sea-ink-soft)]">
            No projects picked yet.
          </p>
        ) : null}
        <div className="mt-4 space-y-3">
          {projects.data?.map((row) => {
            const target = findModel(models, row.modelOverride ?? globalModel ?? defaults.data?.catalogDefault ?? null)
            return (
              <div key={row.projectId} className="island-shell rounded-xl p-4">
                <p className="font-medium text-[var(--sea-ink)]">{row.pathWithNamespace}</p>
                <p className="text-xs text-[var(--sea-ink-soft)]">
                  {row.instanceLabel} · resolves to{' '}
                  {row.effective.error
                    ? row.effective.error
                    : `${row.effective.modelDisplayName ?? '—'} (${row.effective.modelSource})${
                        row.effective.effort ? ` · effort ${row.effective.effort} (${row.effective.effortSource})` : ''
                      }`}
                </p>
                <div className="mt-3 flex flex-wrap items-end gap-4">
                  <div className="space-y-1.5">
                    <Label htmlFor={`model-${row.projectId}`}>Model</Label>
                    <Select
                      value={row.modelOverride ?? INHERIT}
                      onValueChange={(value) =>
                        setProject.mutate(
                          {
                            projectId: row.projectId,
                            model: value === INHERIT ? null : value,
                            effort: null,
                          },
                          { onSuccess: refresh },
                        )
                      }
                    >
                      <SelectTrigger id={`model-${row.projectId}`} size="sm" className="min-w-56">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value={INHERIT}>Use the global default</SelectItem>
                        {models.map((model) => (
                          <SelectItem key={model.value} value={model.value}>
                            {model.displayName}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <EffortSelect
                    id={`effort-${row.projectId}`}
                    model={target}
                    value={row.effortOverride}
                    inheritLabel="Use the global default"
                    onChange={(effort) =>
                      setProject.mutate(
                        { projectId: row.projectId, model: row.modelOverride, effort },
                        { onSuccess: refresh },
                      )
                    }
                  />
                </div>
              </div>
            )
          })}
        </div>
      </section>
    </div>
  )
}

function EffortSelect({
  id,
  model,
  value,
  inheritLabel = 'No effort parameter',
  onChange,
}: {
  id: string
  model: ModelInfo | undefined
  value: Effort | null
  inheritLabel?: string
  onChange: (effort: Effort | null) => void
}) {
  // Gated by the model's own `supportedEffortLevels`, narrowed to the levels
  // rivju is able to send.
  const levels = model?.supportsEffort
    ? (model.supportedEffortLevels ?? []).filter((level): level is Effort =>
        (EFFORTS as readonly string[]).includes(level),
      )
    : []
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>Effort</Label>
      <Select
        value={value ?? INHERIT}
        disabled={levels.length === 0}
        onValueChange={(next) => onChange(next === INHERIT ? null : (next as Effort))}
      >
        <SelectTrigger id={id} size="sm" className="min-w-44">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={INHERIT}>{inheritLabel}</SelectItem>
          {levels.map((level) => (
            <SelectItem key={level} value={level}>
              {level}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {levels.length === 0 ? (
        <p className="text-[11px] text-[var(--sea-ink-soft)]">
          {model ? `${model.displayName} takes no effort setting.` : 'Pick a model first.'}
        </p>
      ) : null}
    </div>
  )
}

function findModel(models: ModelInfo[], value: string | null): ModelInfo | undefined {
  if (!value) return undefined
  return models.find((model) => model.value === value || model.resolvedModel === value)
}
