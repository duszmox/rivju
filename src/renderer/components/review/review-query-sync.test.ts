import { describe, expect, it } from 'vitest'
import { hasNewlySettledRun } from './review-query-sync.ts'

describe('hasNewlySettledRun', () => {
  it.each(['done', 'failed', 'cancelled'])(
    'detects when a persisted active run becomes %s in the event stream',
    (status) => {
      expect(
        hasNewlySettledRun(
          [{ id: 'run-1', status: 'running' }],
          [{ runId: 'run-1', status }],
        ),
      ).toBe(true)
    },
  )

  it('ignores terminal events for other runs', () => {
    expect(
      hasNewlySettledRun(
        [{ id: 'run-1', status: 'running' }],
        [{ runId: 'run-2', status: 'done' }],
      ),
    ).toBe(false)
  })

  it('stops requesting a refresh after persisted data catches up', () => {
    expect(
      hasNewlySettledRun(
        [{ id: 'run-1', status: 'done' }],
        [{ runId: 'run-1', status: 'done' }],
      ),
    ).toBe(false)
  })
})
