import { CircleAlert, RotateCcw, Wrench } from 'lucide-react'
import { classifyFailure } from '../../../main/errors.ts'
import { Button } from '#/components/ui/button.tsx'

/**
 * The one error card. Every failure reaches the user through here, so each
 * failure mode shows its specific title, the raw cause, and a concrete
 * recovery action — never a bare "something went wrong" toast.
 */
export function ErrorSurface({
  raw,
  heading,
  onRetry,
  retrying,
  compact,
}: {
  raw: string | null | undefined
  heading?: string
  onRetry?: () => void
  retrying?: boolean
  compact?: boolean
}) {
  const error = classifyFailure(raw)
  return (
    <div
      role="alert"
      className={`rounded-xl border border-destructive/30 bg-destructive/5 ${compact ? 'px-3 py-2 text-xs' : 'px-4 py-3 text-sm'}`}
    >
      <div className="flex items-start gap-2.5">
        <CircleAlert
          className={`${compact ? 'mt-0.5 size-3.5' : 'mt-0.5 size-4'} shrink-0 text-destructive`}
        />
        <div className="min-w-0 flex-1">
          <p
            className={`font-semibold text-destructive ${compact ? 'text-xs' : 'text-sm'}`}
          >
            {heading ? `${heading} — ` : ''}
            {error.title}
          </p>
          <p
            className={`${compact ? 'mt-0.5 line-clamp-2' : 'mt-1'} whitespace-pre-wrap break-words text-(--sea-ink-soft)`}
            title={error.message}
          >
            {error.message}
          </p>
          <p
            className={`${compact ? 'mt-1' : 'mt-2'} flex items-start gap-1.5 text-(--sea-ink)`}
          >
            <Wrench
              className={`mt-0.5 shrink-0 ${compact ? 'size-3' : 'size-3.5'} text-[var(--lagoon-deep)]`}
            />
            <span>{error.recovery}</span>
          </p>
          {onRetry ? (
            <Button
              variant="outline"
              size="sm"
              className="mt-2"
              onClick={onRetry}
              disabled={retrying}
            >
              <RotateCcw
                className={retrying ? 'size-3.5 animate-spin' : 'size-3.5'}
              />
              {retrying ? 'Retrying…' : 'Retry'}
            </Button>
          ) : null}
        </div>
      </div>
    </div>
  )
}
