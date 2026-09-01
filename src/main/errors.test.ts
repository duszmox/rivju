import { describe, expect, it } from 'vitest'
import { classifyFailure } from './errors.ts'

describe('failure classification', () => {
  const cases: {
    name: string
    raw: string
    title: RegExp
    recovery: RegExp
  }[] = [
    {
      name: 'max turns',
      raw: 'The agent hit the max-turns cap after 40 turns without calling finish_review',
      title: /turn cap/,
      recovery: /review\.max_turns/,
    },
    {
      name: 'wall-clock timeout',
      raw: 'Review exceeded its wall-clock timeout',
      title: /wall-clock/,
      recovery: /review\.timeout_ms/,
    },
    {
      name: 'token revoked (401)',
      raw: 'GitLab API 401 on https://gitlab.example.com/api/v4/user: 401 Unauthorized',
      title: /rejected the access token/,
      recovery: /Re-auth/,
    },
    {
      name: 'gitlab unreachable',
      raw: 'GitLab API 0 on https://gitlab.example.com/api/v4/version: getaddrinfo ENOTFOUND gitlab.internal',
      title: /unreachable/,
      recovery: /VPN|reachable/,
    },
    {
      name: 'TLS failure',
      raw: 'GitLab API 0 on https://gitlab.example.com/api/v4/user: unable to verify the first certificate',
      title: /TLS/,
      recovery: /trust store|base URL/,
    },
    {
      name: 'force-push mid-run',
      raw: 'fatal: invalid reference: cccccccccccccccccccccccccccccccccccccccc',
      title: /head changed/,
      recovery: /force-pushed|new head/,
    },
    {
      name: 'claude binary missing after upgrade',
      raw: 'spawn /Users/me/.local/bin/claude ENOENT',
      title: /missing/,
      recovery: /Restart rivju/,
    },
    {
      name: 'claude logged out',
      raw: 'claude is not logged in. Please run `claude` to log in.',
      title: /not logged in/,
      recovery: /terminal/,
    },
    {
      name: 'worktree conflict',
      raw: "fatal: 'run-1' is already used by worktree at '/path/to/worktrees/run-1'",
      title: /Worktree conflict/,
      recovery: /restart the app|prune/,
    },
    {
      name: 'disk full',
      raw: 'SQLITE_FULL: database or disk is full',
      title: /Disk is full/,
      recovery: /Free disk space/,
    },
    {
      name: 'safeStorage unavailable',
      raw: 'Secure token storage is unavailable on this system (safeStorage reports encryption is not available).',
      title: /Secure token storage/,
      recovery: /gnome-keyring|keychain/,
    },
    {
      name: 'large MR without scope',
      raw: 'This merge request exceeds the review budget. Select a file scope before launching.',
      title: /review budget/,
      recovery: /file picker/,
    },
    {
      name: 'run interrupted at boot',
      raw: 'The run was interrupted: rivju exited while the run was still in progress.',
      title: /interrupted/,
      recovery: /Start a new review/,
    },
    {
      name: 'no finish_review',
      raw: 'Agent ended without calling finish_review',
      title: /stopped before finishing/,
      recovery: /Re-run/,
    },
  ]

  it.each(cases)(
    'maps $name to a specific title and recovery action',
    ({ raw, title, recovery }) => {
      const classified = classifyFailure(raw)
      expect(classified.title).toMatch(title)
      expect(classified.recovery).toMatch(recovery)
      expect(classified.message).toContain(raw.slice(0, 40))
    },
  )

  it('keeps unknown failures specific by echoing the raw message with a log pointer', () => {
    const classified = classifyFailure(
      'Error: EACCES: permission denied, open /etc/something',
    )
    expect(classified.message).toContain('EACCES')
    expect(classified.recovery).toMatch(/JSONL log/)
  })

  it('never returns an empty message', () => {
    expect(classifyFailure(undefined).message).not.toBe('')
  })
})
