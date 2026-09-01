import { spawn } from 'node:child_process'

export interface GitResult {
  stdout: string
  stderr: string
  truncated: boolean
}

export interface GitOptions {
  cwd?: string
  env?: NodeJS.ProcessEnv
  maxOutputBytes?: number
  onStderr?: (chunk: string) => void
  signal?: AbortSignal
}

/** Run git without a shell so refs and paths can never become shell syntax. */
export function runGit(
  args: string[],
  options: GitOptions = {},
): Promise<GitResult> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      signal: options.signal,
    })
    const cap = options.maxOutputBytes ?? Number.POSITIVE_INFINITY
    let stdout = ''
    let stderr = ''
    let stdoutBytes = 0
    let truncated = false

    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      const remaining = Math.max(0, cap - stdoutBytes)
      if (remaining > 0) {
        const buffer = Buffer.from(chunk)
        stdout += buffer.subarray(0, remaining).toString('utf8')
        stdoutBytes += Math.min(buffer.length, remaining)
      }
      if (Buffer.byteLength(chunk) > remaining) truncated = true
    })
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk
      options.onStderr?.(chunk)
    })
    child.on('error', reject)
    child.on('close', (code, signal) => {
      if (code === 0) {
        resolve({ stdout, stderr, truncated })
        return
      }
      const reason = signal ? `signal ${signal}` : `exit ${code ?? 'unknown'}`
      reject(
        new Error(
          `git ${args[0] ?? ''} failed (${reason}): ${stderr.trim() || 'no details'}`,
        ),
      )
    })
  })
}

const mirrorLocks = new Map<string, Promise<void>>()

/** Git mutates shared lock files, so operations for one mirror are serialized. */
export async function withMirrorLock<T>(
  mirrorPath: string,
  task: () => Promise<T>,
): Promise<T> {
  const previous = mirrorLocks.get(mirrorPath) ?? Promise.resolve()
  let release = (): void => undefined
  const current = new Promise<void>((resolve) => {
    release = resolve
  })
  mirrorLocks.set(mirrorPath, current)
  await previous.catch(() => undefined)
  try {
    return await task()
  } finally {
    release()
    if (mirrorLocks.get(mirrorPath) === current) mirrorLocks.delete(mirrorPath)
  }
}
