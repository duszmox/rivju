import { query } from '@anthropic-ai/claude-agent-sdk'
import type { AccountInfo, ModelInfo } from '@anthropic-ai/claude-agent-sdk'
import { eq } from 'drizzle-orm'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { resolveClaudeExecutable } from './executable.ts'
import { getDb } from '../db/client.ts'
import { setting } from '../db/schema.ts'

const PREFLIGHT_TIMEOUT_MS = 45_000

export type PreflightState =
  | { status: 'pending' }
  | {
      status: 'ok'
      account: AccountInfo | null
      models: ModelInfo[]
      claudePath: string
      checkedAt: number
      fromCache: boolean
    }
  | {
      status: 'failed'
      reason: 'binary-not-found' | 'not-authenticated' | 'timeout' | 'session-failed'
      message: string
      hint: string
    }

let state: PreflightState = { status: 'pending' }

export function getPreflightState(): PreflightState {
  return state
}

/**
 * Full preflight: resolve the executable, run a throwaway SDK session, capture
 * models + account from the init response, cache into the `setting` table.
 * Credentials are inherited from the user's existing claude CLI login
 * (`settingSources: []` keeps their real ~/.claude settings out of the session).
 */
export async function runPreflight(): Promise<PreflightState> {
  const claudePath = resolveClaudeExecutable()
  if (!claudePath) {
    state = {
      status: 'failed',
      reason: 'binary-not-found',
      message:
        'rivju could not find Claude Code. It looked on your PATH, in ~/.local/bin and ~/.claude/local, and found no bundled fallback. Install Claude Code, then retry.',
      hint: 'In a terminal: npm install -g @anthropic-ai/claude-code — log in once with `claude`, then retry here.',
    }
    return state
  }

  try {
    const cwd = mkdtempSync(path.join(tmpdir(), 'rivju-preflight-'))
    const probe = await probeSession(cwd, claudePath)
    if (probe.models.length === 0) {
      state = {
        status: 'failed',
        reason: 'session-failed',
        message: 'The claude session initialized but reported no available models.',
        hint: 'Update the CLI (`claude update`) and retry. If it persists, run `claude doctor`.',
      }
      return state
    }
    state = {
      status: 'ok',
      account: probe.account,
      models: probe.models,
      claudePath,
      checkedAt: Date.now(),
      fromCache: false,
    }
    persistCache(state)
    return state
  } catch (err) {
    state = classifyFailure(err)
    return state
  }
}

/**
 * Seeds renderer state from the last successful preflight so the app is usable
 * instantly on boot; the live check still runs right after and replaces this.
 */
export function loadCachedPreflight(): void {
  try {
    const db = getDb()
    const read = (key: string): string | null =>
      db.select().from(setting).where(eq(setting.key, key)).get()?.value ?? null
    const models = readJson<ModelInfo[]>(db, 'claude.models')
    const account = readJson<AccountInfo | null>(db, 'claude.account')
    const claudePath = read('claude.claude_path')
    const checkedAt = read('claude.checked_at')
    if (models && models.length > 0 && claudePath) {
      state = {
        status: 'ok',
        account,
        models,
        claudePath,
        checkedAt: checkedAt ? Number(checkedAt) : 0,
        fromCache: true,
      }
    }
  } catch {
    // db not open yet or corrupt cache — leave state pending
  }
}

async function probeSession(
  cwd: string,
  claudePath: string,
): Promise<{
  account: AccountInfo | null
  models: ModelInfo[]
}> {
  const abort = new AbortController()
  const timer = setTimeout(() => abort.abort(), PREFLIGHT_TIMEOUT_MS)
  try {
    const session = query({
      prompt: 'Reply with exactly: ok',
      options: {
        cwd,
        pathToClaudeCodeExecutable: claudePath,
        settingSources: [],
        allowedTools: [],
        maxTurns: 1,
        abortController: abort,
      },
    })
    try {
      const init = await session.initializationResult()
      const account: AccountInfo | null = init.account
      const models: ModelInfo[] = init.models
      return { account, models }
    } finally {
      try {
        await session.interrupt()
      } catch {
        // nothing in flight — fine
      }
      session.close()
    }
  } finally {
    clearTimeout(timer)
  }
}

function classifyFailure(err: unknown): PreflightState {
  const message = err instanceof Error ? err.message : String(err)
  if (err instanceof Error && err.name === 'AbortError') {
    return {
      status: 'failed',
      reason: 'timeout',
      message: 'The throwaway claude session did not initialize in time.',
      hint: 'Retry. If it keeps timing out, run `claude doctor` in a terminal.',
    }
  }
  if (/not logged in|logged in|unauthenticated|authentication|api key|credit balance|oauth/i.test(message)) {
    return {
      status: 'failed',
      reason: 'not-authenticated',
      message: `The claude CLI is not authenticated: ${message}`,
      hint: 'Run `claude` in a terminal and complete the login, then retry here. rivju inherits that login — no API key needed.',
    }
  }
  return {
    status: 'failed',
    reason: 'session-failed',
    message: `The throwaway claude session failed: ${message}`,
    hint: 'Run `claude doctor` in a terminal, then retry.',
  }
}

const CACHE_KEYS = {
  models: 'claude.models',
  account: 'claude.account',
  claudePath: 'claude.claude_path',
  checkedAt: 'claude.checked_at',
} as const

function persistCache(ok: Extract<PreflightState, { status: 'ok' }>): void {
  try {
    const db = getDb()
    upsert(db, CACHE_KEYS.models, JSON.stringify(ok.models))
    upsert(db, CACHE_KEYS.account, JSON.stringify(ok.account))
    upsert(db, CACHE_KEYS.claudePath, ok.claudePath)
    upsert(db, CACHE_KEYS.checkedAt, String(ok.checkedAt))
  } catch {
    // cache is best-effort; the live state is already updated
  }
}

function upsert(db: ReturnType<typeof getDb>, key: string, value: string): void {
  db.insert(setting)
    .values({ key, value })
    .onConflictDoUpdate({ target: setting.key, set: { value } })
    .run()
}

function readJson<T>(db: ReturnType<typeof getDb>, key: string): T | null {
  const row = db.select().from(setting).where(eq(setting.key, key)).get()
  if (!row) return null
  try {
    return JSON.parse(row.value) as T
  } catch {
    return null
  }
}
