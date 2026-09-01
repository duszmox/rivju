/**
 * Error surfaces. Every failure mode that will actually occur gets a specific
 * title, a message that names the cause, and a recovery action — no generic
 * toasts. Pure string mapping so both the main process (run failures) and the
 * renderer (query errors, run rows) classify identically.
 */

export interface ClassifiedError {
  title: string
  message: string
  recovery: string
}

export function classifyFailure(raw: unknown): ClassifiedError {
  const message = raw instanceof Error ? raw.message : String(raw ?? '')

  if (/run was interrupted|rivju exited while the run/i.test(message)) {
    return {
      title: 'The run was interrupted',
      message,
      recovery:
        'rivju exited before this run finished — nothing was resumed in the background. Start a new review; findings already submitted were kept.',
    }
  }
  if (/max-turns cap|maximum number of turns|error_max_turns/i.test(message)) {
    return {
      title: 'The agent hit its turn cap',
      message,
      recovery:
        'Raise review.max_turns in Settings, narrow the file scope, or pick a smaller diff, then re-run. Findings already submitted were kept.',
    }
  }
  if (/exceeded its wall-clock timeout/i.test(message)) {
    return {
      title: 'The run hit the wall-clock timeout',
      message,
      recovery:
        'Raise review.timeout_ms (or verify.timeout_ms) in Settings, narrow the file scope, then re-run. Findings already submitted were kept.',
    }
  }
  if (/stopped at the cost budget|error_max_budget_usd/i.test(message)) {
    return {
      title: 'The run stopped at its cost budget',
      message,
      recovery:
        'Re-run the review, or narrow the file scope so fewer turns are needed.',
    }
  }
  if (
    /\b401\b|\b403\b|token rejected|expired.*token|token.*expired|insufficient_scope/i.test(
      message,
    )
  ) {
    return {
      title: 'GitLab rejected the access token',
      message,
      recovery:
        'The PAT likely expired or was revoked. Open GitLab instances → Re-auth and paste a fresh token with api scope.',
    }
  }
  if (/certificate|TLS|SSL|self-signed|CERT_/i.test(message)) {
    return {
      title: 'GitLab TLS certificate verification failed',
      message,
      recovery:
        'If your instance uses a private CA, export its root certificate into your system trust store (macOS Keychain), then retry. Also check the base URL for typos.',
    }
  }
  if (
    /fetch failed|ENOTFOUND|ECONNREFUSED|EAI_AGAIN|ETIMEDOUT|ECONNRESET|network|unreachable|getaddrinfo/i.test(
      message,
    )
  ) {
    return {
      title: 'GitLab is unreachable',
      message,
      recovery:
        'Check that the instance URL is reachable — VPN, firewall or DNS may be down. Retry from the GitLab instances screen once connectivity is back.',
    }
  }
  if (
    /invalid reference|bad object|unknown revision|not our ref|not in the working tree|object not found|could not (?:read|parse) object/i.test(
      message,
    )
  ) {
    return {
      title: 'The merge request head changed under this run',
      message,
      recovery:
        'The branch was probably force-pushed or the MR was updated mid-run. Re-open the merge request to capture the new head, then start the review again. Existing findings are kept.',
    }
  }
  if (
    /spawn .*ENOENT|ENOENT.*claude|claude.*(?:not found|no longer exists)|pathToClaudeCodeExecutable/i.test(
      message,
    )
  ) {
    return {
      title: 'The claude CLI is missing',
      message,
      recovery:
        'The binary moved or was removed (an upgrade may have replaced it). Restart rivju — it re-runs preflight and picks the binary up again.',
    }
  }
  if (
    /not logged in|authentication_failed|unauthenticated|please run .claude|oauth|api key|credit balance|logged out|login required/i.test(
      message,
    )
  ) {
    return {
      title: 'Claude is not logged in',
      message,
      recovery:
        'rivju inherits your terminal login. Run `claude` in a terminal and complete the login, then retry here.',
    }
  }
  if (
    /worktree|already (?:exists|registered|checked out)|file exists/i.test(
      message,
    )
  ) {
    return {
      title: 'Worktree conflict',
      message,
      recovery:
        'A stale checkout from an earlier run is in the way. rivju prunes expired worktrees at next launch — restart the app, or delete the run’s worktree directory, then re-run.',
    }
  }
  if (
    /ENOSPC|no space left|EDQUOT|disk is full|disk.*(full|quota)|SQLITE_FULL/i.test(
      message,
    )
  ) {
    return {
      title: 'Disk is full',
      message,
      recovery:
        'rivju could not write its run log or database. Free disk space — run JSONL logs and retained failed-run worktrees in rivju’s data folder are the usual suspects — then re-run.',
    }
  }
  if (/safeStorage|encryption is not available/i.test(message)) {
    return {
      title: 'Secure token storage unavailable',
      message,
      recovery:
        'rivju refuses to store tokens in plaintext. On Linux, install and unlock a keyring service (e.g. gnome-keyring); on macOS, allow keychain access, then retry.',
    }
  }
  if (
    /exceeds the review budget|file scope required|needs_scoping/i.test(message)
  ) {
    return {
      title: 'This merge request exceeds the review budget',
      message,
      recovery:
        'Use the file picker on the merge request to review a subset of files, then launch the review again.',
    }
  }
  if (
    /agent ended without calling finish_review|ended without calling finish_review/i.test(
      message,
    )
  ) {
    return {
      title: 'The agent stopped before finishing',
      message,
      recovery:
        'The model ended its turn without the required finish_review call. Re-run the review; if it repeats, lower effort or narrow the file scope.',
    }
  }

  return {
    title: 'Run failed',
    message: message || 'No error detail was recorded.',
    recovery:
      'Retry the run. The run’s JSONL log under rivju’s data folder (logs/) has the full trace if it persists.',
  }
}
