import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { Plus, Trash2, TriangleAlert } from 'lucide-react'
import { useState } from 'react'
import { Button } from '#/components/ui/button.tsx'
import { Input } from '#/components/ui/input.tsx'
import { Label } from '#/components/ui/label.tsx'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '#/components/ui/select.tsx'
import { INHERIT } from '#/lib/model-select.ts'
import { useTrpc } from '#/lib/trpc.tsx'
import type { RouterOutput } from '#/lib/trpc.tsx'

export const Route = createFileRoute('/settings')({ component: Settings })

const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const
type Effort = (typeof EFFORTS)[number]
type ModelInfo = RouterOutput['settings']['defaults']['models'][number]
type UiTheme = NonNullable<RouterOutput['settings']['uiTheme']>
type TicketRule = RouterOutput['settings']['ticketNavigation'][number]

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
  const setProject = useMutation(
    trpc.settings.setProjectDefaults.mutationOptions(),
  )
  const theme = useQuery(trpc.settings.uiTheme.queryOptions())
  const setTheme = useMutation(trpc.settings.setUiTheme.mutationOptions())
  const turnLimits = useQuery(trpc.settings.turnLimits.queryOptions())
  const setTurnLimits = useMutation(
    trpc.settings.setTurnLimits.mutationOptions(),
  )
  const ticketNavigation = useQuery(
    trpc.settings.ticketNavigation.queryOptions(),
  )
  const setTicketNavigation = useMutation(
    trpc.settings.setTicketNavigation.mutationOptions(),
  )

  const refresh = (): void => {
    void queryClient.invalidateQueries({
      queryKey: trpc.settings.defaults.pathKey(),
    })
    void queryClient.invalidateQueries({
      queryKey: trpc.settings.projectDefaults.pathKey(),
    })
    void queryClient.invalidateQueries({
      queryKey: trpc.settings.effective.pathKey(),
    })
    void queryClient.invalidateQueries({
      queryKey: trpc.skills.runContext.pathKey(),
    })
  }

  const models = defaults.data?.models ?? []
  const globalModel = defaults.data?.model ?? null
  const globalTarget = findModel(
    models,
    globalModel ?? defaults.data?.catalogDefault ?? null,
  )
  const error =
    setDefaults.error ??
    setProject.error ??
    setTurnLimits.error ??
    setTicketNavigation.error

  return (
    <div className="mx-auto max-w-3xl px-8 py-10">
      <p className="island-kicker">Preferences</p>
      <h1 className="display-title mt-1 text-3xl font-bold text-(--sea-ink)">
        Settings
      </h1>
      <p className="mt-1 text-sm text-(--sea-ink-soft)">
        Configure review behavior, appearance, and links from commit messages to
        your ticket tracker.
      </p>

      {defaults.data && !defaults.data.preflightOk ? (
        <div className="mt-6 flex items-start gap-3 rounded-xl border border-destructive/40 bg-destructive/5 p-4 text-sm">
          <TriangleAlert className="mt-0.5 size-4 text-destructive" />
          <p className="text-destructive">
            The Claude preflight has not succeeded, so there is no model catalog
            to choose from.
          </p>
        </div>
      ) : null}

      {error ? (
        <p className="mt-4 text-sm text-destructive">
          {error instanceof Error ? error.message : 'Could not save'}
        </p>
      ) : null}

      <section className="island-shell mt-6 rounded-2xl p-6">
        <h2 className="font-semibold text-(--sea-ink)">Appearance</h2>
        <p className="mt-1 text-sm text-(--sea-ink-soft)">
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
        <h2 className="font-semibold text-(--sea-ink)">Global default</h2>
        <p className="mt-1 text-sm text-(--sea-ink-soft)">
          Used by every project that has no override of its own.
        </p>
        <div className="mt-4 flex flex-wrap items-end gap-4">
          <div className="space-y-1.5">
            <Label htmlFor="global-model">Model</Label>
            <Select
              value={globalTarget?.value ?? ''}
              onValueChange={(value) =>
                setDefaults.mutate(
                  { model: value, effort: null },
                  { onSuccess: refresh },
                )
              }
            >
              <SelectTrigger id="global-model" size="sm" className="min-w-64">
                <SelectValue placeholder="No model catalog" />
              </SelectTrigger>
              <SelectContent>
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
              setDefaults.mutate(
                { model: globalModel, effort },
                { onSuccess: refresh },
              )
            }
          />
        </div>
      </section>

      {turnLimits.data ? (
        <TurnLimitsForm
          key={`${turnLimits.data.reviewMaxTurns}-${turnLimits.data.verifyMaxTurns}`}
          limits={turnLimits.data}
          saving={setTurnLimits.isPending}
          onSave={(values) =>
            setTurnLimits.mutate(values, {
              onSuccess: () =>
                void queryClient.invalidateQueries({
                  queryKey: trpc.settings.turnLimits.pathKey(),
                }),
            })
          }
        />
      ) : null}

      {ticketNavigation.data ? (
        <TicketNavigationForm
          key={JSON.stringify(ticketNavigation.data)}
          rules={ticketNavigation.data}
          saving={setTicketNavigation.isPending}
          onSave={(rules) =>
            setTicketNavigation.mutate(rules, {
              onSuccess: () =>
                void queryClient.invalidateQueries({
                  queryKey: trpc.settings.ticketNavigation.pathKey(),
                }),
            })
          }
        />
      ) : null}

      <section className="mt-8">
        <h2 className="font-semibold text-(--sea-ink)">
          Per-project overrides
        </h2>
        <p className="mt-1 text-sm text-(--sea-ink-soft)">
          A project that needs a stronger (or cheaper) reviewer than the rest.
        </p>
        {projects.data?.length === 0 ? (
          <p className="mt-4 rounded-xl border border-dashed border-[var(--line)] p-6 text-center text-sm text-(--sea-ink-soft)">
            No projects picked yet.
          </p>
        ) : null}
        <div className="mt-4 space-y-3">
          {projects.data?.map((row) => {
            const target = findModel(
              models,
              row.modelOverride ??
                globalModel ??
                defaults.data?.catalogDefault ??
                null,
            )
            return (
              <div key={row.projectId} className="island-shell rounded-xl p-4">
                <p className="font-medium text-(--sea-ink)">
                  {row.pathWithNamespace}
                </p>
                <p className="text-xs text-(--sea-ink-soft)">
                  {row.instanceLabel} · resolves to{' '}
                  {row.effective.error
                    ? row.effective.error
                    : `${row.effective.modelDisplayName ?? '—'} (${row.effective.modelSource})${
                        row.effective.effort
                          ? ` · effort ${row.effective.effort} (${row.effective.effortSource})`
                          : ''
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
                      <SelectTrigger
                        id={`model-${row.projectId}`}
                        size="sm"
                        className="min-w-56"
                      >
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value={INHERIT}>
                          Use the global default
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
                    id={`effort-${row.projectId}`}
                    model={target}
                    value={row.effortOverride}
                    inheritLabel="Use the global default"
                    onChange={(effort) =>
                      setProject.mutate(
                        {
                          projectId: row.projectId,
                          model: row.modelOverride,
                          effort,
                        },
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

function TicketNavigationForm({
  rules: initialRules,
  saving,
  onSave,
}: {
  rules: TicketRule[]
  saving: boolean
  onSave: (rules: TicketRule[]) => void
}) {
  const [rules, setRules] = useState(initialRules)
  const valid = rules.every(
    (rule) =>
      rule.name.trim() &&
      rule.issuePattern.trim() &&
      /^https?:\/\//i.test(rule.linkTemplate.trim()),
  )

  const update = (
    id: string,
    field: 'name' | 'issuePattern' | 'linkTemplate',
    value: string,
  ): void => {
    setRules((current) =>
      current.map((rule) =>
        rule.id === id ? { ...rule, [field]: value } : rule,
      ),
    )
  }

  return (
    <section className="island-shell mt-8 rounded-2xl p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="font-semibold text-(--sea-ink)">Ticket navigation</h2>
          <p className="mt-1 max-w-xl text-sm text-(--sea-ink-soft)">
            Match ticket IDs in merge request commit messages. Use $0 for the
            whole match or $1, $2, and so on for capture groups in the ticket
            URL.
          </p>
        </div>
        <Button
          size="sm"
          variant="outline"
          disabled={rules.length >= 20}
          onClick={() =>
            setRules((current) => [
              ...current,
              {
                id: crypto.randomUUID(),
                name: '',
                issuePattern: '[A-Z]+-\\d+',
                linkTemplate: 'https://tracker.example.com/issue/$0',
              },
            ])
          }
        >
          <Plus /> Add rule
        </Button>
      </div>

      {rules.length === 0 ? (
        <p className="mt-4 rounded-xl border border-dashed border-[var(--line)] p-5 text-center text-sm text-(--sea-ink-soft)">
          No ticket navigation rules configured.
        </p>
      ) : (
        <div className="mt-5 space-y-4">
          {rules.map((rule, index) => (
            <div
              key={rule.id}
              className="grid gap-3 rounded-xl border border-[var(--line)] p-4 sm:grid-cols-[1fr_auto]"
            >
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-1.5 sm:col-span-2">
                  <Label htmlFor={`ticket-rule-name-${rule.id}`}>Name</Label>
                  <Input
                    id={`ticket-rule-name-${rule.id}`}
                    value={rule.name}
                    placeholder="Company Jira"
                    onChange={(event) =>
                      update(rule.id, 'name', event.target.value)
                    }
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor={`ticket-rule-pattern-${rule.id}`}>
                    Issue ID regular expression
                  </Label>
                  <Input
                    id={`ticket-rule-pattern-${rule.id}`}
                    value={rule.issuePattern}
                    className="font-mono"
                    onChange={(event) =>
                      update(rule.id, 'issuePattern', event.target.value)
                    }
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor={`ticket-rule-link-${rule.id}`}>
                    Ticket URL
                  </Label>
                  <Input
                    id={`ticket-rule-link-${rule.id}`}
                    value={rule.linkTemplate}
                    className="font-mono"
                    onChange={(event) =>
                      update(rule.id, 'linkTemplate', event.target.value)
                    }
                  />
                </div>
              </div>
              <Button
                size="icon-sm"
                variant="ghost"
                aria-label={`Remove ticket rule ${index + 1}`}
                onClick={() =>
                  setRules((current) =>
                    current.filter((item) => item.id !== rule.id),
                  )
                }
              >
                <Trash2 />
              </Button>
            </div>
          ))}
        </div>
      )}

      <div className="mt-4 flex items-center gap-3">
        <Button disabled={!valid || saving} onClick={() => onSave(rules)}>
          {saving ? 'Saving…' : 'Save ticket rules'}
        </Button>
        {!valid ? (
          <p className="text-xs text-destructive">
            Every rule needs a name, a pattern, and an http or https URL.
          </p>
        ) : null}
      </div>
    </section>
  )
}

function TurnLimitsForm({
  limits,
  saving,
  onSave,
}: {
  limits: RouterOutput['settings']['turnLimits']
  saving: boolean
  onSave: (values: { reviewMaxTurns: number; verifyMaxTurns: number }) => void
}) {
  const [reviewMaxTurns, setReviewMaxTurns] = useState(
    String(limits.reviewMaxTurns),
  )
  const [verifyMaxTurns, setVerifyMaxTurns] = useState(
    String(limits.verifyMaxTurns),
  )
  const parsedReview = Number(reviewMaxTurns)
  const parsedVerify = Number(verifyMaxTurns)
  const valid = [parsedReview, parsedVerify].every(
    (value) =>
      Number.isInteger(value) && value >= limits.min && value <= limits.max,
  )

  return (
    <section className="island-shell mt-8 rounded-2xl p-6">
      <h2 className="font-semibold text-(--sea-ink)">Turn limits</h2>
      <p className="mt-1 text-sm text-(--sea-ink-soft)">
        Each continuation gets the same allowance. A stopped run keeps its
        findings and can resume from the run screen.
      </p>
      <div className="mt-4 flex flex-wrap items-end gap-4">
        <div className="space-y-1.5">
          <Label htmlFor="review-max-turns">Full review</Label>
          <Input
            id="review-max-turns"
            type="number"
            min={limits.min}
            max={limits.max}
            value={reviewMaxTurns}
            onChange={(event) => setReviewMaxTurns(event.target.value)}
            className="w-32"
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="verify-max-turns">Verification</Label>
          <Input
            id="verify-max-turns"
            type="number"
            min={limits.min}
            max={limits.max}
            value={verifyMaxTurns}
            onChange={(event) => setVerifyMaxTurns(event.target.value)}
            className="w-32"
          />
        </div>
        <Button
          disabled={!valid || saving}
          onClick={() =>
            onSave({
              reviewMaxTurns: parsedReview,
              verifyMaxTurns: parsedVerify,
            })
          }
        >
          {saving ? 'Saving…' : 'Save turn limits'}
        </Button>
      </div>
      {!valid ? (
        <p className="mt-2 text-xs text-destructive">
          Enter whole numbers from {limits.min} to {limits.max}.
        </p>
      ) : null}
    </section>
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
        onValueChange={(next) =>
          onChange(next === INHERIT ? null : (next as Effort))
        }
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
        <p className="text-[11px] text-(--sea-ink-soft)">
          {model
            ? `${model.displayName} takes no effort setting.`
            : 'Pick a model first.'}
        </p>
      ) : null}
    </div>
  )
}

function findModel(
  models: ModelInfo[],
  value: string | null,
): ModelInfo | undefined {
  if (!value) return undefined
  return models.find(
    (model) => model.value === value || model.resolvedModel === value,
  )
}
